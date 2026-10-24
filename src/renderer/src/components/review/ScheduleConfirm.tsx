import { useEffect, useState } from 'react'
import type { SchedulePreviewItem, ScheduleRequest } from '@shared/ipc'
import type { PlatformRules } from '@shared/platformRules'
import { call, errorText } from '../../api'
import { postState, type PostTone } from '../../lib/posts'
import { clipFullName, useStore } from '../../store'
import { Icon } from '../Icon'
import { Modal } from '../Modal'

interface Props {
  req: ScheduleRequest
  items: SchedulePreviewItem[]
  rules: PlatformRules
  onClose: () => void
}

function when(at: string | null): string {
  if (!at) return 'Agora'
  return new Date(at).toLocaleString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
}

const TONE_COLOR: Record<PostTone, string> = { ok: '#A7F3D0', busy: '#93C5FD', error: '#FF8A8A', muted: 'var(--muted)' }

/** Depois do "Confirmar": cada corte em cada rede, atualizando sozinho até tudo terminar. */
function ScheduleResult({ ids, rules, onClose }: { ids: string[]; rules: PlatformRules; onClose: () => void }) {
  const posts = useStore((s) => s.posts)
  const clips = useStore((s) => s.clips)
  const toast = useStore((s) => s.toast)
  // "na fila" vira "agendado" com o passar do tempo
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5000)
    return () => clearInterval(t)
  }, [])
  const mine = ids.map((id) => posts.find((p) => p.id === id)).filter((p) => p !== undefined)
  const rows = mine.map((p) => ({ p, st: postState(p, clips[p.clipId]?.render ?? null, now) }))
  const ok = rows.filter((r) => r.st.tone === 'ok').length
  const failed = rows.filter((r) => r.st.tone === 'error').length
  const pending = rows.filter((r) => r.st.pending).length
  const retry = async (id: string): Promise<void> => {
    try {
      await call('posts:retry', id)
    } catch (e) {
      toast('error', errorText(e))
    }
  }
  return (
    <Modal
      title={pending ? 'Enviando…' : failed ? 'Terminou com falhas' : 'Tudo certo'}
      onClose={onClose}
      wide
      actions={
        <button className="btn primary" onClick={onClose}>
          Fechar
        </button>
      }
    >
      <div className="result-summary">
        <span className="chip violet">{ok} {ok === 1 ? 'concluído' : 'concluídos'}</span>
        {pending > 0 && (
          <span className="chip blue">
            <span className="spinner" style={{ width: 9, height: 9 }} /> {pending} em andamento
          </span>
        )}
        <span className={`chip${failed ? ' error' : ''}`}>{failed} {failed === 1 ? 'falha' : 'falhas'}</span>
      </div>
      {pending > 0 && (
        <span className="hint">Pode fechar: o envio continua sozinho e o resultado aparece em Agendados.</span>
      )}
      <div className="confirm-list">
        {rows.map(({ p, st }) => {
          const c = clips[p.clipId]
          return (
            <div key={p.id} className="result-row">
              <span className="result-dot" style={{ background: TONE_COLOR[st.tone] }} aria-hidden />
              <span className="result-name">{c ? clipFullName(c) : 'Corte'}</span>
              <span className="chip">{rules[p.network].product}</span>
              <span className="result-state" style={{ color: TONE_COLOR[st.tone] }}>
                {st.pending && <span className="spinner" style={{ width: 9, height: 9 }} />} {st.label}
              </span>
              {p.status === 'failed' && (
                <button className="btn sm" onClick={() => void retry(p.id)}>
                  <Icon name="refresh" size={14} /> Tentar de novo
                </button>
              )}
            </div>
          )
        })}
      </div>
    </Modal>
  )
}

/** Mostra exatamente o que vai pra cada rede e só posta depois do "Confirmar". */
export function ScheduleConfirm({ req, items, rules, onClose }: Props) {
  const toast = useStore((s) => s.toast)
  const upsertPost = useStore((s) => s.upsertPost)
  const [busy, setBusy] = useState(false)
  const [created, setCreated] = useState<string[] | null>(null)
  const confirm = async (): Promise<void> => {
    setBusy(true)
    try {
      const posts = await call('posts:schedule', req)
      for (const p of posts) upsertPost(p)
      setCreated(posts.map((p) => p.id))
    } catch (e) {
      toast('error', errorText(e))
    } finally {
      setBusy(false)
    }
  }
  if (created) return <ScheduleResult ids={created} rules={rules} onClose={onClose} />
  return (
    <Modal
      title={req.firstAt ? 'Confirmar agendamento' : 'Confirmar postagem'}
      onClose={onClose}
      wide
      actions={
        <>
          <button className="btn" onClick={onClose}>
            Voltar e ajustar
          </button>
          <button className="btn primary" disabled={busy || items.length === 0} onClick={() => void confirm()}>
            {busy && <span className="spinner" />}
            {req.firstAt ? `Confirmar e agendar ${items.length}` : `Confirmar e postar ${items.length}`}
          </button>
        </>
      }
    >
      <span className="hint">
        Confira o que vai ser publicado em cada rede. Nada é enviado antes de você confirmar. Corte que já está na fila (ou já
        saiu) numa rede não entra de novo, e os horários se encaixam nos que as outras lives ainda não usaram.
      </span>
      {items.length === 0 && (
        <div className="callout warn">
          <Icon name="alert" />
          <span>Esses cortes já estão agendados ou postados nessas redes. Veja na tela de agendados.</span>
        </div>
      )}
      <div className="confirm-list">
        {items.map((it, i) => (
          <div key={i} className="confirm-item">
            <div className="confirm-head">
              <span style={{ fontWeight: 600 }}>{it.clipName}</span>
              <span className="chip violet">{rules[it.network].product}</span>
              <span style={{ flexGrow: 1 }} />
              <span className="mono" style={{ fontSize: 12, color: 'var(--text-3)' }}>
                <Icon name="clock" size={12} /> {when(it.at)}
              </span>
            </div>
            {it.title && (
              <div style={{ fontSize: 13 }}>
                <span className="muted">Título: </span>
                {it.title}
              </div>
            )}
            <div className="confirm-text">{it.text || <span className="muted">(sem legenda)</span>}</div>
            {it.hashtags.length > 0 && <div style={{ fontSize: 12, color: 'var(--violet-4)' }}>{it.hashtags.join(' ')}</div>}
            {it.warnings.map((w, k) => (
              <span key={k} style={{ fontSize: 12, color: 'var(--warn)' }}>
                {w}
              </span>
            ))}
          </div>
        ))}
      </div>
    </Modal>
  )
}
