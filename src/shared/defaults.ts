import type { ClipRender, CropLayout, Settings, StageKey, StagesState, Watermark } from './types'

export const OUT_W = 1080
export const OUT_H = 1920

/** Layout típico: jogo ocupando a maior parte, webcam no canto inferior direito. */
export const DEFAULT_CROP: CropLayout = {
  game: { x: 0.06, y: 0.08, w: 0.7, h: 0.84 },
  cam: { x: 0.76, y: 0.58, w: 0.21, h: 0.34 }
}

export const DEFAULT_WATERMARK: Watermark = {
  enabled: false,
  path: null,
  imgW: 820,
  imgH: 180,
  x: 634,
  y: 56,
  w: 396,
  opacity: 0.8
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

export function emptyStages(): StagesState {
  const s = {} as StagesState
  for (const k of STAGE_ORDER) s[k] = { status: 'pending', progress: 0 }
  return s
}

export function emptyRender(): ClipRender {
  return { status: 'none', progress: 0, path: null, error: null, renderedAt: null }
}

export function defaultSettings(videosDir: string): Settings {
  return {
    watchFolder: `${videosDir}\\Lives\\Brutos`,
    watchEnabled: true,
    llmProvider: 'openai',
    openaiModel: 'gpt-5',
    ollamaUrl: 'http://127.0.0.1:11434',
    ollamaModel: '',
    whisperModel: 'ggml-large-v3-turbo-q8_0.bin',
    cropPreset: null,
    watermark: DEFAULT_WATERMARK,
    dictionary: [
      { term: 'Salvian', variants: ['salviano', 'sauvian', 'salvia'] },
      { term: 'AWP', variants: ['a w p', 'awp', 'a wp', 'ei dablio pi'] },
      { term: 'clutch', variants: ['clatch', 'cluch', 'clóti'] }
    ],
    deleteRawAfterDays: null,
    musicMode: 'mute',
    encoder: 'auto',
    windowSec: 45,
    maxCandidates: 30,
    accounts: {
      instagram: '@fesalvian.lives',
      tiktok: '@fesalvian',
      youtube: '@felipesalvian'
    }
  }
}

/** Duração mínima e máxima de um corte, em segundos. */
export const MIN_CUT = 5
export const MAX_CUT = 180
/** Reels publicados via API ficam limitados a 90 s. */
export const REELS_API_MAX = 90
/** Duração do gancho na tela. */
export const HOOK_SECONDS = 3
