// Fontes da legenda e do gancho: as que vêm com o app (resources/fonts) e as importadas
// pelo usuário (pasta de dados/fonts). O libass acha a fonte pelo nome da família gravado
// dentro do arquivo, então lemos a tabela `name` do TTF/OTF.

import { copyFileSync, existsSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import type { FontInfo } from '@shared/types'
import { ensureDir, fontsDir, userDataDir } from './paths'

export interface FontNames {
  family: string
  subfamily: string
}

function decodeName(buf: Buffer, platform: number): string {
  if (platform === 0 || platform === 3) {
    // UTF-16BE
    const chars: string[] = []
    for (let i = 0; i + 1 < buf.length; i += 2) chars.push(String.fromCharCode(buf.readUInt16BE(i)))
    return chars.join('')
  }
  return buf.toString('latin1')
}

/** Lê família (nameID 1) e subfamília (nameID 2) de um TTF/OTF. */
export function readFontNames(data: Buffer): FontNames | null {
  if (data.length < 12) return null
  const tag = data.toString('latin1', 0, 4)
  if (tag === 'wOFF' || tag === 'wOF2' || tag === 'ttcf') return null
  const numTables = data.readUInt16BE(4)
  let nameOffset = -1
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16
    if (rec + 16 > data.length) return null
    if (data.toString('latin1', rec, rec + 4) === 'name') nameOffset = data.readUInt32BE(rec + 8)
  }
  if (nameOffset < 0 || nameOffset + 6 > data.length) return null
  const count = data.readUInt16BE(nameOffset + 2)
  const strings = nameOffset + data.readUInt16BE(nameOffset + 4)
  const found: Record<number, { score: number; value: string }> = {}
  for (let i = 0; i < count; i++) {
    const r = nameOffset + 6 + i * 12
    if (r + 12 > data.length) break
    const platform = data.readUInt16BE(r)
    const encoding = data.readUInt16BE(r + 2)
    const language = data.readUInt16BE(r + 4)
    const nameId = data.readUInt16BE(r + 6)
    const length = data.readUInt16BE(r + 8)
    const offset = data.readUInt16BE(r + 10)
    if (nameId !== 1 && nameId !== 2) continue
    // Windows inglês é o que o libass usa; depois qualquer Windows/Unicode; Mac por último
    const score = platform === 3 && encoding === 1 && language === 0x409 ? 3 : platform === 3 || platform === 0 ? 2 : 1
    if ((found[nameId]?.score ?? 0) >= score) continue
    const start = strings + offset
    if (start + length > data.length) continue
    found[nameId] = { score, value: decodeName(data.subarray(start, start + length), platform).trim() }
  }
  if (!found[1]?.value) return null
  return { family: found[1].value, subfamily: found[2]?.value ?? 'Regular' }
}

function userFontsDir(): string {
  return ensureDir(join(userDataDir(), 'fonts'))
}

function scan(dir: string, source: FontInfo['source']): FontInfo[] {
  if (!existsSync(dir)) return []
  const out: FontInfo[] = []
  for (const f of readdirSync(dir)) {
    if (!/\.(ttf|otf)$/i.test(f)) continue
    const file = join(dir, f)
    try {
      const names = readFontNames(readFileSync(file))
      if (names) out.push({ family: names.family, file, source, bold: /bold/i.test(names.subfamily) })
    } catch {
      // arquivo corrompido: ignora
    }
  }
  return out
}

let cache: FontInfo[] | null = null

export function listFonts(): FontInfo[] {
  if (!cache) {
    const all = [...scan(fontsDir(), 'bundled'), ...scan(userFontsDir(), 'user')]
    // a importada ganha da embutida se tiver o mesmo nome
    const byFamily = new Map<string, FontInfo>()
    for (const f of all) byFamily.set(f.family.toLowerCase(), f)
    cache = [...byFamily.values()].sort((a, b) => a.family.localeCompare(b.family))
  }
  return cache
}

export function findFont(family: string): FontInfo | null {
  return listFonts().find((f) => f.family.toLowerCase() === family.toLowerCase()) ?? null
}

/** Copia fontes escolhidas pelo usuário pra pasta do app. Devolve as que entraram. */
export function importFonts(files: string[]): { added: FontInfo[]; rejected: string[] } {
  const added: FontInfo[] = []
  const rejected: string[] = []
  for (const file of files) {
    const ext = extname(file).toLowerCase()
    const names = ext === '.ttf' || ext === '.otf' ? readFontNames(readFileSync(file)) : null
    if (!names) {
      rejected.push(basename(file))
      continue
    }
    const dest = join(userFontsDir(), basename(file))
    copyFileSync(file, dest)
    added.push({ family: names.family, file: dest, source: 'user', bold: /bold/i.test(names.subfamily) })
  }
  cache = null
  return { added, rejected }
}

export function removeFont(family: string): void {
  const f = findFont(family)
  if (f?.source === 'user') rmSync(f.file, { force: true })
  cache = null
}
