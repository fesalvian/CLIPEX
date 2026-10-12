import { describe, expect, it } from 'vitest'
import { DEFAULT_CROP } from '@shared/defaults'
import {
  audioExtractArgs,
  frameArgs,
  previewSegmentArgs,
  renderArgs,
  renderFilterGraph,
  type RenderConfig
} from '../src/main/ffmpeg/args'

const base: RenderConfig = {
  src: 'C:\\Lives\\live_2026-10-07_21-03.mkv',
  srcW: 1920,
  srcH: 1080,
  srcFps: 60,
  cutIn: 4353.2,
  cutOut: 4391.2,
  layout: 'both',
  camSplit: 40,
  crop: DEFAULT_CROP,
  zoom: null,
  subtitles: 'sub.ass',
  fontsDir: 'fonts',
  watermark: null,
  audio: { tracks: [1, 2, 3], musicTrack: 4, musicGainDb: -20 },
  encoder: 'nvenc',
  out: 'out.mp4'
}

describe('renderArgs', () => {
  it('corta com -ss/-t antes da entrada e usa NVENC', () => {
    const a = renderArgs(base)
    const i = a.indexOf('-i')
    expect(a.slice(a.indexOf('-ss'), i + 2)).toEqual(['-ss', '4353.2', '-t', '38', '-i', base.src])
    expect(a).toContain('h264_nvenc')
    expect(a[a.length - 1]).toBe('out.mp4')
  })

  it('empilha webcam (40%) e jogo em 1080×1920', () => {
    const { graph } = renderFilterGraph(base)
    expect(graph).toContain('[0:v]split=2[v0][v1]')
    expect(graph).toContain('scale=1080:768')
    expect(graph).toContain('scale=1080:1152')
    expect(graph).toContain('vstack=inputs=2')
  })

  it('o recorte de cada painel tem a proporção do painel (cover)', () => {
    const { graph } = renderFilterGraph(base)
    const crops = [...graph.matchAll(/crop=(\d+):(\d+):(\d+):(\d+)/g)].map((m) => m.slice(1).map(Number))
    expect(crops).toHaveLength(2)
    const [cam, game] = crops as [number[], number[]]
    expect(cam[0]! / cam[1]!).toBeCloseTo(1080 / 768, 1)
    expect(game[0]! / game[1]!).toBeCloseTo(1080 / 1152, 1)
    // dentro do frame
    for (const [w, h, x, y] of [cam, game]) {
      expect(x! + w!).toBeLessThanOrEqual(1920)
      expect(y! + h!).toBeLessThanOrEqual(1080)
    }
  })

  it('só jogo usa um painel de tela cheia sem split', () => {
    const { graph } = renderFilterGraph({ ...base, layout: 'game' })
    expect(graph).not.toContain('vstack')
    expect(graph).toContain('scale=1080:1920')
    expect(graph.startsWith('[0:v]null[v0]')).toBe(true)
  })

  it('zoom no pico sobrepõe um recorte menor da webcam só no intervalo', () => {
    const { graph } = renderFilterGraph({ ...base, zoom: { at: 17, duration: 1.6, factor: 1.35 } })
    expect(graph).toContain('split=3')
    expect(graph).toContain("enable='between(t,17,18.6)'")
  })

  it('soma mic, jogo e Discord, e a música entra baixinha', () => {
    const { graph } = renderFilterGraph(base)
    expect(graph).toContain('[0:a:4]volume=-20dB[mus]')
    expect(graph).toContain('[0:a:1][0:a:2][0:a:3][mus]amix=inputs=4:duration=first:normalize=0')
    expect(graph).toContain('loudnorm=I=-14')
  })

  it('sem música e com faixa única (VOD)', () => {
    const { graph } = renderFilterGraph({ ...base, audio: { tracks: [0], musicTrack: null, musicGainDb: 0 } })
    expect(graph).toContain('[0:a:0]anull,alimiter')
    expect(graph).not.toContain('amix')
  })

  it('marca d’água entra como segunda entrada com opacidade', () => {
    const cfg = { ...base, watermark: { file: 'wm.png', x: 634, y: 56, w: 396, opacity: 0.8 } }
    const a = renderArgs(cfg)
    expect(a.filter((x) => x === '-i')).toHaveLength(2)
    const { graph } = renderFilterGraph(cfg)
    expect(graph).toContain('[1:v]format=rgba,scale=396:-1,colorchannelmixer=aa=0.8[wm]')
    expect(graph).toContain('overlay=634:56')
  })

  it('legenda vem depois da marca d’água e usa caminho relativo', () => {
    const { graph } = renderFilterGraph({ ...base, watermark: { file: 'wm.png', x: 0, y: 0, w: 100, opacity: 1 } })
    expect(graph.indexOf('overlay=0:0:format')).toBeLessThan(graph.indexOf('ass=sub.ass:fontsdir=fonts'))
  })

  it('limita a 60 fps quando a fonte passa disso', () => {
    expect(renderFilterGraph({ ...base, srcFps: 120 }).graph).toContain('fps=60')
    expect(renderFilterGraph(base).graph).not.toContain('fps=60')
  })
})

describe('outros comandos', () => {
  it('extração do microfone mede o loudness na mesma passada', () => {
    const a = audioExtractArgs({ src: 'in.mkv', track: 1, wavOut: 'mic.wav' })
    expect(a).toContain('[0:a:1]ebur128=framelog=info[ebu]')
    expect(a.join(' ')).toContain('-map 0:a:1 -vn -ac 1 -ar 16000 -c:a pcm_s16le mic.wav')
  })

  it('preview do candidato é 360p com keyframe curto', () => {
    const a = previewSegmentArgs({ src: 'in.mkv', start: 100, duration: 90, audioTrack: 0, out: 'p.mp4', encoder: 'x264' })
    expect(a).toContain('fps=30,scale=-2:360:flags=fast_bilinear')
    expect(a).toContain('libx264')
    expect(a.slice(a.indexOf('-g'), a.indexOf('-g') + 2)).toEqual(['-g', '15'])
  })

  it('frame pro editor de recorte', () => {
    expect(frameArgs('in.mkv', 12.5, 'f.jpg')).toEqual(
      expect.arrayContaining(['-ss', '12.5', '-frames:v', '1', 'f.jpg'])
    )
  })
})
