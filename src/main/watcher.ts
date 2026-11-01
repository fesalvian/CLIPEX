// Pasta vigiada: quando um vídeo novo para de crescer (o OBS terminou de gravar),
// cria o projeto e começa a análise sozinho. Cada perfil pode vigiar a própria pasta.

import { existsSync, mkdirSync, openSync, closeSync, readdirSync, statSync } from 'node:fs'
import { extname, join } from 'node:path'
import type { WatcherStatus } from '@shared/types'
import { emit, toast } from './bus'
import { projectsRepo } from './db'
import { enqueueAnalysis } from './pipeline'
import { listProfiles } from './profiles'
import { createProject } from './projects'
import { getSettings, watchSince } from './settings'

const VIDEO_EXT = new Set(['.mkv', '.mp4', '.mov', '.flv', '.ts'])
const POLL_MS = 4000
/** Tempo com o tamanho parado pra considerar que a gravação acabou. */
const STABLE_MS = 15000

interface Seen {
  size: number
  since: number
}

const seen = new Map<string, Seen>()
let timer: NodeJS.Timeout | null = null
let lastStatus = ''

/** O OBS segura o arquivo aberto pra escrita enquanto grava; se der pra abrir em r+, liberou. */
function isUnlocked(path: string): boolean {
  try {
    closeSync(openSync(path, 'r+'))
    return true
  } catch {
    return false
  }
}

export function watcherStatus(): WatcherStatus {
  const s = getSettings()
  return {
    enabled: s.watchEnabled,
    folder: s.watchFolder,
    exists: existsSync(s.watchFolder),
    pending: [...seen.keys()].map((p) => p.split(/[\\/]/).pop() ?? p)
  }
}

function publish(): void {
  const st = watcherStatus()
  const key = JSON.stringify(st)
  if (key !== lastStatus) {
    lastStatus = key
    emit('watcher:changed', st)
  }
}

function scan(): void {
  const present = new Set<string>()
  const folders = new Set<string>()
  for (const profile of listProfiles()) {
    const s = getSettings(profile.id)
    // a mesma pasta em dois perfis: fica com o primeiro
    const key = s.watchFolder.toLowerCase()
    if (!s.watchEnabled || folders.has(key) || !existsSync(s.watchFolder)) continue
    folders.add(key)
    scanFolder(s.watchFolder, profile.id, profile.autoPost.enabled, present)
  }
  for (const k of seen.keys()) if (!present.has(k)) seen.delete(k)
  publish()
}

function scanFolder(folder: string, profileId: string, auto: boolean, present: Set<string>): void {
  const since = watchSince()
  let names: string[] = []
  try {
    names = readdirSync(folder)
  } catch {
    return
  }
  const now = Date.now()
  for (const name of names) {
    if (!VIDEO_EXT.has(extname(name).toLowerCase())) continue
    const path = join(folder, name)
    let st
    try {
      st = statSync(path)
    } catch {
      continue
    }
    if (!st.isFile() || st.mtimeMs < since) continue
    if (projectsRepo.bySource(path)) continue
    present.add(path)
    const prev = seen.get(path)
    if (!prev || prev.size !== st.size) {
      seen.set(path, { size: st.size, since: now })
      continue
    }
    if (now - prev.since >= STABLE_MS && st.size > 0 && isUnlocked(path)) {
      seen.delete(path)
      try {
        const p = createProject(path, { profileId, auto })
        enqueueAnalysis(p.id)
        toast('info', `Nova gravação: ${p.name}. Análise começou.`)
      } catch (e) {
        toast('error', `Não consegui abrir ${name}: ${(e as Error).message}`)
      }
    }
  }
}

export function startWatcher(): void {
  for (const profile of listProfiles()) {
    const s = getSettings(profile.id)
    if (!s.watchEnabled || existsSync(s.watchFolder)) continue
    try {
      mkdirSync(s.watchFolder, { recursive: true })
    } catch {
      // pasta em drive que não existe: o status mostra o problema
    }
  }
  if (timer) clearInterval(timer)
  timer = setInterval(scan, POLL_MS)
  scan()
}

export function stopWatcher(): void {
  if (timer) clearInterval(timer)
  timer = null
}
