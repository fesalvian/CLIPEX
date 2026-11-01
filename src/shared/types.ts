// Tipos compartilhados entre o main process e o renderer.
// Tempos sempre em segundos, na linha do tempo do arquivo original.

export type Network = 'instagram' | 'tiktok' | 'youtube'
export const NETWORKS: readonly Network[] = ['instagram', 'tiktok', 'youtube']

export type LlmProvider = 'openai' | 'local'
/**
 * Tipo de clipe do perfil: gameplay (webcam + jogo, momentos por risada/grito), podcast
 * (conversas completas, câmera seguindo quem fala) ou vídeo 16:9 (o quadro inteiro no 9:16).
 */
export type ClipKind = 'gameplay' | 'podcast' | 'wide'
/**
 * both/game/cam: webcam e jogo recortados (gameplay); fit: o quadro 16:9 inteiro no meio,
 * com fundo desfocado; face: recorte 9:16 que segue o rosto de quem está falando.
 */
export type ClipLayout = 'both' | 'game' | 'cam' | 'fit' | 'face'
export type CamSplit = 30 | 40 | 50
export type DetectedTag = 'laugh' | 'scream' | 'peak' | 'manual' | 'talk'

/** Retângulo normalizado (0..1) sobre o frame da live. */
export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/** Trecho de um corte na linha do tempo da live (s). */
export interface Cut {
  s: number
  e: number
}

export interface CropLayout {
  cam: Rect
  game: Rect
}

/** Trecho em que a câmera fica parada num rosto: centro x (0..1 da largura da fonte), tempo na fonte. */
export interface FaceShot {
  s: number
  e: number
  x: number
}

/** Câmera seguindo o rosto de quem fala, calculada pra um pedaço da fonte. */
export interface FaceTrack {
  from: number
  to: number
  shots: FaceShot[]
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
  /** perfil (canal) dono do projeto */
  profileId: string
  /** tipo de clipe do perfil quando o projeto foi criado */
  kind: ClipKind
  /** criado pelo modo automático (download do canal ou pasta vigiada com postagem automática) */
  auto: boolean
  /** link de onde o vídeo foi baixado */
  sourceUrl: string | null
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
  /** início do primeiro trecho e fim do último */
  cutIn: number
  cutOut: number
  /** trechos que viram o vídeo (corte seco entre eles), em ordem e sem sobrepor */
  segments: Cut[]
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
  /** recorte próprio deste corte; null = segue o recorte padrão do projeto */
  crop: CropLayout | null
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
  /** logo própria deste corte; null = segue o padrão das configurações */
  watermark: Watermark | null
  /** câmera seguindo o rosto (layout 'face') */
  faces: FaceTrack | null
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

/** Configurações que valem pra todos os perfis. */
export const GLOBAL_SETTING_KEYS = [
  'llmProvider',
  'openaiModel',
  'ollamaUrl',
  'ollamaModel',
  'whisperModel',
  'startWithWindows',
  'encoder',
  'youtubeDailyUploads'
] as const

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
  /** abre com o Windows, direto na bandeja (app instalado) */
  startWithWindows: boolean
  musicMode: 'mute' | 'low'
  encoder: 'auto' | 'nvenc' | 'amf' | 'x264'
  windowSec: number
  maxCandidates: number
  accounts: Accounts
  text: TextDefaults
  style: WritingStyle
  /**
   * Uploads por dia no YouTube (todos os perfis): a cota padrão da API (10.000 unidades)
   * dá uns 6 uploads de 1.600 unidades.
   */
  youtubeDailyUploads: number
}

/** Canal vigiado: quando sai vídeo novo, o app baixa e começa a análise sozinho. */
export interface AutoSource {
  /** link do canal (YouTube ou Twitch) */
  url: string
  enabled: boolean
  /** vídeos mais curtos que isso são ignorados (min) */
  minMinutes: number
  /** qualidade máxima do download */
  maxHeight: 720 | 1080
  /** de quanto em quanto tempo olhar o canal (min) */
  checkEveryMin: number
  /** já marcou os vídeos antigos do canal como vistos */
  primed: boolean
  /** na primeira olhada, baixa também o vídeo mais recente */
  startWithLatest: boolean
  lastCheckAt: string | null
  lastError: string | null
  /** ids dos vídeos já tratados (baixados ou ignorados) */
  seen: string[]
}

/** Postagem automática: escolhe os melhores cortes, gera tudo e agenda sem pedir revisão. */
export interface AutoPost {
  enabled: boolean
  networks: Network[]
  /** cortes por dia em cada rede */
  perDay: number
  /** espalhar os cortes de um vídeo em até N dias */
  days: number
  /** nota mínima da IA (0 a 100) pra um corte ser postado */
  minScore: number
  /** duração máxima de um corte (s) */
  maxClipSec: number
  /** termos proibidos (um por linha ou separados por vírgula): o corte que falar algum fica de fora */
  blocklist: string
  /** freio: nada deste perfil é postado enquanto estiver pausado */
  paused: boolean
}

/** Perfil (como os perfis da Netflix): um canal de cortes com contas, estilo e fila próprios. */
export interface Profile {
  id: string
  name: string
  kind: ClipKind
  /** de quem são os vídeos (ex.: "podcast Broxada Sinistra", "streamer Alanzoka") */
  subject: string
  color: string
  createdAt: string
  source: AutoSource | null
  autoPost: AutoPost
}

export interface SourceStatus {
  profileId: string
  checking: boolean
  /** baixando agora */
  download: { title: string; progress: number } | null
  lastCheckAt: string | null
  lastError: string | null
  nextCheckAt: string | null
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
  /** agendado pela postagem automática (pode andar na fila quando chega vídeo novo) */
  auto?: boolean
  /** quando o vídeo subiu pra rede (conta a cota diária do YouTube) */
  uploadedAt?: string | null
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

export type ComponentKey = 'ffmpeg' | 'whisper' | 'whisperModel' | 'yamnet' | 'faces' | 'ytdlp'

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
  profileId: string
  kind: ClipKind
  auto: boolean
  name: string
  liveDate: string | null
  createdAt: string
  status: ProjectStatus
  stages: StagesState
  durationSec: number | null
  clipCount: number
  approvedCount: number
  error: string | null
  /** primeiro corte da lista (aprovado, se tiver): dá nome e capa pro card da live */
  cover: ProjectCover | null
}

export interface ProjectCover {
  clipId: string
  title: string
  /** primeira vez que esse corte foi postado em alguma rede */
  postedAt: string | null
  /** trecho leve do preview (16:9, cam + jogo) ou, sem ele, o vídeo final (9:16) */
  videoPath: string | null
  /** onde o corte começa dentro desse vídeo (s) */
  videoStart: number
  vertical: boolean
}

export interface ScheduleSuggestion {
  network: Network
  /** HH:MM */
  time: string
  reason: string
  basedOnPosts: number
}
