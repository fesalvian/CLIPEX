// Trechos de um corte: um corte pode juntar vários pedaços da live num vídeo só (corte seco
// entre eles). Tempos em segundos na linha do tempo da live; "tempo no vídeo" é a posição no
// vídeo final, com os trechos colados um atrás do outro. Funções puras (testáveis).

import { MAX_CUT, MIN_CUT } from './defaults'
import type { Clip, Cut, Word } from './types'

/** menor trecho quando o corte tem mais de um (s) */
export const MIN_SEGMENT = 1
/** buraco mínimo entre dois trechos; menos que isso eles viram um só */
const MERGE_GAP = 0.1

/** Trechos do corte (cortes antigos, sem a lista, têm um trecho só). */
export function cutsOf(c: Pick<Clip, 'cutIn' | 'cutOut'> & { segments?: Cut[] | null }): Cut[] {
  return c.segments && c.segments.length > 0 ? c.segments : [{ s: c.cutIn, e: c.cutOut }]
}

export function cutsDuration(cuts: Cut[]): number {
  return cuts.reduce((n, k) => n + Math.max(0, k.e - k.s), 0)
}

/** Duração do vídeo final do corte (soma dos trechos). */
export function clipDuration(c: Pick<Clip, 'cutIn' | 'cutOut'> & { segments?: Cut[] | null }): number {
  return cutsDuration(cutsOf(c))
}

/** Índice do trecho que contém `t`, ou -1 (fora de todos). */
export function cutIndexAt(cuts: Cut[], t: number): number {
  return cuts.findIndex((k) => t >= k.s && t <= k.e)
}

/** Tempo da live → tempo no vídeo final. No buraco entre trechos vale o início do próximo. */
export function toOut(cuts: Cut[], t: number): number {
  let acc = 0
  for (const k of cuts) {
    if (t <= k.s) return ms(acc)
    if (t <= k.e) return ms(acc + (t - k.s))
    acc += k.e - k.s
  }
  return ms(acc)
}

/** Tempo no vídeo final → tempo da live. */
export function toSrc(cuts: Cut[], o: number): number {
  let acc = 0
  for (const k of cuts) {
    const len = k.e - k.s
    if (o <= acc + len) return ms(k.s + Math.max(0, o - acc))
    acc += len
  }
  const last = cuts[cuts.length - 1]
  return last ? last.e : 0
}

/** arredonda pro milissegundo (soma de trechos acumula erro de ponto flutuante) */
function ms(n: number): number {
  return Math.round(n * 1000) / 1000
}

function round1(n: number): number {
  return Math.round(n * 10) / 10
}

/**
 * Deixa a lista válida: dentro da live, em ordem, sem sobrepor (trechos que se encostam
 * viram um só), cada trecho com o tamanho mínimo e a soma até o máximo de um corte.
 */
export function normalizeCuts(cuts: Cut[], duration: number): Cut[] {
  const sorted = cuts
    .map((k) => {
      const s = Math.max(0, Math.min(k.s, duration))
      return { s, e: Math.max(s, Math.min(k.e, duration)) }
    })
    .sort((a, b) => a.s - b.s)
  const merged: Cut[] = []
  for (const k of sorted) {
    const prev = merged[merged.length - 1]
    if (prev && k.s < prev.e + MERGE_GAP) prev.e = Math.max(prev.e, k.e)
    else merged.push({ ...k })
  }
  if (merged.length === 0) return [{ s: 0, e: Math.min(duration, MIN_CUT) }]

  const min = merged.length > 1 ? MIN_SEGMENT : MIN_CUT
  for (let i = 0; i < merged.length; i++) {
    const k = merged[i]!
    if (k.e - k.s >= min) continue
    const limit = merged[i + 1] ? merged[i + 1]!.s - MERGE_GAP : duration
    k.e = Math.min(limit, k.s + min)
    if (k.e - k.s < min) k.s = Math.max(i > 0 ? merged[i - 1]!.e + MERGE_GAP : 0, k.e - min)
  }

  // soma acima do máximo: apara do fim pra trás
  let extra = cutsDuration(merged) - MAX_CUT
  for (let i = merged.length - 1; i >= 0 && extra > 0; i--) {
    const k = merged[i]!
    const cut = Math.min(extra, k.e - k.s - MIN_SEGMENT)
    if (cut > 0) {
      k.e -= cut
      extra -= cut
    }
  }
  return merged.map((k) => ({ s: round1(k.s), e: round1(k.e) }))
}

/** Patch de um corte com novos trechos (o início e o fim do corte acompanham). */
export function withCuts(cuts: Cut[]): { segments: Cut[]; cutIn: number; cutOut: number } {
  return { segments: cuts, cutIn: cuts[0]?.s ?? 0, cutOut: cuts[cuts.length - 1]?.e ?? 0 }
}

/**
 * Onde entra um trecho novo: no cursor, se ele está fora dos trechos; senão depois do último.
 * Devolve o trecho (pode passar do fim da janela; a timeline estica pra mostrar).
 */
export function newSegmentAt(cuts: Cut[], cursor: number | null, duration: number, len = 5): Cut | null {
  const fits = (s: number): Cut | null => {
    const next = cuts.find((k) => k.s > s)
    const e = Math.min(s + len, next ? next.s - MERGE_GAP : duration)
    return e - s >= MIN_SEGMENT ? { s: round1(s), e: round1(e) } : null
  }
  if (cursor !== null && cutIndexAt(cuts, cursor) < 0) {
    const k = fits(cursor)
    if (k) return k
  }
  const last = cuts[cuts.length - 1]
  if (last && last.e + 1 < duration) {
    const k = fits(last.e + 1)
    if (k) return k
  }
  return null
}

/**
 * Palavras dos trechos com o tempo no vídeo final (os trechos colados): é o que a IA lê pra
 * escrever gancho e legenda das redes.
 */
export function wordsOnOutput(words: Word[], cuts: Cut[]): Word[] {
  const out: Word[] = []
  let acc = 0
  for (const k of cuts) {
    for (const w of words) {
      if (w.e <= k.s || w.s >= k.e) continue
      out.push({ w: w.w, s: ms(acc + Math.max(0, w.s - k.s)), e: ms(acc + Math.min(k.e, w.e) - k.s) })
    }
    acc += k.e - k.s
  }
  return out
}

/** Momento do zoom: o escolhido, ou o pico detectado se estiver num trecho; senão o meio do vídeo. */
export function zoomPoint(c: Pick<Clip, 'zoomEnabled' | 'zoomAt' | 'peakSec' | 'cutIn' | 'cutOut'> & { segments?: Cut[] | null }): number | null {
  if (!c.zoomEnabled) return null
  const cuts = cutsOf(c)
  const at = c.zoomAt ?? c.peakSec
  return cutIndexAt(cuts, at) >= 0 ? at : toSrc(cuts, cutsDuration(cuts) / 2)
}
