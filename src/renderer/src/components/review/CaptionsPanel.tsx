import { useEffect, useState } from 'react'
import { checkCaption, fullCaptionText, normalizeHashtag, type PlatformRules } from '@shared/platformRules'
import type { Accounts, Clip, LlmProvider, NetCaption, Network } from '@shared/types'
import { call, errorText } from '../../api'
import { useStore } from '../../store'
import { Icon } from '../Icon'

interface Props {
  clip: Clip
  rules: PlatformRules
  accounts: Accounts
  provider: LlmProvider
}

const TABS: Network[] = ['instagram', 'tiktok', 'youtube']

export function CaptionsPanel({ clip, rules, accounts, provider }: Props) {
  const patchClip = useStore((s) => s.patchClip)
  const toast = useStore((s) => s.toast)
  const [tab, setTab] = useState<Network>('instagram')
  const [busy, setBusy] = useState(false)
  const [adding, setAdding] = useState(false)
  const [newTag, setNewTag] = useState('')
  const rule = rules[tab]
  const cap: NetCaption = clip.captions?.[tab] ?? { text: '', hashtags: [], ...(rule.hasTitle ? { title: '' } : {}) }
  const [text, setText] = useState(cap.text)
  const [title, setTitle] = useState(cap.title ?? '')
  useEffect(() => {
    setText(cap.text)
    setTitle(cap.title ?? '')
  }, [clip.id, tab, cap.text, cap.title])

  const save = (next: NetCaption): void => {
    void patchClip(clip.id, { captions: { ...(clip.captions ?? {}), [tab]: next } })
  }
  const regenerate = async (): Promise<void> => {
    setBusy(true)
    try {
      await call('llm:captions', clip.id, provider)
    } catch (e) {
      toast('error', errorText(e))
    } finally {
      setBusy(false)
    }
  }

  const draft: NetCaption = { ...cap, text, ...(rule.hasTitle ? { title } : {}) }
  const check = checkCaption(tab, draft, rules)
  const handle = accounts[tab]
  const tagMaxed = cap.hashtags.length >= rule.hashtags.max

  return (
    <div className="panel">
      <div className="panel-head">
        <span className="panel-title">Legenda e hashtags</span>
        <button className="btn xs" disabled={busy || !clip.words} onClick={() => void regenerate()}>
          {busy ? <span className="spinner" /> : <Icon name="refresh" size={13} />}
          {clip.captions ? 'Gerar de novo' : 'Gerar'}
        </button>
      </div>
      <div className="seg well" role="tablist" aria-label="Rede" style={{ gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' }}>
        {TABS.map((n) => (
          <button key={n} role="tab" aria-selected={tab === n} onClick={() => setTab(n)}>
            {rules[n].label}
          </button>
        ))}
      </div>
      <span className="mono" style={{ fontSize: 12, color: 'var(--violet-3)' }}>
        {handle}
      </span>

      {rule.hasTitle && (
        <label className="field">
          <span className="field-row">
            Título
            <span className="mono">
              {title.length}/{rule.titleMax ?? 100}
            </span>
          </span>
          <input
            className="input"
            value={title}
            maxLength={rule.titleMax ?? 100}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={() => title !== (cap.title ?? '') && save({ ...cap, title })}
          />
        </label>
      )}

      <label className="field">
        <span className="field-row">
          {rule.textLabel}
          <span className="mono" style={{ color: check.chars > check.maxChars ? 'var(--warn)' : undefined }}>
            {check.chars}/{check.maxChars}
          </span>
        </span>
        <textarea className="textarea" rows={5} value={text} onChange={(e) => setText(e.target.value)} onBlur={() => text !== cap.text && save({ ...cap, text })} />
      </label>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <span className="field-row" style={{ fontSize: 12, color: 'var(--muted)' }}>
          Hashtags
          <span className="mono" style={{ color: tagMaxed ? 'var(--warn)' : undefined }}>
            {cap.hashtags.length}/{rule.hashtags.max}
            {tab !== 'instagram' ? ` (recomendado ${rule.hashtags.min} a ${rule.hashtags.max})` : ''}
          </span>
        </span>
        <div className="tags">
          {cap.hashtags.map((t) => (
            <button
              key={t}
              className="tag"
              title="Remover"
              aria-label={`Remover ${t}`}
              onClick={() => save({ ...cap, hashtags: cap.hashtags.filter((x) => x !== t) })}
            >
              {t}
              <Icon name="x" size={11} />
            </button>
          ))}
          {adding ? (
            <input
              className="tag-input"
              autoFocus
              value={newTag}
              placeholder="#hashtag"
              onChange={(e) => setNewTag(e.target.value)}
              onBlur={() => {
                const t = normalizeHashtag(newTag)
                if (t && !cap.hashtags.includes(t)) save({ ...cap, hashtags: [...cap.hashtags, t] })
                setNewTag('')
                setAdding(false)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                if (e.key === 'Escape') {
                  setNewTag('')
                  setAdding(false)
                }
              }}
            />
          ) : (
            <button className="tag add" disabled={tagMaxed} onClick={() => setAdding(true)}>
              + hashtag
            </button>
          )}
        </div>
      </div>

      <div className="callout">
        <Icon name="info" color="#C4B5FD" />
        <span>{rule.tip}</span>
      </div>
      {check.warnings.length > 0 && (
        <div className="callout warn">
          <Icon name="alert" color="#FFC48A" />
          <span>{check.warnings.join(' ')}</span>
        </div>
      )}

      <button
        className="btn sm"
        onClick={() => {
          const body = rule.hasTitle ? `${title}\n\n${fullCaptionText(draft)}` : fullCaptionText(draft)
          void call('clipboard:write', body).then(() => toast('success', 'Legenda e hashtags copiadas.'))
        }}
      >
        <Icon name="copy" size={14} />
        Copiar legenda e hashtags
      </button>
    </div>
  )
}
