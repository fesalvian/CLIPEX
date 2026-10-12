// Tipos compartilhados entre o main process e o renderer.
// Tempos sempre em segundos, na linha do tempo do arquivo original.

export type Network = 'instagram' | 'tiktok' | 'youtube'
export const NETWORKS: readonly Network[] = ['instagram', 'tiktok', 'youtube']

export type LlmProvider = 'openai' | 'local'
export type ClipLayout = 'both' | 'game' | 'cam'
export type CamSplit = 30 | 40 | 50
export type DetectedTag = 'laugh' | 'scream' | 'peak' | 'manual'

/** Retângulo normalizado (0..1) sobre o frame da live. */
export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export interface CropLayout {
  cam: Rect
  game: Rect
}

export type TrackRole = 'mix' | 'mic' | 'game' | 'discord' | 'music' | 'unknown'

export interface AudioTrack {
  /** Ordem entre as faixas de áudio (0 = primeira), usada em `0:a:N`. */
  order: number
  streamIndex: number
  title: string | null
  channels: number
  codec: string
  role: TrackRole
}

export interface SourceInfo {
  path: string
  sizeBytes: number
  durationSec: number
  width: number
  height: number
  fps: number
  videoCodec: string
  audioTracks: AudioTrack[]
}

export type StageKey = 'probe' | 'audio' | 'events' | 'candidates' | 'transcribe' | 'rank' | 'previews' | 'proxy'
export type StageStatus = 'pending' | 'running' | 'done' | 'error' | 'skipped'

export interface StageState {
  status: StageStatus
  progress: number
  message?: string
}

export type StagesState = Record<StageKey, StageState>

export type ProjectStatus = 'queued' | 'analyzing' | 'ready' | 'error'

export interface Project {
  id: string
  name: string
  liveDate: string | null
  createdAt: string
  dir: string
  source: SourceInfo | null
  sourcePath: string
  proxyPath: string | null
  framePath: string | null
  crop: CropLayout
  /** jogo da live: a IA usa nas legendas e hashtags em vez de chutar */
  game: string | null
  status: ProjectStatus
  stages: StagesState
  error: string | null
  rawDeletedAt: string | null
}

export interface Word {
  /** texto */
  w: string
  /** início (s) */
  s: number
  /** fim (s) */
  e: number
}

export interface SubtitleCue {
  id: string
  start: number
  end: number
  words: Word[]
}

export interface NetCaption {
  title?: string
  text: string
  hashtags: string[]
}

export type Captions = Partial<Record<Network, NetCaption>>

export interface Watermark {
  enabled: boolean
  path: string | null
  /** tamanho original do PNG (já sem as bordas transparentes) */
  imgW: number
  imgH: number
  /** posição e largura no vídeo final (1080×1920); a posição só vale no modo livre */
  x: number
  y: number
  w: number
  /** 0..1 */
  opacity: number
  /** 'caption': fica sempre logo acima da legenda (acompanha ela); 'free': posição fixa */
  anchor: 'caption' | 'free'
  /** espaço entre a logo e o topo da legenda (px), no modo 'caption' */
  gap: number
  /** deslocamento horizontal em relação ao centro da legenda (px), no modo 'caption' */
  offsetX: number
}

export interface LlmInsight {
  score: number
  title: string
  reason: string
  tags: string[]
  hooks: string[]
  suggestedIn: number
  suggestedOut: number
  provider: LlmProvider
}

export type ClipStage = 'detected' | 'transcribing' | 'ranking' | 'ready' | 'error'
/** Preparação pra revisão: transcrição do corte, legenda por rede e render. */
export type ClipPrep = 'none' | 'queued' | 'working' | 'ready' | 'error'
export type RenderStatus = 'none' | 'queued' | 'rendering' | 'done' | 'stale' | 'error'

export interface ClipRender {
  status: RenderStatus
  progress: number
  path: string | null
  error: string | null
  renderedAt: string | null
}

export interface Clip {
  id: string
  projectId: string
  number: number
  origin: 'auto' | 'manual'
  peakSec: number
  winStart: number
  winEnd: number
  cutIn: number
  cutOut: number
  /** true enquanto o corte é o sugerido (a IA pode ajustar); vira false quando o usuário mexe */
  autoCut: boolean
  signalScore: number
  tags: DetectedTag[]
  stage: ClipStage
  stageError: string | null
  llm: LlmInsight | null
  approved: boolean
  layout: ClipLayout
  camSplit: CamSplit
  /** sugestão da IA escolhida; null = segue o padrão das configurações */
  hookChoice: number | null
  hookCustom: string
  /** gancho desligado só neste corte */
  hookOff: boolean
  /** ajustes deste corte por cima do padrão (posição arrastada no preview, etc.) */
  captionStyle: Partial<CaptionStyle> | null
  hookStyle: Partial<HookStyle> | null
  zoomEnabled: boolean
  zoomAt: number | null
  words: Word[] | null
  /** trecho da live que já foi transcrito */
  wordsFrom: number | null
  wordsTo: number | null
  cues: SubtitleCue[] | null
  captions: Captions | null
  watermark: Watermark | null
  previewPath: string | null
  previewStart: number | null
  previewEnd: number | null
  prep: ClipPrep
  prepMessage: string | null
  render: ClipRender
  createdAt: string
}

export interface DictEntry {
  term: string
  variants: string[]
}

export type CaptionAnim = 'none' | 'pop' | 'fade' | 'bounce' | 'reveal'
export type HookAnim = 'none' | 'fade' | 'pop' | 'slide' | 'typewriter'

/** Estilo de um texto queimado no vídeo. Medidas em pixels do vídeo final (1080×1920). */
export interface TextStyleBase {
  enabled: boolean
  /** nome da família da fonte (bate com o nome dentro do arquivo .ttf/.otf) */
  font: string
  size: number
  color: string
  outlineColor: string
  outlineWidth: number
  uppercase: boolean
  /** centro do texto; null em `y` da legenda = automático (logo abaixo da webcam) */
  x: number
  y: number | null
  /** largura da área onde o texto pode crescer antes de quebrar linha (px) */
  boxWidth: number
}

export interface CaptionStyle extends TextStyleBase {
  /** cor da palavra que está sendo falada */
  highlight: string
  shadow: boolean
  animation: CaptionAnim
}

export interface HookStyle extends TextStyleBase {
  /** caixa de fundo atrás do texto */
  box: boolean
  boxColor: string
  animation: HookAnim
  /** segundos na tela */
  duration: number
  /** texto padrão: sugestão da IA ou um texto fixo igual pra todos os cortes */
  mode: 'ai' | 'fixed'
  fixedText: string
}

export interface TextDefaults {
  caption: CaptionStyle
  hook: HookStyle
}

/** Como o streamer escreve: vai pro prompt da IA nas legendas das redes e nos ganchos. */
export interface WritingStyle {
  /** jeito de escrever, em texto livre (ex.: "falo 'chat', uso kkkk, nada de emoji") */
  notes: string
  /** palavras e frases que não quer ver (ex.: "épico, insano, você não vai acreditar") */
  avoid: string
  /** guardar como exemplo o que for postado/baixado (depois de editado) */
  learn: boolean
  /** jogo que mais joga: entra como padrão nos projetos novos */
  defaultGame: string
}

export type StyleExampleKind = 'hook' | 'caption'

export interface StyleExample {
  id: string
  kind: StyleExampleKind
  /** rede da legenda; null = vale pra todas */
  network: Network | null
  text: string
  title?: string
  hashtags: string[]
  source: 'manual' | 'posted'
  createdAt: string
}

export interface FontInfo {
  family: string
  file: string
  source: 'bundled' | 'user'
  bold: boolean
}

export interface Accounts {
  instagram: string
  tiktok: string
  youtube: string
}

export interface Settings {
  watchFolder: string
  watchEnabled: boolean
  llmProvider: LlmProvider
  openaiModel: string
  ollamaUrl: string
  ollamaModel: string
  whisperModel: string
  cropPreset: CropLayout | null
  watermark: Watermark
  dictionary: DictEntry[]
  deleteRawAfterDays: number | null
  musicMode: 'mute' | 'low'
  encoder: 'auto' | 'nvenc' | 'amf' | 'x264'
  windowSec: number
  maxCandidates: number
  accounts: Accounts
  text: TextDefaults
  style: WritingStyle
}

export type PostStatus = 'scheduled' | 'uploading' | 'posted' | 'draft' | 'failed' | 'canceled'

export interface Post {
  id: string
  clipId: string
  projectId: string
  network: Network
  status: PostStatus
  scheduledAt: string | null
  title: string | null
  text: string
  hashtags: string[]
  remoteId: string | null
  url: string | null
  error: string | null
  /** aviso da rede depois de postar (ex.: YouTube travou como privado) */
  note?: string | null
  createdAt: string
  postedAt: string | null
}

export interface PostMetric {
  postId: string
  fetchedAt: string
  views: number
  likes: number
  comments: number
}

export type ComponentKey = 'ffmpeg' | 'whisper' | 'whisperModel' | 'yamnet' | 'ytdlp'

export interface VodDownload {
  url: string
  progress: number
  status: 'downloading' | 'done' | 'error'
  message: string | null
}

export interface ComponentStatus {
  key: ComponentKey
  label: string
  ready: boolean
  detail: string
  downloading: boolean
  progress: number
}

export interface WatcherStatus {
  enabled: boolean
  folder: string
  exists: boolean
  pending: string[]
}

export interface ProjectSummary {
  id: string
  name: string
  liveDate: string | null
  createdAt: string
  status: ProjectStatus
  stages: StagesState
  durationSec: number | null
  clipCount: number
  approvedCount: number
  error: string | null
}

export interface ScheduleSuggestion {
  network: Network
  /** HH:MM */
  time: string
  reason: string
  basedOnPosts: number
}
