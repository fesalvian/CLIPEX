import { useEffect, useRef, useState, type PointerEvent as RPointerEvent } from 'react'
import { clampRect } from '@shared/geometry'
import type { CropLayout, Project, Rect } from '@shared/types'
import { mediaUrl } from '../api'

interface Props {
  project: Project
  showCam: boolean
  showGame: boolean
  onCommit: (crop: CropLayout) => void
}

type Kind = 'cam' | 'game'

/** Frame 16:9 da live com os dois retângulos: laranja = webcam, ciano = jogo. */
export function CropEditor({ project, showCam, showGame, onCommit }: Props) {
  const [crop, setCrop] = useState<CropLayout>(project.crop)
  const ref = useRef<HTMLDivElement | null>(null)
  const drag = useRef<{ kind: Kind; mode: 'move' | 'resize'; sx: number; sy: number; o: Rect } | null>(null)

  useEffect(() => {
    if (!drag.current) setCrop(project.crop)
  }, [project.crop])

  const start = (kind: Kind, mode: 'move' | 'resize') => (e: RPointerEvent) => {
    e.stopPropagation()
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    drag.current = { kind, mode, sx: e.clientX, sy: e.clientY, o: crop[kind] }
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
    setCrop((c) => ({ ...c, [d.kind]: next }))
  }
  const onUp = (): void => {
    if (drag.current) onCommit(crop)
    drag.current = null
  }

  const style = (r: Rect): React.CSSProperties => ({
    left: `${r.x * 100}%`,
    top: `${r.y * 100}%`,
    width: `${r.w * 100}%`,
    height: `${r.h * 100}%`
  })
  const frame = mediaUrl(project.framePath, project.framePath ? 1 : undefined)
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
        {frame ? <img src={frame} alt="Frame da live" draggable={false} /> : <div className="crop-grid" />}
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
