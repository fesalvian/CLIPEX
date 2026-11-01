import { useCallback, useEffect, useRef, useState } from 'react'
import { MANUAL_CUT_SEC } from '@shared/defaults'
import { fmtClock } from '@shared/time'
import type { Clip, Project } from '@shared/types'
import { call, errorText, mediaUrl } from '../api'
import { clipList, useStore } from '../store'
import { Icon, PauseIcon, PlayIcon } from './Icon'
import { Modal } from './Modal'

interface Props {
  project: Project
  onClose: () => void
  onCreated: (c: Clip) => void
}

/** Janelas de zoom da linha do tempo detalhada (s); a última é a live inteira. */
const SPANS = [20, 60, 120, 300, 600, 1800, 3600]
const TICK_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600]
const DETAIL_BUCKETS = 300

function parseClock(s: string): number | null {
  const parts = s.trim().split(':').map(Number)
  if (parts.length === 0 || parts.some((n) => !Number.isFinite(n))) return null
  return parts.reduce((acc, n) => acc * 60 + n, 0)
}

/** 4716.4 → "01:18:36.4" */
function fmtPrecise(sec: number): string {
  return `${fmtClock(sec)}.${Math.floor((Math.max(0, sec) % 1) * 10)}`
}

function fmtSpan(sec: number): string {
  return sec < 60 ? `${sec} s` : sec < 3600 ? `${Math.round(sec / 60)} min` : `${Math.round(sec / 360) / 10} h`
}

/**
 * Escolhe o ponto exato onde o corte começa: preview da live nesse ponto (com som), linha do
 * tempo da live inteira e uma detalhada com zoom, pino arrastável e ajuste fino pelo teclado.
 */
export function ManualClipModal({ project, onClose, onCreated }: Props) {
  const duration = project.source?.durationSec ?? 0
  const clips = clipList(useStore((s) => s.clips))
  const upsertClip = useStore((s) => s.upsertClip)
  const toast = useStore((s) => s.toast)
  const [overview, setOverview] = useState<number[]>([])
  const [detail, setDetail] = useState<number[]>([])
  const [at, setAtState] = useState(duration / 2)
  const [text, setText] = useState(fmtPrecise(duration / 2))
  const [span, setSpan] = useState(Math.min(300, duration))
  const [viewFrom, setViewFrom] = useState(Math.max(0, duration / 2 - 150))
  const [playing, setPlaying] = useState(false)
  const [busy, setBusy] = useState(false)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const detailRef = useRef<HTMLDivElement | null>(null)
  const viewSpan = Math.min(span, duration)
  const viewTo = viewFrom + viewSpan
  const src = mediaUrl(project.proxyPath)

  const clampView = useCallback((from: number, s: number) => Math.max(0, Math.min(duration - Math.min(s, duration), from)), [duration])

  /** Move o pino (e o vídeo); a janela detalhada acompanha se o pino sair dela. */
  const setAt = useCallback(
    (t: number, opts: { seekVideo?: boolean } = {}) => {
      const v = Math.max(0, Math.min(duration, t))
      setAtState(v)
      setText(fmtPrecise(v))
      setViewFrom((from) => (v < from || v > from + viewSpan ? clampView(v - viewSpan / 2, viewSpan) : from))
      const video = videoRef.current
      if (opts.seekVideo !== false && video) video.currentTime = v
    },
    [duration, viewSpan, clampView]
  )

  useEffect(() => {
    void call('clips:loudness', project.id, 0, duration, 360).then((r) => setOverview(r.values))
  }, [project.id, duration])

  // linha detalhada: busca de novo quando a janela muda (com um respiro pra não pedir a cada pixel)
  useEffect(() => {
    const id = setTimeout(() => {
      void call('clips:loudness', project.id, viewFrom, viewTo, DETAIL_BUCKETS).then((r) => setDetail(r.values))
    }, 60)
    return () => clearTimeout(id)
  }, [project.id, viewFrom, viewTo])

  // tocando: o pino segue o vídeo, e o corte é criado onde você parar
  useEffect(() => {
    if (!playing) return
    let raf = 0
    const loop = (): void => {
      const v = videoRef.current
      if (v) setAt(v.currentTime, { seekVideo: false })
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [playing, setAt])

  const togglePlay = useCallback((): void => {
    const v = videoRef.current
    if (!v) return
    if (v.paused) void v.play().then(() => setPlaying(true), () => setPlaying(false))
    else {
      v.pause()
      setPlaying(false)
    }
  }, [])

  const pause = (): void => {
    videoRef.current?.pause()
    setPlaying(false)
  }

  const zoomTo = useCallback(
    (nextSpan: number, anchor: number) => {
      const s = Math.min(nextSpan, duration)
      // o ponto embaixo do mouse (ou o pino) fica no mesmo lugar da tela
      const frac = viewSpan > 0 ? (anchor - viewFrom) / viewSpan : 0.5
      setSpan(s)
      setViewFrom(clampView(anchor - frac * s, s))
    },
    [duration, viewSpan, viewFrom, clampView]
  )

  const zoomStep = (dir: 1 | -1, anchor = at): void => {
    const i = SPANS.findIndex((s) => s >= viewSpan - 0.5)
    const cur = i === -1 ? SPANS.length : i
    const next = dir === 1 ? (cur > 0 ? SPANS[cur - 1]! : SPANS[0]!) : cur < SPANS.length - 1 ? SPANS[cur + 1]! : duration
    zoomTo(next, anchor)
  }

  // teclado: espaço toca/pausa, setas ajustam (Shift = 5 s, Alt = 0,1 s)
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.target as HTMLElement | null)?.tagName === 'INPUT') return
      if (e.key === ' ') {
        e.preventDefault()
        togglePlay()
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault()
        pause()
        const step = e.shiftKey ? 5 : e.altKey ? 0.1 : 1
        setAt(at + (e.key === 'ArrowRight' ? step : -step))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [at, setAt, togglePlay])

  const timeAt = (el: HTMLDivElement, clientX: number, from: number, len: number): number => {
    const r = el.getBoundingClientRect()
    return from + Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * len
  }

  /** Arrastar na linha (ou no pino) move o pino junto, com o vídeo mostrando o quadro. */
  const dragOn = (from: number, len: number) => (e: React.PointerEvent<HTMLDivElement>) => {
    const el = e.currentTarget
    if (e.button !== 0) return
    pause()
    el.setPointerCapture(e.pointerId)
    setAt(timeAt(el, e.clientX, from, len))
    const move = (ev: PointerEvent): void => setAt(timeAt(el, ev.clientX, from, len))
    const up = (): void => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
  }

  const onDetailWheel = (e: React.WheelEvent): void => {
    if (!detailRef.current) return
    if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      // Shift + rodinha (ou arrastar de lado no touchpad): anda pela live
      const d = (e.deltaX || e.deltaY) > 0 ? 1 : -1
      setViewFrom((f) => clampView(f + d * viewSpan * 0.15, viewSpan))
      return
    }
    zoomStep(e.deltaY < 0 ? 1 : -1, timeAt(detailRef.current, e.clientX, viewFrom, viewSpan))
  }

  const create = async (): Promise<void> => {
    pause()
    setBusy(true)
    try {
      const c = await call('clips:create-manual', project.id, at)
      upsertClip(c)
      onCreated(c)
      toast('success', 'Corte manual criado. Transcrição e preview a caminho.')
    } catch (e) {
      toast('error', errorText(e))
    } finally {
      setBusy(false)
    }
  }

  const step = TICK_STEPS.find((s) => viewSpan / s <= 8) ?? 3600
  const ticks: number[] = []
  for (let t = Math.ceil(viewFrom / step) * step; t <= viewTo; t += step) ticks.push(t)
  const pct = (t: number, from: number, len: number): string => `${((t - from) / Math.max(0.001, len)) * 100}%`
  /** largura de um trecho [a, b] dentro da janela detalhada */
  const widthIn = (a: number, b: number): string => `${(Math.max(0, Math.min(viewTo, b) - Math.max(viewFrom, a)) / Math.max(0.001, viewSpan)) * 100}%`

  return (
    <Modal
      title="Adicionar corte manual"
      onClose={onClose}
      wide
      actions={
        <>
          <button className="btn" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn primary" disabled={busy} onClick={() => void create()}>
            Criar corte em {fmtPrecise(at)}
          </button>
        </>
      }
    >
      <span className="hint">
        O corte começa exatamente no pino e vai {MANUAL_CUT_SEC} s pra frente (dá pra ajustar nas alças depois). Toque o vídeo e pause no
        momento certo, ou arraste o pino.
      </span>

      <div className="manual-preview">
        {src ? (
          <video
            ref={videoRef}
            src={src}
            preload="auto"
            onLoadedMetadata={(e) => {
              e.currentTarget.currentTime = at
            }}
            onPause={() => setPlaying(false)}
            onClick={togglePlay}
          />
        ) : (
          <span className="hint">O preview da live (proxy 360p) ainda não foi gerado.</span>
        )}
      </div>

      <div className="manual-controls">
        <button className="btn sm" onClick={() => setAt(at - 5)} title="5 s pra trás (Shift + ←)">
          −5 s
        </button>
        <button className="btn sm" onClick={() => setAt(at - 1)} title="1 s pra trás (←)">
          −1 s
        </button>
        <button className="btn primary manual-play" disabled={!src} onClick={togglePlay} aria-label={playing ? 'Pausar' : 'Tocar'}>
          {playing ? <PauseIcon size={22} color="#FFFFFF" /> : <PlayIcon size={22} color="#FFFFFF" />}
        </button>
        <button className="btn sm" onClick={() => setAt(at + 1)} title="1 s pra frente (→)">
          +1 s
        </button>
        <button className="btn sm" onClick={() => setAt(at + 5)} title="5 s pra frente (Shift + →)">
          +5 s
        </button>
        <input
          className="input mono manual-time"
          aria-label="Horário na live"
          value={text}
          onFocus={pause}
          onChange={(e) => {
            setText(e.target.value)
            const t = parseClock(e.target.value)
            if (t !== null) {
              const v = Math.max(0, Math.min(duration, t))
              setAtState(v)
              setViewFrom((from) => (v < from || v > from + viewSpan ? clampView(v - viewSpan / 2, viewSpan) : from))
              if (videoRef.current) videoRef.current.currentTime = v
            }
          }}
        />
      </div>

      {/* live inteira: a faixa clara é o trecho aberto embaixo */}
      <div className="overview manual-overview" onPointerDown={dragOn(0, duration)}>
        <div className="overview-bars">
          {overview.map((v, i) => (
            <span key={i} style={{ height: `${Math.round(3 + v * 30)}px` }} />
          ))}
        </div>
        <div className="manual-viewport" style={{ left: pct(viewFrom, 0, duration), width: pct(viewSpan, 0, duration) }} />
        {clips.map((c) => (
          <i key={c.id} className="overview-clip" style={{ left: pct(c.peakSec, 0, duration) }} title={fmtClock(c.peakSec)} />
        ))}
        <div className="overview-cursor" style={{ left: pct(at, 0, duration) }} />
      </div>

      {/* trecho com zoom: rodinha aproxima/afasta, Shift + rodinha anda pela live */}
      <div ref={detailRef} className="overview manual-detail" onPointerDown={dragOn(viewFrom, viewSpan)} onWheel={onDetailWheel}>
        <div className="overview-bars">
          {detail.map((v, i) => (
            <span key={i} style={{ height: `${Math.round(4 + v * 80)}px` }} />
          ))}
        </div>
        {ticks.map((t) => (
          <span key={t} className="manual-tick" style={{ left: pct(t, viewFrom, viewSpan) }}>
            {fmtClock(t)}
          </span>
        ))}
        {clips
          .filter((c) => c.cutOut >= viewFrom && c.cutIn <= viewTo)
          .map((c) => (
            <i
              key={c.id}
              className="manual-existing"
              style={{ left: pct(Math.max(viewFrom, c.cutIn), viewFrom, viewSpan), width: widthIn(c.cutIn, c.cutOut) }}
              title={`Corte ${c.number}: ${fmtClock(c.cutIn)} → ${fmtClock(c.cutOut)}`}
            />
          ))}
        <div
          className="manual-new"
          style={{ left: pct(at, viewFrom, viewSpan), width: widthIn(at, Math.min(duration, at + MANUAL_CUT_SEC)) }}
        />
        <div className="overview-cursor manual-pin" style={{ left: pct(at, viewFrom, viewSpan) }} />
      </div>

      <div className="manual-zoom">
        <span className="mono muted">
          {fmtClock(viewFrom)} – {fmtClock(viewTo)} · mostrando {fmtSpan(Math.round(viewSpan))}
        </span>
        <span style={{ flexGrow: 1 }} />
        <span className="muted" style={{ fontSize: 12 }}>
          Espaço toca · ← → 1 s · Shift 5 s · Alt 0,1 s
        </span>
        <button className="btn sm" onClick={() => zoomStep(-1)} aria-label="Afastar" title="Afastar (rodinha pra trás)">
          <Icon name="zoomOut" size={15} />
        </button>
        <button className="btn sm" onClick={() => zoomStep(1)} aria-label="Aproximar" title="Aproximar (rodinha pra frente)">
          <Icon name="zoomIn" size={15} />
        </button>
      </div>
    </Modal>
  )
}
