// Protocolo clipador-media:// pra interface tocar previews e ver imagens locais.
// Responde Range (o <video> precisa pra navegar) e só serve arquivos das pastas do app.

import { createReadStream, existsSync, statSync } from 'node:fs'
import { extname, normalize, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { protocol } from 'electron'
import { MEDIA_SCHEME } from '@shared/ipc'
import { resourcesDir, userDataDir } from './paths'

const TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wav': 'audio/wav'
}

export function registerMediaScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: MEDIA_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: false } }
  ])
}

function allowed(path: string): boolean {
  const p = normalize(resolve(path)).toLowerCase()
  return [userDataDir(), resourcesDir()].some((root) => p.startsWith(normalize(resolve(root)).toLowerCase()))
}

/** clipador-media://local/<caminho codificado> */
export function pathFromUrl(url: string): string {
  const u = new URL(url)
  return decodeURIComponent(u.pathname.replace(/^\//, ''))
}

export function handleMediaProtocol(): void {
  protocol.handle(MEDIA_SCHEME, (req) => {
    let path: string
    try {
      path = pathFromUrl(req.url)
    } catch {
      return new Response('bad url', { status: 400 })
    }
    if (!allowed(path) || !existsSync(path)) return new Response('not found', { status: 404 })
    const size = statSync(path).size
    const type = TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream'
    const range = req.headers.get('range')
    const headers: Record<string, string> = { 'content-type': type, 'accept-ranges': 'bytes', 'cache-control': 'no-cache' }
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range)
      let start = m?.[1] ? Number(m[1]) : 0
      let end = m?.[2] ? Number(m[2]) : size - 1
      if (!m?.[1] && m?.[2]) {
        start = Math.max(0, size - Number(m[2]))
        end = size - 1
      }
      end = Math.min(end, size - 1)
      if (start > end || start >= size) return new Response(null, { status: 416, headers: { 'content-range': `bytes */${size}` } })
      const stream = Readable.toWeb(createReadStream(path, { start, end })) as ReadableStream
      return new Response(stream, {
        status: 206,
        headers: { ...headers, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': String(end - start + 1) }
      })
    }
    const stream = Readable.toWeb(createReadStream(path)) as ReadableStream
    return new Response(stream, { status: 200, headers: { ...headers, 'content-length': String(size) } })
  })
}
