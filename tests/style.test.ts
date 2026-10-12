import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { captionFrame, captionStyleFor, DEFAULT_TEXT, hookFrame, hookTextFor, mergeDefaults } from '@shared/text'
import type { Clip, LlmInsight } from '@shared/types'

vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => '', getPath: () => '' },
  BrowserWindow: { getAllWindows: () => [] },
  safeStorage: { isEncryptionAvailable: () => false }
}))

const { readFontNames } = await import('../src/main/fonts')
const { Semaphore } = await import('../src/main/sema')
const { mergeWords } = await import('../src/main/pipeline')

const llm: LlmInsight = {
  score: 80,
  title: 'x',
  reason: '',
  tags: [],
  hooks: ['GANCHO A', 'GANCHO B', 'GANCHO C'],
  suggestedIn: 0,
  suggestedOut: 10,
  provider: 'openai'
}
const base = { hookOff: false, hookCustom: '', hookChoice: null, llm, hookStyle: null } as Pick<
  Clip,
  'hookOff' | 'hookCustom' | 'hookChoice' | 'llm' | 'hookStyle'
>

describe('texto do gancho', () => {
  it('segue: desligado › escrito › escolhido › padrão', () => {
    expect(hookTextFor(base, DEFAULT_TEXT)).toBe('GANCHO A')
    expect(hookTextFor({ ...base, hookChoice: 2 }, DEFAULT_TEXT)).toBe('GANCHO C')
    expect(hookTextFor({ ...base, hookChoice: 2, hookCustom: 'meu' }, DEFAULT_TEXT)).toBe('meu')
    expect(hookTextFor({ ...base, hookCustom: 'meu', hookOff: true }, DEFAULT_TEXT)).toBeNull()
  })
  it('texto fixo padrão e gancho desligado nas configurações', () => {
    const fixed = mergeDefaults({ hook: { ...DEFAULT_TEXT.hook, mode: 'fixed', fixedText: 'CORTE DA LIVE' } })
    expect(hookTextFor(base, fixed)).toBe('CORTE DA LIVE')
    expect(hookTextFor({ ...base, hookChoice: 1 }, fixed)).toBe('GANCHO B')
    const off = mergeDefaults({ hook: { ...DEFAULT_TEXT.hook, enabled: false } })
    expect(hookTextFor({ ...base, hookChoice: 1 }, off)).toBeNull()
  })
})

describe('estilo da legenda', () => {
  it('posição automática acompanha a altura da webcam; arrastada fica fixa', () => {
    const at40 = captionStyleFor({ captionStyle: { y: null }, layout: 'both', camSplit: 40 }, DEFAULT_TEXT)
    const at50 = captionStyleFor({ captionStyle: { y: null }, layout: 'both', camSplit: 50 }, DEFAULT_TEXT)
    expect(at50.y).toBeGreaterThan(at40.y)
    const moved = captionStyleFor({ captionStyle: { x: 400, y: 1600 }, layout: 'both', camSplit: 50 }, DEFAULT_TEXT)
    expect([moved.x, moved.y]).toEqual([400, 1600])
  })
})

describe('animações no preview (mesma conta do render)', () => {
  const cue = { id: 'c', start: 10, end: 12, words: [{ w: 'a', s: 10, e: 10.5 }, { w: 'b', s: 10.5, e: 11 }, { w: 'c', s: 11, e: 12 }] }
  it('pop salta e assenta', () => {
    expect(captionFrame(cue, 10, 'pop').scale).toBeCloseTo(0.7)
    expect(captionFrame(cue, 10.12, 'pop').scale).toBeCloseTo(1.08)
    expect(captionFrame(cue, 10.5, 'pop').scale).toBe(1)
  })
  it('palavra por palavra mostra só até a atual', () => {
    expect(captionFrame(cue, 10.6, 'reveal')).toMatchObject({ visible: 2, current: 1 })
    expect(captionFrame(cue, 10.6, 'none')).toMatchObject({ visible: 3, current: 1 })
  })
  it('gancho: some depois da duração; máquina de escrever revela letras', () => {
    expect(hookFrame('OLA', 3.5, { animation: 'pop', duration: 3 }).visible).toBe(false)
    expect(hookFrame('OLA MUNDO', 0, { animation: 'typewriter', duration: 3 }).chars).toBe(1)
    expect(hookFrame('OLA MUNDO', 2, { animation: 'typewriter', duration: 3 }).chars).toBe(9)
    expect(hookFrame('OLA', 0, { animation: 'slide', duration: 3 }).dy).toBe(-120)
  })
})

describe('fontes', () => {
  const dir = resolve(__dirname, '../resources/fonts')
  it('lê o nome da família de cada fonte que vem com o app', () => {
    const names = readdirSync(dir)
      .filter((f) => /\.(ttf|otf)$/i.test(f))
      .map((f) => readFontNames(readFileSync(join(dir, f)))?.family)
    expect(names).toEqual(expect.arrayContaining(['Montserrat ExtraBold', 'Anton', 'Bebas Neue', 'Bangers', 'Luckiest Guy', 'Poppins Black']))
  })
  it('arquivo que não é fonte é recusado', () => {
    expect(readFontNames(Buffer.from('não sou uma fonte'))).toBeNull()
  })
})

describe('fila com prioridade', () => {
  it('pedido da tela passa na frente do lote', async () => {
    const lane = new Semaphore(1)
    const order: string[] = []
    const job = (name: string, ms = 5) => () => new Promise<void>((r) => setTimeout(() => (order.push(name), r()), ms))
    const all = [
      lane.run(job('lote1', 20)),
      lane.run(job('lote2')),
      lane.run(job('lote3')),
      lane.run(job('tela'), { priority: true })
    ]
    await Promise.all(all)
    expect(order).toEqual(['lote1', 'tela', 'lote2', 'lote3'])
  })
})

describe('transcrição estendida', () => {
  it('junta palavras novas sem duplicar o trecho antigo', () => {
    const old = [{ w: 'b', s: 10, e: 11 }]
    const fresh = [{ w: 'a', s: 5, e: 6 }, { w: 'b2', s: 10.2, e: 10.8 }, { w: 'c', s: 20, e: 21 }]
    expect(mergeWords(old, fresh, 8, 15).map((w) => w.w)).toEqual(['a', 'b', 'c'])
  })
})
