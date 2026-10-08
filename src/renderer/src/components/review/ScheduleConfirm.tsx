import { useState } from 'react'
import type { SchedulePreviewItem, ScheduleRequest } from '@shared/ipc'
import type { PlatformRules } from '@shared/platformRules'
import { call, errorText } from '../../api'
import { useStore } from '../../store'
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

/** Mostra exatamente o que vai pra cada rede e só posta depois do "Confirmar". */
export function ScheduleConfirm({ req, items, rules, onClose }: Props) {
  const toast = useStore((s) => s.toast)
  const [busy, setBusy] = useState(false)
  const confirm = async (): Promise<void> => {
    setBusy(true)
    try {
      const posts = await call('posts:schedule', req)
      toast('success', req.firstAt ? `${posts.length} posts agendados.` : `${posts.length} posts sendo enviados.`)
      onClose()
    } catch (e) {
      toast('error', errorText(e))
    } finally {
      setBusy(false)
    }
  }
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
      <span className="hint">Confira o que vai ser publicado em cada rede. Nada é enviado antes de você confirmar.</span>
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
