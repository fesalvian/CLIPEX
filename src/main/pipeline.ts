// Orquestra a análise de uma live: sonda → microfone + loudness → risada/grito → candidatos
// → (transcrição + ranking) e previews em paralelo → proxy. Os candidatos aparecem na
// interface logo depois da etapa de candidatos e vão sendo completados aos poucos.

import { execFile } from 'node:child_process'
import { existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { whisperPrompt } from '@shared/subtitles'
import type { Clip, Project, StageKey } from '@shared/types'
import { buildTimeline, pickCandidates } from './analysis/candidates'
import { splitEvents } from './analysis/events'
import { LoudnessCollector } from './analysis/loudness'
import { WavReader, writeWavSlice } from './analysis/wav'
import { transcribe } from './analysis/whisper'
import createYamnetWorker from './analysis/yamnet.worker?nodeWorker'
import { emit, toast } from './bus'
import { mutateClip, newClip } from './clips'
import { ffmpegPath, ffprobePath, videoEncoder, whisperExe, whisperModelPath, yamnetPath } from './components'
import { clipsRepo, projectsRepo } from './db'
import { audioExtractArgs, frameArgs, previewSegmentArgs, probeArgs, proxyArgs } from './ffmpeg/args'
import { analysisTrack, parseProbe, previewTrack } from './ffmpeg/probe'
import { performanceHint } from './learning'
import { llmClient } from './llm'
import { normalizeRank, RANK_SCHEMA, rankPrompt, type RankOutput } from './llm/prompts'
import { ensureDir } from './paths'
import { ffmpegProgress, runProcess } from './proc'
import { saveProject, setStage } from './projects'
import { llmLane, previewLane, whisperLane } from './sema'
import { getSettings } from './settings'

const pexec = promisify(execFile)

function files(p: Project) {
  return {
    wav: join(p.dir, 'mic.wav'),
    loud: join(p.dir, 'loudness.f32'),
    events: join(p.dir, 'events.f32'),
    frame: join(p.dir, 'frame.jpg'),
    proxy: join(p.dir, 'proxy.mp4'),
    previews: ensureDir(join(p.dir, 'previews')),
    tmp: ensureDir(join(p.dir, 'tmp'))
  }
}

export function readFloat32(path: string): Float32Array {
  const buf = readFileSync(path)
  return new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4)).slice()
}

function writeFloat32(path: string, arr: Float32Array): void {
  writeFileSync(path, Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength))
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function stageDone(p: Project, k: StageKey): boolean {
  return p.stages[k].status === 'done' || p.stages[k].status === 'skipped'
}

/** Roda uma etapa marcando início, fim e erro. */
async function stage<T>(id: string, key: StageKey, fn: (progress: (v: number) => void) => Promise<T>): Promise<T> {
  setStage(id, key, { status: 'running', progress: 0, message: undefined })
  let last = 0
  const progress = (v: number): void => {
    if (Date.now() - last < 300 && v < 1) return
    last = Date.now()
    setStage(id, key, { progress: Math.max(0, Math.min(1, v)) })
  }
  try {
    const r = await fn(progress)
    setStage(id, key, { status: 'done', progress: 1 })
    return r
  } catch (e) {
    setStage(id, key, { status: 'error', message: errMsg(e) })
    throw e
  }
}

// ---------------- fila de projetos ----------------

const queue: string[] = []
let running: string | null = null

export function enqueueAnalysis(projectId: string): void {
  if (running === projectId || queue.includes(projectId)) return
  queue.push(projectId)
  void pump()
}

async function pump(): Promise<void> {
  if (running) return
  const next = queue.shift()
  if (!next) return
  running = next
  try {
    await analyzeProject(next)
  } catch (e) {
    const p = projectsRepo.get(next)
    if (p) {
      p.status = 'error'
      p.error = errMsg(e)
      saveProject(p, { list: true })
      toast('error', `${p.name}: ${p.error.split('\n')[0]}`)
    }
  } finally {
    running = null
    void pump()
  }
}

export function resumePending(): void {
  for (const p of projectsRepo.all()) {
    const proxyLeft = p.stages.proxy.status === 'pending' || p.stages.proxy.status === 'running'
    if (p.status === 'queued' || p.status === 'analyzing' || (p.status === 'ready' && proxyLeft)) enqueueAnalysis(p.id)
  }
}

/** Continua de onde parou (etapas com erro rodam de novo; nada é apagado). */
export function retryAnalysis(projectId: string): void {
  const p = projectsRepo.get(projectId)
  if (!p) return
  for (const k of Object.keys(p.stages) as StageKey[]) {
    if (p.stages[k].status === 'error' || p.stages[k].status === 'running') p.stages[k] = { status: 'pending', progress: 0 }
  }
  p.status = 'queued'
  p.error = null
  saveProject(p, { list: true })
  enqueueAnalysis(projectId)
}

/** Refaz a análise do zero (apaga os candidatos automáticos que não foram aprovados). */
export function reanalyze(projectId: string): void {
  const p = projectsRepo.get(projectId)
  if (!p) return
  for (const c of clipsRepo.byProject(projectId)) {
    if (c.origin === 'auto' && !c.approved) {
      clipsRepo.delete(c.id)
      emit('clip:removed', { id: c.id, projectId })
    }
  }
  for (const k of ['events', 'candidates', 'transcribe', 'rank', 'previews'] as StageKey[]) {
    p.stages[k] = { status: 'pending', progress: 0 }
  }
  p.status = 'queued'
  p.error = null
  saveProject(p, { list: true })
  enqueueAnalysis(projectId)
}

// ---------------- etapas ----------------

async function probe(p: Project): Promise<Project> {
  await stage(p.id, 'probe', async () => {
    const { stdout } = await pexec(ffprobePath(), probeArgs(p.sourcePath), { windowsHide: true, maxBuffer: 16 * 1024 * 1024 })
    const info = parseProbe(JSON.parse(stdout), p.sourcePath, statSync(p.sourcePath).size)
    const cur = projectsRepo.get(p.id)!
    cur.source = info
    saveProject(cur, { list: true })
  })
  return projectsRepo.get(p.id)!
}

export async function extractFrame(projectId: string, at?: number): Promise<Project | null> {
  const p = projectsRepo.get(projectId)
  if (!p?.source) return p
  const f = files(p)
  const t = at ?? Math.min(p.source.durationSec * 0.3, 1800)
  await pexec(ffmpegPath(), frameArgs(p.sourcePath, t, f.frame), { windowsHide: true, timeout: 60000 })
  const cur = projectsRepo.get(projectId)!
  cur.framePath = f.frame
  return saveProject(cur)
}

async function extractAudio(p: Project): Promise<void> {
  const f = files(p)
  const track = analysisTrack(p.source!)
  if (!track) throw new Error('O arquivo não tem áudio.')
  await stage(p.id, 'audio', async (progress) => {
    const loud = new LoudnessCollector()
    const onProgress = ffmpegProgress(p.source!.durationSec, progress)
    const h = runProcess(ffmpegPath(), audioExtractArgs({ src: p.sourcePath, track: track.order, wavOut: f.wav }), {
      onStdoutLine: onProgress,
      onStderrLine: (l) => loud.push(l),
      lowPriority: true
    })
    await h.done
    writeFloat32(f.loud, loud.result())
  })
}

async function detectEvents(p: Project): Promise<void> {
  const f = files(p)
  const model = yamnetPath()
  if (!model) {
    setStage(p.id, 'events', { status: 'skipped', message: 'Detector de risada/grito não instalado. Usando só o volume.' })
    return
  }
  await stage(p.id, 'events', (progress) => {
    return new Promise<void>((resolve, reject) => {
      const w = createYamnetWorker({ workerData: { wavPath: f.wav, modelPath: model, outPath: f.events } })
      w.on('message', (m: { type: string; value?: number; message?: string }) => {
        if (m.type === 'progress') progress(m.value ?? 0)
        else if (m.type === 'done') resolve()
        else if (m.type === 'error') reject(new Error(m.message))
      })
      w.on('error', reject)
      w.on('exit', (code) => {
        if (code !== 0) reject(new Error(`Detector parou com código ${code}`))
      })
    })
  })
}

function findCandidates(p: Project): Clip[] {
  const f = files(p)
  const existing = clipsRepo.byProject(p.id)
  if (existing.some((c) => c.origin === 'auto')) return existing
  const s = getSettings()
  const loud = readFloat32(f.loud)
  const events = existsSync(f.events) ? splitEvents(readFloat32(f.events)) : null
  const tl = buildTimeline(loud, events, p.source!.durationSec)
  const cands = pickCandidates(tl, {
    durationSec: p.source!.durationSec,
    windowSec: s.windowSec,
    maxCandidates: s.maxCandidates,
    minScore: 0.2
  })
  let n = existing.reduce((m, c) => Math.max(m, c.number), 0)
  const clips = cands.map((c) => newClip(p, c, ++n))
  clipsRepo.saveMany(clips)
  emit('clips:added', clips)
  return [...existing, ...clips]
}

/** Transcreve a janela de um corte (a partir do WAV do microfone). */
export async function transcribeClip(clipId: string): Promise<Clip | null> {
  const clip = clipsRepo.get(clipId)
  if (!clip) return null
  if (clip.words) return clip
  const p = projectsRepo.get(clip.projectId)!
  const f = files(p)
  const exe = whisperExe()
  const model = whisperModelPath()
  if (!exe || !model) throw new Error('Whisper não instalado. Baixe em Configurações › Componentes de IA.')
  if (!existsSync(f.wav)) throw new Error('Áudio do microfone ainda não foi extraído.')
  return whisperLane.run(async () => {
    mutateClip(clipId, (c) => {
      c.stage = 'transcribing'
    })
    const slice = join(f.tmp, `${clipId}.wav`)
    const reader = new WavReader(f.wav, statSync(f.wav).size)
    try {
      writeWavSlice(reader, clip.winStart, clip.winEnd, slice)
    } finally {
      reader.close()
    }
    try {
      const words = await transcribe({
        exe,
        model,
        wav: slice,
        outBase: join(f.tmp, clipId),
        offsetSec: clip.winStart,
        prompt: whisperPrompt(getSettings().dictionary),
        useGpu: true
      }).done
      return mutateClip(clipId, (c) => {
        c.words = words
        c.stage = c.llm ? 'ready' : 'ranking'
      })
    } finally {
      rmSync(slice, { force: true })
    }
  })
}

/** Pede pra LLM a nota, o corte sugerido, etiquetas e ganchos. */
export async function rankClip(clipId: string): Promise<Clip | null> {
  const clip = clipsRepo.get(clipId)
  if (!clip?.words) return clip
  return llmLane.run(async () => {
    const client = await llmClient()
    const { system, user } = rankPrompt({
      words: clip.words!,
      winStart: clip.winStart,
      winEnd: clip.winEnd,
      peak: clip.peakSec,
      tags: clip.tags,
      signalScore: clip.signalScore,
      performanceHint: performanceHint()
    })
    const out = await client.chatJson<RankOutput>(system, user, RANK_SCHEMA)
    const insight = normalizeRank(out, clip.winStart, clip.winEnd, clip.peakSec, client.provider)
    return mutateClip(clipId, (c) => {
      c.llm = insight
      c.stage = 'ready'
      c.stageError = null
      if (c.autoCut) {
        c.cutIn = insight.suggestedIn
        c.cutOut = insight.suggestedOut
      }
    })
  })
}

export async function makePreview(clipId: string): Promise<Clip | null> {
  const clip = clipsRepo.get(clipId)
  if (!clip) return null
  if (clip.previewPath && existsSync(clip.previewPath)) return clip
  const p = projectsRepo.get(clip.projectId)!
  if (!p.source) return clip
  const f = files(p)
  const start = Math.max(0, clip.winStart - 2)
  const duration = Math.min(p.source.durationSec, clip.winEnd + 2) - start
  const out = join(f.previews, `${clip.id}.mp4`)
  const track = previewTrack(p.source)
  return previewLane.run(async () => {
    const enc = await videoEncoder()
    await runProcess(
      ffmpegPath(),
      previewSegmentArgs({ src: p.sourcePath, start, duration, audioTrack: track?.order ?? 0, out, encoder: enc })
    ).done
    return mutateClip(clipId, (c) => {
      c.previewPath = out
      c.previewStart = start
    })
  })
}

async function transcribeAndRank(p: Project, clips: Clip[]): Promise<void> {
  const todo = clips.filter((c) => !c.words || !c.llm)
  if (todo.length === 0) {
    setStage(p.id, 'transcribe', { status: 'done', progress: 1 })
    setStage(p.id, 'rank', { status: 'done', progress: 1 })
    return
  }
  let rankDone = 0
  let rankError: string | null = null
  const ranks: Promise<void>[] = []
  setStage(p.id, 'rank', { status: 'running', progress: 0 })
  await stage(p.id, 'transcribe', async (progress) => {
    let i = 0
    for (const c of todo) {
      try {
        await transcribeClip(c.id)
      } catch (e) {
        mutateClip(c.id, (x) => {
          x.stage = 'error'
          x.stageError = errMsg(e)
        })
        throw e
      }
      progress(++i / todo.length)
      // ranking roda enquanto o próximo trecho é transcrito
      ranks.push(
        rankClip(c.id)
          .then(() => undefined)
          .catch((e: unknown) => {
            rankError ??= errMsg(e)
            mutateClip(c.id, (x) => {
              x.stage = 'error'
              x.stageError = errMsg(e)
            })
          })
          .finally(() => {
            setStage(p.id, 'rank', { progress: ++rankDone / todo.length })
          })
      )
    }
  })
  await Promise.all(ranks)
  if (rankError) setStage(p.id, 'rank', { status: 'error', message: rankError })
  else setStage(p.id, 'rank', { status: 'done', progress: 1 })
}

async function makePreviews(p: Project, clips: Clip[]): Promise<void> {
  const ordered = [...clips].sort((a, b) => b.signalScore - a.signalScore)
  await stage(p.id, 'previews', async (progress) => {
    let i = 0
    for (const c of ordered) {
      await makePreview(c.id)
      progress(++i / ordered.length)
    }
  })
}

async function makeProxy(p: Project): Promise<void> {
  const f = files(p)
  if (p.proxyPath && existsSync(p.proxyPath)) return
  const track = previewTrack(p.source!)
  await stage(p.id, 'proxy', async (progress) => {
    const enc = await videoEncoder()
    const tmp = `${f.proxy}.part.mp4`
    await previewLane.run(
      () =>
        runProcess(ffmpegPath(), proxyArgs({ src: p.sourcePath, audioTrack: track?.order ?? 0, out: tmp, encoder: enc }), {
          onStdoutLine: ffmpegProgress(p.source!.durationSec, progress),
          lowPriority: true
        }).done
    )
    rmSync(f.proxy, { force: true })
    renameSync(tmp, f.proxy)
    const cur = projectsRepo.get(p.id)!
    cur.proxyPath = f.proxy
    saveProject(cur)
  })
}

async function analyzeProject(id: string): Promise<void> {
  let p = projectsRepo.get(id)
  if (!p) return
  p.status = 'analyzing'
  p.error = null
  saveProject(p, { list: true })

  if (!stageDone(p, 'probe') || !p.source) p = await probe(p)
  if (!p.framePath || !existsSync(p.framePath)) void extractFrame(p.id).catch(() => undefined)

  const f = files(p)
  if (!stageDone(p, 'audio') || !existsSync(f.wav) || !existsSync(f.loud)) await extractAudio(p)
  p = projectsRepo.get(id)!
  if (!stageDone(p, 'events') || (p.stages.events.status === 'done' && !existsSync(f.events))) await detectEvents(p)

  p = projectsRepo.get(id)!
  const clips = await stage(id, 'candidates', async () => findCandidates(p!))
  if (clips.length === 0) toast('info', `${p.name}: não achei momentos fortes. Dá pra adicionar cortes manuais.`)
  else toast('success', `${p.name}: ${clips.length} momentos encontrados. A transcrição e a nota da IA vão chegando.`)

  // Transcrição/ranking e previews andam juntos; um erro num não para o outro.
  const results = await Promise.allSettled([transcribeAndRank(p, clips), makePreviews(p, clips)])

  p = projectsRepo.get(id)!
  p.status = 'ready'
  const failed = results.find((r) => r.status === 'rejected') as PromiseRejectedResult | undefined
  p.error = failed ? errMsg(failed.reason) : null
  saveProject(p, { list: true })

  // Proxy da live inteira por último, em prioridade baixa.
  try {
    await makeProxy(p)
  } catch {
    // sem proxy a navegação usa os previews; o erro fica registrado na etapa
  }
}

/** Corte manual ou reprocessamento de um corte só. */
export async function processClip(clipId: string): Promise<void> {
  await Promise.allSettled([
    makePreview(clipId),
    (async () => {
      try {
        await transcribeClip(clipId)
        await rankClip(clipId)
      } catch (e) {
        mutateClip(clipId, (c) => {
          c.stage = 'error'
          c.stageError = errMsg(e)
        })
      }
    })()
  ])
}
