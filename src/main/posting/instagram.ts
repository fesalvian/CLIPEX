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
import { DEFAULT_PROFILE_ID } from '@shared/defaults'
import { secretsRepo } from '../db'
import { env, setEnv } from '../env'
import { secretKey } from '../profiles'
import { bitrateToFit, fitBitrateArgs, probeArgs } from '../ffmpeg/args'
import { parseProbe } from '../ffmpeg/probe'
import type { NetworkClient, PublishInput, PublishResult, RemoteStats } from './types'

const pexec = promisify(execFile)
const VERSION = 'v21.0'
/** Plano gratuito do Supabase: 50 MB por arquivo. */
const STORAGE_MAX_BYTES = 48 * 1024 * 1024
const TOKEN_KEY = 'instagram-token'
/** conta dos outros perfis (o do Felipe usa o .env) */
const ACCOUNT_KEY = 'instagram-account'

interface StoredToken {
  /** token do .env de onde este foi renovado (se o .env mudar, vale o novo) */
  from: string
  token: string
  refreshedAt: number
}

interface Account {
  token: string
  userId: string
}

export function hostForToken(token: string): string {
  const forced = env('INSTAGRAM_GRAPH_HOST')
  if (forced) return forced
  // Login do Instagram gera token "IG…"; Login do Facebook, "EAA…"
  return /^IG/i.test(token) ? 'graph.instagram.com' : 'graph.facebook.com'
}

/** Token e conta colados pelo usuário: .env no perfil do Felipe, cofre do app nos outros. */
function baseAccount(profileId: string): Account {
  if (profileId !== DEFAULT_PROFILE_ID) {
    const a = secretsRepo.get<Account>(secretKey(ACCOUNT_KEY, profileId))
    if (!a) throw new Error('Cole o token do Instagram deste perfil em Configurações › Contas.')
    return a
  }
  const token = env('INSTAGRAM_ACCESS_TOKEN')
  const userId = env('INSTAGRAM_USER_ID')
  if (!token || !userId) {
    throw new Error('Preencha INSTAGRAM_ACCESS_TOKEN e INSTAGRAM_USER_ID no .env (veja o passo a passo no README).')
  }
  return { token, userId }
}

/** Token em uso: o renovado pelo app (se veio do mesmo token colado) ou o colado. */
function currentToken(profileId: string): string {
  const { token } = baseAccount(profileId)
  const stored = secretsRepo.get<StoredToken>(secretKey(TOKEN_KEY, profileId))
  return stored && stored.from === token ? stored.token : token
}

/**
 * Token do login do Instagram dura 60 dias; renovando antes disso ele não vence.
 * Renova no máximo uma vez por semana (a API só deixa renovar token com mais de 24 h).
 */
export async function refreshInstagramToken(profileId: string, force = false): Promise<void> {
  const { token: from } = baseAccount(profileId)
  if (!/^IG/i.test(from)) return
  const key = secretKey(TOKEN_KEY, profileId)
  const stored = secretsRepo.get<StoredToken>(key)
  const base = stored && stored.from === from ? stored : { from, token: from, refreshedAt: 0 }
  if (!force && Date.now() - base.refreshedAt < 7 * 24 * 3600 * 1000) return
  const res = await fetch(
    `https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(base.token)}`
  )
  const json = (await res.json().catch(() => ({}))) as { access_token?: string }
  if (res.ok && json.access_token) secretsRepo.set(key, { from, token: json.access_token, refreshedAt: Date.now() })
}

function cfg(profileId: string): { token: string; userId: string; host: string } {
  const { userId } = baseAccount(profileId)
  const token = currentToken(profileId)
  return { token, userId, host: hostForToken(token) }
}

/**
 * Token novo colado na tela: no perfil do Felipe vai pro .env (como antes); nos outros, pro
 * cofre do app, com o id da conta lido do próprio token (login do Instagram, "IG…").
 */
export async function setInstagramToken(profileId: string, token: string): Promise<void> {
  const clean = token.replace(/\s/g, '')
  if (profileId === DEFAULT_PROFILE_ID) {
    setEnv('INSTAGRAM_ACCESS_TOKEN', clean)
    return
  }
  if (!/^IG/i.test(clean)) throw new Error('Nos outros perfis use o token do login do Instagram (começa com IG).')
  const res = await fetch(`https://graph.instagram.com/${VERSION}/me?fields=user_id,username&access_token=${encodeURIComponent(clean)}`)
  const json = (await res.json().catch(() => ({}))) as { user_id?: string | number; id?: string; error?: { message?: string } }
  const userId = String(json.user_id ?? json.id ?? '')
  if (!res.ok || !userId) throw new Error(`Instagram não aceitou o token: ${json.error?.message ?? res.status}`)
  secretsRepo.set(secretKey(ACCOUNT_KEY, profileId), { token: clean, userId } satisfies Account)
}

async function graph<T>(profileId: string, method: 'GET' | 'POST', path: string, params: Record<string, string> = {}): Promise<T> {
  const { token, host } = cfg(profileId)
  const q = new URLSearchParams({ ...params, access_token: token })
  const url = `https://${host}/${VERSION}/${path}`
  const res = method === 'GET' ? await fetch(`${url}?${q}`) : await fetch(url, { method: 'POST', body: q })
  const json = (await res.json().catch(() => ({}))) as T & { error?: { message?: string; code?: number } }
  if (json.error?.code === 190) throw new Error(INVALID_TOKEN)
  if (!res.ok || json.error) throw new Error(`Instagram: ${json.error?.message ?? res.status}`)
  return json
}

/** Código 190: token vencido ou derrubado (troca de senha, sessão encerrada pela Meta). */
const INVALID_TOKEN =
  'Instagram: o token não vale mais (troca de senha ou sessão encerrada pela Meta). Gere um token novo no painel da Meta e cole em Configurações › Contas.'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export function instagramCaption(text: string, hashtags: string[]): string {
  return [text.trim(), hashtags.join(' ')].filter(Boolean).join('\n\n')
}

async function resumableContainer(profileId: string, input: PublishInput, caption: string, onProgress?: (p: number) => void): Promise<string> {
  const { userId, token } = cfg(profileId)
  const c = await graph<{ id: string; uri?: string }>(profileId, 'POST', `${userId}/media`, {
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

async function urlContainer(
  profileId: string,
  input: PublishInput,
  caption: string,
  onProgress?: (p: number) => void
): Promise<{ id: string; cleanup: () => Promise<void> }> {
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
    const { userId } = cfg(profileId)
    const c = await graph<{ id: string }>(profileId, 'POST', `${userId}/media`, {
      media_type: 'REELS',
      video_url: videoUrl,
      caption,
      share_to_feed: 'true'
    })
    return { id: c.id, cleanup }
  } catch (e) {
    await cleanup()
    throw e
  }
}

export const instagram: NetworkClient = {
  network: 'instagram',

  async connected(profileId) {
    try {
      await refreshInstagramToken(profileId).catch(() => undefined)
      const { userId } = cfg(profileId)
      const r = await graph<{ username?: string }>(profileId, 'GET', userId, { fields: 'username' })
      return { connected: true, account: r.username ? `@${r.username}` : null }
    } catch {
      return { connected: false, account: null }
    }
  },

  async connect(profileId) {
    // token fica no .env (ou no cofre, nos outros perfis); "conectar" confere se ele funciona
    // (e se o storage está ok quando precisa)
    const { userId } = cfg(profileId)
    await graph(profileId, 'GET', userId, { fields: 'username' })
    if (cfg(profileId).host === 'graph.instagram.com') storage()
    await refreshInstagramToken(profileId, true).catch(() => undefined)
  },

  async publish(profileId, input, onProgress): Promise<PublishResult> {
    await refreshInstagramToken(profileId).catch(() => undefined)
    const caption = instagramCaption(input.text, input.hashtags)
    let containerId: string
    let cleanup: (() => Promise<void>) | null = null
    if (cfg(profileId).host === 'graph.instagram.com') {
      // login do Instagram: só por link
      const r = await urlContainer(profileId, input, caption, onProgress)
      containerId = r.id
      cleanup = r.cleanup
    } else {
      try {
        containerId = await resumableContainer(profileId, input, caption, onProgress)
      } catch (e) {
        if (!env('SUPABASE_URL')) throw e
        const r = await urlContainer(profileId, input, caption, onProgress)
        containerId = r.id
        cleanup = r.cleanup
      }
    }
    try {
      // espera o Instagram baixar e processar o vídeo (só depois dá pra apagar do storage)
      for (let i = 0; i < 90; i++) {
        const st = await graph<{ status_code?: string; status?: string }>(profileId, 'GET', containerId, { fields: 'status_code,status' })
        if (st.status_code === 'FINISHED') break
        if (st.status_code === 'ERROR' || st.status_code === 'EXPIRED') throw new Error(`Instagram não processou o vídeo: ${st.status ?? st.status_code}`)
        await sleep(5000)
      }
      const { userId } = cfg(profileId)
      const pub = await graph<{ id: string }>(profileId, 'POST', `${userId}/media_publish`, { creation_id: containerId })
      onProgress?.(1)
      const info = await graph<{ permalink?: string }>(profileId, 'GET', pub.id, { fields: 'permalink' }).catch(() => ({
        permalink: undefined
      }))
      return { remoteId: pub.id, url: info.permalink ?? null, draft: false, scheduledRemotely: false }
    } finally {
      // apaga do storage temporário depois de publicado (ou se deu erro)
      await cleanup?.()
    }
  },

  async metrics(profileId, ids) {
    const out = new Map<string, RemoteStats>()
    for (const id of ids) {
      try {
        const m = await graph<{ like_count?: number; comments_count?: number }>(profileId, 'GET', id, { fields: 'like_count,comments_count' })
        const ins = await graph<{ data?: { name: string; values?: { value: number }[] }[] }>(profileId, 'GET', `${id}/insights`, {
          metric: 'views'
        }).catch(
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
