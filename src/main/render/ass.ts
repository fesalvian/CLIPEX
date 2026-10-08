// Legenda queimada no formato ASS (libass): trechos curtos em caixa alta, palavra falada
// destacada, e o gancho numa caixa branca nos primeiros segundos.

import { HOOK_SECONDS, OUT_H, OUT_W } from '@shared/defaults'
import { captionAnchor } from '@shared/geometry'
import type { CamSplit, ClipLayout, SubtitleCue } from '@shared/types'

export const CAPTION_FONT = 'Montserrat ExtraBold'

export interface AssConfig {
  cues: SubtitleCue[]
  hook: string | null
  cutIn: number
  cutOut: number
  layout: ClipLayout
  camSplit: CamSplit
  /** cor da palavra destacada, #RRGGBB */
  highlight?: string
}

/** #RRGGBB → &H00BBGGRR */
export function assColor(hex: string, alpha = 0): string {
  const h = hex.replace('#', '')
  const r = h.slice(0, 2)
  const g = h.slice(2, 4)
  const b = h.slice(4, 6)
  const a = alpha.toString(16).padStart(2, '0')
  return `&H${a}${b}${g}${r}`.toUpperCase()
}

/** 3.456 → 0:00:03.46 */
export function assTime(sec: number): string {
  const cs = Math.max(0, Math.round(sec * 100))
  const h = Math.floor(cs / 360000)
  const m = Math.floor((cs % 360000) / 6000)
  const s = Math.floor((cs % 6000) / 100)
  const c = cs % 100
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(c).padStart(2, '0')}`
}

/** Tira o que o libass interpretaria como comando e emoji (a fonte não tem: vira quadradinho). */
export function assEscape(text: string): string {
  return text
    .replace(/[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}‍️]/gu, '')
    .replace(/\\/g, '/')
    .replace(/\{/g, '(')
    .replace(/\}/g, ')')
    .replace(/\r?\n/g, '\\N')
}

function upper(s: string): string {
  return s.toLocaleUpperCase('pt-BR')
}

export function buildAss(c: AssConfig): string {
  const dur = Math.max(0.1, c.cutOut - c.cutIn)
  const anchor = captionAnchor(c.layout, c.camSplit)
  const captionMarginV = Math.round(anchor * OUT_H + 40)
  const hi = assColor(c.highlight ?? '#C4B5FD')
  const white = assColor('#FFFFFF')

  const lines: string[] = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${OUT_W}`,
    `PlayResY: ${OUT_H}`,
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    'YCbCr Matrix: TV.709',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Caption,${CAPTION_FONT},84,${white},${white},&H00000000,&H90000000,0,0,0,0,100,100,0,0,1,7,4,8,70,70,${captionMarginV},1`,
    `Style: Hook,${CAPTION_FONT},60,${assColor('#12123A')},${assColor('#12123A')},${white},&H00000000,0,0,0,0,100,100,0,0,3,22,0,8,90,90,130,1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text'
  ]

  const hook = c.hook?.trim()
  if (hook) {
    lines.push(`Dialogue: 2,${assTime(0)},${assTime(Math.min(HOOK_SECONDS, dur))},Hook,,0,0,0,,${assEscape(upper(hook))}`)
  }

  for (const cue of c.cues) {
    const words = cue.words.filter((w) => w.w.trim())
    if (words.length === 0) continue
    const cueEnd = Math.min(cue.end, c.cutOut)
    for (let i = 0; i < words.length; i++) {
      const start = i === 0 ? cue.start : words[i]!.s
      const end = i === words.length - 1 ? cueEnd : words[i + 1]!.s
      const a = Math.max(0, start - c.cutIn)
      const b = Math.min(dur, end - c.cutIn)
      if (b - a < 0.02) continue
      const text = words
        .map((w, k) => {
          const t = assEscape(upper(w.w))
          return k === i ? `{\\c${hi}}${t}{\\c${white}}` : t
        })
        .join(' ')
      lines.push(`Dialogue: 1,${assTime(a)},${assTime(b)},Caption,,0,0,0,,${text}`)
    }
  }
  return lines.join('\n') + '\n'
}
