import { useEffect, useRef, useState } from 'react'
import { normalizeHashtag } from '@shared/platformRules'
import type { Network, StyleExample, WritingStyle } from '@shared/types'
import { call, errorText } from '../api'
import { useStore } from '../store'
import { Icon } from './Icon'

type Tab = 'hook' | Network | 'general'

const TABS: { key: Tab; label: string }[] = [
  { key: 'hook', label: 'Ganchos' },
  { key: 'instagram', label: 'Instagram' },
  { key: 'tiktok', label: 'TikTok' },
  { key: 'youtube', label: 'Shorts' },
  { key: 'general', label: 'Qualquer rede' }
]

function matches(e: StyleExample, tab: Tab): boolean {
  if (tab === 'hook') return e.kind === 'hook'
  if (tab === 'general') return e.kind === 'caption' && e.network === null
  return e.kind === 'caption' && e.network === tab
}

/** "Meu jeito de escrever": o que vai pro prompt pra IA escrever como o streamer. */
export function StylePanel() {
  const settings = useStore((s) => s.settings)
  const update = useStore((s) => s.updateSettings)
  const toast = useStore((s) => s.toast)
  const [examples, setExamples] = useState<StyleExample[]>([])
  const [tab, setTab] = useState<Tab>('hook')
  const [draft, setDraft] = useState<WritingStyle | null>(settings?.style ?? null)
  const [text, setText] = useState('')
  const [tags, setTags] = useState('')
  const [title, setTitle] = useState('')
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    void call('style:list').then(setExamples)
  }, [])
  useEffect(() => {
    if (settings && !draft) setDraft(settings.style)
  }, [settings, draft])
  if (!draft) return null

  const set = (p: Partial<WritingStyle>): void => {
    const next = { ...draft, ...p }
    setDraft(next)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => void update({ style: next }), 500)
  }

  const add = async (): Promise<void> => {
    if (!text.trim()) return
    try {
      const hashtags = tags
        .split(/[\s,]+/)
        .map((t) => normalizeHashtag(t))
        .filter((t): t is string => t !== null)
      const list = await call('style:add', {
        kind: tab === 'hook' ? 'hook' : 'caption',
        network: tab === 'hook' || tab === 'general' ? null : tab,
        text: tab === 'hook' ? text.trim().toLocaleUpperCase('pt-BR') : text.trim(),
        title: tab === 'youtube' && title.trim() ? title.trim() : undefined,
        hashtags: tab === 'hook' ? [] : hashtags,
        source: 'manual'
      })
      setExamples(list)
      setText('')
      setTags('')
      setTitle('')
    } catch (e) {
      toast('error', errorText(e))
    }
  }

  const shown = examples.filter((e) => matches(e, tab)).reverse()

  return (
    <section className="panel">
      <span className="panel-title">Meu jeito de escrever</span>
      <span className="hint">
        A IA usa isto nas legendas das redes e nos ganchos pra escrever como você, em vez de soar genérica. Quanto mais exemplos reais, melhor.
      </span>

      <div className="style-grid">
        <label className="field">
          Como eu escrevo
          <textarea
            className="textarea"
            rows={4}
            value={draft.notes}
            placeholder={'Ex.: escrevo curto e tudo minúsculo, falo "chat" e "mano", uso kkkk, nunca uso emoji, termino chamando pra live'}
            onChange={(e) => set({ notes: e.target.value })}
          />
        </label>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <label className="field">
            Palavras e frases que eu não uso
            <input
              className="input"
              value={draft.avoid}
              placeholder="Ex.: épico, insano, você não vai acreditar, confira"
              onChange={(e) => set({ avoid: e.target.value })}
            />
          </label>
          <label className="field">
            Jogo que eu mais jogo (padrão das lives novas)
            <input className="input" value={draft.defaultGame} placeholder="Ex.: Valorant" onChange={(e) => set({ defaultGame: e.target.value })} />
          </label>
        </div>
      </div>
      <label className="check">
        <input type="checkbox" checked={draft.learn} onChange={() => set({ learn: !draft.learn })} />
        Aprender com o que eu posto (guarda a legenda e o gancho finais de cada corte agendado ou baixado)
      </label>

      <div className="seg well" role="tablist" aria-label="Tipo de exemplo" style={{ gridTemplateColumns: `repeat(${TABS.length}, minmax(0, 1fr))` }}>
        {TABS.map((t) => (
          <button key={t.key} role="tab" aria-selected={tab === t.key} onClick={() => setTab(t.key)}>
            {t.label} <span className="muted">{examples.filter((e) => matches(e, t.key)).length}</span>
          </button>
        ))}
      </div>

      <div className="example-add">
        {tab === 'youtube' && (
          <input className="input" placeholder="Título do Short (opcional)" value={title} onChange={(e) => setTitle(e.target.value)} />
        )}
        <textarea
          className="textarea"
          rows={tab === 'hook' ? 1 : 3}
          placeholder={tab === 'hook' ? 'Um gancho que você usaria (ex.: ELE NÃO SABIA QUE EU TAVA ATRÁS)' : 'Cole uma legenda que você escreveu'}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        {tab !== 'hook' && (
          <input className="input" placeholder="#hashtags que você usou (opcional)" value={tags} onChange={(e) => setTags(e.target.value)} />
        )}
        <button className="btn sm" disabled={!text.trim()} onClick={() => void add()} style={{ alignSelf: 'flex-start' }}>
          <Icon name="plus" size={14} /> Adicionar exemplo
        </button>
      </div>

      {shown.length === 0 ? (
        <span className="hint">Nenhum exemplo ainda nessa aba.</span>
      ) : (
        <div className="example-list">
          {shown.map((e) => (
            <div key={e.id} className="example">
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0, flexGrow: 1 }}>
                {e.title && <span style={{ fontWeight: 600, fontSize: 13 }}>{e.title}</span>}
                <span className="example-text">{e.text}</span>
                {e.hashtags.length > 0 && <span style={{ fontSize: 12, color: 'var(--violet-4)' }}>{e.hashtags.join(' ')}</span>}
              </div>
              <span className={`chip ${e.source === 'posted' ? 'blue' : 'violet'}`} style={{ fontSize: 11 }}>
                {e.source === 'posted' ? 'postado' : 'você'}
              </span>
              <button
                className="btn xs ghost"
                aria-label="Remover exemplo"
                onClick={() => void call('style:remove', e.id).then(setExamples)}
              >
                <Icon name="trash" size={13} />
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
