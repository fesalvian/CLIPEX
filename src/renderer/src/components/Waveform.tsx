import { useMemo, useRef, useState, type PointerEvent as RPointerEvent } from 'react'
import { cutIndexAt, cutsOf, MIN_SEGMENT, toOut } from '@shared/cuts'
import { MIN_CUT } from '@shared/defaults'
import type { Clip, Cut } from '@shared/types'
import type { LiveWave } from '../store'
import { capturePointer } from '../lib/pointer'
import { Icon } from './Icon'

const BARS = 120
/** quanto o ponteiro precisa andar pra virar arraste (senão é clique) */
const DRAG_PX = 4
/** distância (px) em que o cursor de reprodução pode ser pego e gruda no início/fim do corte */
const HEAD_PX = 8
/** espaço mínimo entre dois trechos (s) */
const GAP = 0.1

interface Props {
  clip: Clip
  live: LiveWave | null
  /** duração da live (s) */
  duration: number
  selected: boolean
  /** tempo do player (s na live) quando este corte está selecionado */
  time: number | null
  onCutsChange: (cuts: Cut[], final: boolean) => void
  /** janela visível arrastada pela live */
  onViewChange: (winStart: number, winEnd: number, final: boolean) => void
  onSeek: (sec: number) => void
}

type Mode = 'in' | 'out' | 'move' | 'pan' | 'scrub'

interface Drag {
  mode: Mode
  /** trecho sendo mexido (in/out/move) */
  seg: number
  x0: number
  moved: boolean
  /** valores no começo do arraste */
  cuts: Cut[]
  winStart: number
  /** últimos valores calculados: é isso que fica salvo ao soltar */
  last: Cut[]
  lastWin: number
}

/**
 * Timeline do corte com a waveform da live. Um corte pode ter vários trechos (viram um vídeo
 * só, com corte seco entre eles):
 * - alças: início e fim de cada trecho;
 * - arrastar dentro de um trecho: move esse trecho;
 * - arrastar fora dos trechos: anda pela live (arrasta o áudio);
 * - arrastar o cursor de reprodução: procura no corte (gruda no início e no fim);
 * - clique sem arrastar: posiciona o cursor.
 */
export function Waveform({ clip, live, duration, selected, time, onCutsChange, onViewChange, onSeek }: Props) {
  const ref = useRef<HTMLDivElement | null>(null)
  const drag = useRef<Drag | null>(null)
  const [scrubbing, setScrubbing] = useState(false)
  const cuts = cutsOf(clip)
  const multi = cuts.length > 1
  const minLen = multi ? MIN_SEGMENT : MIN_CUT
  const view0 = clip.winStart
  const span = Math.max(1, clip.winEnd - clip.winStart)
  const pct = (sec: number): number => ((sec - view0) / span) * 100
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

  /** o ponteiro está em cima do cursor de reprodução (dá pra pegar ele) */
  const nearHead = (clientX: number): boolean => {
    if (!selected || headP === null || !ref.current) return false
    const r = ref.current.getBoundingClientRect()
    return Math.abs(clientX - (r.left + (headP / 100) * r.width)) <= HEAD_PX
  }

  /** tempo do cursor arrastado: dentro do corte, grudando no início e no fim de cada trecho */
  const scrubAt = (clientX: number): number => {
    const r = ref.current!.getBoundingClientRect()
    const raw = view0 + ((clientX - r.left) / r.width) * span
    const snap = (HEAD_PX / r.width) * span
    for (const k of cuts) {
      if (Math.abs(raw - k.s) <= snap) return k.s
      if (Math.abs(raw - k.e) <= snap) return k.e
    }
    return Math.max(clip.cutIn, Math.min(clip.cutOut, Math.round(raw * 10) / 10))
  }

  const start = (mode: Mode | null, seg = -1) => (e: RPointerEvent) => {
    if (e.button !== 0) return
    e.stopPropagation()
    const sec = secAt(e.clientX)
    const inside = cutIndexAt(cuts, sec)
    const m: Mode = mode ?? (nearHead(e.clientX) ? 'scrub' : inside >= 0 ? 'move' : 'pan')
    capturePointer(e)
    if (m === 'scrub') setScrubbing(true)
    drag.current = {
      mode: m,
      seg: mode ? seg : inside,
      x0: e.clientX,
      moved: false,
      cuts,
      winStart: clip.winStart,
      last: cuts,
      lastWin: clip.winStart
    }
  }

  const onMove = (e: RPointerEvent): void => {
    const d = drag.current
    if (!ref.current) return
    if (!d) {
      // cursor mostra o que o arraste vai fazer
      const sec = secAt(e.clientX)
      ref.current.style.cursor = nearHead(e.clientX) ? 'ew-resize' : cutIndexAt(cuts, sec) >= 0 ? 'move' : 'grab'
      return
    }
    if (d.mode === 'scrub') {
      d.moved = true
      onSeek(scrubAt(e.clientX))
      return
    }
    const dx = e.clientX - d.x0
    if (!d.moved && Math.abs(dx) < DRAG_PX) return
    d.moved = true
    const width = ref.current.getBoundingClientRect().width
    const dsec = (dx / width) * span
    // posição no tempo a partir da janela do começo do arraste (não depende de re-render)
    const at = round1(d.winStart + ((e.clientX - ref.current.getBoundingClientRect().left) / width) * span)

    if (d.mode === 'pan') {
      // arrastar o áudio: puxar pra direita mostra o que vem antes na live
      d.lastWin = round1(Math.max(0, Math.min(Math.max(0, duration - span), d.winStart - dsec)))
      onViewChange(d.lastWin, round1(d.lastWin + span), false)
      return
    }

    const k = d.cuts[d.seg]
    if (!k) return
    const prev = d.cuts[d.seg - 1]
    const next = d.cuts[d.seg + 1]
    let nk: Cut
    if (d.mode === 'in') {
      const lo = prev ? prev.e + GAP : d.winStart
      nk = { s: Math.max(lo, Math.min(at, k.e - minLen)), e: k.e }
    } else if (d.mode === 'out') {
      const hi = next ? next.s - GAP : d.winStart + span
      nk = { s: k.s, e: Math.min(hi, Math.max(at, k.s + minLen)) }
    } else {
      const len = k.e - k.s
      const lo = prev ? prev.e + GAP : Math.min(d.winStart, k.s)
      const hi = next ? next.s - GAP : Math.max(d.winStart + span, k.e)
      const s = round1(Math.max(lo, Math.min(hi - len, k.s + dsec)))
      nk = { s, e: round1(s + len) }
    }
    d.last = d.cuts.map((c, i) => (i === d.seg ? nk : c))
    onCutsChange(d.last, false)
  }

  const onUp = (e: RPointerEvent): void => {
    const d = drag.current
    drag.current = null
    if (!d) return
    if (d.mode === 'scrub') {
      setScrubbing(false)
      return
    }
    if (!d.moved) {
      if (d.mode === 'move' || d.mode === 'pan') onSeek(secAt(e.clientX))
      return
    }
    if (d.mode === 'pan') onViewChange(d.lastWin, round1(d.lastWin + span), true)
    else onCutsChange(d.last, true)
  }

  const nudge = (seg: number, which: 'in' | 'out', delta: number): void => {
    const k = cuts[seg]!
    const prev = cuts[seg - 1]
    const next = cuts[seg + 1]
    const nk =
      which === 'in'
        ? { s: Math.max(prev ? prev.e + GAP : 0, Math.min(k.s + delta, k.e - minLen)), e: k.e }
        : { s: k.s, e: Math.min(next ? next.s - GAP : duration, Math.max(k.e + delta, k.s + minLen)) }
    onCutsChange(
      cuts.map((c, i) => (i === seg ? nk : c)),
      true
    )
  }

  const removeSeg = (seg: number): void => onCutsChange(cuts.filter((_, i) => i !== seg), true)

  const clampP = (p: number): number => Math.max(0, Math.min(100, p))
  // escurece o que fica fora dos trechos (antes, entre e depois)
  const dims: { l: number; r: number }[] = []
  let edge = 0
  for (const k of cuts) {
    const l = clampP(pct(k.s))
    if (l > edge) dims.push({ l: edge, r: l })
    edge = Math.max(edge, clampP(pct(k.e)))
  }
  if (edge < 100) dims.push({ l: edge, r: 100 })
  const inP = pct(clip.cutIn)
  const outP = pct(clip.cutOut)

  return (
    <div
      ref={ref}
      className={`wave${drag.current?.mode === 'pan' ? ' panning' : ''}`}
      onPointerDown={start(null)}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      title="Arraste um trecho pra mover · arraste fora dele pra andar pela live · clique pra posicionar"
    >
      <div className={`wave-bars${bars ? '' : ' shimmer'}`}>
        {(bars ?? []).map((v, i) => {
          const pos = (i / (BARS - 1)) * 100
          const on = cuts.some((k) => pos >= pct(k.s) && pos <= pct(k.e))
          const tt = on ? (pos - inP) / Math.max(1, outP - inP) : 0
          const color = on ? `rgb(${Math.round(167 - tt * 71)},${Math.round(139 + tt * 26)},250)` : '#353A5E'
          return <span key={i} style={{ height: `${Math.round(6 + level(v) * 42)}px`, background: color }} />
        })}
      </div>
      {dims.map((g, i) => (
        <div key={i} className="wave-dim" style={{ left: `${g.l}%`, width: `${g.r - g.l}%` }} />
      ))}
      {cuts.map((k, i) => {
        const l = pct(k.s)
        const r = pct(k.e)
        const regionL = clampP(l)
        const regionR = clampP(r)
        const n = cuts.length > 1 ? ` ${i + 1}` : ''
        return (
          <div key={i}>
            {regionR > regionL && (
              <div className="wave-region" style={{ left: `${regionL}%`, width: `${regionR - regionL}%` }}>
                {multi && <span className="wave-seg-n mono">{i + 1}</span>}
              </div>
            )}
            {multi && regionR - regionL > 6 && (
              <button
                className="wave-seg-x"
                style={{ left: `calc(${regionR}% - 22px)` }}
                aria-label={`Tirar o trecho ${i + 1}`}
                title="Tirar este trecho"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => removeSeg(i)}
              >
                <Icon name="x" size={11} strokeWidth={2.6} />
              </button>
            )}
            {l >= -1 && l <= 101 && (
              <div
                className="wave-handle in"
                style={{ left: `calc(${l}% - 6px)` }}
                role="slider"
                tabIndex={0}
                aria-label={`Início do trecho${n}`}
                aria-valuemin={0}
                aria-valuemax={duration}
                aria-valuenow={k.s}
                onPointerDown={start('in', i)}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowLeft') nudge(i, 'in', -0.5)
                  if (e.key === 'ArrowRight') nudge(i, 'in', 0.5)
                }}
              >
                <span />
              </div>
            )}
            {r >= -1 && r <= 101 && (
              <div
                className="wave-handle out"
                style={{ left: `calc(${r}% - 6px)` }}
                role="slider"
                tabIndex={0}
                aria-label={`Fim do trecho${n}`}
                aria-valuemin={0}
                aria-valuemax={duration}
                aria-valuenow={k.e}
                onPointerDown={start('out', i)}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowLeft') nudge(i, 'out', -0.5)
                  if (e.key === 'ArrowRight') nudge(i, 'out', 0.5)
                }}
              >
                <span />
              </div>
            )}
          </div>
        )
      })}
      {selected && headP !== null && headP >= 0 && headP <= 100 && (
        <div className={`wave-head${scrubbing ? ' scrubbing' : ''}${headP > 80 ? ' flip' : ''}`} style={{ left: `${headP}%` }}>
          <i onPointerDown={start('scrub')} title="Arraste pra procurar no corte (gruda no início e no fim de cada trecho)" />
          {scrubbing && time !== null && <b className="mono">+{fmtSec(toOut(cuts, time))}</b>}
        </div>
      )}
    </div>
  )
}

/** segundos no vídeo final, com décimo: "3,2s" */
function fmtSec(s: number): string {
  return `${Math.max(0, s).toFixed(1).replace('.', ',')}s`
}

function round1(n: number): number {
  return Math.round(n * 10) / 10
}
