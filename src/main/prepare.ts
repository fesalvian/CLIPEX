// "Renderizar N clipes" na tela de clipar: deixa cada corte aprovado pronto pra revisar
// (transcrição, legenda em trechos, legenda/hashtags por rede) e já manda renderizar.

import { cutsDuration, cutsOf, wordsOnOutput } from '@shared/cuts'
import { enforceCaption } from '@shared/platformRules'
import { applyDictionary } from '@shared/subtitles'
import { NETWORKS, type Captions, type Clip, type LlmProvider, type Word } from '@shared/types'
import { toast } from './bus'
import { clipName, hookText, mutateClip, rebuildCues } from './clips'
import { existsSync } from 'node:fs'
import { clipsRepo, projectsRepo } from './db'
import { llmClient } from './llm'
import {
  CAPTIONS_SCHEMA,
  captionsFromOutput,
  captionsPrompt,
  HOOKS_SCHEMA,
  hooksPrompt,
  stripEmoji,
  type CaptionsOutput
} from './llm/prompts'
import { processClip, transcribeClip } from './pipeline'
import { enqueueRender } from './render/queue'
import { llmLane } from './sema'
import { getSettings, platformRules } from './settings'
import { captionStyleBlock, hookStyleBlock } from './style'

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** O que a IA lê: só as falas dos trechos, coladas como no vídeo final. */
function spokenWords(c: Clip): { words: Word[]; duration: number } {
  const cuts = cutsOf(c)
  return { words: wordsOnOutput(c.words ?? [], cuts), duration: cutsDuration(cuts) }
}

export async function generateCaptions(clipId: string, provider?: LlmProvider): Promise<Captions> {
  const c = clipsRepo.get(clipId)
  if (!c) throw new Error('Corte não encontrado')
  if (!c.words) throw new Error('O corte ainda não foi transcrito.')
  const rules = platformRules()
  const out = await llmLane.run(async () => {
    const client = await llmClient(provider)
    const game = projectsRepo.get(c.projectId)?.game ?? null
    const spoken = spokenWords(c)
    const { system, user } = captionsPrompt(
      spoken.words,
      0,
      spoken.duration,
      hookText(c),
      c.llm?.title ?? null,
      rules,
      getSettings().accounts,
      captionStyleBlock(game)
    )
    return client.chatJson<CaptionsOutput>(system, user, CAPTIONS_SCHEMA)
  })
  const raw = captionsFromOutput(out)
  const captions: Captions = {}
  for (const net of NETWORKS) captions[net] = enforceCaption(net, raw[net], rules)
  mutateClip(clipId, (x) => {
    x.captions = captions
  })
  return captions
}

export async function generateHooks(clipId: string, provider?: LlmProvider): Promise<string[]> {
  const c = clipsRepo.get(clipId)
  if (!c?.words) throw new Error('O corte ainda não foi transcrito.')
  const avoid = c.llm?.hooks ?? []
  const out = await llmLane.run(async () => {
    const client = await llmClient(provider)
    const spoken = spokenWords(c)
    const { system, user } = hooksPrompt(spoken.words, 0, spoken.duration, avoid, hookStyleBlock(projectsRepo.get(c.projectId)?.game ?? null))
    return { r: await client.chatJson<{ hooks: string[] }>(system, user, HOOKS_SCHEMA), provider: client.provider }
  })
  const hooks = out.r.hooks.map((h) => stripEmoji(h).toLocaleUpperCase('pt-BR')).filter(Boolean).slice(0, 3)
  mutateClip(clipId, (x) => {
    x.llm = x.llm
      ? { ...x.llm, hooks }
      : {
          score: Math.round(x.signalScore * 100),
          title: '',
          reason: '',
          tags: [],
          hooks,
          suggestedIn: x.cutIn,
          suggestedOut: x.cutOut,
          provider: out.provider
        }
    if (!x.hookCustom) x.hookChoice = 0
  })
  return hooks
}

const queue: string[] = []
let busy = false

export function prepareClips(clipIds: string[]): void {
  for (const id of clipIds) {
    const c = clipsRepo.get(id)
    if (!c || queue.includes(id)) continue
    if (c.prep === 'ready' && c.captions && c.cues) {
      if (c.render.status === 'none' || c.render.status === 'stale' || c.render.status === 'error') void enqueueRender(id).catch(() => undefined)
      continue
    }
    queue.push(id)
    mutateClip(id, (x) => {
      x.prep = 'queued'
      x.prepMessage = 'Na fila'
    })
  }
  void pump()
}

async function pump(): Promise<void> {
  if (busy) return
  busy = true
  try {
    for (let id = queue.shift(); id; id = queue.shift()) await prepareOne(id)
  } finally {
    busy = false
  }
}

function step(id: string, message: string): void {
  mutateClip(id, (x) => {
    x.prep = 'working'
    x.prepMessage = message
  })
}

async function prepareOne(id: string): Promise<void> {
  let c: Clip | null = clipsRepo.get(id)
  if (!c) return
  try {
    if (!c.words) {
      step(id, 'Transcrevendo')
      c = await transcribeClip(id)
    }
    if (!c?.cues) {
      step(id, 'Montando legenda')
      c = mutateClip(id, (x) => {
        x.cues = rebuildCues(x)
      })
    }
    if (!c?.captions) {
      step(id, 'Gerando legenda')
      try {
        await generateCaptions(id)
      } catch (e) {
        // sem LLM ainda dá pra revisar e postar com legenda escrita à mão
        toast('error', `${clipName(c!)}: legenda das redes não gerada (${errMsg(e).split('\n')[0]})`)
      }
    }
    mutateClip(id, (x) => {
      x.prep = 'ready'
      x.prepMessage = null
    })
    void enqueueRender(id).catch(() => undefined)
  } catch (e) {
    mutateClip(id, (x) => {
      x.prep = 'error'
      x.prepMessage = errMsg(e)
    })
  }
}

/**
 * Ao abrir o app: retoma o que ficou no meio quando ele foi fechado (preparação,
 * transcrição/nota de corte manual, render). Sem isso o corte fica preso em "Gerando…".
 */
export function resumeClipJobs(): void {
  const toPrepare: string[] = []
  for (const p of projectsRepo.all()) {
    const analyzing = p.status === 'analyzing' || p.status === 'queued'
    for (const c of clipsRepo.byProject(p.id)) {
      if (c.render.status === 'rendering' || c.render.status === 'queued') {
        mutateClip(c.id, (x) => {
          x.render = { ...x.render, status: x.render.path && existsSync(x.render.path) ? 'stale' : 'none', progress: 0 }
        })
      }
      if (c.prep === 'queued' || c.prep === 'working') {
        mutateClip(c.id, (x) => {
          x.prep = 'none'
          x.prepMessage = null
        })
        toPrepare.push(c.id)
      }
      // corte manual interrompido (a análise do projeto já terminou)
      if (!analyzing && (c.stage === 'transcribing' || c.stage === 'ranking')) void processClip(c.id)
    }
  }
  if (toPrepare.length) prepareClips(toPrepare)
}

/** Reaplica o dicionário nos trechos de legenda de um corte. */
export function applyDictionaryToClip(clipId: string): Clip {
  const c = clipsRepo.get(clipId)
  if (!c) throw new Error('Corte não encontrado')
  if (!c.cues) return c
  return mutateClip(clipId, (x) => {
    x.cues = applyDictionary(x.cues!, getSettings().dictionary)
    if (x.render.status === 'done') x.render = { ...x.render, status: 'stale' }
  })!
}
