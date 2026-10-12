import type { PlatformRules } from './platformRules'
import type {
  Captions,
  Clip,
  ComponentKey,
  ComponentStatus,
  CropLayout,
  FontInfo,
  LlmProvider,
  Network,
  Post,
  Project,
  ProjectSummary,
  ScheduleSuggestion,
  Settings,
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
    | 'winStart'
    | 'winEnd'
    | 'approved'
    | 'layout'
    | 'camSplit'
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

export interface ScheduleRequest {
  clipIds: string[]
  networks: Network[]
  /** null = começar agora (o primeiro corte sai na hora) */
  firstAt: string | null
  /**
   * null = todos no mesmo horário; 1 = um por dia (no horário de firstAt, ou no melhor
   * horário de cada rede se for "agora"); n = n por dia nos melhores horários de cada rede
   */
  perDay: number | null
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

/** Chamadas renderer → main (ipcRenderer.invoke). */
export interface IpcApi {
  'app:info': () => { version: string; userData: string; isDev: boolean }
  'app:platform-rules': () => PlatformRules

  'projects:list': () => ProjectSummary[]
  'projects:get': (id: string) => Project | null
  'projects:import': (path: string | null) => Project | null
  'projects:import-twitch': (url: string) => void
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
  'posts:suggest-time': () => ScheduleSuggestion[]
  /** melhores horários de cada rede pra n cortes por dia */
  'posts:slots': (perDay: number) => Record<Network, string[]>
  'posts:connect': (network: Network) => { ok: boolean; error: string | null }
  'posts:connections': () => Record<Network, { connected: boolean; account: string | null }>

  'settings:get': () => Settings
  'settings:update': (patch: Partial<Settings>) => Settings
  'settings:set-openai-key': (key: string) => void
  'settings:has-openai-key': () => boolean

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
