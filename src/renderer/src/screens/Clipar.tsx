import { useEffect, useMemo, useRef, useState } from 'react'
import { STAGE_LABEL, STAGE_ORDER } from '@shared/defaults'
import { fmtClock, fmtDur, fmtLong, fmtTotal } from '@shared/time'
import type { CamSplit, Clip, ClipLayout, CropLayout, DetectedTag, Project, Watermark } from '@shared/types'
import { call, errorText } from '../api'
import { AppHeader } from '../components/AppHeader'
import { CropEditor } from '../components/CropEditor'
import { Icon, PauseIcon, PlayIcon } from '../components/Icon'
import { ManualClipModal } from '../components/ManualClipModal'
import { Preview916 } from '../components/Preview916'
import { WatermarkPanel } from '../components/WatermarkPanel'
import { Waveform } from '../components/Waveform'
import { usePreviewPlayer, type Player } from '../lib/player'
import { clipLabel, clipList, clipScore, useStore } from '../store'

type Filter = 'all' | 'laugh' | 'scream' | 'peak'

const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: 'Todos' },
  { key: 'laugh', label: 'Risadas' },
  { key: 'scream', label: 'Gritos' },
  { key: 'peak', label: 'Picos de áudio' }
]

export const TAG_INFO: Record<DetectedTag, { label: string; color: string }> = {
  laugh: { label: 'Risada', color: '#C4B5FD' },
  scream: { label: 'Grito', color: '#FF9F45' },
  peak: { label: 'Pico de áudio', color: '#3FC8E8' },
  manual: { label: 'Manual', color: '#F472B6' }
}

const LAYOUTS: { key: ClipLayout; label: string }[] = [
  { key: 'both', label: 'Cam + jogo' },
  { key: 'game', label: 'Só jogo' },
  { key: 'cam', label: 'Só cam' }
]
const SPLITS: CamSplit[] = [30, 40, 50]

export function projectSubtitle(p: Project | null): string {
  if (!p) return ''
  const file = p.sourcePath.split(/[\\/]/).pop() ?? ''
  if (!p.source) return file
  const fps = Math.round(p.source.fps)
  return `${file} · ${fmtLong(p.source.durationSec)} · ${p.source.height}p${fps}`
}

export function AnalysisBanner({ project }: { project: Project }) {
  if (project.status !== 'analyzing' && project.status !== 'queued') return null
  const running = STAGE_ORDER.find((k) => project.stages[k].status === 'running')
  const done = STAGE_ORDER.filter((k) => k !== 'proxy' && (project.stages[k].status === 'done' || project.stages[k].status === 'skipped')).length
  const st = running ? project.stages[running] : null
  return (
    <div className="analysis-banner">
      <span className="spinner" />
      <div style={{ flexGrow: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
        <span style={{ fontSize: 13 }}>
          {project.status === 'queued' ? 'Na fila pra análise' : `Analisando a live · ${running ? STAGE_LABEL[running] : 'preparando'}`}
          <span className="muted"> · etapa {Math.min(done + 1, STAGE_ORDER.length - 1)} de {STAGE_ORDER.length - 1}</span>
        </span>
        <div className="progress">
          <span style={{ width: `${Math.round((st?.progress ?? 0) * 100)}%` }} />
        </div>
      </div>
      <span className="hint">Os momentos aparecem aqui assim que são encontrados.</span>
    </div>
  )
}

function ClipRow({
  clip,
  selected,
  player,
  wave,
  onSelectPlay,
  onToggle
}: {
  clip: Clip
  selected: boolean
  player: Player
  wave: number[] | undefined
  onSelectPlay: () => void
  onToggle: () => void
}) {
  const previewClip = useStore((s) => s.previewClip)
  const patchClip = useStore((s) => s.patchClip)
  const loadWave = useStore((s) => s.loadWave)
  useEffect(() => {
    void loadWave(clip)
  }, [clip.id, loadWave]) // eslint-disable-line react-hooks/exhaustive-deps

  const isPlaying = selected && player.playing
  const busy = clip.stage === 'transcribing' || clip.stage === 'ranking' || (clip.stage === 'detected' && !clip.llm)
  const score = clipScore(clip)

  return (
    <div className={`clip-row${selected ? ' sel' : ''}${clip.approved ? '' : ' off'}`}>
      <div className="clip-use">
        <label>
          <input type="checkbox" checked={clip.approved} onChange={onToggle} aria-label={`Aprovar ${clipLabel(clip)}`} />
          <span>usar</span>
        </label>
      </div>

      <div className="clip-main">
        <div className="clip-top">
          <span className="clip-name">{clipLabel(clip)}</span>
          {clip.llm?.title && <span className="clip-title">{clip.llm.title}</span>}
          {clip.tags.map((t) => (
            <span key={t} className="chip">
              <span className="dot" style={{ background: TAG_INFO[t].color }} />
              {TAG_INFO[t].label}
            </span>
          ))}
          <span style={{ flexGrow: 1 }} />
          <span className="mono" style={{ fontSize: 12, color: 'var(--muted)' }}>
            na live {fmtClock(clip.peakSec)}
          </span>
          {clip.stage === 'error' ? (
            <span className="score warn" title={clip.stageError ?? ''}>
              <Icon name="alert" size={12} /> {score}
            </span>
          ) : (
            <span
              className={`score${clip.llm ? '' : ' pending'}`}
              title={clip.llm ? (clip.llm.reason || 'Nota de potencial da IA') : 'Nota provisória pelo áudio; a IA ainda vai avaliar'}
            >
              {busy && <span className="spinner" style={{ width: 10, height: 10 }} />}
              {clip.llm ? score : `~${score}`}
            </span>
          )}
        </div>

        <Waveform
          clip={clip}
          wave={wave}
          selected={selected}
          time={selected ? player.time : null}
          onCutChange={(cutIn, cutOut, final) => {
            if (final) void patchClip(clip.id, { cutIn, cutOut })
            else previewClip(clip.id, { cutIn, cutOut })
          }}
          onSeek={(sec) => {
            if (!selected) onSelectPlay()
            else player.seek(sec)
          }}
        />

        <div className="clip-times mono">
          <span>{fmtClock(clip.winStart)}</span>
          <span style={{ color: 'var(--text-3)' }}>
            corte: {fmtClock(clip.cutIn)} → {fmtClock(clip.cutOut)} · <span style={{ color: 'var(--violet-3)' }}>{fmtDur(clip.cutOut - clip.cutIn)}</span>
          </span>
          <span>{fmtClock(clip.winEnd)}</span>
        </div>
      </div>

      <div className="clip-play">
        <button className={`play-btn${isPlaying ? ' on' : ''}`} aria-label={isPlaying ? 'Pausar clipe' : 'Reproduzir clipe'} onClick={onSelectPlay}>
          {isPlaying ? <PauseIcon /> : <PlayIcon />}
        </button>
      </div>
    </div>
  )
}

export function Clipar() {
  const project = useStore((s) => s.project)
  const clipsMap = useStore((s) => s.clips)
  const settings = useStore((s) => s.settings)
  const waves = useStore((s) => s.waves)
  const patchClip = useStore((s) => s.patchClip)
  const openProject = useStore((s) => s.openProject)
  const toast = useStore((s) => s.toast)
  const updateSettings = useStore((s) => s.updateSettings)
  const setProject = useStore((s) => s.setProject)

  const [filter, setFilter] = useState<Filter>('all')
  const [selId, setSelId] = useState<string | null>(null)
  const [presetOn, setPresetOn] = useState(true)
  const [manualOpen, setManualOpen] = useState(false)
  const [wmDraft, setWmDraft] = useState<Watermark | null>(null)

  const clips = useMemo(() => clipList(clipsMap).sort((a, b) => clipScore(b) - clipScore(a) || a.number - b.number), [clipsMap])
  const visible = clips.filter((c) => filter === 'all' || c.tags.includes(filter))
  const selected = (selId ? clipsMap[selId] : null) ?? visible[0] ?? null
  const approved = clips.filter((c) => c.approved)
  const totalSec = approved.reduce((n, c) => n + (c.cutOut - c.cutIn), 0)

  const player = usePreviewPlayer(selected)
  const autoPlay = useRef(false)
  useEffect(() => {
    if (autoPlay.current && player.ready) {
      autoPlay.current = false
      player.play()
    }
  }, [player.ready, player])

  // corte sem preview (ex.: manual): pede pra gerar
  useEffect(() => {
    if (selected && !selected.previewPath && project?.stages.previews.status !== 'running') {
      void call('clips:ensure-preview', selected.id).catch(() => undefined)
    }
  }, [selected?.id, selected?.previewPath]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!project || !settings) {
    return (
      <>
        <AppHeader title="Carregando…" step="clipar" />
        <main className="screen">
          <div className="empty">
            <span className="spinner" />
          </div>
        </main>
      </>
    )
  }

  const effectiveWm: Watermark = wmDraft ?? selected?.watermark ?? settings.watermark

  const onSelectPlay = (c: Clip): void => {
    if (selected?.id === c.id) player.toggle()
    else {
      autoPlay.current = true
      setSelId(c.id)
    }
  }

  const commitCrop = async (crop: CropLayout): Promise<void> => {
    try {
      setProject(await call('projects:set-crop', project.id, crop, presetOn))
    } catch (e) {
      toast('error', errorText(e))
    }
  }

  const setWatermark = (wm: Watermark, final = true): void => {
    if (!final) {
      setWmDraft(wm)
      return
    }
    setWmDraft(null)
    if (selected) void patchClip(selected.id, { watermark: wm })
    else void updateSettings({ watermark: wm })
  }

  const applyWmAll = async (): Promise<void> => {
    const wm = effectiveWm
    await updateSettings({ watermark: wm })
    await Promise.all(clips.filter((c) => c.watermark).map((c) => patchClip(c.id, { watermark: null })))
    toast('success', 'Marca d’água aplicada em todos os cortes (e salva como padrão).')
  }

  const renderApproved = async (): Promise<void> => {
    if (approved.length === 0) return
    player.pause()
    await call('clips:prepare', approved.map((c) => c.id))
    await openProject(project.id, 'revisar')
  }

  const analyzing = project.status === 'analyzing' || project.status === 'queued'

  return (
    <>
      <AppHeader
        title={project.name}
        subtitle={projectSubtitle(project)}
        step="clipar"
        analyzing={analyzing}
        projectId={project.id}
        actions={
          <button className="btn primary" disabled={approved.length === 0} onClick={() => void renderApproved()}>
            Renderizar {approved.length} {approved.length === 1 ? 'clipe' : 'clipes'}
            <Icon name="arrowRight" color="#FFFFFF" strokeWidth={2.4} />
          </button>
        }
      />

      <main className="screen split">
        <section aria-label="Momentos encontrados" className="col-list">
          <AnalysisBanner project={project} />
          {!analyzing && project.error && (
            <div className={`callout ${project.status === 'error' ? 'error' : 'warn'}`}>
              <Icon name="alert" />
              <span style={{ flexGrow: 1 }}>{project.error.split('\n')[0]}</span>
              <button className="btn xs" onClick={() => void call('projects:retry', project.id)}>
                Tentar de novo
              </button>
            </div>
          )}

          <div className="list-head">
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
              <h1>
                {clips.length} {clips.length === 1 ? 'momento encontrado' : 'momentos encontrados'}
              </h1>
              <span className="muted" style={{ fontSize: 13 }}>
                ordenados por potencial
              </span>
            </div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {FILTERS.map((f) => (
                <button key={f.key} className="filter-btn" aria-pressed={filter === f.key} onClick={() => setFilter(f.key)}>
                  {f.label}
                </button>
              ))}
            </div>
          </div>

          {visible.length === 0 && !analyzing && (
            <div className="empty">
              <Icon name="scissors" size={28} color="#A78BFA" />
              <span>{clips.length === 0 ? 'Nenhum momento forte encontrado nessa live.' : 'Nenhum corte com esse filtro.'}</span>
            </div>
          )}

          {visible.map((c) => (
            <ClipRow
              key={c.id}
              clip={c}
              selected={selected?.id === c.id}
              player={player}
              wave={waves[c.id]}
              onSelectPlay={() => onSelectPlay(c)}
              onToggle={() => void patchClip(c.id, { approved: !c.approved })}
            />
          ))}

          <div className="list-foot">
            <button className="btn" onClick={() => setManualOpen(true)} disabled={!project.source}>
              <Icon name="plus" />
              Adicionar corte manual
            </button>
            <span style={{ fontSize: 14, color: 'var(--text-3)' }}>
              {approved.length} de {clips.length} aprovados · <span className="mono" style={{ color: 'var(--violet-3)' }}>{fmtTotal(totalSec)}</span> no total
            </span>
          </div>
        </section>

        <aside aria-label="Preview e recorte" className="col-side">
          <div className="panel-head">
            <span style={{ fontWeight: 600, fontSize: 15 }}>Preview · {selected ? clipLabel(selected) : '—'}</span>
            <span className="mono" style={{ fontSize: 12, color: 'var(--muted)' }}>
              preview 360p
            </span>
          </div>

          <div style={{ alignSelf: 'center' }}>
            <Preview916
              clip={selected}
              crop={project.crop}
              player={player}
              width={300}
              watermark={effectiveWm}
              onWatermarkChange={(wm, final) => setWatermark(wm, final)}
            />
          </div>

          {selected && (
            <>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <span className="label">Layout do corte</span>
                <div className="seg" role="group" aria-label="Layout do corte" style={{ gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' }}>
                  {LAYOUTS.map((l) => (
                    <button key={l.key} aria-pressed={selected.layout === l.key} onClick={() => void patchClip(selected.id, { layout: l.key })}>
                      {l.label}
                    </button>
                  ))}
                </div>
              </div>

              {selected.layout === 'both' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <span className="label">Altura da webcam</span>
                  <div className="pills" role="group" aria-label="Altura da webcam">
                    {SPLITS.map((v) => (
                      <button
                        key={v}
                        className="pill-btn cam mono"
                        aria-pressed={selected.camSplit === v}
                        onClick={() => void patchClip(selected.id, { camSplit: v })}
                      >
                        {v}%
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}

          <div className="panel" style={{ gap: 10 }}>
            <CropEditor
              project={project}
              showCam={selected?.layout !== 'game'}
              showGame={selected?.layout !== 'cam'}
              onCommit={(crop) => void commitCrop(crop)}
            />
            <span className="hint">Arraste os retângulos e as alças pra ajustar o que vai pra cada parte do 9:16.</span>
            <label className="check">
              <input
                type="checkbox"
                checked={presetOn}
                onChange={() => {
                  const next = !presetOn
                  setPresetOn(next)
                  if (next) void call('projects:set-crop', project.id, project.crop, true)
                }}
              />
              Salvar como preset do meu layout de live
            </label>
          </div>

          <WatermarkPanel
            watermark={effectiveWm}
            approvedCount={approved.length}
            onChange={(wm) => setWatermark(wm)}
            onApplyAll={() => void applyWmAll()}
          />
        </aside>
      </main>

      {manualOpen && (
        <ManualClipModal
          project={project}
          onClose={() => setManualOpen(false)}
          onCreated={(c) => {
            setManualOpen(false)
            setSelId(c.id)
          }}
        />
      )}
    </>
  )
}
