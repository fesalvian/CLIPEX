import { describe, expect, it } from 'vitest'
import { buildTimeline, pickCandidates } from '../src/main/analysis/candidates'
import { splitEvents } from '../src/main/analysis/events'
import { LoudnessCollector, loudnessBuckets, parseEbur128Line } from '../src/main/analysis/loudness'
import { parseWavHeader, wavHeader } from '../src/main/analysis/wav'
import { dtwPreset, parseWhisperJson, stripHallucinations, whisperArgs } from '../src/main/analysis/whisper'
import { analysisTrack, assignRoles, parseProbe, renderTracks } from '../src/main/ffmpeg/probe'

describe('ebur128', () => {
  it('lê o loudness momentâneo da linha do log', () => {
    const line = '[Parsed_ebur128_0 @ 0000017f098afa80] t: 0.399977   TARGET:-23 LUFS    M: -21.8 S:-120.7     I: -21.8 LUFS       LRA:   0.0 LU'
    expect(parseEbur128Line(line)).toEqual({ t: 0.399977, m: -21.8 })
    expect(parseEbur128Line('t: 0.1 TARGET:-23 LUFS M:-120.7 S:-120.7')!.m).toBe(-70)
    expect(parseEbur128Line('out_time=00:00:01')).toBeNull()
  })

  it('monta série de 10 Hz e converte em baldes 0..1', () => {
    const c = new LoudnessCollector()
    c.push('t: 0.1 TARGET:-23 LUFS M:-60.0 S:-1')
    c.push('t: 0.2 TARGET:-23 LUFS M:-30.0 S:-1')
    c.push('t: 0.4 TARGET:-23 LUFS M:-10.0 S:-1')
    const s = c.result()
    expect(Array.from(s)).toEqual([-60, -30, -30, -10])
    expect(loudnessBuckets(s, 0, 0.4, 2)).toEqual([0.6, 1])
  })
})

describe('WAV', () => {
  it('acha o chunk data mesmo com LIST no meio', () => {
    const h = wavHeader(32000, 16000)
    const list = Buffer.concat([Buffer.from('LIST'), Buffer.from([4, 0, 0, 0]), Buffer.from('INFO')])
    const buf = Buffer.concat([h.subarray(0, 36), list, h.subarray(36)])
    const info = parseWavHeader(buf)
    expect(info.dataOffset).toBe(56)
    expect(info.frames).toBe(16000)
    expect(info.sampleRate).toBe(16000)
  })

  it('corrige tamanho 0xFFFFFFFF pelo tamanho do arquivo', () => {
    const h = wavHeader(0, 16000)
    h.writeUInt32LE(0xffffffff, 40)
    expect(parseWavHeader(h, 44 + 3200).frames).toBe(1600)
  })
})

describe('ffprobe', () => {
  const probe = {
    format: { duration: '18720.5' },
    streams: [
      { index: 0, codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080, avg_frame_rate: '60/1' },
      ...[0, 1, 2, 3, 4].map((i) => ({ index: i + 1, codec_type: 'audio', codec_name: 'aac', channels: 2 }))
    ]
  }

  it('MKV do OBS com 5 faixas segue a ordem mix/mic/jogo/discord/música', () => {
    const info = parseProbe(probe, 'live.mkv', 100)
    expect(info.audioTracks.map((t) => t.role)).toEqual(['mix', 'mic', 'game', 'discord', 'music'])
    expect(info.fps).toBe(60)
    expect(analysisTrack(info)!.order).toBe(1)
    expect(renderTracks(info)).toEqual({ tracks: [1, 2, 3], music: 4 })
  })

  it('faixa única (VOD) vira mix e é usada em tudo', () => {
    const info = parseProbe({ ...probe, streams: probe.streams.slice(0, 2) }, 'vod.mp4', 1)
    expect(info.audioTracks[0]!.role).toBe('mix')
    expect(analysisTrack(info)!.order).toBe(0)
    expect(renderTracks(info)).toEqual({ tracks: [0], music: null })
  })

  it('usa o nome da faixa quando existe', () => {
    const roles = assignRoles([
      { order: 0, streamIndex: 1, title: 'Microfone', channels: 1, codec: 'aac' },
      { order: 1, streamIndex: 2, title: 'Jogo', channels: 2, codec: 'aac' },
      { order: 2, streamIndex: 3, title: 'Spotify', channels: 2, codec: 'aac' }
    ]).map((t) => t.role)
    expect(roles).toEqual(['mic', 'game', 'music'])
  })

  it('sem vídeo dá erro', () => {
    expect(() => parseProbe({ streams: [] }, 'x', 0)).toThrow()
  })
})

describe('candidatos', () => {
  function synthetic(seconds: number, spikes: { at: number; lufs: number; laugh?: number; scream?: number }[]) {
    const loud = new Float32Array(seconds * 10).fill(-30)
    for (let i = 0; i < loud.length; i++) loud[i] = -30 + Math.sin(i / 7) * 2
    const frames = Math.floor(seconds / 0.48)
    const inter = new Float32Array(frames * 3)
    for (let f = 0; f < frames; f++) inter[f * 3 + 2] = 0.8
    for (const s of spikes) {
      for (let k = s.at * 10; k < (s.at + 3) * 10; k++) loud[k] = s.lufs
      const f0 = Math.floor(s.at / 0.48)
      for (let f = f0; f < f0 + 6; f++) {
        inter[f * 3] = s.laugh ?? 0
        inter[f * 3 + 1] = s.scream ?? 0
      }
    }
    return { loud, events: splitEvents(inter) }
  }

  it('acha os picos, ordena por força e etiqueta risada e grito', () => {
    const { loud, events } = synthetic(1800, [
      { at: 300, lufs: -12, scream: 0.9 },
      { at: 900, lufs: -20, laugh: 0.8 },
      { at: 1500, lufs: -18 }
    ])
    const tl = buildTimeline(loud, events, 1800)
    const c = pickCandidates(tl, { durationSec: 1800, windowSec: 45, maxCandidates: 30, minScore: 0.2 })
    expect(c.length).toBeGreaterThanOrEqual(3)
    const top = c.slice(0, 3)
    expect(top.map((x) => Math.abs(x.peak - 300) < 6 || Math.abs(x.peak - 900) < 6 || Math.abs(x.peak - 1500) < 6)).toEqual([true, true, true])
    const scream = c.find((x) => Math.abs(x.peak - 300) < 6)!
    expect(scream.tags).toContain('scream')
    const laugh = c.find((x) => Math.abs(x.peak - 900) < 6)!
    expect(laugh.tags).toContain('laugh')
    for (const x of c) {
      expect(x.winStart).toBeLessThanOrEqual(x.cutIn)
      expect(x.cutOut).toBeLessThanOrEqual(x.winEnd)
      expect(x.cutOut - x.cutIn).toBeGreaterThanOrEqual(8)
    }
  })

  it('janelas não se sobrepõem quando os picos estão perto', () => {
    const { loud, events } = synthetic(600, [
      { at: 200, lufs: -12, scream: 0.9 },
      { at: 245, lufs: -12, laugh: 0.9 }
    ])
    const c = pickCandidates(buildTimeline(loud, events, 600), { durationSec: 600, windowSec: 45, maxCandidates: 10, minScore: 0.2 })
    const sorted = [...c].sort((a, b) => a.winStart - b.winStart)
    for (let i = 1; i < sorted.length; i++) expect(sorted[i]!.winStart).toBeGreaterThanOrEqual(sorted[i - 1]!.winEnd)
  })

  it('live parada não gera candidato', () => {
    const loud = new Float32Array(6000).fill(-30)
    const c = pickCandidates(buildTimeline(loud, null, 600), { durationSec: 600, windowSec: 45, maxCandidates: 10, minScore: 0.2 })
    expect(c).toHaveLength(0)
  })
})

describe('whisper', () => {
  it('transforma segmentos de uma palavra em palavras com tempo absoluto', () => {
    const json = {
      transcription: [
        { offsets: { from: 0, to: 120 }, text: '' },
        { offsets: { from: 120, to: 920 }, text: ' Mano,' },
        { offsets: { from: 8000, to: 8620 }, text: ' AWP' }
      ]
    }
    expect(parseWhisperJson(json, 100)).toEqual([
      { w: 'Mano,', s: 100.12, e: 100.92 },
      { w: 'AWP', s: 108, e: 108.62 }
    ])
  })

  it('remove alucinação clássica do Whisper em silêncio', () => {
    const words = ['ele', 'me', 'viu', 'Legendas', 'pela', 'comunidade', 'Amara.org'].map((w, i) => ({ w, s: i, e: i + 1 }))
    expect(stripHallucinations(words).map((w) => w.w)).toEqual(['ele', 'me', 'viu'])
  })

  it('usa DTW e desliga flash attention no turbo', () => {
    const a = whisperArgs({ exe: 'w', model: 'x/ggml-large-v3-turbo-q8_0.bin', wav: 'a.wav', outBase: 'o', offsetSec: 0, prompt: 'AWP', useGpu: true })
    expect(a).toEqual(expect.arrayContaining(['-l', 'pt', '-ml', '1', '-sow', '-dtw', 'large.v3.turbo', '-nfa', '--prompt', 'AWP']))
    expect(dtwPreset('ggml-medium.bin')).toBe('medium')
  })
})
