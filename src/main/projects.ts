import { randomUUID } from 'node:crypto'
import { existsSync, rmSync, statSync } from 'node:fs'
import { basename } from 'node:path'
import { DEFAULT_CROP, emptyStages } from '@shared/defaults'
import { clipSubtitle } from '@shared/text'
import { parseLiveDate, projectNameFromDate } from '@shared/time'
import type { Clip, Project, ProjectCover, ProjectSummary, StageKey, StageState } from '@shared/types'
import { emit } from './bus'
import { clipsRepo, postsRepo, projectsRepo } from './db'
import { projectDir } from './paths'
import { activeProfileId, getSettings } from './settings'
import { getProfile } from './profiles'

/** Mesma ordem da tela de clipar (nota da IA, senão o sinal); entre os aprovados, se tiver. */
function coverOf(clips: Clip[], profileId: string): ProjectCover | null {
  const score = (c: Clip): number => (c.llm ? c.llm.score : Math.round(c.signalScore * 100))
  const pool = clips.some((c) => c.approved) ? clips.filter((c) => c.approved) : clips
  const c = [...pool].sort((a, b) => score(b) - score(a) || a.number - b.number)[0]
  if (!c) return null
  const posted = postsRepo
    .byClip(c.id)
    .map((x) => x.postedAt)
    .filter((d): d is string => !!d)
    .sort()[0]
  const rendered = c.render.status === 'done' && !!c.render.path && existsSync(c.render.path)
  const preview = !!c.previewPath && c.previewStart !== null && existsSync(c.previewPath)
  return {
    clipId: c.id,
    title: clipSubtitle(c, getSettings(profileId).text) ?? `Clipe ${String(c.number).padStart(2, '0')}`,
    postedAt: posted ?? null,
    // a tela inteira da live (cam + jogo) identifica melhor que o 9:16, que pode ser "só jogo"
    videoPath: preview ? c.previewPath : rendered ? c.render.path : null,
    videoStart: preview ? Math.max(0, c.cutIn - c.previewStart!) : 0,
    vertical: !preview && rendered
  }
}

export function summarize(p: Project): ProjectSummary {
  const clips = clipsRepo.byProject(p.id)
  return {
    id: p.id,
    profileId: p.profileId,
    kind: p.kind,
    auto: p.auto,
    name: p.name,
    liveDate: p.liveDate,
    createdAt: p.createdAt,
    status: p.status,
    stages: p.stages,
    durationSec: p.source?.durationSec ?? null,
    clipCount: clips.length,
    approvedCount: clips.filter((c) => c.approved).length,
    error: p.error,
    cover: coverOf(clips, p.profileId)
  }
}

/** Projetos do perfil ativo (a tela inicial mostra um perfil por vez). */
export function listSummaries(profileId: string = activeProfileId()): ProjectSummary[] {
  return projectsRepo
    .all()
    .filter((p) => p.profileId === profileId)
    .map(summarize)
}

export function publishProjects(): void {
  emit('projects:changed', listSummaries())
}

let lastListEmit = 0

/** Salva e avisa a interface. A lista de projetos é reemitida no máximo 2x por segundo. */
export function saveProject(p: Project, opts: { list?: boolean } = {}): Project {
  projectsRepo.save(p)
  emit('project:updated', p)
  if (opts.list || Date.now() - lastListEmit > 500) {
    lastListEmit = Date.now()
    publishProjects()
  }
  return p
}

export function setStage(id: string, key: StageKey, patch: Partial<StageState>): Project | null {
  const p = projectsRepo.get(id)
  if (!p) return null
  p.stages[key] = { ...p.stages[key], ...patch }
  return saveProject(p)
}

export interface NewProjectOptions {
  /** perfil dono (padrão: o ativo) */
  profileId?: string
  /** nome do projeto (vídeo baixado: o título); sem ele, a data do arquivo */
  name?: string
  liveDate?: string | null
  auto?: boolean
  sourceUrl?: string | null
}

export function createProject(sourcePath: string, opts: NewProjectOptions = {}): Project {
  const existing = projectsRepo.bySource(sourcePath)
  if (existing) return existing
  if (!existsSync(sourcePath)) throw new Error(`Arquivo não encontrado: ${sourcePath}`)
  const file = basename(sourcePath)
  const live = parseLiveDate(file)
  const id = randomUUID().slice(0, 8)
  const fallbackName = file.replace(/\.[^.]+$/, '')
  const profile = getProfile(opts.profileId ?? activeProfileId())
  const s = getSettings(profile.id)
  const p: Project = {
    id,
    profileId: profile.id,
    kind: profile.kind,
    auto: !!opts.auto,
    sourceUrl: opts.sourceUrl ?? null,
    name: opts.name?.trim() || projectNameFromDate(live?.date ?? null, fallbackName),
    liveDate: opts.liveDate ?? live?.date ?? null,
    createdAt: new Date().toISOString(),
    dir: projectDir(id),
    source: null,
    sourcePath,
    proxyPath: null,
    framePath: null,
    crop: s.cropPreset ?? DEFAULT_CROP,
    game: s.style.defaultGame.trim() || null,
    status: 'queued',
    stages: emptyStages(),
    error: null,
    rawDeletedAt: null
  }
  // tamanho só pra validar que dá pra ler o arquivo
  statSync(sourcePath)
  return saveProject(p, { list: true })
}

export function deleteProject(id: string): void {
  const p = projectsRepo.get(id)
  projectsRepo.delete(id)
  if (p && existsSync(p.dir)) rmSync(p.dir, { recursive: true, force: true })
  publishProjects()
}
