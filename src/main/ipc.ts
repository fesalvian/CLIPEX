import { copyFileSync, existsSync } from 'node:fs'
import { extname, join } from 'node:path'
import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeImage, shell } from 'electron'
import type { IpcApi, IpcChannel } from '@shared/ipc'
import { NETWORKS, type Network, type Watermark } from '@shared/types'
import { createManualClip, rebuildCues, updateClip } from './clips'
import { componentStatus, downloadComponent } from './components'
import { clipsRepo, projectsRepo } from './db'
import { env, setEnv } from './env'
import { exportClip, exportZip } from './export'
import { suggestTimes } from './learning'
import { listModels } from './llm'
import { loudnessBuckets } from './analysis/loudness'
import { ensureDir, isDev, userDataDir } from './paths'
import { enqueueAnalysis, makePreview, processClip, readFloat32, reanalyze, retryAnalysis } from './pipeline'
import { cancelPost, clients, planSchedule, schedulePosts } from './posting/scheduler'
import { applyDictionaryToClip, generateCaptions, generateHooks, prepareClips } from './prepare'
import { createProject, deleteProject, listSummaries, saveProject } from './projects'
import { cancelRender, enqueueRender, markProjectStale } from './render/queue'
import { getSettings, platformRules, resetWatchSince, updateSettings } from './settings'
import { importTwitchVod, isTwitchVodUrl } from './twitch'
import { startWatcher, watcherStatus } from './watcher'
import { postsRepo } from './db'
import { emit, toast } from './bus'

type Handler<K extends IpcChannel> = (...args: Parameters<IpcApi[K]>) => ReturnType<IpcApi[K]> | Promise<Awaited<ReturnType<IpcApi[K]>>>

function handle<K extends IpcChannel>(channel: K, fn: Handler<K>): void {
  ipcMain.handle(channel, async (_e, ...args: unknown[]) => {
    try {
      return await fn(...(args as Parameters<IpcApi[K]>))
    } catch (e) {
      // o renderer recebe só a mensagem, sem o stack do main
      throw new Error(e instanceof Error ? e.message : String(e))
    }
  })
}

function win(): BrowserWindow | undefined {
  return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
}

export function registerIpc(): void {
  handle('app:info', () => ({ version: app.getVersion(), userData: userDataDir(), isDev }))
  handle('app:platform-rules', () => platformRules())

  // ---------- projetos ----------
  handle('projects:list', () => listSummaries())
  handle('projects:get', (id) => projectsRepo.get(id))
  handle('projects:import', async (path) => {
    let file = path
    if (!file) {
      const w = win()
      const opts = {
        title: 'Importar gravação da live',
        properties: ['openFile' as const],
        filters: [{ name: 'Vídeo', extensions: ['mkv', 'mp4', 'mov', 'flv', 'ts'] }]
      }
      const r = w ? await dialog.showOpenDialog(w, opts) : await dialog.showOpenDialog(opts)
      if (r.canceled || !r.filePaths[0]) return null
      file = r.filePaths[0]
    }
    const p = createProject(file)
    enqueueAnalysis(p.id)
    return p
  })
  handle('projects:import-twitch', (url) => {
    if (!isTwitchVodUrl(url)) throw new Error('Cole o link de um vídeo da Twitch (twitch.tv/videos/...).')
    void importTwitchVod(url).catch((e: Error) => toast('error', e.message))
  })
  handle('projects:delete', (id) => deleteProject(id))
  handle('projects:reanalyze', (id) => reanalyze(id))
  handle('projects:retry', (id) => retryAnalysis(id))
  handle('projects:set-crop', (id, crop, saveAsPreset) => {
    const p = projectsRepo.get(id)
    if (!p) throw new Error('Projeto não encontrado')
    p.crop = crop
    if (saveAsPreset) updateSettings({ cropPreset: crop })
    markProjectStale(id)
    return saveProject(p)
  })
  handle('projects:open-folder', (id) => {
    const p = projectsRepo.get(id)
    if (p) void shell.openPath(existsSync(join(p.dir, 'renders')) ? join(p.dir, 'renders') : p.dir)
  })

  // ---------- cortes ----------
  handle('clips:list', (projectId) => clipsRepo.byProject(projectId))
  handle('clips:update', (id, patch) => updateClip(id, patch))
  handle('clips:create-manual', (projectId, at) => {
    const c = createManualClip(projectId, at)
    void processClip(c.id)
    return c
  })
  handle('clips:delete', (id) => {
    const c = clipsRepo.get(id)
    clipsRepo.delete(id)
    if (c) emit('clip:removed', { id, projectId: c.projectId })
  })
  handle('clips:loudness', (projectId, from, to, buckets) => {
    const p = projectsRepo.get(projectId)
    const file = p ? join(p.dir, 'loudness.f32') : ''
    if (!p || !existsSync(file)) return { from, to, values: [] }
    return { from, to, values: loudnessBuckets(readFloat32(file), from, to, buckets) }
  })
  handle('clips:ensure-preview', async (id) => {
    const c = await makePreview(id)
    if (!c) throw new Error('Corte não encontrado')
    return c
  })
  handle('clips:prepare', (ids) => prepareClips(ids))
  handle('clips:apply-dictionary', (id) => applyDictionaryToClip(id))
  handle('clips:reset-cues', (id) => {
    const c = clipsRepo.get(id)
    if (!c) throw new Error('Corte não encontrado')
    return updateClip(id, { cues: rebuildCues(c) })
  })

  // ---------- IA ----------
  handle('llm:hooks', (id, provider) => generateHooks(id, provider))
  handle('llm:captions', (id, provider) => generateCaptions(id, provider))
  handle('llm:models', (provider) => listModels(provider))

  // ---------- render e exportação ----------
  handle('render:clips', (ids) => {
    for (const id of ids) void enqueueRender(id).catch(() => undefined)
  })
  handle('render:cancel', (id) => cancelRender(id))
  handle('export:clip', (id) => exportClip(id))
  handle('export:zip', (projectId, ids) => exportZip(projectId, ids))

  // ---------- postagem ----------
  handle('posts:preview', (req) => planSchedule(req))
  handle('posts:schedule', (req) => schedulePosts(req))
  handle('posts:list', (projectId) => postsRepo.all(projectId))
  handle('posts:cancel', (id) => cancelPost(id))
  handle('posts:suggest-time', () => suggestTimes())
  handle('posts:connect', async (network) => {
    try {
      await clients[network].connect()
      return { ok: true, error: null }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })
  handle('posts:connections', async () => {
    const out = {} as Record<Network, { connected: boolean; account: string | null }>
    await Promise.all(
      NETWORKS.map(async (n) => {
        out[n] = await clients[n].connected().catch(() => ({ connected: false, account: null }))
      })
    )
    return out
  })

  // ---------- configurações ----------
  handle('settings:get', () => getSettings())
  handle('settings:update', (patch) => {
    const before = getSettings()
    const next = updateSettings(patch)
    if (patch.watchFolder !== undefined && patch.watchFolder !== before.watchFolder) resetWatchSince()
    if (patch.watchFolder !== undefined || patch.watchEnabled !== undefined) startWatcher()
    if (patch.watermark) {
      // marca d'água global mudou: renders que usam a global ficam velhos
      for (const p of projectsRepo.all()) {
        for (const c of clipsRepo.byProject(p.id)) if (!c.watermark && c.render.status === 'done') markProjectStale(p.id)
      }
    }
    return next
  })
  handle('settings:set-openai-key', (key) => setEnv('OPENAI_API_KEY', key))
  handle('settings:has-openai-key', () => env('OPENAI_API_KEY').length > 0)

  handle('watermark:pick', async () => {
    const w = win()
    const opts = { title: 'Escolher marca d’água (PNG)', properties: ['openFile' as const], filters: [{ name: 'PNG', extensions: ['png'] }] }
    const r = w ? await dialog.showOpenDialog(w, opts) : await dialog.showOpenDialog(opts)
    const file = r.filePaths[0]
    if (r.canceled || !file) return null
    const img = nativeImage.createFromPath(file)
    if (img.isEmpty()) throw new Error('Não consegui ler esse PNG.')
    const { width, height } = img.getSize()
    // copia pra pasta do app: o arquivo original pode sumir
    const dest = join(ensureDir(join(userDataDir(), 'assets')), `watermark_${Date.now()}${extname(file).toLowerCase()}`)
    copyFileSync(file, dest)
    const s = getSettings().watermark
    const wmW = Math.min(width, Math.max(120, s.w))
    const next: Watermark = { ...s, enabled: true, path: dest, imgW: width, imgH: height, w: wmW, x: Math.max(0, 1080 - wmW - 46) }
    return next
  })
  handle('dialog:pick-folder', async (initial) => {
    const w = win()
    const opts = { title: 'Pasta das gravações', defaultPath: initial ?? undefined, properties: ['openDirectory' as const, 'createDirectory' as const] }
    const r = w ? await dialog.showOpenDialog(w, opts) : await dialog.showOpenDialog(opts)
    return r.canceled ? null : (r.filePaths[0] ?? null)
  })
  handle('dialog:pick-video', async () => {
    const w = win()
    const opts = { properties: ['openFile' as const], filters: [{ name: 'Vídeo', extensions: ['mkv', 'mp4', 'mov'] }] }
    const r = w ? await dialog.showOpenDialog(w, opts) : await dialog.showOpenDialog(opts)
    return r.canceled ? null : (r.filePaths[0] ?? null)
  })

  handle('components:status', () => componentStatus())
  handle('components:download', (key) => {
    downloadComponent(key).then(
      () => toast('success', 'Download concluído.'),
      (e: Error) => toast('error', `Download falhou: ${e.message}`)
    )
  })

  handle('watcher:status', () => watcherStatus())
  handle('clipboard:write', (text) => clipboard.writeText(text))
}
