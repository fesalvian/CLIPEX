import { DEFAULT_TEXT } from './text'
import type {
  AutoPost,
  AutoSource,
  ClipKind,
  ClipLayout,
  ClipRender,
  CropLayout,
  Profile,
  Settings,
  StageKey,
  StagesState,
  Watermark,
  WritingStyle
} from './types'

export { OUT_H, OUT_W } from './consts'

/** Layout típico: jogo ocupando a maior parte, webcam no canto inferior direito. */
export const DEFAULT_CROP: CropLayout = {
  game: { x: 0.06, y: 0.08, w: 0.7, h: 0.84 },
  cam: { x: 0.76, y: 0.58, w: 0.21, h: 0.34 }
}

/** Sem PNG escolhido (o app usa a logo do canal; ver defaultSettings). */
export const DEFAULT_WATERMARK: Watermark = {
  enabled: false,
  path: null,
  imgW: 820,
  imgH: 180,
  x: 634,
  y: 56,
  w: 396,
  opacity: 0.8,
  anchor: 'free',
  gap: 36,
  offsetX: 0
}

/**
 * Logo do canal (@fesalvian), já sem as bordas transparentes (1018×224), presa acima da
 * legenda. Tamanho e espaço vêm de onde o Felipe posicionou ela no preview.
 */
export function channelLogo(path: string): Watermark {
  return { enabled: true, path, imgW: 1018, imgH: 224, x: 361, y: 1357, w: 358, opacity: 0.8, anchor: 'caption', gap: 36, offsetX: 0 }
}

export const STAGE_ORDER: readonly StageKey[] = [
  'probe',
  'audio',
  'events',
  'candidates',
  'transcribe',
  'rank',
  'previews',
  'proxy'
]

export const STAGE_LABEL: Record<StageKey, string> = {
  probe: 'Lendo o arquivo',
  audio: 'Extraindo o microfone',
  events: 'Detectando risadas e gritos',
  candidates: 'Escolhendo momentos',
  transcribe: 'Transcrevendo',
  rank: 'Avaliando com IA',
  previews: 'Gerando previews',
  proxy: 'Proxy 360p'
}

/** Podcast não procura risada/grito: transcreve o episódio inteiro e a IA acha as conversas. */
const PODCAST_ORDER: readonly StageKey[] = ['probe', 'audio', 'transcribe', 'candidates', 'previews', 'proxy']

export function stageOrder(kind: ClipKind): readonly StageKey[] {
  return kind === 'podcast' ? PODCAST_ORDER : STAGE_ORDER
}

export function stageLabel(kind: ClipKind, k: StageKey): string {
  if (kind === 'podcast') {
    if (k === 'audio') return 'Extraindo o áudio'
    if (k === 'transcribe') return 'Transcrevendo o episódio'
    if (k === 'candidates') return 'Achando conversas completas'
  }
  return STAGE_LABEL[k]
}

export function emptyStages(): StagesState {
  const s = {} as StagesState
  for (const k of STAGE_ORDER) s[k] = { status: 'pending', progress: 0 }
  return s
}

export function emptyRender(): ClipRender {
  return { status: 'none', progress: 0, path: null, error: null, renderedAt: null }
}

export function defaultSettings(videosDir: string, logoPath: string | null = null): Settings {
  return {
    watchFolder: `${videosDir}\\Lives\\Brutos`,
    watchEnabled: true,
    llmProvider: 'openai',
    openaiModel: 'gpt-5',
    ollamaUrl: 'http://127.0.0.1:11434',
    ollamaModel: '',
    whisperModel: 'ggml-large-v3-turbo-q8_0.bin',
    cropPreset: null,
    watermark: logoPath ? channelLogo(logoPath) : DEFAULT_WATERMARK,
    dictionary: [
      { term: 'Salvian', variants: ['salviano', 'sauvian', 'salvia'] },
      { term: 'AWP', variants: ['a w p', 'awp', 'a wp', 'ei dablio pi'] },
      { term: 'clutch', variants: ['clatch', 'cluch', 'clóti'] }
    ],
    deleteRawAfterDays: null,
    startWithWindows: true,
    musicMode: 'mute',
    encoder: 'auto',
    windowSec: 45,
    maxCandidates: 30,
    accounts: {
      instagram: '@fesalvian.lives',
      tiktok: '@fesalvian',
      youtube: '@felipesalvian'
    },
    text: DEFAULT_TEXT,
    style: DEFAULT_STYLE,
    youtubeDailyUploads: 6
  }
}

/** Perfil que já existia antes dos perfis: o canal do Felipe. */
export const DEFAULT_PROFILE_ID = 'fesalvian'

export const PROFILE_COLORS = ['#8B5CF6', '#3B82F6', '#FF9F45', '#3FC8E8', '#F472B6', '#34D399', '#FACC15', '#F87171']

export const KIND_LABEL: Record<ClipKind, string> = {
  gameplay: 'Gameplay',
  podcast: 'Podcast',
  wide: 'Clipe em 16:9'
}

/** Layout que cada tipo de clipe usa nos cortes novos. */
export function defaultLayout(kind: ClipKind): ClipLayout {
  return kind === 'podcast' ? 'face' : kind === 'wide' ? 'fit' : 'both'
}

/** Layouts que fazem sentido em cada tipo de clipe. */
export function layoutsFor(kind: ClipKind): ClipLayout[] {
  if (kind === 'podcast') return ['face', 'fit']
  if (kind === 'wide') return ['fit', 'face', 'game']
  return ['both', 'game', 'cam', 'fit']
}

export const LAYOUT_LABEL: Record<ClipLayout, string> = {
  both: 'Cam + jogo',
  game: 'Recorte',
  cam: 'Só cam',
  fit: 'Vídeo inteiro',
  face: 'Seguir quem fala'
}

export function defaultAutoPost(): AutoPost {
  return {
    enabled: false,
    networks: ['youtube', 'tiktok', 'instagram'],
    perDay: 3,
    days: 14,
    minScore: 70,
    maxClipSec: 90,
    blocklist: '',
    paused: false
  }
}

export function newSource(url: string): AutoSource {
  return {
    url,
    enabled: true,
    minMinutes: 10,
    maxHeight: 1080,
    checkEveryMin: 30,
    primed: false,
    startWithLatest: true,
    lastCheckAt: null,
    lastError: null,
    seen: []
  }
}

export function defaultProfile(): Profile {
  return {
    id: DEFAULT_PROFILE_ID,
    name: 'fesalvian',
    kind: 'gameplay',
    subject: 'Felipe Salviano ("Senhor Salvian"), streamer da Twitch',
    color: PROFILE_COLORS[0]!,
    createdAt: new Date(0).toISOString(),
    source: null,
    autoPost: defaultAutoPost()
  }
}

/**
 * Configurações de um perfil novo: sem a logo, o dicionário e as @ do Felipe, pasta vigiada
 * desligada e o bruto baixado apagado 3 dias depois de tudo postado (vídeos baixados ocupam muito).
 */
export function newProfileSettings(base: Settings): Settings {
  return {
    ...base,
    watchEnabled: false,
    cropPreset: null,
    watermark: DEFAULT_WATERMARK,
    dictionary: [],
    deleteRawAfterDays: 3,
    accounts: { instagram: '', tiktok: '', youtube: '' },
    text: DEFAULT_TEXT,
    style: DEFAULT_STYLE
  }
}

export const DEFAULT_STYLE: WritingStyle = { notes: '', avoid: '', learn: true, defaultGame: '' }

/** Duração mínima e máxima de um corte, em segundos. */
export const MIN_CUT = 5
export const MAX_CUT = 180
/** Duração inicial do corte manual: começa no ponto marcado e vai daí pra frente. */
export const MANUAL_CUT_SEC = 30
/** Reels publicados via API ficam limitados a 90 s. */
export const REELS_API_MAX = 90
