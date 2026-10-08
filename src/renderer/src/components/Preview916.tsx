import { useEffect, useMemo, useRef, type PointerEvent as RPointerEvent } from 'react'
import { HOOK_SECONDS, OUT_W } from '@shared/defaults'
import { captionAnchor, coverCrop, layoutPanes, zoomCrop } from '@shared/geometry'
import { buildCues, stripEmoji } from '@shared/subtitles'
import { fmtDur } from '@shared/time'
import type { Clip, CropLayout, Watermark } from '@shared/types'
import { mediaUrl } from '../api'
import type { Player } from '../lib/player'
import { Icon } from './Icon'

const ZOOM = { lead: 0.25, duration: 1.6, factor: 1.35 }

interface Props {
  clip: Clip | null
  crop: CropLayout
  player: Player
  width: number
  hook?: string | null
  /** momento do punch-in (s na live) ou null */
  zoomAt?: number | null
  watermark: Watermark
  /** permite arrastar/redimensionar a marca d'água */
  onWatermarkChange?: (wm: Watermark, final: boolean) => void
}

/** Preview 9:16: compõe webcam e jogo do preview 360p com a mesma conta de recorte do render. */
export function Preview916({ clip, crop, player, width, hook, zoomAt, watermark, onWatermarkChange }: Props) {
  const height = Math.round((width * 16) / 9)
  const scale = width / OUT_W
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const layout = clip?.layout ?? 'both'
  const split = clip?.camSplit ?? 40
  const t = player.time

  const panes = useMemo(() => layoutPanes(layout, split, width, height), [layout, split, width, height])
  const state = useRef({ panes, crop, zoomAt, layout })
  state.current = { panes, crop, zoomAt, layout }

  // desenha cada frame do vídeo no canvas
  useEffect(() => {
    const v = player.videoRef.current
    const cv = canvasRef.current
    if (!v || !cv) return
    const ctx = cv.getContext('2d')
    if (!ctx) return
    const dpr = window.devicePixelRatio || 1
    cv.width = Math.round(width * dpr)
    cv.height = Math.round(height * dpr)
    let stop = false
    let handle = 0
    const draw = (): void => {
      if (stop) return
      if (v.videoWidth > 0) {
        const s = state.current
        const tSrc = (clip?.previewStart ?? 0) + v.currentTime
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
        ctx.fillStyle = '#000'
        ctx.fillRect(0, 0, width, height)
        const zoomTarget = s.panes.some((p) => p.kind === 'cam') ? 'cam' : 'game'
        const zoomOn = s.zoomAt != null && tSrc >= s.zoomAt - ZOOM.lead && tSrc <= s.zoomAt - ZOOM.lead + ZOOM.duration
        for (const p of s.panes) {
          const rect = p.kind === 'cam' ? s.crop.cam : s.crop.game
          let c = coverCrop(rect, v.videoWidth, v.videoHeight, p.out.w / p.out.h)
          if (zoomOn && p.kind === zoomTarget) c = zoomCrop(c, ZOOM.factor)
          ctx.drawImage(v, c.x, c.y, c.w, c.h, p.out.x, p.out.y, p.out.w, p.out.h)
        }
      }
      handle = 'requestVideoFrameCallback' in v ? v.requestVideoFrameCallback(draw) : requestAnimationFrame(draw)
    }
    const kick = (): void => {
      // pausado: redesenha ao buscar um ponto
      if (!player.playing) {
        stop = false
        draw()
      }
    }
    draw()
    v.addEventListener('seeked', kick)
    v.addEventListener('loadeddata', kick)
    return () => {
      stop = true
      v.removeEventListener('seeked', kick)
      v.removeEventListener('loadeddata', kick)
      if ('cancelVideoFrameCallback' in v) v.cancelVideoFrameCallback(handle)
      cancelAnimationFrame(handle)
    }
  }, [player.videoRef, player.src, player.playing, width, height, clip?.previewStart])

  // redesenha quando muda layout/recorte com o vídeo parado
  useEffect(() => {
    const v = player.videoRef.current
    if (v && !player.playing && v.readyState >= 2) v.dispatchEvent(new Event('seeked'))
  }, [layout, split, crop, player.playing, player.videoRef])

  const cues = useMemo(() => {
    if (!clip) return []
    if (clip.cues) return clip.cues
    return clip.words ? buildCues(clip.words, clip.cutIn, clip.cutOut) : []
  }, [clip])
  const cue = cues.find((c) => t >= c.start && t < c.end)
  const wordIdx = cue ? cue.words.reduce((acc, w, i) => (w.s <= t ? i : acc), 0) : -1

  const showHook = !!hook && !!clip && t - clip.cutIn < HOOK_SECONDS && t >= clip.cutIn - 0.1
  const anchor = captionAnchor(layout, split)
  const dur = clip ? clip.cutOut - clip.cutIn : 0
  const pos = clip ? Math.max(0, Math.min(1, (t - clip.cutIn) / Math.max(0.1, dur))) : 0
  const zoomMark = clip && zoomAt != null ? (zoomAt - clip.cutIn) / Math.max(0.1, dur) : null

  // ---- marca d'água arrastável ----
  const drag = useRef<{ mode: 'move' | 'resize'; sx: number; sy: number; o: Watermark } | null>(null)
  const wmRatio = watermark.imgH / Math.max(1, watermark.imgW)
  const clampWm = (w: Watermark): Watermark => {
    const ww = Math.max(60, Math.min(OUT_W, w.w))
    const hh = ww * wmRatio
    return { ...w, w: Math.round(ww), x: Math.round(Math.max(0, Math.min(OUT_W - ww, w.x))), y: Math.round(Math.max(0, Math.min(1920 - hh, w.y))) }
  }
  const startDrag = (mode: 'move' | 'resize') => (e: RPointerEvent) => {
    if (!onWatermarkChange) return
    e.stopPropagation()
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    drag.current = { mode, sx: e.clientX, sy: e.clientY, o: watermark }
  }
  const onMove = (e: RPointerEvent): void => {
    const d = drag.current
    if (!d || !onWatermarkChange) return
    const dx = (e.clientX - d.sx) / scale
    const dy = (e.clientY - d.sy) / scale
    onWatermarkChange(clampWm(d.mode === 'move' ? { ...d.o, x: d.o.x + dx, y: d.o.y + dy } : { ...d.o, w: d.o.w + dx }), false)
  }
  const onUp = (): void => {
    if (drag.current && onWatermarkChange) onWatermarkChange(watermark, true)
    drag.current = null
  }

  const wmUrl = mediaUrl(watermark.path)
  const hasVideo = !!player.src

  return (
    <div
      className="p916"
      style={{ width, height }}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
    >
      <video ref={player.videoRef} src={player.src ?? undefined} preload="auto" playsInline className="p916-video" />
      {hasVideo ? (
        <canvas ref={canvasRef} className="p916-canvas" style={{ width, height }} onClick={player.toggle} />
      ) : (
        <div className="p916-placeholder" onClick={player.toggle}>
          {panes.map((p) => (
            <div
              key={p.kind}
              className={`p916-pane ${p.kind}`}
              style={{ top: p.out.y, height: p.out.h }}
            >
              <Icon name={p.kind === 'cam' ? 'user' : 'crosshair'} size={48} strokeWidth={1.4} />
              <span>{p.kind === 'cam' ? 'WEBCAM' : 'GAMEPLAY'}</span>
            </div>
          ))}
          {clip && (
            <div className="p916-wait">
              <span className="spinner" /> Gerando preview…
            </div>
          )}
        </div>
      )}

      {showHook && (
        <div className="p916-hook" style={{ top: (130 / 1920) * height, fontSize: (60 / 1920) * height, padding: `${22 * scale}px ${26 * scale}px` }}>
          {stripEmoji(hook!).toLocaleUpperCase('pt-BR')}
        </div>
      )}

      {cue && (
        <div
          className="p916-caption"
          style={{
            top: ((anchor * 1920 + 40) / 1920) * height,
            fontSize: (84 / 1920) * height,
            WebkitTextStroke: `${Math.max(2, 14 * scale)}px #000`
          }}
        >
          {cue.words.map((w, i) => (
            <span key={i} className={i === wordIdx ? 'hl' : undefined}>
              {stripEmoji(w.w).toLocaleUpperCase('pt-BR')}{' '}
            </span>
          ))}
        </div>
      )}

      {watermark.enabled && (
        <div
          className={`p916-wm${onWatermarkChange ? ' editable' : ''}`}
          style={{
            left: watermark.x * scale,
            top: watermark.y * scale,
            width: watermark.w * scale,
            height: watermark.w * wmRatio * scale
          }}
          onPointerDown={startDrag('move')}
        >
          {wmUrl ? (
            <img src={wmUrl} alt="" draggable={false} style={{ opacity: watermark.opacity }} />
          ) : (
            <div className="p916-wm-ph" style={{ opacity: watermark.opacity, fontSize: Math.max(7, watermark.w * wmRatio * scale * 0.42) }}>
              <Icon name="at" size={Math.max(8, watermark.w * wmRatio * scale * 0.46)} strokeWidth={2.4} />
              SUA_ARROBA
            </div>
          )}
          {onWatermarkChange && (
            <>
              <span className="wm-corner tl" />
              <span className="wm-corner tr" />
              <span className="wm-corner bl" />
              <span className="wm-resize" aria-label="Redimensionar" onPointerDown={startDrag('resize')} />
            </>
          )}
        </div>
      )}

      <div className="p916-bar">
        <div className="progress">
          <span style={{ width: `${pos * 100}%` }} />
          {zoomMark !== null && zoomMark >= 0 && zoomMark <= 1 && <i className="zoom-mark" style={{ left: `${zoomMark * 100}%` }} />}
        </div>
        <div className="p916-times mono">
          <span>{fmtDur(Math.max(0, t - (clip?.cutIn ?? 0)))}</span>
          <span>{fmtDur(dur)}</span>
        </div>
      </div>
    </div>
  )
}
