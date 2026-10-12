import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { channelLogo, defaultSettings } from '@shared/defaults'
import type { PlatformRules } from '@shared/platformRules'
import { mergeDefaults } from '@shared/text'
import type { Settings, Watermark } from '@shared/types'
import { settingsRepo } from './db'
import { configFile, resourcesDir } from './paths'

const KEY = 'app'
let cached: Settings | null = null

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
  getSettings()
  const v = watermarkMigrated
  if (v) {
    watermarkMigrated = false
    // grava a versão nova pra não migrar de novo
    settingsRepo.set(KEY, getSettings())
  }
  return v
}

export function getSettings(): Settings {
  if (cached) return cached
  const stored = settingsRepo.get<Partial<Settings>>(KEY) ?? {}
  const defaults = defaultSettings(app.getPath('videos'), channelLogoPath())
  cached = {
    ...defaults,
    ...stored,
    watermark: upgradeWatermark(stored.watermark, defaults.watermark),
    accounts: { ...defaults.accounts, ...(stored.accounts ?? {}) },
    text: mergeDefaults(stored.text),
    style: { ...defaults.style, ...(stored.style ?? {}) }
  }
  return cached
}

export function updateSettings(patch: Partial<Settings>): Settings {
  const next = { ...getSettings(), ...patch }
  settingsRepo.set(KEY, next)
  cached = next
  return next
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
