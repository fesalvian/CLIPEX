import type { AudioTrack, SourceInfo, TrackRole } from '@shared/types'

interface ProbeStream {
  index: number
  codec_type?: string
  codec_name?: string
  width?: number
  height?: number
  r_frame_rate?: string
  avg_frame_rate?: string
  channels?: number
  duration?: string
  tags?: Record<string, string>
}

interface ProbeJson {
  streams?: ProbeStream[]
  format?: { duration?: string; size?: string; tags?: Record<string, string> }
}

function parseRate(r: string | undefined): number {
  if (!r) return 0
  const [a, b] = r.split('/').map(Number)
  if (!a || !b) return 0
  return a / b
}

function tag(tags: Record<string, string> | undefined, key: string): string | null {
  if (!tags) return null
  for (const [k, v] of Object.entries(tags)) if (k.toLowerCase() === key) return v
  return null
}

/** Ordem das faixas no OBS: 1 mix, 2 microfone, 3 jogo, 4 Discord, 5 música. */
const ORDER_ROLES: TrackRole[] = ['mix', 'mic', 'game', 'discord', 'music']

export function roleFromTitle(title: string | null): TrackRole | null {
  if (!title) return null
  const t = title.toLowerCase()
  if (/\b(mic|microfone|voz|voice)\b/.test(t)) return 'mic'
  if (/discord/.test(t)) return 'discord'
  if (/(m[uú]sica|music|spotify)/.test(t)) return 'music'
  if (/(jogo|game|gameplay)/.test(t)) return 'game'
  if (/(mix|live|stream|master|geral)/.test(t)) return 'mix'
  return null
}

export function assignRoles(tracks: Omit<AudioTrack, 'role'>[]): AudioTrack[] {
  if (tracks.length === 1) return tracks.map((t) => ({ ...t, role: 'mix' }))
  const byTitle = tracks.map((t) => roleFromTitle(t.title))
  const titled = byTitle.filter((r) => r !== null).length
  return tracks.map((t, i) => {
    // Se a maioria das faixas tem nome reconhecível, confia no nome; senão usa a ordem do OBS.
    const role = titled >= Math.ceil(tracks.length / 2) ? (byTitle[i] ?? 'unknown') : (ORDER_ROLES[i] ?? 'unknown')
    return { ...t, role }
  })
}

export function parseProbe(json: unknown, path: string, sizeBytes: number): SourceInfo {
  const p = json as ProbeJson
  const streams = p.streams ?? []
  const video = streams.find((s) => s.codec_type === 'video' && s.width && s.height)
  if (!video) throw new Error('O arquivo não tem faixa de vídeo.')
  const audio = streams.filter((s) => s.codec_type === 'audio')
  const tracks = assignRoles(
    audio.map((s, i) => ({
      order: i,
      streamIndex: s.index,
      title: tag(s.tags, 'title') ?? tag(s.tags, 'handler_name'),
      channels: s.channels ?? 2,
      codec: s.codec_name ?? '?'
    }))
  )
  let duration = Number(p.format?.duration ?? video.duration ?? 0)
  if (!Number.isFinite(duration) || duration <= 0) {
    // MKV do OBS às vezes só tem DURATION nas tags do stream.
    const d = tag(video.tags, 'duration')
    if (d) {
      const m = /^(\d+):(\d+):([\d.]+)/.exec(d)
      if (m) duration = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])
    }
  }
  const fps = parseRate(video.avg_frame_rate) || parseRate(video.r_frame_rate) || 30
  return {
    path,
    sizeBytes,
    durationSec: duration,
    width: video.width!,
    height: video.height!,
    fps: Math.round(fps * 100) / 100,
    videoCodec: video.codec_name ?? '?',
    audioTracks: tracks
  }
}

/** Faixa usada na análise: microfone quando existe, senão a primeira. */
export function analysisTrack(info: SourceInfo): AudioTrack | null {
  return info.audioTracks.find((t) => t.role === 'mic') ?? info.audioTracks[0] ?? null
}

/** Faixa do preview: o mix da live. */
export function previewTrack(info: SourceInfo): AudioTrack | null {
  return info.audioTracks.find((t) => t.role === 'mix') ?? info.audioTracks[0] ?? null
}

/** Faixas do áudio final: tudo menos o mix e a música (que entra à parte, se for o caso). */
export function renderTracks(info: SourceInfo): { tracks: number[]; music: number | null } {
  const t = info.audioTracks
  const music = t.find((x) => x.role === 'music')?.order ?? null
  const parts = t.filter((x) => x.role === 'mic' || x.role === 'game' || x.role === 'discord').map((x) => x.order)
  if (parts.length > 0) return { tracks: parts, music }
  // Só tem uma faixa misturada (VOD da Twitch, importação manual): usa ela.
  const first = t[0]
  return { tracks: first ? [first.order] : [], music: null }
}
