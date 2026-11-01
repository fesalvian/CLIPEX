// Perfis (como os da Netflix): cada um é um canal de cortes com contas, estilo, pasta ou canal
// vigiado e fila de postagem próprios. O do Felipe (gameplay) existe desde antes dos perfis.

import { randomUUID } from 'node:crypto'
import { DEFAULT_PROFILE_ID, defaultAutoPost, defaultProfile, PROFILE_COLORS } from '@shared/defaults'
import type { ClipKind, Profile } from '@shared/types'
import { emit } from './bus'
import { projectsRepo, settingsRepo } from './db'
import { activeProfileId, forgetProfileSettings, setActiveProfileId } from './settings'

const KEY = 'profiles'

function upgrade(p: Profile): Profile {
  return { ...p, autoPost: { ...defaultAutoPost(), ...(p.autoPost ?? {}) }, source: p.source ?? null }
}

export function listProfiles(): Profile[] {
  const stored = settingsRepo.get<Profile[]>(KEY)
  if (stored?.length) return stored.map(upgrade)
  const first = [defaultProfile()]
  settingsRepo.set(KEY, first)
  return first
}

function save(list: Profile[]): Profile[] {
  settingsRepo.set(KEY, list)
  emit('profiles:changed', list)
  return list
}

export function getProfile(id: string): Profile {
  const list = listProfiles()
  return list.find((p) => p.id === id) ?? list.find((p) => p.id === DEFAULT_PROFILE_ID) ?? list[0]!
}

export function activeProfile(): Profile {
  return getProfile(activeProfileId())
}

/** Perfil dono de um projeto (projetos de antes dos perfis são do Felipe). */
export function profileOfProject(projectId: string): Profile {
  return getProfile(projectsRepo.get(projectId)?.profileId ?? DEFAULT_PROFILE_ID)
}

export function selectProfile(id: string): Profile {
  const p = getProfile(id)
  setActiveProfileId(p.id)
  return p
}

export interface NewProfile {
  name: string
  kind: ClipKind
  subject: string
}

export function createProfile(input: NewProfile): Profile {
  const name = input.name.trim()
  if (!name) throw new Error('Dê um nome pro perfil.')
  const list = listProfiles()
  const used = new Set(list.map((p) => p.color))
  const p: Profile = {
    id: randomUUID().slice(0, 8),
    name: name.slice(0, 40),
    kind: input.kind,
    subject: input.subject.trim() || name,
    color: PROFILE_COLORS.find((c) => !used.has(c)) ?? PROFILE_COLORS[list.length % PROFILE_COLORS.length]!,
    createdAt: new Date().toISOString(),
    source: null,
    autoPost: defaultAutoPost()
  }
  save([...list, p])
  return p
}

export function updateProfile(id: string, patch: Partial<Omit<Profile, 'id' | 'createdAt'>>): Profile {
  const list = listProfiles()
  const i = list.findIndex((p) => p.id === id)
  if (i < 0) throw new Error('Perfil não encontrado.')
  const next = upgrade({ ...list[i]!, ...patch, id })
  if (!next.name.trim()) throw new Error('O perfil precisa de um nome.')
  list[i] = next
  save(list)
  return next
}

/** Exclui o perfil e os projetos dele (os vídeos brutos ficam). O do Felipe não sai. */
export function deleteProfile(id: string, deleteProject: (projectId: string) => void): Profile[] {
  if (id === DEFAULT_PROFILE_ID) throw new Error('O perfil principal não pode ser excluído.')
  for (const p of projectsRepo.all()) if (p.profileId === id) deleteProject(p.id)
  forgetProfileSettings(id)
  const list = save(listProfiles().filter((p) => p.id !== id))
  if (activeProfileId() === id) setActiveProfileId(DEFAULT_PROFILE_ID)
  return list
}

/** Chave de um segredo (token) de um perfil. O do Felipe usa as chaves de antes dos perfis. */
export function secretKey(base: string, profileId: string): string {
  return profileId === DEFAULT_PROFILE_ID ? base : `${base}:${profileId}`
}
