import type { NetCaption, Network } from './types'

export interface PlatformRule {
  label: string
  product: string
  textLabel: string
  maxChars: number
  hasTitle: boolean
  titleMax?: number
  hashtags: { min: number; max: number; required: string[]; ignoredAbove?: number }
  maxVideoSec: number
  delivery: string
  tip: string
  guidance: string[]
}

export type PlatformRules = Record<Network, PlatformRule>

export function normalizeHashtag(tag: string): string | null {
  const t = tag
    .trim()
    .replace(/^#+/, '')
    .replace(/[^\p{L}\p{N}_]/gu, '')
  return t ? `#${t.toLowerCase()}` : null
}

export function extractHashtags(text: string): string[] {
  return [...text.matchAll(/#[\p{L}\p{N}_]+/gu)].map((m) => m[0].toLowerCase())
}

function uniq(list: string[]): string[] {
  return [...new Set(list)]
}

/**
 * Ajusta a legenda às regras da rede: normaliza e limita hashtags, garante as obrigatórias,
 * corta título e texto no limite de caracteres.
 */
export function enforceCaption(net: Network, cap: NetCaption, rules: PlatformRules): NetCaption {
  const rule = rules[net]
  let tags = uniq(cap.hashtags.map(normalizeHashtag).filter((t): t is string => t !== null))
  for (const req of rule.hashtags.required) {
    const r = normalizeHashtag(req)
    if (r && !tags.includes(r)) tags = [r, ...tags]
  }
  if (tags.length > rule.hashtags.max) {
    const required = rule.hashtags.required.map((r) => normalizeHashtag(r) ?? '')
    const keep = tags.filter((t) => required.includes(t))
    const rest = tags.filter((t) => !required.includes(t))
    tags = [...keep, ...rest].slice(0, rule.hashtags.max)
  }

  // Hashtags soltas no texto contam no limite do Instagram: tira do texto e junta na lista.
  let text = cap.text.trim()
  const inText = extractHashtags(text)
  if (inText.length > 0) {
    text = text.replace(/\s*#[\p{L}\p{N}_]+/gu, '').trim()
    for (const t of inText) if (!tags.includes(t) && tags.length < rule.hashtags.max) tags.push(t)
  }
  const tagLine = tags.join(' ')
  const room = rule.maxChars - (tagLine ? tagLine.length + 2 : 0)
  if (text.length > room) text = text.slice(0, Math.max(0, room - 1)).trimEnd() + '…'

  const out: NetCaption = { text, hashtags: tags }
  if (rule.hasTitle) {
    let title = (cap.title ?? '').trim()
    const max = rule.titleMax ?? 100
    const titleTags = extractHashtags(title)
    if (titleTags.length === 0) {
      const tag = tags.find((t) => t !== '#shorts') ?? '#shorts'
      title = `${title} ${tag}`.trim()
    } else if (titleTags.length > 1) {
      // fica só a última hashtag no título
      const last = titleTags[titleTags.length - 1]!
      title = `${title.replace(/\s*#[\p{L}\p{N}_]+/gu, '').trim()} ${last}`
    }
    if (title.length > max) {
      const tag = extractHashtags(title).pop() ?? ''
      const base = title.replace(/\s*#[\p{L}\p{N}_]+/gu, '').trim()
      title = `${base.slice(0, max - tag.length - 2).trimEnd()}… ${tag}`.trim()
    }
    out.title = title
  }
  return out
}

export interface CaptionCheck {
  chars: number
  maxChars: number
  hashtagCount: number
  hashtagMax: number
  titleChars: number | null
  warnings: string[]
}

/** Texto final que vai pro post (legenda + linha de hashtags). */
export function fullCaptionText(cap: NetCaption): string {
  const tags = cap.hashtags.join(' ')
  return tags ? `${cap.text}\n\n${tags}` : cap.text
}

export function checkCaption(net: Network, cap: NetCaption, rules: PlatformRules, clipSec?: number): CaptionCheck {
  const rule = rules[net]
  const warnings: string[] = []
  const chars = fullCaptionText(cap).length
  if (chars > rule.maxChars) warnings.push(`${rule.textLabel} passou de ${rule.maxChars} caracteres.`)
  if (cap.hashtags.length > rule.hashtags.max) warnings.push(`Use no máximo ${rule.hashtags.max} hashtags.`)
  if (cap.hashtags.length < rule.hashtags.min) warnings.push(`Recomendado pelo menos ${rule.hashtags.min} hashtags.`)
  for (const req of rule.hashtags.required) {
    if (!cap.hashtags.includes(req)) warnings.push(`Falta ${req}.`)
  }
  let titleChars: number | null = null
  if (rule.hasTitle) {
    titleChars = (cap.title ?? '').length
    if (!cap.title) warnings.push('Falta o título.')
    else if (titleChars > (rule.titleMax ?? 100)) warnings.push(`Título passou de ${rule.titleMax ?? 100} caracteres.`)
  }
  if (clipSec !== undefined && clipSec > rule.maxVideoSec) {
    warnings.push(`O vídeo tem ${Math.round(clipSec)} s e o ${rule.product} via API aceita até ${rule.maxVideoSec} s.`)
  }
  return { chars, maxChars: rule.maxChars, hashtagCount: cap.hashtags.length, hashtagMax: rule.hashtags.max, titleChars, warnings }
}
