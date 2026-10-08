import { randomUUID } from 'node:crypto'
import type { ClipPatch } from '@shared/ipc'
import { emptyRender, MAX_CUT, MIN_CUT } from '@shared/defaults'
import { applyDictionary, buildCues, mergeCues } from '@shared/subtitles'
import type { Clip, Project } from '@shared/types'
import type { Candidate } from './analysis/candidates'
import { emit } from './bus'
import { clipsRepo, projectsRepo } from './db'
import { getSettings } from './settings'

export function newClip(project: Project, c: Candidate, number: number, origin: Clip['origin'] = 'auto'): Clip {
  return {
    id: randomUUID().slice(0, 12),
    projectId: project.id,
    number,
    origin,
    peakSec: c.peak,
    winStart: c.winStart,
    winEnd: c.winEnd,
    cutIn: c.cutIn,
    cutOut: c.cutOut,
    autoCut: origin === 'auto',
    signalScore: c.score,
    tags: c.tags,
    stage: 'detected',
    stageError: null,
    llm: null,
    approved: false,
    layout: 'both',
    camSplit: 40,
    hookChoice: 0,
    hookCustom: '',
    zoomEnabled: false,
    zoomAt: null,
    words: null,
    cues: null,
    captions: null,
    watermark: null,
    previewPath: null,
    previewStart: null,
    prep: 'none',
    prepMessage: null,
    render: emptyRender(),
    createdAt: new Date().toISOString()
  }
}

/** Campos que mudam o vídeo final: se mudarem depois do render, ele fica desatualizado. */
const RENDER_FIELDS: (keyof ClipPatch)[] = [
  'cutIn',
  'cutOut',
  'layout',
  'camSplit',
  'hookChoice',
  'hookCustom',
  'zoomEnabled',
  'zoomAt',
  'cues',
  'watermark'
]

export function saveClip(c: Clip): Clip {
  clipsRepo.save(c)
  emit('clip:updated', c)
  return c
}

export function mutateClip(id: string, fn: (c: Clip) => void): Clip | null {
  const c = clipsRepo.get(id)
  if (!c) return null
  fn(c)
  return saveClip(c)
}

export function markStale(c: Clip): void {
  if (c.render.status === 'done') c.render = { ...c.render, status: 'stale' }
}

export function updateClip(id: string, patch: ClipPatch): Clip {
  const c = clipsRepo.get(id)
  if (!c) throw new Error('Corte não encontrado')
  const before = JSON.stringify(RENDER_FIELDS.map((k) => c[k as keyof Clip]))
  Object.assign(c, patch)

  // Mantém o corte dentro da janela e com duração válida.
  if (patch.cutIn !== undefined || patch.cutOut !== undefined) {
    c.autoCut = false
    c.cutIn = Math.max(c.winStart, Math.min(c.cutIn, c.winEnd - MIN_CUT))
    c.cutOut = Math.max(c.cutIn + MIN_CUT, Math.min(c.cutOut, c.winEnd, c.cutIn + MAX_CUT))
    // legenda acompanha o novo corte sem perder o que já foi editado
    if (c.cues && c.words && !patch.cues) c.cues = mergeCues(c.cues, c.words, c.cutIn, c.cutOut, getSettings().dictionary)
  }
  if (c.zoomAt !== null && (c.zoomAt < c.cutIn || c.zoomAt > c.cutOut)) c.zoomAt = null

  const after = JSON.stringify(RENDER_FIELDS.map((k) => c[k as keyof Clip]))
  if (before !== after) markStale(c)
  return saveClip(c)
}

export function rebuildCues(c: Clip): Clip['cues'] {
  if (!c.words) return null
  return applyDictionary(buildCues(c.words, c.cutIn, c.cutOut), getSettings().dictionary)
}

export function clipName(c: Clip): string {
  return `Clipe ${String(c.number).padStart(2, '0')}`
}

export function hookText(c: Clip): string | null {
  if (c.hookCustom.trim()) return c.hookCustom.trim()
  if (c.hookChoice === null) return null
  return c.llm?.hooks[c.hookChoice] ?? null
}

/** Momento do zoom: o escolhido, ou o pico detectado se estiver dentro do corte. */
export function zoomMoment(c: Clip): number | null {
  if (!c.zoomEnabled) return null
  const at = c.zoomAt ?? c.peakSec
  return at >= c.cutIn && at <= c.cutOut ? at : (c.cutIn + c.cutOut) / 2
}

export function nextClipNumber(projectId: string): number {
  return clipsRepo.byProject(projectId).reduce((m, c) => Math.max(m, c.number), 0) + 1
}

export function createManualClip(projectId: string, at: number): Clip {
  const p = projectsRepo.get(projectId)
  if (!p?.source) throw new Error('Projeto ainda sem análise do arquivo.')
  const half = getSettings().windowSec
  const dur = p.source.durationSec
  const t = Math.max(0, Math.min(dur, at))
  const cand: Candidate = {
    peak: t,
    winStart: Math.max(0, t - half),
    winEnd: Math.min(dur, t + half),
    cutIn: Math.max(0, t - 15),
    cutOut: Math.min(dur, t + 15),
    score: 1,
    tags: ['manual']
  }
  const c = newClip(p, cand, nextClipNumber(projectId), 'manual')
  c.approved = true
  clipsRepo.save(c)
  emit('clips:added', [c])
  return c
}
