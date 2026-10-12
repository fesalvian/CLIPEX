// Montagem dos comandos do ffmpeg/ffprobe. Funções puras: entram configurações,
// saem listas de argumentos. Nada de string solta concatenada no meio do código.

import { OUT_H, OUT_W } from '@shared/defaults'
import { coverCrop, layoutPanes, zoomCrop, type PixelRect } from '@shared/geometry'
import type { CamSplit, ClipLayout, CropLayout } from '@shared/types'

export type VideoEncoder = 'nvenc' | 'amf' | 'x264'

const BASE = ['-hide_banner', '-nostdin', '-y']
const PROGRESS = ['-progress', 'pipe:1', '-nostats']

function num(n: number, digits = 3): string {
  return Number(n.toFixed(digits)).toString()
}

export function probeArgs(src: string): string[] {
  return ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', src]
}

/** Teste rápido pra saber se o encoder de GPU funciona de verdade nesta máquina. */
export function encoderTestArgs(enc: VideoEncoder): string[] {
  return [
    ...BASE,
    '-f',
    'lavfi',
    '-i',
    'color=c=black:s=256x256:d=0.2',
    ...videoCodecArgs(enc, 'fast'),
    '-f',
    'null',
    '-'
  ]
}

/** Codec de vídeo. `fast` = proxy/preview leve; `final` = qualidade de postagem. */
export function videoCodecArgs(enc: VideoEncoder, profile: 'fast' | 'final'): string[] {
  if (profile === 'fast') {
    switch (enc) {
      case 'nvenc':
        return ['-c:v', 'h264_nvenc', '-preset', 'p1', '-rc', 'vbr', '-cq', '30', '-b:v', '0', '-pix_fmt', 'yuv420p']
      case 'amf':
        return ['-c:v', 'h264_amf', '-quality', 'speed', '-rc', 'cqp', '-qp_i', '30', '-qp_p', '30', '-pix_fmt', 'yuv420p']
      case 'x264':
        return ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '30', '-pix_fmt', 'yuv420p']
    }
  }
  // ~8 Mbps de média (teto 12): o que Reels/Shorts/TikTok recomendam pra 1080×1920;
  // mais que isso só deixa o upload lento, as redes recomprimem de qualquer jeito.
  switch (enc) {
    case 'nvenc':
      return [
        '-c:v', 'h264_nvenc', '-preset', 'p5', '-tune', 'hq', '-rc', 'vbr', '-cq', '23',
        '-b:v', '8M', '-maxrate', '12M', '-bufsize', '16M', '-profile:v', 'high', '-pix_fmt', 'yuv420p'
      ]
    case 'amf':
      return [
        '-c:v', 'h264_amf', '-quality', 'quality', '-rc', 'vbr_peak', '-b:v', '8M', '-maxrate', '12M',
        '-profile:v', 'high', '-pix_fmt', 'yuv420p'
      ]
    case 'x264':
      return [
        '-c:v', 'libx264', '-preset', 'medium', '-crf', '21', '-maxrate', '12M', '-bufsize', '16M',
        '-profile:v', 'high', '-pix_fmt', 'yuv420p'
      ]
  }
}

export interface AudioExtractConfig {
  src: string
  /** ordem da faixa de áudio (0:a:N) */
  track: number
  wavOut: string
}

/**
 * Uma passada só pelo arquivo: tira a faixa escolhida em WAV 16 kHz mono (Whisper e YAMNet)
 * e mede o loudness momentâneo (EBU R128, a cada 100 ms) no log.
 */
export function audioExtractArgs(c: AudioExtractConfig): string[] {
  return [
    ...BASE,
    '-loglevel', 'info',
    ...PROGRESS,
    '-i', c.src,
    '-filter_complex', `[0:a:${c.track}]ebur128=framelog=info[ebu]`,
    '-map', '[ebu]', '-f', 'null', '-',
    '-map', `0:a:${c.track}`, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', c.wavOut
  ]
}

export interface SegmentConfig {
  src: string
  start: number
  duration: number
  /** faixa de áudio pro preview (normalmente o mix) */
  audioTrack: number
  out: string
  encoder: VideoEncoder
}

/**
 * Filtro dos vídeos leves: corta pra 30 fps ANTES de reduzir (metade dos quadros pra escalar)
 * e usa o redimensionamento mais barato. Medido: 7,6 s contra 12,5 s num trecho de 94 s 1080p60.
 * Decodificação por software: com -hwaccel cuda/auto ficou mais lento (17–22 s).
 */
export const LIGHT_VF = 'fps=30,scale=-2:360:flags=fast_bilinear'

/** Trecho leve (360p) de um candidato, pra tocar na tela de clipar. */
export function previewSegmentArgs(c: SegmentConfig): string[] {
  return [
    ...BASE,
    ...PROGRESS,
    '-ss', num(Math.max(0, c.start)),
    '-t', num(c.duration),
    '-i', c.src,
    '-map', '0:v:0',
    '-map', `0:a:${c.audioTrack}?`,
    '-vf', LIGHT_VF,
    ...videoCodecArgs(c.encoder, 'fast'),
    '-g', '15',
    '-c:a', 'aac', '-b:a', '96k', '-ac', '2',
    '-movflags', '+faststart',
    c.out
  ]
}

export interface ProxyConfig {
  src: string
  audioTrack: number
  out: string
  encoder: VideoEncoder
}

/** Proxy 360p da live inteira, pra navegar. */
export function proxyArgs(c: ProxyConfig): string[] {
  return [
    ...BASE,
    ...PROGRESS,
    '-i', c.src,
    '-map', '0:v:0',
    '-map', `0:a:${c.audioTrack}?`,
    '-vf', LIGHT_VF,
    ...videoCodecArgs(c.encoder, 'fast'),
    '-g', '30',
    '-c:a', 'aac', '-b:a', '64k', '-ac', '2',
    '-movflags', '+faststart',
    c.out
  ]
}

/**
 * Cópia do vídeo final com bitrate menor pra caber num limite de tamanho (ex.: 50 MB do
 * storage gratuito). Áudio copiado como está.
 */
export function fitBitrateArgs(src: string, out: string, videoKbps: number, enc: VideoEncoder): string[] {
  const b = `${Math.round(videoKbps)}k`
  const max = `${Math.round(videoKbps * 1.25)}k`
  const buf = `${Math.round(videoKbps * 2)}k`
  const codec =
    enc === 'nvenc'
      ? ['-c:v', 'h264_nvenc', '-preset', 'p5', '-rc', 'vbr', '-b:v', b, '-maxrate', max, '-bufsize', buf]
      : enc === 'amf'
        ? ['-c:v', 'h264_amf', '-rc', 'vbr_peak', '-b:v', b, '-maxrate', max]
        : ['-c:v', 'libx264', '-preset', 'medium', '-b:v', b, '-maxrate', max, '-bufsize', buf]
  return [...BASE, '-i', src, '-map', '0:v:0', '-map', '0:a:0?', ...codec, '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-c:a', 'copy', '-movflags', '+faststart', out]
}

/** Bitrate de vídeo (kbps) pra um arquivo de `seconds` caber em `maxBytes` (com folga). */
export function bitrateToFit(maxBytes: number, seconds: number, audioKbps = 192): number {
  const totalKbps = (maxBytes * 8 * 0.92) / 1000 / Math.max(1, seconds)
  return Math.max(800, Math.floor(totalKbps - audioKbps))
}

export function frameArgs(src: string, at: number, out: string): string[] {
  return [...BASE, '-ss', num(Math.max(0, at)), '-i', src, '-frames:v', '1', '-vf', 'scale=1280:-2', '-q:v', '3', out]
}

export interface RenderAudio {
  /** faixas somadas (ordens 0:a:N) */
  tracks: number[]
  /** faixa de música mixada baixinho, ou null pra deixar de fora */
  musicTrack: number | null
  musicGainDb: number
}

export interface RenderWatermark {
  /** caminho do PNG (pode ser relativo ao cwd do ffmpeg) */
  file: string
  x: number
  y: number
  w: number
  opacity: number
}

export interface RenderConfig {
  src: string
  srcW: number
  srcH: number
  srcFps: number
  cutIn: number
  cutOut: number
  layout: ClipLayout
  camSplit: CamSplit
  crop: CropLayout
  /** punch-in: tempo relativo ao início do corte */
  zoom: { at: number; duration: number; factor: number } | null
  /** arquivo .ass relativo ao cwd do ffmpeg (evita escapar caminho do Windows no filtro) */
  subtitles: string | null
  fontsDir: string | null
  watermark: RenderWatermark | null
  audio: RenderAudio
  encoder: VideoEncoder
  out: string
}

function cropFilter(c: PixelRect): string {
  return `crop=${c.w}:${c.h}:${c.x}:${c.y}`
}

export function renderFilterGraph(c: RenderConfig): { graph: string; videoOut: string; audioOut: string } {
  const panes = layoutPanes(c.layout, c.camSplit, OUT_W, OUT_H)
  const zoomKind: 'cam' | 'game' | null = c.zoom ? (panes.some((p) => p.kind === 'cam') ? 'cam' : 'game') : null
  const parts: string[] = []
  const splits = panes.length + (zoomKind ? 1 : 0)
  const srcLabels = Array.from({ length: splits }, (_, i) => `v${i}`)
  parts.push(splits > 1 ? `[0:v]split=${splits}${srcLabels.map((l) => `[${l}]`).join('')}` : `[0:v]null[v0]`)

  const paneLabels: string[] = []
  let next = 0
  for (const pane of panes) {
    const rect = pane.kind === 'cam' ? c.crop.cam : c.crop.game
    const aspect = pane.out.w / pane.out.h
    const crop = coverCrop(rect, c.srcW, c.srcH, aspect)
    const scale = `scale=${pane.out.w}:${pane.out.h}:flags=lanczos,setsar=1`
    const base = `p_${pane.kind}`
    parts.push(`[${srcLabels[next++]}]${cropFilter(crop)},${scale}[${base}]`)
    if (c.zoom && zoomKind === pane.kind) {
      const z = zoomCrop(crop, c.zoom.factor)
      const t0 = num(Math.max(0, c.zoom.at))
      const t1 = num(Math.max(0, c.zoom.at + c.zoom.duration))
      parts.push(`[${srcLabels[next++]}]${cropFilter(z)},${scale}[${base}z]`)
      parts.push(`[${base}][${base}z]overlay=0:0:enable='between(t,${t0},${t1})'[${base}o]`)
      paneLabels.push(`${base}o`)
    } else {
      paneLabels.push(base)
    }
  }

  let cur: string
  if (paneLabels.length === 2) {
    parts.push(`[${paneLabels[0]}][${paneLabels[1]}]vstack=inputs=2[stk]`)
    cur = 'stk'
  } else {
    cur = paneLabels[0]!
  }

  if (c.srcFps > 60.5) {
    parts.push(`[${cur}]fps=60[fps]`)
    cur = 'fps'
  }

  if (c.watermark) {
    const w = c.watermark
    parts.push(`[1:v]format=rgba,scale=${Math.round(w.w)}:-1,colorchannelmixer=aa=${num(w.opacity, 2)}[wm]`)
    parts.push(`[${cur}][wm]overlay=${Math.round(w.x)}:${Math.round(w.y)}:format=auto[wmd]`)
    cur = 'wmd'
  }

  if (c.subtitles) {
    const fonts = c.fontsDir ? `:fontsdir=${c.fontsDir}` : ''
    parts.push(`[${cur}]ass=${c.subtitles}${fonts}[subd]`)
    cur = 'subd'
  }
  parts.push(`[${cur}]format=yuv420p[vout]`)

  // Áudio: soma das faixas sem a música (ou com ela bem baixa), limitador e loudness pra redes.
  const aIn = c.audio.tracks.map((t) => `[0:a:${t}]`)
  if (c.audio.musicTrack !== null) {
    parts.push(`[0:a:${c.audio.musicTrack}]volume=${num(c.audio.musicGainDb, 1)}dB[mus]`)
    aIn.push('[mus]')
  }
  const head = aIn.length > 1 ? `${aIn.join('')}amix=inputs=${aIn.length}:duration=first:normalize=0` : `${aIn[0]}anull`
  parts.push(`${head},alimiter=limit=0.95,loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000[aout]`)

  return { graph: parts.join(';'), videoOut: '[vout]', audioOut: '[aout]' }
}

export function renderArgs(c: RenderConfig): string[] {
  const dur = Math.max(0.1, c.cutOut - c.cutIn)
  const { graph, videoOut, audioOut } = renderFilterGraph(c)
  const args = [...BASE, ...PROGRESS, '-ss', num(c.cutIn), '-t', num(dur), '-i', c.src]
  if (c.watermark) args.push('-i', c.watermark.file)
  args.push(
    '-filter_complex', graph,
    '-map', videoOut,
    '-map', audioOut,
    ...videoCodecArgs(c.encoder, 'final'),
    '-c:a', 'aac', '-b:a', '192k', '-ac', '2',
    '-movflags', '+faststart',
    c.out
  )
  return args
}
