import { useEffect, useState } from 'react'
import { hookTextFor } from '@shared/text'
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
  const defaults = useStore((s) => s.settings?.text)
  const go = useStore((s) => s.go)
  const [custom, setCustom] = useState(clip.hookCustom)
  const [busy, setBusy] = useState(false)
  useEffect(() => setCustom(clip.hookCustom), [clip.id, clip.hookCustom])
  if (!defaults) return null

  const hooks = clip.llm?.hooks ?? []
  const usingCustom = clip.hookCustom.trim().length > 0
  const shown = hookTextFor(clip, defaults)
  // texto fixo só vale se tiver algo escrito; vazio = cai na sugestão da IA
  const fixedMode = defaults.hook.mode === 'fixed' && defaults.hook.fixedText.trim().length > 0
  // qual sugestão está valendo (escolhida, ou a primeira quando o padrão é a IA)
  const activeIdx = clip.hookOff || usingCustom ? -1 : (clip.hookChoice ?? (fixedMode ? -1 : 0))
  const fixedActive = !clip.hookOff && !usingCustom && clip.hookChoice === null && fixedMode

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
      <span className="hint">
        Sugestões da IA a partir da transcrição do corte. Aparece nos primeiros {defaults.hook.duration} segundos.
      </span>
      {!defaults.hook.enabled && (
        <div className="callout warn">
          <Icon name="info" color="#FFC48A" />
          <span>
            O texto inicial está desligado no padrão.{' '}
            <button className="link-btn" onClick={() => go({ name: 'settings' })}>
              Ligar em Configurações
            </button>
          </span>
        </div>
      )}

      {fixedActive && (
        <div className="hook-opt on" aria-pressed>
          <span className="radio" />
          <span style={{ flexGrow: 1, textAlign: 'left' }}>{shown}</span>
          <span className="hint">texto padrão</span>
        </div>
      )}
      {hooks.length === 0 && !fixedActive && (
        <span className="hint">{clip.words ? 'Sem sugestões ainda. Gere abaixo.' : 'Esperando a transcrição do corte.'}</span>
      )}
      {hooks.map((h, i) => {
        const on = activeIdx === i
        return (
          <button
            key={i}
            className={`hook-opt${on ? ' on' : ''}`}
            aria-pressed={on}
            onClick={() => {
              setCustom('')
              void patchClip(clip.id, { hookChoice: i, hookCustom: '', hookOff: false })
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
          maxLength={70}
          onChange={(e) => setCustom(e.target.value)}
          onBlur={() => {
            if (custom !== clip.hookCustom) void patchClip(clip.id, { hookCustom: custom, hookOff: false })
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
        {shown && (
          <button
            className="btn sm ghost"
            title="A IA passa a usar este gancho como referência de como você escreve"
            onClick={() =>
              void call('style:add', { kind: 'hook', network: null, text: shown, hashtags: [], source: 'manual' }).then(() =>
                toast('success', 'Gancho guardado como exemplo do seu jeito.')
              )
            }
          >
            <Icon name="sparkle" size={14} /> Guardar como exemplo
          </button>
        )}
        <button
          className={`btn sm${clip.hookOff ? ' soft' : ' ghost'}`}
          aria-pressed={clip.hookOff}
          onClick={() => {
            setCustom('')
            void patchClip(clip.id, clip.hookOff ? { hookOff: false } : { hookOff: true, hookCustom: '' })
          }}
        >
          {clip.hookOff ? 'Sem gancho neste corte (ligar de novo)' : 'Sem gancho'}
        </button>
      </div>
    </div>
  )
}
