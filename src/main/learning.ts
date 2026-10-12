// Aprender com o desempenho: views por tipo de momento e por horário de postagem.

import { DEFAULT_SLOTS, pickSlots } from '@shared/schedule'
import { NETWORKS, type Network, type ScheduleSuggestion } from '@shared/types'
import { clipsRepo, metricsRepo, postsRepo } from './db'

const DEFAULT_TIMES: Record<Network, string> = { instagram: '19:30', tiktok: '20:00', youtube: '18:00' }

function fmtViews(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace('.', ',')} mi`
  if (n >= 1000) return `${Math.round(n / 1000)} mil`
  return String(Math.round(n))
}

function postedWithViews(): { network: Network; postedAt: Date; views: number; tags: string[] }[] {
  const latest = new Map(metricsRepo.latest().map((m) => [m.postId, m.views]))
  const out: { network: Network; postedAt: Date; views: number; tags: string[] }[] = []
  for (const p of postsRepo.all(null)) {
    if (p.status !== 'posted' || !p.postedAt) continue
    const views = latest.get(p.id)
    if (views === undefined) continue
    const clip = clipsRepo.get(p.clipId)
    out.push({ network: p.network, postedAt: new Date(p.postedAt), views, tags: clip?.llm?.tags ?? [] })
  }
  return out
}

/** Resumo pro prompt de ranking: que tipo de momento tem dado mais views. */
export function performanceHint(): string | null {
  const rows = postedWithViews()
  if (rows.length < 3) return null
  const byTag = new Map<string, number[]>()
  for (const r of rows) for (const t of r.tags) byTag.set(t, [...(byTag.get(t) ?? []), r.views])
  const ranked = [...byTag.entries()]
    .filter(([, v]) => v.length >= 2)
    .map(([t, v]) => ({ t, avg: v.reduce((a, b) => a + b, 0) / v.length }))
    .sort((a, b) => b.avg - a.avg)
    .slice(0, 4)
  if (ranked.length === 0) return null
  return ranked.map((r) => `${r.t} (média de ${fmtViews(r.avg)} views)`).join(', ')
}

/** Melhor horário por rede, pela média de views dos posts de cada hora. */
export function suggestTimes(): ScheduleSuggestion[] {
  const rows = postedWithViews()
  return NETWORKS.map((network) => {
    const mine = rows.filter((r) => r.network === network)
    const byHour = new Map<number, number[]>()
    for (const r of mine) {
      const h = r.postedAt.getHours()
      byHour.set(h, [...(byHour.get(h) ?? []), r.views])
    }
    const best = [...byHour.entries()]
      .filter(([, v]) => v.length >= 2)
      .map(([h, v]) => ({ h, avg: v.reduce((a, b) => a + b, 0) / v.length }))
      .sort((a, b) => b.avg - a.avg)[0]
    if (!best) {
      return {
        network,
        time: DEFAULT_TIMES[network],
        reason: 'Horário padrão de pico no Brasil. Fica mais preciso conforme o app aprende com seus posts.',
        basedOnPosts: mine.length
      }
    }
    return {
      network,
      time: `${String(best.h).padStart(2, '0')}:00`,
      reason: `Seus cortes postados nesse horário tiveram mais views (média de ${fmtViews(best.avg)}).`,
      basedOnPosts: mine.length
    }
  })
}

/** Horas que mais deram views numa rede ('HH:00', melhor primeiro; só com 2+ posts na hora). */
function rankedHours(network: Network): string[] {
  const byHour = new Map<number, number[]>()
  for (const r of postedWithViews().filter((x) => x.network === network)) {
    const h = r.postedAt.getHours()
    byHour.set(h, [...(byHour.get(h) ?? []), r.views])
  }
  return [...byHour.entries()]
    .filter(([, v]) => v.length >= 2)
    .map(([h, v]) => ({ h, avg: v.reduce((a, b) => a + b, 0) / v.length }))
    .sort((a, b) => b.avg - a.avg)
    .map((x) => `${String(x.h).padStart(2, '0')}:00`)
}

/** Os `n` melhores horários de cada rede pra postar vários cortes por dia. */
export function bestSlots(n: number): Record<Network, string[]> {
  const out = {} as Record<Network, string[]>
  for (const net of NETWORKS) out[net] = pickSlots(rankedHours(net), DEFAULT_SLOTS[net], n)
  return out
}
