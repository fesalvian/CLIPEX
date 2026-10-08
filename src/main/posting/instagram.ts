// Instagram Reels via Graph API (conta profissional). Upload resumable direto pro
// rupload.facebook.com; se falhar e houver Supabase configurado, sobe pra um storage
// temporário e passa a URL pública (video_url).

import { readFileSync, statSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { env } from '../env'
import type { NetworkClient, PublishInput, PublishResult, RemoteStats } from './types'

const VERSION = 'v21.0'

function cfg(): { token: string; userId: string; host: string } {
  const token = env('INSTAGRAM_ACCESS_TOKEN')
  const userId = env('INSTAGRAM_USER_ID')
  if (!token || !userId) {
    throw new Error('Preencha INSTAGRAM_ACCESS_TOKEN e INSTAGRAM_USER_ID no .env (token de longa duração da conta profissional).')
  }
  return { token, userId, host: env('INSTAGRAM_GRAPH_HOST') || 'graph.facebook.com' }
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

async function urlContainer(input: PublishInput, caption: string): Promise<{ id: string; cleanup: () => Promise<void> }> {
  const base = env('SUPABASE_URL').replace(/\/$/, '')
  const key = env('SUPABASE_SERVICE_ROLE_KEY')
  const bucket = env('SUPABASE_BUCKET') || 'clipador-temp'
  if (!base || !key) throw new Error('Upload direto falhou e não há storage temporário (SUPABASE_URL) configurado.')
  const object = `${randomUUID()}.mp4`
  const up = await fetch(`${base}/storage/v1/object/${bucket}/${object}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'video/mp4', 'x-upsert': 'true' },
    body: readFileSync(input.videoPath)
  })
  if (!up.ok) throw new Error(`Storage temporário recusou o vídeo: ${await up.text()}`)
  const publicUrl = `${base}/storage/v1/object/public/${bucket}/${object}`
  const { userId } = cfg()
  const c = await graph<{ id: string }>('POST', `${userId}/media`, {
    media_type: 'REELS',
    video_url: publicUrl,
    caption,
    share_to_feed: 'true'
  })
  return {
    id: c.id,
    cleanup: async () => {
      await fetch(`${base}/storage/v1/object/${bucket}/${object}`, { method: 'DELETE', headers: { authorization: `Bearer ${key}` } }).catch(
        () => undefined
      )
    }
  }
}

export const instagram: NetworkClient = {
  network: 'instagram',

  async connected() {
    try {
      const { userId } = cfg()
      const r = await graph<{ username?: string }>('GET', userId, { fields: 'username' })
      return { connected: true, account: r.username ? `@${r.username}` : null }
    } catch {
      return { connected: false, account: null }
    }
  },

  async connect() {
    // Instagram usa token de longa duração no .env; "conectar" só confere se ele funciona.
    const { userId } = cfg()
    await graph('GET', userId, { fields: 'username' })
  },

  async publish(input, onProgress): Promise<PublishResult> {
    const caption = instagramCaption(input.text, input.hashtags)
    let containerId: string
    let cleanup: (() => Promise<void>) | null = null
    try {
      containerId = await resumableContainer(input, caption, onProgress)
    } catch (e) {
      if (!env('SUPABASE_URL')) throw e
      const r = await urlContainer(input, caption)
      containerId = r.id
      cleanup = r.cleanup
    }
    try {
      // espera o Instagram processar o vídeo
      for (let i = 0; i < 60; i++) {
        const st = await graph<{ status_code?: string; status?: string }>('GET', containerId, { fields: 'status_code,status' })
        if (st.status_code === 'FINISHED') break
        if (st.status_code === 'ERROR' || st.status_code === 'EXPIRED') throw new Error(`Instagram não processou o vídeo: ${st.status ?? st.status_code}`)
        await sleep(5000)
      }
      const { userId } = cfg()
      const pub = await graph<{ id: string }>('POST', `${userId}/media_publish`, { creation_id: containerId })
      const info = await graph<{ permalink?: string }>('GET', pub.id, { fields: 'permalink' }).catch(() => ({ permalink: undefined }))
      return { remoteId: pub.id, url: info.permalink ?? null, draft: false, scheduledRemotely: false }
    } finally {
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
