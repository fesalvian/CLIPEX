import { useEffect, useState } from 'react'
import { DEFAULT_PROFILE_ID, KIND_LABEL, PROFILE_COLORS } from '@shared/defaults'
import type { ProfilePatch } from '@shared/ipc'
import { NETWORKS, type AutoPost, type AutoSource, type Network, type Profile } from '@shared/types'
import { call, errorText } from '../api'
import { useStore } from '../store'
import { Icon } from './Icon'
import { Modal } from './Modal'
import { ProfileAvatar } from './ProfileAvatar'

const NET_SHORT: Record<Network, string> = { instagram: 'Reels', tiktok: 'TikTok', youtube: 'Shorts' }

function useProfileUpdate(profile: Profile): (patch: ProfilePatch) => Promise<void> {
  const toast = useStore((s) => s.toast)
  return async (patch) => {
    try {
      const next = await call('profiles:update', profile.id, patch)
      useStore.setState({ profiles: useStore.getState().profiles.map((p) => (p.id === next.id ? next : p)) })
    } catch (e) {
      toast('error', errorText(e))
    }
  }
}

/** Nome, de quem são os vídeos, cor e exclusão do perfil. */
export function ProfileInfoPanel({ profile }: { profile: Profile }) {
  const update = useProfileUpdate(profile)
  const selectProfile = useStore((s) => s.selectProfile)
  const toast = useStore((s) => s.toast)
  const [name, setName] = useState(profile.name)
  const [subject, setSubject] = useState(profile.subject)
  const [confirm, setConfirm] = useState(false)
  useEffect(() => {
    setName(profile.name)
    setSubject(profile.subject)
  }, [profile.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const remove = async (): Promise<void> => {
    try {
      const list = await call('profiles:delete', profile.id)
      useStore.setState({ profiles: list })
      await selectProfile(DEFAULT_PROFILE_ID)
      toast('info', `Perfil ${profile.name} excluído.`)
    } catch (e) {
      toast('error', errorText(e))
    }
  }

  return (
    <section className="panel">
      <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
        <ProfileAvatar profile={{ name: name || profile.name, color: profile.color }} size={44} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span className="panel-title">Perfil · {profile.name}</span>
          <span className="hint">
            {KIND_LABEL[profile.kind]} · tudo nesta tela vale só pra este perfil, menos o que estiver marcado “todos os perfis”.
          </span>
        </div>
      </div>
      <div className="settings-grid">
        <label className="field">
          Nome
          <input
            className="input"
            value={name}
            maxLength={40}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => name.trim() && name !== profile.name && void update({ name: name.trim() })}
          />
        </label>
        <label className="field">
          De quem são os vídeos (vai pro prompt da IA)
          <input
            className="input"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            onBlur={() => subject !== profile.subject && void update({ subject: subject.trim() })}
          />
        </label>
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <span className="label">Cor</span>
        {PROFILE_COLORS.map((c) => (
          <button
            key={c}
            className="color-dot"
            aria-label={`Cor ${c}`}
            aria-pressed={profile.color === c}
            style={{ background: c }}
            onClick={() => void update({ color: c })}
          />
        ))}
        <span style={{ flexGrow: 1 }} />
        {profile.id !== DEFAULT_PROFILE_ID && (
          <button className="btn sm danger" onClick={() => setConfirm(true)}>
            <Icon name="trash" size={14} /> Excluir perfil
          </button>
        )}
      </div>
      {confirm && (
        <Modal
          title={`Excluir o perfil ${profile.name}?`}
          onClose={() => setConfirm(false)}
          actions={
            <>
              <button className="btn" onClick={() => setConfirm(false)}>
                Cancelar
              </button>
              <button
                className="btn danger"
                onClick={() => {
                  setConfirm(false)
                  void remove()
                }}
              >
                Excluir perfil
              </button>
            </>
          }
        >
          <span className="hint">
            Apaga os projetos, cortes e agendamentos deste perfil. Os vídeos brutos e os posts que já saíram nas redes ficam.
          </span>
        </Modal>
      )}
    </section>
  )
}

/** Canal vigiado: o app baixa cada vídeo novo do canal e começa a análise sozinho. */
export function SourcePanel({ profile }: { profile: Profile }) {
  const toast = useStore((s) => s.toast)
  const status = useStore((s) => s.source)
  const src = profile.source
  const [url, setUrl] = useState(src?.url ?? '')
  useEffect(() => setUrl(profile.source?.url ?? ''), [profile.id, profile.source?.url])

  const save = async (patch: Partial<AutoSource> | null): Promise<void> => {
    try {
      await call('sources:set', patch)
      useStore.setState({ profiles: await call('profiles:list'), source: await call('sources:status') })
    } catch (e) {
      toast('error', errorText(e))
    }
  }

  return (
    <section className="panel">
      <span className="panel-title">Download automático</span>
      <span className="hint">
        Aponte o canal que você vai clipar (YouTube ou Twitch). O Clipador olha o canal de tempos em tempos e, quando sai vídeo novo, baixa e começa a análise. Lives que ainda estão rolando esperam acabar. O app precisa estar aberto ou na bandeja.
      </span>
      <div style={{ display: 'flex', gap: 8 }}>
        <input
          className="input mono"
          aria-label="Link do canal"
          placeholder="https://www.youtube.com/@canal ou https://www.twitch.tv/canal"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
        <button className="btn" disabled={!url.trim() || url.trim() === src?.url} onClick={() => void save({ url: url.trim() })}>
          {src ? 'Trocar canal' : 'Vigiar canal'}
        </button>
      </div>
      {!src && (
        <span className="hint">
          Na primeira olhada, os vídeos que já estavam no canal ficam de fora, menos o mais recente (dá pra mudar depois).
        </span>
      )}
      {src && (
        <>
          <label className="check">
            <input type="checkbox" checked={src.enabled} onChange={() => void save({ enabled: !src.enabled })} />
            Vigiar este canal
          </label>
          <div className="settings-grid">
            <label className="field">
              Olhar o canal a cada
              <select className="select" value={src.checkEveryMin} onChange={(e) => void save({ checkEveryMin: Number(e.target.value) })}>
                {[15, 30, 60, 120, 360].map((v) => (
                  <option key={v} value={v}>
                    {v < 60 ? `${v} min` : `${v / 60} h`}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              Ignorar vídeos com menos de
              <select className="select" value={src.minMinutes} onChange={(e) => void save({ minMinutes: Number(e.target.value) })}>
                {[3, 5, 10, 20, 40].map((v) => (
                  <option key={v} value={v}>
                    {v} min
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              Qualidade do download
              <select className="select" value={src.maxHeight} onChange={(e) => void save({ maxHeight: Number(e.target.value) as 720 | 1080 })}>
                <option value={1080}>1080p (melhor pro corte)</option>
                <option value={720}>720p (baixa mais rápido, ocupa menos)</option>
              </select>
            </label>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <span className="hint" style={{ flexGrow: 1 }}>
              {status?.lastCheckAt ? `Última olhada: ${new Date(status.lastCheckAt).toLocaleString('pt-BR')}` : 'Ainda não olhou o canal.'}
              {status?.lastError && <span style={{ color: 'var(--warn)' }}> · {status.lastError}</span>}
            </span>
            <button className="btn sm" disabled={!!status?.checking} onClick={() => void call('sources:check')}>
              {status?.checking ? <span className="spinner" /> : <Icon name="refresh" size={14} />} Olhar agora
            </button>
            <button className="btn sm danger" onClick={() => void save(null)}>
              Parar de vigiar
            </button>
          </div>
        </>
      )}
    </section>
  )
}

/** Postagem automática: escolhe, prepara, renderiza e agenda sozinho, sem revisão. */
export function AutoPostPanel({ profile }: { profile: Profile }) {
  const update = useProfileUpdate(profile)
  const ap = profile.autoPost
  const [blocklist, setBlocklist] = useState(ap.blocklist)
  const [confirmOn, setConfirmOn] = useState(false)
  useEffect(() => setBlocklist(profile.autoPost.blocklist), [profile.id]) // eslint-disable-line react-hooks/exhaustive-deps
  const set = (patch: Partial<AutoPost>): void => void update({ autoPost: { ...ap, ...patch } })
  const toggleNet = (n: Network): void => {
    const has = ap.networks.includes(n)
    set({ networks: has ? ap.networks.filter((x) => x !== n) : [...ap.networks, n] })
  }
  const total = ap.perDay * ap.days

  return (
    <section className={`panel${ap.enabled && !ap.paused ? ' auto-on' : ''}`}>
      <span className="panel-title">Postagem automática</span>
      <span className="hint">
        Quando um vídeo chega sozinho (canal vigiado ou pasta vigiada), o Clipador escolhe os melhores cortes, gera gancho, legenda e hashtags, renderiza e agenda tudo sem pedir revisão. Os vídeos que você importa à mão continuam passando por você.
      </span>
      <label className="check">
        <input type="checkbox" checked={ap.enabled} onChange={() => (ap.enabled ? set({ enabled: false }) : setConfirmOn(true))} />
        Postar sozinho, sem revisão
      </label>
      {ap.enabled && (
        <>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <span className="label">Onde postar</span>
            <div className="pills" role="group" aria-label="Redes da postagem automática">
              {NETWORKS.map((n) => (
                <button key={n} className="pill-btn" aria-pressed={ap.networks.includes(n)} onClick={() => toggleNet(n)}>
                  {NET_SHORT[n]}
                </button>
              ))}
            </div>
          </div>
          <div className="settings-grid">
            <label className="field">
              Cortes por dia em cada rede
              <select className="select" value={ap.perDay} onChange={(e) => set({ perDay: Number(e.target.value) })}>
                {[1, 2, 3, 4, 5].map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              Espalhar os cortes de um vídeo em até
              <select className="select" value={ap.days} onChange={(e) => set({ days: Number(e.target.value) })}>
                {[3, 7, 10, 14, 21, 30].map((v) => (
                  <option key={v} value={v}>
                    {v} dias
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              Nota mínima da IA
              <select className="select" value={ap.minScore} onChange={(e) => set({ minScore: Number(e.target.value) })}>
                {[50, 60, 65, 70, 75, 80, 85, 90].map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              Duração máxima de um corte
              <select className="select" value={ap.maxClipSec} onChange={(e) => set({ maxClipSec: Number(e.target.value) })}>
                <option value={60}>60 s</option>
                <option value={90}>90 s (limite do Reels via API)</option>
                <option value={120}>2 min</option>
                <option value={179}>3 min (limite do Shorts)</option>
              </select>
            </label>
          </div>
          <span className="hint">
            Até {total} cortes por vídeo, os de nota maior primeiro. Quando chega vídeo novo, os cortes dele passam na frente e os do vídeo anterior que ainda não saíram andam pra trás (os que passarem de {ap.days} dias saem da fila).
            {ap.maxClipSec > 90 && ap.networks.includes('instagram') && ' Atenção: Reels via API aceita até 90 s; cortes maiores falham no Instagram.'}
          </span>
          <label className="field">
            Termos proibidos (o corte que falar algum fica de fora)
            <textarea
              className="input"
              rows={2}
              placeholder="um por linha ou separados por vírgula: nomes, assuntos que você não quer no canal…"
              value={blocklist}
              onChange={(e) => setBlocklist(e.target.value)}
              onBlur={() => blocklist !== ap.blocklist && set({ blocklist })}
            />
          </label>
          <div className="callout warn" style={{ alignItems: 'center' }}>
            <Icon name="alert" color="#FFC48A" />
            <span style={{ flexGrow: 1 }}>
              {ap.paused
                ? 'Pausado: nada deste perfil é postado até você retomar. A fila continua guardada.'
                : 'Freio: pausa todos os posts deste perfil na hora, inclusive os que já estão na fila.'}
            </span>
            <button className="btn sm" onClick={() => set({ paused: !ap.paused })}>
              {ap.paused ? 'Retomar postagens' : 'Pausar postagens'}
            </button>
          </div>
          {ap.networks.includes('tiktok') && (
            <span className="hint">TikTok: enquanto o app do TikTok não for auditado, os vídeos chegam como rascunho (até 5 por dia) e você publica pelo app.</span>
          )}
        </>
      )}
      {confirmOn && (
        <Modal
          title="Postar sem revisão?"
          onClose={() => setConfirmOn(false)}
          actions={
            <>
              <button className="btn" onClick={() => setConfirmOn(false)}>
                Cancelar
              </button>
              <button
                className="btn primary"
                onClick={() => {
                  setConfirmOn(false)
                  set({ enabled: true, paused: false })
                }}
              >
                Ligar postagem automática
              </button>
            </>
          }
        >
          <span className="hint">
            Os cortes de {profile.name} vão ser postados nas contas deste perfil sem você ver antes. O que te protege é a nota mínima, os termos proibidos e o botão de pausa. Confira se as contas conectadas em “Contas” são as do canal de cortes, não as suas.
          </span>
        </Modal>
      )}
    </section>
  )
}
