// Postagem automática: quando termina a análise de um vídeo que chegou sozinho (canal vigiado
// ou pasta vigiada) num perfil com a postagem automática ligada, escolhe os melhores cortes,
// prepara tudo (legenda, gancho, legenda das redes), renderiza e agenda N por dia, sem pedir
// revisão. O usuário ligou isso de propósito no perfil; os freios são a nota mínima, os
// termos proibidos e a pausa do perfil.
//
// Vídeo novo passa na frente: os cortes dele pegam os primeiros horários e os do vídeo
// anterior que ainda não saíram andam pra trás (os que passarem do prazo saem da fila).

import { clipDuration, cutsOf } from '@shared/cuts'
import { fitAroundQueue } from '@shared/schedule'
import { normalizeTerm } from '@shared/subtitles'
import type { Clip, Network, Post, Profile } from '@shared/types'
import { emit, toast } from './bus'
import { mutateClip } from './clips'
import { clipsRepo, postsRepo, projectsRepo } from './db'
import { ensureFaces } from './faces'
import { bestSlots } from './learning'
import { schedulePosts } from './posting/scheduler'
import { prepareClip } from './prepare'
import { getProfile } from './profiles'
import { enqueueRender } from './render/queue'

const DAY_MS = 24 * 3600 * 1000
/** Teto de cortes postados de um vídeo só. */
const MAX_PER_VIDEO = 60

/** Termos proibidos: um por linha ou separados por vírgula. */
export function parseBlocklist(text: string): string[] {
  return text
    .split(/[\n,;]+/)
    .map((t) => normalizeTerm(t))
    .filter((t) => t.length >= 2)
}

/** O corte fala algum termo proibido? (compara sem acento e sem caixa, palavra ou expressão) */
export function hitsBlocklist(c: Pick<Clip, 'words' | 'segments' | 'cutIn' | 'cutOut' | 'llm'>, terms: string[]): string | null {
  if (terms.length === 0) return null
  const cuts = cutsOf(c as Clip)
  const spoken = (c.words ?? []).filter((w) => cuts.some((k) => w.e > k.s && w.s < k.e)).map((w) => normalizeTerm(w.w))
  const text = ` ${[...spoken, normalizeTerm(c.llm?.title ?? '')].join(' ')} `
  return terms.find((t) => text.includes(` ${t} `)) ?? null
}

/** Os cortes que entram: nota mínima, duração máxima, sem termo proibido, melhor primeiro. */
export function pickClips(clips: Clip[], profile: Profile): { picked: Clip[]; blocked: number } {
  const ap = profile.autoPost
  const terms = parseBlocklist(ap.blocklist)
  let blocked = 0
  const ok = clips.filter((c) => {
    if (!c.llm || c.stage === 'error' || c.llm.score < ap.minScore) return false
    if (clipDuration(c) > ap.maxClipSec + 0.5) return false
    if (hitsBlocklist(c, terms)) {
      blocked++
      return false
    }
    return true
  })
  ok.sort((a, b) => b.llm!.score - a.llm!.score || a.number - b.number)
  const limit = Math.min(MAX_PER_VIDEO, Math.max(1, ap.perDay * ap.days))
  return { picked: ok.slice(0, limit), blocked }
}

const running = new Set<string>()

function savePost(p: Post): void {
  postsRepo.save(p)
  emit('post:updated', p)
}

/**
 * Cortes ainda na fila (automáticos, não enviados) de outros vídeos do perfil numa rede: andam
 * pra depois dos novos. Os que passarem do prazo saem da fila.
 */
function pushBackOlder(profile: Profile, net: Network, older: Post[], horizon: number): number {
  if (older.length === 0) return 0
  const mine = new Set(
    projectsRepo
      .all()
      .filter((p) => p.profileId === profile.id)
      .map((p) => p.id)
  )
  const olderIds = new Set(older.map((p) => p.id))
  const queue = postsRepo
    .all(null)
    .filter(
      (p) =>
        mine.has(p.projectId) &&
        p.network === net &&
        (p.status === 'scheduled' || p.status === 'uploading') &&
        p.scheduledAt &&
        !olderIds.has(p.id)
    )
    .map((p) => new Date(p.scheduledAt!))
  const sorted = [...older].sort((a, b) => a.scheduledAt!.localeCompare(b.scheduledAt!))
  const perDay = profile.autoPost.perDay
  const fitted = fitAroundQueue(
    sorted.map((p) => new Date(Math.max(Date.now() + 60_000, new Date(p.scheduledAt!).getTime()))),
    queue,
    bestSlots(perDay, profile.id)[net],
    perDay
  )
  let dropped = 0
  sorted.forEach((p, i) => {
    const t = fitted[i]
    if (!t) return
    if (t.getTime() > horizon) {
      savePost({ ...p, status: 'canceled', note: 'Saiu da fila: chegou um vídeo mais novo' })
      dropped++
    } else if (t.toISOString() !== p.scheduledAt) savePost({ ...p, scheduledAt: t.toISOString() })
  })
  return dropped
}

/** Roda a postagem automática de um projeto (uma vez; os cortes já agendados ficam). */
export async function runAutopilot(projectId: string): Promise<void> {
  const project = projectsRepo.get(projectId)
  if (!project?.auto || running.has(projectId)) return
  const profile = getProfile(project.profileId)
  const ap = profile.autoPost
  if (!ap.enabled || ap.networks.length === 0) return
  // já rodou (tem post desse projeto): não agenda de novo
  if (postsRepo.all(projectId).length > 0) return
  running.add(projectId)
  try {
    const { picked, blocked } = pickClips(clipsRepo.byProject(projectId), profile)
    if (picked.length === 0) {
      toast('info', `${profile.name} · ${project.name}: nenhum corte passou da nota mínima (${ap.minScore}). Nada foi agendado.`)
      return
    }
    // prepara um por um (transcrição já existe; legenda das redes pela IA)
    const ready: string[] = []
    for (const c of picked) {
      mutateClip(c.id, (x) => {
        x.approved = true
      })
      if (c.layout === 'face') await ensureFaces(c.id).catch(() => undefined)
      const done = await prepareClip(c.id)
      if (done?.captions) ready.push(c.id)
    }
    if (ready.length === 0) {
      toast('error', `${profile.name} · ${project.name}: a IA não gerou as legendas das redes. Nada foi agendado (veja a chave da OpenAI ou o Ollama).`)
      return
    }
    // vídeo novo na frente: os cortes ainda na fila de vídeos anteriores não seguram horário
    const others = postsRepo
      .all(null)
      .filter((p) => p.auto && p.status === 'scheduled' && !p.remoteId && p.projectId !== projectId)
      .filter((p) => projectsRepo.get(p.projectId)?.profileId === profile.id)
    const created = schedulePosts(
      { clipIds: ready, networks: ap.networks, firstAt: null, nowCount: 1, perDay: ap.perDay },
      { auto: true, ignore: new Set(others.map((p) => p.id)) }
    )
    const horizon = Date.now() + ap.days * DAY_MS
    let dropped = 0
    for (const net of ap.networks) dropped += pushBackOlder(profile, net, others.filter((p) => p.network === net), horizon)
    // renderiza já (postar não fica esperando o render)
    for (const id of ready) void enqueueRender(id).catch(() => undefined)
    const last = created.reduce((m, p) => Math.max(m, p.scheduledAt ? new Date(p.scheduledAt).getTime() : 0), 0)
    const until = last ? new Date(last).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }) : ''
    toast(
      'success',
      `${profile.name} · ${project.name}: ${ready.length} cortes agendados (${ap.perDay} por dia${until ? ` até ${until}` : ''}).` +
        (blocked ? ` ${blocked} ficaram de fora por termo proibido.` : '') +
        (dropped ? ` ${dropped} posts de vídeos anteriores saíram da fila.` : '')
    )
  } catch (e) {
    toast('error', `${profile.name} · postagem automática falhou: ${(e as Error).message.split('\n')[0]}`)
  } finally {
    running.delete(projectId)
  }
}

/** Ao abrir o app: vídeo automático que terminou de analisar mas não chegou a ser agendado. */
export function resumeAutopilot(): void {
  for (const p of projectsRepo.all()) {
    if (p.auto && p.status === 'ready' && postsRepo.all(p.id).length === 0) void runAutopilot(p.id)
  }
}
