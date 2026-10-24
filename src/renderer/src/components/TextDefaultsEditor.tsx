import { useEffect, useRef, useState, type ReactNode } from 'react'
import { CAPTION_ANIMS, DEFAULT_TEXT, HOOK_ANIMS, autoCaptionY, watermarkBox } from '@shared/text'
import type { CaptionStyle, HookStyle, SubtitleCue, TextDefaults, Watermark } from '@shared/types'
import { call, errorText, mediaUrl } from '../api'
import { useStore } from '../store'
import { Icon } from './Icon'
import { TextLayer, type TextKind } from './TextLayer'

const W = 250
const H = Math.round((W * 16) / 9)
const LOOP = 4.2

/** Legenda de exemplo com tempos, pra ver as animações no loop. */
const DEMO: SubtitleCue[] = [
  { id: 'a', start: 0.2, end: 1.6, words: ['ele', 'me', 'viu'].map((w, i) => ({ w, s: 0.2 + i * 0.45, e: 0.6 + i * 0.45 })) },
  { id: 'b', start: 1.6, end: 3.4, words: ['que', 'clutch', 'absurdo'].map((w, i) => ({ w, s: 1.6 + i * 0.55, e: 2.1 + i * 0.55 })) },
  { id: 'c', start: 3.4, end: 4.2, words: ['kkkkk'].map((w) => ({ w, s: 3.4, e: 4.2 })) }
]

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="style-row">
      <span>{label}</span>
      <span className="style-ctl">{children}</span>
    </label>
  )
}

function WatermarkGhost({ wm, caption, width }: { wm: Watermark; caption: CaptionStyle & { y: number }; width: number }) {
  const s = width / 1080
  const b = watermarkBox(wm, caption)
  const url = mediaUrl(wm.path)
  if (!url) return null
  return (
    <img
      src={url}
      alt=""
      draggable={false}
      style={{ position: 'absolute', left: b.x * s, top: b.y * s, width: b.w * s, height: b.h * s, opacity: wm.opacity, pointerEvents: 'none', zIndex: 2 }}
    />
  )
}

function Color({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <span className="color-pick">
      <input type="color" value={value} onChange={(e) => onChange(e.target.value.toUpperCase())} />
      <span className="mono">{value.toUpperCase()}</span>
    </span>
  )
}

export function TextDefaultsEditor() {
  const settings = useStore((s) => s.settings)
  const fonts = useStore((s) => s.fonts)
  const loadFonts = useStore((s) => s.loadFonts)
  const updateSettings = useStore((s) => s.updateSettings)
  const toast = useStore((s) => s.toast)
  const [draft, setDraft] = useState<TextDefaults | null>(settings?.text ?? null)
  const [tab, setTab] = useState<TextKind>('caption')
  const [mode, setMode] = useState<'play' | 'place'>('play')
  const [t, setT] = useState(0)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (settings && !draft) setDraft(settings.text)
  }, [settings, draft])

  // loop da animação de exemplo
  useEffect(() => {
    if (mode !== 'play') return
    let raf = 0
    const t0 = performance.now()
    const tick = (now: number): void => {
      setT(((now - t0) / 1000) % LOOP)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [mode])

  if (!draft) return null

  // salva com atraso: o seletor de cor dispara muitas mudanças seguidas
  const commit = (next: TextDefaults): void => {
    setDraft(next)
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => void updateSettings({ text: next }), 400)
  }
  const cap = (p: Partial<CaptionStyle>): void => commit({ ...draft, caption: { ...draft.caption, ...p } })
  const hk = (p: Partial<HookStyle>): void => commit({ ...draft, hook: { ...draft.hook, ...p } })

  const importFonts = async (): Promise<void> => {
    try {
      const r = await call('fonts:import')
      await loadFonts()
      if (r.added.length) toast('success', `Fonte importada: ${r.added.map((f) => f.family).join(', ')}`)
      if (r.rejected.length) toast('error', `Não consegui ler: ${r.rejected.join(', ')} (use .ttf ou .otf)`)
    } catch (e) {
      toast('error', errorText(e))
    }
  }

  const c = draft.caption
  const h = draft.hook
  const capY = c.y ?? autoCaptionY('both', 40, c.size)
  const cue = DEMO.find((d) => t >= d.start && t < d.end) ?? null
  const fontOptions = (current: string) =>
    (fonts.some((f) => f.family === current) ? fonts : [...fonts, { family: current, file: '', source: 'user' as const, bold: false }]).map((f) => (
      <option key={f.family} value={f.family}>
        {f.family}
        {f.source === 'user' ? ' (importada)' : ''}
      </option>
    ))

  return (
    <section className="panel">
      <div className="panel-head">
        <span className="panel-title">Textos padronizados</span>
        <button className="btn xs" onClick={() => commit(DEFAULT_TEXT)} title="Volta tudo pro estilo original">
          Restaurar padrão
        </button>
      </div>
      <span className="hint">
        Estilo da legenda e do texto inicial (gancho) de todos os cortes. Em cada corte dá pra mover os textos ou desligar só ali.
      </span>

      <div className="style-editor">
        <div className="style-preview">
          <div className="p916" style={{ width: W, height: H }}>
            <div className="p916-placeholder">
              <div className="p916-pane cam" style={{ top: 0, height: Math.round(H * 0.4) }}>
                <Icon name="user" size={40} strokeWidth={1.4} />
              </div>
              <div className="p916-pane game" style={{ top: Math.round(H * 0.4), height: H - Math.round(H * 0.4) }}>
                <Icon name="crosshair" size={40} strokeWidth={1.4} />
              </div>
            </div>
            <TextLayer
              width={W}
              caption={{ ...c, y: capY }}
              hook={{ ...h, y: h.y ?? DEFAULT_TEXT.hook.y! }}
              hookText={h.mode === 'fixed' && h.fixedText.trim() ? h.fixedText : 'ELE NÃO SABIA QUE EU TAVA ATRÁS'}
              cue={mode === 'play' ? cue : null}
              sampleCue={DEMO[1]!}
              t={t}
              elapsed={0}
              editing={mode === 'place'}
              onChange={(kind, p) => (kind === 'caption' ? cap(p) : hk(p))}
            />
            {/* logo do canal no lugar onde ela fica (acima da legenda) */}
            {settings?.watermark.enabled && settings.watermark.path && (
              <WatermarkGhost wm={settings.watermark} caption={{ ...c, y: capY }} width={W} />
            )}
          </div>
          <div className="seg well compact" role="group" aria-label="Modo do exemplo">
            <button aria-pressed={mode === 'play'} onClick={() => setMode('play')}>
              Ver animação
            </button>
            <button aria-pressed={mode === 'place'} onClick={() => setMode('place')}>
              Posicionar
            </button>
          </div>
          {mode === 'place' && (
            <span className="hint" style={{ textAlign: 'center', maxWidth: W }}>
              Arraste os textos. Alças das laterais: largura da área; canto roxo: tamanho da fonte.
            </span>
          )}
        </div>

        <div className="style-form">
          <div className="seg well" role="tablist" aria-label="Texto" style={{ gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' }}>
            <button role="tab" aria-selected={tab === 'caption'} onClick={() => setTab('caption')}>
              Legenda
            </button>
            <button role="tab" aria-selected={tab === 'hook'} onClick={() => setTab('hook')}>
              Texto inicial (gancho)
            </button>
          </div>

          {tab === 'caption' ? (
            <>
              <label className="check">
                <input type="checkbox" checked={c.enabled} onChange={() => cap({ enabled: !c.enabled })} />
                Legenda ligada em todos os cortes
              </label>
              <Row label="Fonte">
                <select className="select" value={c.font} onChange={(e) => cap({ font: e.target.value })}>
                  {fontOptions(c.font)}
                </select>
              </Row>
              <Row label={`Tamanho · ${c.size}px`}>
                <input type="range" min={40} max={150} value={c.size} onChange={(e) => cap({ size: Number(e.target.value) })} />
              </Row>
              <Row label={`Largura da área · ${c.boxWidth}px`}>
                <input type="range" min={200} max={1080} step={10} value={c.boxWidth} onChange={(e) => cap({ boxWidth: Number(e.target.value) })} />
              </Row>
              <Row label="Cor do texto">
                <Color value={c.color} onChange={(v) => cap({ color: v })} />
              </Row>
              <Row label="Palavra falada">
                <Color value={c.highlight} onChange={(v) => cap({ highlight: v })} />
              </Row>
              <Row label={`Contorno · ${c.outlineWidth}px`}>
                <Color value={c.outlineColor} onChange={(v) => cap({ outlineColor: v })} />
                <input type="range" min={0} max={16} value={c.outlineWidth} onChange={(e) => cap({ outlineWidth: Number(e.target.value) })} />
              </Row>
              <Row label="Animação">
                <select className="select" value={c.animation} onChange={(e) => cap({ animation: e.target.value as CaptionStyle['animation'] })}>
                  {CAPTION_ANIMS.map((a) => (
                    <option key={a.key} value={a.key}>
                      {a.label}
                    </option>
                  ))}
                </select>
              </Row>
              <div className="style-checks">
                <label className="check">
                  <input type="checkbox" checked={c.uppercase} onChange={() => cap({ uppercase: !c.uppercase })} />
                  Maiúsculas
                </label>
                <label className="check">
                  <input type="checkbox" checked={c.shadow} onChange={() => cap({ shadow: !c.shadow })} />
                  Sombra
                </label>
                <label className="check">
                  <input type="checkbox" checked={c.y === null} onChange={() => cap(c.y === null ? { y: capY } : { y: null, x: 540 })} />
                  Posição automática (abaixo da webcam)
                </label>
              </div>
            </>
          ) : (
            <>
              <label className="check">
                <input type="checkbox" checked={h.enabled} onChange={() => hk({ enabled: !h.enabled })} />
                Texto inicial ligado em todos os cortes
              </label>
              <div className="seg well" role="group" aria-label="Texto padrão" style={{ gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' }}>
                <button aria-pressed={h.mode === 'ai'} onClick={() => hk({ mode: 'ai' })}>
                  Sugestão da IA
                </button>
                <button aria-pressed={h.mode === 'fixed'} onClick={() => hk({ mode: 'fixed' })}>
                  Texto fixo
                </button>
              </div>
              {h.mode === 'fixed' && (
                <>
                  <input
                    className="input"
                    placeholder="Ex.: CORTE DA LIVE DE ONTEM"
                    maxLength={70}
                    value={h.fixedText}
                    onChange={(e) => hk({ fixedText: e.target.value })}
                  />
                  <span className="hint">Vazio = usa a sugestão da IA. Em cada corte dá pra escolher outra ou escrever a sua.</span>
                </>
              )}
              <Row label="Fonte">
                <select className="select" value={h.font} onChange={(e) => hk({ font: e.target.value })}>
                  {fontOptions(h.font)}
                </select>
              </Row>
              <Row label={`Tamanho · ${h.size}px`}>
                <input type="range" min={30} max={130} value={h.size} onChange={(e) => hk({ size: Number(e.target.value) })} />
              </Row>
              <Row label={`Largura da área · ${h.boxWidth}px`}>
                <input type="range" min={200} max={1080} step={10} value={h.boxWidth} onChange={(e) => hk({ boxWidth: Number(e.target.value) })} />
              </Row>
              <Row label="Cor do texto">
                <Color value={h.color} onChange={(v) => hk({ color: v })} />
              </Row>
              {h.box ? (
                <Row label="Cor da caixa">
                  <Color value={h.boxColor} onChange={(v) => hk({ boxColor: v })} />
                </Row>
              ) : (
                <Row label={`Contorno · ${h.outlineWidth}px`}>
                  <Color value={h.outlineColor} onChange={(v) => hk({ outlineColor: v })} />
                  <input type="range" min={0} max={16} value={h.outlineWidth} onChange={(e) => hk({ outlineWidth: Number(e.target.value) })} />
                </Row>
              )}
              <Row label="Animação">
                <select className="select" value={h.animation} onChange={(e) => hk({ animation: e.target.value as HookStyle['animation'] })}>
                  {HOOK_ANIMS.map((a) => (
                    <option key={a.key} value={a.key}>
                      {a.label}
                    </option>
                  ))}
                </select>
              </Row>
              <Row label={`Tempo na tela · ${h.duration}s`}>
                <input type="range" min={1} max={8} step={0.5} value={h.duration} onChange={(e) => hk({ duration: Number(e.target.value) })} />
              </Row>
              <div className="style-checks">
                <label className="check">
                  <input type="checkbox" checked={h.box} onChange={() => hk({ box: !h.box, ...(h.box && h.outlineWidth === 0 ? { outlineWidth: 6 } : {}) })} />
                  Caixa de fundo
                </label>
                <label className="check">
                  <input type="checkbox" checked={h.uppercase} onChange={() => hk({ uppercase: !h.uppercase })} />
                  Maiúsculas
                </label>
              </div>
            </>
          )}

          <div className="fonts-box">
            <div className="panel-head">
              <span style={{ fontWeight: 600, fontSize: 13 }}>Fontes</span>
              <button className="btn xs" onClick={() => void importFonts()}>
                <Icon name="upload" size={13} /> Importar fonte (.ttf/.otf)
              </button>
            </div>
            <div className="tags">
              {fonts.map((f) => (
                <span key={f.family} className="chip" style={{ fontFamily: `"${f.family}"`, fontSize: 13 }}>
                  {f.family}
                  {f.source === 'user' && (
                    <button
                      className="chip-x"
                      aria-label={`Remover ${f.family}`}
                      onClick={() => void call('fonts:remove', f.family).then(() => loadFonts())}
                    >
                      <Icon name="x" size={11} />
                    </button>
                  )}
                </span>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
