import { useEffect, useRef, useState } from 'react'
import { stageLabel, stageOrder } from '@shared/defaults'
import { fmtLong } from '@shared/time'
import type { ClipKind, Profile, ProjectCover, ProjectSummary, SourceStatus, VodDownload } from '@shared/types'
import { call, errorText, mediaUrl, useApiEvent } from '../api'
import { AppHeader } from '../components/AppHeader'
import { Icon } from '../components/Icon'
import { Modal } from '../components/Modal'
import { useActiveProfile, useStore } from '../store'

/** Como chamar os vídeos de cada tipo de perfil. */
const KIND_WORDS: Record<ClipKind, { title: string; one: string; empty: string }> = {
  gameplay: { title: 'Lives', one: 'live', empty: 'Nenhuma live ainda.' },
  podcast: { title: 'Episódios', one: 'episódio', empty: 'Nenhum episódio ainda.' },
  wide: { title: 'Vídeos', one: 'vídeo', empty: 'Nenhum vídeo ainda.' }
}

function StageList({ p }: { p: ProjectSummary }) {
  return (
    <div className="stage-list">
      {stageOrder(p.kind).map((k) => {
        const s = p.stages[k]
        return (
          <div key={k} className={`stage ${s.status}`} title={s.message}>
            <span className="stage-icon">
              {s.status === 'done' && <Icon name="check" size={12} color="#A78BFA" strokeWidth={2.6} />}
              {s.status === 'running' && <span className="spinner" style={{ width: 11, height: 11 }} />}
              {s.status === 'error' && <Icon name="alert" size={12} color="#FF8A8A" />}
              {s.status === 'skipped' && <Icon name="x" size={12} color="#9396B3" />}
            </span>
            <span className="stage-name">{stageLabel(p.kind, k)}</span>
            {s.status === 'running' && <span className="mono stage-pct">{Math.round(s.progress * 100)}%</span>}
            {(s.status === 'error' || s.status === 'skipped') && s.message && <span className="stage-msg">{s.message.split('\n')[0]}</span>}
          </div>
        )
      })}
    </div>
  )
}

const dateFmt = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' })

/** Capa do card: primeiro quadro do corte; toca sem som com o mouse em cima. */
function CoverVideo({ cover }: { cover: ProjectCover }) {
  const ref = useRef<HTMLVideoElement | null>(null)
  const src = mediaUrl(cover.videoPath)
  if (!src) {
    return (
      <div className="project-cover empty">
        <Icon name="scissors" size={18} color="#9396B3" />
      </div>
    )
  }
  const restart = (): void => {
    const v = ref.current
    if (v) v.currentTime = cover.videoStart
  }
  return (
    <div className={`project-cover${cover.vertical ? ' vertical' : ''}`}>
      <video
        ref={ref}
        src={`${src}#t=${cover.videoStart}`}
        muted
        playsInline
        loop
        preload="metadata"
        onMouseEnter={() => void ref.current?.play().catch(() => undefined)}
        onMouseLeave={() => {
          ref.current?.pause()
          restart()
        }}
      />
    </div>
  )
}

function ProjectCard({ p, focused }: { p: ProjectSummary; focused: boolean }) {
  const openProject = useStore((s) => s.openProject)
  const toast = useStore((s) => s.toast)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const analyzing = p.status === 'analyzing' || p.status === 'queued'
  const stageErrors = Object.values(p.stages).some((s) => s.status === 'error')
  const statusChip =
    p.status === 'ready' ? (
      <span className="chip violet">Pronta</span>
    ) : p.status === 'error' ? (
      <span className="chip error">Erro</span>
    ) : p.status === 'queued' ? (
      <span className="chip">Na fila</span>
    ) : (
      <span className="chip blue">
        <span className="spinner" style={{ width: 9, height: 9 }} /> Analisando
      </span>
    )

  return (
    <div
      className={`project-card${focused ? ' focused' : ''}`}
      ref={(el) => {
        if (el && focused) el.scrollIntoView({ block: 'center' })
      }}
    >
      <div className="project-top">
        <div style={{ display: 'flex', gap: 14, alignItems: 'center', minWidth: 0 }}>
          {p.cover && <CoverVideo cover={p.cover} />}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', minWidth: 0 }}>
              <span className="project-title" title={p.cover?.title ?? p.name}>
                {p.cover?.title ?? p.name}
              </span>
              {statusChip}
              {p.auto && <span className="chip blue">automático</span>}
            </div>
            {p.cover && (
              <span style={{ fontSize: 13, color: 'var(--text-3)' }}>
                {p.cover.postedAt
                  ? `postado em ${dateFmt.format(new Date(p.cover.postedAt))}`
                  : `ainda não postado · importado em ${dateFmt.format(new Date(p.createdAt))}`}
              </span>
            )}
            <span className="mono" style={{ fontSize: 12, color: 'var(--muted)' }}>
              {p.durationSec ? fmtLong(p.durationSec) : '—'} · {p.clipCount} momentos · {p.approvedCount} aprovados
            </span>
            {p.cover && (
              <span className="mono project-id" title={p.name}>
                {p.name}
              </span>
            )}
          </div>
        </div>
        <div className="project-actions">
          <button className="btn sm" onClick={() => void call('projects:open-folder', p.id)} aria-label="Abrir pasta do projeto" title="Abrir pasta">
            <Icon name="folder" size={15} />
          </button>
          {stageErrors && !analyzing ? (
            <button
              className="btn sm soft"
              title="Roda de novo só as etapas que deram erro"
              onClick={() => void call('projects:retry', p.id).catch((e) => toast('error', errorText(e)))}
            >
              <Icon name="refresh" size={14} /> Continuar análise
            </button>
          ) : (
            <button
              className="btn sm"
              disabled={analyzing}
              title="Refazer a análise do zero (mantém os cortes aprovados)"
              onClick={() => void call('projects:reanalyze', p.id).catch((e) => toast('error', errorText(e)))}
            >
              <Icon name="refresh" size={14} /> Reanalisar
            </button>
          )}
          <button className="btn sm danger" aria-label="Excluir projeto" title="Excluir projeto" onClick={() => setConfirmDelete(true)}>
            <Icon name="trash" size={15} />
          </button>
          <button className="btn sm" disabled={p.approvedCount === 0} onClick={() => void openProject(p.id, 'revisar')}>
            Revisar e postar
          </button>
          <button className="btn primary" disabled={p.clipCount === 0 && !analyzing} onClick={() => void openProject(p.id, 'clipar')}>
            Clipar
            <Icon name="arrowRight" color="#FFFFFF" strokeWidth={2.4} />
          </button>
        </div>
      </div>
      {(focused || analyzing || p.status === 'error' || stageErrors) && <StageList p={p} />}
      {p.status === 'error' && p.error && (
        <div className="callout error">
          <Icon name="alert" />
          <span>{p.error.split('\n')[0]}</span>
        </div>
      )}
      {confirmDelete && (
        <Modal
          title={`Excluir ${p.name}?`}
          onClose={() => setConfirmDelete(false)}
          actions={
            <>
              <button className="btn" onClick={() => setConfirmDelete(false)}>
                Cancelar
              </button>
              <button
                className="btn danger"
                onClick={() => {
                  setConfirmDelete(false)
                  void call('projects:delete', p.id)
                }}
              >
                Excluir projeto
              </button>
            </>
          }
        >
          <span className="hint">Apaga a análise, os previews e os vídeos renderizados deste projeto. O arquivo bruto da live não é apagado.</span>
        </Modal>
      )}
    </div>
  )
}

function LinkModal({ onClose, gameplay }: { onClose: () => void; gameplay: boolean }) {
  const toast = useStore((s) => s.toast)
  const [url, setUrl] = useState('')
  const start = async (): Promise<void> => {
    try {
      await call('projects:import-url', url.trim())
      toast('info', 'Baixando o vídeo. A análise começa quando terminar.')
      onClose()
    } catch (e) {
      toast('error', errorText(e))
    }
  }
  return (
    <Modal
      title="Baixar vídeo por link"
      onClose={onClose}
      actions={
        <>
          <button className="btn" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn primary" disabled={!url.trim()} onClick={() => void start()}>
            Baixar e analisar
          </button>
        </>
      }
    >
      <span className="hint">
        Link de um vídeo do YouTube ou de um VOD da Twitch. Você revisa os cortes antes de postar (pra baixar sozinho, aponte o canal em Configurações).
        {gameplay && ' O vídeo baixado tem uma faixa de áudio só, então a detecção de risada e grito fica menos precisa e não dá pra tirar a música do corte.'}
      </span>
      <label className="field">
        Link do vídeo
        <input
          className="input mono"
          autoFocus
          placeholder="https://www.youtube.com/watch?v=... ou https://www.twitch.tv/videos/..."
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
      </label>
    </Modal>
  )
}

const timeFmt = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' })

/** Canal vigiado do perfil: link, quando olhou, o que está baixando e a postagem automática. */
function SourceBar({ profile, status }: { profile: Profile; status: SourceStatus | null }) {
  const go = useStore((s) => s.go)
  const toast = useStore((s) => s.toast)
  const src = profile.source
  const ap = profile.autoPost
  if (!src) {
    if (profile.kind === 'gameplay') return null
    return (
      <div className="watch-bar">
        <Icon name="link" color="#9396B3" />
        <span style={{ fontSize: 13 }}>Aponte o canal que você vai clipar e o Clipador baixa cada vídeo novo sozinho.</span>
        <span style={{ flexGrow: 1 }} />
        <button className="btn xs" onClick={() => go({ name: 'settings' })}>
          Apontar canal
        </button>
      </div>
    )
  }
  return (
    <div className="watch-bar source-bar">
      <Icon name="eye" color={src.enabled ? '#A78BFA' : '#9396B3'} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
        <span style={{ fontSize: 13 }}>
          {src.enabled ? 'Vigiando o canal' : 'Canal vigiado desligado'}{' '}
          <span className="mono" style={{ color: 'var(--text-3)' }}>
            {src.url}
          </span>
        </span>
        <span className="hint" style={{ fontSize: 12 }}>
          {status?.checking
            ? 'Olhando o canal agora…'
            : status?.lastCheckAt
              ? `Olhou às ${timeFmt.format(new Date(status.lastCheckAt))}${status.nextCheckAt && src.enabled ? ` · próxima às ${timeFmt.format(new Date(status.nextCheckAt))}` : ''}`
              : 'Ainda não olhou o canal.'}
          {status?.lastError && <span style={{ color: 'var(--warn)' }}> · {status.lastError}</span>}
        </span>
      </div>
      <span style={{ flexGrow: 1 }} />
      {status?.download && (
        <span className="chip blue" title={status.download.title}>
          <span className="spinner" style={{ width: 9, height: 9 }} />
          Baixando {Math.round(status.download.progress * 100)}%
        </span>
      )}
      {ap.enabled ? (
        <span className={`chip ${ap.paused ? 'warn' : 'violet'}`}>
          {ap.paused ? 'Postagem automática pausada' : `Postagem automática · ${ap.perDay} por dia`}
        </span>
      ) : (
        <span className="chip">Você revisa antes de postar</span>
      )}
      <button
        className="btn xs"
        disabled={!!status?.checking || !!status?.download}
        onClick={() => void call('sources:check').catch((e) => toast('error', errorText(e)))}
      >
        <Icon name="refresh" size={13} /> Olhar agora
      </button>
    </div>
  )
}

export function Home() {
  const projects = useStore((s) => s.projects)
  const focus = useStore((s) => (s.route.name === 'home' ? s.route.focus : undefined))
  const watcher = useStore((s) => s.watcher)
  const components = useStore((s) => s.components)
  const go = useStore((s) => s.go)
  const toast = useStore((s) => s.toast)
  const profile = useActiveProfile()
  const source = useStore((s) => s.source)
  const kind = profile?.kind ?? 'gameplay'
  const words = KIND_WORDS[kind]
  const [linkOpen, setLinkOpen] = useState(false)
  const [vod, setVod] = useState<VodDownload | null>(null)
  useApiEvent('vod:progress', (v) => setVod(v.status === 'downloading' ? v : null))
  const missing = components.filter((c) => !c.ready && c.key !== 'ffmpeg' && c.key !== 'ytdlp')
  // aprovados, capa e data de post mudam nas outras telas: atualiza ao voltar
  useEffect(() => {
    void call('projects:list').then((projects) => useStore.setState({ projects }))
  }, [])

  const importFile = async (): Promise<void> => {
    try {
      const p = await call('projects:import', null)
      if (p) toast('info', `${p.name} importada. A análise começou.`)
    } catch (e) {
      toast('error', errorText(e))
    }
  }

  return (
    <>
      <AppHeader
        title="Clipador"
        subtitle={kind === 'gameplay' ? 'cortes automáticos das lives' : 'cortes automáticos'}
        actions={
          <>
            <button className="btn" onClick={() => go({ name: 'posts' })}>
              <Icon name="clock" />
              Agendados
            </button>
            <button className="btn" onClick={() => go({ name: 'settings' })}>
              <Icon name="gear" />
              Configurações
            </button>
            <button className="btn" onClick={() => setLinkOpen(true)}>
              <Icon name="download" />
              Baixar por link
            </button>
            <button className="btn primary" onClick={() => void importFile()}>
              <Icon name="upload" color="#FFFFFF" />
              {kind === 'gameplay' ? 'Importar gravação' : 'Importar vídeo'}
            </button>
          </>
        }
      />
      <main className="screen home">
        {missing.length > 0 && (
          <div className="callout warn">
            <Icon name="alert" color="#FFC48A" />
            <span>
              Falta baixar: {missing.map((c) => c.label).join(', ')}. Sem isso a análise usa só o volume do áudio.{' '}
              <button className="link-btn" onClick={() => go({ name: 'settings' })}>
                Baixar nas configurações
              </button>
            </span>
          </div>
        )}

        {profile && <SourceBar profile={profile} status={source} />}

        {watcher && (kind === 'gameplay' || watcher.enabled) && (
          <div className="watch-bar">
            <Icon name="eye" color={watcher.enabled && watcher.exists ? '#A78BFA' : '#9396B3'} />
            <span style={{ fontSize: 13 }}>
              {watcher.enabled ? 'Vigiando' : 'Pasta vigiada desligada'}{' '}
              <span className="mono" style={{ color: 'var(--text-3)' }}>
                {watcher.folder}
              </span>
              {watcher.enabled && !watcher.exists && <span style={{ color: 'var(--warn)' }}> · pasta não existe</span>}
            </span>
            <span style={{ flexGrow: 1 }} />
            {watcher.pending.length > 0 && (
              <span className="chip blue">
                <span className="spinner" style={{ width: 9, height: 9 }} />
                Gravando ou copiando: {watcher.pending.join(', ')}
              </span>
            )}
            <button className="btn xs" onClick={() => go({ name: 'settings' })}>
              Trocar pasta
            </button>
          </div>
        )}

        {vod && (
          <div className="analysis-banner">
            <span className="spinner" />
            <div style={{ flexGrow: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span style={{ fontSize: 13 }}>
                Baixando o vídeo <span className="mono muted">{Math.round(vod.progress * 100)}%</span>
              </span>
              <div className="progress">
                <span style={{ width: `${vod.progress * 100}%` }} />
              </div>
            </div>
          </div>
        )}

        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 600 }}>{words.title}</h1>
          <span className="muted" style={{ fontSize: 13 }}>
            {profile?.source
              ? `quando sai ${words.one} novo no canal, ele aparece aqui sozinho`
              : kind === 'gameplay'
                ? 'quando o OBS termina de gravar na pasta vigiada, a live aparece aqui sozinha'
                : 'baixe por link ou aponte o canal em Configurações'}
          </span>
        </div>

        {projects.length === 0 ? (
          <div className="empty">
            <Icon name="scissors" size={32} color="#A78BFA" />
            <span style={{ fontSize: 15 }}>{words.empty}</span>
            <span className="hint" style={{ maxWidth: 460 }}>
              {kind === 'gameplay'
                ? 'Grave no OBS em MKV com as faixas separadas (1 mix, 2 microfone, 3 jogo, 4 Discord, 5 música) na pasta vigiada, ou importe um arquivo.'
                : 'Aponte o canal em Configurações pra baixar cada vídeo novo sozinho, baixe um vídeo por link ou importe um arquivo.'}
            </span>
            <div style={{ display: 'flex', gap: 8 }}>
              {kind !== 'gameplay' && (
                <button className="btn" onClick={() => setLinkOpen(true)}>
                  Baixar por link
                </button>
              )}
              <button className="btn primary" onClick={() => void importFile()}>
                {kind === 'gameplay' ? 'Importar gravação' : 'Importar vídeo'}
              </button>
            </div>
          </div>
        ) : (
          projects.map((p) => <ProjectCard key={p.id} p={p} focused={focus === p.id} />)
        )}
      </main>
      {linkOpen && <LinkModal gameplay={kind === 'gameplay'} onClose={() => setLinkOpen(false)} />}
    </>
  )
}
