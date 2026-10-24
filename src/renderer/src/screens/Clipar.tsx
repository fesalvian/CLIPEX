import { useEffect, useMemo, useRef, useState } from 'react'
import { STAGE_LABEL, STAGE_ORDER } from '@shared/defaults'
import { clipDuration, cutsOf, newSegmentAt, withCuts } from '@shared/cuts'
import { fmtClock, fmtDur, fmtLong, fmtTotal } from '@shared/time'
import type { CamSplit, Clip, ClipLayout, CropLayout, DetectedTag, Project, Watermark } from '@shared/types'
import { call, errorText } from '../api'
import { AppHeader } from '../components/AppHeader'
import { CropEditor } from '../components/CropEditor'
import { Icon, PauseIcon, PlayIcon } from '../components/Icon'
import { ManualClipModal } from '../components/ManualClipModal'
import { OwnSettingRow } from '../components/OwnSettingRow'
import { Preview916 } from '../components/Preview916'
import { RawGoneNotice } from '../components/RawGoneNotice'
import { WatermarkPanel } from '../components/WatermarkPanel'
import { TextsPanel } from '../components/TextsPanel'
import type { TextKind, TextPatch } from '../components/TextLayer'
import { Waveform } from '../components/Waveform'
import { usePreviewPlayer, type Player } from '../lib/player'
import { clipLabel, clipList, clipScore, clipSub, useStore, type LiveWave } from '../store'
import { captionStyleFor, hookStyleFor, hookTextFor } from '@shared/text'

type Filter = 'all' | 'laugh' | 'scream' | 'peak' | 'manual'

const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: 'Todos' },
  { key: 'laugh', label: 'Risadas' },
  { key: 'scream', label: 'Gritos' },
  { key: 'peak', label: 'Picos de áudio' },
  { key: 'manual', label: 'Manuais' }
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
/** tamanho da timeline de cada corte (s): dá pra afastar pra pegar outros trechos do momento */
const TIMELINE_MIN = 20
const TIMELINE_MAX = 30 * 60

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
  const done = STAGE_ORDER.filter(
    (k) => k !== 'proxy' && (project.stages[k].status === 'done' || project.stages[k].status === 'skipped')
  ).length
  const st = running ? project.stages[running] : null
  return (
    <div className="analysis-banner">
      <span className="spinner" />
      <div style={{ flexGrow: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
        <span style={{ fontSize: 13 }}>
          {project.status === 'queued'
            ? 'Na fila pra análise'
            : `Analisando a live · ${running ? STAGE_LABEL[running] : 'preparando'}`}
          <span className="muted">
            {' '}
            · etapa {Math.min(done + 1, STAGE_ORDER.length - 1)} de {STAGE_ORDER.length - 1}
          </span>
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
  live,
  duration,
  onSelect,
  onSelectPlay,
  onToggle
}: {
  clip: Clip
  selected: boolean
  player: Player
  live: LiveWave | null
  duration: number
  onSelect: () => void
  onSelectPlay: () => void
  onToggle: () => void
}) {
  const previewClip = useStore((s) => s.previewClip)
  const patchClip = useStore((s) => s.patchClip)
  const toast = useStore((s) => s.toast)
  const cuts = cutsOf(clip)
  const span = clip.winEnd - clip.winStart

  /** Trecho novo no cursor (se estiver fora dos trechos) ou depois do último; a timeline estica. */
  const addSegment = (): void => {
    const k = newSegmentAt(cuts, selected ? player.time : null, duration)
    if (!k) {
      toast('info', 'Não tem espaço pra outro trecho depois do último. Ande a timeline ou ponha o cursor fora dos trechos.')
      return
    }
    if (!selected) onSelect()
    void patchClip(clip.id, withCuts([...cuts, k].sort((a, b) => a.s - b.s)))
    player.seek(k.s)
  }

  /** Aproxima ou afasta a timeline em volta do meio (mais da live pra pegar outros trechos). */
  const zoomView = (factor: number): void => {
    const next = Math.max(TIMELINE_MIN, Math.min(TIMELINE_MAX, Math.min(duration, span * factor)))
    const mid = (clip.winStart + clip.winEnd) / 2
    const winStart = Math.max(0, Math.min(duration - next, mid - next / 2))
    void patchClip(clip.id, { winStart, winEnd: winStart + next })
  }

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
          {clipSub(clip) && <span className="clip-title">{clipSub(clip)}</span>}
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
              title={
                clip.llm ? clip.llm.reason || 'Nota de potencial da IA' : 'Nota provisória pelo áudio; a IA ainda vai avaliar'
              }
            >
              {busy && <span className="spinner" style={{ width: 10, height: 10 }} />}
              {clip.llm ? score : `~${score}`}
            </span>
          )}
        </div>

        <Waveform
          clip={clip}
          live={live}
          duration={duration}
          selected={selected}
          time={selected ? player.time : null}
          onCutsChange={(next, final) => {
            if (!selected) onSelect()
            if (final) void patchClip(clip.id, withCuts(next))
            else previewClip(clip.id, withCuts(next))
          }}
          onViewChange={(winStart, winEnd, final) => {
            if (final) void patchClip(clip.id, { winStart, winEnd })
            else previewClip(clip.id, { winStart, winEnd })
          }}
          onSeek={(sec) => {
            if (!selected) onSelect()
            player.seek(Math.max(clip.cutIn, Math.min(sec, clip.cutOut)))
          }}
        />

        <div className="clip-times mono">
          <span>{fmtClock(clip.winStart)}</span>
          <span style={{ color: 'var(--text-3)' }}>
            {cuts.length > 1 ? `${cuts.length} trechos` : `corte: ${fmtClock(clip.cutIn)} → ${fmtClock(clip.cutOut)}`} ·{' '}
            <span style={{ color: 'var(--violet-3)' }}>{fmtDur(clipDuration(clip))}</span>
          </span>
          <span>{fmtClock(clip.winEnd)}</span>
        </div>

        <div className="clip-tools">
          <button className="btn xs" onClick={addSegment} title="Junta outro pedaço da live neste mesmo vídeo (corte seco entre eles)">
            <Icon name="plus" size={13} /> Trecho
          </button>
          <span style={{ flexGrow: 1 }} />
          <span className="mono" style={{ fontSize: 11, color: 'var(--muted-2)' }}>
            timeline {fmtDur(span)}
          </span>
          <button className="btn xs icon" onClick={() => zoomView(1 / 1.6)} disabled={span <= TIMELINE_MIN + 0.5} aria-label="Aproximar a timeline" title="Aproximar">
            <Icon name="zoomIn" size={14} />
          </button>
          <button
            className="btn xs icon"
            onClick={() => zoomView(1.6)}
            disabled={span >= Math.min(duration, TIMELINE_MAX) - 0.5}
            aria-label="Afastar a timeline (mostrar mais da live)"
            title="Afastar (mostrar mais da live)"
          >
            <Icon name="zoomOut" size={14} />
          </button>
        </div>
      </div>

      <div className="clip-play">
        <button
          className={`play-btn${isPlaying ? ' on' : ''}`}
          aria-label={isPlaying ? 'Pausar clipe' : 'Reproduzir clipe'}
          onClick={onSelectPlay}
        >
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
  const liveWave = useStore((s) => s.liveWave)
  const loadLiveWave = useStore((s) => s.loadLiveWave)
  const patchClip = useStore((s) => s.patchClip)
  const openProject = useStore((s) => s.openProject)
  const toast = useStore((s) => s.toast)
  const updateSettings = useStore((s) => s.updateSettings)
  const setProject = useStore((s) => s.setProject)

  const [filter, setFilter] = useState<Filter>('all')
  const [selId, setSelId] = useState<string | null>(null)
  const [presetOn, setPresetOn] = useState(true)
  // recorte e logo mudam só no corte selecionado, a não ser que marque "mudar em todos"
  const [cropAll, setCropAll] = useState(false)
  const [wmAll, setWmAll] = useState(false)
  const [manualOpen, setManualOpen] = useState(false)
  const [wmDraft, setWmDraft] = useState<Watermark | null>(null)
  const [textDraft, setTextDraft] = useState<{ clipId: string; patch: Partial<Clip> } | null>(null)

  const clips = useMemo(() => clipList(clipsMap).sort((a, b) => clipScore(b) - clipScore(a) || a.number - b.number), [clipsMap])
  const visible = clips.filter(
    (c) => filter === 'all' || c.tags.includes(filter) || (filter === 'manual' && c.origin === 'manual')
  )
  const selected = (selId ? clipsMap[selId] : null) ?? visible[0] ?? null
  const approved = clips.filter((c) => c.approved)
  const totalSec = approved.reduce((n, c) => n + clipDuration(c), 0)

  const player = usePreviewPlayer(selected, project?.proxyPath ?? null)
  const duration = project?.source?.durationSec ?? 0

  // waveform da live inteira (a timeline de cada corte recorta daqui e pode andar por ela)
  const audioDone = project?.stages.audio.status === 'done'
  useEffect(() => {
    if (project && audioDone && duration > 0) void loadLiveWave(project.id, duration)
  }, [project?.id, audioDone, duration, loadLiveWave]) // eslint-disable-line react-hooks/exhaustive-deps
  const autoPlay = useRef(false)
  useEffect(() => {
    if (autoPlay.current && player.ready) {
      autoPlay.current = false
      player.play()
    }
  }, [player.ready, player])

  // corte selecionado sem preview (ex.: manual): pede pra gerar, passando na frente do lote
  useEffect(() => {
    if (selected && player.loadingPreview) void call('clips:ensure-preview', selected.id).catch(() => undefined)
  }, [selected?.id]) // eslint-disable-line react-hooks/exhaustive-deps

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
  const effectiveCrop: CropLayout = selected?.crop ?? project.crop
  // enquanto arrasta um texto, o preview usa a posição provisória
  const textClip = selected ? { ...selected, ...(textDraft?.clipId === selected.id ? textDraft.patch : {}) } : null
  const capStyle = captionStyleFor(textClip ?? { captionStyle: null, layout: 'both', camSplit: 40 }, settings.text)
  const hkStyle = hookStyleFor(textClip ?? { hookStyle: null }, settings.text)

  const changeText = (c: Clip, kind: TextKind, tp: TextPatch, final: boolean): void => {
    const patch: Partial<Clip> =
      kind === 'caption' ? { captionStyle: { ...(c.captionStyle ?? {}), ...tp } } : { hookStyle: { ...(c.hookStyle ?? {}), ...tp } }
    if (final) {
      setTextDraft(null)
      void patchClip(c.id, patch)
    } else {
      setTextDraft({ clipId: c.id, patch })
    }
  }

  const onSelectPlay = (c: Clip): void => {
    if (selected?.id === c.id) player.toggle()
    else {
      autoPlay.current = true
      setSelId(c.id)
    }
  }

  /** Recorte padrão do projeto: vale pra todos os cortes (os próprios voltam pro padrão). */
  const setCropAllClips = async (crop: CropLayout): Promise<void> => {
    try {
      setProject(await call('projects:set-crop', project.id, crop, presetOn))
    } catch (e) {
      toast('error', errorText(e))
    }
  }

  const commitCrop = (crop: CropLayout): void => {
    if (cropAll || !selected) void setCropAllClips(crop)
    else void patchClip(selected.id, { crop })
  }

  const applyCropAll = async (): Promise<void> => {
    await setCropAllClips(effectiveCrop)
    toast('success', 'Recorte aplicado em todos os cortes.')
  }

  const setWatermark = (wm: Watermark, final = true): void => {
    if (!final) {
      setWmDraft(wm)
      return
    }
    setWmDraft(null)
    if (wmAll || !selected) void setWmAllClips(wm)
    else void patchClip(selected.id, { watermark: wm })
  }

  /** Logo padrão (configurações): vale pra todos os cortes e pras próximas lives. */
  const setWmAllClips = async (wm: Watermark): Promise<void> => {
    await updateSettings({ watermark: wm })
    await Promise.all(clips.filter((c) => c.watermark).map((c) => patchClip(c.id, { watermark: null })))
  }

  const applyWmAll = async (): Promise<void> => {
    const wm = effectiveWm
    await updateSettings({ watermark: wm })
    await Promise.all(clips.filter((c) => c.watermark).map((c) => patchClip(c.id, { watermark: null })))
    toast('success', 'Marca d’água aplicada em todos os cortes (e salva como padrão).')
  }

  // "usar" de todos os cortes visíveis (respeita o filtro)
  const allOn = visible.length > 0 && visible.every((c) => c.approved)
  const someOn = visible.some((c) => c.approved)
  const toggleAll = (): void => {
    const next = !allOn
    for (const c of visible) if (c.approved !== next) void patchClip(c.id, { approved: next })
  }

  const renderApproved = async (): Promise<void> => {
    if (approved.length === 0) return
    player.pause()
    await call(
      'clips:prepare',
      approved.map((c) => c.id)
    )
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
          <RawGoneNotice project={project} />
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
            <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
              <label className="select-all" title={allOn ? 'Desmarcar todos' : 'Usar todos'}>
                <input
                  type="checkbox"
                  checked={allOn}
                  ref={(el) => {
                    if (el) el.indeterminate = someOn && !allOn
                  }}
                  onChange={toggleAll}
                  disabled={visible.length === 0}
                  aria-label={allOn ? 'Desmarcar todos os cortes' : 'Usar todos os cortes'}
                />
                <span>todos</span>
              </label>
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
              live={liveWave?.projectId === project.id ? liveWave : null}
              duration={duration}
              onSelect={() => setSelId(c.id)}
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
              {approved.length} de {clips.length} aprovados ·{' '}
              <span className="mono" style={{ color: 'var(--violet-3)' }}>
                {fmtTotal(totalSec)}
              </span>{' '}
              no total
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
              clip={textClip}
              crop={effectiveCrop}
              player={player}
              width={300}
              captionStyle={capStyle}
              hookStyle={hkStyle}
              hookText={selected ? hookTextFor(selected, settings.text) : null}
              dictionary={settings.dictionary}
              watermark={effectiveWm}
              onWatermarkChange={(wm, final) => setWatermark(wm, final)}
              onTextChange={selected ? (kind, tp, final) => changeText(selected, kind, tp, final) : undefined}
            />
          </div>

          {selected && (
            <>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <span className="label">Layout do corte</span>
                <div
                  className="seg"
                  role="group"
                  aria-label="Layout do corte"
                  style={{ gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' }}
                >
                  {LAYOUTS.map((l) => (
                    <button
                      key={l.key}
                      aria-pressed={selected.layout === l.key}
                      onClick={() => void patchClip(selected.id, { layout: l.key })}
                    >
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
              crop={effectiveCrop}
              player={player}
              showCam={selected?.layout !== 'game'}
              showGame={selected?.layout !== 'cam'}
              onCommit={commitCrop}
            />
            <span className="hint">
              Arraste os retângulos e as alças pra ajustar o que vai pra cada parte do 9:16.{' '}
              {cropAll || !selected ? 'Muda em todos os cortes desta live.' : 'Muda só neste corte.'}
            </span>
            {selected?.crop && (
              <OwnSettingRow
                text="Este corte tem um recorte próprio."
                onReset={() => void patchClip(selected.id, { crop: null })}
                onApplyAll={() => void applyCropAll()}
              />
            )}
            <label className="check">
              <input type="checkbox" checked={cropAll} onChange={() => setCropAll(!cropAll)} />
              Mudar o recorte em todos os cortes
            </label>
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

          {selected && <TextsPanel clip={selected} settings={settings} allClips={clips} />}

          <WatermarkPanel
            watermark={effectiveWm}
            caption={capStyle}
            perClip={!!selected && !wmAll}
            own={!!selected?.watermark}
            overrides={clips.filter((c) => c.watermark).length}
            allMode={wmAll}
            onAllModeChange={setWmAll}
            onChange={(wm) => setWatermark(wm)}
            onReset={() => selected && void patchClip(selected.id, { watermark: null })}
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
