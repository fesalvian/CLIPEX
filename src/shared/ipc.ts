import type { PlatformRules } from './platformRules'
import type {
  AutoSource,
  Captions,
  Clip,
  ClipKind,
  ClipRender,
  ComponentKey,
  ComponentStatus,
  CropLayout,
  FontInfo,
  LlmProvider,
  Network,
  Post,
  Profile,
  Project,
  ProjectSummary,
  ScheduleSuggestion,
  Settings,
  SourceStatus,
  StyleExample,
  SubtitleCue,
  VodDownload,
  WatcherStatus,
  Watermark
} from './types'

/** Campos de um corte que a interface pode alterar. */
export type ClipPatch = Partial<
  Pick<
    Clip,
    | 'cutIn'
    | 'cutOut'
    | 'segments'
    | 'winStart'
    | 'winEnd'
    | 'approved'
    | 'layout'
    | 'camSplit'
    | 'crop'
    | 'hookChoice'
    | 'hookCustom'
    | 'hookOff'
    | 'captionStyle'
    | 'hookStyle'
    | 'zoomEnabled'
    | 'zoomAt'
    | 'cues'
    | 'captions'
    | 'watermark'
  >
>

/** Um post na tela de agendados, com o nome do corte e da live. */
export interface PostOverviewItem {
  post: Post
  clipName: string
  projectName: string
  render: Pick<ClipRender, 'status' | 'error'> | null
}

export interface ScheduleRequest {
  clipIds: string[]
  networks: Network[]
  /** null = começar agora (o primeiro corte sai na hora) */
  firstAt: string | null
  /** com firstAt null: quantos cortes saem na hora (padrão 1); o resto segue o ritmo */
  nowCount?: number
  /**
   * null = todos no mesmo horário; 1 = um por dia (no horário de firstAt, ou no melhor
   * horário de cada rede se for "agora"); n = n por dia nos melhores horários de cada rede
   */
  perDay: number | null
}

/** Uma mudança de "organizar a fila": post repetido cancelado ou post em outro horário. */
export interface TidyChange {
  postId: string
  clipName: string
  projectName: string
  network: Network
  kind: 'cancel' | 'move'
  from: string | null
  to: string | null
  /** já está no YouTube (agendado lá): muda pelo YouTube */
  remote: boolean
}

export interface TidyPreview {
  perDay: number
  changes: TidyChange[]
  /** tem Short agendado no YouTube pra mudar e a conexão não tem permissão de editar */
  youtubeNeedsReconnect: boolean
}

export interface TidyResult {
  applied: number
  errors: string[]
}

export interface SchedulePreviewItem {
  clipId: string
  clipName: string
  network: Network
  at: string | null
  title: string | null
  text: string
  hashtags: string[]
  warnings: string[]
}

export interface LoudnessSlice {
  from: number
  to: number
  /** valores 0..1 por balde */
  values: number[]
}

export interface ExportResult {
  ok: boolean
  path: string | null
  error: string | null
}

export interface NewProfileInput {
  name: string
  kind: ClipKind
  subject: string
}

export type ProfilePatch = Partial<Pick<Profile, 'name' | 'subject' | 'color' | 'autoPost'>>

/** Chamadas renderer → main (ipcRenderer.invoke). */
export interface IpcApi {
  'app:info': () => { version: string; userData: string; isDev: boolean }
  'app:platform-rules': () => PlatformRules

  'profiles:list': () => Profile[]
  'profiles:active': () => string
  /** troca o perfil ativo (as telas passam a mostrar e editar esse perfil) */
  'profiles:select': (id: string) => Profile
  'profiles:create': (input: NewProfileInput) => Profile
  'profiles:update': (id: string, patch: ProfilePatch) => Profile
  /** exclui o perfil e os projetos dele (os vídeos brutos ficam) */
  'profiles:delete': (id: string) => Profile[]

  /** canal vigiado do perfil ativo: liga, muda ou desliga (null) */
  'sources:set': (patch: Partial<AutoSource> | null) => AutoSource | null
  'sources:check': () => void
  'sources:status': () => SourceStatus

  'projects:list': () => ProjectSummary[]
  'projects:get': (id: string) => Project | null
  'projects:import': (path: string | null) => Project | null
  'projects:import-twitch': (url: string) => void
  /** baixa um vídeo do YouTube ou da Twitch pelo link (perfil ativo) */
  'projects:import-url': (url: string) => void
  'projects:delete': (id: string) => void
  'projects:reanalyze': (id: string) => void
  'projects:retry': (id: string) => void
  'projects:set-crop': (id: string, crop: CropLayout, saveAsPreset: boolean) => Project
  'projects:set-game': (id: string, game: string) => Project
  'projects:open-folder': (id: string) => void

  'clips:list': (projectId: string) => Clip[]
  'clips:update': (clipId: string, patch: ClipPatch) => Clip
  'clips:create-manual': (projectId: string, atSec: number) => Clip
  'clips:delete': (clipId: string) => void
  'clips:loudness': (projectId: string, from: number, to: number, buckets: number) => LoudnessSlice
  'clips:ensure-preview': (clipId: string) => Clip
  'clips:prepare': (clipIds: string[]) => void
  'clips:apply-dictionary': (clipId: string) => Clip
  'clips:reset-cues': (clipId: string) => Clip
  /** calcula a câmera seguindo quem fala (layout 'face') */
  'clips:ensure-faces': (clipId: string) => Clip

  'llm:hooks': (clipId: string, provider: LlmProvider) => string[]
  'llm:captions': (clipId: string, provider: LlmProvider) => Captions
  'llm:models': (provider: LlmProvider) => string[]

  'render:clips': (clipIds: string[]) => void
  'render:cancel': (clipId: string) => void

  'export:clip': (clipId: string) => ExportResult
  'export:zip': (projectId: string, clipIds: string[]) => ExportResult

  'posts:preview': (req: ScheduleRequest) => SchedulePreviewItem[]
  'posts:schedule': (req: ScheduleRequest) => Post[]
  'posts:list': (projectId: string | null) => Post[]
  'posts:cancel': (postId: string) => Post
  'posts:retry': (postId: string) => Post
  'posts:overview': () => PostOverviewItem[]
  /** organizar a fila: tira repetidos e espalha (no máximo n por dia em cada rede) */
  'posts:tidy-preview': (perDay: number) => TidyPreview
  'posts:tidy-apply': (perDay: number) => TidyResult
  'posts:suggest-time': () => ScheduleSuggestion[]
  /** melhores horários de cada rede pra n cortes por dia */
  'posts:slots': (perDay: number) => Record<Network, string[]>
  'posts:connect': (network: Network) => { ok: boolean; error: string | null }
  'posts:connections': () => Record<Network, { connected: boolean; account: string | null }>

  'settings:get': () => Settings
  'settings:update': (patch: Partial<Settings>) => Settings
  'settings:set-openai-key': (key: string) => void
  'settings:has-openai-key': () => boolean
  /** troca o token do Instagram no .env e já testa */
  'settings:set-instagram-token': (token: string) => { ok: boolean; error: string | null }

  'watermark:pick': () => Watermark | null
  'dialog:pick-folder': (initial: string | null) => string | null
  'dialog:pick-video': () => string | null

  'style:list': () => StyleExample[]
  'style:add': (ex: Omit<StyleExample, 'id' | 'createdAt'>) => StyleExample[]
  'style:remove': (id: string) => StyleExample[]

  'fonts:list': () => FontInfo[]
  'fonts:import': () => { added: FontInfo[]; rejected: string[] }
  'fonts:remove': (family: string) => FontInfo[]

  'components:status': () => ComponentStatus[]
  'components:download': (key: ComponentKey) => void

  'watcher:status': () => WatcherStatus

  'clipboard:write': (text: string) => void
}

/** Eventos main → renderer. */
export interface IpcEvents {
  'project:updated': Project
  'projects:changed': ProjectSummary[]
  'clip:updated': Clip
  'clips:added': Clip[]
  'clip:removed': { id: string; projectId: string }
  'components:changed': ComponentStatus[]
  'watcher:changed': WatcherStatus
  'post:updated': Post
  'vod:progress': VodDownload
  'profiles:changed': Profile[]
  'source:status': SourceStatus
  'toast': { kind: 'info' | 'error' | 'success'; text: string }
}

export type IpcChannel = keyof IpcApi
export type IpcEventName = keyof IpcEvents

export interface ExposedApi {
  invoke<K extends IpcChannel>(channel: K, ...args: Parameters<IpcApi[K]>): Promise<Awaited<ReturnType<IpcApi[K]>>>
  on<K extends IpcEventName>(event: K, listener: (payload: IpcEvents[K]) => void): () => void
  mediaUrl(path: string): string
}

export const MEDIA_SCHEME = 'clipador-media'

export type { SubtitleCue }
