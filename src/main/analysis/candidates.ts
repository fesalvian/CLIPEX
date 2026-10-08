// Junta loudness + risada + grito numa pontuação por segundo e escolhe os momentos.

import type { DetectedTag } from '@shared/types'
import type { EventSeries } from './events'
import { LOUDNESS_RATE, SILENCE_LUFS } from './loudness'

export interface CandidateOptions {
  durationSec: number
  /** meia janela em volta do pico (s) */
  windowSec: number
  maxCandidates: number
  minScore: number
}

export interface Candidate {
  peak: number
  winStart: number
  winEnd: number
  cutIn: number
  cutOut: number
  score: number
  tags: DetectedTag[]
}

export interface Timeline {
  loud: Float32Array
  peak: Float32Array
  laugh: Float32Array
  scream: Float32Array
  combined: Float32Array
  smooth: Float32Array
}

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n
}

function median(values: number[]): number {
  if (values.length === 0) return SILENCE_LUFS
  const s = [...values].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2
}

/** Loudness por segundo (máximo dos 10 valores de 100 ms). */
export function perSecondLoudness(series: Float32Array, seconds: number): Float32Array {
  const out = new Float32Array(seconds).fill(SILENCE_LUFS)
  for (let s = 0; s < seconds; s++) {
    let mx = SILENCE_LUFS
    const a = s * LOUDNESS_RATE
    for (let k = a; k < a + LOUDNESS_RATE && k < series.length; k++) mx = Math.max(mx, series[k]!)
    out[s] = mx
  }
  return out
}

/** Linha de base do volume de fala: mediana de ±60 s, calculada em blocos de 10 s e interpolada. */
export function loudnessBaseline(loud: Float32Array): Float32Array {
  const n = loud.length
  const step = 10
  const half = 60
  const points: number[] = []
  for (let c = 0; c < n; c += step) {
    const vals: number[] = []
    for (let k = Math.max(0, c - half); k < Math.min(n, c + half); k++) {
      if (loud[k]! > -50) vals.push(loud[k]!)
    }
    points.push(vals.length >= 10 ? median(vals) : -35)
  }
  const out = new Float32Array(n)
  for (let s = 0; s < n; s++) {
    const i = Math.floor(s / step)
    const f = (s % step) / step
    const a = points[i] ?? -35
    const b = points[i + 1] ?? a
    out[s] = a + (b - a) * f
  }
  return out
}

/** Probabilidade máxima de um evento nos frames do YAMNet que cobrem cada segundo. */
function eventPerSecond(frames: Float32Array, hop: number, seconds: number): Float32Array {
  const out = new Float32Array(seconds)
  for (let i = 0; i < frames.length; i++) {
    const a = Math.floor(i * hop)
    const b = Math.min(seconds - 1, Math.floor(i * hop + 0.96))
    for (let s = a; s <= b; s++) out[s] = Math.max(out[s]!, frames[i]!)
  }
  return out
}

export function buildTimeline(loudSeries: Float32Array, events: EventSeries | null, durationSec: number): Timeline {
  const seconds = Math.max(1, Math.ceil(durationSec))
  const loud = perSecondLoudness(loudSeries, seconds)
  const base = loudnessBaseline(loud)
  const peak = new Float32Array(seconds)
  for (let s = 0; s < seconds; s++) {
    if (loud[s]! < -45) continue
    // +6 LU acima da fala começa a contar, +16 LU é grito/pico cheio.
    peak[s] = clamp01((loud[s]! - base[s]! - 6) / 10)
  }
  const laughRaw = events ? eventPerSecond(events.laugh, events.hop, seconds) : new Float32Array(seconds)
  const screamRaw = events ? eventPerSecond(events.scream, events.hop, seconds) : new Float32Array(seconds)
  const laugh = laughRaw.map((p) => clamp01((p - 0.1) / 0.5))
  const scream = screamRaw.map((p) => clamp01((p - 0.1) / 0.5))

  // "OU" probabilístico: sinais diferentes no mesmo segundo se reforçam.
  const combined = new Float32Array(seconds)
  for (let s = 0; s < seconds; s++) {
    combined[s] = 1 - (1 - 0.9 * laugh[s]!) * (1 - 0.85 * scream[s]!) * (1 - 0.6 * peak[s]!)
  }
  const smooth = new Float32Array(seconds)
  const R = 3
  for (let s = 0; s < seconds; s++) {
    let sum = 0
    let mx = 0
    let cnt = 0
    for (let k = Math.max(0, s - R); k <= Math.min(seconds - 1, s + R); k++) {
      sum += combined[k]!
      mx = Math.max(mx, combined[k]!)
      cnt++
    }
    smooth[s] = 0.5 * (sum / cnt) + 0.5 * mx
  }
  return { loud, peak, laugh, scream, combined, smooth }
}

function maxIn(arr: Float32Array, a: number, b: number): number {
  let mx = 0
  for (let k = Math.max(0, a); k <= Math.min(arr.length - 1, b); k++) mx = Math.max(mx, arr[k]!)
  return mx
}

export function pickCandidates(tl: Timeline, o: CandidateOptions): Candidate[] {
  const n = tl.smooth.length
  const limit = Math.min(o.maxCandidates, Math.max(5, Math.round(o.durationSec / 600)))
  const minGap = Math.max(10, o.windowSec * 0.75)
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => tl.smooth[b]! - tl.smooth[a]!)
  const peaks: number[] = []
  for (const s of order) {
    if (tl.smooth[s]! < o.minScore || peaks.length >= limit) break
    if (peaks.some((p) => Math.abs(p - s) < minGap)) continue
    peaks.push(s)
  }
  peaks.sort((a, b) => a - b)

  const out: Candidate[] = []
  for (let i = 0; i < peaks.length; i++) {
    const p = peaks[i]!
    const prev = peaks[i - 1]
    const next = peaks[i + 1]
    // Janelas sem sobreposição: se dois picos estão perto, divide no meio.
    const winStart = Math.max(0, p - o.windowSec, prev !== undefined ? (prev + p) / 2 : 0)
    const winEnd = Math.min(o.durationSec, p + o.windowSec, next !== undefined ? (p + next) / 2 : Infinity)

    // Corte sugerido: um pouco de contexto antes, e vai até a reação acabar.
    let tail = p
    for (let k = p; k <= Math.min(n - 1, p + 20); k++) if (tl.combined[k]! > 0.3) tail = k
    const cutIn = Math.max(winStart, p - 20)
    const cutOut = Math.min(winEnd, Math.max(p + 8, tail + 2))

    const tags: DetectedTag[] = []
    if (maxIn(tl.laugh, p - 6, p + 6) >= 0.4) tags.push('laugh')
    if (maxIn(tl.scream, p - 6, p + 6) >= 0.4) tags.push('scream')
    if (maxIn(tl.peak, p - 6, p + 6) >= 0.5 || tags.length === 0) tags.push('peak')

    out.push({
      peak: p,
      winStart: round1(winStart),
      winEnd: round1(winEnd),
      cutIn: round1(cutIn),
      cutOut: round1(cutOut),
      score: Math.round(tl.smooth[p]! * 1000) / 1000,
      tags
    })
  }
  return out.sort((a, b) => b.score - a.score)
}

function round1(n: number): number {
  return Math.round(n * 10) / 10
}
