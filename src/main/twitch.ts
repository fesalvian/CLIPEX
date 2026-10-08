// Plano B: baixar o VOD da Twitch com yt-dlp quando não tem gravação local.
// Nesse caso só existe uma faixa de áudio misturada e a detecção usa ela.

import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { VodDownload } from '@shared/types'
import { emit, toast } from './bus'
import { downloadComponent, ffmpegPath, ytdlpPath } from './components'
import { ensureDir, userDataDir } from './paths'
import { enqueueAnalysis } from './pipeline'
import { runProcess } from './proc'
import { createProject } from './projects'

export function isTwitchVodUrl(url: string): boolean {
  return /^https?:\/\/(www\.|m\.)?twitch\.tv\/(videos\/\d+|[\w-]+\/(video|v)\/\d+)/i.test(url.trim())
}

/** Nome no padrão das gravações do OBS, pra data da live virar o nome do projeto. */
export const VOD_TEMPLATE = 'live_%(timestamp>%Y-%m-%d_%H-%M)s_%(id)s.%(ext)s'

export function ytdlpArgs(url: string, outDir: string, ffmpegDir: string): string[] {
  return [
    '--newline',
    '--no-part',
    '--ffmpeg-location', ffmpegDir,
    '-f', 'best',
    '-o', join(outDir, VOD_TEMPLATE),
    '--print', 'after_move:filepath',
    url.trim()
  ]
}

export function parseYtdlpProgress(line: string): number | null {
  const m = /\[download\]\s+([\d.]+)%/.exec(line)
  return m ? Number(m[1]) / 100 : null
}

export async function importTwitchVod(url: string): Promise<void> {
  if (!isTwitchVodUrl(url)) throw new Error('Cole o link de um vídeo da Twitch (twitch.tv/videos/...).')
  if (!ytdlpPath()) await downloadComponent('ytdlp')
  const exe = ytdlpPath()
  if (!exe) throw new Error('Não consegui baixar o yt-dlp.')
  const outDir = ensureDir(join(userDataDir(), 'vods'))
  const state: VodDownload = { url, progress: 0, status: 'downloading', message: null }
  emit('vod:progress', state)
  let finalPath = null as string | null
  let last = 0
  const before = new Set(readdirSync(outDir))
  try {
    await runProcess(exe, ytdlpArgs(url, outDir, dirname(ffmpegPath())), {
      onStdoutLine: (line) => {
        const p = parseYtdlpProgress(line)
        if (p !== null && Date.now() - last > 500) {
          last = Date.now()
          emit('vod:progress', { ...state, progress: p })
        } else if (/\.(mp4|mkv|ts)$/i.test(line.trim())) {
          finalPath = line.trim()
        }
      }
    }).done
    finalPath ??= readdirSync(outDir).filter((f) => !before.has(f)).map((f) => join(outDir, f))[0] ?? null
    if (!finalPath) throw new Error('O download terminou mas não achei o arquivo.')
    emit('vod:progress', { ...state, progress: 1, status: 'done' })
    const p = createProject(finalPath)
    enqueueAnalysis(p.id)
    toast('success', `VOD baixado: ${p.name}. A análise começou.`)
  } catch (e) {
    const message = (e as Error).message.split('\n').slice(-2).join(' ')
    emit('vod:progress', { ...state, status: 'error', message })
    toast('error', `Download do VOD falhou: ${message}`)
  }
}
