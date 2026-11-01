import { useState } from 'react'
import { KIND_LABEL } from '@shared/defaults'
import type { ClipKind } from '@shared/types'
import { call, errorText } from '../api'
import { useStore } from '../store'
import { Icon } from './Icon'
import { Modal } from './Modal'

const KINDS: { key: ClipKind; text: string; subjectHint: string }[] = [
  {
    key: 'gameplay',
    text: 'Live de jogo com webcam. Acha os momentos por risada, grito e pico de áudio; o vídeo sai com a cam em cima e o jogo embaixo.',
    subjectHint: 'streamer Alanzoka'
  },
  {
    key: 'podcast',
    text: 'Conversa. Transcreve o episódio inteiro e a IA acha as conversas completas (começo, meio e fim). A câmera segue o rosto de quem está falando.',
    subjectHint: 'podcast Broxada Sinistra'
  },
  {
    key: 'wide',
    text: 'Qualquer vídeo 16:9. O quadro inteiro vai no meio do vídeo vertical, com o fundo desfocado em volta.',
    subjectHint: 'canal do Bistecone'
  }
]

/** Novo perfil: nome, tipo de clipe e de quem são os vídeos (vai pro prompt da IA). */
export function NewProfileModal({ onClose }: { onClose: () => void }) {
  const toast = useStore((s) => s.toast)
  const selectProfile = useStore((s) => s.selectProfile)
  const [name, setName] = useState('')
  const [kind, setKind] = useState<ClipKind>('podcast')
  const [subject, setSubject] = useState('')
  const [busy, setBusy] = useState(false)
  const hint = KINDS.find((k) => k.key === kind)!.subjectHint

  const create = async (): Promise<void> => {
    setBusy(true)
    try {
      const p = await call('profiles:create', { name, kind, subject })
      useStore.setState({ profiles: await call('profiles:list') })
      await selectProfile(p.id)
      onClose()
      toast('success', `Perfil ${p.name} criado. Conecte as contas e o canal em Configurações.`)
    } catch (e) {
      toast('error', errorText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title="Novo perfil"
      wide
      onClose={onClose}
      actions={
        <>
          <button className="btn" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn primary" disabled={!name.trim() || busy} onClick={() => void create()}>
            {busy && <span className="spinner" />}
            Criar perfil
          </button>
        </>
      }
    >
      <span className="hint">
        Cada perfil é um canal de cortes: contas, logo, legenda, jeito de escrever, canal vigiado e fila de postagem próprios.
      </span>
      <label className="field">
        Nome do perfil
        <input className="input" autoFocus placeholder="ex.: cortes do broxada" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} />
      </label>
      <div className="field">
        Que tipo de clipe?
        <div className="kind-grid" role="radiogroup" aria-label="Tipo de clipe">
          {KINDS.map((k) => (
            <button key={k.key} className="kind-card" role="radio" aria-checked={kind === k.key} onClick={() => setKind(k.key)}>
              <span className="kind-title">
                {kind === k.key && <Icon name="check" size={14} color="#C4B5FD" strokeWidth={2.6} />}
                {KIND_LABEL[k.key]}
              </span>
              <span className="kind-text">{k.text}</span>
            </button>
          ))}
        </div>
      </div>
      <label className="field">
        De quem são os vídeos?
        <input className="input" placeholder={`ex.: ${hint}`} value={subject} onChange={(e) => setSubject(e.target.value)} />
        <span className="hint">A IA usa isso nos ganchos, nas legendas e nas hashtags.</span>
      </label>
    </Modal>
  )
}
