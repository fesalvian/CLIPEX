// Instagram Reels via API (conta profissional).
//
// Dois jeitos de conectar, detectados pelo token:
// - Login do Instagram (token "IG…", host graph.instagram.com): mais simples, não precisa de
//   Página do Facebook. Essa API NÃO aceita o arquivo direto: o Instagram baixa o vídeo de um
//   link. O app sobe o vídeo pro Supabase Storage, gera um link temporário, publica e apaga.
// - Login do Facebook (token "EAA…", host graph.facebook.com): conta ligada a uma Página.
//   Aceita upload direto (resumable) e não precisa de storage.

import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync, rmSync, statSync } from 'node:fs'
import { promisify } from 'node:util'
import { ffmpegPath, ffprobePath, videoEncoder } from '../components'
import { secretsRepo } from '../db'
import { env } from '../env'
import { bitrateToFit, fitBitrateArgs, probeArgs } from '../ffmpeg/args'
import { parseProbe } from '../ffmpeg/probe'
import type { NetworkClient, PublishInput, PublishResult, RemoteStats } from './types'

const pexec = promisify(execFile)
const VERSION = 'v21.0'
/** Plano gratuito do Supabase: 50 MB por arquivo. */
const STORAGE_MAX_BYTES = 48 * 1024 * 1024
const TOKEN_KEY = 'instagram-token'

interface StoredToken {
  /** token do .env de onde este foi renovado (se o .env mudar, vale o novo) */
  from: string
  token: string
  refreshedAt: number
}

export function hostForToken(token: string): string {
  const forced = env('INSTAGRAM_GRAPH_HOST')
  if (forced) return forced
  // Login do Instagram gera token "IG…"; Login do Facebook, "EAA…"
  return /^IG/i.test(token) ? 'graph.instagram.com' : 'graph.facebook.com'
}

function envToken(): { token: string; userId: string } {
  const token = env('INSTAGRAM_ACCESS_TOKEN')
  const userId = env('INSTAGRAM_USER_ID')
  if (!token || !userId) {
    throw new Error('Preencha INSTAGRAM_ACCESS_TOKEN e INSTAGRAM_USER_ID no .env (veja o passo a passo no README).')
  }
  return { token, userId }
}

/** Token em uso: o renovado pelo app (se veio do mesmo token do .env) ou o do .env. */
function currentToken(): string {
  const { token } = envToken()
  const stored = secretsRepo.get<StoredToken>(TOKEN_KEY)
  return stored && stored.from === token ? stored.token : token
}

/**
 * Token do login do Instagram dura 60 dias; renovando antes disso ele não vence.
 * Renova no máximo uma vez por semana (a API só deixa renovar token com mais de 24 h).
 */
export async function refreshInstagramToken(force = false): Promise<void> {
  const { token: fromEnv } = envToken()
  if (!/^IG/i.test(fromEnv)) return
  const stored = secretsRepo.get<StoredToken>(TOKEN_KEY)
  const base = stored && stored.from === fromEnv ? stored : { from: fromEnv, token: fromEnv, refreshedAt: 0 }
  if (!force && Date.now() - base.refreshedAt < 7 * 24 * 3600 * 1000) return
  const res = await fetch(
    `https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(base.token)}`
  )
  const json = (await res.json().catch(() => ({}))) as { access_token?: string }
  if (res.ok && json.access_token) secretsRepo.set(TOKEN_KEY, { from: fromEnv, token: json.access_token, refreshedAt: Date.now() })
}

function cfg(): { token: string; userId: string; host: string } {
  const { userId } = envToken()
  const token = currentToken()
  return { token, userId, host: hostForToken(token) }
}

async function graph<T>(method: 'GET' | 'POST', path: string, params: Record<string, string> = {}): Promise<T> {
  const { token, host } = cfg()
  const q = new URLSearchParams({ ...params, access_token: token })
  const url = `https://${host}/${VERSION}/${path}`
  const res = method === 'GET' ? await fetch(`${url}?${q}`) : await fetch(url, { method: 'POST', body: q })
  const json = (await res.json().catch(() => ({}))) as T & { error?: { message?: string } }
  if (!res.ok || json.error) throw new Error(`Instagram: ${json.error?.message ?? res.status}`)
  return json
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export function instagramCaption(text: string, hashtags: string[]): string {
  return [text.trim(), hashtags.join(' ')].filter(Boolean).join('\n\n')
}

async function resumableContainer(input: PublishInput, caption: string, onProgress?: (p: number) => void): Promise<string> {
  const { userId, token } = cfg()
  const c = await graph<{ id: string; uri?: string }>('POST', `${userId}/media`, {
    media_type: 'REELS',
    upload_type: 'resumable',
    caption,
    share_to_feed: 'true'
  })
  const size = statSync(input.videoPath).size
  const res = await fetch(c.uri ?? `https://rupload.facebook.com/ig-api-upload/${VERSION}/${c.id}`, {
    method: 'POST',
    headers: { authorization: `OAuth ${token}`, offset: '0', file_size: String(size) },
    body: readFileSync(input.videoPath)
  })
  onProgress?.(1)
  if (!res.ok) throw new Error(`Upload pro Instagram falhou: ${await res.text()}`)
  return c.id
}

// ---------- storage temporário (Supabase) ----------

function storage(): { base: string; key: string; bucket: string } {
  const base = env('SUPABASE_URL').replace(/\/$/, '')
  const key = env('SUPABASE_SERVICE_ROLE_KEY')
  const bucket = env('SUPABASE_BUCKET') || 'clipador-temp'
  if (!base || !key) {
    throw new Error('O Instagram (login do Instagram) precisa baixar o vídeo de um link: preencha SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY no .env.')
  }
  return { base, key, bucket }
}

function storageHeaders(key: string): Record<string, string> {
  // chave nova "sb_secret_…" vai só no apikey; a antiga (JWT "eyJ…") também no Authorization
  return key.startsWith('eyJ') ? { apikey: key, authorization: `Bearer ${key}` } : { apikey: key }
}

/** Vídeo acima do limite do storage gratuito: cópia com bitrate menor (o Instagram recomprime de qualquer jeito). */
async function fitForStorage(path: string): Promise<{ path: string; temp: boolean }> {
  if (statSync(path).size <= STORAGE_MAX_BYTES) return { path, temp: false }
  const { stdout } = await pexec(ffprobePath(), probeArgs(path), { windowsHide: true })
  const seconds = parseProbe(JSON.parse(stdout), path, 0).durationSec
  const out = path.replace(/\.mp4$/i, '') + '.ig.mp4'
  await pexec(ffmpegPath(), fitBitrateArgs(path, out, bitrateToFit(STORAGE_MAX_BYTES, seconds), await videoEncoder()), {
    windowsHide: true,
    timeout: 10 * 60 * 1000
  })
  return { path: out, temp: true }
}

async function urlContainer(input: PublishInput, caption: string, onProgress?: (p: number) => void): Promise<{ id: string; cleanup: () => Promise<void> }> {
  const { base, key, bucket } = storage()
  const file = await fitForStorage(input.videoPath)
  const object = `${randomUUID()}.mp4`
  try {
    const up = await fetch(`${base}/storage/v1/object/${bucket}/${object}`, {
      method: 'POST',
      headers: { ...storageHeaders(key), 'content-type': 'video/mp4', 'x-upsert': 'true' },
      body: readFileSync(file.path)
    })
    if (!up.ok) throw new Error(`Storage temporário recusou o vídeo: ${await up.text()}`)
  } finally {
    if (file.temp) rmSync(file.path, { force: true })
  }
  onProgress?.(0.6)
  const cleanup = async (): Promise<void> => {
    await fetch(`${base}/storage/v1/object/${bucket}/${object}`, { method: 'DELETE', headers: storageHeaders(key) }).catch(() => undefined)
  }
  try {
    // link assinado de 1 hora: o bucket pode ficar privado
    const sign = await fetch(`${base}/storage/v1/object/sign/${bucket}/${object}`, {
      method: 'POST',
      headers: { ...storageHeaders(key), 'content-type': 'application/json' },
      body: JSON.stringify({ expiresIn: 3600 })
    })
    const signed = (await sign.json().catch(() => ({}))) as { signedURL?: string }
    if (!sign.ok || !signed.signedURL) throw new Error('Não consegui gerar o link temporário do vídeo no Supabase.')
    const videoUrl = `${base}/storage/v1${signed.signedURL}`
    const { userId } = cfg()
    const c = await graph<{ id: string }>('POST', `${userId}/media`, { media_type: 'REELS', video_url: videoUrl, caption, share_to_feed: 'true' })
    return { id: c.id, cleanup }
  } catch (e) {
    await cleanup()
    throw e
  }
}

export const instagram: NetworkClient = {
  network: 'instagram',

  async connected() {
    try {
      await refreshInstagramToken().catch(() => undefined)
      const { userId } = cfg()
      const r = await graph<{ username?: string }>('GET', userId, { fields: 'username' })
      return { connected: true, account: r.username ? `@${r.username}` : null }
    } catch {
      return { connected: false, account: null }
    }
  },

  async connect() {
    // token fica no .env; "conectar" confere se ele funciona (e se o storage está ok quando precisa)
    const { userId } = cfg()
    await graph('GET', userId, { fields: 'username' })
    if (cfg().host === 'graph.instagram.com') storage()
    await refreshInstagramToken(true).catch(() => undefined)
  },

  async publish(input, onProgress): Promise<PublishResult> {
    await refreshInstagramToken().catch(() => undefined)
    const caption = instagramCaption(input.text, input.hashtags)
    let containerId: string
    let cleanup: (() => Promise<void>) | null = null
    if (cfg().host === 'graph.instagram.com') {
      // login do Instagram: só por link
      const r = await urlContainer(input, caption, onProgress)
      containerId = r.id
      cleanup = r.cleanup
    } else {
      try {
        containerId = await resumableContainer(input, caption, onProgress)
      } catch (e) {
        if (!env('SUPABASE_URL')) throw e
        const r = await urlContainer(input, caption, onProgress)
        containerId = r.id
        cleanup = r.cleanup
      }
    }
    try {
      // espera o Instagram baixar e processar o vídeo (só depois dá pra apagar do storage)
      for (let i = 0; i < 90; i++) {
        const st = await graph<{ status_code?: string; status?: string }>('GET', containerId, { fields: 'status_code,status' })
        if (st.status_code === 'FINISHED') break
        if (st.status_code === 'ERROR' || st.status_code === 'EXPIRED') throw new Error(`Instagram não processou o vídeo: ${st.status ?? st.status_code}`)
        await sleep(5000)
      }
      const { userId } = cfg()
      const pub = await graph<{ id: string }>('POST', `${userId}/media_publish`, { creation_id: containerId })
      onProgress?.(1)
      const info = await graph<{ permalink?: string }>('GET', pub.id, { fields: 'permalink' }).catch(() => ({ permalink: undefined }))
      return { remoteId: pub.id, url: info.permalink ?? null, draft: false, scheduledRemotely: false }
    } finally {
      // apaga do storage temporário depois de publicado (ou se deu erro)
      await cleanup?.()
    }
  },

  async metrics(ids) {
    const out = new Map<string, RemoteStats>()
    for (const id of ids) {
      try {
        const m = await graph<{ like_count?: number; comments_count?: number }>('GET', id, { fields: 'like_count,comments_count' })
        const ins = await graph<{ data?: { name: string; values?: { value: number }[] }[] }>('GET', `${id}/insights`, { metric: 'views' }).catch(
          () => ({ data: [] })
        )
        const views = ins.data?.find((d) => d.name === 'views')?.values?.[0]?.value ?? 0
        out.set(id, { views, likes: m.like_count ?? 0, comments: m.comments_count ?? 0 })
      } catch {
        // post apagado ou sem permissão de insights
      }
    }
    return out
  }
}
