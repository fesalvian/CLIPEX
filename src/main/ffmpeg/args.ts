// Montagem dos comandos do ffmpeg/ffprobe. Funções puras: entram configurações,
// saem listas de argumentos. Nada de string solta concatenada no meio do código.

import { OUT_H, OUT_W } from '@shared/defaults'
import { faceCropExpr } from '@shared/faces'
import { coverCrop, fitBox, layoutPanes, zoomCrop, type PixelRect } from '@shared/geometry'
import type { CamSplit, ClipLayout, CropLayout, Cut, FaceTrack } from '@shared/types'

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

/** Quadros pequenos (320×240, RGB cru no stdout) pra detecção de rosto. */
export function faceFramesArgs(src: string, start: number, duration: number, fps: number): string[] {
  return [
    ...BASE,
    '-loglevel', 'error',
    '-ss', num(Math.max(0, start)),
    '-t', num(duration),
    '-i', src,
    '-map', '0:v:0',
    '-vf', `fps=${fps},scale=320:240:flags=fast_bilinear`,
    '-pix_fmt', 'rgb24',
    '-f', 'rawvideo',
    'pipe:1'
  ]
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
  /**
   * trechos do corte, relativos a cutIn (o tempo do arquivo lido); com mais de um, o que fica
   * entre eles sai do vídeo (corte seco). Sem = o intervalo inteiro.
   */
  keep?: Cut[]
  layout: ClipLayout
  camSplit: CamSplit
  crop: CropLayout
  /** punch-in: tempo relativo ao início do corte */
  zoom: { at: number; duration: number; factor: number } | null
  /** layout 'face': planos da câmera seguindo quem fala (tempo da fonte) */
  faces?: FaceTrack | null
  /** arquivo .ass relativo ao cwd do ffmpeg (evita escapar caminho do Windows no filtro) */
  subtitles: string | null
  fontsDir: string | null
  watermark: RenderWatermark | null
  audio: RenderAudio
  encoder: VideoEncoder
  out: string
}

/**
 * select/aselect dos trechos (tempo do arquivo lido). O vídeo leva cada quadro pra posição
 * dele no vídeo final (trecho k começa na soma dos anteriores); o áudio é recontado amostra a
 * amostra, sem buraco.
 */
export function keepFilters(keep: Cut[]): { video: string; audio: string } {
  const inside = keep.map((k) => `between(t,${num(k.s)},${num(k.e)})`).join('+')
  let acc = 0
  let pts = '0'
  const terms = keep.map((k) => {
    const t = { k, acc }
    acc += k.e - k.s
    return t
  })
  for (let i = terms.length - 1; i >= 0; i--) {
    const { k, acc: a } = terms[i]!
    pts = `if(lte(T,${num(k.e)}),T-${num(k.s)}+${num(a)},${pts})`
  }
  return {
    video: `select='${inside}',setpts='(${pts})/TB'`,
    audio: `aselect='${inside}',asetpts=N/SR/TB`
  }
}

function cropFilter(c: PixelRect): string {
  return `crop=${c.w}:${c.h}:${c.x}:${c.y}`
}

/**
 * Vídeo inteiro (layout 'fit'): o quadro 16:9 no meio, largura toda, e em volta o mesmo vídeo
 * ampliado e desfocado (desfoque feito numa versão pequena: bem mais rápido).
 */
function fitGraph(parts: string[], src: string, c: RenderConfig): string {
  const box = fitBox(c.srcW, c.srcH)
  parts.push(`${src}split=${c.zoom ? 3 : 2}[fb][ff]${c.zoom ? '[fz]' : ''}`)
  parts.push(
    `[fb]scale=270:480:force_original_aspect_ratio=increase:flags=fast_bilinear,crop=270:480,boxblur=12:2,eq=brightness=-0.12,scale=${OUT_W}:${OUT_H}:flags=bilinear,setsar=1[bg]`
  )
  parts.push(`[ff]scale=${box.w}:${box.h}:flags=lanczos,setsar=1[fg]`)
  let fg = 'fg'
  if (c.zoom) {
    const z = zoomCrop({ x: 0, y: 0, w: c.srcW, h: c.srcH }, c.zoom.factor)
    const t0 = num(Math.max(0, c.zoom.at))
    const t1 = num(Math.max(0, c.zoom.at + c.zoom.duration))
    parts.push(`[fz]${cropFilter(z)},scale=${box.w}:${box.h}:flags=lanczos,setsar=1[fgz]`)
    parts.push(`[fg][fgz]overlay=0:0:enable='between(t,${t0},${t1})'[fgo]`)
    fg = 'fgo'
  }
  parts.push(`[bg][${fg}]overlay=${box.x}:${box.y}[stk]`)
  return 'stk'
}

/** Seguir quem fala (layout 'face'): recorte 9:16 da altura toda, com o x mudando a cada plano. */
function faceGraph(parts: string[], src: string, c: RenderConfig): string {
  const cropW = Math.min(c.srcW, Math.round((c.srcH * 9) / 16 / 2) * 2)
  const cuts = c.keep && c.keep.length ? c.keep.map((k) => ({ s: k.s + c.cutIn, e: k.e + c.cutIn })) : [{ s: c.cutIn, e: c.cutOut }]
  const x = faceCropExpr(c.faces ?? null, cuts, c.srcW, cropW)
  const scale = `scale=${OUT_W}:${OUT_H}:flags=lanczos,setsar=1`
  if (!c.zoom) {
    parts.push(`${src}crop=${cropW}:${c.srcH}:x='${x}':y=0,${scale}[stk]`)
    return 'stk'
  }
  const zw = Math.round(cropW / c.zoom.factor / 2) * 2
  const zh = Math.round(c.srcH / c.zoom.factor / 2) * 2
  const zx = faceCropExpr(c.faces ?? null, cuts, c.srcW, cropW, Math.round((cropW - zw) / 2))
  const t0 = num(Math.max(0, c.zoom.at))
  const t1 = num(Math.max(0, c.zoom.at + c.zoom.duration))
  parts.push(`${src}split=2[fa][fz]`)
  parts.push(`[fa]crop=${cropW}:${c.srcH}:x='${x}':y=0,${scale}[fan]`)
  parts.push(`[fz]crop=${zw}:${zh}:x='${zx}':y=${Math.round((c.srcH - zh) / 2)},${scale}[fzn]`)
  parts.push(`[fan][fzn]overlay=0:0:enable='between(t,${t0},${t1})'[stk]`)
  return 'stk'
}

export function renderFilterGraph(c: RenderConfig): { graph: string; videoOut: string; audioOut: string } {
  if (c.layout === 'fit' || c.layout === 'face') return wholeFrameGraph(c)
  const panes = layoutPanes(c.layout, c.camSplit, OUT_W, OUT_H)
  const zoomKind: 'cam' | 'game' | null = c.zoom ? (panes.some((p) => p.kind === 'cam') ? 'cam' : 'game') : null
  const parts: string[] = []
  const splits = panes.length + (zoomKind ? 1 : 0)
  const srcLabels = Array.from({ length: splits }, (_, i) => `v${i}`)
  // vários trechos: só os quadros e o áudio de dentro deles, com o tempo recontado sem os buracos
  const keep = c.keep && c.keep.length > 1 ? keepFilters(c.keep) : null
  let vSrc = '[0:v]'
  if (keep) {
    parts.push(`[0:v]${keep.video}[vk]`)
    vSrc = '[vk]'
  }
  parts.push(splits > 1 ? `${vSrc}split=${splits}${srcLabels.map((l) => `[${l}]`).join('')}` : `${vSrc}null[v0]`)

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

  return finishGraph(parts, cur, c, keep)
}

/** Layouts que usam o quadro todo da fonte (vídeo inteiro, seguir quem fala). */
function wholeFrameGraph(c: RenderConfig): { graph: string; videoOut: string; audioOut: string } {
  const parts: string[] = []
  const keep = c.keep && c.keep.length > 1 ? keepFilters(c.keep) : null
  let src = '[0:v]'
  if (keep) {
    parts.push(`[0:v]${keep.video}[vk]`)
    src = '[vk]'
  }
  const cur = c.layout === 'fit' ? fitGraph(parts, src, c) : faceGraph(parts, src, c)
  return finishGraph(parts, cur, c, keep)
}

/** Depois do vídeo montado: 60 fps no máximo, logo, legenda e o áudio. */
function finishGraph(
  parts: string[],
  start: string,
  c: RenderConfig,
  keep: { video: string; audio: string } | null
): { graph: string; videoOut: string; audioOut: string } {
  let cur = start
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
  const aKeep = keep ? `,${keep.audio}` : ''
  parts.push(`${head}${aKeep},alimiter=limit=0.95,loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000[aout]`)

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
