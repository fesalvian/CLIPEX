import { describe, expect, it } from 'vitest'
import rules from '../config/platform-rules.json'
import { assColor, assEscape, assTime, buildAss } from '../src/main/render/ass'
import { normalizeRank, stripEmoji, transcriptForPrompt } from '../src/main/llm/prompts'
import { checkCaption, enforceCaption, type PlatformRules } from '@shared/platformRules'
import { applyDictionary, buildCues, findDictFixes, mergeCues, retimeCue } from '@shared/subtitles'
import { fmtClock, fmtDur, fmtTotal, parseLiveDate, projectNameFromDate } from '@shared/time'
import { coverCrop, layoutPanes } from '@shared/geometry'
import type { CaptionStyle, HookStyle, Word } from '@shared/types'
import { captionStyleFor, DEFAULT_TEXT, hookStyleFor } from '@shared/text'

const R = rules as PlatformRules

const words: Word[] = [
  ['mano', 0, 0.4],
  ['mano', 0.4, 0.8],
  ['olha', 0.8, 1.1],
  ['ali', 1.1, 1.4],
  ['calma', 3.0, 3.4],
  ['que', 3.4, 3.5],
  ['tô', 3.5, 3.7],
  ['de', 3.7, 3.8],
  ['a', 3.8, 3.9],
  ['w', 3.9, 4.0],
  ['p', 4.0, 4.2],
  ['[música]', 5, 6]
].map(([w, s, e]) => ({ w: w as string, s: (s as number) + 100, e: (e as number) + 100 }))

describe('tempo', () => {
  it('formata', () => {
    expect(fmtClock(4363.2)).toBe('01:12:43')
    expect(fmtDur(38.4)).toBe('00:38')
    expect(fmtTotal(154)).toBe('2min 34s')
  })
  it('lê a data do nome do arquivo', () => {
    expect(parseLiveDate('live_2026-10-07_21-03.mkv')).toEqual({ date: '2026-10-07', time: '21:03' })
    expect(parseLiveDate('2026-10-07 21-03-11.mkv')).toEqual({ date: '2026-10-07', time: '21:03' })
    expect(parseLiveDate('gravacao.mkv')).toBeNull()
    expect(projectNameFromDate('2026-10-07', 'x')).toBe('Live de 07/10')
  })
})

describe('legenda', () => {
  it('agrupa em trechos curtos, quebra na pausa e ignora ruído', () => {
    const cues = buildCues(words, 100, 110)
    expect(cues.map((c) => c.words.map((w) => w.w).join(' '))).toEqual(['mano mano olha ali', 'calma que tô de', 'a w p'])
  })

  it('dicionário junta "a w p" em AWP mantendo o tempo', () => {
    const cues = buildCues(words, 100, 110)
    const fixes = findDictFixes(cues[2]!, [{ term: 'AWP', variants: ['a w p'] }])
    expect(fixes).toHaveLength(1)
    expect(fixes[0]!.replacement).toBe('AWP')
    const [, , fixed] = applyDictionary(cues, [{ term: 'AWP', variants: ['a w p'] }])
    expect(fixed!.words).toEqual([{ w: 'AWP', s: 103.8, e: 104.2 }])
  })

  it('corrige maiúscula do termo e preserva pontuação', () => {
    const cue = { id: 'c', start: 0, end: 1, words: [{ w: 'salvian!', s: 0, e: 1 }] }
    expect(findDictFixes(cue, [{ term: 'Salvian', variants: [] }])[0]!.replacement).toBe('Salvian!')
  })

  it('mudar o corte mantém trechos editados e gera os que entraram', () => {
    const all = buildCues(words, 100, 110)
    const edited = [retimeCue(all[1]!, 'CALMA QUE TÔ DE')]
    // corte começa antes: o primeiro trecho volta, o editado continua igual
    const merged = mergeCues(edited, words, 100, 103.82, [])
    expect(merged.map((c) => c.words.map((w) => w.w).join(' '))).toEqual(['mano mano olha ali', 'CALMA QUE TÔ DE'])
  })

  it('editar o texto redistribui o tempo quando muda o número de palavras', () => {
    const cue = buildCues(words, 100, 110)[0]!
    const same = retimeCue(cue, 'MANO MANO OLHA LÁ')
    expect(same.words.map((w) => w.s)).toEqual(cue.words.map((w) => w.s))
    const fewer = retimeCue(cue, 'olha ali')
    expect(fewer.words).toHaveLength(2)
    expect(fewer.words[0]!.s).toBe(cue.start)
    expect(fewer.words[1]!.e).toBeCloseTo(cue.end, 2)
  })
})

describe('ASS', () => {
  it('cores e tempos no formato do libass', () => {
    expect(assColor('#C4B5FD')).toBe('&H00FDB5C4')
    expect(assTime(3.456)).toBe('0:00:03.46')
    expect(assEscape('a {b} c\\d')).toBe('a (b) c/d')
  })

  // estilo fixo de teste (não depende do padrão do canal, que pode mudar)
  const BASE_CAP: CaptionStyle = {
    ...DEFAULT_TEXT.caption,
    highlight: '#C4B5FD',
    y: null,
    boxWidth: 940
  }
  const BASE_HOOK: HookStyle = {
    ...DEFAULT_TEXT.hook,
    font: 'Montserrat ExtraBold',
    size: 60,
    color: '#12123A',
    box: true,
    boxColor: '#FFFFFF',
    outlineWidth: 0,
    x: 540,
    y: 210,
    boxWidth: 900,
    duration: 3
  }
  const styles = (cap: Partial<CaptionStyle> = {}, hook: Partial<HookStyle> = {}) => {
    const d = { caption: { ...BASE_CAP, ...cap }, hook: { ...BASE_HOOK, ...hook } }
    const clip = { captionStyle: null, hookStyle: null, layout: 'both' as const, camSplit: 40 as const }
    return { caption: captionStyleFor(clip, d), hookStyle: hookStyleFor(clip, d) }
  }

  it('padrão do canal: o estilo que o Felipe montou', () => {
    expect(DEFAULT_TEXT.caption).toMatchObject({ font: 'Montserrat ExtraBold', size: 84, highlight: '#4DFF00', outlineWidth: 7, y: 1580, animation: 'pop' })
    expect(DEFAULT_TEXT.hook).toMatchObject({ font: 'Luckiest Guy', size: 66, color: '#FFFFFF', box: false, outlineWidth: 6, x: 513, y: 769, duration: 8 })
  })

  it('a área do texto limita a quebra de linha pelas margens da linha', () => {
    const ass = buildAss({ cues: buildCues(words, 100, 110), hook: 'oi', cutIn: 100, cutOut: 110, ...styles({ boxWidth: 600 }, { boxWidth: 400 }) })
    expect(dialogues(ass, 'Caption')[0]).toContain(',Caption,,240,240,0,,')
    expect(dialogues(ass, 'Hook')[0]).toContain(',Hook,,340,340,0,,')
  })
  const dialogues = (ass: string, style: string) => ass.split('\n').filter((l) => l.includes(`,${style},`) && l.startsWith('Dialogue'))

  it('gera gancho nos 3 primeiros segundos e uma linha por palavra destacada', () => {
    const cues = buildCues(words, 100, 110)
    const ass = buildAss({ cues, hook: 'ele não sabia', cutIn: 100, cutOut: 110, ...styles({ animation: 'none' }, { animation: 'none' }) })
    expect(ass).toContain('Dialogue: 2,0:00:00.00,0:00:03.00,Hook,,90,90,0,,{\\an5\\pos(540,210)}ELE NÃO SABIA')
    const lines = dialogues(ass, 'Caption')
    expect(lines).toHaveLength(11)
    // legenda presa pelo topo: 1ª linha centrada logo abaixo da webcam, as outras crescem pra baixo
    expect(lines[0]).toContain('{\\an8\\pos(540,808)}{\\c&H00FDB5C4}MANO{\\c&H00FFFFFF} MANO OLHA ALI')
  })

  it('posição, fonte e cores vêm do estilo', () => {
    const ass = buildAss({
      cues: buildCues(words, 100, 110),
      hook: 'oi',
      cutIn: 100,
      cutOut: 110,
      ...styles({ x: 300, y: 1500, font: 'Anton', color: '#FFFF00', size: 100 }, { y: 400, box: false, outlineWidth: 5 }),
      isBold: () => true
    })
    expect(ass).toMatch(/Style: Caption,Anton,100,&H0000FFFF,&H0000FFFF,&H00000000,&H90000000,-1,/)
    expect(dialogues(ass, 'Caption')[0]).toContain('\\an8\\pos(300,1440)')
    // sem caixa: BorderStyle 1 com contorno 5
    expect(ass).toMatch(/Style: Hook,.*,0,0,1,5,0,5,90,90,0,1/)
    expect(dialogues(ass, 'Hook')[0]).toContain('\\pos(540,400)')
  })

  it('animações da legenda', () => {
    const cues = buildCues(words, 100, 110)
    const pop = dialogues(buildAss({ cues, hook: null, cutIn: 100, cutOut: 110, ...styles({ animation: 'pop' }) }), 'Caption')
    expect(pop[0]).toContain('\\fscx70\\fscy70\\t(0,120,\\fscx108\\fscy108)')
    expect(pop[1]).not.toContain('\\t(')
    const reveal = dialogues(buildAss({ cues, hook: null, cutIn: 100, cutOut: 110, ...styles({ animation: 'reveal' }) }), 'Caption')
    expect(reveal[0]).toMatch(/\}MANO\{[^}]*\}$/)
    expect(reveal[1]).toContain('MANO {\\c&H00FDB5C4}MANO')
    const bounce = dialogues(buildAss({ cues, hook: null, cutIn: 100, cutOut: 110, ...styles({ animation: 'bounce' }) }), 'Caption')
    expect(bounce[0]).toContain('\\t(0,90,\\fscx118\\fscy118)}MANO{')
  })

  it('legenda desligada não gera linhas; gancho máquina de escrever usa karaokê', () => {
    const ass = buildAss({
      cues: buildCues(words, 100, 110),
      hook: 'abc',
      cutIn: 100,
      cutOut: 110,
      ...styles({ enabled: false }, { animation: 'typewriter' })
    })
    expect(dialogues(ass, 'Caption')).toHaveLength(0)
    expect(dialogues(ass, 'Hook')[0]).toContain('{\\ko5}A{\\ko5}B{\\ko5}C')
    // cor secundária transparente: letra ainda não "digitada" não aparece
    expect(ass).toMatch(/Style: Hook,[^,]+,60,&H003A1212,&HFF3A1212,/)
  })
})

describe('regras por rede', () => {
  it('Instagram: no máximo 5 hashtags e tira hashtag do texto', () => {
    const c = enforceCaption('instagram', { text: 'achei errado #susto', hashtags: ['clips', '#Gameplay', '#a', '#b', '#c', '#d'] }, R)
    expect(c.hashtags).toHaveLength(5)
    expect(c.hashtags[0]).toBe('#clips')
    expect(c.text).toBe('achei errado')
  })

  it('Shorts: garante #shorts e uma hashtag no título', () => {
    const c = enforceCaption('youtube', { title: 'ELE TAVA ATRÁS DE MIM', text: 'live todo dia', hashtags: ['#susto'] }, R)
    expect(c.hashtags).toContain('#shorts')
    expect(c.title).toBe('ELE TAVA ATRÁS DE MIM #susto')
    const long = enforceCaption('youtube', { title: 'x'.repeat(150), text: '', hashtags: [] }, R)
    expect(long.title!.length).toBeLessThanOrEqual(100)
  })

  it('avisa quando o Reels passa de 90 s via API', () => {
    const check = checkCaption('instagram', { text: 'oi', hashtags: ['#a', '#b', '#c'] }, R, 95)
    expect(check.warnings.join(' ')).toContain('90 s')
  })
})

describe('LLM', () => {
  it('transcrição pro prompt usa tempo relativo', () => {
    expect(transcriptForPrompt(words, 100, 110).split('\n')[0]).toBe('[00:00] mano mano olha ali')
  })

  it('normaliza corte sugerido dentro da janela', () => {
    const r = normalizeRank(
      { score: 140, title: 'Susto', reason: 'x', tags: ['Susto'], start: -5, end: 500, hooks: ['ele não sabia 😱', 'b', 'c', 'd'] },
      1000,
      1090,
      1045,
      'openai'
    )
    expect(r.score).toBe(100)
    expect(r.suggestedIn).toBe(1000)
    expect(r.suggestedOut).toBe(1090)
    expect(r.hooks).toEqual(['ELE NÃO SABIA', 'B', 'C'])
  })

  it('corte que termina no pico é estendido pra incluir a reação', () => {
    // pico em 45 s da janela; IA sugeriu 0 → 45 (deixa o grito de fora)
    const r = normalizeRank({ score: 50, title: '', reason: '', tags: [], start: 0, end: 45, hooks: [] }, 1000, 1090, 1045, 'local')
    expect(r.suggestedIn).toBe(1000)
    expect(r.suggestedOut).toBe(1050)
    // e o corte que começa depois do pico volta pra pegar ele
    const r2 = normalizeRank({ score: 50, title: '', reason: '', tags: [], start: 50, end: 70, hooks: [] }, 1000, 1090, 1045, 'local')
    expect(r2.suggestedIn).toBe(1037)
  })

  it('emoji não vai pro vídeo', () => {
    expect(stripEmoji('ELE ME VIU 😱🔥 KKKK')).toBe('ELE ME VIU KKKK')
    expect(assEscape('NÃO 😂')).toBe('NÃO ')
  })
})

describe('geometria', () => {
  it('cam + jogo divide 1920 pela altura da webcam', () => {
    expect(layoutPanes('both', 30).map((p) => p.out.h)).toEqual([576, 1344])
  })
  it('cover mantém o centro do retângulo e cabe no frame', () => {
    const c = coverCrop({ x: 0.9, y: 0.5, w: 0.1, h: 0.5 }, 1920, 1080, 1080 / 768)
    expect(c.x + c.w).toBeLessThanOrEqual(1920)
    expect(c.w / c.h).toBeCloseTo(1080 / 768, 1)
  })
})
