import { describe, expect, it, vi } from 'vitest'
import { channelLogo } from '@shared/defaults'
import { planSlots, pickSlots, DEFAULT_SLOTS } from '@shared/schedule'
import { captionTop, DEFAULT_TEXT, hookTextFor, watermarkBox } from '@shared/text'
import type { Clip, StyleExample } from '@shared/types'

// main/style.ts e main/image.ts dependem do Electron/banco: troca por versões em memória
const store = new Map<string, unknown>()
vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => '', getPath: () => '' }, BrowserWindow: { getAllWindows: () => [] }, safeStorage: {} }))
vi.mock('../src/main/db', () => ({
  settingsRepo: { get: (k: string) => store.get(k) ?? null, set: (k: string, v: unknown) => store.set(k, v) }
}))
const style = { notes: 'escrevo tudo minúsculo, falo "chat"', avoid: 'épico, insano', learn: true, defaultGame: '' }
vi.mock('../src/main/settings', () => ({ getSettings: () => ({ style, text: DEFAULT_TEXT }) }))

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
    const block = captionStyleBlock('Valorant')
    expect(block).toContain('Jogo da live: Valorant')
    expect(block).toContain('escrevo tudo minúsculo')
    expect(block).toContain('Nunca use estas palavras/expressões: épico, insano')
    expect(block).toContain('chat eu juro que ele tava atrás kkkk')
    const p = captionsPrompt([{ w: 'oi', s: 0, e: 1 }], 0, 5, null, null, rules as never, { instagram: '@a', tiktok: '@b', youtube: '@c' }, block)
    expect(p.system).toContain(HUMAN_RULES)
    expect(p.system).toContain('chat eu juro')
    const h = hooksPrompt([{ w: 'oi', s: 0, e: 1 }], 0, 5, [], hookStyleBlock(null))
    expect(h.system).toContain('ELE NÃO SABIA')
  })

  it('sem jogo informado, manda não chutar o jogo', () => {
    expect(captionStyleBlock(null)).toContain('não chute o nome do jogo')
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
