import { useEffect, useRef, useState, type PointerEvent as RPointerEvent } from 'react'
import { clampRect } from '@shared/geometry'
import type { CropLayout, Project, Rect } from '@shared/types'
import { mediaUrl } from '../api'
import type { Player } from '../lib/player'
import { capturePointer } from '../lib/pointer'

interface Props {
  project: Project
  /** recorte mostrado (o do corte selecionado, ou o padrão do projeto) */
  crop: CropLayout
  /** player do preview: o editor mostra o mesmo quadro (pausado ou tocando) */
  player: Player
  showCam: boolean
  showGame: boolean
  onCommit: (crop: CropLayout) => void
}

type Kind = 'cam' | 'game'

/** Frame 16:9 da live com os dois retângulos: laranja = webcam, ciano = jogo. */
export function CropEditor({ project, crop: shown, player, showCam, showGame, onCommit }: Props) {
  const [crop, setCrop] = useState<CropLayout>(shown)
  const ref = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [hasFrame, setHasFrame] = useState(false)
  const drag = useRef<{ kind: Kind; mode: 'move' | 'resize'; sx: number; sy: number; o: Rect; last: CropLayout } | null>(null)

  useEffect(() => {
    if (!drag.current) setCrop(shown)
  }, [shown])

  // Quadro inteiro do vídeo que está no preview, no mesmo instante (antes ficava uma foto
  // tirada de outro ponto da live, que não batia com o preview).
  useEffect(() => {
    const v = player.videoRef.current
    const cv = canvasRef.current
    if (!v || !cv) return
    const ctx = cv.getContext('2d')
    if (!ctx) return
    let stop = false
    let shown = false
    let handle = 0
    const draw = (): void => {
      if (stop) return
      if (v.videoWidth > 0 && v.readyState >= 2) {
        if (cv.width !== v.videoWidth || cv.height !== v.videoHeight) {
          cv.width = v.videoWidth
          cv.height = v.videoHeight
        }
        ctx.drawImage(v, 0, 0)
        if (!shown) {
          shown = true
          setHasFrame(true)
        }
      }
      handle = 'requestVideoFrameCallback' in v ? v.requestVideoFrameCallback(draw) : requestAnimationFrame(draw)
    }
    const kick = (): void => {
      if (!player.playing) draw()
    }
    setHasFrame(false)
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
  }, [player.videoRef, player.src, player.playing])

  const start = (kind: Kind, mode: 'move' | 'resize') => (e: RPointerEvent) => {
    e.stopPropagation()
    capturePointer(e)
    drag.current = { kind, mode, sx: e.clientX, sy: e.clientY, o: crop[kind], last: crop }
  }
  const onMove = (e: RPointerEvent): void => {
    const d = drag.current
    if (!d || !ref.current) return
    const r = ref.current.getBoundingClientRect()
    const dx = (e.clientX - d.sx) / r.width
    const dy = (e.clientY - d.sy) / r.height
    const next =
      d.mode === 'move'
        ? clampRect({ ...d.o, x: d.o.x + dx, y: d.o.y + dy })
        : clampRect({ ...d.o, w: Math.min(1 - d.o.x, d.o.w + dx), h: Math.min(1 - d.o.y, d.o.h + dy) })
    d.last = { ...d.last, [d.kind]: next }
    setCrop(d.last)
  }
  const onUp = (): void => {
    if (drag.current) onCommit(drag.current.last)
    drag.current = null
  }

  const style = (r: Rect): React.CSSProperties => ({
    left: `${r.x * 100}%`,
    top: `${r.y * 100}%`,
    width: `${r.w * 100}%`,
    height: `${r.h * 100}%`
  })
  const still = mediaUrl(project.framePath, project.framePath ? 1 : undefined)
  const res = project.source ? `${project.source.width}×${project.source.height}` : '1920×1080'

  return (
    <>
      <div className="panel-head">
        <span className="panel-title" style={{ fontSize: 14 }}>
          Recorte na tela da live
        </span>
        <span className="mono" style={{ fontSize: 11, color: 'var(--muted-2)' }}>
          {res}
        </span>
      </div>
      <div ref={ref} className="crop-frame" onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
        {!hasFrame && (still ? <img src={still} alt="Frame da live" draggable={false} /> : <div className="crop-grid" />)}
        <canvas ref={canvasRef} className="crop-canvas" style={{ opacity: hasFrame ? 0.8 : 0 }} />
        <div className={`crop-rect game${showGame ? '' : ' off'}`} style={style(crop.game)} onPointerDown={start('game', 'move')}>
          <span className="crop-label">JOGO</span>
          <span className="crop-handle" aria-label="Redimensionar jogo" onPointerDown={start('game', 'resize')} />
        </div>
        <div className={`crop-rect cam${showCam ? '' : ' off'}`} style={style(crop.cam)} onPointerDown={start('cam', 'move')}>
          <span className="crop-label">CAM</span>
          <span className="crop-handle" aria-label="Redimensionar webcam" onPointerDown={start('cam', 'resize')} />
        </div>
      </div>
    </>
  )
}
