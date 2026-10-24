// Fila de render final (1080×1920, a partir do arquivo original, na GPU quando dá).

import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { captionStyleFor, DEFAULT_FONT, hookStyleFor, watermarkBox } from '@shared/text'
import { clipDuration, cutsOf, toOut } from '@shared/cuts'
import { findFont } from '../fonts'
import { clipName, hookText, markStale, mutateClip, rebuildCues, zoomMoment } from '../clips'
import { ffmpegPath, videoEncoder } from '../components'
import { clipsRepo, projectsRepo } from '../db'
import { renderArgs, type RenderConfig } from '../ffmpeg/args'
import { renderTracks } from '../ffmpeg/probe'
import { ensureDir } from '../paths'
import { CanceledError, ffmpegProgress, runProcess, type RunHandle } from '../proc'
import { getSettings } from '../settings'
import { buildAss } from './ass'
import type { Clip } from '@shared/types'

const ZOOM = { lead: 0.25, duration: 1.6, factor: 1.35 }
/** Música bem baixinha quando o usuário escolhe não mutar. */
const MUSIC_LOW_DB = -22

interface Pending {
  clipId: string
  resolve: (c: Clip) => void
  reject: (e: unknown) => void
}

const queue: Pending[] = []
let current: { clipId: string; handle: RunHandle | null } | null = null

export function slug(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40)
}

export function outputName(c: Clip): string {
  const base = `clipe-${String(c.number).padStart(2, '0')}`
  const title = c.llm?.title ? slug(c.llm.title) : ''
  return title ? `${base}_${title}` : base
}

/** Põe o corte na fila (ou devolve a promessa do que já está na fila). */
export function enqueueRender(clipId: string): Promise<Clip> {
  const c = clipsRepo.get(clipId)
  if (c && lastRenderWithoutRaw(c)) {
    // um erro de antes ("bruto não existe mais") volta a ser só desatualizado
    const kept = c.render.status === 'error' ? mutateClip(clipId, (x) => (x.render = { ...x.render, status: 'stale', error: null })) : c
    return Promise.resolve(kept ?? c)
  }
  return new Promise<Clip>((resolve, reject) => {
    const existing = queue.find((q) => q.clipId === clipId)
    if (existing) {
      const prevResolve = existing.resolve
      const prevReject = existing.reject
      existing.resolve = (c) => {
        prevResolve(c)
        resolve(c)
      }
      existing.reject = (e) => {
        prevReject(e)
        reject(e)
      }
      return
    }
    queue.push({ clipId, resolve, reject })
    mutateClip(clipId, (c) => {
      c.render = { ...c.render, status: 'queued', progress: 0, error: null }
    })
    void pump()
  })
}

/** Garante um render atualizado (renderiza se não existe ou ficou velho). */
export async function ensureRendered(clipId: string): Promise<Clip> {
  const c = clipsRepo.get(clipId)
  if (!c) throw new Error('Corte não encontrado')
  if (c.render.status === 'done' && c.render.path && existsSync(c.render.path)) return c
  return enqueueRender(clipId)
}

/**
 * Bruto da live apagado mas o vídeo final ainda existe: não dá pra renderizar de novo, então
 * vale a última versão gerada (postagem e download continuam funcionando).
 */
function lastRenderWithoutRaw(c: Clip): boolean {
  if (!c.render.path || !existsSync(c.render.path)) return false
  const p = projectsRepo.get(c.projectId)
  return !!p && !existsSync(p.sourcePath)
}

export function cancelRender(clipId: string): void {
  const i = queue.findIndex((q) => q.clipId === clipId)
  if (i >= 0) {
    const [q] = queue.splice(i, 1)
    q!.reject(new CanceledError())
    mutateClip(clipId, (c) => {
      c.render = { ...c.render, status: c.render.path ? 'stale' : 'none', progress: 0 }
    })
  }
  if (current?.clipId === clipId) current.handle?.cancel()
}

/** Toda vez que muda algo global (recorte da live, marca d'água), os renders prontos ficam velhos. */
export function markProjectStale(projectId: string): void {
  for (const c of clipsRepo.byProject(projectId)) {
    if (c.render.status === 'done') mutateClip(c.id, markStale)
  }
}

async function pump(): Promise<void> {
  if (current) return
  const job = queue.shift()
  if (!job) return
  current = { clipId: job.clipId, handle: null }
  try {
    job.resolve(await renderClip(job.clipId))
  } catch (e) {
    job.reject(e)
  } finally {
    current = null
    void pump()
  }
}

/** Copia pro diretório do render só as fontes usadas (o libass procura em `fonts/`). */
function copyFonts(dir: string, families: string[]): void {
  const out = join(dir, 'fonts')
  rmSync(out, { recursive: true, force: true })
  ensureDir(out)
  for (const fam of new Set(families)) {
    const f = findFont(fam) ?? findFont(DEFAULT_FONT)
    if (f) copyFileSync(f.file, join(out, basename(f.file)))
  }
}

export async function buildRenderConfig(clip: Clip, workDir: string, out: string): Promise<RenderConfig> {
  const p = projectsRepo.get(clip.projectId)
  if (!p?.source) throw new Error('Projeto sem informações do arquivo.')
  const s = getSettings()
  const cues = clip.cues ?? rebuildCues(clip) ?? []
  const caption = captionStyleFor(clip, s.text)
  const hookStyle = hookStyleFor(clip, s.text)
  // fonte que sumiu (arquivo apagado) cai na padrão, pra não sair com fonte do sistema
  if (!findFont(caption.font)) caption.font = DEFAULT_FONT
  if (!findFont(hookStyle.font)) hookStyle.font = DEFAULT_FONT
  writeFileSync(
    join(workDir, 'sub.ass'),
    buildAss({
      cues,
      hook: hookText(clip),
      cutIn: clip.cutIn,
      cutOut: clip.cutOut,
      cuts: cutsOf(clip),
      caption,
      hookStyle,
      isBold: (fam) => findFont(fam)?.bold ?? false
    }),
    'utf8'
  )
  copyFonts(workDir, [caption.font, hookStyle.font])

  const wm = clip.watermark ?? s.watermark
  let watermark: RenderConfig['watermark'] = null
  if (wm.enabled && wm.path && existsSync(wm.path)) {
    copyFileSync(wm.path, join(workDir, 'wm.png'))
    // mesma conta do preview: no modo "acima da legenda" a logo acompanha a legenda do corte
    const box = watermarkBox(wm, caption)
    watermark = { file: 'wm.png', x: box.x, y: box.y, w: box.w, opacity: wm.opacity }
  }

  const z = zoomMoment(clip)
  const zoom = z !== null ? { at: Math.max(0, toOut(cutsOf(clip), z) - ZOOM.lead), duration: ZOOM.duration, factor: ZOOM.factor } : null
  const tracks = renderTracks(p.source)
  return {
    src: p.sourcePath,
    srcW: p.source.width,
    srcH: p.source.height,
    srcFps: p.source.fps,
    cutIn: clip.cutIn,
    cutOut: clip.cutOut,
    keep: cutsOf(clip).map((k) => ({ s: k.s - clip.cutIn, e: k.e - clip.cutIn })),
    layout: clip.layout,
    camSplit: clip.camSplit,
    crop: clip.crop ?? p.crop,
    zoom,
    subtitles: 'sub.ass',
    fontsDir: 'fonts',
    watermark,
    audio: {
      tracks: tracks.tracks,
      musicTrack: s.musicMode === 'low' ? tracks.music : null,
      musicGainDb: MUSIC_LOW_DB
    },
    encoder: await videoEncoder(),
    out
  }
}

async function renderClip(clipId: string): Promise<Clip> {
  const clip = clipsRepo.get(clipId)
  if (!clip) throw new Error('Corte não encontrado')
  const p = projectsRepo.get(clip.projectId)!
  if (!existsSync(p.sourcePath)) throw new Error('O arquivo bruto da live não existe mais.')
  const workDir = ensureDir(join(p.dir, 'render', clip.id))
  const rendersDir = ensureDir(join(p.dir, 'renders'))
  const out = join(rendersDir, `${outputName(clip)}.mp4`)
  const tmp = join(workDir, 'out.mp4')

  mutateClip(clipId, (c) => {
    c.render = { ...c.render, status: 'rendering', progress: 0, error: null }
  })
  try {
    const cfg = await buildRenderConfig(clip, workDir, 'out.mp4')
    const dur = clipDuration(clip)
    let last = 0
    const handle = runProcess(ffmpegPath(), renderArgs(cfg), {
      cwd: workDir,
      onStdoutLine: ffmpegProgress(dur, (v) => {
        if (Date.now() - last < 250) return
        last = Date.now()
        mutateClip(clipId, (c) => {
          c.render = { ...c.render, progress: v }
        })
      })
    })
    if (current) current.handle = handle
    await handle.done
    // apaga render antigo com outro nome (título mudou)
    const old = clipsRepo.get(clipId)?.render.path
    if (old && old !== out && existsSync(old)) rmSync(old, { force: true })
    mkdirSync(rendersDir, { recursive: true })
    rmSync(out, { force: true })
    renameSync(tmp, out)
    return mutateClip(clipId, (c) => {
      c.render = { status: 'done', progress: 1, path: out, error: null, renderedAt: new Date().toISOString() }
    })!
  } catch (e) {
    const canceled = e instanceof CanceledError
    mutateClip(clipId, (c) => {
      c.render = {
        ...c.render,
        status: canceled ? (c.render.path ? 'stale' : 'none') : 'error',
        progress: 0,
        error: canceled ? null : `${clipName(c)}: ${(e as Error).message}`
      }
    })
    throw e
  }
}
