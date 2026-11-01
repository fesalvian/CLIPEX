import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { channelLogo, DEFAULT_PROFILE_ID, defaultSettings, newProfileSettings } from '@shared/defaults'
import type { PlatformRules } from '@shared/platformRules'
import { mergeDefaults } from '@shared/text'
import { GLOBAL_SETTING_KEYS, type Settings, type Watermark } from '@shared/types'
import { projectsRepo, settingsRepo } from './db'
import { configFile, resourcesDir } from './paths'

// Configurações em duas partes: as globais (IA, Whisper, encoder…) ficam em 'app'; o resto
// (pasta vigiada, logo, textos, jeito de escrever, contas…) é de cada perfil. O perfil do
// Felipe começa com o que já estava salvo em 'app' antes de existirem perfis.

const KEY = 'app'
const ACTIVE_KEY = 'activeProfile'
const cached = new Map<string, Settings>()
type GlobalKey = (typeof GLOBAL_SETTING_KEYS)[number]

function profileKey(id: string): string {
  return `profileSettings:${id}`
}

function isGlobal(k: string): k is GlobalKey {
  return (GLOBAL_SETTING_KEYS as readonly string[]).includes(k)
}

/** Perfil escolhido na interface (o que as telas mostram e editam). */
export function activeProfileId(): string {
  return settingsRepo.get<string>(ACTIVE_KEY) ?? DEFAULT_PROFILE_ID
}

export function setActiveProfileId(id: string): void {
  settingsRepo.set(ACTIVE_KEY, id)
}

/** Logo do canal que vem com o app (já recortada). */
export function channelLogoPath(): string | null {
  const p = join(resourcesDir(), 'brand', 'logoLives.png')
  return existsSync(p) ? p : null
}

/**
 * Marca d'água salva por versões antigas (sem `anchor`, PNG com borda transparente e
 * posição fixa) vira a logo do canal presa acima da legenda.
 */
export function upgradeWatermark(stored: Partial<Watermark> | undefined, fallback: Watermark): Watermark {
  if (!stored) return fallback
  if (stored.anchor === undefined) {
    watermarkMigrated = true
    const logo = channelLogoPath()
    return logo ? channelLogo(logo) : { ...fallback, ...stored, anchor: 'free', gap: 36, offsetX: 0 }
  }
  return { ...fallback, ...stored }
}

let watermarkMigrated = false

/** A marca d'água antiga virou a logo presa à legenda nesta abertura? (uma vez só) */
export function consumeWatermarkMigration(): boolean {
  getSettings(DEFAULT_PROFILE_ID)
  const v = watermarkMigrated
  if (v) {
    watermarkMigrated = false
    // grava a versão nova pra não migrar de novo
    updateSettings({}, DEFAULT_PROFILE_ID)
  }
  return v
}

/** Configurações de um perfil (sem id: o perfil ativo), já juntas com as globais. */
export function getSettings(profileId: string = activeProfileId()): Settings {
  const hit = cached.get(profileId)
  if (hit) return hit
  const global = settingsRepo.get<Partial<Settings>>(KEY) ?? {}
  const own = settingsRepo.get<Partial<Settings>>(profileKey(profileId))
  const base = defaultSettings(app.getPath('videos'), channelLogoPath())
  // perfil do Felipe sem parte própria ainda: usa o que estava salvo antes dos perfis
  const defaults = profileId === DEFAULT_PROFILE_ID ? base : newProfileSettings(base)
  const stored: Partial<Settings> = own ?? (profileId === DEFAULT_PROFILE_ID ? global : {})
  const globals: Partial<Settings> = {}
  for (const k of GLOBAL_SETTING_KEYS) if (global[k] !== undefined) Object.assign(globals, { [k]: global[k] })
  const next: Settings = {
    ...defaults,
    ...stored,
    ...globals,
    watermark: upgradeWatermark(stored.watermark, defaults.watermark),
    accounts: { ...defaults.accounts, ...(stored.accounts ?? {}) },
    text: mergeDefaults(stored.text),
    style: { ...defaults.style, ...(stored.style ?? {}) }
  }
  cached.set(profileId, next)
  return next
}

/** Configurações do perfil dono de um projeto. */
export function projectSettings(projectId: string): Settings {
  return getSettings(projectsRepo.get(projectId)?.profileId ?? DEFAULT_PROFILE_ID)
}

/** Grava: o que é global vale pra todos os perfis; o resto só pro perfil. */
export function updateSettings(patch: Partial<Settings>, profileId: string = activeProfileId()): Settings {
  const cur = getSettings(profileId)
  const global = settingsRepo.get<Partial<Settings>>(KEY) ?? {}
  const own: Partial<Settings> = {}
  let globalChanged = false
  for (const [k, v] of Object.entries({ ...cur, ...patch })) {
    if (isGlobal(k)) {
      if (k in patch) {
        Object.assign(global, { [k]: v })
        globalChanged = true
      }
    } else Object.assign(own, { [k]: v })
  }
  settingsRepo.set(profileKey(profileId), own)
  if (globalChanged) {
    settingsRepo.set(KEY, global)
    cached.clear()
  } else cached.delete(profileId)
  return getSettings(profileId)
}

/** Apaga as configurações próprias de um perfil excluído. */
export function forgetProfileSettings(profileId: string): void {
  settingsRepo.set(profileKey(profileId), {})
  cached.delete(profileId)
}

/** Quando a pasta vigiada foi configurada: arquivos mais antigos que isso não são importados sozinhos. */
export function watchSince(): number {
  const v = settingsRepo.get<number>('watchSince')
  if (v) return v
  const now = Date.now() - 24 * 3600 * 1000
  settingsRepo.set('watchSince', now)
  return now
}

export function resetWatchSince(): void {
  settingsRepo.set('watchSince', Date.now())
}

let rules: PlatformRules | null = null

export function platformRules(): PlatformRules {
  if (!rules) rules = JSON.parse(readFileSync(configFile('platform-rules.json'), 'utf8')) as PlatformRules
  return rules
}
