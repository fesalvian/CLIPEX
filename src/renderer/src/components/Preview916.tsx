import { useEffect, useMemo, useRef, type PointerEvent as RPointerEvent } from 'react'
import { OUT_W } from '@shared/defaults'
import { faceXAt } from '@shared/faces'
import { coverCrop, fitBox, layoutPanes, zoomCrop } from '@shared/geometry'
import { cutsDuration, cutsOf, toOut } from '@shared/cuts'
import { applyDictionary, buildCuesInCuts } from '@shared/subtitles'
import { fmtDur } from '@shared/time'
import type { CaptionStyle, Clip, CropLayout, DictEntry, HookStyle, SubtitleCue, Watermark } from '@shared/types'
import { mediaUrl } from '../api'
import type { Player } from '../lib/player'
import { Icon } from './Icon'
import { TextLayer, type TextKind, type TextPatch } from './TextLayer'
import { watermarkBox } from '@shared/text'
import { capturePointer } from '../lib/pointer'

const ZOOM = { lead: 0.25, duration: 1.6, factor: 1.35 }

const SAMPLE_CUE: SubtitleCue = {
  id: 'sample',
  start: 0,
  end: 1,
  words: [
    { w: 'sua', s: 0, e: 0.3 },
    { w: 'legenda', s: 0.3, e: 0.6 },
    { w: 'aqui', s: 0.6, e: 1 }
  ]
}

interface Props {
  clip: Clip | null
  crop: CropLayout
  player: Player
  width: number
  captionStyle: CaptionStyle & { y: number }
  hookStyle: HookStyle & { y: number }
  hookText: string | null
  dictionary: DictEntry[]
  /** momento do punch-in (s na live) ou null */
  zoomAt?: number | null
  watermark: Watermark
  /** permite arrastar/redimensionar a marca d'água */
  onWatermarkChange?: (wm: Watermark, final: boolean) => void
  /** permite arrastar e redimensionar a legenda e o gancho (com o vídeo pausado) */
  onTextChange?: (kind: TextKind, patch: TextPatch, final: boolean) => void
}

/** Preview 9:16: compõe webcam e jogo do vídeo leve com a mesma conta de recorte do render. */
export function Preview916(props: Props) {
  const { clip, crop, player, width, captionStyle, hookStyle, hookText, dictionary, zoomAt, watermark, onWatermarkChange, onTextChange } = props
  const height = Math.round((width * 16) / 9)
  const scale = width / OUT_W
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const layout = clip?.layout ?? 'both'
  const split = clip?.camSplit ?? 40
  const t = player.time

  const panes = useMemo(() => layoutPanes(layout, split, width, height), [layout, split, width, height])
  const faces = clip?.faces ?? null
  const state = useRef({ panes, crop, zoomAt, offset: player.offset, layout, faces })
  state.current = { panes, crop, zoomAt, offset: player.offset, layout, faces }

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
        const tSrc = s.offset + v.currentTime
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
        ctx.fillStyle = '#000'
        ctx.fillRect(0, 0, width, height)
        const zoomTarget = s.panes.some((p) => p.kind === 'cam') ? 'cam' : 'game'
        const zoomOn = s.zoomAt != null && tSrc >= s.zoomAt - ZOOM.lead && tSrc <= s.zoomAt - ZOOM.lead + ZOOM.duration
        const vw = v.videoWidth
        const vh = v.videoHeight
        if (s.layout === 'fit') {
          // vídeo inteiro: fundo ampliado e desfocado, quadro no meio (mesma conta do render)
          const bg = coverCrop({ x: 0, y: 0, w: 1, h: 1 }, vw, vh, width / height)
          ctx.save()
          ctx.filter = 'blur(12px) brightness(0.8)'
          ctx.drawImage(v, bg.x, bg.y, bg.w, bg.h, -12, -12, width + 24, height + 24)
          ctx.restore()
          const box = fitBox(vw, vh, width, height)
          let c = { x: 0, y: 0, w: vw, h: vh }
          if (zoomOn) c = zoomCrop(c, ZOOM.factor)
          ctx.drawImage(v, c.x, c.y, c.w, c.h, box.x, box.y, box.w, box.h)
        } else if (s.layout === 'face') {
          // seguir quem fala: recorte 9:16 na altura toda, centrado no plano do momento
          const cw = Math.min(vw, (vh * 9) / 16)
          const cx = Math.max(0, Math.min(vw - cw, faceXAt(s.faces, tSrc) * vw - cw / 2))
          let c = { x: cx, y: 0, w: cw, h: vh }
          if (zoomOn) c = zoomCrop(c, ZOOM.factor)
          ctx.drawImage(v, c.x, c.y, c.w, c.h, 0, 0, width, height)
        } else {
          for (const p of s.panes) {
            const rect = p.kind === 'cam' ? s.crop.cam : s.crop.game
            let c = coverCrop(rect, vw, vh, p.out.w / p.out.h)
            if (zoomOn && p.kind === zoomTarget) c = zoomCrop(c, ZOOM.factor)
            ctx.drawImage(v, c.x, c.y, c.w, c.h, p.out.x, p.out.y, p.out.w, p.out.h)
          }
        }
      }
      handle = 'requestVideoFrameCallback' in v ? v.requestVideoFrameCallback(draw) : requestAnimationFrame(draw)
    }
    const kick = (): void => {
      // pausado: redesenha ao buscar um ponto
      if (!player.playing) draw()
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
  }, [player.videoRef, player.src, player.playing, width, height])

  // redesenha quando muda layout/recorte com o vídeo parado
  useEffect(() => {
    const v = player.videoRef.current
    if (v && !player.playing && v.readyState >= 2) v.dispatchEvent(new Event('seeked'))
  }, [layout, split, crop, faces, player.playing, player.videoRef])

  const cues = useMemo(() => {
    if (!clip) return []
    if (clip.cues) return clip.cues
    return clip.words ? applyDictionary(buildCuesInCuts(clip.words, cutsOf(clip)), dictionary) : []
  }, [clip, dictionary])
  const cue = cues.find((c) => t >= c.start && t < c.end) ?? null
  const sampleCue = cues[0] ?? SAMPLE_CUE
  const editing = !!onTextChange && !player.playing

  // tempo no vídeo final: os trechos colados, sem o que fica entre eles
  const cuts = clip ? cutsOf(clip) : []
  const dur = cutsDuration(cuts)
  const elapsed = clip ? toOut(cuts, t) : 0
  const pos = clip ? Math.max(0, Math.min(1, elapsed / Math.max(0.1, dur))) : 0
  const zoomMark = clip && zoomAt != null ? toOut(cuts, zoomAt) / Math.max(0.1, dur) : null
  // onde um trecho emenda no outro (marcas na barra)
  const joins = cuts.slice(1).map((k) => toOut(cuts, k.s) / Math.max(0.1, dur))

  // ---- marca d'água/logo arrastável ----
  // no modo "acima da legenda": arrastar muda o espaço até a legenda e o deslocamento lateral
  const drag = useRef<{ mode: 'move' | 'resize'; sx: number; sy: number; o: Watermark; last: Watermark } | null>(null)
  const wmRatio = watermark.imgH / Math.max(1, watermark.imgW)
  const wmBox = watermarkBox(watermark, captionStyle)
  const clampWm = (w: Watermark): Watermark => {
    const ww = Math.round(Math.max(60, Math.min(OUT_W, w.w)))
    if (w.anchor === 'caption') {
      return { ...w, w: ww, gap: Math.round(Math.max(0, Math.min(1200, w.gap))), offsetX: Math.round(Math.max(-OUT_W / 2, Math.min(OUT_W / 2, w.offsetX))) }
    }
    const hh = ww * wmRatio
    return { ...w, w: ww, x: Math.round(Math.max(0, Math.min(OUT_W - ww, w.x))), y: Math.round(Math.max(0, Math.min(1920 - hh, w.y))) }
  }
  const startDrag = (mode: 'move' | 'resize') => (e: RPointerEvent) => {
    if (!onWatermarkChange) return
    e.stopPropagation()
    capturePointer(e)
    drag.current = { mode, sx: e.clientX, sy: e.clientY, o: watermark, last: watermark }
  }
  const onMove = (e: RPointerEvent): void => {
    const d = drag.current
    if (!d || !onWatermarkChange) return
    const dx = (e.clientX - d.sx) / scale
    const dy = (e.clientY - d.sy) / scale
    let next: Watermark
    if (d.mode === 'resize') next = { ...d.o, w: d.o.w + dx }
    else if (d.o.anchor === 'caption') {
      // subir aumenta o espaço até a legenda; não dá pra descer por cima dela (gap >= 0)
      let off = d.o.offsetX + dx
      if (Math.abs(off) < 14) off = 0
      next = { ...d.o, offsetX: off, gap: d.o.gap - dy }
    } else next = { ...d.o, x: d.o.x + dx, y: d.o.y + dy }
    d.last = clampWm(next)
    onWatermarkChange(d.last, false)
  }
  const onUp = (): void => {
    if (drag.current && onWatermarkChange) onWatermarkChange(drag.current.last, true)
    drag.current = null
  }

  const wmUrl = mediaUrl(watermark.path)
  const hasVideo = !!player.src

  return (
    <div className="p916" style={{ width, height }} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
      <video ref={player.videoRef} src={player.src ?? undefined} preload="auto" playsInline className="p916-video" />
      {hasVideo ? (
        <canvas ref={canvasRef} className="p916-canvas" style={{ width, height }} onClick={player.toggle} />
      ) : (
        <div className="p916-placeholder" onClick={player.toggle}>
          {panes.map((p) => (
            <div key={p.kind} className={`p916-pane ${p.kind}`} style={{ top: p.out.y, height: p.out.h }}>
              <Icon name={p.kind === 'cam' || layout === 'face' ? 'user' : 'crosshair'} size={48} strokeWidth={1.4} />
              <span>{p.kind === 'cam' ? 'WEBCAM' : layout === 'face' ? 'QUEM FALA' : layout === 'fit' ? 'VÍDEO INTEIRO' : 'GAMEPLAY'}</span>
            </div>
          ))}
        </div>
      )}
      {clip && player.loadingPreview && (
        <div className="p916-wait">
          <span className="spinner" /> {hasVideo ? 'Atualizando preview…' : 'Gerando preview…'}
        </div>
      )}

      <TextLayer
        width={width}
        caption={captionStyle}
        hook={hookStyle}
        hookText={hookText}
        cue={cue}
        sampleCue={sampleCue}
        t={t}
        elapsed={elapsed}
        editing={editing}
        onChange={onTextChange}
      />

      {watermark.enabled && (
        <div
          className={`p916-wm${onWatermarkChange ? ' editable' : ''}`}
          style={{
            left: wmBox.x * scale,
            top: wmBox.y * scale,
            width: wmBox.w * scale,
            height: wmBox.h * scale
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
          {joins.map((j, i) => (
            <i key={i} className="join-mark" style={{ left: `${j * 100}%` }} />
          ))}
          {zoomMark !== null && zoomMark >= 0 && zoomMark <= 1 && <i className="zoom-mark" style={{ left: `${zoomMark * 100}%` }} />}
        </div>
        <div className="p916-times mono">
          <span>{fmtDur(elapsed)}</span>
          <span>{fmtDur(dur)}</span>
        </div>
      </div>
    </div>
  )
}
