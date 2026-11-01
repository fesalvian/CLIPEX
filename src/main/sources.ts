// Download automático: o perfil aponta pra um canal (YouTube ou Twitch) e o app olha o canal
// de tempos em tempos com o yt-dlp. Vídeo novo (longo o bastante e que não é live rolando)
// é baixado e vira um projeto do perfil, marcado como automático (a postagem automática pega
// daí). Também baixa um vídeo avulso por link (plano B).

import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { newSource } from '@shared/defaults'
import type { AutoSource, SourceStatus, VodDownload } from '@shared/types'
import { emit, toast } from './bus'
import { downloadComponent, ffmpegPath, ytdlpPath } from './components'
import { projectsRepo } from './db'
import { downloadsDir, ensureDir } from './paths'
import { enqueueAnalysis } from './pipeline'
import { runProcess } from './proc'
import { activeProfile, getProfile, listProfiles, updateProfile } from './profiles'
import { createProject } from './projects'
import { Semaphore } from './sema'
import { parseYtdlpProgress } from './twitch'

/** Quantos vídeos do topo do canal olhar a cada vez. */
const LIST_SIZE = 8
/** Quantos ids de vídeos já vistos guardar por canal. */
const SEEN_MAX = 300
const TICK_MS = 60_000

export function isYoutubeUrl(url: string): boolean {
  return /^https?:\/\/((www|m)\.)?(youtube\.com|youtu\.be)\//i.test(url.trim())
}

export function isTwitchUrl(url: string): boolean {
  return /^https?:\/\/((www|m)\.)?twitch\.tv\//i.test(url.trim())
}

/** Link de um vídeo só (não de canal). */
export function isVideoUrl(url: string): boolean {
  const u = url.trim()
  return (
    /^https?:\/\/((www|m)\.)?youtube\.com\/(watch\?|live\/|shorts\/)/i.test(u) ||
    /^https?:\/\/youtu\.be\/[\w-]+/i.test(u) ||
    /^https?:\/\/((www|m)\.)?twitch\.tv\/(videos\/\d+|[\w-]+\/(video|v)\/\d+)/i.test(u)
  )
}

/**
 * Link da lista de vídeos do canal: no YouTube a aba "Vídeos" (sem Shorts e lives), na
 * Twitch os VODs das lives, mais novos primeiro. Devolve null se não for canal.
 */
export function channelListUrl(url: string): string | null {
  const u = url.trim().replace(/\/+$/, '')
  if (isVideoUrl(u)) return null
  if (isYoutubeUrl(u)) {
    const m = /^(https?:\/\/(?:(?:www|m)\.)?youtube\.com\/(?:@[\w.-]+|channel\/[\w-]+|c\/[\w.-]+|user\/[\w.-]+))(\/[\w]+)?/i.exec(u)
    if (!m) return null
    const tab = (m[2] ?? '').toLowerCase()
    return `${m[1]}${tab === '/streams' || tab === '/videos' ? tab : '/videos'}`
  }
  if (isTwitchUrl(u)) {
    const m = /^https?:\/\/(?:(?:www|m)\.)?twitch\.tv\/([\w]+)/i.exec(u)
    if (!m || ['videos', 'directory'].includes(m[1]!.toLowerCase())) return null
    return `https://www.twitch.tv/${m[1]}/videos?filter=archives&sort=time`
  }
  return null
}

export interface ListedVideo {
  id: string
  title: string
  url: string
  /** segundos (nem sempre vem na listagem) */
  duration: number | null
  liveStatus: string | null
}

/** Vídeos da listagem `--flat-playlist -J` do yt-dlp, na ordem do canal (mais novo primeiro). */
export function parseListing(json: unknown): ListedVideo[] {
  const entries = (json as { entries?: Record<string, unknown>[] }).entries ?? []
  const out: ListedVideo[] = []
  for (const e of entries) {
    const id = typeof e.id === 'string' ? e.id : null
    if (!id) continue
    const url = typeof e.url === 'string' && /^https?:/.test(e.url) ? e.url : typeof e.webpage_url === 'string' ? e.webpage_url : null
    if (!url) continue
    out.push({
      id,
      title: typeof e.title === 'string' ? e.title : id,
      url,
      duration: typeof e.duration === 'number' ? e.duration : null,
      liveStatus: typeof e.live_status === 'string' ? e.live_status : null
    })
  }
  return out
}

export interface VideoInfo {
  id: string
  title: string
  duration: number
  liveStatus: string | null
  /** AAAA-MM-DD */
  date: string | null
}

export function parseVideoInfo(json: unknown): VideoInfo {
  const j = json as Record<string, unknown>
  const raw = typeof j.upload_date === 'string' ? j.upload_date : null
  return {
    id: String(j.id ?? ''),
    title: String(j.title ?? j.id ?? ''),
    duration: typeof j.duration === 'number' ? j.duration : 0,
    liveStatus: typeof j.live_status === 'string' ? j.live_status : j.is_live === true ? 'is_live' : null,
    date: raw && /^\d{8}$/.test(raw) ? `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}` : null
  }
}

/** Live acontecendo, agendada ou ainda processando: não dá pra baixar inteira agora. */
export function notReadyYet(liveStatus: string | null): boolean {
  return liveStatus === 'is_live' || liveStatus === 'is_upcoming' || liveStatus === 'post_live'
}

export function listArgs(url: string, n = LIST_SIZE): string[] {
  return ['-J', '--flat-playlist', '--playlist-end', String(n), '--no-warnings', url]
}

export function infoArgs(url: string): string[] {
  return ['-J', '--no-playlist', '--skip-download', '--no-warnings', url]
}

/** Baixa até `maxHeight` (vídeo e áudio juntos num MKV) e imprime o caminho final. */
export function downloadArgs(url: string, outDir: string, ffmpegDir: string, maxHeight: number): string[] {
  return [
    '--newline',
    '--no-part',
    '--no-playlist',
    '--ffmpeg-location', ffmpegDir,
    '-f', `bv*[height<=${maxHeight}]+ba/b[height<=${maxHeight}]/b`,
    '--merge-output-format', 'mkv',
    '-o', join(outDir, '%(upload_date>%Y-%m-%d)s_%(id)s.%(ext)s'),
    '--print', 'after_move:filepath',
    url.trim()
  ]
}

async function ytdlp(): Promise<string> {
  if (!ytdlpPath()) await downloadComponent('ytdlp')
  const exe = ytdlpPath()
  if (!exe) throw new Error('Não consegui baixar o yt-dlp.')
  return exe
}

async function ytdlpJson(args: string[]): Promise<unknown> {
  const exe = await ytdlp()
  let out = ''
  await runProcess(exe, args, { onStdoutLine: (l) => (out += l) }).done
  return JSON.parse(out)
}

/** Canal da Twitch ao vivo agora? (o VOD mais recente ainda está sendo gravado) */
async function twitchLiveNow(channelUrl: string): Promise<boolean> {
  const m = /twitch\.tv\/([\w]+)/i.exec(channelUrl)
  if (!m) return false
  try {
    const info = parseVideoInfo(await ytdlpJson(['-J', '--skip-download', '--no-warnings', `https://www.twitch.tv/${m[1]}`]))
    return info.liveStatus === 'is_live' || info.liveStatus === null
  } catch {
    // canal offline: o yt-dlp responde com erro
    return false
  }
}

// ---------------- estado (pra tela) ----------------

const status = new Map<string, SourceStatus>()

function nextCheck(src: AutoSource): string | null {
  if (!src.enabled) return null
  const last = src.lastCheckAt ? new Date(src.lastCheckAt).getTime() : 0
  return new Date(Math.max(Date.now(), last + src.checkEveryMin * 60_000)).toISOString()
}

export function sourceStatus(profileId: string): SourceStatus {
  const src = getProfile(profileId).source
  const cur = status.get(profileId)
  return {
    profileId,
    checking: cur?.checking ?? false,
    download: cur?.download ?? null,
    lastCheckAt: src?.lastCheckAt ?? null,
    lastError: src?.lastError ?? null,
    nextCheckAt: src ? nextCheck(src) : null
  }
}

function setStatus(profileId: string, patch: Partial<SourceStatus>): void {
  status.set(profileId, { ...sourceStatus(profileId), ...patch })
  emit('source:status', sourceStatus(profileId))
}

function patchSource(profileId: string, patch: Partial<AutoSource>): AutoSource | null {
  const p = getProfile(profileId)
  if (!p.source) return null
  const next = { ...p.source, ...patch }
  updateProfile(profileId, { source: next })
  return next
}

// ---------------- download ----------------

const downloads = new Semaphore(1)

interface DownloadJob {
  url: string
  profileId: string
  title: string
  date: string | null
  maxHeight: number
  auto: boolean
}

/** Baixa um vídeo e cria o projeto do perfil (a análise começa sozinha). */
async function downloadVideo(job: DownloadJob): Promise<string> {
  return downloads.run(async () => {
    const exe = await ytdlp()
    const outDir = ensureDir(join(downloadsDir(), job.profileId))
    const state: VodDownload = { url: job.url, progress: 0, status: 'downloading', message: null }
    emit('vod:progress', state)
    setStatus(job.profileId, { download: { title: job.title, progress: 0 } })
    let finalPath = null as string | null
    let last = 0
    const before = new Set(readdirSync(outDir))
    try {
      await runProcess(exe, downloadArgs(job.url, outDir, dirname(ffmpegPath()), job.maxHeight), {
        onStdoutLine: (line) => {
          const p = parseYtdlpProgress(line)
          if (p !== null && Date.now() - last > 500) {
            last = Date.now()
            emit('vod:progress', { ...state, progress: p })
            setStatus(job.profileId, { download: { title: job.title, progress: p } })
          } else if (/\.(mp4|mkv|webm|ts)$/i.test(line.trim())) {
            finalPath = line.trim()
          }
        }
      }).done
      finalPath ??= readdirSync(outDir).filter((f) => !before.has(f)).map((f) => join(outDir, f))[0] ?? null
      if (!finalPath) throw new Error('O download terminou mas não achei o arquivo.')
      emit('vod:progress', { ...state, progress: 1, status: 'done' })
      const p = createProject(finalPath, {
        profileId: job.profileId,
        name: job.title.slice(0, 80),
        liveDate: job.date,
        auto: job.auto,
        sourceUrl: job.url
      })
      enqueueAnalysis(p.id)
      return p.name
    } catch (e) {
      const message = (e as Error).message.split('\n').slice(-2).join(' ')
      emit('vod:progress', { ...state, status: 'error', message })
      throw new Error(message)
    } finally {
      setStatus(job.profileId, { download: null })
    }
  })
}

/** Vídeo avulso por link (YouTube ou Twitch), no perfil ativo. */
export async function importVideoUrl(url: string): Promise<void> {
  if (!isVideoUrl(url)) throw new Error('Cole o link de um vídeo do YouTube ou da Twitch.')
  const profile = activeProfile()
  try {
    const info = parseVideoInfo(await ytdlpJson(infoArgs(url)))
    if (notReadyYet(info.liveStatus)) throw new Error('Esse vídeo é uma live que ainda não terminou. Tente quando acabar.')
    const name = await downloadVideo({
      url,
      profileId: profile.id,
      title: info.title,
      date: info.date,
      maxHeight: profile.source?.maxHeight ?? 1080,
      auto: false
    })
    toast('success', `Vídeo baixado: ${name}. A análise começou.`)
  } catch (e) {
    toast('error', `Download falhou: ${(e as Error).message}`)
  }
}

// ---------------- canal vigiado ----------------

const checking = new Set<string>()

/** Olha o canal do perfil agora: marca o que já existia e baixa o que é novo. */
export async function checkSource(profileId: string): Promise<void> {
  const profile = getProfile(profileId)
  const src = profile.source
  if (!src || checking.has(profileId)) return
  const list = channelListUrl(src.url)
  if (!list) {
    patchSource(profileId, { lastError: 'Link de canal inválido (use o link do canal no YouTube ou na Twitch).', lastCheckAt: new Date().toISOString() })
    return
  }
  checking.add(profileId)
  setStatus(profileId, { checking: true })
  try {
    const videos = parseListing(await ytdlpJson(listArgs(list)))
    // Twitch ao vivo: o VOD do topo é a live rolando (baixaria pela metade); espera acabar
    if (isTwitchUrl(list) && videos.length && (await twitchLiveNow(list))) videos.shift()
    let seen = new Set(src.seen)
    // primeira olhada: o que já estava no canal não é baixado (só o mais recente, se pedir)
    if (!src.primed) {
      const skip = src.startWithLatest ? videos.slice(1) : videos
      for (const v of skip) seen.add(v.id)
      patchSource(profileId, { primed: true, seen: [...seen].slice(-SEEN_MAX) })
    }
    // do mais antigo pro mais novo
    for (const v of [...videos].reverse()) {
      if (seen.has(v.id) || notReadyYet(v.liveStatus)) continue
      const already = projectsRepo.all().some((p) => p.sourceUrl === v.url)
      const info = parseVideoInfo(await ytdlpJson(infoArgs(v.url)))
      const duration = info.duration || v.duration || 0
      if (notReadyYet(info.liveStatus)) continue
      const markSeen = (): void => {
        seen = new Set(getProfile(profileId).source?.seen ?? [])
        seen.add(v.id)
        patchSource(profileId, { seen: [...seen].slice(-SEEN_MAX) })
      }
      if (already || duration < src.minMinutes * 60) {
        markSeen()
        continue
      }
      toast('info', `${profile.name}: vídeo novo no canal, baixando "${v.title}".`)
      const cur = getProfile(profileId)
      const name = await downloadVideo({
        url: v.url,
        profileId,
        title: info.title || v.title,
        date: info.date,
        maxHeight: cur.source?.maxHeight ?? 1080,
        auto: true
      })
      markSeen()
      toast('success', `${profile.name}: "${name}" baixado. A análise começou.`)
    }
    patchSource(profileId, { lastCheckAt: new Date().toISOString(), lastError: null })
  } catch (e) {
    const msg = (e as Error).message.split('\n').filter(Boolean).slice(-1)[0] ?? 'erro desconhecido'
    patchSource(profileId, { lastCheckAt: new Date().toISOString(), lastError: msg })
  } finally {
    checking.delete(profileId)
    setStatus(profileId, { checking: false })
  }
}

/** Liga um canal no perfil (ou troca o link). A primeira olhada acontece em seguida. */
export function setSource(profileId: string, patch: Partial<AutoSource> | null): AutoSource | null {
  const p = getProfile(profileId)
  if (patch === null) {
    updateProfile(profileId, { source: null })
    emit('source:status', sourceStatus(profileId))
    return null
  }
  const url = patch.url?.trim() ?? p.source?.url ?? ''
  if (patch.url !== undefined && !channelListUrl(url)) {
    throw new Error('Cole o link do canal (ex.: youtube.com/@canal ou twitch.tv/canal), não de um vídeo.')
  }
  // trocou de canal: começa do zero (marca o que já existe nele como visto)
  const fresh = !p.source || (patch.url !== undefined && url !== p.source.url)
  const next: AutoSource = { ...(fresh ? newSource(url) : p.source!), ...patch, url }
  updateProfile(profileId, { source: next })
  emit('source:status', sourceStatus(profileId))
  if (next.enabled && fresh) setTimeout(() => void checkSource(profileId), 1000)
  return next
}

let timer: NodeJS.Timeout | null = null

function tick(): void {
  const now = Date.now()
  for (const p of listProfiles()) {
    const src = p.source
    if (!src?.enabled) continue
    const last = src.lastCheckAt ? new Date(src.lastCheckAt).getTime() : 0
    if (now - last >= src.checkEveryMin * 60_000) void checkSource(p.id)
  }
}

export function startSources(): void {
  if (timer) clearInterval(timer)
  timer = setInterval(tick, TICK_MS)
  setTimeout(tick, 20_000)
}

export function stopSources(): void {
  if (timer) clearInterval(timer)
  timer = null
}

/** Baixando ou olhando algum canal agora (não reiniciar o app no meio). */
export function sourcesBusy(): boolean {
  return checking.size > 0 || downloads.pending > 0 || [...status.values()].some((s) => s.download !== null)
}
