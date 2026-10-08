import { describe, expect, it, vi } from 'vitest'

// twitch.ts importa módulos do Electron indiretamente; aqui só interessam as funções puras.
vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => '', getPath: () => '' }, BrowserWindow: { getAllWindows: () => [] } }))

const { isTwitchVodUrl, parseYtdlpProgress, ytdlpArgs, VOD_TEMPLATE } = await import('../src/main/twitch')
const { parseLiveDate } = await import('@shared/time')

describe('VOD da Twitch', () => {
  it('aceita só link de vídeo', () => {
    expect(isTwitchVodUrl('https://www.twitch.tv/videos/2283746512')).toBe(true)
    expect(isTwitchVodUrl('https://twitch.tv/senhorsalvian/video/2283746512')).toBe(true)
    expect(isTwitchVodUrl('https://www.twitch.tv/senhorsalvian')).toBe(false)
    expect(isTwitchVodUrl('https://youtube.com/watch?v=x')).toBe(false)
  })

  it('lê o progresso do yt-dlp', () => {
    expect(parseYtdlpProgress('[download]  42.7% of ~ 3.21GiB at  9.81MiB/s ETA 03:12 (frag 120/290)')).toBeCloseTo(0.427)
    expect(parseYtdlpProgress('[info] Downloading format 1080p60')).toBeNull()
  })

  it('nome do arquivo segue o padrão das gravações (vira "Live de DD/MM")', () => {
    const args = ytdlpArgs('https://www.twitch.tv/videos/1', 'C:\\vods', 'C:\\ffmpeg')
    expect(args).toEqual(expect.arrayContaining(['--ffmpeg-location', 'C:\\ffmpeg', '-f', 'best']))
    const sample = VOD_TEMPLATE.replace('%(timestamp>%Y-%m-%d_%H-%M)s', '2026-10-07_21-03').replace('%(id)s', 'v1').replace('%(ext)s', 'mp4')
    expect(parseLiveDate(sample)).toEqual({ date: '2026-10-07', time: '21:03' })
  })
})
