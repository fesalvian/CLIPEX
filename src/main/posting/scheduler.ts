// Fila de postagem: Instagram e TikTok são publicados pelo próprio app na hora marcada
// (o app precisa estar aberto ou na bandeja); YouTube sobe na hora e agenda com publishAt.

import { randomUUID } from 'node:crypto'
import type { SchedulePreviewItem, ScheduleRequest } from '@shared/ipc'
import { checkCaption } from '@shared/platformRules'
import { planSlots } from '@shared/schedule'
import type { Network, Post } from '@shared/types'
import { emit, toast } from '../bus'
import { cleanupRawFiles } from '../cleanup'
import { clipName } from '../clips'
import { clipsRepo, metricsRepo, postsRepo } from '../db'
import { bestSlots } from '../learning'
import { ensureRendered } from '../render/queue'
import { Semaphore } from '../sema'
import { platformRules } from '../settings'
import { learnFromClip } from '../style'
import { instagram } from './instagram'
import { tiktok } from './tiktok'
import type { NetworkClient } from './types'
import { youtube } from './youtube'

export const clients: Record<Network, NetworkClient> = { instagram, tiktok, youtube }

const lane = new Semaphore(1)
let timer: NodeJS.Timeout | null = null
let metricsTimer: NodeJS.Timeout | null = null

function savePost(p: Post): Post {
  postsRepo.save(p)
  emit('post:updated', p)
  return p
}

function hhmm(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export function planSchedule(req: ScheduleRequest): SchedulePreviewItem[] {
  const rules = platformRules()
  // o melhor corte sai primeiro (e fica com os melhores horários)
  const clips = req.clipIds
    .map((id) => clipsRepo.get(id))
    .filter((c): c is NonNullable<typeof c> => c !== null)
    .sort((a, b) => (b.llm?.score ?? b.signalScore * 100) - (a.llm?.score ?? a.signalScore * 100) || a.number - b.number)
  const start = req.firstAt ? new Date(req.firstAt) : new Date()
  const times = planSlots({
    count: clips.length,
    networks: req.networks,
    start,
    firstNow: !req.firstAt,
    perDay: req.perDay,
    // 1 por dia com data/hora escolhida: sempre nesse horário
    fixedTime: req.perDay === 1 && req.firstAt ? hhmm(start) : null,
    slots: bestSlots(Math.max(1, req.perDay ?? 1))
  })
  const items: SchedulePreviewItem[] = []
  clips.forEach((c, i) => {
    req.networks.forEach((net, ni) => {
      const at = times[i]?.[ni] ?? null
      const cap = c.captions?.[net] ?? { text: '', hashtags: [] }
      const warnings = checkCaption(net, cap, rules, c.cutOut - c.cutIn).warnings
      if (!c.captions?.[net]) warnings.unshift('Sem legenda gerada pra essa rede.')
      if (c.render.status !== 'done') warnings.push('O vídeo vai ser renderizado antes de postar.')
      if (net === 'tiktok') warnings.push('Vai como rascunho: você confirma e escreve a legenda no app do TikTok.')
      if (net !== 'youtube' && at) warnings.push('O Clipador precisa estar aberto (ou na bandeja) nesse horário.')
      items.push({
        clipId: c.id,
        clipName: `${clipName(c)}${c.llm?.title ? ` · ${c.llm.title}` : ''}`,
        network: net,
        at: at ? at.toISOString() : null,
        title: cap.title ?? null,
        text: cap.text,
        hashtags: cap.hashtags,
        warnings
      })
    })
  })
  // ordem do calendário
  return items.sort((a, b) => (a.at ? new Date(a.at).getTime() : 0) - (b.at ? new Date(b.at).getTime() : 0))
}

export function schedulePosts(req: ScheduleRequest): Post[] {
  const now = new Date().toISOString()
  const created = planSchedule(req).map((it) =>
    savePost({
      id: randomUUID().slice(0, 12),
      clipId: it.clipId,
      projectId: clipsRepo.get(it.clipId)!.projectId,
      network: it.network,
      status: 'scheduled',
      scheduledAt: it.at ?? now,
      title: it.title,
      text: it.text,
      hashtags: it.hashtags,
      remoteId: null,
      url: null,
      error: null,
      createdAt: now,
      postedAt: null
    })
  )
  // o que vai ser postado (já editado) vira exemplo do jeito de escrever do streamer
  for (const id of new Set(created.map((p) => p.clipId))) {
    const c = clipsRepo.get(id)
    if (c) learnFromClip(c, req.networks)
  }
  setTimeout(() => void tick(), 500)
  return created
}

export function cancelPost(id: string): Post {
  const p = postsRepo.get(id)
  if (!p) throw new Error('Post não encontrado')
  if (p.remoteId) throw new Error('Esse já foi enviado pra rede. Cancele pelo app da rede (ex.: YouTube Studio).')
  if (p.status !== 'scheduled' && p.status !== 'failed') throw new Error('Esse post não pode mais ser cancelado.')
  return savePost({ ...p, status: 'canceled' })
}

async function publishPost(post: Post): Promise<void> {
  const fresh = postsRepo.get(post.id)
  if (!fresh || fresh.status !== 'scheduled' || fresh.remoteId) return
  savePost({ ...fresh, status: 'uploading', error: null })
  try {
    const clip = await ensureRendered(fresh.clipId)
    const future = fresh.scheduledAt && new Date(fresh.scheduledAt).getTime() > Date.now() + 60_000
    const r = await clients[fresh.network].publish({
      videoPath: clip.render.path!,
      title: fresh.title,
      text: fresh.text,
      hashtags: fresh.hashtags,
      publishAt: fresh.network === 'youtube' && future ? fresh.scheduledAt : null
    })
    const status: Post['status'] = r.draft ? 'draft' : r.scheduledRemotely ? 'scheduled' : 'posted'
    savePost({
      ...fresh,
      status,
      remoteId: r.remoteId,
      url: r.url,
      note: r.note ?? null,
      postedAt: status === 'posted' ? new Date().toISOString() : null
    })
    const label = { instagram: 'Instagram', tiktok: 'TikTok', youtube: 'YouTube' }[fresh.network]
    if (r.note) {
      toast('info', `${clipName(clip)} foi pro ${label}. ${r.note}`)
      return
    }
    toast(
      'success',
      status === 'draft'
        ? `${clipName(clip)} foi pro rascunho do ${label}. Confirme no app.`
        : status === 'scheduled'
          ? `${clipName(clip)} agendado no ${label}.`
          : `${clipName(clip)} postado no ${label}.`
    )
  } catch (e) {
    savePost({ ...fresh, status: 'failed', error: (e as Error).message })
    toast('error', `Falha ao postar: ${(e as Error).message.split('\n')[0]}`)
  }
}

async function tick(): Promise<void> {
  const now = Date.now()
  for (const p of postsRepo.all(null)) {
    if (p.status !== 'scheduled') continue
    const at = p.scheduledAt ? new Date(p.scheduledAt).getTime() : now
    if (p.remoteId) {
      // agendado no próprio YouTube: quando passa a hora, conta como postado
      if (at <= now) savePost({ ...p, status: 'posted', postedAt: p.scheduledAt })
      continue
    }
    // YouTube sobe já (agendamento nativo); as outras redes só na hora.
    if (p.network === 'youtube' || at <= now) await lane.run(() => publishPost(p))
  }
}

async function collectMetrics(): Promise<void> {
  const posted = postsRepo.all(null).filter((p) => p.status === 'posted' && p.remoteId)
  const now = new Date().toISOString()
  for (const net of ['youtube', 'instagram'] as const) {
    const mine = posted.filter((p) => p.network === net)
    if (mine.length === 0) continue
    try {
      const stats = await clients[net].metrics(mine.map((p) => p.remoteId!))
      for (const p of mine) {
        const s = stats.get(p.remoteId!)
        if (s) metricsRepo.add({ postId: p.id, fetchedAt: now, ...s })
      }
    } catch {
      // sem conexão ou token expirado: tenta de novo na próxima rodada
    }
  }
}

export function startScheduler(): void {
  timer = setInterval(() => void tick(), 30_000)
  metricsTimer = setInterval(() => {
    void collectMetrics()
    cleanupRawFiles()
  }, 6 * 3600 * 1000)
  setTimeout(() => void tick(), 5000)
  setTimeout(() => {
    void collectMetrics()
    cleanupRawFiles()
  }, 60_000)
}

export function stopScheduler(): void {
  if (timer) clearInterval(timer)
  if (metricsTimer) clearInterval(metricsTimer)
}

export function hasPendingPosts(): boolean {
  return postsRepo.all(null).some((p) => p.status === 'scheduled' && !p.remoteId)
}
