import { create } from 'zustand'
import type { ClipPatch } from '@shared/ipc'
import type { Clip, ComponentStatus, FontInfo, Post, Project, ProjectSummary, Settings, WatcherStatus } from '@shared/types'
import { call, errorText } from './api'
import { loadFontFaces } from './lib/fonts'

export type Route =
  | { name: 'home' }
  | { name: 'settings' }
  | { name: 'clipar'; projectId: string }
  | { name: 'revisar'; projectId: string }

export interface Toast {
  id: number
  kind: 'info' | 'error' | 'success'
  text: string
}

interface State {
  route: Route
  projects: ProjectSummary[]
  project: Project | null
  clips: Record<string, Clip>
  posts: Post[]
  settings: Settings | null
  components: ComponentStatus[]
  watcher: WatcherStatus | null
  toasts: Toast[]
  /** volume da live inteira, 4 valores por segundo (a timeline de cada corte recorta daqui) */
  liveWave: LiveWave | null
  fonts: FontInfo[]

  go: (r: Route) => void
  openProject: (id: string, screen: 'clipar' | 'revisar') => Promise<void>
  setProject: (p: Project) => void
  upsertClip: (c: Clip) => void
  upsertClips: (list: Clip[]) => void
  removeClip: (id: string) => void
  patchClip: (id: string, patch: ClipPatch) => Promise<void>
  /** só local (arrastar alça); depois chama patchClip */
  previewClip: (id: string, patch: Partial<Clip>) => void
  loadLiveWave: (projectId: string, duration: number) => Promise<void>
  loadFonts: () => Promise<void>
  upsertPost: (p: Post) => void
  setSettings: (s: Settings) => void
  updateSettings: (patch: Partial<Settings>) => Promise<void>
  toast: (kind: Toast['kind'], text: string) => void
  dismiss: (id: number) => void
  set: (p: Partial<State>) => void
}

let toastId = 0

export const WAVE_RATE = 4

export interface LiveWave {
  projectId: string
  rate: number
  values: number[]
}

export const useStore = create<State>((set, get) => ({
  route: { name: 'home' },
  projects: [],
  project: null,
  clips: {},
  posts: [],
  settings: null,
  components: [],
  watcher: null,
  toasts: [],
  liveWave: null,
  fonts: [],

  go: (route) => set({ route }),

  openProject: async (id, screen) => {
    const cur = get().project
    if (cur?.id !== id) set({ project: null, clips: {}, posts: [], liveWave: null })
    set({ route: { name: screen, projectId: id } })
    const [project, clips, posts] = await Promise.all([call('projects:get', id), call('clips:list', id), call('posts:list', id)])
    if (!project) {
      get().toast('error', 'Projeto não encontrado.')
      set({ route: { name: 'home' } })
      return
    }
    set({ project, clips: Object.fromEntries(clips.map((c) => [c.id, c])), posts })
  },

  setProject: (p) => {
    if (get().project?.id === p.id) set({ project: p })
  },

  upsertClip: (c) => {
    if (get().project?.id !== c.projectId) return
    set({ clips: { ...get().clips, [c.id]: c } })
  },

  upsertClips: (list) => {
    const pid = get().project?.id
    const next = { ...get().clips }
    for (const c of list) if (c.projectId === pid) next[c.id] = c
    set({ clips: next })
  },

  removeClip: (id) => {
    const next = { ...get().clips }
    delete next[id]
    set({ clips: next })
  },

  previewClip: (id, patch) => {
    const c = get().clips[id]
    if (c) set({ clips: { ...get().clips, [id]: { ...c, ...patch } } })
  },

  patchClip: async (id, patch) => {
    const c = get().clips[id]
    if (c) set({ clips: { ...get().clips, [id]: { ...c, ...patch } } })
    try {
      const saved = await call('clips:update', id, patch)
      get().upsertClip(saved)
    } catch (e) {
      get().toast('error', errorText(e))
      if (c) get().upsertClip(c)
    }
  },

  loadLiveWave: async (projectId, duration) => {
    const cur = get().liveWave
    if (cur?.projectId === projectId && cur.values.length > 0) return
    const n = Math.max(1, Math.ceil(duration * WAVE_RATE))
    const r = await call('clips:loudness', projectId, 0, n / WAVE_RATE, n)
    if (r.values.length) set({ liveWave: { projectId, rate: WAVE_RATE, values: r.values } })
  },

  loadFonts: async () => {
    const fonts = await call('fonts:list')
    set({ fonts })
    await loadFontFaces(fonts)
  },

  upsertPost: (p) => {
    if (get().project?.id !== p.projectId) return
    const list = get().posts.filter((x) => x.id !== p.id)
    set({ posts: [...list, p] })
  },

  setSettings: (s) => set({ settings: s }),

  updateSettings: async (patch) => {
    const cur = get().settings
    if (cur) set({ settings: { ...cur, ...patch } })
    try {
      set({ settings: await call('settings:update', patch) })
    } catch (e) {
      get().toast('error', errorText(e))
    }
  },

  toast: (kind, text) => {
    const id = ++toastId
    set({ toasts: [...get().toasts.slice(-3), { id, kind, text }] })
    setTimeout(() => get().dismiss(id), kind === 'error' ? 9000 : 5000)
  },

  dismiss: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),

  set: (p) => set(p)
}))

export function clipList(clips: Record<string, Clip>): Clip[] {
  return Object.values(clips)
}

export function clipLabel(c: Clip): string {
  return `Clipe ${String(c.number).padStart(2, '0')}`
}

/** Nota mostrada na lista: a da IA quando existe, senão a força do sinal. */
export function clipScore(c: Clip): number {
  return c.llm ? c.llm.score : Math.round(c.signalScore * 100)
}
