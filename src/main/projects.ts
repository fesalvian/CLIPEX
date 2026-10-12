import { randomUUID } from 'node:crypto'
import { existsSync, rmSync, statSync } from 'node:fs'
import { basename } from 'node:path'
import { DEFAULT_CROP, emptyStages } from '@shared/defaults'
import { parseLiveDate, projectNameFromDate } from '@shared/time'
import type { Project, ProjectSummary, StageKey, StageState } from '@shared/types'
import { emit } from './bus'
import { clipsRepo, projectsRepo } from './db'
import { projectDir } from './paths'
import { getSettings } from './settings'

export function summarize(p: Project): ProjectSummary {
  const clips = clipsRepo.byProject(p.id)
  return {
    id: p.id,
    name: p.name,
    liveDate: p.liveDate,
    createdAt: p.createdAt,
    status: p.status,
    stages: p.stages,
    durationSec: p.source?.durationSec ?? null,
    clipCount: clips.length,
    approvedCount: clips.filter((c) => c.approved).length,
    error: p.error
  }
}

export function listSummaries(): ProjectSummary[] {
  return projectsRepo.all().map(summarize)
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

export function createProject(sourcePath: string): Project {
  const existing = projectsRepo.bySource(sourcePath)
  if (existing) return existing
  if (!existsSync(sourcePath)) throw new Error(`Arquivo não encontrado: ${sourcePath}`)
  const file = basename(sourcePath)
  const live = parseLiveDate(file)
  const id = randomUUID().slice(0, 8)
  const fallbackName = file.replace(/\.[^.]+$/, '')
  const p: Project = {
    id,
    name: projectNameFromDate(live?.date ?? null, fallbackName),
    liveDate: live?.date ?? null,
    createdAt: new Date().toISOString(),
    dir: projectDir(id),
    source: null,
    sourcePath,
    proxyPath: null,
    framePath: null,
    crop: getSettings().cropPreset ?? DEFAULT_CROP,
    game: getSettings().style.defaultGame.trim() || null,
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
