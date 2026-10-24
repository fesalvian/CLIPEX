// Legenda queimada no formato ASS (libass): trechos curtos, palavra falada destacada,
// gancho nos primeiros segundos. Posição, fonte, cores e animações vêm do estilo efetivo
// do corte (src/shared/text.ts), as mesmas contas que o preview usa.

import { OUT_H, OUT_W } from '@shared/consts'
import { cutsDuration, toOut } from '@shared/cuts'
import { ANIM, TEXT_MARGIN, captionTextTop, displayText, typewriterStep } from '@shared/text'
import type { CaptionStyle, Cut, HookStyle, SubtitleCue } from '@shared/types'

export interface AssConfig {
  cues: SubtitleCue[]
  hook: string | null
  cutIn: number
  cutOut: number
  /** trechos do corte (sem = um só, de cutIn a cutOut); a legenda segue o vídeo com eles colados */
  cuts?: Cut[]
  caption: CaptionStyle & { y: number }
  hookStyle: HookStyle & { y: number }
  /** a família é negrito no arquivo (o libass precisa do Bold=-1 pra achar) */
  isBold?: (family: string) => boolean
}

/** #RRGGBB → &HAABBGGRR */
export function assColor(hex: string, alpha = 0): string {
  const h = hex.replace('#', '').padEnd(6, '0')
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

function ms(sec: number): number {
  return Math.round(sec * 1000)
}

const POP = `\\fscx${ANIM.popFrom * 100}\\fscy${ANIM.popFrom * 100}\\t(0,${ms(ANIM.popIn)},\\fscx${ANIM.popOver * 100}\\fscy${ANIM.popOver * 100})\\t(${ms(ANIM.popIn)},${ms(ANIM.popIn + ANIM.popSettle)},\\fscx100\\fscy100)`

function pos(x: number, y: number): string {
  return `\\an5\\pos(${Math.round(x)},${Math.round(y)})`
}

/**
 * Margens da linha que limitam a largura onde o texto cresce antes de quebrar (com \pos o
 * libass posiciona pelo ponto, mas quebra a linha pela largura entre as margens).
 */
export function wrapMargins(boxWidth: number): string {
  const m = Math.max(0, Math.round((OUT_W - Math.max(80, Math.min(OUT_W, boxWidth))) / 2))
  return `${m},${m}`
}

export function buildAss(c: AssConfig): string {
  const cuts = c.cuts?.length ? c.cuts : [{ s: c.cutIn, e: c.cutOut }]
  const dur = Math.max(0.1, cutsDuration(cuts))
  const cap = c.caption
  const hk = c.hookStyle
  const bold = (f: string): number => (c.isBold?.(f) ? -1 : 0)
  const hi = assColor(cap.highlight)
  const base = assColor(cap.color)

  const hookOutline = hk.box ? assColor(hk.boxColor) : assColor(hk.outlineColor)
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
    `Style: Caption,${cap.font},${Math.round(cap.size)},${base},${base},${assColor(cap.outlineColor)},${cap.shadow ? '&H90000000' : '&HFF000000'},${bold(cap.font)},0,0,0,100,100,0,0,1,${cap.outlineWidth},${cap.shadow ? 4 : 0},5,${TEXT_MARGIN},${TEXT_MARGIN},0,1`,
    // Secundária transparente: a máquina de escrever usa karaokê (\k) pra revelar letra por letra.
    `Style: Hook,${hk.font},${Math.round(hk.size)},${assColor(hk.color)},${assColor(hk.color, hk.animation === 'typewriter' ? 255 : 0)},${hookOutline},&H00000000,${bold(hk.font)},0,0,0,100,100,0,0,${hk.box ? 3 : 1},${hk.box ? 22 : hk.outlineWidth},0,5,90,90,0,1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text'
  ]

  const hook = c.hook?.trim()
  if (hook && hk.enabled) {
    const text = displayText(hook, hk.uppercase)
    const end = Math.min(hk.duration, dur)
    const fadeOut = hk.animation === 'none' ? '' : `\\fad(0,${ms(ANIM.hookFadeOut)})`
    let tags = pos(hk.x, hk.y)
    let body = assEscape(text)
    switch (hk.animation) {
      case 'fade':
        tags += `\\fad(${ms(ANIM.hookFadeIn)},${ms(ANIM.hookFadeOut)})`
        break
      case 'pop':
        tags += POP + fadeOut
        break
      case 'slide':
        tags = `\\an5\\move(${Math.round(hk.x)},${Math.round(hk.y - ANIM.slideFrom)},${Math.round(hk.x)},${Math.round(hk.y)},0,${ms(ANIM.slideIn)})\\fad(${ms(ANIM.slideIn / 2)},${ms(ANIM.hookFadeOut)})`
        break
      case 'typewriter': {
        const step = Math.max(1, Math.round(typewriterStep(text.length) * 100))
        tags += fadeOut
        // \ko: a letra ainda não "digitada" some inteira (preenchimento e contorno)
        body = [...text].map((ch) => `{\\ko${step}}${assEscape(ch)}`).join('')
        break
      }
    }
    lines.push(`Dialogue: 2,${assTime(0)},${assTime(end)},Hook,,${wrapMargins(hk.boxWidth)},0,,{${tags}}${body}`)
  }

  if (!cap.enabled) return lines.join('\n') + '\n'

  for (const cue of c.cues) {
    const words = cue.words.filter((w) => w.w.trim())
    if (words.length === 0) continue
    const cueEnd = Math.min(cue.end, c.cutOut)
    for (let i = 0; i < words.length; i++) {
      const start = i === 0 ? cue.start : words[i]!.s
      const end = i === words.length - 1 ? cueEnd : words[i + 1]!.s
      const a = Math.max(0, toOut(cuts, start))
      const b = Math.min(dur, toOut(cuts, end))
      if (b - a < 0.02) continue
      // presa pelo topo (\an8): linhas a mais crescem pra baixo, a logo acima não é coberta
      let tags = `\\an8\\pos(${Math.round(cap.x)},${captionTextTop(cap)})`
      if (i === 0 && cap.animation === 'pop') tags += POP
      if (i === 0 && cap.animation === 'fade') tags += `\\fad(${ms(ANIM.captionFade)},0)`
      const shown = cap.animation === 'reveal' ? words.slice(0, i + 1) : words
      const text = shown
        .map((w, k) => {
          const t = assEscape(displayText(w.w, cap.uppercase))
          if (k !== i) return t
          if (cap.animation === 'bounce') {
            const s = Math.round(ANIM.bounceScale * 100)
            return `{\\c${hi}\\t(0,${ms(ANIM.bounceIn)},\\fscx${s}\\fscy${s})}${t}{\\c${base}\\fscx100\\fscy100}`
          }
          return `{\\c${hi}}${t}{\\c${base}}`
        })
        .join(' ')
      lines.push(`Dialogue: 1,${assTime(a)},${assTime(b)},Caption,,${wrapMargins(cap.boxWidth)},0,,{${tags}}${text}`)
    }
  }
  return lines.join('\n') + '\n'
}
