import { describe, expect, it } from 'vitest'
import { DEFAULT_CROP } from '@shared/defaults'
import { clipDuration, cutIndexAt, newSegmentAt, normalizeCuts, toOut, toSrc, wordsOnOutput, zoomPoint } from '@shared/cuts'
import { buildCuesInCuts, mergeCuesInCuts } from '@shared/subtitles'
import { buildAss } from '../src/main/render/ass'
import { keepFilters, renderFilterGraph, type RenderConfig } from '../src/main/ffmpeg/args'
import { DEFAULT_TEXT } from '@shared/text'
import type { Cut, Word } from '@shared/types'

const cuts: Cut[] = [
  { s: 100, e: 110 },
  { s: 130, e: 135 },
  { s: 200, e: 220 }
]

describe('tempo dos trechos', () => {
  it('soma a duração e acha o trecho', () => {
    expect(clipDuration({ cutIn: 100, cutOut: 220, segments: cuts })).toBe(35)
    expect(clipDuration({ cutIn: 10, cutOut: 40 })).toBe(30)
    expect(cutIndexAt(cuts, 132)).toBe(1)
    expect(cutIndexAt(cuts, 120)).toBe(-1)
  })

  it('converte tempo da live ↔ tempo no vídeo final', () => {
    expect(toOut(cuts, 105)).toBe(5)
    expect(toOut(cuts, 131)).toBe(11)
    // no buraco vale o começo do próximo trecho
    expect(toOut(cuts, 120)).toBe(10)
    expect(toOut(cuts, 210)).toBe(25)
    expect(toOut(cuts, 999)).toBe(35)
    expect(toSrc(cuts, 11)).toBe(131)
    expect(toSrc(cuts, 25)).toBe(210)
    expect(toSrc(cuts, 99)).toBe(220)
  })
})

describe('normalizeCuts', () => {
  it('ordena e junta trechos que se encostam ou sobrepõem', () => {
    expect(normalizeCuts([{ s: 50, e: 60 }, { s: 10, e: 20 }, { s: 58, e: 70 }], 1000)).toEqual([
      { s: 10, e: 20 },
      { s: 50, e: 70 }
    ])
  })

  it('trecho curto ganha o mínimo; corte de um trecho só usa o mínimo de corte', () => {
    expect(normalizeCuts([{ s: 10, e: 10.2 }, { s: 30, e: 40 }], 1000)[0]).toEqual({ s: 10, e: 11 })
    expect(normalizeCuts([{ s: 10, e: 11 }], 1000)).toEqual([{ s: 10, e: 15 }])
  })

  it('fica dentro da live e apara a soma no máximo de um corte', () => {
    expect(normalizeCuts([{ s: 990, e: 1200 }], 1000)).toEqual([{ s: 990, e: 1000 }])
    const long = normalizeCuts([{ s: 0, e: 150 }, { s: 200, e: 300 }], 1000)
    expect(long.reduce((n, k) => n + k.e - k.s, 0)).toBe(180)
    expect(long[0]).toEqual({ s: 0, e: 150 })
  })
})

describe('newSegmentAt', () => {
  it('cria no cursor quando ele está fora dos trechos, sem invadir o próximo', () => {
    expect(newSegmentAt(cuts, 120, 1000)).toEqual({ s: 120, e: 125 })
    expect(newSegmentAt(cuts, 127, 1000)).toEqual({ s: 127, e: 129.9 })
  })

  it('cursor dentro de um trecho: cria depois do último', () => {
    expect(newSegmentAt(cuts, 105, 1000)).toEqual({ s: 221, e: 226 })
    expect(newSegmentAt(cuts, null, 223)).toEqual({ s: 221, e: 223 })
    expect(newSegmentAt(cuts, null, 221.5)).toBeNull()
  })
})

const words: Word[] = [
  { w: 'mano', s: 101, e: 101.4 },
  { w: 'olha', s: 101.5, e: 102 },
  { w: 'fora', s: 120, e: 121 },
  { w: 'ali', s: 130.2, e: 130.8 }
]

describe('legenda com vários trechos', () => {
  it('só as palavras dos trechos, e nenhum trecho de legenda atravessa o corte seco', () => {
    const cues = buildCuesInCuts(words, cuts.slice(0, 2))
    expect(cues.map((c) => c.words.map((w) => w.w).join(' '))).toEqual(['mano olha', 'ali'])
    expect(cues.map((c) => c.id)).toEqual(['c0', 'c1'])
  })

  it('mantém o texto editado ao mudar os trechos', () => {
    const cues = buildCuesInCuts(words, [{ s: 100, e: 110 }])
    cues[0]!.words[0]!.w = 'MANO'
    const merged = mergeCuesInCuts(cues, words, cuts.slice(0, 2), [])
    expect(merged.map((c) => c.words.map((w) => w.w).join(' '))).toEqual(['MANO olha', 'ali'])
  })

  it('a IA lê as falas coladas no tempo do vídeo final', () => {
    expect(wordsOnOutput(words, cuts.slice(0, 2))).toEqual([
      { w: 'mano', s: 1, e: 1.4 },
      { w: 'olha', s: 1.5, e: 2 },
      { w: 'ali', s: 10.2, e: 10.8 }
    ])
  })

  it('o .ass põe cada palavra no tempo do vídeo final', () => {
    const cue = buildCuesInCuts(words, cuts.slice(0, 2))
    const ass = buildAss({
      cues: cue,
      hook: null,
      cutIn: 100,
      cutOut: 135,
      cuts: cuts.slice(0, 2),
      caption: { ...DEFAULT_TEXT.caption, y: 1200 },
      hookStyle: { ...DEFAULT_TEXT.hook, y: 300 }
    })
    const lines = ass.split('\n').filter((l) => l.startsWith('Dialogue'))
    // "ali" falado em 130,2 s na live = 10,2 s no vídeo (10 s do primeiro trecho + 0,2 s)
    expect(lines.some((l) => l.includes('0:00:10.20') && /ali/i.test(l))).toBe(true)
    expect(lines.every((l) => !l.includes('0:00:30'))).toBe(true)
  })
})

describe('zoomPoint', () => {
  const clip = { zoomEnabled: true, zoomAt: null, peakSec: 120, cutIn: 100, cutOut: 220, segments: cuts }
  it('pico fora dos trechos: zoom no meio do vídeo final', () => {
    expect(zoomPoint(clip)).toBe(toSrc(cuts, 17.5))
    expect(zoomPoint({ ...clip, peakSec: 132 })).toBe(132)
    expect(zoomPoint({ ...clip, zoomEnabled: false })).toBeNull()
  })
})

describe('render com vários trechos', () => {
  const base: RenderConfig = {
    src: 'live.mkv',
    srcW: 1920,
    srcH: 1080,
    srcFps: 60,
    cutIn: 100,
    cutOut: 135,
    layout: 'both',
    camSplit: 40,
    crop: DEFAULT_CROP,
    zoom: null,
    subtitles: null,
    fontsDir: null,
    watermark: null,
    audio: { tracks: [1], musicTrack: null, musicGainDb: -20 },
    encoder: 'x264',
    out: 'out.mp4'
  }

  it('um trecho só: grafo igual ao de antes', () => {
    expect(renderFilterGraph({ ...base, keep: [{ s: 0, e: 35 }] }).graph).toBe(renderFilterGraph(base).graph)
  })

  it('seleciona os trechos e recoloca o tempo de cada um', () => {
    const keep = [
      { s: 0, e: 10 },
      { s: 30, e: 35 }
    ]
    const f = keepFilters(keep)
    expect(f.video).toBe("select='between(t,0,10)+between(t,30,35)',setpts='(if(lte(T,10),T-0+0,if(lte(T,35),T-30+10,0)))/TB'")
    expect(f.audio).toBe("aselect='between(t,0,10)+between(t,30,35)',asetpts=N/SR/TB")
    const { graph } = renderFilterGraph({ ...base, keep })
    expect(graph.startsWith(`[0:v]${f.video}[vk];[vk]split=2`)).toBe(true)
    expect(graph).toContain(`anull,${f.audio},alimiter`)
  })
})
