import { describe, expect, it, vi } from 'vitest'
import { buildShots, faceCropExpr, faceXAt, targets, trackCovers, type FaceBox, type FaceFrame } from '@shared/faces'
import { fitBox, layoutPanes } from '@shared/geometry'
import { overlapRatio, readWindow, snapToSpeech, transcriptChunks } from '@shared/moments'
import type { Word } from '@shared/types'

// sources.ts e autopilot.ts importam módulos do Electron indiretamente; aqui só as funções puras
vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => '', getPath: () => '' },
  BrowserWindow: { getAllWindows: () => [] },
  safeStorage: {},
  shell: {}
}))

const { channelListUrl, isVideoUrl, notReadyYet, parseListing, parseVideoInfo, downloadArgs } = await import('../src/main/sources')
const { renderArgs, renderFilterGraph } = await import('../src/main/ffmpeg/args')
const { hitsBlocklist, parseBlocklist, pickClips } = await import('../src/main/autopilot')

/** Frase por frase: cada palavra dura 0,4 s, com pausa de 1 s depois do ponto final. */
function speech(sentences: string[], start = 0): Word[] {
  const out: Word[] = []
  let t = start
  for (const s of sentences) {
    for (const w of s.split(' ')) {
      out.push({ w, s: t, e: t + 0.35 })
      t += 0.4
    }
    t += 1
  }
  return out
}

describe('conversas completas do podcast', () => {
  it('pedaços de 10 min e janelas com um pouco do anterior', () => {
    const chunks = transcriptChunks(25 * 60)
    expect(chunks).toEqual([
      { s: 0, e: 600 },
      { s: 600, e: 1200 },
      { s: 1200, e: 1500 }
    ])
    expect(readWindow(chunks, 0)).toEqual({ s: 0, e: 600 })
    expect(readWindow(chunks, 1)).toEqual({ s: 420, e: 1200 })
  })

  it('começa no início da frase e termina no fim dela', () => {
    const words = speech([
      'isso aqui é a introdução do programa.',
      'aí eu fui no mercado e encontrei o cara que me devia dinheiro faz três anos.',
      'ele olhou pra mim e saiu correndo pelo estacionamento.',
      'nunca mais vi.'
    ])
    // a IA mandou começar no meio da segunda frase e terminar no meio da terceira
    const second = words.findIndex((w) => w.w === 'mercado')
    const third = words.findIndex((w) => w.w === 'correndo')
    const span = snapToSpeech(words, words[second]!.s, words[third]!.e, { minSec: 3, maxSec: 60 })!
    const aiFoi = words.findIndex((w) => w.w === 'aí')
    const estacionamento = words.findIndex((w) => w.w === 'estacionamento.')
    // arredondado a 0,1 s
    expect(Math.abs(span.s - (words[aiFoi]!.s - 0.15))).toBeLessThan(0.06)
    expect(Math.abs(span.e - (words[estacionamento]!.e + 0.3))).toBeLessThan(0.06)
  })

  it('longo demais: fecha na última frase que cabe; curto demais: descarta', () => {
    const words = speech(['primeira frase bem curta.', 'segunda frase também é curta.', 'terceira frase que passa do limite de tempo pedido.'])
    const span = snapToSpeech(words, 0, words[words.length - 1]!.e, { minSec: 1, maxSec: 6 })!
    expect(span.e - span.s).toBeLessThanOrEqual(6.01)
    const lastIn = words.filter((w) => w.e <= span.e)
    expect(lastIn[lastIn.length - 1]!.w.endsWith('.')).toBe(true)
    expect(snapToSpeech(words, 0, 1, { minSec: 20, maxSec: 60 })).toBeNull()
  })

  it('sobreposição em relação ao menor trecho', () => {
    expect(overlapRatio({ s: 0, e: 60 }, { s: 50, e: 70 })).toBeCloseTo(0.5)
    expect(overlapRatio({ s: 0, e: 10 }, { s: 20, e: 30 })).toBe(0)
  })
})

const face = (x: number, w = 0.1, motion = 0): FaceBox => ({ x, y: 0.2, w, h: 0.2, score: 0.9, motion })
const frame = (t: number, faces: FaceBox[], cut = false): FaceFrame => ({ t, faces, cut })

describe('câmera seguindo quem fala', () => {
  const crop = 0.316

  it('um rosto: olha pra ele; dois juntos: o meio; separados: quem mexe a boca', () => {
    const frames = [
      frame(0, [face(0.6)]),
      frame(0.2, [face(0.42), face(0.5)]),
      frame(0.4, [face(0.1, 0.1, 0), face(0.8, 0.1, 0.05)]),
      frame(0.6, [face(0.1, 0.1, 0), face(0.8, 0.1, 0.06)])
    ]
    const tg = targets(frames, crop)
    expect(tg[0]).toBeCloseTo(0.65)
    expect(tg[1]).toBeCloseTo(0.51)
    expect(tg[2]).toBeCloseTo(0.85)
    expect(tg[3]).toBeCloseTo(0.85)
  })

  it('planos parados: não segue cada tremida, troca quando a pessoa muda de lugar', () => {
    const frames: FaceFrame[] = []
    for (let i = 0; i < 50; i++) {
      const t = i * 0.2
      // 0–5 s: rosto na esquerda tremendo um pouco; 5–10 s: rosto na direita
      const x = t < 5 ? 0.2 + (i % 2 ? 0.01 : -0.01) : 0.7
      frames.push(frame(t, [face(x)], false))
    }
    const shots = buildShots(frames, targets(frames, crop), crop, 0, 10)
    expect(shots).toHaveLength(2)
    expect(shots[0]!.s).toBe(0)
    expect(shots[0]!.x).toBeCloseTo(0.25, 1)
    expect(shots[1]!.s).toBeCloseTo(5, 0)
    expect(shots[1]!.x).toBeCloseTo(0.75, 1)
    expect(shots[1]!.e).toBe(10)
  })

  it('troca de câmera na fonte corta na hora; sem rosto segura o último lugar', () => {
    const frames = [frame(0, [face(0.2)]), frame(1, [face(0.2)]), frame(1.2, [face(0.75)], true), frame(1.4, []), frame(1.6, [face(0.75)])]
    const shots = buildShots(frames, targets(frames, crop), crop, 0, 2)
    expect(shots.map((s) => s.s)).toEqual([0, 1.2])
  })

  it('recorte nunca sai do quadro e vira expressão por trecho no tempo do vídeo final', () => {
    const track = { from: 0, to: 30, shots: [{ s: 0, e: 10, x: 0.05 }, { s: 10, e: 30, x: 0.95 }] }
    expect(faceXAt(track, 5)).toBe(0.05)
    expect(faceXAt(track, 12)).toBe(0.95)
    expect(trackCovers(track, [{ s: 2, e: 20 }])).toBe(true)
    expect(trackCovers(track, [{ s: 2, e: 40 }])).toBe(false)
    // fonte 1920×1080: recorte de 608; trecho da live 5–15 s
    const expr = faceCropExpr(track, [{ s: 5, e: 15 }], 1920, 608)
    expect(expr).toBe('if(lt(t,5),0,1312)')
    // dois trechos colados: o segundo começa no tempo 5 do vídeo final
    expect(faceCropExpr(track, [{ s: 0, e: 5 }, { s: 20, e: 25 }], 1920, 608)).toBe('if(lt(t,5),0,1312)')
  })
})

describe('render dos layouts novos', () => {
  const base = {
    src: 'in.mkv',
    srcW: 1920,
    srcH: 1080,
    srcFps: 30,
    cutIn: 100,
    cutOut: 130,
    camSplit: 40 as const,
    crop: { cam: { x: 0, y: 0, w: 0.2, h: 0.2 }, game: { x: 0, y: 0, w: 1, h: 1 } },
    zoom: null,
    subtitles: 'sub.ass',
    fontsDir: 'fonts',
    watermark: null,
    audio: { tracks: [0], musicTrack: null, musicGainDb: -22 },
    encoder: 'x264' as const,
    out: 'out.mp4'
  }

  it('vídeo inteiro: fundo desfocado e o quadro no meio', () => {
    const g = renderFilterGraph({ ...base, layout: 'fit' }).graph
    expect(g).toContain('boxblur')
    const box = fitBox(1920, 1080)
    expect(g).toContain(`scale=${box.w}:${box.h}`)
    expect(g).toContain(`overlay=${box.x}:${box.y}`)
    expect(g).toContain('ass=sub.ass')
  })

  it('seguir quem fala: crop 9:16 com x por plano (tempo de saída)', () => {
    const faces = { from: 90, to: 140, shots: [{ s: 90, e: 110, x: 0.3 }, { s: 110, e: 140, x: 0.7 }] }
    const g = renderFilterGraph({ ...base, layout: 'face', faces }).graph
    expect(g).toContain("crop=608:1080:x='if(lt(t,10),272,1040)':y=0")
    expect(g).toContain('scale=1080:1920')
    const zoomed = renderFilterGraph({ ...base, layout: 'face', faces, zoom: { at: 3, duration: 1.6, factor: 1.35 } }).graph
    expect(zoomed).toContain("enable='between(t,3,4.6)'")
    expect(renderArgs({ ...base, layout: 'face', faces })).toContain('-filter_complex')
  })

  it('layouts de quadro inteiro ocupam a tela toda no preview', () => {
    expect(layoutPanes('fit', 40)).toHaveLength(1)
    expect(layoutPanes('face', 40)[0]!.out.h).toBe(1920)
  })
})

describe('canal vigiado', () => {
  it('lista de vídeos do canal (YouTube sem Shorts, Twitch só VODs)', () => {
    expect(channelListUrl('https://www.youtube.com/@BroxadaSinistra')).toBe('https://www.youtube.com/@BroxadaSinistra/videos')
    expect(channelListUrl('https://youtube.com/@canal/featured')).toBe('https://youtube.com/@canal/videos')
    expect(channelListUrl('https://www.youtube.com/@canal/streams')).toBe('https://www.youtube.com/@canal/streams')
    expect(channelListUrl('https://www.youtube.com/channel/UC123abc')).toBe('https://www.youtube.com/channel/UC123abc/videos')
    expect(channelListUrl('https://www.twitch.tv/alanzoka')).toBe('https://www.twitch.tv/alanzoka/videos?filter=archives&sort=time')
    expect(channelListUrl('https://www.youtube.com/watch?v=abc')).toBeNull()
    expect(channelListUrl('https://www.twitch.tv/videos/123')).toBeNull()
    expect(channelListUrl('https://vimeo.com/x')).toBeNull()
  })

  it('link de vídeo avulso', () => {
    expect(isVideoUrl('https://www.youtube.com/watch?v=abc')).toBe(true)
    expect(isVideoUrl('https://youtu.be/abc')).toBe(true)
    expect(isVideoUrl('https://www.twitch.tv/videos/2283746512')).toBe(true)
    expect(isVideoUrl('https://www.youtube.com/@canal')).toBe(false)
  })

  it('lê a listagem e as informações do yt-dlp', () => {
    const list = parseListing({
      entries: [
        { id: 'a1', title: 'EP 120', url: 'https://www.youtube.com/watch?v=a1', duration: 7200 },
        { id: 'b2', title: 'AO VIVO', url: 'https://www.youtube.com/watch?v=b2', live_status: 'is_live' },
        { title: 'sem id' }
      ]
    })
    expect(list.map((v) => v.id)).toEqual(['a1', 'b2'])
    expect(list[0]!.duration).toBe(7200)
    expect(notReadyYet(list[1]!.liveStatus)).toBe(true)
    expect(notReadyYet('was_live')).toBe(false)
    const info = parseVideoInfo({ id: 'a1', title: 'EP 120', duration: 7200.5, upload_date: '20261030', live_status: 'not_live' })
    expect(info).toEqual({ id: 'a1', title: 'EP 120', duration: 7200.5, liveStatus: 'not_live', date: '2026-10-30' })
  })

  it('baixa até a altura pedida, num MKV', () => {
    const args = downloadArgs('https://youtu.be/x', 'C:\\vods', 'C:\\ff', 720)
    expect(args).toEqual(expect.arrayContaining(['-f', 'bv*[height<=720]+ba/b[height<=720]/b', '--merge-output-format', 'mkv', '--no-playlist']))
  })
})

describe('postagem automática', () => {
  const words = (text: string, from = 0): Word[] => text.split(' ').map((w, i) => ({ w, s: from + i * 0.5, e: from + i * 0.5 + 0.4 }))
  const clip = (id: string, score: number, text: string, dur = 40) =>
    ({
      id,
      number: Number(id.replace(/\D/g, '')) || 1,
      stage: 'ready',
      llm: { score, title: '', hooks: [] },
      words: words(text),
      cutIn: 0,
      cutOut: dur,
      segments: [{ s: 0, e: dur }]
    }) as never

  it('termos proibidos sem acento nem caixa, palavra inteira', () => {
    const terms = parseBlocklist('Política, aposta\nbet')
    expect(terms).toEqual(['politica', 'aposta', 'bet'])
    expect(hitsBlocklist(clip('c1', 80, 'falei de POLÍTICA ontem'), terms)).toBe('politica')
    expect(hitsBlocklist(clip('c2', 80, 'alfabeto não conta'), terms)).toBeNull()
  })

  it('escolhe pela nota mínima, duração e termos, melhor primeiro, até perDay × dias', () => {
    const profile = { autoPost: { minScore: 70, maxClipSec: 90, blocklist: 'aposta', perDay: 1, days: 2 } } as never
    const { picked, blocked } = pickClips(
      [clip('c1', 75, 'oi'), clip('c2', 95, 'oi'), clip('c3', 60, 'oi'), clip('c4', 99, 'fiz uma aposta'), clip('c5', 90, 'oi', 120), clip('c6', 80, 'oi')],
      profile
    )
    expect(picked.map((c) => c.id)).toEqual(['c2', 'c6'])
    expect(blocked).toBe(1)
  })
})
