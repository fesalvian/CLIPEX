import { describe, expect, it, vi } from 'vitest'
import { channelLogo } from '@shared/defaults'
import { planSlots, pickSlots, reflowQueue, DEFAULT_SLOTS } from '@shared/schedule'
import { captionTop, DEFAULT_TEXT, hookTextFor, watermarkBox } from '@shared/text'
import type { Clip, StyleExample } from '@shared/types'

// main/style.ts e main/image.ts dependem do Electron/banco: troca por versões em memória
const store = new Map<string, unknown>()
vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => '', getPath: () => '' }, BrowserWindow: { getAllWindows: () => [] }, safeStorage: {}, shell: {} }))
vi.mock('../src/main/db', () => ({
  settingsRepo: { get: (k: string) => store.get(k) ?? null, set: (k: string, v: unknown) => store.set(k, v) },
  projectsRepo: { get: () => null }
}))
vi.mock('../src/main/profiles', () => ({ getProfile: () => ({ id: 'fesalvian', kind: 'gameplay' }), secretKey: (b: string) => b }))
const style = { notes: 'escrevo tudo minúsculo, falo "chat"', avoid: 'épico, insano', learn: true, defaultGame: '' }
vi.mock('../src/main/settings', () => ({ getSettings: () => ({ style, text: DEFAULT_TEXT }), activeProfileId: () => 'fesalvian' }))

const { addExample, captionStyleBlock, hookStyleBlock, learnFromClip, listExamples } = await import('../src/main/style')
const { parseCropdetect } = await import('../src/main/image')
const { captionsPrompt, hooksPrompt, HUMAN_RULES } = await import('../src/main/llm/prompts')
const rules = (await import('../config/platform-rules.json')).default

const fmt = (d: Date | null): string => (d ? `${d.getDate()}/${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : 'agora')

describe('vários cortes por dia', () => {
  const slots = { instagram: ['12:00', '19:30', '21:30'], tiktok: ['12:30', '19:00', '21:30'], youtube: ['12:00', '18:00', '20:00'] }
  const start = new Date(2026, 9, 9, 13, 0) // 9/10 13:00

  it('3 por dia começando agora: o melhor sai na hora, o resto nos melhores horários de cada rede', () => {
    const plan = planSlots({ count: 7, networks: ['instagram', 'youtube'], start, firstNow: true, perDay: 3, fixedTime: null, slots })
    expect(plan.map((r) => r.map(fmt).join(' '))).toEqual([
      'agora agora',
      '9/19:30 9/18:00', // ainda cabem 2 hoje (o "agora" conta como um dos 3)
      '9/21:30 9/20:00',
      '10/12:00 10/12:00',
      '10/19:30 10/18:00',
      '10/21:30 10/20:00',
      '11/12:00 11/12:00'
    ])
  })

  it('postar 3 agora e agendar o resto, 2 por dia', () => {
    const plan = planSlots({ count: 6, networks: ['tiktok'], start, firstNow: true, nowCount: 3, perDay: 2, fixedTime: null, slots })
    // os 3 de agora já passam do ritmo de hoje: o resto começa amanhã
    expect(plan.map((r) => fmt(r[0]!))).toEqual(['agora', 'agora', 'agora', '10/12:30', '10/19:00', '11/12:30'])
  })

  it('1 por dia no horário escolhido', () => {
    const at = new Date(2026, 9, 9, 19, 30)
    const plan = planSlots({ count: 3, networks: ['tiktok'], start: at, firstNow: false, perDay: 1, fixedTime: '19:30', slots })
    expect(plan.map((r) => fmt(r[0]!))).toEqual(['9/19:30', '10/19:30', '11/19:30'])
  })

  it('todos juntos', () => {
    const plan = planSlots({ count: 3, networks: ['tiktok'], start, firstNow: false, perDay: null, fixedTime: null, slots })
    expect(plan.map((r) => fmt(r[0]!))).toEqual(['9/13:00', '9/13:00', '9/13:00'])
  })

  it('horário que já passou hoje não é usado; pickSlots respeita o espaço entre posts', () => {
    const late = new Date(2026, 9, 9, 22, 0)
    const plan = planSlots({ count: 2, networks: ['instagram'], start: late, firstNow: true, perDay: 3, fixedTime: null, slots })
    expect(plan.map((r) => fmt(r[0]!))).toEqual(['agora', '10/12:00'])
    expect(pickSlots(['19:00', '19:30', '20:00'], DEFAULT_SLOTS.instagram, 3)).toEqual(['12:00', '19:00', '20:00'])
  })
})

describe('logo acima da legenda', () => {
  const cap = { ...DEFAULT_TEXT.caption, y: 1580 }
  it('fica centralizada e logo acima do bloco de 2 linhas, sem encostar', () => {
    const logo = channelLogo('x.png')
    const b = watermarkBox(logo, cap)
    expect(b.w).toBe(358)
    expect(b.h).toBe(Math.round((358 * 224) / 1018))
    expect(b.x + b.w / 2).toBeCloseTo(540, 0)
    expect(b.y + b.h).toBeLessThanOrEqual(captionTop(cap) - logo.gap + 1)
  })
  it('acompanha a legenda quando ela muda de lugar', () => {
    const logo = channelLogo('x.png')
    const up = watermarkBox(logo, { ...cap, y: 1200 })
    expect(watermarkBox(logo, cap).y - up.y).toBe(380)
  })
  it('espaço negativo vira zero (nunca sobrepõe a legenda)', () => {
    const b = watermarkBox({ ...channelLogo('x.png'), gap: -300 }, cap)
    expect(b.y + b.h).toBeLessThanOrEqual(Math.round(captionTop(cap)) + 1)
  })
  it('modo livre usa a posição salva', () => {
    expect(watermarkBox({ ...channelLogo('x.png'), anchor: 'free', x: 10, y: 20 }, cap)).toMatchObject({ x: 10, y: 20 })
  })
  it('lê o recorte do cropdetect', () => {
    expect(parseCropdetect('... crop=1018:224:248:366\n... crop=1018:224:248:366')).toEqual({ w: 1018, h: 224, x: 248, y: 366 })
    expect(parseCropdetect('nada')).toBeNull()
  })
})

describe('Instagram', () => {
  it('detecta o servidor pelo tipo de token', async () => {
    const { hostForToken } = await import('../src/main/posting/instagram')
    expect(hostForToken('IGAAxyz')).toBe('graph.instagram.com')
    expect(hostForToken('EAAGxyz')).toBe('graph.facebook.com')
  })
  it('vídeo grande ganha bitrate que cabe nos 48 MB do storage gratuito', async () => {
    const { bitrateToFit, fitBitrateArgs } = await import('../src/main/ffmpeg/args')
    const kbps = bitrateToFit(48 * 1024 * 1024, 90)
    // 90 s × (vídeo + 192k de áudio) tem que caber
    expect(((kbps + 192) * 1000 * 90) / 8).toBeLessThan(48 * 1024 * 1024)
    expect(kbps).toBeGreaterThan(3500)
    expect(fitBitrateArgs('a.mp4', 'b.mp4', kbps, 'nvenc')).toEqual(expect.arrayContaining(['-b:v', `${kbps}k`, '-c:a', 'copy']))
  })
})

describe('gancho com texto fixo vazio', () => {
  it('cai na sugestão da IA em vez de ficar sem gancho', () => {
    const c = { hookOff: false, hookCustom: '', hookChoice: null, hookStyle: null, llm: { hooks: ['DA IA'] } } as unknown as Clip
    expect(DEFAULT_TEXT.hook.mode).toBe('fixed')
    expect(hookTextFor(c, DEFAULT_TEXT)).toBe('DA IA')
    expect(hookTextFor(c, { ...DEFAULT_TEXT, hook: { ...DEFAULT_TEXT.hook, fixedText: 'CORTE DA LIVE' } })).toBe('CORTE DA LIVE')
  })
})

describe('meu jeito de escrever', () => {
  it('exemplos e regras entram no prompt das legendas e dos ganchos', () => {
    addExample({ kind: 'caption', network: 'instagram', text: 'chat eu juro que ele tava atrás kkkk', hashtags: ['#valorant'], source: 'manual' })
    addExample({ kind: 'hook', network: null, text: 'ELE NÃO SABIA', hashtags: [], source: 'manual' })
    const block = captionStyleBlock('fesalvian', 'Valorant')
    expect(block).toContain('Jogo da live: Valorant')
    expect(block).toContain('escrevo tudo minúsculo')
    expect(block).toContain('Nunca use estas palavras/expressões: épico, insano')
    expect(block).toContain('chat eu juro que ele tava atrás kkkk')
    const p = captionsPrompt([{ w: 'oi', s: 0, e: 1 }], 0, 5, null, null, rules as never, { instagram: '@a', tiktok: '@b', youtube: '@c' }, block)
    expect(p.system).toContain(HUMAN_RULES)
    expect(p.system).toContain('chat eu juro')
    const h = hooksPrompt([{ w: 'oi', s: 0, e: 1 }], 0, 5, [], hookStyleBlock('fesalvian', null))
    expect(h.system).toContain('ELE NÃO SABIA')
  })

  it('sem jogo informado, manda não chutar o jogo', () => {
    expect(captionStyleBlock('fesalvian', null)).toContain('não chute o nome do jogo')
  })

  it('aprende com o que foi postado, sem duplicar', () => {
    const clip = {
      hookOff: false,
      hookCustom: 'MEU GANCHO',
      hookChoice: null,
      hookStyle: null,
      llm: null,
      captions: { tiktok: { text: 'texto final editado', hashtags: ['#a'] } }
    } as unknown as Clip
    learnFromClip(clip)
    learnFromClip(clip)
    const all = listExamples() as StyleExample[]
    expect(all.filter((e) => e.text === 'texto final editado')).toHaveLength(1)
    expect(all.some((e) => e.kind === 'hook' && e.text === 'MEU GANCHO' && e.source === 'posted')).toBe(true)
  })
})

describe('fila depois do app fechado', () => {
  // horários locais, como o agendamento
  const d = (day: number, h: number, m = 0): Date => new Date(2026, 9, day, h, m)
  const fmt = (ds: Date[] | null): string[] | null => ds?.map((x) => `${x.getDate()} ${x.getHours()}:${String(x.getMinutes()).padStart(2, '0')}`) ?? null

  it('nada atrasado (ou só um pouco): não mexe', () => {
    expect(reflowQueue([d(24, 19), d(24, 21, 30)], d(23, 10))).toBeNull()
    expect(reflowQueue([d(23, 9, 45), d(24, 19)], d(23, 10))).toBeNull()
  })
  it('o primeiro atrasado sai agora e o resto anda no mesmo ritmo, sem rajada', () => {
    const times = [d(19, 19), d(19, 21, 30), d(20, 19), d(20, 21, 30), d(24, 19), d(24, 21, 30)]
    expect(fmt(reflowQueue(times, d(23, 10)))).toEqual(['23 10:00', '24 19:00', '24 21:30', '25 19:00', '25 21:30', '26 19:00'])
  })
  it('próximo horário a menos de 1 h: não posta agora, usa ele', () => {
    const times = [d(20, 19), d(24, 19), d(24, 21, 30)]
    expect(fmt(reflowQueue(times, d(24, 18, 30)))).toEqual(['24 19:00', '24 21:30', '25 19:00'])
  })
  it('tudo atrasado: continua nos horários do dia que a fila usava', () => {
    expect(fmt(reflowQueue([d(19, 19), d(19, 21, 30), d(20, 19)], d(23, 10)))).toEqual(['23 10:00', '23 19:00', '23 21:30'])
  })
})

describe('TikTok', () => {
  it('até 64 MB vai inteiro; acima, pedaços de 10 MB com o resto no último', async () => {
    const { chunkPlan } = await import('../src/main/posting/tiktok')
    const MB = 1024 * 1024
    // o vídeo de 19 MB que o TikTok recusou como "1 pedaço de 10 MB"
    expect(chunkPlan(Math.round(19.34 * MB))).toEqual({ chunkSize: Math.round(19.34 * MB), count: 1 })
    expect(chunkPlan(3 * MB)).toEqual({ chunkSize: 3 * MB, count: 1 })
    expect(chunkPlan(64 * MB)).toEqual({ chunkSize: 64 * MB, count: 1 })
    const big = Math.round(79.2 * MB)
    const p = chunkPlan(big)
    expect(p).toEqual({ chunkSize: 10 * MB, count: 7 })
    const last = big - (p.count - 1) * p.chunkSize
    expect(last).toBeGreaterThanOrEqual(5 * MB)
    expect(last).toBeLessThanOrEqual(128 * MB)
  })
})
