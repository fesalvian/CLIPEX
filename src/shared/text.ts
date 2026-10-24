// Legenda e gancho: padrões, estilo efetivo de cada corte e a conta das animações.
// O preview (renderer) e o .ass do render usam estas mesmas funções, pra o que aparece
// no app ser o que sai no vídeo.

import { OUT_H, OUT_W } from './consts'
import { captionAnchor } from './geometry'
import type {
  CamSplit,
  CaptionAnim,
  CaptionStyle,
  Clip,
  ClipLayout,
  HookAnim,
  HookStyle,
  SubtitleCue,
  TextDefaults,
  Watermark
} from './types'

export const DEFAULT_FONT = 'Montserrat ExtraBold'

/** Margem lateral pra quebra de linha (px no vídeo final). */
export const TEXT_MARGIN = 70

/** Padrão do canal (o estilo que o Felipe montou nas configurações). */
export const DEFAULT_TEXT: TextDefaults = {
  caption: {
    enabled: true,
    font: DEFAULT_FONT,
    size: 84,
    color: '#FFFFFF',
    highlight: '#4DFF00',
    outlineColor: '#000000',
    outlineWidth: 7,
    shadow: true,
    uppercase: true,
    x: OUT_W / 2,
    y: 1580,
    boxWidth: OUT_W - 2 * TEXT_MARGIN,
    animation: 'pop'
  },
  hook: {
    enabled: true,
    font: 'Luckiest Guy',
    size: 66,
    color: '#FFFFFF',
    outlineColor: '#000000',
    outlineWidth: 6,
    box: false,
    boxColor: '#FF0000',
    uppercase: true,
    x: 513,
    y: 769,
    boxWidth: 900,
    animation: 'pop',
    duration: 8,
    mode: 'fixed',
    fixedText: ''
  }
}

/** Altura de uma linha de texto em relação ao tamanho da fonte (libass/navegador ≈ 1,2). */
export const LINE_HEIGHT = 1.2

export const CAPTION_ANIMS: { key: CaptionAnim; label: string }[] = [
  { key: 'none', label: 'Sem animação' },
  { key: 'pop', label: 'Pop (cada trecho salta)' },
  { key: 'fade', label: 'Aparecer suave' },
  { key: 'bounce', label: 'Palavra falada cresce' },
  { key: 'reveal', label: 'Palavra por palavra' }
]

export const HOOK_ANIMS: { key: HookAnim; label: string }[] = [
  { key: 'none', label: 'Sem animação' },
  { key: 'pop', label: 'Pop' },
  { key: 'fade', label: 'Aparecer suave' },
  { key: 'slide', label: 'Descer de cima' },
  { key: 'typewriter', label: 'Máquina de escrever' }
]

export function mergeDefaults(stored: Partial<TextDefaults> | undefined): TextDefaults {
  return {
    caption: { ...DEFAULT_TEXT.caption, ...(stored?.caption ?? {}) },
    hook: { ...DEFAULT_TEXT.hook, ...(stored?.hook ?? {}) }
  }
}

/** Centro vertical automático da legenda: logo abaixo da webcam (ou a 62% sem divisão). */
export function autoCaptionY(layout: ClipLayout, split: CamSplit, size: number): number {
  return Math.round(captionAnchor(layout, split) * OUT_H + 40 + size * 0.6)
}

export function captionStyleFor(c: Pick<Clip, 'captionStyle' | 'layout' | 'camSplit'>, d: TextDefaults): CaptionStyle & { y: number } {
  const s = { ...d.caption, ...(c.captionStyle ?? {}) }
  return { ...s, y: s.y ?? autoCaptionY(c.layout, c.camSplit, s.size) }
}

export function hookStyleFor(c: Pick<Clip, 'hookStyle'>, d: TextDefaults): HookStyle & { y: number } {
  const s = { ...d.hook, ...(c.hookStyle ?? {}) }
  return { ...s, y: s.y ?? DEFAULT_TEXT.hook.y! }
}

/** Texto do gancho deste corte, seguindo: desligado › escrito à mão › sugestão escolhida › padrão. */
export function hookTextFor(c: Pick<Clip, 'hookOff' | 'hookCustom' | 'hookChoice' | 'llm' | 'hookStyle'>, d: TextDefaults): string | null {
  if (c.hookOff) return null
  const style = { ...d.hook, ...(c.hookStyle ?? {}) }
  if (!style.enabled) return null
  if (c.hookCustom.trim()) return c.hookCustom.trim()
  if (c.hookChoice !== null && c.llm?.hooks[c.hookChoice]) return c.llm.hooks[c.hookChoice]!
  // texto fixo vazio: cai na sugestão da IA (senão o corte fica sem gancho sem querer)
  if (style.mode === 'fixed' && style.fixedText.trim()) return style.fixedText.trim()
  return c.llm?.hooks[0] ?? null
}

type ClipNameFields = Pick<Clip, 'number' | 'hookOff' | 'hookCustom' | 'hookChoice' | 'llm' | 'hookStyle'>

/** Texto que identifica o corte além do número: o gancho do vídeo (ou o título da IA, sem gancho). */
export function clipSubtitle(c: ClipNameFields, d: TextDefaults): string | null {
  return hookTextFor(c, d) ?? c.llm?.title ?? null
}

/** "Clipe 07 · TEXTO DO GANCHO", cortado em `max` caracteres. */
export function clipTitle(c: ClipNameFields, d: TextDefaults, max = 60): string {
  const base = `Clipe ${String(c.number).padStart(2, '0')}`
  const sub = clipSubtitle(c, d)
  if (!sub) return base
  return `${base} · ${sub.length > max ? `${sub.slice(0, max - 1).trimEnd()}…` : sub}`
}

/**
 * A legenda é presa pelo topo: `y` é o centro da PRIMEIRA linha e as linhas a mais crescem
 * pra baixo. Assim o topo não muda com o número de linhas e a logo acima nunca é coberta.
 */
export function captionTextTop(cap: Pick<CaptionStyle, 'size'> & { y: number }): number {
  return Math.round(cap.y - (cap.size * LINE_HEIGHT) / 2)
}

/** Topo visual da legenda (com o contorno). */
export function captionTop(cap: Pick<CaptionStyle, 'size' | 'outlineWidth'> & { y: number }): number {
  return captionTextTop(cap) - cap.outlineWidth
}

export interface PixelBox {
  x: number
  y: number
  w: number
  h: number
}

/**
 * Onde a logo/marca d'água fica no vídeo final. No modo 'caption' ela acompanha a legenda:
 * centralizada nela (mais o deslocamento) e sempre acima, com `gap` de espaço — nunca
 * sobrepõe nem vai pra baixo da legenda.
 */
export function watermarkBox(wm: Watermark, cap: Pick<CaptionStyle, 'size' | 'outlineWidth' | 'x'> & { y: number }): PixelBox {
  const w = Math.max(20, Math.min(OUT_W, wm.w))
  const h = (w * wm.imgH) / Math.max(1, wm.imgW)
  if (wm.anchor !== 'caption') return { x: Math.round(wm.x), y: Math.round(wm.y), w: Math.round(w), h: Math.round(h) }
  const x = Math.max(0, Math.min(OUT_W - w, cap.x + wm.offsetX - w / 2))
  const y = Math.max(0, captionTop(cap) - Math.max(0, wm.gap) - h)
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) }
}

export function captionsOn(c: Pick<Clip, 'captionStyle'>, d: TextDefaults): boolean {
  return { ...d.caption, ...(c.captionStyle ?? {}) }.enabled
}

// ---------------- animações ----------------

export const ANIM = {
  popIn: 0.12,
  popSettle: 0.08,
  popFrom: 0.7,
  popOver: 1.08,
  captionFade: 0.12,
  bounceScale: 1.18,
  bounceIn: 0.09,
  hookFadeIn: 0.25,
  hookFadeOut: 0.2,
  slideFrom: 120,
  slideIn: 0.25,
  typeMax: 0.9,
  typePerChar: 0.045
}

function popScale(dt: number): number {
  if (dt <= 0) return ANIM.popFrom
  if (dt < ANIM.popIn) return ANIM.popFrom + ((ANIM.popOver - ANIM.popFrom) * dt) / ANIM.popIn
  if (dt < ANIM.popIn + ANIM.popSettle) return ANIM.popOver - ((ANIM.popOver - 1) * (dt - ANIM.popIn)) / ANIM.popSettle
  return 1
}

export interface CaptionFrame {
  /** quantas palavras aparecem (palavra por palavra mostra só até a atual) */
  visible: number
  /** palavra destacada */
  current: number
  scale: number
  opacity: number
  /** escala da palavra destacada */
  wordScale: number
}

/** Estado da legenda num instante `t` (s na live), pro preview desenhar igual ao render. */
export function captionFrame(cue: SubtitleCue, t: number, anim: CaptionAnim): CaptionFrame {
  const words = cue.words
  let current = 0
  for (let i = 0; i < words.length; i++) if (words[i]!.s <= t) current = i
  const dt = t - cue.start
  const wordStart = current === 0 ? cue.start : words[current]!.s
  return {
    visible: anim === 'reveal' ? current + 1 : words.length,
    current,
    scale: anim === 'pop' ? popScale(dt) : 1,
    opacity: anim === 'fade' ? Math.max(0, Math.min(1, dt / ANIM.captionFade)) : 1,
    wordScale: anim === 'bounce' ? 1 + (ANIM.bounceScale - 1) * Math.max(0, Math.min(1, (t - wordStart) / ANIM.bounceIn)) : 1
  }
}

export interface HookFrame {
  visible: boolean
  opacity: number
  scale: number
  /** deslocamento vertical (px no vídeo final) */
  dy: number
  /** quantos caracteres aparecem (máquina de escrever) */
  chars: number
}

export function typewriterStep(len: number): number {
  return Math.min(ANIM.typePerChar, ANIM.typeMax / Math.max(1, len))
}

/** Estado do gancho `dt` segundos depois do início do corte. */
export function hookFrame(text: string, dt: number, style: Pick<HookStyle, 'animation' | 'duration'>): HookFrame {
  const len = text.length
  if (dt < 0 || dt > style.duration) return { visible: false, opacity: 0, scale: 1, dy: 0, chars: len }
  const out = style.duration - dt
  const fadeOut = style.animation === 'none' ? 1 : Math.max(0, Math.min(1, out / ANIM.hookFadeOut))
  switch (style.animation) {
    case 'fade':
      return { visible: true, opacity: Math.min(1, dt / ANIM.hookFadeIn) * fadeOut, scale: 1, dy: 0, chars: len }
    case 'pop':
      return { visible: true, opacity: fadeOut, scale: popScale(dt), dy: 0, chars: len }
    case 'slide': {
      const k = Math.min(1, dt / ANIM.slideIn)
      const ease = 1 - Math.pow(1 - k, 3)
      return { visible: true, opacity: Math.min(1, k * 2) * fadeOut, scale: 1, dy: -ANIM.slideFrom * (1 - ease), chars: len }
    }
    case 'typewriter':
      return { visible: true, opacity: fadeOut, scale: 1, dy: 0, chars: Math.min(len, Math.floor(dt / typewriterStep(len)) + 1) }
    default:
      return { visible: true, opacity: 1, scale: 1, dy: 0, chars: len }
  }
}

export function displayText(text: string, uppercase: boolean): string {
  return uppercase ? text.toLocaleUpperCase('pt-BR') : text
}
