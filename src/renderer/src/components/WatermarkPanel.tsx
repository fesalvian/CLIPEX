import { OUT_H, OUT_W } from '@shared/defaults'
import type { Watermark } from '@shared/types'
import { call, errorText, mediaUrl } from '../api'
import { useStore } from '../store'
import { Icon } from './Icon'

interface Props {
  watermark: Watermark
  approvedCount: number
  onChange: (wm: Watermark) => void
  onApplyAll: () => void
}

const OPACITIES = [0.5, 0.8, 1]

export function WatermarkPanel({ watermark: wm, approvedCount, onChange, onApplyAll }: Props) {
  const toast = useStore((s) => s.toast)
  const ratio = wm.imgH / Math.max(1, wm.imgW)
  const fileName = wm.path ? (wm.path.split(/[\\/]/).pop() ?? '') : null

  const pick = async (): Promise<void> => {
    try {
      const next = await call('watermark:pick')
      if (next) onChange(next)
    } catch (e) {
      toast('error', errorText(e))
    }
  }

  const clamp = (w: Watermark): Watermark => {
    const ww = Math.max(60, Math.min(OUT_W, w.w))
    return { ...w, w: ww, x: Math.max(0, Math.min(OUT_W - ww, w.x)), y: Math.max(0, Math.min(OUT_H - ww * ratio, w.y)) }
  }

  const thumb = mediaUrl(wm.path)
  return (
    <div className="panel">
      <div className="panel-head">
        <span className="panel-title" style={{ fontSize: 14 }}>
          Marca d'água (sua @)
        </span>
        <label className="check">
          <input type="checkbox" checked={wm.enabled} onChange={() => onChange({ ...wm, enabled: !wm.enabled })} />
          Ativa
        </label>
      </div>

      <div className="wm-file">
        <div className="wm-thumb">{thumb ? <img src={thumb} alt="" /> : <span>PNG</span>}</div>
        <div className="wm-meta">
          <span className="mono" style={{ fontSize: 12, color: 'var(--text-2)' }}>
            {fileName ?? 'Nenhum PNG escolhido'}
          </span>
          <span style={{ fontSize: 12, color: 'var(--muted-2)' }}>
            {wm.path ? `fundo transparente · ${wm.imgW}×${wm.imgH}` : 'Use um PNG com fundo transparente'}
          </span>
        </div>
        <button className="btn sm" onClick={() => void pick()}>
          {wm.path ? 'Trocar' : 'Escolher'}
        </button>
      </div>

      <div className="callout">
        <Icon name="move" color="#C4B5FD" />
        <span>Arraste a imagem no preview pra mover. Puxe o canto roxo pra redimensionar, mantendo a proporção do PNG.</span>
      </div>

      <div className="wm-nums mono">
        <div>
          <span>X</span>
          {Math.round(wm.x)}px
        </div>
        <div>
          <span>Y</span>
          {Math.round(wm.y)}px
        </div>
        <div>
          <span>LARGURA</span>
          {Math.round(wm.w)}px
        </div>
      </div>
      <span style={{ fontSize: 11, color: 'var(--muted-2)' }}>Valores no vídeo final (1080×1920).</span>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <span style={{ fontSize: 12, color: 'var(--muted)' }}>Opacidade</span>
        <div className="pills" role="group" aria-label="Opacidade da marca d'água">
          {OPACITIES.map((o) => (
            <button
              key={o}
              className="pill-btn"
              aria-pressed={Math.abs(wm.opacity - o) < 0.01}
              onClick={() => onChange({ ...wm, opacity: o })}
            >
              {Math.round(o * 100)}%
            </button>
          ))}
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 8 }}>
        <button className="btn sm" onClick={() => onChange(clamp({ ...wm, x: (OUT_W - wm.w) / 2, y: (OUT_H - wm.w * ratio) / 2 }))}>
          Centralizar
        </button>
        <button className="btn sm" onClick={() => onChange(clamp({ ...wm, w: wm.imgW }))}>
          Tamanho original
        </button>
      </div>

      <button className="btn soft" onClick={onApplyAll}>
        Aplicar em todos os {approvedCount} cortes
      </button>
    </div>
  )
}
