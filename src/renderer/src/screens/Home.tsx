import { useState } from 'react'
import { STAGE_LABEL, STAGE_ORDER } from '@shared/defaults'
import { fmtLong } from '@shared/time'
import type { ProjectSummary, VodDownload } from '@shared/types'
import { call, errorText, useApiEvent } from '../api'
import { AppHeader } from '../components/AppHeader'
import { Icon } from '../components/Icon'
import { Modal } from '../components/Modal'
import { useStore } from '../store'

function StageList({ p }: { p: ProjectSummary }) {
  return (
    <div className="stage-list">
      {STAGE_ORDER.map((k) => {
        const s = p.stages[k]
        return (
          <div key={k} className={`stage ${s.status}`} title={s.message}>
            <span className="stage-icon">
              {s.status === 'done' && <Icon name="check" size={12} color="#A78BFA" strokeWidth={2.6} />}
              {s.status === 'running' && <span className="spinner" style={{ width: 11, height: 11 }} />}
              {s.status === 'error' && <Icon name="alert" size={12} color="#FF8A8A" />}
              {s.status === 'skipped' && <Icon name="x" size={12} color="#9396B3" />}
            </span>
            <span className="stage-name">{STAGE_LABEL[k]}</span>
            {s.status === 'running' && <span className="mono stage-pct">{Math.round(s.progress * 100)}%</span>}
            {(s.status === 'error' || s.status === 'skipped') && s.message && <span className="stage-msg">{s.message.split('\n')[0]}</span>}
          </div>
        )
      })}
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
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <span style={{ fontWeight: 600, fontSize: 17 }}>{p.name}</span>
            {statusChip}
          </div>
          <span className="mono" style={{ fontSize: 12, color: 'var(--muted)' }}>
            {p.durationSec ? fmtLong(p.durationSec) : '—'} · {p.clipCount} momentos · {p.approvedCount} aprovados
          </span>
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

function TwitchModal({ onClose }: { onClose: () => void }) {
  const toast = useStore((s) => s.toast)
  const [url, setUrl] = useState('')
  const start = async (): Promise<void> => {
    try {
      await call('projects:import-twitch', url)
      onClose()
    } catch (e) {
      toast('error', errorText(e))
    }
  }
  return (
    <Modal
      title="Baixar VOD da Twitch"
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
        Plano B quando não tem a gravação local. O VOD tem uma faixa de áudio só (tudo misturado), então a detecção de risada e grito fica menos precisa e não dá pra tirar a música do corte.
      </span>
      <label className="field">
        Link do vídeo
        <input className="input mono" autoFocus placeholder="https://www.twitch.tv/videos/..." value={url} onChange={(e) => setUrl(e.target.value)} />
      </label>
    </Modal>
  )
}

export function Home() {
  const projects = useStore((s) => s.projects)
  const focus = useStore((s) => (s.route.name === 'home' ? s.route.focus : undefined))
  const watcher = useStore((s) => s.watcher)
  const components = useStore((s) => s.components)
  const go = useStore((s) => s.go)
  const toast = useStore((s) => s.toast)
  const [twitchOpen, setTwitchOpen] = useState(false)
  const [vod, setVod] = useState<VodDownload | null>(null)
  useApiEvent('vod:progress', (v) => setVod(v.status === 'downloading' ? v : null))
  const missing = components.filter((c) => !c.ready && c.key !== 'ffmpeg' && c.key !== 'ytdlp')

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
        subtitle="cortes automáticos das lives"
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
            <button className="btn" onClick={() => setTwitchOpen(true)}>
              <Icon name="download" />
              VOD da Twitch
            </button>
            <button className="btn primary" onClick={() => void importFile()}>
              <Icon name="upload" color="#FFFFFF" />
              Importar gravação
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

        {watcher && (
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
                Baixando o VOD da Twitch <span className="mono muted">{Math.round(vod.progress * 100)}%</span>
              </span>
              <div className="progress">
                <span style={{ width: `${vod.progress * 100}%` }} />
              </div>
            </div>
          </div>
        )}

        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 600 }}>Lives</h1>
          <span className="muted" style={{ fontSize: 13 }}>
            quando o OBS termina de gravar na pasta vigiada, a live aparece aqui sozinha
          </span>
        </div>

        {projects.length === 0 ? (
          <div className="empty">
            <Icon name="scissors" size={32} color="#A78BFA" />
            <span style={{ fontSize: 15 }}>Nenhuma live ainda.</span>
            <span className="hint" style={{ maxWidth: 460 }}>
              Grave no OBS em MKV com as faixas separadas (1 mix, 2 microfone, 3 jogo, 4 Discord, 5 música) na pasta vigiada, ou importe um arquivo.
            </span>
            <button className="btn primary" onClick={() => void importFile()}>
              Importar gravação
            </button>
          </div>
        ) : (
          projects.map((p) => <ProjectCard key={p.id} p={p} focused={focus === p.id} />)
        )}
      </main>
      {twitchOpen && <TwitchModal onClose={() => setTwitchOpen(false)} />}
    </>
  )
}
