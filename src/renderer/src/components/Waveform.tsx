import { useRef, type PointerEvent as RPointerEvent } from 'react'
import { MIN_CUT } from '@shared/defaults'
import type { Clip } from '@shared/types'

interface Props {
  clip: Clip
  wave: number[] | undefined
  selected: boolean
  /** tempo do player (s na live) quando este corte está selecionado */
  time: number | null
  onCutChange: (cutIn: number, cutOut: number, final: boolean) => void
  onSeek: (sec: number) => void
}

/** Waveform da janela do candidato com alças de início e fim (estilo corte de stories). */
export function Waveform({ clip, wave, selected, time, onCutChange, onSeek }: Props) {
  const ref = useRef<HTMLDivElement | null>(null)
  const drag = useRef<{ which: 'in' | 'out'; cutIn: number; cutOut: number } | null>(null)
  const span = Math.max(1, clip.winEnd - clip.winStart)
  const inP = ((clip.cutIn - clip.winStart) / span) * 100
  const outP = ((clip.cutOut - clip.winStart) / span) * 100
  const headP = time !== null ? ((time - clip.winStart) / span) * 100 : null

  const secAt = (clientX: number): number => {
    const r = ref.current!.getBoundingClientRect()
    const f = Math.max(0, Math.min(1, (clientX - r.left) / r.width))
    return Math.round((clip.winStart + f * span) * 10) / 10
  }

  const startDrag = (which: 'in' | 'out') => (e: RPointerEvent) => {
    e.stopPropagation()
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    drag.current = { which, cutIn: clip.cutIn, cutOut: clip.cutOut }
  }
  const onMove = (e: RPointerEvent): void => {
    const d = drag.current
    if (!d) return
    const s = secAt(e.clientX)
    if (d.which === 'in') d.cutIn = Math.min(s, d.cutOut - MIN_CUT)
    else d.cutOut = Math.max(s, d.cutIn + MIN_CUT)
    onCutChange(d.cutIn, d.cutOut, false)
  }
  const onUp = (): void => {
    const d = drag.current
    drag.current = null
    if (d) onCutChange(d.cutIn, d.cutOut, true)
  }

  const nudge = (which: 'in' | 'out', delta: number): void => {
    const cutIn = which === 'in' ? Math.max(clip.winStart, Math.min(clip.cutIn + delta, clip.cutOut - MIN_CUT)) : clip.cutIn
    const cutOut = which === 'out' ? Math.min(clip.winEnd, Math.max(clip.cutOut + delta, clip.cutIn + MIN_CUT)) : clip.cutOut
    onCutChange(cutIn, cutOut, true)
  }

  // Escala relativa à janela: o volume normal da fala fica embaixo e o pico salta.
  const bars = wave ?? []
  const sorted = [...bars].sort((a, b) => a - b)
  const lo = sorted[Math.floor(sorted.length * 0.1)] ?? 0
  const hi = Math.max(lo + 0.05, sorted[sorted.length - 1] ?? 1)
  const level = (v: number): number => Math.pow(Math.max(0, Math.min(1, (v - lo) / (hi - lo))), 1.6)
  return (
    <div
      ref={ref}
      className="wave"
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      onClick={(e) => onSeek(secAt(e.clientX))}
    >
      <div className={`wave-bars${wave ? '' : ' shimmer'}`}>
        {bars.map((v, i) => {
          const pos = (i / Math.max(1, bars.length - 1)) * 100
          const on = pos >= inP && pos <= outP
          const tt = on ? (pos - inP) / Math.max(1, outP - inP) : 0
          const color = on ? `rgb(${Math.round(167 - tt * 71)},${Math.round(139 + tt * 26)},250)` : '#353A5E'
          return <span key={i} style={{ height: `${Math.round(6 + level(v) * 42)}px`, background: color }} />
        })}
      </div>
      <div className="wave-dim" style={{ left: 0, width: `${inP}%` }} />
      <div className="wave-dim" style={{ right: 0, width: `${100 - outP}%` }} />
      <div className="wave-region" style={{ left: `${inP}%`, width: `${outP - inP}%` }} />
      <div
        className="wave-handle in"
        style={{ left: `calc(${inP}% - 6px)` }}
        role="slider"
        tabIndex={0}
        aria-label="Início do corte"
        aria-valuemin={clip.winStart}
        aria-valuemax={clip.winEnd}
        aria-valuenow={clip.cutIn}
        onPointerDown={startDrag('in')}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft') nudge('in', -0.5)
          if (e.key === 'ArrowRight') nudge('in', 0.5)
        }}
      >
        <span />
      </div>
      <div
        className="wave-handle out"
        style={{ left: `calc(${outP}% - 6px)` }}
        role="slider"
        tabIndex={0}
        aria-label="Fim do corte"
        aria-valuemin={clip.winStart}
        aria-valuemax={clip.winEnd}
        aria-valuenow={clip.cutOut}
        onPointerDown={startDrag('out')}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft') nudge('out', -0.5)
          if (e.key === 'ArrowRight') nudge('out', 0.5)
        }}
      >
        <span />
      </div>
      {selected && headP !== null && headP >= 0 && headP <= 100 && (
        <div className="wave-head" style={{ left: `${headP}%` }}>
          <i />
        </div>
      )}
    </div>
  )
}
