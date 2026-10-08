import type { DictEntry, SubtitleCue, Word } from './types'

export interface CueOptions {
  maxWords: number
  maxChars: number
  /** pausa (s) que força um novo trecho */
  pauseBreak: number
}

const DEFAULT_CUE_OPTIONS: CueOptions = { maxWords: 4, maxChars: 22, pauseBreak: 0.6 }

/** Tira emoji e símbolos que a fonte da legenda não tem (sairiam como quadradinho no vídeo). */
export function stripEmoji(s: string): string {
  return s
    .replace(/[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}‍️]/gu, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

export function cleanWord(w: string): string {
  return w.replace(/\s+/g, ' ').trim()
}

/** Palavras do Whisper que são só ruído ("[música]", "(risos)", "♪"). */
export function isNoiseWord(w: string): boolean {
  const t = cleanWord(w)
  if (!t) return true
  if (/^[[(*♪].*[\])*♪]$/.test(t)) return true
  return /^[♪.…,!?-]+$/.test(t)
}

/** Agrupa as palavras transcritas em trechos curtos de legenda, estilo TikTok. */
export function buildCues(words: Word[], from: number, to: number, opts: Partial<CueOptions> = {}): SubtitleCue[] {
  const o = { ...DEFAULT_CUE_OPTIONS, ...opts }
  const inside = words
    .filter((w) => w.e > from && w.s < to && !isNoiseWord(w.w))
    .map((w) => ({ w: cleanWord(w.w), s: Math.max(from, w.s), e: Math.min(to, Math.max(w.e, w.s + 0.05)) }))

  const cues: SubtitleCue[] = []
  let cur: Word[] = []
  const flush = (): void => {
    const first = cur[0]
    const last = cur[cur.length - 1]
    if (first && last) cues.push({ id: `c${cues.length}`, start: first.s, end: last.e, words: cur })
    cur = []
  }
  for (const w of inside) {
    const prev = cur[cur.length - 1]
    const chars = cur.reduce((n, x) => n + x.w.length + 1, 0) + w.w.length
    const pause = prev ? w.s - prev.e : 0
    const endsSentence = prev ? /[.!?…]$/.test(prev.w) : false
    if (cur.length > 0 && (cur.length >= o.maxWords || chars > o.maxChars || pause > o.pauseBreak || endsSentence)) {
      flush()
    }
    cur.push(w)
  }
  flush()

  // Estende cada trecho até o próximo quando o buraco é pequeno (evita piscar).
  for (let i = 0; i < cues.length - 1; i++) {
    const a = cues[i]!
    const b = cues[i + 1]!
    if (b.start - a.end < 0.35) a.end = b.start
  }
  return cues
}

/**
 * Ajusta a legenda a um novo intervalo de corte sem perder edições: trechos existentes
 * dentro do intervalo ficam como estão (aparados nas bordas) e as partes novas do corte
 * ganham trechos gerados das palavras transcritas.
 */
export function mergeCues(existing: SubtitleCue[], words: Word[], from: number, to: number, dict: DictEntry[]): SubtitleCue[] {
  const kept: SubtitleCue[] = []
  for (const c of existing) {
    const ws = c.words.filter((w) => w.e > from && w.s < to)
    if (ws.length === 0) continue
    kept.push({ ...c, start: Math.max(from, c.start), end: Math.min(to, c.end), words: ws })
  }
  kept.sort((a, b) => a.start - b.start)
  const gaps: [number, number][] = []
  let cursor = from
  for (const c of kept) {
    if (c.start - cursor > 0.05) gaps.push([cursor, c.start])
    cursor = Math.max(cursor, c.end)
  }
  if (to - cursor > 0.05) gaps.push([cursor, to])
  const fresh = gaps.flatMap(([a, b]) => applyDictionary(buildCues(words, a, b), dict))
  return [...kept, ...fresh]
    .sort((a, b) => a.start - b.start)
    .map((c, i) => ({ ...c, id: `c${i}` }))
}

export function cueText(cue: SubtitleCue): string {
  return cue.words.map((w) => w.w).join(' ')
}

/**
 * Troca o texto de um trecho mantendo os tempos. Se o número de palavras for igual,
 * cada palavra mantém o tempo original; senão os tempos são redistribuídos pelo tamanho.
 */
export function retimeCue(cue: SubtitleCue, text: string): SubtitleCue {
  const tokens = text.split(/\s+/).map(cleanWord).filter(Boolean)
  if (tokens.length === 0) return { ...cue, words: [] }
  if (tokens.length === cue.words.length) {
    return { ...cue, words: cue.words.map((w, i) => ({ ...w, w: tokens[i]! })) }
  }
  const span = Math.max(0.1, cue.end - cue.start)
  const weights = tokens.map((t) => Math.max(1, t.length))
  const total = weights.reduce((a, b) => a + b, 0)
  let t = cue.start
  const words = tokens.map((tok, i) => {
    const d = (span * weights[i]!) / total
    const w: Word = { w: tok, s: round3(t), e: round3(t + d) }
    t += d
    return w
  })
  return { ...cue, words }
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000
}

export function normalizeTerm(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export interface DictFix {
  cueId: string
  /** índice da primeira e da última palavra substituídas */
  from: number
  to: number
  original: string
  replacement: string
}

/** Procura no trecho as grafias erradas do dicionário (inclusive variantes com várias palavras). */
export function findDictFixes(cue: SubtitleCue, dict: DictEntry[]): DictFix[] {
  const norm = cue.words.map((w) => normalizeTerm(w.w))
  const fixes: DictFix[] = []
  const taken = new Set<number>()
  // variantes mais longas primeiro, pra "a w p" ganhar de "a"
  const patterns: { tokens: string[]; term: string }[] = []
  for (const entry of dict) {
    const forms = new Set([...entry.variants, entry.term].map(normalizeTerm).filter(Boolean))
    for (const f of forms) patterns.push({ tokens: f.split(' '), term: entry.term })
  }
  patterns.sort((a, b) => b.tokens.length - a.tokens.length)

  for (const p of patterns) {
    for (let i = 0; i + p.tokens.length <= norm.length; i++) {
      let ok = true
      for (let k = 0; k < p.tokens.length; k++) {
        if (norm[i + k] !== p.tokens[k] || taken.has(i + k)) {
          ok = false
          break
        }
      }
      if (!ok) continue
      const original = cue.words
        .slice(i, i + p.tokens.length)
        .map((w) => w.w)
        .join(' ')
      const trailing = /[.,!?…]+$/.exec(original)?.[0] ?? ''
      const replacement = p.term + trailing
      if (original === replacement) continue
      for (let k = 0; k < p.tokens.length; k++) taken.add(i + k)
      fixes.push({ cueId: cue.id, from: i, to: i + p.tokens.length - 1, original, replacement })
    }
  }
  return fixes.sort((a, b) => a.from - b.from)
}

export function applyDictFixes(cue: SubtitleCue, fixes: DictFix[]): SubtitleCue {
  if (fixes.length === 0) return cue
  const words: Word[] = []
  let i = 0
  const sorted = [...fixes].sort((a, b) => a.from - b.from)
  for (const f of sorted) {
    while (i < f.from) words.push(cue.words[i++]!)
    const first = cue.words[f.from]!
    const last = cue.words[f.to]!
    words.push({ w: f.replacement, s: first.s, e: last.e })
    i = f.to + 1
  }
  while (i < cue.words.length) words.push(cue.words[i++]!)
  return { ...cue, words }
}

export function applyDictionary(cues: SubtitleCue[], dict: DictEntry[]): SubtitleCue[] {
  return cues.map((c) => applyDictFixes(c, findDictFixes(c, dict)))
}

/** Palavras que viram prompt inicial do Whisper, pra ele acertar nomes e gírias. */
export function whisperPrompt(dict: DictEntry[]): string {
  return dict
    .map((d) => d.term)
    .filter(Boolean)
    .slice(0, 40)
    .join(', ')
}
