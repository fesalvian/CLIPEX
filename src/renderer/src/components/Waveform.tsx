import { useMemo, useRef, type PointerEvent as RPointerEvent } from 'react'
import { MIN_CUT } from '@shared/defaults'
import type { Clip } from '@shared/types'
import type { LiveWave } from '../store'
import { capturePointer } from '../lib/pointer'

const BARS = 120
/** quanto o ponteiro precisa andar pra virar arraste (senão é clique) */
const DRAG_PX = 4

interface Props {
  clip: Clip
  live: LiveWave | null
  /** duração da live (s) */
  duration: number
  selected: boolean
  /** tempo do player (s na live) quando este corte está selecionado */
  time: number | null
  onCutChange: (cutIn: number, cutOut: number, final: boolean) => void
  /** janela visível arrastada pela live */
  onViewChange: (winStart: number, winEnd: number, final: boolean) => void
  onSeek: (sec: number) => void
}

type Mode = 'in' | 'out' | 'move' | 'pan'

interface Drag {
  mode: Mode
  x0: number
  moved: boolean
  /** valores no começo do arraste */
  cutIn: number
  cutOut: number
  winStart: number
  /** últimos valores calculados: é isso que fica salvo ao soltar */
  lastIn: number
  lastOut: number
  lastWin: number
}

/**
 * Timeline do corte com a waveform da live:
 * - alças: início e fim do corte;
 * - arrastar dentro do corte: move o corte inteiro;
 * - arrastar fora do corte: anda pela live (arrasta o áudio);
 * - clique sem arrastar: posiciona o cursor.
 */
export function Waveform({ clip, live, duration, selected, time, onCutChange, onViewChange, onSeek }: Props) {
  const ref = useRef<HTMLDivElement | null>(null)
  const drag = useRef<Drag | null>(null)
  const view0 = clip.winStart
  const span = Math.max(1, clip.winEnd - clip.winStart)
  const pct = (sec: number): number => ((sec - view0) / span) * 100
  const inP = pct(clip.cutIn)
  const outP = pct(clip.cutOut)
  const headP = time !== null ? pct(time) : null

  // barras da janela recortadas da waveform da live inteira
  const bars = useMemo(() => {
    if (!live) return null
    const out: number[] = []
    for (let i = 0; i < BARS; i++) {
      const a = Math.floor((view0 + (i * span) / BARS) * live.rate)
      const b = Math.max(a + 1, Math.floor((view0 + ((i + 1) * span) / BARS) * live.rate))
      let mx = 0
      for (let k = Math.max(0, a); k < b && k < live.values.length; k++) mx = Math.max(mx, live.values[k]!)
      out.push(mx)
    }
    return out
  }, [live, view0, span])

  // Escala relativa à janela: o volume normal da fala fica embaixo e o pico salta.
  const level = useMemo(() => {
    const sorted = [...(bars ?? [])].sort((a, b) => a - b)
    const lo = sorted[Math.floor(sorted.length * 0.1)] ?? 0
    const hi = Math.max(lo + 0.05, sorted[sorted.length - 1] ?? 1)
    return (v: number): number => Math.pow(Math.max(0, Math.min(1, (v - lo) / (hi - lo))), 1.6)
  }, [bars])

  const secAt = (clientX: number): number => {
    const r = ref.current!.getBoundingClientRect()
    const f = Math.max(0, Math.min(1, (clientX - r.left) / r.width))
    return Math.round((view0 + f * span) * 10) / 10
  }

  const start = (mode: Mode | null) => (e: RPointerEvent) => {
    if (e.button !== 0) return
    e.stopPropagation()
    const sec = secAt(e.clientX)
    const m: Mode = mode ?? (sec >= clip.cutIn && sec <= clip.cutOut ? 'move' : 'pan')
    capturePointer(e)
    drag.current = {
      mode: m,
      x0: e.clientX,
      moved: false,
      cutIn: clip.cutIn,
      cutOut: clip.cutOut,
      winStart: clip.winStart,
      lastIn: clip.cutIn,
      lastOut: clip.cutOut,
      lastWin: clip.winStart
    }
  }

  const onMove = (e: RPointerEvent): void => {
    const d = drag.current
    if (!ref.current) return
    if (!d) {
      // cursor mostra o que o arraste vai fazer
      const sec = secAt(e.clientX)
      ref.current.style.cursor = sec >= clip.cutIn && sec <= clip.cutOut ? 'move' : 'grab'
      return
    }
    const dx = e.clientX - d.x0
    if (!d.moved && Math.abs(dx) < DRAG_PX) return
    d.moved = true
    const width = ref.current.getBoundingClientRect().width
    const dsec = (dx / width) * span
    const len = d.cutOut - d.cutIn
    // posição no tempo a partir da janela do começo do arraste (não depende de re-render)
    const at = round1(d.winStart + ((e.clientX - ref.current.getBoundingClientRect().left) / width) * span)
    if (d.mode === 'in') {
      d.lastIn = Math.max(d.winStart, Math.min(at, d.cutOut - MIN_CUT))
      onCutChange(d.lastIn, d.cutOut, false)
    } else if (d.mode === 'out') {
      d.lastOut = Math.min(d.winStart + span, Math.max(at, d.cutIn + MIN_CUT))
      onCutChange(d.cutIn, d.lastOut, false)
    } else if (d.mode === 'move') {
      const lo = Math.min(d.winStart, d.cutIn)
      const hi = Math.max(d.winStart + span, d.cutOut)
      const ni = round1(Math.max(lo, Math.min(hi - len, d.cutIn + dsec)))
      d.lastIn = ni
      d.lastOut = round1(ni + len)
      onCutChange(d.lastIn, d.lastOut, false)
    } else {
      // arrastar o áudio: puxar pra direita mostra o que vem antes na live
      d.lastWin = round1(Math.max(0, Math.min(Math.max(0, duration - span), d.winStart - dsec)))
      onViewChange(d.lastWin, round1(d.lastWin + span), false)
    }
  }

  const onUp = (e: RPointerEvent): void => {
    const d = drag.current
    drag.current = null
    if (!d) return
    if (!d.moved) {
      if (d.mode === 'move' || d.mode === 'pan') onSeek(secAt(e.clientX))
      return
    }
    if (d.mode === 'pan') onViewChange(d.lastWin, round1(d.lastWin + span), true)
    else onCutChange(d.lastIn, d.lastOut, true)
  }

  const nudge = (which: 'in' | 'out', delta: number): void => {
    const cutIn = which === 'in' ? Math.max(0, Math.min(clip.cutIn + delta, clip.cutOut - MIN_CUT)) : clip.cutIn
    const cutOut = which === 'out' ? Math.min(duration, Math.max(clip.cutOut + delta, clip.cutIn + MIN_CUT)) : clip.cutOut
    onCutChange(cutIn, cutOut, true)
  }

  const clampP = (p: number): number => Math.max(0, Math.min(100, p))
  const regionL = clampP(inP)
  const regionR = clampP(outP)
  const handleIn = inP >= -1 && inP <= 101
  const handleOut = outP >= -1 && outP <= 101

  return (
    <div
      ref={ref}
      className={`wave${drag.current?.mode === 'pan' ? ' panning' : ''}`}
      onPointerDown={start(null)}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      title="Arraste o corte pra mover · arraste fora dele pra andar pela live · clique pra posicionar"
    >
      <div className={`wave-bars${bars ? '' : ' shimmer'}`}>
        {(bars ?? []).map((v, i) => {
          const pos = (i / (BARS - 1)) * 100
          const on = pos >= inP && pos <= outP
          const tt = on ? (pos - inP) / Math.max(1, outP - inP) : 0
          const color = on ? `rgb(${Math.round(167 - tt * 71)},${Math.round(139 + tt * 26)},250)` : '#353A5E'
          return <span key={i} style={{ height: `${Math.round(6 + level(v) * 42)}px`, background: color }} />
        })}
      </div>
      <div className="wave-dim" style={{ left: 0, width: `${regionL}%` }} />
      <div className="wave-dim" style={{ right: 0, width: `${100 - regionR}%` }} />
      {regionR > regionL && <div className="wave-region" style={{ left: `${regionL}%`, width: `${regionR - regionL}%` }} />}
      {handleIn && (
        <div
          className="wave-handle in"
          style={{ left: `calc(${inP}% - 6px)` }}
          role="slider"
          tabIndex={0}
          aria-label="Início do corte"
          aria-valuemin={0}
          aria-valuemax={duration}
          aria-valuenow={clip.cutIn}
          onPointerDown={start('in')}
          onKeyDown={(e) => {
            if (e.key === 'ArrowLeft') nudge('in', -0.5)
            if (e.key === 'ArrowRight') nudge('in', 0.5)
          }}
        >
          <span />
        </div>
      )}
      {handleOut && (
        <div
          className="wave-handle out"
          style={{ left: `calc(${outP}% - 6px)` }}
          role="slider"
          tabIndex={0}
          aria-label="Fim do corte"
          aria-valuemin={0}
          aria-valuemax={duration}
          aria-valuenow={clip.cutOut}
          onPointerDown={start('out')}
          onKeyDown={(e) => {
            if (e.key === 'ArrowLeft') nudge('out', -0.5)
            if (e.key === 'ArrowRight') nudge('out', 0.5)
          }}
        >
          <span />
        </div>
      )}
      {selected && headP !== null && headP >= 0 && headP <= 100 && (
        <div className="wave-head" style={{ left: `${headP}%` }}>
          <i />
        </div>
      )}
    </div>
  )
}

function round1(n: number): number {
  return Math.round(n * 10) / 10
}
