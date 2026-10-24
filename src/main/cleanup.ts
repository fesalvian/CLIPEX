// Apaga o arquivo bruto da live X dias depois que todos os cortes aprovados foram postados.
// Opcional (desligado por padrão) e só mexe em arquivos da pasta vigiada.

import { existsSync, rmSync } from 'node:fs'
import { normalize, resolve } from 'node:path'
import { toast } from './bus'
import { clipsRepo, postsRepo, projectsRepo } from './db'
import { saveProject } from './projects'
import { getSettings } from './settings'

const DAY = 24 * 3600 * 1000

function insideFolder(file: string, folder: string): boolean {
  const f = normalize(resolve(file)).toLowerCase()
  const d = normalize(resolve(folder)).toLowerCase().replace(/[\\/]$/, '')
  return f.startsWith(`${d}\\`) || f.startsWith(`${d}/`)
}

/**
 * Data do último post de um projeto, se todos os cortes aprovados já foram publicados e
 * não sobrou nenhum post na fila (agendado pra depois ou enviando).
 */
export function allPostedAt(projectId: string): number | null {
  const approved = clipsRepo.byProject(projectId).filter((c) => c.approved)
  if (approved.length === 0) return null
  const posts = postsRepo.all(projectId)
  if (posts.some((p) => p.status === 'scheduled' || p.status === 'uploading')) return null
  let last = 0
  for (const c of approved) {
    const done = posts.filter((p) => p.clipId === c.id && (p.status === 'posted' || p.status === 'draft'))
    if (done.length === 0) return null
    for (const p of done) last = Math.max(last, new Date(p.postedAt ?? p.createdAt).getTime())
  }
  return last
}

export function cleanupRawFiles(now = Date.now()): void {
  const s = getSettings()
  if (!s.deleteRawAfterDays) return
  for (const p of projectsRepo.all()) {
    if (p.rawDeletedAt || !existsSync(p.sourcePath) || !insideFolder(p.sourcePath, s.watchFolder)) continue
    const last = allPostedAt(p.id)
    if (last === null || now - last < s.deleteRawAfterDays * DAY) continue
    try {
      rmSync(p.sourcePath)
      p.rawDeletedAt = new Date(now).toISOString()
      saveProject(p, { list: true })
      toast('info', `Arquivo bruto de ${p.name} apagado (cortes postados há mais de ${s.deleteRawAfterDays} dias).`)
    } catch {
      // arquivo em uso: tenta na próxima rodada
    }
  }
}
