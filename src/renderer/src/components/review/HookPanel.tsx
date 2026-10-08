import { useEffect, useState } from 'react'
import type { Clip, LlmProvider } from '@shared/types'
import { call, errorText } from '../../api'
import { useStore } from '../../store'
import { Icon } from '../Icon'

interface Props {
  clip: Clip
  provider: LlmProvider
  onProvider: (p: LlmProvider) => void
}

export function HookPanel({ clip, provider, onProvider }: Props) {
  const patchClip = useStore((s) => s.patchClip)
  const toast = useStore((s) => s.toast)
  const [custom, setCustom] = useState(clip.hookCustom)
  const [busy, setBusy] = useState(false)
  useEffect(() => setCustom(clip.hookCustom), [clip.id, clip.hookCustom])

  const hooks = clip.llm?.hooks ?? []
  const usingCustom = clip.hookCustom.trim().length > 0

  const regenerate = async (): Promise<void> => {
    setBusy(true)
    try {
      await call('llm:hooks', clip.id, provider)
    } catch (e) {
      toast('error', errorText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="panel" style={{ gap: 10 }}>
      <div className="panel-head">
        <span className="panel-title">Gancho dos primeiros segundos</span>
        <div className="seg well compact" role="group" aria-label="Modelo">
          {(['openai', 'local'] as const).map((p) => (
            <button key={p} aria-pressed={provider === p} onClick={() => onProvider(p)}>
              {p === 'openai' ? 'OpenAI' : 'Local'}
            </button>
          ))}
        </div>
      </div>
      <span className="hint">Sugestões da IA a partir da transcrição do corte. Aparece nos primeiros 3 segundos.</span>

      {hooks.length === 0 && <span className="hint">{clip.words ? 'Sem sugestões ainda. Gere abaixo.' : 'Esperando a transcrição do corte.'}</span>}
      {hooks.map((h, i) => {
        const on = !usingCustom && clip.hookChoice === i
        return (
          <button
            key={i}
            className={`hook-opt${on ? ' on' : ''}`}
            aria-pressed={on}
            onClick={() => {
              setCustom('')
              void patchClip(clip.id, { hookChoice: i, hookCustom: '' })
            }}
          >
            <span className="radio" />
            <span style={{ flexGrow: 1, textAlign: 'left' }}>{h}</span>
          </button>
        )
      })}

      <label className="field">
        Ou escreva o seu
        <input
          className="input"
          placeholder="Seu gancho aqui"
          value={custom}
          maxLength={60}
          onChange={(e) => setCustom(e.target.value)}
          onBlur={() => {
            if (custom !== clip.hookCustom) void patchClip(clip.id, { hookCustom: custom })
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          }}
        />
      </label>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button className="btn sm" disabled={busy || !clip.words} onClick={() => void regenerate()}>
          {busy ? <span className="spinner" /> : <Icon name="refresh" size={14} />}
          Gerar outras
        </button>
        {(usingCustom || clip.hookChoice !== null) && (
          <button
            className="btn sm ghost"
            onClick={() => {
              setCustom('')
              void patchClip(clip.id, { hookChoice: null, hookCustom: '' })
            }}
          >
            Sem gancho
          </button>
        )}
      </div>
    </div>
  )
}
