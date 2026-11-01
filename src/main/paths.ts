import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'

export const isDev = !app.isPackaged

/** Raiz do projeto em dev; pasta de recursos no app empacotado. */
export function appRoot(): string {
  return isDev ? app.getAppPath() : process.resourcesPath
}

export function ensureDir(dir: string): string {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

export function userDataDir(): string {
  return app.getPath('userData')
}

export function projectsDir(): string {
  return ensureDir(join(userDataDir(), 'projects'))
}

export function projectDir(id: string): string {
  return ensureDir(join(projectsDir(), id))
}

/** Vídeos baixados pelo app (VOD da Twitch, canais vigiados). */
export function downloadsDir(): string {
  return ensureDir(join(userDataDir(), 'vods'))
}

/** Componentes baixados pelo app (Whisper, modelos). */
export function componentsDir(): string {
  return ensureDir(join(userDataDir(), 'components'))
}

/** Componentes que vêm junto no dev (`vendor/`, fora do git). */
export function vendorDir(): string {
  return join(appRoot(), 'vendor')
}

export function resourcesDir(): string {
  return isDev ? join(appRoot(), 'resources') : join(process.resourcesPath, 'resources')
}

export function fontsDir(): string {
  return join(resourcesDir(), 'fonts')
}

export function configFile(name: string): string {
  // O usuário pode sobrescrever qualquer config copiando o arquivo pra pasta de dados.
  const override = join(userDataDir(), name)
  if (existsSync(override)) return override
  return isDev ? join(appRoot(), 'config', name) : join(process.resourcesPath, 'config', name)
}

/** Onde fica o `.env`: na raiz do projeto em dev, na pasta de dados no app empacotado. */
export function envFile(): string {
  return isDev ? join(appRoot(), '.env') : join(userDataDir(), '.env')
}
