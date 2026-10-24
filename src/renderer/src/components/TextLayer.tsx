import { useRef, type CSSProperties, type PointerEvent as RPointerEvent } from 'react'
import { OUT_H, OUT_W } from '@shared/consts'
import { stripEmoji } from '@shared/subtitles'
import { captionFrame, captionTextTop, displayText, hookFrame, LINE_HEIGHT, type CaptionFrame, type HookFrame } from '@shared/text'
import type { CaptionStyle, HookStyle, SubtitleCue } from '@shared/types'
import { fontStack } from '../lib/fonts'
import { capturePointer } from '../lib/pointer'

export type TextKind = 'caption' | 'hook'

/** O que muda ao arrastar: posição, largura da área do texto ou tamanho da fonte. */
export interface TextPatch {
  x?: number
  y?: number
  boxWidth?: number
  size?: number
}

interface Props {
  /** largura do preview em px (o vídeo final tem 1080) */
  width: number
  caption: CaptionStyle & { y: number }
  hook: HookStyle & { y: number }
  hookText: string | null
  /** trecho da legenda no instante atual (tocando) */
  cue: SubtitleCue | null
  /** trecho mostrado pra posicionar quando está pausado */
  sampleCue: SubtitleCue | null
  /** instante atual na live (s) */
  t: number
  /** instante no vídeo final (s): o gancho conta a partir do começo do vídeo */
  elapsed: number
  /** pausado e editável: mostra os dois textos com contorno pra arrastar e redimensionar */
  editing: boolean
  onChange?: (kind: TextKind, patch: TextPatch, final: boolean) => void
}

type Mode = 'move' | 'w' | 'e' | 'size'

const SNAP = 18
const MIN_W = 140
const STATIC_CAPTION: CaptionFrame = { visible: 99, current: 0, scale: 1, opacity: 1, wordScale: 1 }
const STATIC_HOOK: HookFrame = { visible: true, opacity: 1, scale: 1, dy: 0, chars: 9999 }

function stroke(width: number, color: string, s: number): CSSProperties {
  if (width <= 0) return {}
  // o contorno do ASS fica todo por fora da letra; no CSS metade fica por dentro, então dobra
  return { WebkitTextStroke: `${Math.max(1, width * 2 * s)}px ${color}`, paintOrder: 'stroke fill' }
}

function Handles({ on }: { on: (mode: Mode) => (e: RPointerEvent) => void }) {
  return (
    <>
      <span className="tb-h w" aria-label="Largura da área do texto" onPointerDown={on('w')} />
      <span className="tb-h e" aria-label="Largura da área do texto" onPointerDown={on('e')} />
      <span className="tb-h size" aria-label="Tamanho da fonte" onPointerDown={on('size')} />
    </>
  )
}

/** Legenda e gancho por cima do preview, com o mesmo estilo e animação do render. */
export function TextLayer({ width, caption, hook, hookText, cue, sampleCue, t, elapsed, editing, onChange }: Props) {
  const s = width / OUT_W
  const drag = useRef<{ kind: TextKind; mode: Mode; sx: number; sy: number; x: number; y: number; bw: number; size: number; last: TextPatch } | null>(
    null
  )
  const editable = editing && !!onChange

  const start = (kind: TextKind, mode: Mode) => (e: RPointerEvent) => {
    if (!editable || e.button !== 0) return
    e.stopPropagation()
    capturePointer(e)
    const st = kind === 'caption' ? caption : hook
    drag.current = { kind, mode, sx: e.clientX, sy: e.clientY, x: st.x, y: st.y, bw: st.boxWidth, size: st.size, last: {} }
  }
  const move = (e: RPointerEvent): void => {
    const d = drag.current
    if (!d) return
    const dx = (e.clientX - d.sx) / s
    const dy = (e.clientY - d.sy) / s
    let patch: TextPatch
    if (d.mode === 'move') {
      let x = d.x + dx
      if (Math.abs(x - OUT_W / 2) < SNAP) x = OUT_W / 2
      patch = { x: Math.round(Math.max(0, Math.min(OUT_W, x))), y: Math.round(Math.max(0, Math.min(OUT_H, d.y + dy))) }
    } else if (d.mode === 'e' || d.mode === 'w') {
      // largura cresce pros dois lados (o texto continua centralizado no ponto)
      const bw = d.bw + (d.mode === 'e' ? 2 * dx : -2 * dx)
      patch = { boxWidth: Math.round(Math.max(MIN_W, Math.min(OUT_W, bw))) }
    } else {
      patch = { size: Math.round(Math.max(24, Math.min(220, d.size + (dx + dy) * 0.35))) }
    }
    d.last = patch
    onChange?.(d.kind, patch, false)
  }
  const up = (): void => {
    const d = drag.current
    drag.current = null
    if (d && Object.keys(d.last).length) onChange?.(d.kind, d.last, true)
  }
  const handlers = (kind: TextKind) => ({
    onPointerDown: start(kind, 'move'),
    onPointerMove: move,
    onPointerUp: up,
    onPointerCancel: up
  })

  // ---- legenda ----
  let captionEl: React.ReactNode = null
  const shownCue = cue ?? (editing ? sampleCue : null)
  if (caption.enabled && shownCue) {
    const f = cue ? captionFrame(cue, t, caption.animation) : STATIC_CAPTION
    captionEl = (
      <div
        className={`text-box caption${editable ? ' editable' : ''}`}
        style={{
          // presa pelo topo (igual ao \an8 do render): linhas a mais crescem pra baixo
          left: caption.x * s,
          top: captionTextTop(caption) * s,
          width: caption.boxWidth * s,
          lineHeight: LINE_HEIGHT,
          transform: `translate(-50%, 0) scale(${f.scale})`,
          transformOrigin: 'top center',
          opacity: f.opacity,
          fontFamily: fontStack(caption.font),
          fontSize: caption.size * s,
          color: caption.color,
          textShadow: caption.shadow ? `0 ${4 * s}px 0 rgba(0,0,0,0.56)` : 'none',
          ...stroke(caption.outlineWidth, caption.outlineColor, s)
        }}
        {...handlers('caption')}
      >
        {shownCue.words.slice(0, f.visible).map((w, i) => {
          const on = i === f.current
          return (
            <span
              key={i}
              style={on ? { color: caption.highlight, display: 'inline-block', transform: `scale(${f.wordScale})` } : undefined}
            >
              {displayText(stripEmoji(w.w), caption.uppercase)}
              {i < f.visible - 1 ? ' ' : ''}
            </span>
          )
        })}
        {editable && <Handles on={(m) => start('caption', m)} />}
      </div>
    )
  }

  // ---- gancho ----
  let hookEl: React.ReactNode = null
  if (hook.enabled && hookText) {
    const text = displayText(stripEmoji(hookText), hook.uppercase)
    const f = editing ? STATIC_HOOK : hookFrame(text, elapsed, hook)
    if (f.visible) {
      const pad = hook.box ? 22 * s : 0
      hookEl = (
        <div
          className={`text-box hook${editable ? ' editable' : ''}`}
          style={{
            left: hook.x * s,
            top: (hook.y + f.dy) * s,
            width: hook.boxWidth * s,
            lineHeight: LINE_HEIGHT,
            transform: `translate(-50%, -50%) scale(${f.scale})`,
            opacity: f.opacity,
            fontFamily: fontStack(hook.font),
            fontSize: hook.size * s,
            color: hook.color
          }}
          {...handlers('hook')}
        >
          <span
            className="hook-text"
            style={{
              background: hook.box ? hook.boxColor : 'transparent',
              padding: `${pad}px ${pad * 1.1}px`,
              ...(hook.box ? {} : stroke(hook.outlineWidth, hook.outlineColor, s))
            }}
          >
            {text.slice(0, f.chars)}
            {/* letras ainda não "digitadas" ocupam espaço, igual ao libass */}
            {f.chars < text.length && <span style={{ color: 'transparent', WebkitTextStroke: '0' }}>{text.slice(f.chars)}</span>}
          </span>
          {editable && <Handles on={(m) => start('hook', m)} />}
        </div>
      )
    }
  }

  return (
    <>
      {hookEl}
      {captionEl}
    </>
  )
}
