// Localiza e baixa os componentes externos: ffmpeg, whisper.cpp, modelo do Whisper e YAMNet.

import { execFile } from 'node:child_process'
import { createWriteStream, existsSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { join, sep } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'
import type { ComponentKey, ComponentStatus } from '@shared/types'
import { emit } from './bus'
import { encoderTestArgs, type VideoEncoder } from './ffmpeg/args'
import { componentsDir, ensureDir, isDev, vendorDir } from './paths'
import { getSettings } from './settings'

const pexec = promisify(execFile)

const WHISPER_REPO = 'ggml-org/whisper.cpp'
const MODEL_BASE = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main'
const YAMNET_URL = 'https://huggingface.co/andrelgomes/yamnet-onnx/resolve/main/yamnet.onnx'

function firstExisting(paths: string[]): string | null {
  for (const p of paths) if (p && existsSync(p)) return p
  return null
}

function unpacked(p: string): string {
  // Dentro do app empacotado, binários ficam em app.asar.unpacked.
  return p.replace(`app.asar${sep}`, `app.asar.unpacked${sep}`)
}

function bundledFfmpeg(): string | null {
  try {
    return unpacked(require('ffmpeg-static') as string)
  } catch {
    return null
  }
}

function bundledFfprobe(): string | null {
  try {
    return unpacked((require('ffprobe-static') as { path: string }).path)
  } catch {
    return null
  }
}

const SYSTEM_FFMPEG_DIRS = ['C:\\ffmpeg\\bin', 'C:\\Program Files\\ffmpeg\\bin']

function systemBinary(name: 'ffmpeg' | 'ffprobe'): string | null {
  const exe = process.platform === 'win32' ? `${name}.exe` : name
  const fromPath = (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':').map((d) => join(d, exe))
  return firstExisting([...SYSTEM_FFMPEG_DIRS.map((d) => join(d, exe)), ...fromPath])
}

export function ffmpegPath(): string {
  const p = firstExisting([bundledFfmpeg() ?? '']) ?? systemBinary('ffmpeg')
  if (!p) throw new Error('Não achei o ffmpeg. Instale o ffmpeg ou reinstale o app.')
  return p
}

export function ffprobePath(): string {
  const p = firstExisting([bundledFfprobe() ?? '']) ?? systemBinary('ffprobe')
  if (!p) throw new Error('Não achei o ffprobe.')
  return p
}

export function whisperExe(): string | null {
  return firstExisting([
    join(componentsDir(), 'whisper', 'whisper-cli.exe'),
    join(componentsDir(), 'whisper', 'Release', 'whisper-cli.exe'),
    isDev ? join(vendorDir(), 'whisper', 'Release', 'whisper-cli.exe') : ''
  ])
}

export function whisperModelPath(): string | null {
  const name = getSettings().whisperModel
  return firstExisting([join(componentsDir(), 'models', name), isDev ? join(vendorDir(), 'models', name) : ''])
}

const YTDLP_URL = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'

export function ytdlpPath(): string | null {
  return firstExisting([join(componentsDir(), 'yt-dlp.exe'), isDev ? join(vendorDir(), 'yt-dlp.exe') : ''])
}

export function yamnetPath(): string | null {
  return firstExisting([join(componentsDir(), 'models', 'yamnet.onnx'), isDev ? join(vendorDir(), 'models', 'yamnet.onnx') : ''])
}

export async function hasNvidiaGpu(): Promise<boolean> {
  try {
    await pexec('nvidia-smi', ['-L'], { windowsHide: true, timeout: 5000 })
    return true
  } catch {
    return false
  }
}

let encoderCache: VideoEncoder | null = null

/** Escolhe o encoder: NVENC (NVIDIA) → AMF (AMD) → libx264, testando de verdade. */
export async function videoEncoder(): Promise<VideoEncoder> {
  const pref = getSettings().encoder
  if (pref !== 'auto') return pref
  if (encoderCache) return encoderCache
  for (const enc of ['nvenc', 'amf'] as const) {
    try {
      await pexec(ffmpegPath(), encoderTestArgs(enc), { windowsHide: true, timeout: 15000 })
      encoderCache = enc
      return enc
    } catch {
      // encoder não disponível nesta máquina
    }
  }
  encoderCache = 'x264'
  return 'x264'
}

// ---------- downloads ----------

const progress: Partial<Record<ComponentKey, number>> = {}

function sizeLabel(path: string | null): string {
  if (!path) return ''
  const mb = statSync(path).size / 1024 / 1024
  return mb > 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`
}

export function componentStatus(): ComponentStatus[] {
  let ff: string | null = null
  try {
    ff = ffmpegPath()
  } catch {
    ff = null
  }
  const w = whisperExe()
  const m = whisperModelPath()
  const y = yamnetPath()
  const item = (key: ComponentKey, label: string, path: string | null, detail: string): ComponentStatus => ({
    key,
    label,
    ready: path !== null,
    detail: path ? detail : 'Não instalado',
    downloading: progress[key] !== undefined,
    progress: progress[key] ?? 0
  })
  return [
    item('ffmpeg', 'ffmpeg', ff, ff?.includes('ffmpeg-static') ? 'Empacotado no app' : (ff ?? '')),
    item('whisper', 'Whisper (transcrição)', w, w?.includes('vendor') ? 'whisper.cpp (dev)' : 'whisper.cpp'),
    item('whisperModel', 'Modelo do Whisper', m, `${getSettings().whisperModel} · ${sizeLabel(m)}`),
    item('yamnet', 'Detector de risada e grito', y, `YAMNet · ${sizeLabel(y)}`),
    item('ytdlp', 'Baixador de VOD da Twitch (plano B)', ytdlpPath(), 'yt-dlp')
  ]
}

function publish(): void {
  emit('components:changed', componentStatus())
}

async function download(url: string, dest: string, key: ComponentKey): Promise<void> {
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok || !res.body) throw new Error(`Download falhou (HTTP ${res.status})`)
  const total = Number(res.headers.get('content-length') ?? 0)
  let got = 0
  let lastEmit = 0
  const tmp = `${dest}.part`
  const body = Readable.fromWeb(res.body as import('node:stream/web').ReadableStream)
  body.on('data', (chunk: Buffer) => {
    got += chunk.length
    if (total > 0 && Date.now() - lastEmit > 400) {
      progress[key] = got / total
      lastEmit = Date.now()
      publish()
    }
  })
  await pipeline(body, createWriteStream(tmp))
  renameSync(tmp, dest)
}

async function latestWhisperAsset(gpu: boolean): Promise<string> {
  const res = await fetch(`https://api.github.com/repos/${WHISPER_REPO}/releases?per_page=8`, {
    headers: { accept: 'application/vnd.github+json' }
  })
  if (!res.ok) throw new Error(`GitHub respondeu ${res.status}`)
  const releases = (await res.json()) as { assets: { name: string; browser_download_url: string }[] }[]
  const want = gpu
    ? [/^whisper-bin-win-cuda-12[\d.]*-x64\.zip$/, /^whisper-cublas-12[\d.]*-bin-x64\.zip$/]
    : [/^whisper-blas-bin-x64\.zip$/, /^whisper-bin-x64\.zip$/]
  for (const r of releases) {
    for (const re of want) {
      const a = r.assets.find((x) => re.test(x.name))
      if (a) return a.browser_download_url
    }
  }
  throw new Error('Não achei uma versão do whisper.cpp pra Windows.')
}

/** Extrai o zip com o tar do Windows (bsdtar entende zip). */
async function unzip(zip: string, dir: string): Promise<void> {
  ensureDir(dir)
  await pexec('tar', ['-xf', zip, '-C', dir], { windowsHide: true, timeout: 10 * 60 * 1000 })
}

export async function downloadComponent(key: ComponentKey): Promise<void> {
  if (progress[key] !== undefined) return
  progress[key] = 0
  publish()
  try {
    const models = ensureDir(join(componentsDir(), 'models'))
    if (key === 'whisper') {
      const url = await latestWhisperAsset(await hasNvidiaGpu())
      const zip = join(componentsDir(), 'whisper.zip')
      await download(url, zip, key)
      const dir = join(componentsDir(), 'whisper')
      rmSync(dir, { recursive: true, force: true })
      await unzip(zip, dir)
      rmSync(zip, { force: true })
      // alguns zips vêm com uma pasta Release/ dentro
      if (!existsSync(join(dir, 'whisper-cli.exe')) && !readdirSync(dir).includes('Release')) {
        throw new Error('O pacote do Whisper veio sem o whisper-cli.exe.')
      }
    } else if (key === 'whisperModel') {
      const name = getSettings().whisperModel
      await download(`${MODEL_BASE}/${name}`, join(models, name), key)
    } else if (key === 'yamnet') {
      await download(YAMNET_URL, join(models, 'yamnet.onnx'), key)
    } else if (key === 'ytdlp') {
      await download(YTDLP_URL, join(componentsDir(), 'yt-dlp.exe'), key)
    } else {
      throw new Error('O ffmpeg vem junto com o app.')
    }
  } finally {
    delete progress[key]
    publish()
  }
}
