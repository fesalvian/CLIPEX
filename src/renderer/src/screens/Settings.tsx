import { useEffect, useState } from 'react'
import { NETWORKS, type Network, type Settings } from '@shared/types'
import { call, errorText } from '../api'
import { AppHeader } from '../components/AppHeader'
import { Icon } from '../components/Icon'
import { StylePanel } from '../components/StylePanel'
import { TextDefaultsEditor } from '../components/TextDefaultsEditor'
import { useStore } from '../store'

const NET_LABEL: Record<Network, string> = { instagram: 'Instagram Reels', tiktok: 'TikTok', youtube: 'YouTube Shorts' }
const NET_HELP: Record<Network, string> = {
  youtube:
    'YOUTUBE_CLIENT_ID e YOUTUBE_CLIENT_SECRET no .env (Google Cloud › credencial OAuth "App para computador"). Se o YouTube travar algum vídeo como privado (projeto sem auditoria da API), o app avisa depois do upload.',
  instagram:
    'INSTAGRAM_ACCESS_TOKEN (token da Página, "EAA…") e INSTAGRAM_USER_ID (conta do Instagram ligada à Página) no .env. O vídeo sobe direto do PC, sem storage. Com token do login do Instagram ("IG…") precisa do Supabase pra o Instagram baixar o vídeo. Passo a passo no README.',
  tiktok:
    'TIKTOK_CLIENT_KEY e TIKTOK_CLIENT_SECRET do Sandbox no .env (a chave começa com sbaw), com a URI http://127.0.0.1:51789/callback/ cadastrada no Login Kit (Desktop). Erro de client_key no login: falta salvar o Sandbox (Apply changes). Os vídeos vão como rascunho; você confirma no app do TikTok.'
}

export function SettingsScreen() {
  const settings = useStore((s) => s.settings)
  const components = useStore((s) => s.components)
  const update = useStore((s) => s.updateSettings)
  const go = useStore((s) => s.go)
  const toast = useStore((s) => s.toast)
  const [hasKey, setHasKey] = useState(false)
  const [key, setKey] = useState('')
  const [models, setModels] = useState<{ openai: string[]; local: string[] }>({ openai: [], local: [] })
  const [conns, setConns] = useState<Record<Network, { connected: boolean; account: string | null }> | null>(null)
  const [connecting, setConnecting] = useState<Network | null>(null)

  const loadModels = (): void => {
    void call('llm:models', 'openai').then(
      (m) => setModels((x) => ({ ...x, openai: m })),
      () => undefined
    )
    void call('llm:models', 'local').then(
      (m) => setModels((x) => ({ ...x, local: m })),
      () => undefined
    )
  }

  useEffect(() => {
    void call('settings:has-openai-key').then(setHasKey)
    void call('posts:connections').then(setConns)
    loadModels()
  }, [])

  if (!settings) return null
  const set = (patch: Partial<Settings>): void => void update(patch)

  const saveKey = async (): Promise<void> => {
    await call('settings:set-openai-key', key.trim())
    setKey('')
    setHasKey(key.trim().length > 0)
    toast('success', 'Chave da OpenAI salva.')
    loadModels()
  }

  const connect = async (n: Network): Promise<void> => {
    setConnecting(n)
    try {
      const r = await call('posts:connect', n)
      if (r.ok) toast('success', `${NET_LABEL[n]} conectado.`)
      else toast('error', r.error ?? 'Não deu pra conectar.')
      setConns(await call('posts:connections'))
    } catch (e) {
      toast('error', errorText(e))
    } finally {
      setConnecting(null)
    }
  }

  const openaiOptions = models.openai.includes(settings.openaiModel) ? models.openai : [settings.openaiModel, ...models.openai]
  const localOptions =
    settings.ollamaModel && !models.local.includes(settings.ollamaModel) ? [settings.ollamaModel, ...models.local] : models.local

  return (
    <>
      <AppHeader
        title="Configurações"
        subtitle="Clipador"
        actions={
          <button className="btn" onClick={() => go({ name: 'home' })}>
            <Icon name="arrowLeft" /> Voltar
          </button>
        }
      />
      <main className="screen settings">
        <TextDefaultsEditor />
        <StylePanel />
        <div className="settings-cols">
          <div className="col">
            <section className="panel">
              <span className="panel-title">Pasta vigiada</span>
              <span className="hint">
                Quando um vídeo termina de ser gravado nessa pasta, o Clipador cria o projeto e começa a análise sozinho.
              </span>
              <div style={{ display: 'flex', gap: 8 }}>
                <input className="input mono" readOnly value={settings.watchFolder} aria-label="Pasta vigiada" />
                <button
                  className="btn"
                  onClick={() =>
                    void call('dialog:pick-folder', settings.watchFolder).then((f) => {
                      if (f) set({ watchFolder: f })
                    })
                  }
                >
                  <Icon name="folder" /> Trocar
                </button>
              </div>
              <label className="check">
                <input
                  type="checkbox"
                  checked={settings.watchEnabled}
                  onChange={() => set({ watchEnabled: !settings.watchEnabled })}
                />
                Vigiar a pasta
              </label>
              <label className="check">
                <input
                  type="checkbox"
                  checked={settings.startWithWindows}
                  onChange={() => set({ startWithWindows: !settings.startWithWindows })}
                />
                Abrir com o Windows, direto na bandeja (pros agendamentos de Instagram e TikTok saírem na hora)
              </label>
              <label className="field" style={{ maxWidth: 420 }}>
                Apagar o arquivo bruto (só da pasta vigiada) depois que todos os cortes aprovados forem postados
                <select
                  className="select"
                  value={settings.deleteRawAfterDays ?? 0}
                  onChange={(e) => set({ deleteRawAfterDays: Number(e.target.value) || null })}
                >
                  <option value={0}>Nunca</option>
                  <option value={3}>3 dias depois</option>
                  <option value={7}>7 dias depois</option>
                  <option value={14}>14 dias depois</option>
                  <option value={30}>30 dias depois</option>
                </select>
              </label>
            </section>

            <section className="panel">
              <span className="panel-title">Inteligência artificial</span>
              <span className="hint">Usada no ranking dos momentos, nos ganchos e nas legendas por rede.</span>
              <div
                className="seg"
                role="group"
                aria-label="Provedor"
                style={{ gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', maxWidth: 360 }}
              >
                <button aria-pressed={settings.llmProvider === 'openai'} onClick={() => set({ llmProvider: 'openai' })}>
                  OpenAI
                </button>
                <button aria-pressed={settings.llmProvider === 'local'} onClick={() => set({ llmProvider: 'local' })}>
                  Local (Ollama)
                </button>
              </div>
              <div className="settings-grid">
                <label className="field">
                  <span className="field-row">
                    Chave da OpenAI
                    <span style={{ color: hasKey ? 'var(--ok)' : 'var(--warn)' }}>
                      {hasKey ? 'configurada' : 'não configurada'}
                    </span>
                  </span>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <input
                      className="input mono"
                      type="password"
                      placeholder={hasKey ? '•••••••• (trocar)' : 'sk-...'}
                      value={key}
                      onChange={(e) => setKey(e.target.value)}
                    />
                    <button className="btn" disabled={!key.trim()} onClick={() => void saveKey()}>
                      Salvar
                    </button>
                  </div>
                </label>
                <label className="field">
                  Modelo da OpenAI
                  <select className="select" value={settings.openaiModel} onChange={(e) => set({ openaiModel: e.target.value })}>
                    {openaiOptions.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  Endereço do Ollama
                  <input className="input mono" value={settings.ollamaUrl} onChange={(e) => set({ ollamaUrl: e.target.value })} />
                </label>
                <label className="field">
                  Modelo local
                  <select className="select" value={settings.ollamaModel} onChange={(e) => set({ ollamaModel: e.target.value })}>
                    {localOptions.length === 0 && <option value="">Ollama não respondeu</option>}
                    {localOptions.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            </section>
          </div>
          <div className="col">
            <section className="panel">
              <span className="panel-title">Componentes de IA</span>
              <span className="hint">Rodam no seu PC. O Whisper usa a placa de vídeo quando tem NVIDIA.</span>
              {components.map((c) => (
                <div key={c.key} className="component-row">
                  <span className={`stage-icon`}>
                    {c.ready ? (
                      <Icon name="check" size={14} color="#A78BFA" strokeWidth={2.6} />
                    ) : (
                      <Icon name="alert" size={14} color="#FFC48A" />
                    )}
                  </span>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flexGrow: 1, minWidth: 0 }}>
                    <span style={{ fontWeight: 600 }}>{c.label}</span>
                    <span
                      className="mono"
                      style={{ fontSize: 12, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis' }}
                    >
                      {c.detail}
                    </span>
                    {c.downloading && (
                      <div className="progress" style={{ marginTop: 4 }}>
                        <span style={{ width: `${c.progress * 100}%` }} />
                      </div>
                    )}
                  </div>
                  {c.key !== 'ffmpeg' && (
                    <button className="btn sm" disabled={c.downloading} onClick={() => void call('components:download', c.key)}>
                      {c.downloading ? <span className="spinner" /> : <Icon name="download" size={14} />}
                      {c.ready ? 'Baixar de novo' : 'Baixar'}
                    </button>
                  )}
                </div>
              ))}
              <label className="field" style={{ maxWidth: 420 }}>
                Modelo do Whisper
                <select className="select" value={settings.whisperModel} onChange={(e) => set({ whisperModel: e.target.value })}>
                  <option value="ggml-large-v3-turbo-q8_0.bin">large-v3-turbo q8 (834 MB) · recomendado</option>
                  <option value="ggml-large-v3-turbo.bin">large-v3-turbo (1,5 GB)</option>
                  <option value="ggml-large-v3-turbo-q5_0.bin">large-v3-turbo q5 (547 MB)</option>
                  <option value="ggml-medium-q5_0.bin">medium q5 (514 MB) · PC sem placa de vídeo</option>
                </select>
              </label>
            </section>

            <section className="panel">
              <span className="panel-title">Vídeo final</span>
              <div className="settings-grid">
                <label className="field">
                  Música da live no corte
                  <select
                    className="select"
                    value={settings.musicMode}
                    onChange={(e) => set({ musicMode: e.target.value as Settings['musicMode'] })}
                  >
                    <option value="mute">Sem música (evita direitos autorais)</option>
                    <option value="low">Música bem baixinha</option>
                  </select>
                </label>
                <label className="field">
                  Encoder de vídeo
                  <select
                    className="select"
                    value={settings.encoder}
                    onChange={(e) => set({ encoder: e.target.value as Settings['encoder'] })}
                  >
                    <option value="auto">Automático (GPU quando tiver)</option>
                    <option value="nvenc">NVIDIA (NVENC)</option>
                    <option value="amf">AMD (AMF)</option>
                    <option value="x264">Processador (libx264)</option>
                  </select>
                </label>
                <label className="field">
                  Janela em volta de cada momento
                  <select
                    className="select"
                    value={settings.windowSec}
                    onChange={(e) => set({ windowSec: Number(e.target.value) })}
                  >
                    {[30, 45, 60, 90].map((v) => (
                      <option key={v} value={v}>
                        ±{v} s
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  Máximo de momentos por live
                  <select
                    className="select"
                    value={settings.maxCandidates}
                    onChange={(e) => set({ maxCandidates: Number(e.target.value) })}
                  >
                    {[10, 20, 30, 50].map((v) => (
                      <option key={v} value={v}>
                        {v}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            </section>

            <section className="panel">
              <span className="panel-title">Contas</span>
              {NETWORKS.map((n) => (
                <div key={n} className="component-row" style={{ alignItems: 'flex-start' }}>
                  <span className="stage-icon" style={{ marginTop: 3 }}>
                    {conns?.[n]?.connected ? (
                      <Icon name="check" size={14} color="#A78BFA" strokeWidth={2.6} />
                    ) : (
                      <Icon name="link" size={14} color="#9396B3" />
                    )}
                  </span>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flexGrow: 1 }}>
                    <span style={{ fontWeight: 600 }}>
                      {NET_LABEL[n]} · <span className="mono">{settings.accounts[n]}</span>
                      {conns?.[n]?.account && <span className="muted"> · conectado como {conns[n].account}</span>}
                    </span>
                    <span className="hint">{NET_HELP[n]}</span>
                  </div>
                  <button className="btn sm" disabled={connecting !== null} onClick={() => void connect(n)}>
                    {connecting === n && <span className="spinner" />}
                    {conns?.[n]?.connected ? 'Reconectar' : n === 'instagram' ? 'Testar' : 'Conectar'}
                  </button>
                </div>
              ))}
            </section>
          </div>
        </div>
      </main>
    </>
  )
}
