// TikTok: Content Posting API, upload pro inbox (rascunho). App não auditado só consegue
// postar privado, então o MVP manda como rascunho e o usuário confirma no app do TikTok.

import { closeSync, openSync, readSync, statSync } from 'node:fs'
import { secretsRepo } from '../db'
import { env } from '../env'
import { loopbackAuth, pkce, postForm } from './oauth'
import type { NetworkClient, PublishResult, RemoteStats } from './types'

const KEY = 'tiktok'
/** Porta fixa: o TikTok exige a URI de retorno cadastrada no app (http://127.0.0.1:51789/callback/). */
const PORT = 51789
const CALLBACK = '/callback/'
const MB = 1024 * 1024
const CHUNK = 10 * MB

/**
 * Pedaços do upload (Media Transfer Guide: pedaços de 5 a 64 MB, o último leva o resto).
 * Até 64 MB vai inteiro: o TikTok recusou um vídeo de 19 MB mandado como "1 pedaço de 10 MB"
 * com o resto embutido ("The chunk size is invalid"). Acima disso, pedaços de 10 MB.
 */
export function chunkPlan(size: number): { chunkSize: number; count: number } {
  if (size <= 64 * MB) return { chunkSize: size, count: 1 }
  return { chunkSize: CHUNK, count: Math.floor(size / CHUNK) }
}

interface Tokens {
  access_token: string
  refresh_token: string
  expires_at: number
  open_id: string
  account: string | null
}

function creds(): { key: string; secret: string } {
  const key = env('TIKTOK_CLIENT_KEY')
  const secret = env('TIKTOK_CLIENT_SECRET')
  if (!key || !secret) throw new Error('Preencha TIKTOK_CLIENT_KEY e TIKTOK_CLIENT_SECRET no .env (TikTok for Developers).')
  return { key, secret }
}

async function accessToken(): Promise<string> {
  const t = secretsRepo.get<Tokens>(KEY)
  if (!t) throw new Error('Conecte a conta do TikTok nas configurações.')
  if (Date.now() < t.expires_at - 60_000) return t.access_token
  const { key, secret } = creds()
  const r = await postForm('https://open.tiktokapis.com/v2/oauth/token/', {
    client_key: key,
    client_secret: secret,
    grant_type: 'refresh_token',
    refresh_token: t.refresh_token
  })
  const next: Tokens = {
    ...t,
    access_token: String(r.access_token),
    refresh_token: String(r.refresh_token ?? t.refresh_token),
    expires_at: Date.now() + Number(r.expires_in ?? 86400) * 1000
  }
  secretsRepo.set(KEY, next)
  return next.access_token
}

async function api<T>(path: string, body: unknown): Promise<T> {
  const token = await accessToken()
  const res = await fetch(`https://open.tiktokapis.com${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=UTF-8' },
    body: JSON.stringify(body)
  })
  const json = (await res.json().catch(() => ({}))) as { data?: T; error?: { code?: string; message?: string } }
  if (!res.ok || (json.error && json.error.code !== 'ok')) throw new Error(`TikTok: ${json.error?.message ?? res.status}`)
  return json.data as T
}

export const tiktok: NetworkClient = {
  network: 'tiktok',

  async connected() {
    const t = secretsRepo.get<Tokens>(KEY)
    return { connected: !!t, account: t?.account ?? null }
  },

  async connect() {
    const { key, secret } = creds()
    // O TikTok desktop usa o desafio PKCE em hexadecimal.
    const p = pkce('hex')
    const { code, redirectUri } = await loopbackAuth(
      (redirect, state) => {
        const q = new URLSearchParams({
          client_key: key,
          response_type: 'code',
          scope: 'user.info.basic,video.upload',
          redirect_uri: redirect,
          state,
          code_challenge: p.challenge,
          code_challenge_method: 'S256'
        })
        return `https://www.tiktok.com/v2/auth/authorize/?${q}`
      },
      { port: PORT, path: CALLBACK }
    )
    const r = await postForm('https://open.tiktokapis.com/v2/oauth/token/', {
      client_key: key,
      client_secret: secret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
      code_verifier: p.verifier
    })
    secretsRepo.set(KEY, {
      access_token: String(r.access_token),
      refresh_token: String(r.refresh_token ?? ''),
      expires_at: Date.now() + Number(r.expires_in ?? 86400) * 1000,
      open_id: String(r.open_id ?? ''),
      account: null
    } satisfies Tokens)
    try {
      const token = await accessToken()
      const res = await fetch('https://open.tiktokapis.com/v2/user/info/?fields=display_name,username', {
        headers: { authorization: `Bearer ${token}` }
      })
      const json = (await res.json()) as { data?: { user?: { username?: string; display_name?: string } } }
      const u = json.data?.user
      const t = secretsRepo.get<Tokens>(KEY)!
      secretsRepo.set(KEY, { ...t, account: u?.username ? `@${u.username}` : (u?.display_name ?? null) })
    } catch {
      // nome da conta é só pra exibir
    }
  },

  async publish(input, onProgress): Promise<PublishResult> {
    const size = statSync(input.videoPath).size
    const { chunkSize: chunk, count } = chunkPlan(size)
    const init = await api<{ publish_id: string; upload_url: string }>('/v2/post/publish/inbox/video/init/', {
      source_info: { source: 'FILE_UPLOAD', video_size: size, chunk_size: chunk, total_chunk_count: count }
    })
    const fd = openSync(input.videoPath, 'r')
    try {
      for (let i = 0; i < count; i++) {
        const start = i * chunk
        // o último pedaço leva o resto do arquivo
        const end = i === count - 1 ? size - 1 : start + chunk - 1
        const buf = Buffer.alloc(end - start + 1)
        readSync(fd, buf, 0, buf.length, start)
        const res = await fetch(init.upload_url, {
          method: 'PUT',
          headers: { 'content-type': 'video/mp4', 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': String(buf.length) },
          body: buf
        })
        if (!res.ok && res.status !== 206) throw new Error(`Upload pro TikTok falhou (${res.status})`)
        onProgress?.((end + 1) / size)
      }
    } finally {
      closeSync(fd)
    }
    return { remoteId: init.publish_id, url: null, draft: true, scheduledRemotely: false }
  },

  async metrics() {
    // Rascunhos viram post só quando o usuário publica no app; sem id do vídeo final não dá pra medir.
    return new Map<string, RemoteStats>()
  }
}
