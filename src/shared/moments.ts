// Podcast: o episódio é transcrito em pedaços e a IA lê cada pedaço procurando conversas
// completas. Funções puras: janelas de leitura, encaixe do corte nas frases e sobreposição.

import type { Word } from './types'

/** Pedaço do episódio transcrito de uma vez (s). */
export const PODCAST_CHUNK_SEC = 10 * 60
/** Quanto do pedaço anterior a IA relê, pra não perder conversa que atravessa o corte (s). */
export const PODCAST_OVERLAP_SEC = 3 * 60

export interface Span {
  s: number
  e: number
}

/** Pedaços de transcrição do episódio, em ordem. */
export function transcriptChunks(durationSec: number, chunk = PODCAST_CHUNK_SEC): Span[] {
  const out: Span[] = []
  for (let s = 0; s < durationSec - 0.5; s += chunk) out.push({ s, e: Math.min(durationSec, s + chunk) })
  return out
}

/** Janela que a IA lê depois do pedaço `i`: o pedaço com um pouco do anterior. */
export function readWindow(chunks: Span[], i: number, overlap = PODCAST_OVERLAP_SEC): Span {
  const c = chunks[i]!
  return { s: Math.max(0, c.s - (i > 0 ? overlap : 0)), e: c.e }
}

const SENTENCE_END = /[.!?…]["')\]]?$/

function endsSentence(words: Word[], i: number, gap = 0.7): boolean {
  const w = words[i]!
  if (SENTENCE_END.test(w.w.trim())) return true
  const next = words[i + 1]
  return !next || next.s - w.e >= gap
}

export interface SnapOptions {
  /** quanto pode voltar pra pegar o começo da frase (s) */
  maxBack?: number
  /** quanto pode estender pra terminar a frase (s) */
  maxForward?: number
  minSec: number
  maxSec: number
}

/**
 * Encaixa o corte sugerido pela IA na fala: começa no início de uma frase (volta até
 * `maxBack` se o ponto cair no meio) e termina no fim de uma frase (estende até `maxForward`).
 * Respeita a duração mínima e máxima. Devolve null se não tiver fala no trecho.
 */
export function snapToSpeech(words: Word[], start: number, end: number, o: SnapOptions): Span | null {
  const maxBack = o.maxBack ?? 6
  const maxForward = o.maxForward ?? 5
  if (words.length === 0) return null
  let a = words.findIndex((w) => w.e > start + 0.05)
  if (a < 0) return null
  // no meio de uma frase: volta até o começo dela (palavra depois de um fim de frase)
  for (let k = a; k > 0; k--) {
    if (endsSentence(words, k - 1)) {
      if (start - words[k]!.s <= maxBack) a = k
      break
    }
    if (start - words[k - 1]!.s > maxBack) break
  }
  let b = -1
  for (let k = words.length - 1; k >= a; k--) {
    if (words[k]!.s < end - 0.05) {
      b = k
      break
    }
  }
  if (b < a) return null
  // termina no fim de uma frase
  if (!endsSentence(words, b)) {
    for (let k = b + 1; k < words.length && words[k]!.e - end <= maxForward; k++) {
      if (endsSentence(words, k)) {
        b = k
        break
      }
    }
  }
  let s = Math.max(0, words[a]!.s - 0.15)
  let e = words[b]!.e + 0.3
  if (e - s > o.maxSec) {
    // longo demais: fecha na última frase que cabe
    const limit = s + o.maxSec
    let k = b
    while (k > a && (words[k]!.e + 0.3 > limit || !endsSentence(words, k))) k--
    e = k > a ? words[k]!.e + 0.3 : limit
  }
  if (e - s < o.minSec) return null
  return { s: round1(s), e: round1(e) }
}

/** Quanto de `a` fica dentro de `b` (0..1, em relação ao menor dos dois). */
export function overlapRatio(a: Span, b: Span): number {
  const inter = Math.max(0, Math.min(a.e, b.e) - Math.max(a.s, b.s))
  return inter / Math.max(0.1, Math.min(a.e - a.s, b.e - b.s))
}

function round1(n: number): number {
  return Math.round(n * 10) / 10
}
