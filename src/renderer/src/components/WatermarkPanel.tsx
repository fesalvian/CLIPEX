import { OUT_H, OUT_W } from '@shared/defaults'
import { watermarkBox } from '@shared/text'
import type { CaptionStyle, Watermark } from '@shared/types'
import { call, errorText, mediaUrl } from '../api'
import { useStore } from '../store'
import { Icon } from './Icon'
import { OwnSettingRow } from './OwnSettingRow'

interface Props {
  watermark: Watermark
  /** legenda do corte selecionado (a logo fica acima dela) */
  caption: CaptionStyle & { y: number }
  /** as mudanças valem só pro corte selecionado */
  perClip: boolean
  /** o corte selecionado tem uma logo própria */
  own: boolean
  /** cortes com logo própria */
  overrides: number
  /** "mudar em todos os cortes" marcado */
  allMode: boolean
  onAllModeChange: (on: boolean) => void
  onChange: (wm: Watermark) => void
  /** volta o corte selecionado pra logo padrão */
  onReset: () => void
  /** a logo mostrada vira o padrão e vale pra todos os cortes */
  onApplyAll: () => void
}

const OPACITIES = [0.5, 0.8, 1]

export function WatermarkPanel({ watermark: wm, caption, perClip, own, overrides, allMode, onAllModeChange, onChange, onReset, onApplyAll }: Props) {
  const toast = useStore((s) => s.toast)
  const ratio = wm.imgH / Math.max(1, wm.imgW)
  const fileName = wm.path ? (wm.path.split(/[\\/]/).pop() ?? '') : null
  const box = watermarkBox(wm, caption)
  const anchored = wm.anchor === 'caption'

  const pick = async (): Promise<void> => {
    try {
      const next = await call('watermark:pick')
      if (next) onChange({ ...wm, enabled: true, path: next.path, imgW: next.imgW, imgH: next.imgH, w: next.w })
    } catch (e) {
      toast('error', errorText(e))
    }
  }

  const clampFree = (w: Watermark): Watermark => {
    const ww = Math.max(60, Math.min(OUT_W, w.w))
    return { ...w, w: ww, x: Math.max(0, Math.min(OUT_W - ww, w.x)), y: Math.max(0, Math.min(OUT_H - ww * ratio, w.y)) }
  }

  const thumb = mediaUrl(wm.path)
  return (
    <div className="panel">
      <div className="panel-head">
        <span className="panel-title" style={{ fontSize: 14 }}>
          Logo / marca d'água
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
            {wm.path ? `${wm.imgW}×${wm.imgH} · borda transparente recortada` : 'Use um PNG com fundo transparente'}
          </span>
        </div>
        <button className="btn sm" onClick={() => void pick()}>
          {wm.path ? 'Trocar' : 'Escolher'}
        </button>
      </div>

      <div className="seg well" role="group" aria-label="Posição da logo" style={{ gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' }}>
        <button aria-pressed={anchored} onClick={() => onChange({ ...wm, anchor: 'caption' })}>
          Acima da legenda
        </button>
        <button aria-pressed={!anchored} onClick={() => onChange(clampFree({ ...wm, anchor: 'free', x: box.x, y: box.y }))}>
          Posição livre
        </button>
      </div>

      <div className="callout">
        <Icon name="move" color="#C4B5FD" />
        <span>
          {anchored
            ? 'A logo acompanha a legenda: fica sempre logo acima dela, sem encostar. Arraste no preview pra mudar o espaço e o lado; o canto roxo muda o tamanho.'
            : 'Arraste a imagem no preview pra mover. Puxe o canto roxo pra redimensionar, mantendo a proporção do PNG.'}
        </span>
      </div>

      <div className="wm-nums mono">
        {anchored ? (
          <>
            <div>
              <span>ESPAÇO ATÉ A LEGENDA</span>
              {Math.round(wm.gap)}px
            </div>
            <div>
              <span>DESLOCAMENTO</span>
              {Math.round(wm.offsetX)}px
            </div>
          </>
        ) : (
          <>
            <div>
              <span>X</span>
              {Math.round(box.x)}px
            </div>
            <div>
              <span>Y</span>
              {Math.round(box.y)}px
            </div>
          </>
        )}
        <div>
          <span>LARGURA</span>
          {Math.round(box.w)}px
        </div>
      </div>
      <span style={{ fontSize: 11, color: 'var(--muted-2)' }}>Valores no vídeo final (1080×1920).</span>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <span style={{ fontSize: 12, color: 'var(--muted)' }}>Opacidade</span>
        <div className="pills" role="group" aria-label="Opacidade da marca d'água">
          {OPACITIES.map((o) => (
            <button key={o} className="pill-btn" aria-pressed={Math.abs(wm.opacity - o) < 0.01} onClick={() => onChange({ ...wm, opacity: o })}>
              {Math.round(o * 100)}%
            </button>
          ))}
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 8 }}>
        <button
          className="btn sm"
          onClick={() =>
            onChange(anchored ? { ...wm, offsetX: 0 } : clampFree({ ...wm, x: (OUT_W - wm.w) / 2, y: (OUT_H - wm.w * ratio) / 2 }))
          }
        >
          Centralizar
        </button>
        <button className="btn sm" onClick={() => onChange(anchored ? { ...wm, w: Math.min(wm.imgW, OUT_W) } : clampFree({ ...wm, w: wm.imgW }))}>
          Tamanho original
        </button>
      </div>

      {own && !allMode && <OwnSettingRow text="Este corte tem uma logo própria." onReset={onReset} onApplyAll={onApplyAll} />}
      {!own && overrides > 0 && (
        <button className="btn soft" onClick={onApplyAll}>
          Usar esta logo nos {overrides} {overrides === 1 ? 'corte que tem' : 'cortes que têm'} outra
        </button>
      )}
      <label className="check">
        <input type="checkbox" checked={allMode} onChange={() => onAllModeChange(!allMode)} />
        Mudar a logo em todos os cortes
      </label>
      <span className="hint">
        {perClip ? 'Muda só neste corte.' : 'Muda em todos os cortes (e nas próximas lives).'}
      </span>
    </div>
  )
}
