import { readFileSync } from 'node:fs'
import { app } from 'electron'
import { defaultSettings } from '@shared/defaults'
import type { PlatformRules } from '@shared/platformRules'
import type { Settings } from '@shared/types'
import { settingsRepo } from './db'
import { configFile } from './paths'

const KEY = 'app'
let cached: Settings | null = null

export function getSettings(): Settings {
  if (cached) return cached
  const stored = settingsRepo.get<Partial<Settings>>(KEY) ?? {}
  const defaults = defaultSettings(app.getPath('videos'))
  cached = {
    ...defaults,
    ...stored,
    watermark: { ...defaults.watermark, ...(stored.watermark ?? {}) },
    accounts: { ...defaults.accounts, ...(stored.accounts ?? {}) }
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
