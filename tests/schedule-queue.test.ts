import { describe, expect, it } from 'vitest'
import { fitAroundQueue, tidyQueue, type QueueEntry } from '@shared/schedule'

const d = (day: number, h: number, m = 0): Date => new Date(2026, 9, day, h, m, 0, 0)
const hm = (x: Date | null | undefined): string =>
  x ? `${x.getDate()} ${String(x.getHours()).padStart(2, '0')}:${String(x.getMinutes()).padStart(2, '0')}` : 'agora'

describe('fitAroundQueue', () => {
  const daily = ['18:00', '20:00']

  it('fila vazia: fica no horário planejado', () => {
    expect(fitAroundQueue([d(24, 18), d(24, 20), d(25, 18)], [], daily, 2).map(hm)).toEqual(['24 18:00', '24 20:00', '25 18:00'])
  })

  it('horário tomado por outra live: vai pro próximo livre, mantendo a ordem', () => {
    const queue = [d(24, 18), d(24, 20), d(25, 18)]
    expect(fitAroundQueue([d(24, 18), d(24, 20)], queue, daily, 2).map(hm)).toEqual(['25 20:00', '26 18:00'])
  })

  it('respeita o limite por dia mesmo com horário livre', () => {
    // dia 24 já tem 1; com 1 por dia, o novo vai pro 25
    expect(fitAroundQueue([d(24, 20)], [d(24, 18)], daily, 1).map(hm)).toEqual(['25 18:00'])
  })

  it('"postar agora" não muda', () => {
    expect(fitAroundQueue([null, d(24, 18)], [d(24, 18)], daily, 2).map(hm)).toEqual(['agora', '24 20:00'])
  })
})

describe('tidyQueue', () => {
  const now = d(24, 14)
  const q = (id: string, clipId: string, at: Date): QueueEntry => ({ id, clipId, at })

  it('tira repetidos (fica o primeiro) e o que já foi postado', () => {
    const plan = tidyQueue([q('a', 'c1', d(24, 18)), q('b', 'c1', d(24, 18)), q('c', 'c2', d(24, 20)), q('d', 'c3', d(25, 18))], new Set(['c3']), ['18:00', '20:00'], 2, now)
    expect(plan.cancel).toEqual(['b', 'd'])
    expect(plan.move).toEqual([])
  })

  it('espalha: no máximo N por dia, nos horários da rede, na mesma ordem', () => {
    const queue = [q('a', 'c1', d(24, 18)), q('b', 'c2', d(24, 18)), q('c', 'c3', d(24, 18)), q('e', 'c4', d(24, 20)), q('f', 'c5', d(24, 20))]
    const plan = tidyQueue(queue, new Set(), ['18:00', '20:00'], 2, now)
    const at = new Map(plan.move.map((m) => [m.id, hm(m.to)]))
    expect(plan.cancel).toEqual([])
    // a fica onde está; b vai pras 20h; o resto pros próximos dias
    expect(at.get('a')).toBeUndefined()
    expect([at.get('b'), at.get('c'), at.get('e'), at.get('f')]).toEqual(['24 20:00', '25 18:00', '25 20:00', '26 18:00'])
  })

  it('não usa horário que já passou nem o que está muito em cima', () => {
    const plan = tidyQueue([q('a', 'c1', d(24, 12))], new Set(), ['12:00', '14:15', '19:00'], 2, now)
    expect(plan.move.map((m) => hm(m.to))).toEqual(['24 19:00'])
  })
})
