// OAuth de app desktop: abre o navegador e recebe o código num servidor local (loopback).

import { createHash, randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { shell } from 'electron'

export interface Pkce {
  verifier: string
  challenge: string
}

export function pkce(encoding: 'base64url' | 'hex' = 'base64url'): Pkce {
  const verifier = randomBytes(48).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest(encoding)
  return { verifier, challenge }
}

const PAGE = (ok: boolean, msg: string): string => `<!doctype html><meta charset="utf-8"><title>Clipador</title>
<body style="font-family:system-ui;background:#0A0F2C;color:#EEEEF6;display:grid;place-items:center;height:100vh;margin:0">
<div style="text-align:center"><h2 style="color:${ok ? '#C4B5FD' : '#FFC48A'}">${ok ? 'Conta conectada' : 'Não deu certo'}</h2><p>${msg}</p></div></body>`

export interface LoopbackResult {
  code: string
  redirectUri: string
}

/**
 * Sobe um servidor em 127.0.0.1 (porta fixa quando a rede exige URI registrada),
 * abre a URL de autorização e espera o código voltar.
 */
export async function loopbackAuth(
  buildUrl: (redirectUri: string, state: string) => string,
  opts: { port?: number; path?: string; host?: string } = {}
): Promise<LoopbackResult> {
  const state = randomBytes(16).toString('hex')
  const path = opts.path ?? '/'
  const host = opts.host ?? '127.0.0.1'
  let server: Server | null = null
  try {
    return await new Promise<LoopbackResult>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Tempo esgotado esperando a autorização.')), 5 * 60 * 1000)
      server = createServer((req, res) => {
        const url = new URL(req.url ?? '/', `http://${host}`)
        if (url.pathname !== path) {
          res.writeHead(404).end()
          return
        }
        const code = url.searchParams.get('code')
        const err = url.searchParams.get('error_description') ?? url.searchParams.get('error')
        if (url.searchParams.get('state') !== state || !code) {
          res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' }).end(PAGE(false, err ?? 'Resposta inválida.'))
          clearTimeout(timer)
          reject(new Error(err ?? 'Autorização cancelada.'))
          return
        }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(PAGE(true, 'Pode fechar esta aba e voltar pro Clipador.'))
        clearTimeout(timer)
        const addr = server!.address()
        const port = typeof addr === 'object' && addr ? addr.port : opts.port
        resolve({ code, redirectUri: `http://${host}:${port}${path}` })
      })
      server.on('error', (e) => reject(e))
      server.listen(opts.port ?? 0, '127.0.0.1', () => {
        const addr = server!.address()
        const port = typeof addr === 'object' && addr ? addr.port : opts.port
        void shell.openExternal(buildUrl(`http://${host}:${port}${path}`, state))
      })
    })
  } finally {
    ;(server as Server | null)?.close()
  }
}

export async function postForm(url: string, form: Record<string, string>): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString()
  })
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (!res.ok || json.error) {
    throw new Error(`Autorização falhou: ${String(json.error_description ?? json.error ?? res.status)}`)
  }
  return json
}
