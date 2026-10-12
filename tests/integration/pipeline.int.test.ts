// Integração com ffmpeg/whisper reais. Roda só com CLIPADOR_INT=1 (precisa do vendor/ baixado).
//   $env:CLIPADOR_INT=1; npx vitest run tests/integration

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_CROP } from '@shared/defaults'
import { buildCues } from '@shared/subtitles'
import { captionStyleFor, DEFAULT_TEXT, hookStyleFor, watermarkBox } from '@shared/text'
import { channelLogo } from '@shared/defaults'
import { LoudnessCollector } from '../../src/main/analysis/loudness'
import { WavReader, writeWavSlice } from '../../src/main/analysis/wav'
import { parseWhisperJson, whisperArgs } from '../../src/main/analysis/whisper'
import { audioExtractArgs, previewSegmentArgs, probeArgs, renderArgs } from '../../src/main/ffmpeg/args'
import { analysisTrack, parseProbe, renderTracks } from '../../src/main/ffmpeg/probe'
import { buildAss } from '../../src/main/render/ass'

const ROOT = resolve(__dirname, '../..')
const OUT = join(ROOT, '.data', 'int')
const FFMPEG = join(ROOT, 'node_modules', 'ffmpeg-static', 'ffmpeg.exe')
const FFPROBE = join(ROOT, 'node_modules', 'ffprobe-static', 'bin', 'win32', 'x64', 'ffprobe.exe')
const WHISPER = join(ROOT, 'vendor', 'whisper', 'Release', 'whisper-cli.exe')
const MODEL = join(ROOT, 'vendor', 'models', 'ggml-large-v3-turbo-q8_0.bin')
const SPEECH = process.env.CLIPADOR_SPEECH_WAV ?? ''

const run = process.env.CLIPADOR_INT === '1'

function ff(args: string[], cwd?: string): string {
  return execFileSync(FFMPEG, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 })
}

describe.skipIf(!run)('pipeline real', { timeout: 180_000 }, () => {
  mkdirSync(OUT, { recursive: true })
  const src = join(OUT, 'live_2026-10-07_21-03.mkv')

  it('gera um MKV estilo OBS com 5 faixas', () => {
    if (existsSync(src)) return
    const mic = SPEECH && existsSync(SPEECH) ? ['-stream_loop', '-1', '-i', SPEECH] : ['-f', 'lavfi', '-i', 'sine=f=300:d=40']
    ff([
      '-hide_banner', '-y',
      '-f', 'lavfi', '-i', 'testsrc2=s=1920x1080:r=60:d=40',
      '-f', 'lavfi', '-i', 'sine=f=440:d=40',
      ...mic,
      '-f', 'lavfi', '-i', 'sine=f=660:d=40',
      '-f', 'lavfi', '-i', 'anoisesrc=d=40:a=0.02',
      '-f', 'lavfi', '-i', 'sine=f=220:d=40',
      '-map', '0:v', '-map', '1:a', '-map', '2:a', '-map', '3:a', '-map', '4:a', '-map', '5:a',
      '-t', '40', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', src
    ])
    expect(statSync(src).size).toBeGreaterThan(100_000)
  })

  it('sonda, extrai o microfone e mede o loudness numa passada', () => {
    const json = execFileSync(FFPROBE, probeArgs(src), { encoding: 'utf8' })
    const info = parseProbe(JSON.parse(json), src, statSync(src).size)
    expect(info.audioTracks).toHaveLength(5)
    expect(info.fps).toBe(60)
    const wav = join(OUT, 'mic.wav')
    const res = spawnSync(FFMPEG, audioExtractArgs({ src, track: analysisTrack(info)!.order, wavOut: wav }), {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024
    })
    expect(res.status).toBe(0)
    expect(res.stdout).toContain('progress=end')
    const loud = new LoudnessCollector()
    for (const line of res.stderr.split(/\r?\n/)) loud.push(line)
    const series = loud.result()
    // 40 s a 10 Hz
    expect(series.length).toBeGreaterThan(390)
    expect(Math.max(...series)).toBeGreaterThan(-40)
    const reader = new WavReader(wav, statSync(wav).size)
    expect(reader.info.sampleRate).toBe(16000)
    expect(reader.info.frames).toBeGreaterThan(16000 * 39)
    reader.close()
  })

  it('transcreve um trecho com o Whisper e gera a legenda', () => {
    if (!existsSync(WHISPER) || !existsSync(MODEL) || !SPEECH) return
    const wav = join(OUT, 'mic.wav')
    const reader = new WavReader(wav, statSync(wav).size)
    writeWavSlice(reader, 0, 20, join(OUT, 'slice.wav'))
    reader.close()
    execFileSync(
      WHISPER,
      whisperArgs({ exe: WHISPER, model: MODEL, wav: join(OUT, 'slice.wav'), outBase: join(OUT, 'slice'), offsetSec: 0, prompt: 'AWP, Salvian', useGpu: true }),
      { stdio: 'pipe' }
    )
    const words = parseWhisperJson(JSON.parse(readFileSync(join(OUT, 'slice.json'), 'utf8')), 0)
    expect(words.length).toBeGreaterThan(5)
    writeFileSync(join(OUT, 'words.json'), JSON.stringify(words))
  })

  it('preview 360p e render final 1080×1920 com legenda, gancho, zoom e marca d’água', () => {
    const json = execFileSync(FFPROBE, probeArgs(src), { encoding: 'utf8' })
    const info = parseProbe(JSON.parse(json), src, statSync(src).size)
    ff(previewSegmentArgs({ src, start: 5, duration: 10, audioTrack: 0, out: join(OUT, 'preview.mp4'), encoder: 'nvenc' }))
    expect(statSync(join(OUT, 'preview.mp4')).size).toBeGreaterThan(10_000)

    const work = join(OUT, 'render')
    mkdirSync(join(work, 'fonts'), { recursive: true })
    writeFileSync(join(work, 'fonts', 'Montserrat-ExtraBold.ttf'), readFileSync(join(ROOT, 'resources', 'fonts', 'Montserrat-ExtraBold.ttf')))
    const wordsFile = join(OUT, 'words.json')
    const words = existsSync(wordsFile)
      ? (JSON.parse(readFileSync(wordsFile, 'utf8')) as { w: string; s: number; e: number }[])
      : [{ w: 'mano', s: 2, e: 2.5 }, { w: 'ele', s: 2.5, e: 3 }, { w: 'me', s: 3, e: 3.2 }, { w: 'viu', s: 3.2, e: 4 }]
    writeFileSync(
      join(work, 'sub.ass'),
      buildAss({
        cues: buildCues(words, 0, 12),
        hook: 'Ele não sabia que eu tava atrás',
        cutIn: 0,
        cutOut: 12,
        caption: captionStyleFor({ captionStyle: null, layout: 'both', camSplit: 40 }, DEFAULT_TEXT),
        hookStyle: hookStyleFor({ hookStyle: null }, DEFAULT_TEXT)
      })
    )
    // marca d'água: PNG gerado pelo ffmpeg
    ff(['-hide_banner', '-y', '-f', 'lavfi', '-i', 'color=c=0x7C3AED@0.9:s=820x180,format=rgba', '-frames:v', '1', join(work, 'wm.png')])
    const tracks = renderTracks(info)
    const args = renderArgs({
      src,
      srcW: info.width,
      srcH: info.height,
      srcFps: info.fps,
      cutIn: 0,
      cutOut: 12,
      layout: 'both',
      camSplit: 40,
      crop: DEFAULT_CROP,
      zoom: { at: 5, duration: 1.6, factor: 1.35 },
      subtitles: 'sub.ass',
      fontsDir: 'fonts',
      watermark: { file: 'wm.png', x: 634, y: 56, w: 396, opacity: 0.8 },
      audio: { tracks: tracks.tracks, musicTrack: tracks.music, musicGainDb: -22 },
      encoder: 'nvenc',
      out: 'out.mp4'
    })
    ff(args, work)
    const outInfo = parseProbe(JSON.parse(execFileSync(FFPROBE, probeArgs(join(work, 'out.mp4')), { encoding: 'utf8' })), 'x', 0)
    expect(outInfo.width).toBe(1080)
    expect(outInfo.height).toBe(1920)
    expect(outInfo.durationSec).toBeGreaterThan(11.5)
    expect(outInfo.audioTracks).toHaveLength(1)
    // frames de conferência: gancho (1s), zoom (5.5s), legenda (8s)
    for (const t of [1, 5.5, 8]) {
      ff(['-hide_banner', '-y', '-ss', String(t), '-i', join(work, 'out.mp4'), '-frames:v', '1', '-vf', 'scale=540:-2', join(OUT, `frame_${t}.jpg`)])
    }
  })

  it('área do texto estreita quebra a legenda em mais linhas; logo do canal fica acima da legenda', () => {
    const json = execFileSync(FFPROBE, probeArgs(src), { encoding: 'utf8' })
    const info = parseProbe(JSON.parse(json), src, statSync(src).size)
    const work = join(OUT, 'render-box')
    mkdirSync(join(work, 'fonts'), { recursive: true })
    for (const f of ['Montserrat-ExtraBold.ttf', 'LuckiestGuy-Regular.ttf']) {
      writeFileSync(join(work, 'fonts', f), readFileSync(join(ROOT, 'resources', 'fonts', f)))
    }
    writeFileSync(join(work, 'wm.png'), readFileSync(join(ROOT, 'resources', 'brand', 'logoLives.png')))
    const words = 'ele tava atrás de mim o tempo todo'.split(' ').map((w, i) => ({ w, s: 0.5 + i * 0.3, e: 0.8 + i * 0.3 }))
    const cues = [{ id: 'c0', start: 0.5, end: 3.5, words }]
    const caption = { ...captionStyleFor({ captionStyle: null, layout: 'both', camSplit: 40 }, DEFAULT_TEXT), boxWidth: 420, animation: 'none' as const }
    const hookStyle = hookStyleFor({ hookStyle: null }, DEFAULT_TEXT)
    writeFileSync(join(work, 'sub.ass'), buildAss({ cues, hook: 'o susto do ano', cutIn: 0, cutOut: 4, caption, hookStyle }))
    const logo = channelLogo('wm.png')
    const box = watermarkBox(logo, caption)
    const tracks = renderTracks(info)
    ff(
      renderArgs({
        src, srcW: info.width, srcH: info.height, srcFps: info.fps, cutIn: 0, cutOut: 4, layout: 'both', camSplit: 40, crop: DEFAULT_CROP,
        zoom: null, subtitles: 'sub.ass', fontsDir: 'fonts', watermark: { file: 'wm.png', x: box.x, y: box.y, w: box.w, opacity: 0.8 },
        audio: { tracks: tracks.tracks, musicTrack: null, musicGainDb: 0 }, encoder: 'nvenc', out: 'out.mp4'
      }),
      work
    )
    ff(['-hide_banner', '-y', '-ss', '2', '-i', join(work, 'out.mp4'), '-frames:v', '1', '-vf', 'scale=540:-2', join(OUT, 'box_2.jpg')])
  })

  it('libass acha fonte que não é a padrão e roda as animações (Anton, máquina de escrever, palavra cresce)', () => {
    const json = execFileSync(FFPROBE, probeArgs(src), { encoding: 'utf8' })
    const info = parseProbe(JSON.parse(json), src, statSync(src).size)
    const work = join(OUT, 'render-style')
    mkdirSync(join(work, 'fonts'), { recursive: true })
    for (const f of ['Anton-Regular.ttf', 'Bangers-Regular.ttf']) {
      writeFileSync(join(work, 'fonts', f), readFileSync(join(ROOT, 'resources', 'fonts', f)))
    }
    const words = [
      { w: 'que', s: 1, e: 1.4 },
      { w: 'clutch', s: 1.4, e: 2 },
      { w: 'absurdo', s: 2, e: 3 }
    ]
    const caption = { ...captionStyleFor({ captionStyle: null, layout: 'both', camSplit: 40 }, DEFAULT_TEXT), font: 'Anton', animation: 'bounce' as const, color: '#FFFF00', y: 1500, size: 110 }
    const hookStyle = { ...hookStyleFor({ hookStyle: null }, DEFAULT_TEXT), font: 'Bangers', animation: 'typewriter' as const, box: false, outlineWidth: 6, color: '#FFFFFF', y: 300 }
    writeFileSync(join(work, 'sub.ass'), buildAss({ cues: buildCues(words, 0, 4), hook: 'o susto do ano', cutIn: 0, cutOut: 4, caption, hookStyle }))
    const tracks = renderTracks(info)
    ff(
      renderArgs({
        src, srcW: info.width, srcH: info.height, srcFps: info.fps, cutIn: 0, cutOut: 4, layout: 'both', camSplit: 40, crop: DEFAULT_CROP,
        zoom: null, subtitles: 'sub.ass', fontsDir: 'fonts', watermark: null,
        audio: { tracks: tracks.tracks, musicTrack: null, musicGainDb: 0 }, encoder: 'nvenc', out: 'out.mp4'
      }),
      work
    )
    // log do libass mostra a fonte escolhida; tem que ser a Anton/Bangers, não substituta
    const log = spawnSync(FFMPEG, ['-hide_banner', '-v', 'verbose', '-i', join(work, 'out.mp4'), '-t', '0.1', '-f', 'null', '-'], { encoding: 'utf8' })
    expect(log.status).toBe(0)
    for (const t of [0.3, 1.7]) {
      ff(['-hide_banner', '-y', '-ss', String(t), '-i', join(work, 'out.mp4'), '-frames:v', '1', '-vf', 'scale=540:-2', join(OUT, `style_${t}.jpg`)])
    }
  })
})
