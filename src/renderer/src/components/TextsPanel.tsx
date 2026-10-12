import { useEffect, useState } from 'react'
import type { ClipPatch } from '@shared/ipc'
import { hookTextFor } from '@shared/text'
import type { Clip, Settings } from '@shared/types'
import { useStore } from '../store'
import { Icon } from './Icon'

interface Props {
  clip: Clip
  settings: Settings
  allClips: Clip[]
}

function withoutPos<T extends { x?: number; y?: number | null }>(o: T | null): T | null {
  if (!o) return null
  const { x: _x, y: _y, ...rest } = o
  return Object.keys(rest).length ? (rest as T) : null
}

/** Legenda e texto inicial do corte: liga/desliga, texto, posição. Estilo fica nas configurações. */
export function TextsPanel({ clip, settings, allClips }: Props) {
  const patchClip = useStore((s) => s.patchClip)
  const updateSettings = useStore((s) => s.updateSettings)
  const go = useStore((s) => s.go)
  const toast = useStore((s) => s.toast)
  const d = settings.text
  const [custom, setCustom] = useState(clip.hookCustom)
  useEffect(() => setCustom(clip.hookCustom), [clip.id, clip.hookCustom])

  const captionOn = { ...d.caption, ...(clip.captionStyle ?? {}) }.enabled
  const hookEnabledDefault = { ...d.hook, ...(clip.hookStyle ?? {}) }.enabled
  const hookOn = hookEnabledDefault && !clip.hookOff
  const captionMoved = clip.captionStyle?.x !== undefined || clip.captionStyle?.y !== undefined
  const hookMoved = clip.hookStyle?.x !== undefined || clip.hookStyle?.y !== undefined
  const suggestions = clip.llm?.hooks ?? []
  const fallback = hookTextFor({ ...clip, hookCustom: '', hookOff: false }, d)

  const patch = (p: ClipPatch): void => void patchClip(clip.id, p)

  const positionsToAll = async (): Promise<void> => {
    const cap = clip.captionStyle ?? {}
    const hk = clip.hookStyle ?? {}
    await Promise.all(
      allClips
        .filter((c) => c.id !== clip.id)
        .map((c) =>
          patchClip(c.id, {
            captionStyle: { ...(withoutPos(c.captionStyle) ?? {}), ...(cap.x !== undefined ? { x: cap.x, y: cap.y } : {}) },
            hookStyle: { ...(withoutPos(c.hookStyle) ?? {}), ...(hk.x !== undefined ? { x: hk.x, y: hk.y } : {}) }
          })
        )
    )
    toast('success', `Posições aplicadas em ${allClips.length - 1} cortes.`)
  }

  const saveAsDefault = async (): Promise<void> => {
    const cap = clip.captionStyle ?? {}
    const hk = clip.hookStyle ?? {}
    await updateSettings({
      text: {
        caption: { ...d.caption, ...(cap.x !== undefined ? { x: cap.x, y: cap.y ?? null } : {}) },
        hook: { ...d.hook, ...(hk.x !== undefined ? { x: hk.x, y: hk.y ?? d.hook.y } : {}) }
      }
    })
    patch({ captionStyle: withoutPos(clip.captionStyle), hookStyle: withoutPos(clip.hookStyle) })
    toast('success', 'Posições salvas como padrão pra todos os cortes.')
  }

  return (
    <div className="panel" style={{ gap: 10 }}>
      <div className="panel-head">
        <span className="panel-title" style={{ fontSize: 14 }}>
          Textos do vídeo
        </span>
        <button className="btn xs ghost" onClick={() => go({ name: 'settings' })} title="Fonte, cores e animações">
          <Icon name="gear" size={13} /> Estilo
        </button>
      </div>
      <div className="callout">
        <Icon name="move" color="#C4B5FD" />
        <span>Pause o vídeo e arraste a legenda e o texto inicial no preview. No meio, o texto encaixa no centro.</span>
      </div>

      <div className="text-row">
        <label className="check">
          <input
            type="checkbox"
            checked={captionOn}
            onChange={() => patch({ captionStyle: { ...(clip.captionStyle ?? {}), enabled: !captionOn } })}
          />
          Legenda
        </label>
        <span className="hint">
          {captionMoved ? 'posição personalizada · ' : 'posição automática (abaixo da webcam)'}
          {captionMoved && (
            <button className="link-btn" onClick={() => patch({ captionStyle: withoutPos(clip.captionStyle) })}>
              voltar pro padrão
            </button>
          )}
        </span>
      </div>

      <div className="text-row">
        <label className="check">
          <input
            type="checkbox"
            checked={hookOn}
            onChange={() =>
              hookEnabledDefault
                ? patch({ hookOff: !clip.hookOff })
                : patch({ hookOff: false, hookStyle: { ...(clip.hookStyle ?? {}), enabled: true } })
            }
          />
          Texto inicial (gancho)
        </label>
        {hookMoved && (
          <span className="hint">
            posição personalizada ·{' '}
            <button className="link-btn" onClick={() => patch({ hookStyle: withoutPos(clip.hookStyle) })}>
              voltar pro padrão
            </button>
          </span>
        )}
      </div>
      {hookOn && (
        <>
          <input
            className="input"
            value={custom}
            maxLength={70}
            placeholder={fallback ?? 'Escreva o texto inicial'}
            aria-label="Texto inicial"
            onChange={(e) => setCustom(e.target.value)}
            onBlur={() => custom !== clip.hookCustom && patch({ hookCustom: custom })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
            }}
          />
          {suggestions.length > 0 && (
            <div className="tags">
              {suggestions.map((h, i) => (
                <button
                  key={i}
                  className={`tag${!clip.hookCustom && clip.hookChoice === i ? ' on' : ''}`}
                  title="Usar esta sugestão da IA"
                  onClick={() => {
                    setCustom('')
                    patch({ hookChoice: i, hookCustom: '', hookOff: false })
                  }}
                >
                  {h}
                </button>
              ))}
            </div>
          )}
        </>
      )}

      {(captionMoved || hookMoved) && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 8 }}>
          <button className="btn sm" onClick={() => void positionsToAll()}>
            Posições em todos
          </button>
          <button className="btn sm" onClick={() => void saveAsDefault()}>
            Salvar como padrão
          </button>
        </div>
      )}
    </div>
  )
}
