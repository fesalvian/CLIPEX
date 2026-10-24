// Fila de postagem: Instagram e TikTok são publicados pelo próprio app na hora marcada
// (o app precisa estar aberto ou na bandeja); YouTube sobe na hora e agenda com publishAt.
// Se o app ficou fechado na hora, a fila da rede anda (reflowQueue) em vez de sair tudo junto.

import { clipDuration } from '@shared/cuts'
import { randomUUID } from 'node:crypto'
import type { PostOverviewItem, SchedulePreviewItem, ScheduleRequest, TidyChange, TidyPreview, TidyResult } from '@shared/ipc'
import { checkCaption } from '@shared/platformRules'
import { fitAroundQueue, planSlots, reflowQueue, tidyQueue } from '@shared/schedule'
import { NETWORKS, type Network, type Post } from '@shared/types'
import { emit, toast } from '../bus'
import { cleanupRawFiles } from '../cleanup'
import { clipName } from '../clips'
import { clipsRepo, metricsRepo, postsRepo, projectsRepo } from '../db'
import { bestSlots } from '../learning'
import { ensureRendered } from '../render/queue'
import { Semaphore } from '../sema'
import { platformRules } from '../settings'
import { learnFromClip } from '../style'
import { instagram } from './instagram'
import { tiktok } from './tiktok'
import type { NetworkClient } from './types'
import { youtube, youtubeCanEdit, youtubeDelete, youtubeReschedule } from './youtube'

export const clients: Record<Network, NetworkClient> = { instagram, tiktok, youtube }

const LABEL: Record<Network, string> = { instagram: 'Instagram', tiktok: 'TikTok', youtube: 'YouTube' }
/** Redes que o próprio app publica na hora marcada. */
const APP_TIMED: Network[] = ['instagram', 'tiktok']

const lane = new Semaphore(1)
let timer: NodeJS.Timeout | null = null
let metricsTimer: NodeJS.Timeout | null = null
let ticking = false
/** Redes cujo aviso de "esperando conectar" já apareceu nesta sessão. */
const waitingNotified = new Set<Network>()

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
  // 1 por dia com data/hora escolhida: sempre nesse horário
  const fixedTime = req.perDay === 1 && req.firstAt ? hhmm(start) : null
  const slots = bestSlots(Math.max(1, req.perDay ?? 1))
  const times = planSlots({
    count: clips.length,
    networks: req.networks,
    start,
    firstNow: !req.firstAt,
    nowCount: req.nowCount,
    perDay: req.perDay,
    fixedTime,
    slots
  })
  // com ritmo por dia: encaixa nos horários livres da fila que já existe (outras lives)
  if (req.perDay) {
    const pending = postsRepo.all(null).filter((p) => (p.status === 'scheduled' || p.status === 'uploading') && p.scheduledAt)
    req.networks.forEach((net, ni) => {
      const queue = pending.filter((p) => p.network === net).map((p) => new Date(p.scheduledAt!))
      const fitted = fitAroundQueue(
        times.map((row) => row[ni] ?? null),
        queue,
        fixedTime ? [fixedTime] : slots[net],
        req.perDay!
      )
      fitted.forEach((t, i) => (times[i]![ni] = t))
    })
  }
  // o mesmo corte não vai duas vezes pra mesma rede (agendar de novo sem querer)
  const taken = new Set(
    postsRepo
      .all(null)
      .filter((p) => p.status === 'scheduled' || p.status === 'uploading' || p.status === 'posted' || p.status === 'draft')
      .map((p) => `${p.clipId}:${p.network}`)
  )
  const items: SchedulePreviewItem[] = []
  clips.forEach((c, i) => {
    req.networks.forEach((net, ni) => {
      if (taken.has(`${c.id}:${net}`)) return
      const at = times[i]?.[ni] ?? null
      const cap = c.captions?.[net] ?? { text: '', hashtags: [] }
      const warnings = checkCaption(net, cap, rules, clipDuration(c)).warnings
      if (!c.captions?.[net]) warnings.unshift('Sem legenda gerada pra essa rede.')
      if (c.render.status !== 'done') warnings.push('O vídeo vai ser renderizado antes de postar.')
      if (net === 'tiktok') warnings.push('Vai como rascunho: você confirma e escreve a legenda no app do TikTok.')
      if (net !== 'youtube' && at) warnings.push('O Clipador precisa estar aberto (ou na bandeja) nesse horário.')
      items.push({
        clipId: c.id,
        clipName: clipName(c),
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

/** O que "organizar a fila" faria agora: repetidos cancelados e o resto espalhado. */
export function planTidy(perDay: number): { changes: (TidyChange & { post: Post })[]; preview: TidyPreview } {
  const now = new Date()
  const all = postsRepo.all(null)
  const projects = new Map(projectsRepo.all().map((p) => [p.id, p.name]))
  const slots = bestSlots(perDay)
  const changes: (TidyChange & { post: Post })[] = []
  for (const net of NETWORKS) {
    const mine = all.filter((p) => p.network === net)
    // na fila: agendado e ainda por vir (Short agendado no YouTube só até a hora dele)
    const queue = mine.filter((p) => p.status === 'scheduled' && p.scheduledAt && (!p.remoteId || new Date(p.scheduledAt) > now))
    const done = new Set(mine.filter((p) => p.status === 'posted' || p.status === 'draft' || p.status === 'uploading').map((p) => p.clipId))
    const plan = tidyQueue(
      queue.map((p) => ({ id: p.id, clipId: p.clipId, at: new Date(p.scheduledAt!) })),
      done,
      slots[net],
      perDay,
      now
    )
    const byId = new Map(queue.map((p) => [p.id, p]))
    const describe = (p: Post, kind: TidyChange['kind'], to: Date | null): TidyChange & { post: Post } => {
      const c = clipsRepo.get(p.clipId)
      return {
        post: p,
        postId: p.id,
        clipName: c ? clipName(c) : 'Corte apagado',
        projectName: projects.get(p.projectId) ?? 'Live apagada',
        network: net,
        kind,
        from: p.scheduledAt,
        to: to ? to.toISOString() : null,
        remote: !!p.remoteId
      }
    }
    for (const id of plan.cancel) changes.push(describe(byId.get(id)!, 'cancel', null))
    for (const m of plan.move) changes.push(describe(byId.get(m.id)!, 'move', m.to))
  }
  return {
    changes,
    preview: {
      perDay,
      changes: changes.map(({ post: _post, ...c }) => c),
      youtubeNeedsReconnect: changes.some((c) => c.remote) && !youtubeCanEdit()
    }
  }
}

/** Aplica "organizar a fila" (recalculado agora). Short já no YouTube muda pela API do YouTube. */
export async function applyTidy(perDay: number): Promise<TidyResult> {
  return lane.run(async () => {
    const { changes, preview } = planTidy(perDay)
    if (preview.youtubeNeedsReconnect) throw new Error('Reconecte o YouTube (com permissão de editar) antes de organizar os Shorts.')
    const errors: string[] = []
    let applied = 0
    for (const ch of changes) {
      const p = postsRepo.get(ch.postId)
      if (!p || p.status !== 'scheduled') continue
      try {
        if (ch.kind === 'cancel') {
          if (p.remoteId) await youtubeDelete(p.remoteId)
          savePost({ ...p, status: 'canceled', note: p.remoteId ? 'Repetido: apagado do YouTube' : 'Repetido' })
        } else {
          if (p.remoteId) await youtubeReschedule(p.remoteId, new Date(ch.to!))
          savePost({ ...p, scheduledAt: ch.to })
        }
        applied++
      } catch (e) {
        errors.push(`${ch.clipName} (${LABEL[ch.network]}): ${(e as Error).message}`)
      }
    }
    return { applied, errors }
  })
}

/** Todos os posts (de todas as lives) com o nome do corte, pra tela de agendados. */
export function postsOverview(): PostOverviewItem[] {
  const projects = new Map(projectsRepo.all().map((p) => [p.id, p.name]))
  return postsRepo.all(null).map((post) => {
    const c = clipsRepo.get(post.clipId)
    return {
      post,
      clipName: c ? clipName(c) : 'Corte apagado',
      projectName: projects.get(post.projectId) ?? 'Live apagada',
      render: c ? { status: c.render.status, error: c.render.error } : null
    }
  })
}

/** Post que falhou volta pra fila e sai agora (o conteúdo já foi confirmado ao agendar). */
export function retryPost(id: string): Post {
  const p = postsRepo.get(id)
  if (!p) throw new Error('Post não encontrado')
  if (p.status !== 'failed') throw new Error('Só dá pra tentar de novo um post que falhou.')
  const next = savePost({ ...p, status: 'scheduled', scheduledAt: new Date().toISOString(), error: null })
  setTimeout(() => void tick(), 500)
  return next
}

/** O app ficou fechado na hora de alguns posts da rede: reorganiza a fila em vez de mandar tudo junto. */
function reflowLate(net: Network, now: Date): void {
  const queue = postsRepo
    .all(null)
    .filter((p) => p.network === net && p.status === 'scheduled' && !p.remoteId && p.scheduledAt)
    .sort((a, b) => a.scheduledAt!.localeCompare(b.scheduledAt!))
  const next = reflowQueue(
    queue.map((p) => new Date(p.scheduledAt!)),
    now
  )
  if (!next) return
  queue.forEach((p, i) => {
    const at = next[i]!.toISOString()
    if (at !== p.scheduledAt) savePost({ ...p, scheduledAt: at })
  })
  toast(
    'info',
    `O Clipador estava fechado na hora de alguns posts do ${LABEL[net]}. O primeiro sai agora e os outros seguem nos próximos horários, no mesmo ritmo.`
  )
}

/**
 * Redes do app (Instagram, TikTok) prontas pra publicar o que venceu: conectadas e com a fila
 * já reorganizada. Desconectada, a fila espera (sem falhar post por post) e avisa uma vez.
 */
async function readyNetworks(now: Date): Promise<Set<Network>> {
  const ready = new Set<Network>(['youtube'])
  const pending = postsRepo.all(null).filter((p) => p.status === 'scheduled' && !p.remoteId)
  for (const net of APP_TIMED) {
    const mine = pending.filter((p) => p.network === net)
    const due = mine.some((p) => !p.scheduledAt || new Date(p.scheduledAt).getTime() <= now.getTime())
    if (!due) continue
    const conn = await clients[net].connected().catch(() => ({ connected: false, account: null }))
    if (!conn.connected) {
      if (!waitingNotified.has(net)) {
        waitingNotified.add(net)
        const n = mine.length
        toast(
          'info',
          `${n} ${n === 1 ? 'post' : 'posts'} do ${LABEL[net]} esperando a conta ser conectada (Configurações › Contas). Quando conectar, a fila continua de onde parou.`
        )
      }
      continue
    }
    waitingNotified.delete(net)
    reflowLate(net, now)
    ready.add(net)
  }
  return ready
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
    const label = LABEL[fresh.network]
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
  // um envio longo (vários uploads pro YouTube) não pode sobrepor a próxima rodada
  if (ticking) return
  ticking = true
  try {
    const ready = await readyNetworks(new Date())
    const now = Date.now()
    for (const p of postsRepo.all(null)) {
      if (p.status !== 'scheduled') continue
      const at = p.scheduledAt ? new Date(p.scheduledAt).getTime() : now
      if (p.remoteId) {
        // agendado no próprio YouTube: quando passa a hora, conta como postado
        if (at <= now) savePost({ ...p, status: 'posted', postedAt: p.scheduledAt })
        continue
      }
      if (!ready.has(p.network)) continue
      // YouTube sobe já (agendamento nativo); as outras redes só na hora.
      if (p.network === 'youtube' || at <= now) await lane.run(() => publishPost(p))
    }
  } finally {
    ticking = false
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

/** Enviando algum vídeo agora. */
export function postingNow(): boolean {
  return ticking || postsRepo.all(null).some((p) => p.status === 'uploading')
}

export function hasPendingPosts(): boolean {
  return postsRepo.all(null).some((p) => p.status === 'scheduled' && !p.remoteId)
}
