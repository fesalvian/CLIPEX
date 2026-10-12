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
  if (i.count <= 1 || !i.perDay || i.perDay < 1) return out

  // 1 por dia no horário escolhido
  if (i.perDay === 1 && i.fixedTime) {
    for (let k = 1; k < i.count; k++) out[k] = i.networks.map(() => at(i.start, k, i.fixedTime!))
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
  const cap0 = Math.min(perDay - 1, ...i.networks.map((n) => later[n]!.length))

  let k = 1
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
