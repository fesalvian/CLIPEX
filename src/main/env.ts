import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { parse } from 'dotenv'
import { envFile } from './paths'

let cache: Record<string, string> | null = null

export function loadEnv(): Record<string, string> {
  const file = envFile()
  cache = existsSync(file) ? parse(readFileSync(file)) : {}
  return cache
}

export function env(key: string): string {
  if (!cache) loadEnv()
  return (cache?.[key] ?? process.env[key] ?? '').trim()
}

/** Grava (ou troca) uma chave no `.env`, preservando o resto do arquivo. */
export function setEnv(key: string, value: string): void {
  const file = envFile()
  const lines = existsSync(file) ? readFileSync(file, 'utf8').split(/\r?\n/) : []
  const clean = value.replace(/[\r\n]/g, '').trim()
  let found = false
  const out = lines.map((l) => {
    if (l.startsWith(`${key}=`)) {
      found = true
      return `${key}=${clean}`
    }
    return l
  })
  if (!found) out.push(`${key}=${clean}`)
  writeFileSync(file, out.join('\n').replace(/\n*$/, '\n'))
  loadEnv()
}
