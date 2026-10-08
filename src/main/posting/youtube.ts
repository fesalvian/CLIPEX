// YouTube Shorts: OAuth de app desktop, upload resumable e agendamento nativo (publishAt).

import { createReadStream, statSync } from 'node:fs'
import { Readable } from 'node:stream'
import { secretsRepo } from '../db'
import { env } from '../env'
import { loopbackAuth, pkce, postForm } from './oauth'
import type { NetworkClient, PublishInput, PublishResult, RemoteStats } from './types'

const SCOPES = ['https://www.googleapis.com/auth/youtube.upload', 'https://www.googleapis.com/auth/youtube.readonly']
const KEY = 'youtube'

interface Tokens {
  access_token: string
  refresh_token: string
  expires_at: number
  channel: string | null
}

function creds(): { id: string; secret: string } {
  const id = env('YOUTUBE_CLIENT_ID')
  const secret = env('YOUTUBE_CLIENT_SECRET')
  if (!id || !secret) throw new Error('Preencha YOUTUBE_CLIENT_ID e YOUTUBE_CLIENT_SECRET no .env (Google Cloud › Credenciais › App para computador).')
  return { id, secret }
}

async function accessToken(): Promise<string> {
  const t = secretsRepo.get<Tokens>(KEY)
  if (!t) throw new Error('Conecte a conta do YouTube nas configurações.')
  if (Date.now() < t.expires_at - 60_000) return t.access_token
  const { id, secret } = creds()
  const r = await postForm('https://oauth2.googleapis.com/token', {
    client_id: id,
    client_secret: secret,
    refresh_token: t.refresh_token,
    grant_type: 'refresh_token'
  })
  const next = { ...t, access_token: String(r.access_token), expires_at: Date.now() + Number(r.expires_in ?? 3600) * 1000 }
  secretsRepo.set(KEY, next)
  return next.access_token
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = await accessToken()
  const res = await fetch(`https://www.googleapis.com/youtube/v3/${path}`, {
    ...init,
    headers: { ...(init.headers ?? {}), authorization: `Bearer ${token}` }
  })
  const json = (await res.json().catch(() => ({}))) as T & { error?: { message?: string } }
  if (!res.ok) throw new Error(`YouTube: ${json.error?.message ?? res.status}`)
  return json
}

export function youtubeDescription(text: string, hashtags: string[]): string {
  // As 3 primeiras hashtags da descrição aparecem acima do título.
  return [text.trim(), hashtags.join(' ')].filter(Boolean).join('\n\n')
}

export const youtube: NetworkClient = {
  network: 'youtube',

  async connected() {
    const t = secretsRepo.get<Tokens>(KEY)
    return { connected: !!t, account: t?.channel ?? null }
  },

  async connect() {
    const { id, secret } = creds()
    const p = pkce()
    const { code, redirectUri } = await loopbackAuth((redirect, state) => {
      const q = new URLSearchParams({
        client_id: id,
        redirect_uri: redirect,
        response_type: 'code',
        scope: SCOPES.join(' '),
        access_type: 'offline',
        prompt: 'consent',
        state,
        code_challenge: p.challenge,
        code_challenge_method: 'S256'
      })
      return `https://accounts.google.com/o/oauth2/v2/auth?${q}`
    })
    const r = await postForm('https://oauth2.googleapis.com/token', {
      client_id: id,
      client_secret: secret,
      code,
      code_verifier: p.verifier,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri
    })
    secretsRepo.set(KEY, {
      access_token: String(r.access_token),
      refresh_token: String(r.refresh_token ?? ''),
      expires_at: Date.now() + Number(r.expires_in ?? 3600) * 1000,
      channel: null
    } satisfies Tokens)
    try {
      const ch = await api<{ items?: { snippet?: { customUrl?: string; title?: string } }[] }>('channels?part=snippet&mine=true')
      const sn = ch.items?.[0]?.snippet
      const t = secretsRepo.get<Tokens>(KEY)!
      secretsRepo.set(KEY, { ...t, channel: sn?.customUrl ?? sn?.title ?? null })
    } catch {
      // nome do canal é só pra exibir
    }
  },

  async publish(input: PublishInput, onProgress): Promise<PublishResult> {
    const token = await accessToken()
    const size = statSync(input.videoPath).size
    const meta = {
      snippet: {
        title: (input.title ?? '').slice(0, 100),
        description: youtubeDescription(input.text, input.hashtags),
        categoryId: '20',
        defaultLanguage: 'pt-BR',
        defaultAudioLanguage: 'pt-BR'
      },
      status: {
        privacyStatus: input.publishAt ? 'private' : 'public',
        ...(input.publishAt ? { publishAt: new Date(input.publishAt).toISOString() } : {}),
        selfDeclaredMadeForKids: false
      }
    }
    const init = await fetch('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json; charset=UTF-8',
        'x-upload-content-type': 'video/mp4',
        'x-upload-content-length': String(size)
      },
      body: JSON.stringify(meta)
    })
    const location = init.headers.get('location')
    if (!init.ok || !location) throw new Error(`YouTube recusou o upload: ${await init.text()}`)
    let sent = 0
    const stream = createReadStream(input.videoPath)
    stream.on('data', (chunk) => {
      sent += chunk.length
      onProgress?.(sent / size)
    })
    const up = await fetch(location, {
      method: 'PUT',
      headers: { 'content-type': 'video/mp4', 'content-length': String(size) },
      body: Readable.toWeb(stream) as ReadableStream,
      duplex: 'half'
    } as RequestInit & { duplex: 'half' })
    const json = (await up.json().catch(() => ({}))) as { id?: string; error?: { message?: string } }
    if (!up.ok || !json.id) throw new Error(`Upload pro YouTube falhou: ${json.error?.message ?? up.status}`)
    return { remoteId: json.id, url: `https://youtube.com/shorts/${json.id}`, draft: false, scheduledRemotely: !!input.publishAt }
  },

  async metrics(ids: string[]) {
    const out = new Map<string, RemoteStats>()
    for (let i = 0; i < ids.length; i += 50) {
      const batch = ids.slice(i, i + 50)
      const r = await api<{ items?: { id: string; statistics?: Record<string, string> }[] }>(
        `videos?part=statistics&id=${batch.join(',')}`
      )
      for (const it of r.items ?? []) {
        out.set(it.id, {
          views: Number(it.statistics?.viewCount ?? 0),
          likes: Number(it.statistics?.likeCount ?? 0),
          comments: Number(it.statistics?.commentCount ?? 0)
        })
      }
    }
    return out
  }
}
