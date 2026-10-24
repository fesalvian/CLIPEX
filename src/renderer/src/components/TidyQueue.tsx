import { useEffect, useState } from 'react'
import type { TidyChange, TidyPreview } from '@shared/ipc'
import type { Network } from '@shared/types'
import { call, errorText } from '../api'
import { fmtWhen } from '../lib/posts'
import { useStore } from '../store'
import { Icon } from './Icon'
import { Modal } from './Modal'

const NET_LABEL: Record<Network, string> = { instagram: 'Reels', tiktok: 'TikTok', youtube: 'Shorts' }
const ORDER: Network[] = ['youtube', 'instagram', 'tiktok']
const PER_DAY = [1, 2, 3]

/**
 * "Organizar fila": tira os posts repetidos (o mesmo corte duas vezes na mesma rede) e
 * espalha o resto, no máximo N por dia em cada rede. Mostra o antes e depois e só aplica
 * depois de confirmar.
 */
export function TidyQueue({ onClose }: { onClose: () => void }) {
  const toast = useStore((s) => s.toast)
  const [perDay, setPerDay] = useState(2)
  const [preview, setPreview] = useState<TidyPreview | null>(null)
  const [busy, setBusy] = useState(false)
  const [errors, setErrors] = useState<string[]>([])

  const load = (n: number): void => {
    setPreview(null)
    void call('posts:tidy-preview', n).then(setPreview, (e) => toast('error', errorText(e)))
  }
  useEffect(() => load(perDay), [perDay]) // eslint-disable-line react-hooks/exhaustive-deps

  const reconnect = async (): Promise<void> => {
    setBusy(true)
    try {
      const r = await call('posts:connect', 'youtube')
      if (!r.ok) toast('error', r.error ?? 'Não deu pra conectar o YouTube.')
      load(perDay)
    } finally {
      setBusy(false)
    }
  }

  const apply = async (): Promise<void> => {
    setBusy(true)
    try {
      const r = await call('posts:tidy-apply', perDay)
      setErrors(r.errors)
      if (r.errors.length === 0) {
        toast('success', `Fila organizada: ${r.applied} ${r.applied === 1 ? 'mudança' : 'mudanças'}.`)
        onClose()
      } else {
        toast('error', `${r.applied} mudanças feitas, ${r.errors.length} com erro.`)
        load(perDay)
      }
    } catch (e) {
      toast('error', errorText(e))
    } finally {
      setBusy(false)
    }
  }

  const changes = preview?.changes ?? []
  const cancels = changes.filter((c) => c.kind === 'cancel')
  const removedYt = cancels.filter((c) => c.remote).length
  const moves = changes.length - cancels.length
  const blocked = !!preview?.youtubeNeedsReconnect

  return (
    <Modal
      title="Organizar a fila"
      onClose={onClose}
      wide
      actions={
        <>
          <button className="btn" onClick={onClose}>
            Fechar
          </button>
          <button className="btn primary" disabled={busy || !preview || changes.length === 0 || blocked} onClick={() => void apply()}>
            {busy && <span className="spinner" />}
            Aplicar {changes.length} {changes.length === 1 ? 'mudança' : 'mudanças'}
          </button>
        </>
      }
    >
      <span className="hint">
        Tira os posts repetidos (o mesmo corte duas vezes na mesma rede) e espalha o resto nos horários de cada rede, na
        mesma ordem. Nada muda antes de você aplicar.
      </span>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ fontSize: 13 }}>Posts por dia em cada rede</span>
        <div className="pills" role="group" aria-label="Posts por dia em cada rede">
          {PER_DAY.map((n) => (
            <button key={n} className="pill-btn mono" aria-pressed={perDay === n} onClick={() => setPerDay(n)}>
              {n}
            </button>
          ))}
        </div>
      </div>

      {blocked && (
        <div className="callout warn">
          <Icon name="alert" />
          <span style={{ flexGrow: 1 }}>
            Tem Shorts já agendados no YouTube pra mudar. Reconecte o YouTube e aceite a permissão de gerenciar os vídeos pra
            o Clipador poder mudar o horário e apagar os repetidos.
          </span>
          <button className="btn sm" disabled={busy} onClick={() => void reconnect()}>
            Reconectar YouTube
          </button>
        </div>
      )}

      {errors.length > 0 && (
        <div className="callout error" role="alert" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
          {errors.map((e, i) => (
            <span key={i}>{e}</span>
          ))}
        </div>
      )}

      {!preview ? (
        <div className="empty">
          <span className="spinner" />
        </div>
      ) : changes.length === 0 ? (
        <div className="callout blue">
          <Icon name="check" />
          <span>A fila já está organizada: nenhum repetido e no máximo {perDay} por dia em cada rede.</span>
        </div>
      ) : (
        <>
          <span style={{ fontSize: 13 }}>
            {cancels.length > 0 && (
              <>
                <b>{cancels.length}</b> {cancels.length === 1 ? 'repetido cancelado' : 'repetidos cancelados'}
                {removedYt > 0 && ` (${removedYt} ${removedYt === 1 ? 'Short apagado' : 'Shorts apagados'} do YouTube)`}
                {moves > 0 && ' · '}
              </>
            )}
            {moves > 0 && (
              <>
                <b>{moves}</b> {moves === 1 ? 'muda' : 'mudam'} de horário
              </>
            )}
          </span>
          <div className="tidy-list">
            {ORDER.map((net) => {
              const list = changes.filter((c) => c.network === net)
              if (list.length === 0) return null
              return (
                <section key={net} className="tidy-net" aria-label={NET_LABEL[net]}>
                  <span className="label">
                    {NET_LABEL[net]} · {list.length}
                  </span>
                  {list.map((c) => (
                    <TidyRow key={c.postId} c={c} />
                  ))}
                </section>
              )
            })}
          </div>
        </>
      )}
    </Modal>
  )
}

function TidyRow({ c }: { c: TidyChange }) {
  return (
    <div className={`tidy-row${c.kind === 'cancel' ? ' cancel' : ''}`}>
      <span className="post-names">
        <span className="post-clip">{c.clipName}</span>
        <span className="post-project">{c.projectName}</span>
      </span>
      <span className="mono tidy-when">
        {c.kind === 'cancel' ? (
          <>
            {fmtWhen(c.from)} · <b>{c.remote ? 'repetido: apagar do YouTube' : 'repetido: cancelar'}</b>
          </>
        ) : (
          <>
            {fmtWhen(c.from)} <Icon name="arrowRight" size={12} /> <b>{fmtWhen(c.to)}</b>
          </>
        )}
      </span>
    </div>
  )
}
