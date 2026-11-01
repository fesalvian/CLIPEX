// YouTube Shorts: OAuth de app desktop, upload resumable e agendamento nativo (publishAt).

import { createReadStream, statSync } from 'node:fs'
import { Readable } from 'node:stream'
import { secretsRepo } from '../db'
import { env } from '../env'
import { secretKey } from '../profiles'
import { loopbackAuth, pkce, postForm } from './oauth'
import { QuotaError, type NetworkClient, type PublishInput, type PublishResult, type RemoteStats } from './types'

// force-ssl: mudar o horário ou apagar um Short já agendado (organizar a fila)
const EDIT_SCOPE = 'https://www.googleapis.com/auth/youtube.force-ssl'
const SCOPES = ['https://www.googleapis.com/auth/youtube.upload', 'https://www.googleapis.com/auth/youtube.readonly', EDIT_SCOPE]
const KEY = 'youtube'

interface Tokens {
  access_token: string
  refresh_token: string
  expires_at: number
  channel: string | null
  /** permissões dadas na conexão (conexões antigas não guardavam) */
  scope?: string
}

function creds(): { id: string; secret: string } {
  const id = env('YOUTUBE_CLIENT_ID')
  const secret = env('YOUTUBE_CLIENT_SECRET')
  if (!id || !secret) throw new Error('Preencha YOUTUBE_CLIENT_ID e YOUTUBE_CLIENT_SECRET no .env (Google Cloud › Credenciais › App para computador).')
  return { id, secret }
}

async function accessToken(profileId: string): Promise<string> {
  const key = secretKey(KEY, profileId)
  const t = secretsRepo.get<Tokens>(key)
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
  secretsRepo.set(key, next)
  return next.access_token
}

/** Erro de cota da API (10.000 unidades por dia, por projeto do Google). */
function isQuota(message: string): boolean {
  return /quota/i.test(message)
}

async function api<T>(profileId: string, path: string, init: RequestInit = {}): Promise<T> {
  const token = await accessToken(profileId)
  const res = await fetch(`https://www.googleapis.com/youtube/v3/${path}`, {
    ...init,
    headers: { ...(init.headers ?? {}), authorization: `Bearer ${token}` }
  })
  const json = (await res.json().catch(() => ({}))) as T & { error?: { message?: string } }
  if (!res.ok) {
    const msg = `YouTube: ${json.error?.message ?? res.status}`
    throw isQuota(msg) ? new QuotaError(msg) : new Error(msg)
  }
  return json
}

export function youtubeDescription(text: string, hashtags: string[]): string {
  // As 3 primeiras hashtags da descrição aparecem acima do título.
  return [text.trim(), hashtags.join(' ')].filter(Boolean).join('\n\n')
}

/** A conexão permite mudar o horário e apagar Shorts já agendados (conexões antigas não). */
export function youtubeCanEdit(profileId: string): boolean {
  return !!secretsRepo.get<Tokens>(secretKey(KEY, profileId))?.scope?.includes(EDIT_SCOPE)
}

/** Muda a hora de publicar de um Short já agendado no YouTube. */
export async function youtubeReschedule(profileId: string, videoId: string, publishAt: Date): Promise<void> {
  await api(profileId, 'videos?part=status', {
    method: 'PUT',
    headers: { 'content-type': 'application/json; charset=UTF-8' },
    body: JSON.stringify({
      id: videoId,
      status: { privacyStatus: 'private', publishAt: publishAt.toISOString(), selfDeclaredMadeForKids: false }
    })
  })
}

/** Apaga um Short (privado, agendado) do canal. */
export async function youtubeDelete(profileId: string, videoId: string): Promise<void> {
  await api(profileId, `videos?id=${encodeURIComponent(videoId)}`, { method: 'DELETE' })
}

export const youtube: NetworkClient = {
  network: 'youtube',

  async connected(profileId) {
    const t = secretsRepo.get<Tokens>(secretKey(KEY, profileId))
    return { connected: !!t, account: t?.channel ?? null }
  },

  async connect(profileId) {
    const key = secretKey(KEY, profileId)
    const { id, secret } = creds()
    const p = pkce()
    const { code, redirectUri } = await loopbackAuth((redirect, state) => {
      const q = new URLSearchParams({
        client_id: id,
        redirect_uri: redirect,
        response_type: 'code',
        scope: SCOPES.join(' '),
        access_type: 'offline',
        // escolher a conta: cada perfil pode ser um canal diferente
        prompt: 'consent select_account',
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
    secretsRepo.set(key, {
      access_token: String(r.access_token),
      refresh_token: String(r.refresh_token ?? ''),
      expires_at: Date.now() + Number(r.expires_in ?? 3600) * 1000,
      channel: null,
      scope: String(r.scope ?? '')
    } satisfies Tokens)
    try {
      const ch = await api<{ items?: { snippet?: { customUrl?: string; title?: string } }[] }>(profileId, 'channels?part=snippet&mine=true')
      const sn = ch.items?.[0]?.snippet
      const t = secretsRepo.get<Tokens>(key)!
      secretsRepo.set(key, { ...t, channel: sn?.customUrl ?? sn?.title ?? null })
    } catch {
      // nome do canal é só pra exibir
    }
  },

  async publish(profileId, input: PublishInput, onProgress): Promise<PublishResult> {
    const token = await accessToken(profileId)
    const size = statSync(input.videoPath).size
    const meta = {
      snippet: {
        title: (input.title ?? '').slice(0, 100),
        description: youtubeDescription(input.text, input.hashtags),
        categoryId: input.categoryId ?? '20',
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
    if (!init.ok || !location) {
      const body = await init.text()
      if (isQuota(body)) throw new QuotaError('YouTube: a cota diária da API acabou.')
      throw new Error(`YouTube recusou o upload: ${body}`)
    }
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
    const json = (await up.json().catch(() => ({}))) as { id?: string; status?: { privacyStatus?: string }; error?: { message?: string } }
    if (!up.ok || !json.id) throw new Error(`Upload pro YouTube falhou: ${json.error?.message ?? up.status}`)
    // Projeto sem auditoria da API: o YouTube trava o vídeo como privado mesmo pedindo público.
    let privacy = json.status?.privacyStatus
    try {
      const st = await api<{ items?: { status?: { privacyStatus?: string } }[] }>(profileId, `videos?part=status&id=${json.id}`)
      privacy = st.items?.[0]?.status?.privacyStatus ?? privacy
    } catch {
      // sem leitura do status: fica com o que veio no upload
    }
    const lockedPrivate = !input.publishAt && privacy === 'private'
    return {
      remoteId: json.id,
      url: `https://youtube.com/shorts/${json.id}`,
      draft: false,
      scheduledRemotely: !!input.publishAt,
      note: lockedPrivate
        ? 'Subiu como privado: o YouTube só libera público pra projetos que passaram pela auditoria da API. Dá pra tornar público no YouTube Studio.'
        : undefined
    }
  },

  async metrics(profileId, ids: string[]) {
    const out = new Map<string, RemoteStats>()
    for (let i = 0; i < ids.length; i += 50) {
      const batch = ids.slice(i, i + 50)
      const r = await api<{ items?: { id: string; statistics?: Record<string, string> }[] }>(
        profileId,
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
