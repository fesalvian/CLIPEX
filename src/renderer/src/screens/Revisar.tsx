import { useEffect, useMemo, useState } from 'react'
import type { SchedulePreviewItem, ScheduleRequest } from '@shared/ipc'
import type { PlatformRules } from '@shared/platformRules'
import { clipDuration, cutsOf, toOut, zoomPoint } from '@shared/cuts'
import { fmtDur } from '@shared/time'
import type { Clip, LlmProvider, Network, Post, ScheduleSuggestion } from '@shared/types'
import { call, errorText } from '../api'
import { AppHeader } from '../components/AppHeader'
import { Icon } from '../components/Icon'
import { Preview916 } from '../components/Preview916'
import { RawGoneNotice } from '../components/RawGoneNotice'
import { CaptionsPanel } from '../components/review/CaptionsPanel'
import { DictionaryPanel } from '../components/review/DictionaryPanel'
import { HookPanel } from '../components/review/HookPanel'
import { ScheduleConfirm } from '../components/review/ScheduleConfirm'
import { SubtitlePanel } from '../components/review/SubtitlePanel'
import type { TextKind, TextPatch } from '../components/TextLayer'
import { usePreviewPlayer } from '../lib/player'
import { captionStyleFor, hookStyleFor, hookTextFor } from '@shared/text'
import { clipLabel, clipList, clipSub, useStore } from '../store'

const NETS: Network[] = ['instagram', 'youtube', 'tiktok']


interface Status {
  label: string
  kind: 'ok' | 'busy' | 'wait' | 'warn' | 'error'
  title?: string
}

function clipStatus(c: Clip, rawGone: boolean): Status {
  // sem o bruto não renderiza de novo: vale o último vídeo gerado
  if (rawGone && c.render.path && c.render.status !== 'done') return { label: 'Usa o último render', kind: 'ok' }
  if (rawGone && !c.render.path) return { label: 'Sem render · bruto apagado', kind: 'error' }
  if (c.prep === 'error') return { label: 'Erro na preparação', kind: 'error', title: c.prepMessage ?? '' }
  if (c.prep === 'queued') return { label: 'Na fila', kind: 'wait' }
  if (c.prep === 'working') return { label: c.prepMessage ?? 'Preparando', kind: 'busy' }
  if (c.render.status === 'rendering') return { label: `Renderizando ${Math.round(c.render.progress * 100)}%`, kind: 'busy' }
  if (c.render.status === 'queued') return { label: 'Render na fila', kind: 'wait' }
  if (c.render.status === 'error') return { label: 'Erro no render', kind: 'error', title: c.render.error ?? '' }
  if (c.render.status === 'stale') return { label: 'Editado · falta renderizar', kind: 'warn' }
  if (c.prep === 'none') return { label: 'Não preparado', kind: 'wait' }
  return { label: 'Pronto pra revisar', kind: 'ok' }
}

const CHIP_CLASS: Record<Status['kind'], string> = { ok: 'violet', busy: 'blue', wait: '', warn: 'warn', error: 'error' }

function postLine(posts: Post[]): string | null {
  const live = posts.filter((p) => p.status !== 'canceled')
  if (live.length === 0) return null
  const posted = live.filter((p) => p.status === 'posted').length
  const sched = live.filter((p) => p.status === 'scheduled' || p.status === 'uploading').length
  const draft = live.filter((p) => p.status === 'draft').length
  const failed = live.filter((p) => p.status === 'failed').length
  const privateOnly = live.filter((p) => p.note).length
  return [
    posted && `${posted} postado`,
    privateOnly && `${privateOnly} privado no YouTube`,
    sched && `${sched} agendado`,
    draft && `${draft} rascunho`,
    failed && `${failed} falhou`
  ]
    .filter(Boolean)
    .join(' · ')
}

const RHYTHMS: { v: number | null; label: string }[] = [
  { v: null, label: 'Todos juntos' },
  { v: 1, label: '1 por dia' },
  { v: 2, label: '2 por dia' },
  { v: 3, label: '3 por dia' },
  { v: 5, label: '5 por dia' },
  { v: 10, label: '10 por dia' }
]

function rhythmHint(perDay: number | null, count: number, mode: 'now' | 'sched', nowCount: number): string {
  const lead = mode === 'now' ? Math.min(nowCount, count) : 1
  const first =
    mode === 'now'
      ? lead === 1
        ? 'O melhor corte sai agora'
        : `Os ${lead} melhores cortes saem agora`
      : 'O melhor corte sai na data e hora acima'
  if (!perDay) return mode === 'now' ? 'Todos os cortes saem agora.' : 'Todos os cortes saem na data e hora acima.'
  if (lead >= count) return `${first}.`
  const days = Math.ceil((count - lead) / perDay)
  if (perDay === 1 && mode === 'sched') return `${first}; um por dia, sempre nesse horário (${days} ${days === 1 ? 'dia' : 'dias'}).`
  return `${first}; o resto vai nos melhores horários de cada rede, ${perDay} por dia (${days} ${days === 1 ? 'dia' : 'dias'}).`
}

function defaultDateTime(s: ScheduleSuggestion | undefined): { date: string; time: string } {
  const time = s?.time ?? '19:30'
  const [h, m] = time.split(':').map(Number)
  const d = new Date()
  d.setHours(h ?? 19, m ?? 30, 0, 0)
  if (d.getTime() < Date.now() + 10 * 60 * 1000) d.setDate(d.getDate() + 1)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return { date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, time }
}

export function Revisar() {
  const project = useStore((s) => s.project)
  const clipsMap = useStore((s) => s.clips)
  const posts = useStore((s) => s.posts)
  const settings = useStore((s) => s.settings)
  const patchClip = useStore((s) => s.patchClip)
  const toast = useStore((s) => s.toast)
  const setProjectState = useStore((s) => s.setProject)

  const clips = useMemo(
    () =>
      clipList(clipsMap)
        .filter((c) => c.approved)
        .sort((a, b) => a.number - b.number),
    [clipsMap]
  )
  const [selId, setSelId] = useState<string | null>(null)
  const sel = clips.find((c) => c.id === selId) ?? clips[0] ?? null
  const player = usePreviewPlayer(sel, project?.proxyPath ?? null)
  const [textDraft, setTextDraft] = useState<{ clipId: string; patch: Partial<Clip> } | null>(null)

  const [rules, setRules] = useState<PlatformRules | null>(null)
  const [provider, setProvider] = useState<LlmProvider>(settings?.llmProvider ?? 'openai')
  const [nets, setNets] = useState<Record<Network, boolean>>({ instagram: true, youtube: true, tiktok: true })
  const [mode, setMode] = useState<'now' | 'sched'>('sched')
  /** "Postar agora N e agendar o resto": vazio = 1 */
  const [nowText, setNowText] = useState('1')
  const [suggest, setSuggest] = useState<ScheduleSuggestion[]>([])
  const [date, setDate] = useState('')
  const [time, setTime] = useState('19:30')
  const [perDay, setPerDay] = useState<number | null>(1)
  const [slots, setSlots] = useState<Record<Network, string[]> | null>(null)
  const [game, setGame] = useState(project?.game ?? '')
  const [confirm, setConfirm] = useState<{ req: ScheduleRequest; items: SchedulePreviewItem[] } | null>(null)
  const [downloading, setDownloading] = useState<'one' | 'all' | null>(null)
  const [connections, setConnections] = useState<Record<Network, { connected: boolean; account: string | null }> | null>(null)

  // aprovado depois (ou corte manual) ainda não preparado: prepara sozinho ao abrir a revisão
  const unprepared = clips.filter((c) => c.prep === 'none').map((c) => c.id)
  const unpreparedKey = unprepared.join(',')
  useEffect(() => {
    if (unprepared.length) void call('clips:prepare', unprepared)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unpreparedKey])

  useEffect(() => {
    if (perDay && perDay > 1) void call('posts:slots', perDay).then(setSlots)
    else setSlots(null)
  }, [perDay])

  useEffect(() => setGame(project?.game ?? ''), [project?.id, project?.game])

  useEffect(() => {
    void call('app:platform-rules').then(setRules)
    void call('posts:connections').then(setConnections)
    void call('posts:suggest-time').then((s) => {
      setSuggest(s)
      const d = defaultDateTime(s.find((x) => x.network === 'instagram'))
      setDate(d.date)
      setTime(d.time)
    })
  }, [])

  if (!project || !settings || !rules) {
    return (
      <>
        <AppHeader title={project?.name ?? 'Carregando…'} step="revisar" />
        <main className="screen">
          <div className="empty">
            <span className="spinner" />
          </div>
        </main>
      </>
    )
  }

  const chosen = NETS.filter((n) => nets[n])
  const nowCount = Math.max(1, Math.floor(Number(nowText)) || 1)
  const firstAt = mode === 'sched' && date ? new Date(`${date}T${time}:00`).toISOString() : null
  const sugg = suggest.find((s) => s.network === (chosen[0] ?? 'instagram'))

  const openConfirm = async (clipIds: string[], rhythm: number | null): Promise<void> => {
    if (chosen.length === 0 || clipIds.length === 0) return
    if (mode === 'sched' && firstAt && new Date(firstAt).getTime() < Date.now()) {
      toast('error', 'Esse horário já passou. Escolha outro ou use "Postar agora".')
      return
    }
    const req: ScheduleRequest = { clipIds, networks: chosen, firstAt, perDay: rhythm, nowCount: mode === 'now' ? nowCount : undefined }
    try {
      setConfirm({ req, items: await call('posts:preview', req) })
    } catch (e) {
      toast('error', errorText(e))
    }
  }

  const renderAndScheduleAll = async (): Promise<void> => {
    const stale = clips.filter(
      (c) => c.render.status !== 'done' && c.render.status !== 'rendering' && c.render.status !== 'queued'
    )
    if (stale.length)
      await call(
        'render:clips',
        stale.map((c) => c.id)
      )
    await openConfirm(
      clips.map((c) => c.id),
      perDay
    )
  }

  const selFailed = sel ? posts.filter((p) => p.clipId === sel.id && p.status === 'failed') : []
  const retryPost = async (id: string): Promise<void> => {
    try {
      await call('posts:retry', id)
      toast('info', 'Enviando de novo.')
    } catch (e) {
      toast('error', errorText(e))
    }
  }

  const download = async (which: 'one' | 'all'): Promise<void> => {
    setDownloading(which)
    try {
      const r =
        which === 'one' && sel
          ? await call('export:clip', sel.id)
          : await call(
              'export:zip',
              project.id,
              clips.map((c) => c.id)
            )
      if (r.ok) toast('success', `Salvo em ${r.path}`)
      else if (r.error) toast('error', r.error)
    } catch (e) {
      toast('error', errorText(e))
    } finally {
      setDownloading(null)
    }
  }

  const ctaLabel =
    chosen.length === 0
      ? 'Escolha onde postar'
      : `${mode === 'sched' ? 'Agendar' : 'Postar agora'} em ${chosen.length} ${chosen.length === 1 ? 'rede' : 'redes'}`

  const zoomAt = sel ? zoomPoint(sel) : null
  // enquanto arrasta um texto, o preview usa a posição provisória
  const textClip = sel ? { ...sel, ...(textDraft?.clipId === sel.id ? textDraft.patch : {}) } : null

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

  return (
    <>
      <AppHeader
        title={project.name}
        subtitle={`${clips.length} ${clips.length === 1 ? 'corte aprovado' : 'cortes aprovados'}`}
        step="revisar"
        projectId={project.id}
        actions={
          <button
            className="btn primary"
            disabled={clips.length === 0 || chosen.length === 0}
            onClick={() => void renderAndScheduleAll()}
          >
            Renderizar e agendar tudo
            <Icon name="arrowRight" color="#FFFFFF" strokeWidth={2.4} />
          </button>
        }
      />

      {clips.length === 0 ? (
        <main className="screen">
          <div className="empty">
            <span>Nenhum corte aprovado ainda. Volte pra tela de clipar e marque "usar" nos momentos que quer postar.</span>
            <button className="btn" onClick={() => void useStore.getState().openProject(project.id, 'clipar')}>
              <Icon name="arrowLeft" /> Voltar pra clipar
            </button>
          </div>
        </main>
      ) : (
        <main className="screen review">
          <section aria-label="Cortes" className="col-cards">
            <RawGoneNotice project={project} />
            <span className="label">Cortes aprovados</span>
            {clips.map((c) => {
              const st = clipStatus(c, !!project.rawDeletedAt)
              const on = sel?.id === c.id
              const pl = postLine(posts.filter((p) => p.clipId === c.id))
              return (
                <button key={c.id} className={`review-card${on ? ' sel' : ''}`} aria-pressed={on} onClick={() => setSelId(c.id)}>
                  <span className={`mini916 ${c.layout}`} style={{ ['--split' as string]: `${c.camSplit}%` }}>
                    <span className="cam" />
                    <span className="game" />
                  </span>
                  <span className="review-card-text">
                    <span style={{ fontWeight: 600, fontSize: 14 }}>{clipLabel(c)}</span>
                    {clipSub(c) && <span className="review-card-title">{clipSub(c)}</span>}
                    <span className="mono" style={{ fontSize: 12, color: 'var(--muted)' }}>
                      {fmtDur(clipDuration(c))}
                    </span>
                    <span className={`chip ${CHIP_CLASS[st.kind]}`} title={st.title} style={{ fontSize: 11, padding: '2px 8px' }}>
                      {st.kind === 'busy' && <span className="spinner" style={{ width: 9, height: 9 }} />}
                      {st.label}
                    </span>
                    {pl && <span style={{ fontSize: 11, color: 'var(--violet-3)' }}>{pl}</span>}
                  </span>
                </button>
              )
            })}
            <DictionaryPanel dictionary={settings.dictionary} clipIds={clips.map((c) => c.id)} />
          </section>

          {sel && textClip && (
            <section aria-label="Preview do corte" className="review-preview">
              <Preview916
                clip={textClip}
                crop={sel.crop ?? project.crop}
                player={player}
                width={280}
                captionStyle={captionStyleFor(textClip, settings.text)}
                hookStyle={hookStyleFor(textClip, settings.text)}
                hookText={hookTextFor(sel, settings.text)}
                dictionary={settings.dictionary}
                zoomAt={zoomAt}
                watermark={sel.watermark ?? settings.watermark}
                onTextChange={(kind, tp, final) => changeText(sel, kind, tp, final)}
              />
              <span className="hint">Pausado: arraste a legenda e o texto inicial; as alças mudam a largura e o tamanho.</span>
              <label className="check boxed">
                <input
                  type="checkbox"
                  checked={sel.zoomEnabled}
                  onChange={() => void patchClip(sel.id, { zoomEnabled: !sel.zoomEnabled })}
                />
                <span style={{ flexGrow: 1 }}>Zoom na webcam no pico</span>
                {zoomAt !== null && (
                  <span className="mono" style={{ fontSize: 12, color: 'var(--cam-soft)' }}>
                    {fmtDur(toOut(cutsOf(sel), zoomAt))}
                  </span>
                )}
              </label>
              {sel.zoomEnabled && (
                <button className="btn xs" onClick={() => void patchClip(sel.id, { zoomAt: player.time })}>
                  Zoom na posição atual ({fmtDur(toOut(cutsOf(sel), player.time))})
                </button>
              )}
              <RenderStatus clip={sel} projectId={project.id} rawGone={!!project.rawDeletedAt} />
            </section>
          )}

          {sel && (
            <section aria-label="Revisão do corte" className="review-edit">
              <HookPanel clip={sel} provider={provider} onProvider={setProvider} />
              <SubtitlePanel clip={sel} dictionary={settings.dictionary} onSeek={(s) => player.seek(s)} />
            </section>
          )}

          {sel && (
            <aside aria-label="Publicação" className="col-publish">
              <div className="panel" style={{ gap: 10 }}>
                <span className="panel-title">Onde postar</span>
                {NETS.map((n) => {
                  const on = nets[n]
                  const conn = connections?.[n]
                  return (
                    <label key={n} className={`net-row${on ? ' on' : ''}`}>
                      <input type="checkbox" checked={on} onChange={() => setNets({ ...nets, [n]: !on })} />
                      <span style={{ display: 'flex', flexDirection: 'column', gap: 2, flexGrow: 1 }}>
                        <span style={{ fontSize: 14, fontWeight: 600 }}>
                          {rules[n].product} · {settings.accounts[n]}
                        </span>
                        <span style={{ fontSize: 12, color: n === 'tiktok' ? 'var(--warn)' : 'var(--muted)' }}>
                          {rules[n].delivery}
                        </span>
                        {conn && !conn.connected && (
                          <span style={{ fontSize: 11, color: 'var(--warn)' }}>Conta não conectada (Configurações)</span>
                        )}
                      </span>
                    </label>
                  )
                })}
              </div>

              <div className="panel" style={{ gap: 8 }}>
                <label className="field">
                  <span className="field-row">
                    Jogo da live
                    <span className="hint">a IA usa nas legendas e hashtags</span>
                  </span>
                  <input
                    className="input"
                    placeholder="Ex.: Valorant (sem jogo, a IA não chuta)"
                    value={game}
                    onChange={(e) => setGame(e.target.value)}
                    onBlur={() => {
                      if (game !== (project.game ?? '')) void call('projects:set-game', project.id, game).then(setProjectState)
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                    }}
                  />
                </label>
              </div>

              <CaptionsPanel clip={sel} rules={rules} accounts={settings.accounts} provider={provider} />

              <div className="panel">
                <span className="panel-title">Quando</span>
                <div className="now-row">
                  <label className="now-check">
                    <input type="checkbox" checked={mode === 'now'} onChange={(e) => setMode(e.target.checked ? 'now' : 'sched')} />
                    Postar agora
                  </label>
                  <input
                    className="input mono now-count"
                    type="number"
                    min={1}
                    max={Math.max(1, clips.length)}
                    placeholder="1"
                    value={nowText}
                    disabled={mode !== 'now'}
                    aria-label="Quantos cortes postar agora"
                    onChange={(e) => setNowText(e.target.value)}
                  />
                  <span className="hint">{nowCount === 1 ? 'corte' : 'cortes'} e agendar o resto</span>
                </div>
                {mode === 'sched' && (
                  <>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 8 }}>
                      <label className="field">
                        Data
                        <input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
                      </label>
                      <label className="field">
                        Hora
                        <input className="input" type="time" value={time} onChange={(e) => setTime(e.target.value)} />
                      </label>
                    </div>
                    {sugg && (
                      <div className="callout blue">
                        <Icon name="chart" color="#93C5FD" />
                        <span>
                          Sugestão: {sugg.time}. {sugg.reason}
                        </span>
                      </div>
                    )}
                  </>
                )}

                <div className="rhythm">
                  <span className="label">Ritmo do "Renderizar e agendar tudo" ({clips.length} cortes)</span>
                  <div className="rhythm-opts" role="group" aria-label="Cortes por dia">
                    {RHYTHMS.map((r) => (
                      <button key={String(r.v)} className="pill-btn" aria-pressed={perDay === r.v} onClick={() => setPerDay(r.v)}>
                        {r.label}
                      </button>
                    ))}
                  </div>
                  <span className="hint">{rhythmHint(perDay, clips.length, mode, nowCount)}</span>
                  {slots && (
                    <div className="slot-list">
                      {chosen.map((n) => (
                        <span key={n} className="mono">
                          <b>{rules[n].label}</b> {slots[n]?.join(' · ')}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {selFailed.length > 0 && (
                <div className="callout error" role="alert" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
                  {selFailed.map((p) => (
                    <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <Icon name="alert" color="#FF8A8A" />
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <b>{rules[p.network].label}</b> falhou: {p.error?.split('\n')[0] ?? 'erro desconhecido'}
                      </span>
                      <button className="btn" onClick={() => void retryPost(p.id)}>
                        <Icon name="refresh" size={15} /> Tentar de novo
                      </button>
                    </div>
                  ))}
                </div>
              )}

              <button className="btn primary lg" disabled={chosen.length === 0} onClick={() => void openConfirm([sel.id], null)}>
                {ctaLabel}
              </button>

              <div className="panel planb">
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <span className="panel-title" style={{ fontSize: 14 }}>
                    Plano B: baixar e postar na mão
                  </span>
                  <span className="hint">
                    Se a postagem automática falhar, baixe os vídeos já renderizados. Cada um vem com um .txt das legendas e
                    hashtags de cada rede.
                  </span>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 8 }}>
                  <button className="btn" disabled={downloading !== null} onClick={() => void download('one')}>
                    {downloading === 'one' ? <span className="spinner" /> : <Icon name="download" size={15} />}
                    Baixar este clipe
                  </button>
                  <button className="btn" disabled={downloading !== null} onClick={() => void download('all')}>
                    {downloading === 'all' ? <span className="spinner" /> : <Icon name="zip" size={15} />}
                    Baixar todos (.zip)
                  </button>
                </div>
              </div>
            </aside>
          )}
        </main>
      )}

      {confirm && <ScheduleConfirm req={confirm.req} items={confirm.items} rules={rules} onClose={() => setConfirm(null)} />}
    </>
  )
}

function RenderStatus({ clip, projectId, rawGone }: { clip: Clip; projectId: string; rawGone: boolean }) {
  const r = clip.render
  if (rawGone) {
    return (
      <div className="render-status">
        {r.path ? (
          <button className="btn xs" onClick={() => void call('projects:open-folder', projectId)}>
            <Icon name="folder" size={13} /> Último vídeo renderizado · abrir pasta
          </button>
        ) : (
          <span style={{ fontSize: 11, color: 'var(--danger)' }}>Este corte nunca foi renderizado e o bruto foi apagado.</span>
        )}
      </div>
    )
  }
  return (
    <div className="render-status">
      {r.status === 'rendering' && (
        <>
          <span style={{ fontSize: 12 }}>Vídeo final · renderizando {Math.round(r.progress * 100)}%</span>
          <div className="progress">
            <span style={{ width: `${r.progress * 100}%` }} />
          </div>
        </>
      )}
      {r.status === 'done' && (
        <button className="btn xs" onClick={() => void call('projects:open-folder', projectId)}>
          <Icon name="folder" size={13} /> Vídeo final pronto · abrir pasta
        </button>
      )}
      {(r.status === 'stale' || r.status === 'none' || r.status === 'error') && (
        <button className="btn xs" onClick={() => void call('render:clips', [clip.id])}>
          <Icon name="refresh" size={13} /> {r.status === 'none' ? 'Renderizar' : 'Renderizar de novo'}
        </button>
      )}
      {r.status === 'error' && r.error && <span style={{ fontSize: 11, color: 'var(--danger)' }}>{r.error.split('\n')[0]}</span>}
    </div>
  )
}
