// Fila de postagem: Instagram e TikTok são publicados pelo próprio app na hora marcada
// (o app precisa estar aberto ou na bandeja); YouTube sobe na véspera e agenda com publishAt,
// sem passar da cota diária da API (que é de todos os perfis juntos). Cada perfil posta nas
// contas dele. Se o app ficou fechado na hora, a fila da rede anda (reflowQueue) em vez de
// sair tudo junto.

import { clipDuration } from '@shared/cuts'
import { randomUUID } from 'node:crypto'
import type { PostOverviewItem, SchedulePreviewItem, ScheduleRequest, TidyChange, TidyPreview, TidyResult } from '@shared/ipc'
import { checkCaption } from '@shared/platformRules'
import { fitAroundQueue, planSlots, reflowQueue, tidyQueue } from '@shared/schedule'
import { DEFAULT_PROFILE_ID } from '@shared/defaults'
import { NETWORKS, type ClipKind, type Network, type Post } from '@shared/types'
import { emit, toast } from '../bus'
import { cleanupRawFiles } from '../cleanup'
import { clipName } from '../clips'
import { clipsRepo, metricsRepo, postsRepo, projectsRepo } from '../db'
import { bestSlots } from '../learning'
import { listProfiles } from '../profiles'
import { ensureRendered } from '../render/queue'
import { Semaphore } from '../sema'
import { activeProfileId, getSettings, platformRules } from '../settings'
import { learnFromClip } from '../style'
import { instagram } from './instagram'
import { tiktok } from './tiktok'
import { QuotaError, type NetworkClient } from './types'
import { youtube, youtubeCanEdit, youtubeDelete, youtubeReschedule } from './youtube'

export const clients: Record<Network, NetworkClient> = { instagram, tiktok, youtube }

const LABEL: Record<Network, string> = { instagram: 'Instagram', tiktok: 'TikTok', youtube: 'YouTube' }
/** O YouTube recebe o vídeo até 24 h antes (agenda lá com publishAt): não gasta a cota toda de uma vez. */
const YOUTUBE_AHEAD_MS = 24 * 3600 * 1000
/** O TikTok aceita no máximo 5 rascunhos pendentes por dia em cada conta. */
const TIKTOK_DRAFTS_PER_DAY = 5
const DAY_MS = 24 * 3600 * 1000
/** Categoria do vídeo no YouTube por tipo de clipe (20 = jogos, 24 = entretenimento). */
const YT_CATEGORY: Record<ClipKind, string> = { gameplay: '20', podcast: '24', wide: '24' }

/** A cota do YouTube acabou: só tenta de novo depois que ela zera (meia-noite do Pacífico). */
let youtubeBlockedUntil = 0

/** Próxima meia-noite no horário do Pacífico (quando a cota da API do YouTube zera). */
export function nextPacificMidnight(now = new Date()): Date {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
    hourCycle: 'h23'
  }).formatToParts(now)
  const get = (t: string): number => Number(parts.find((p) => p.type === t)?.value ?? 0)
  const elapsed = (get('hour') * 3600 + get('minute') * 60 + get('second')) * 1000
  return new Date(now.getTime() - elapsed + DAY_MS + 60_000)
}

/** Perfil dono de um post (pelo projeto). */
function profileOf(p: Post): string {
  return projectsRepo.get(p.projectId)?.profileId ?? DEFAULT_PROFILE_ID
}

/** Posts de um perfil. */
function postsOf(profileId: string): Post[] {
  const mine = new Set(
    projectsRepo
      .all()
      .filter((p) => p.profileId === profileId)
      .map((p) => p.id)
  )
  return postsRepo.all(null).filter((p) => mine.has(p.projectId))
}

const lane = new Semaphore(1)
let timer: NodeJS.Timeout | null = null
let metricsTimer: NodeJS.Timeout | null = null
let ticking = false
/** Contas (perfil:rede) cujo aviso de "esperando conectar" já apareceu nesta sessão. */
const waitingNotified = new Set<string>()

function savePost(p: Post): Post {
  postsRepo.save(p)
  emit('post:updated', p)
  return p
}

function hhmm(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export function planSchedule(req: ScheduleRequest, opts: { keepOrder?: boolean; ignore?: Set<string> } = {}): SchedulePreviewItem[] {
  const rules = platformRules()
  // o melhor corte sai primeiro (e fica com os melhores horários)
  const clips = req.clipIds
    .map((id) => clipsRepo.get(id))
    .filter((c): c is NonNullable<typeof c> => c !== null)
  if (!opts.keepOrder) {
    clips.sort((a, b) => (b.llm?.score ?? b.signalScore * 100) - (a.llm?.score ?? a.signalScore * 100) || a.number - b.number)
  }
  const profileId = clips[0] ? (projectsRepo.get(clips[0].projectId)?.profileId ?? DEFAULT_PROFILE_ID) : activeProfileId()
  const start = req.firstAt ? new Date(req.firstAt) : new Date()
  // 1 por dia com data/hora escolhida: sempre nesse horário
  const fixedTime = req.perDay === 1 && req.firstAt ? hhmm(start) : null
  const slots = bestSlots(Math.max(1, req.perDay ?? 1), profileId)
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
  // com ritmo por dia: encaixa nos horários livres da fila que já existe (outras lives do mesmo perfil)
  if (req.perDay) {
    const pending = postsOf(profileId).filter(
      (p) => (p.status === 'scheduled' || p.status === 'uploading') && p.scheduledAt && !opts.ignore?.has(p.id)
    )
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
      if (net === 'youtube' && at && at.getTime() - Date.now() > YOUTUBE_AHEAD_MS) {
        warnings.push('Sobe pro YouTube na véspera (o Clipador precisa estar aberto ou na bandeja).')
      }
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

export function schedulePosts(req: ScheduleRequest, opts: { auto?: boolean; keepOrder?: boolean; ignore?: Set<string> } = {}): Post[] {
  const now = new Date().toISOString()
  const created = planSchedule(req, opts).map((it) =>
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
      auto: !!opts.auto,
      uploadedAt: null,
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

/** O que "organizar a fila" faria agora (no perfil): repetidos cancelados e o resto espalhado. */
export function planTidy(perDay: number, profileId: string = activeProfileId()): { changes: (TidyChange & { post: Post })[]; preview: TidyPreview } {
  const now = new Date()
  const all = postsOf(profileId)
  const projects = new Map(projectsRepo.all().map((p) => [p.id, p.name]))
  const slots = bestSlots(perDay, profileId)
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
      youtubeNeedsReconnect: changes.some((c) => c.remote) && !youtubeCanEdit(profileId)
    }
  }
}

/** Aplica "organizar a fila" (recalculado agora). Short já no YouTube muda pela API do YouTube. */
export async function applyTidy(perDay: number, profileId: string = activeProfileId()): Promise<TidyResult> {
  return lane.run(async () => {
    const { changes, preview } = planTidy(perDay, profileId)
    if (preview.youtubeNeedsReconnect) throw new Error('Reconecte o YouTube (com permissão de editar) antes de organizar os Shorts.')
    const errors: string[] = []
    let applied = 0
    for (const ch of changes) {
      const p = postsRepo.get(ch.postId)
      if (!p || p.status !== 'scheduled') continue
      try {
        if (ch.kind === 'cancel') {
          if (p.remoteId) await youtubeDelete(profileId, p.remoteId)
          savePost({ ...p, status: 'canceled', note: p.remoteId ? 'Repetido: apagado do YouTube' : 'Repetido' })
        } else {
          if (p.remoteId) await youtubeReschedule(profileId, p.remoteId, new Date(ch.to!))
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

/** Todos os posts do perfil (de todas as lives) com o nome do corte, pra tela de agendados. */
export function postsOverview(profileId: string = activeProfileId()): PostOverviewItem[] {
  const projects = new Map(projectsRepo.all().map((p) => [p.id, p.name]))
  return postsOf(profileId).map((post) => {
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
function reflowLate(profileId: string, net: Network, now: Date): void {
  const queue = postsOf(profileId)
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

/** Quando um post tem que subir: YouTube na véspera (agenda lá); as outras redes na hora. */
function uploadAt(p: Post): number {
  const at = p.scheduledAt ? new Date(p.scheduledAt).getTime() : 0
  return p.network === 'youtube' ? at - YOUTUBE_AHEAD_MS : at
}

/**
 * Contas (perfil:rede) prontas pra publicar o que venceu: conectadas e com a fila já
 * reorganizada. Desconectada, a fila espera (sem falhar post por post) e avisa uma vez.
 */
async function readyAccounts(now: Date): Promise<Set<string>> {
  const ready = new Set<string>()
  const pending = postsRepo.all(null).filter((p) => p.status === 'scheduled' && !p.remoteId)
  for (const profile of listProfiles()) {
    const ofProfile = pending.filter((p) => profileOf(p) === profile.id)
    for (const net of NETWORKS) {
      const mine = ofProfile.filter((p) => p.network === net)
      const due = mine.some((p) => !p.scheduledAt || uploadAt(p) <= now.getTime())
      if (!due) continue
      const key = `${profile.id}:${net}`
      const conn = await clients[net].connected(profile.id).catch(() => ({ connected: false, account: null }))
      if (!conn.connected) {
        if (!waitingNotified.has(key)) {
          waitingNotified.add(key)
          const n = mine.length
          toast(
            'info',
            `${profile.name}: ${n} ${n === 1 ? 'post' : 'posts'} do ${LABEL[net]} esperando a conta ser conectada (Configurações › Contas). Quando conectar, a fila continua de onde parou.`
          )
        }
        continue
      }
      waitingNotified.delete(key)
      if (net !== 'youtube') reflowLate(profile.id, net, now)
      ready.add(key)
    }
  }
  return ready
}

/** Uploads pro YouTube nas últimas 24 h (todos os perfis: a cota é do projeto do Google). */
function youtubeUploadsToday(now: number): number {
  return postsRepo
    .all(null)
    .filter((p) => p.network === 'youtube' && p.uploadedAt && now - new Date(p.uploadedAt).getTime() < DAY_MS).length
}

/** Rascunhos mandados pro TikTok de um perfil nas últimas 24 h. */
function tiktokDraftsToday(profileId: string, now: number): number {
  return postsOf(profileId).filter((p) => p.network === 'tiktok' && p.uploadedAt && now - new Date(p.uploadedAt).getTime() < DAY_MS).length
}

async function publishPost(post: Post): Promise<void> {
  const fresh = postsRepo.get(post.id)
  if (!fresh || fresh.status !== 'scheduled' || fresh.remoteId) return
  const profileId = profileOf(fresh)
  savePost({ ...fresh, status: 'uploading', error: null })
  try {
    const clip = await ensureRendered(fresh.clipId)
    const future = fresh.scheduledAt && new Date(fresh.scheduledAt).getTime() > Date.now() + 60_000
    const kind = projectsRepo.get(fresh.projectId)?.kind ?? 'gameplay'
    const r = await clients[fresh.network].publish(profileId, {
      videoPath: clip.render.path!,
      title: fresh.title,
      text: fresh.text,
      hashtags: fresh.hashtags,
      publishAt: fresh.network === 'youtube' && future ? fresh.scheduledAt : null,
      categoryId: YT_CATEGORY[kind]
    })
    const status: Post['status'] = r.draft ? 'draft' : r.scheduledRemotely ? 'scheduled' : 'posted'
    savePost({
      ...fresh,
      status,
      remoteId: r.remoteId,
      url: r.url,
      note: r.note ?? null,
      uploadedAt: new Date().toISOString(),
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
    if (e instanceof QuotaError) {
      // cota do dia acabou: volta pra fila e tenta depois que ela zerar
      youtubeBlockedUntil = nextPacificMidnight().getTime()
      savePost({ ...fresh, status: 'scheduled', note: 'A cota diária da API do YouTube acabou: sobe depois que ela zerar.' })
      toast('info', 'A cota diária do YouTube acabou. Os próximos Shorts sobem quando ela zerar (às 4h ou 5h da manhã).')
      return
    }
    savePost({ ...fresh, status: 'failed', error: (e as Error).message })
    toast('error', `Falha ao postar: ${(e as Error).message.split('\n')[0]}`)
  }
}

async function tick(): Promise<void> {
  // um envio longo (vários uploads pro YouTube) não pode sobrepor a próxima rodada
  if (ticking) return
  ticking = true
  try {
    const ready = await readyAccounts(new Date())
    const paused = new Set(
      listProfiles()
        .filter((p) => p.autoPost.paused)
        .map((p) => p.id)
    )
    const queue = postsRepo
      .all(null)
      .filter((p) => p.status === 'scheduled')
      .sort((a, b) => (a.scheduledAt ?? '').localeCompare(b.scheduledAt ?? ''))
    for (const p of queue) {
      const now = Date.now()
      const at = p.scheduledAt ? new Date(p.scheduledAt).getTime() : now
      if (p.remoteId) {
        // agendado no próprio YouTube: quando passa a hora, conta como postado
        if (at <= now) savePost({ ...p, status: 'posted', postedAt: p.scheduledAt })
        continue
      }
      const profileId = profileOf(p)
      // freio do perfil: nada sai enquanto estiver pausado
      if (paused.has(profileId) || !ready.has(`${profileId}:${p.network}`)) continue
      if (p.scheduledAt && uploadAt(p) > now) continue
      if (p.network === 'youtube') {
        if (now < youtubeBlockedUntil) continue
        if (youtubeUploadsToday(now) >= getSettings().youtubeDailyUploads) continue
      }
      if (p.network === 'tiktok' && tiktokDraftsToday(profileId, now) >= TIKTOK_DRAFTS_PER_DAY) continue
      await lane.run(() => publishPost(p))
    }
  } finally {
    ticking = false
  }
}

async function collectMetrics(): Promise<void> {
  const now = new Date().toISOString()
  for (const profile of listProfiles()) {
    const posted = postsOf(profile.id).filter((p) => p.status === 'posted' && p.remoteId)
    for (const net of ['youtube', 'instagram'] as const) {
      const mine = posted.filter((p) => p.network === net)
      if (mine.length === 0) continue
      try {
        const stats = await clients[net].metrics(profile.id, mine.map((p) => p.remoteId!))
        for (const p of mine) {
          const s = stats.get(p.remoteId!)
          if (s) metricsRepo.add({ postId: p.id, fetchedAt: now, ...s })
        }
      } catch {
        // sem conexão ou token expirado: tenta de novo na próxima rodada
      }
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
