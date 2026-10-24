// Distribui os cortes nos horários: "todos juntos", "1 por dia no horário escolhido" ou
// "N por dia nos melhores horários de cada rede". Função pura (testável).

import type { Network } from './types'

export interface SlotPlanInput {
  /** quantos cortes (já na ordem: melhor primeiro) */
  count: number
  networks: Network[]
  /** quando sai o primeiro corte */
  start: Date
  /** o primeiro corte sai na hora (devolve null em vez de `start`) */
  firstNow: boolean
  /** com firstNow: quantos cortes saem na hora (padrão 1); o resto segue o ritmo */
  nowCount?: number
  /** null = todos juntos; n = n cortes por dia (contando o primeiro) */
  perDay: number | null
  /** com 1 por dia: sempre nesse horário ('HH:MM'); sem ele, usa o melhor horário de cada rede */
  fixedTime: string | null
  /** melhores horários de cada rede, 'HH:MM' */
  slots: Record<Network, string[]>
}

function at(base: Date, dayOffset: number, hhmm: string): Date {
  const [h, m] = hhmm.split(':').map(Number)
  const d = new Date(base)
  d.setDate(d.getDate() + dayOffset)
  d.setHours(h ?? 0, m ?? 0, 0, 0)
  return d
}

/** [corte][rede] → data/hora, ou null = postar agora. */
export function planSlots(i: SlotPlanInput): (Date | null)[][] {
  const first = (): Date | null => (i.firstNow ? null : new Date(i.start))
  const out: (Date | null)[][] = Array.from({ length: i.count }, () => i.networks.map(first))
  // quantos saem no primeiro momento (agora ou na data escolhida)
  const lead = i.firstNow ? Math.max(1, Math.floor(i.nowCount ?? 1)) : 1
  if (i.count <= lead || !i.perDay || i.perDay < 1) return out

  // 1 por dia no horário escolhido
  if (i.perDay === 1 && i.fixedTime) {
    for (let k = lead; k < i.count; k++) out[k] = i.networks.map(() => at(i.start, k - lead + 1, i.fixedTime!))
    return out
  }

  const times: Record<string, string[]> = {}
  for (const n of i.networks) {
    times[n] = [...new Set(i.slots[n] ?? [])].sort().slice(0, i.perDay)
    if (times[n]!.length === 0) times[n] = ['19:00']
  }
  const perDay = Math.min(i.perDay, ...i.networks.map((n) => times[n]!.length))

  // resto do dia do primeiro post: horários que ainda não passaram, a mesma quantidade
  // em todas as redes (pra um corte cair no mesmo dia em todas)
  const later: Record<string, string[]> = {}
  for (const n of i.networks) later[n] = times[n]!.filter((t) => at(i.start, 0, t).getTime() > i.start.getTime() + 30 * 60 * 1000)
  const cap0 = Math.max(0, Math.min(perDay - lead, ...i.networks.map((n) => later[n]!.length)))

  let k = lead
  for (let j = 0; j < cap0 && k < i.count; j++, k++) {
    const row = out[k]!
    i.networks.forEach((n, ni) => (row[ni] = at(i.start, 0, later[n]![j]!)))
  }
  for (let day = 1; k < i.count; day++) {
    for (let j = 0; j < perDay && k < i.count; j++, k++) {
      const row = out[k]!
      i.networks.forEach((n, ni) => (row[ni] = at(i.start, day, times[n]![j]!)))
    }
  }
  return out
}

/** Um post até 30 min atrasado sai normal, sem mexer na fila. */
export const LATE_GRACE_MIN = 30

function hhmmOf(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/**
 * Fila de uma rede depois que o app ficou fechado na hora de alguns posts: em vez de mandar
 * tudo de uma vez, o primeiro atrasado sai agora e os outros andam pros próximos horários, na
 * mesma ordem e no mesmo ritmo (os horários do dia que a fila já usa). `times` em ordem.
 * Devolve os novos horários (mesmo tamanho) ou null se nada estava atrasado.
 */
export function reflowQueue(times: Date[], now: Date, gapMin = 60): Date[] | null {
  const grace = now.getTime() - LATE_GRACE_MIN * 60_000
  if (!times.some((t) => t.getTime() < grace)) return null
  const gap = gapMin * 60_000
  const keep = times.filter((t) => t.getTime() >= grace)
  const slots: Date[] = []
  if (keep.length === 0 || keep[0]!.getTime() - now.getTime() >= gap) slots.push(new Date(now))
  slots.push(...keep.map((t) => new Date(t)))

  const daily = [...new Set(times.map(hhmmOf))].sort()
  const base = slots[slots.length - 1]!
  let last = base.getTime()
  for (let day = 0; slots.length < times.length; day++) {
    for (const t of daily) {
      if (slots.length >= times.length) break
      const d = at(base, day, t)
      if (d.getTime() >= last + gap) {
        slots.push(d)
        last = d.getTime()
      }
    }
  }
  return slots.slice(0, times.length)
}

/** Horários de pico padrão de cada rede no Brasil (usados até ter histórico de views). */
export const DEFAULT_SLOTS: Record<Network, string[]> = {
  instagram: ['12:00', '19:30', '21:30', '09:00', '15:00', '17:30', '22:45', '11:00', '13:30', '20:30'],
  tiktok: ['19:00', '21:30', '12:30', '16:00', '23:00', '09:30', '14:00', '18:00', '20:15', '22:15'],
  youtube: ['18:00', '20:00', '12:00', '15:00', '21:30', '10:00', '17:00', '19:00', '13:00', '22:30']
}

function minutes(t: string): number {
  const [h, m] = t.split(':').map(Number)
  return (h ?? 0) * 60 + (m ?? 0)
}

/**
 * Escolhe `n` horários: primeiro os que mais deram views (em ordem), completando com os
 * padrões, com pelo menos `gapMin` minutos entre um e outro.
 */
export function pickSlots(ranked: string[], defaults: string[], n: number, gapMin = 60): string[] {
  const chosen: string[] = []
  for (const t of [...ranked, ...defaults]) {
    if (chosen.length >= n) break
    if (chosen.every((c) => Math.abs(minutes(c) - minutes(t)) >= gapMin)) chosen.push(t)
  }
  return chosen.sort()
}

/** Horários do dia (`daily`, 'HH:MM') a partir de `from`, dia após dia. */
function* slotsFrom(from: Date, daily: string[]): Generator<Date> {
  const times = [...new Set(daily)].sort()
  if (times.length === 0) return
  for (let day = 0; day < 3650; day++) {
    for (const t of times) {
      const d = at(from, day, t)
      if (d.getTime() >= from.getTime()) yield d
    }
  }
}

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
}

/** Ocupação de uma rede: horários já tomados e quantos posts por dia. */
class Busy {
  private times: number[]
  private perDayCount = new Map<string, number>()
  constructor(
    times: Date[],
    private readonly cap: number,
    private readonly gap: number
  ) {
    this.times = []
    for (const t of times) this.take(t)
  }
  free(d: Date): boolean {
    if ((this.perDayCount.get(dayKey(d)) ?? 0) >= this.cap) return false
    return this.times.every((t) => Math.abs(t - d.getTime()) >= this.gap)
  }
  take(d: Date): void {
    this.times.push(d.getTime())
    this.perDayCount.set(dayKey(d), (this.perDayCount.get(dayKey(d)) ?? 0) + 1)
  }
}

/**
 * Encaixa posts novos de uma rede na fila que já existe (de outras lives): cada um vai pro
 * horário planejado ou, se ele já está tomado (ou o dia já tem `perDay` posts), pro próximo
 * horário livre do dia a dia da rede. A ordem é mantida. null (postar agora) fica como está.
 */
export function fitAroundQueue(
  planned: (Date | null)[],
  queue: Date[],
  daily: string[],
  perDay: number,
  gapMin = 60
): (Date | null)[] {
  const busy = new Busy(queue, Math.max(1, perDay), gapMin * 60_000)
  let last = 0
  return planned.map((t) => {
    if (!t) return null
    const from = new Date(Math.max(t.getTime(), last))
    let pick: Date | null = busy.free(from) ? from : null
    if (!pick) for (const s of slotsFrom(from, daily)) if (s.getTime() > from.getTime() && busy.free(s)) { pick = s; break }
    const chosen = pick ?? from
    busy.take(chosen)
    last = chosen.getTime()
    return chosen
  })
}

export interface QueueEntry {
  id: string
  clipId: string
  at: Date
}

export interface TidyPlan {
  /** posts repetidos (mesmo corte na mesma rede): cancelar */
  cancel: string[]
  /** novos horários (só os que mudam) */
  move: { id: string; to: Date }[]
}

/**
 * Arruma a fila de uma rede: o mesmo corte só uma vez (o primeiro; nenhum se ele já foi
 * postado nessa rede) e no máximo `perDay` por dia, nos horários do dia a dia da rede, na
 * ordem em que já estavam, a partir de `now`.
 */
export function tidyQueue(queue: QueueEntry[], done: Set<string>, daily: string[], perDay: number, now: Date, gapMin = 60): TidyPlan {
  const sorted = [...queue].sort((a, b) => a.at.getTime() - b.at.getTime() || a.id.localeCompare(b.id))
  const cancel: string[] = []
  const keep: QueueEntry[] = []
  const seen = new Set(done)
  for (const q of sorted) {
    if (seen.has(q.clipId)) cancel.push(q.id)
    else {
      seen.add(q.clipId)
      keep.push(q)
    }
  }
  const busy = new Busy([], Math.max(1, perDay), gapMin * 60_000)
  const start = new Date(now.getTime() + LATE_GRACE_MIN * 60_000)
  const slots = slotsFrom(start, daily)
  const move: TidyPlan['move'] = []
  for (const q of keep) {
    let next = slots.next()
    while (!next.done && !busy.free(next.value)) next = slots.next()
    if (next.done) break
    busy.take(next.value)
    if (next.value.getTime() !== q.at.getTime()) move.push({ id: q.id, to: next.value })
  }
  return { cancel, move }
}
