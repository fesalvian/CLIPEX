import type { PlatformRules } from '@shared/platformRules'
import { buildCues, cueText, stripEmoji } from '@shared/subtitles'
import { fmtDur } from '@shared/time'
import { DEFAULT_PROFILE_ID } from '@shared/defaults'
import type { Accounts, ClipKind, DetectedTag, LlmProvider, NetCaption, Profile, Word } from '@shared/types'
import type { JsonSchema } from './client'

const TAG_PT: Record<DetectedTag, string> = {
  laugh: 'risada',
  scream: 'grito',
  peak: 'pico de volume',
  manual: 'marcado pelo streamer',
  talk: 'conversa'
}

const CHANNEL = `Você trabalha editando cortes da live de jogo do streamer brasileiro Felipe Salviano ("Senhor Salvian"), que faz live na Twitch. Os cortes viram vídeos verticais pra Instagram Reels, YouTube Shorts e TikTok, pro público brasileiro. Escreva sempre em português do Brasil, num tom natural de quem joga e vê live, sem emoji.`

/** Quem é o canal, no começo de todo prompt. O perfil do Felipe mantém o texto de sempre. */
export function channelIntro(p: Pick<Profile, 'id' | 'kind' | 'subject'>): string {
  if (p.id === DEFAULT_PROFILE_ID) return CHANNEL
  const tail =
    'Os cortes viram vídeos verticais pra Instagram Reels, YouTube Shorts e TikTok, pro público brasileiro. Escreva sempre em português do Brasil, sem emoji.'
  if (p.kind === 'podcast') {
    return `Você trabalha num canal de cortes do ${p.subject}. ${tail} Tom de quem acompanha o programa e quer mostrar a melhor parte da conversa pra quem não viu o episódio.`
  }
  if (p.kind === 'gameplay') {
    return `Você trabalha num canal de cortes das lives de ${p.subject}. ${tail} Tom natural de quem joga e vê live.`
  }
  return `Você trabalha num canal de cortes dos vídeos de ${p.subject}. ${tail} Tom natural de quem acompanha o canal.`
}

/**
 * Regras contra texto "com cara de IA" e contra inventar o que não aconteceu: o modelo só
 * sabe o que está na transcrição (não vê o vídeo).
 */
export const HUMAN_RULES = `Regras de escrita (valem pra tudo que você escrever):
- Você só sabe o que está na transcrição; você NÃO vê o vídeo. Não invente o que aconteceu, quem é quem, o mapa, a arma ou o jogo. Se a transcrição não deixa claro, escreva algo que funcione sem esse detalhe.
- Escreva como o streamer escreveria pros seguidores dele: frases curtas, gíria de live quando couber, nada de texto de agência ou de marketing.
- Evite frases genéricas e clichês de IA: "você não vai acreditar", "momento épico", "insano", "simplesmente", "prepare-se", "confira", "não perca", "isso é ouro", "mais um dia", exclamação em toda frase.
- Prefira citar uma fala real do trecho (curta) a resumir com adjetivo.`

/** Transcrição com tempos relativos ao início da janela: "[00:12] mano olha ali". */
export function transcriptForPrompt(words: Word[], from: number, to: number): string {
  const cues = buildCues(words, from, to, { maxWords: 14, maxChars: 90, pauseBreak: 1.2 })
  if (cues.length === 0) return '(sem fala detectada)'
  return cues.map((c) => `[${fmtDur(c.start - from)}] ${cueText(c)}`).join('\n')
}

export interface RankInput {
  /** quem é o canal (channelIntro) */
  channel: string
  /** podcast: avalia como conversa, não como reação */
  kind?: ClipKind
  /** bloco "como o Felipe escreve" + exemplos de ganchos (main/style.ts) */
  style: string
  words: Word[]
  winStart: number
  winEnd: number
  peak: number
  tags: DetectedTag[]
  signalScore: number
  /** resumo do que já performou bem (aprendizado com as views) */
  performanceHint: string | null
}

const REACTION_CRITERIA = `Critérios que pesam:
- reação genuína e forte (susto, risada, raiva, comemoração);
- dá pra entender sem ter visto o resto da live;
- tem começo, clímax e fecho em poucos segundos;
- frase marcante ou engraçada que funciona como legenda;
- trechos só de conversa parada ou explicação longa valem pouco.`

const PODCAST_CRITERIA = `Critérios que pesam:
- é uma conversa completa: começa no início do assunto e tem um fecho claro;
- dá pra entender sem ter visto o resto do episódio;
- história com desfecho, opinião forte, revelação, conselho direto ou discussão engraçada;
- frase marcante que funciona como legenda;
- apresentação, patrocínio e papo sem fecho valem pouco.`

export interface RankOutput {
  score: number
  title: string
  reason: string
  tags: string[]
  start: number
  end: number
  hooks: string[]
}

export const RANK_SCHEMA: JsonSchema = {
  name: 'avaliacao_corte',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['score', 'title', 'reason', 'tags', 'start', 'end', 'hooks'],
    properties: {
      score: { type: 'integer', description: 'Potencial de viralizar, 0 a 100' },
      title: { type: 'string', description: 'Nome curto do momento, até 40 caracteres' },
      reason: { type: 'string', description: 'Uma frase dizendo por que funciona ou não' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Até 4 etiquetas curtas (ex.: susto, rage, jogada, zoeira)' },
      start: { type: 'number', description: 'Início sugerido do corte, em segundos desde o começo da janela' },
      end: { type: 'number', description: 'Fim sugerido do corte, em segundos desde o começo da janela' },
      hooks: { type: 'array', items: { type: 'string' }, description: 'Exatamente 3 ganchos' }
    }
  }
}

export function rankPrompt(i: RankInput): { system: string; user: string } {
  const span = i.winEnd - i.winStart
  const system = `${i.channel}

Sua tarefa: avaliar um trecho ${i.kind === 'podcast' ? 'do episódio' : 'da live'} candidato a corte e dizer o potencial dele de viralizar.

${i.kind === 'podcast' ? PODCAST_CRITERIA : REACTION_CRITERIA}

Regras do corte sugerido:
- duração ideal entre ${i.kind === 'podcast' ? '30 e 75 segundos, nunca mais que 90' : '15 e 45 segundos, nunca mais que 60'};
- comece logo antes do contexto necessário, sem enrolação;
- termine logo depois da reação acabar;
- start e end em segundos desde o começo da janela (0 a ${Math.round(span)}).

Ganchos: exatamente 3 opções curtas (até 45 caracteres), em CAIXA ALTA, pra aparecer na tela nos 3 primeiros segundos e prender quem está rolando o feed. Sem emoji, sem mentir sobre o que acontece.

${HUMAN_RULES}
${i.style ? `\n${i.style}\n` : ''}
Responda só com o JSON pedido.`

  const tags = i.tags.map((t) => TAG_PT[t]).join(', ')
  const user = [
    `Janela de ${Math.round(span)} s. O pico dos sinais está em ${fmtDur(i.peak - i.winStart)} (${tags || 'sem sinal específico'}), força ${Math.round(i.signalScore * 100)}/100.`,
    i.performanceHint ? `O que tem dado mais views nos cortes do canal: ${i.performanceHint}` : '',
    '',
    'Transcrição (tempo desde o começo da janela):',
    transcriptForPrompt(i.words, i.winStart, i.winEnd)
  ]
    .filter((l) => l !== null)
    .join('\n')
  return { system, user }
}

export const HOOKS_SCHEMA: JsonSchema = {
  name: 'ganchos',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['hooks'],
    properties: { hooks: { type: 'array', items: { type: 'string' } } }
  }
}

export function hooksPrompt(
  words: Word[],
  from: number,
  to: number,
  avoid: string[],
  style = '',
  channel = CHANNEL
): { system: string; user: string } {
  return {
    system: `${channel}

Escreva 3 ganchos novos pra um corte: textos curtos (até 45 caracteres) em CAIXA ALTA que aparecem na tela nos 3 primeiros segundos. Precisam despertar curiosidade e combinar com o que acontece no trecho. Sem emoji, sem mentir.

${HUMAN_RULES}
${style ? `\n${style}\n` : ''}
Responda só com o JSON.`,
    user: `Não repita estes: ${avoid.join(' | ') || '(nenhum)'}\n\nTranscrição do corte:\n${transcriptForPrompt(words, from, to)}`
  }
}

export interface CaptionsOutput {
  instagram: { text: string; hashtags: string[] }
  tiktok: { text: string; hashtags: string[] }
  youtube: { title: string; text: string; hashtags: string[] }
}

const NET_CAPTION = {
  type: 'object',
  additionalProperties: false,
  required: ['text', 'hashtags'],
  properties: { text: { type: 'string' }, hashtags: { type: 'array', items: { type: 'string' } } }
}

export const CAPTIONS_SCHEMA: JsonSchema = {
  name: 'legendas_por_rede',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['instagram', 'tiktok', 'youtube'],
    properties: {
      instagram: NET_CAPTION,
      tiktok: NET_CAPTION,
      youtube: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'text', 'hashtags'],
        properties: {
          title: { type: 'string' },
          text: { type: 'string' },
          hashtags: { type: 'array', items: { type: 'string' } }
        }
      }
    }
  }
}

export function captionsPrompt(
  words: Word[],
  from: number,
  to: number,
  hook: string | null,
  title: string | null,
  rules: PlatformRules,
  accounts: Accounts,
  style = '',
  channel = CHANNEL
): { system: string; user: string } {
  const rule = (k: keyof PlatformRules): string =>
    `${rules[k].product} (${k === 'instagram' ? accounts.instagram : k === 'tiktok' ? accounts.tiktok : accounts.youtube}): ${rules[k].guidance.join(' ')} Texto até ${rules[k].maxChars} caracteres; ${rules[k].hashtags.min} a ${rules[k].hashtags.max} hashtags${rules[k].hashtags.required.length ? `, sempre com ${rules[k].hashtags.required.join(' ')}` : ''}.${rules[k].hasTitle ? ` Título até ${rules[k].titleMax ?? 100} caracteres.` : ''}`
  return {
    system: `${channel}

Escreva a legenda e as hashtags de um corte pra cada rede, seguindo as regras de cada uma:
- ${rule('instagram')}
- ${rule('tiktok')}
- ${rule('youtube')}

Hashtags em minúsculas, sem acento, específicas do momento e do assunto (jogo só se foi informado). Não ponha hashtags dentro do texto, só na lista.

${HUMAN_RULES}
${style ? `\n${style}\n` : ''}
Responda só com o JSON.`,
    user: [
      title ? `Momento: ${title}` : '',
      hook ? `Gancho na tela: ${hook}` : '',
      '',
      'Transcrição do corte:',
      transcriptForPrompt(words, from, to)
    ].join('\n')
  }
}

export function captionsFromOutput(o: CaptionsOutput): Record<'instagram' | 'tiktok' | 'youtube', NetCaption> {
  return {
    instagram: { text: o.instagram.text, hashtags: o.instagram.hashtags },
    tiktok: { text: o.tiktok.text, hashtags: o.tiktok.hashtags },
    youtube: { title: o.youtube.title, text: o.youtube.text, hashtags: o.youtube.hashtags }
  }
}

export { stripEmoji }

/** Normaliza a resposta da avaliação (limites, ganchos em caixa alta, corte dentro da janela). */
export function normalizeRank(o: RankOutput, winStart: number, winEnd: number, peak: number, provider: LlmProvider) {
  const span = winEnd - winStart
  let start = Number.isFinite(o.start) ? o.start : 0
  let end = Number.isFinite(o.end) ? o.end : span
  start = Math.max(0, Math.min(span - 5, start))
  end = Math.max(start + 5, Math.min(span, end))
  // Modelos menores às vezes cortam bem no pico e deixam a reação de fora: o corte
  // sempre inclui o pico detectado, com contexto antes e a reação depois.
  const p = Math.max(0, Math.min(span, peak - winStart))
  if (start > p - 2) start = Math.max(0, p - 8)
  if (end < p + 3) end = Math.min(span, p + 5)
  if (end - start > 90) {
    start = Math.max(0, Math.min(start, p - 30))
    end = Math.min(span, start + 90)
  }
  const hooks = (o.hooks ?? [])
    .map((h) => stripEmoji(h).toLocaleUpperCase('pt-BR'))
    .filter(Boolean)
    .slice(0, 3)
  return {
    score: Math.max(0, Math.min(100, Math.round(o.score))),
    title: (o.title ?? '').trim().slice(0, 60),
    reason: (o.reason ?? '').trim(),
    tags: (o.tags ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean).slice(0, 4),
    hooks,
    suggestedIn: Math.round((winStart + start) * 10) / 10,
    suggestedOut: Math.round((winStart + end) * 10) / 10,
    provider
  }
}

// ---------- podcast: conversas completas ----------

export interface SegmentInput {
  channel: string
  style: string
  /** palavras da janela lida (tempo do episódio) */
  words: Word[]
  from: number
  to: number
  /** quantas conversas no máximo nesta janela */
  maxMoments: number
  minSec: number
  maxSec: number
  /** trechos que já viraram corte (tempo desde o começo da janela), pra não repetir */
  taken: { s: number; e: number }[]
  performanceHint: string | null
}

export interface SegmentMoment {
  start: number
  end: number
  score: number
  title: string
  reason: string
  tags: string[]
  hooks: string[]
}

export interface SegmentOutput {
  moments: SegmentMoment[]
}

export const SEGMENT_SCHEMA: JsonSchema = {
  name: 'conversas_completas',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['moments'],
    properties: {
      moments: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['start', 'end', 'score', 'title', 'reason', 'tags', 'hooks'],
          properties: {
            start: { type: 'number', description: 'Início, em segundos desde o começo do trecho (use os tempos entre colchetes)' },
            end: { type: 'number', description: 'Fim, em segundos desde o começo do trecho' },
            score: { type: 'integer', description: 'Potencial de viralizar, 0 a 100' },
            title: { type: 'string', description: 'Nome curto do momento, até 40 caracteres' },
            reason: { type: 'string', description: 'Uma frase dizendo por que funciona sozinho' },
            tags: { type: 'array', items: { type: 'string' }, description: 'Até 4 etiquetas curtas (ex.: história, polêmica, conselho, zoeira)' },
            hooks: { type: 'array', items: { type: 'string' }, description: 'Exatamente 3 ganchos' }
          }
        }
      }
    }
  }
}

/** Transcrição com o tempo em segundos desde o começo do trecho: "[123.4] e aí ele falou". */
function secondsTranscript(words: Word[], from: number, to: number): string {
  const cues = buildCues(words, from, to, { maxWords: 16, maxChars: 110, pauseBreak: 1.2 })
  if (cues.length === 0) return '(sem fala detectada)'
  return cues.map((c) => `[${(c.start - from).toFixed(1)}] ${cueText(c)}`).join('\n')
}

export function segmentPrompt(i: SegmentInput): { system: string; user: string } {
  const span = i.to - i.from
  const system = `${i.channel}

Sua tarefa: ler um trecho da transcrição de um episódio e achar as CONVERSAS COMPLETAS que funcionam sozinhas como corte vertical.

Uma conversa completa:
- começa no início do assunto (a pergunta, a deixa ou a primeira frase da história), nunca no meio de uma frase;
- tem desenvolvimento e um fecho claro (a conclusão, a resposta, a piada final, a risada depois);
- dá pra entender sem ter visto o resto do episódio;
- termina logo depois do fecho, sem puxar o assunto seguinte.

O que vale mais: história pessoal com desfecho, opinião forte ou polêmica, revelação, conselho direto, discussão engraçada, frase marcante. Vale pouco: apresentação, propaganda, leitura de patrocínio, papo de bastidor, conversa sem fecho.

Regras:
- cada conversa entre ${Math.round(i.minSec)} e ${Math.round(i.maxSec)} segundos;
- no máximo ${i.maxMoments} conversas neste trecho, só as que valem a pena (pode ser nenhuma);
- conversas sem sobreposição entre si e fora dos trechos que já viraram corte;
- start e end em segundos desde o começo do trecho (0 a ${Math.round(span)}), usando os tempos entre colchetes.

Ganchos: exatamente 3 opções curtas (até 45 caracteres), em CAIXA ALTA, pra aparecer na tela nos 3 primeiros segundos e fazer a pessoa ficar até o fim. Sem emoji, sem mentir sobre o que acontece.

${HUMAN_RULES}
${i.style ? `\n${i.style}\n` : ''}
Responda só com o JSON pedido.`
  const user = [
    `Trecho de ${Math.round(span)} s do episódio.`,
    i.taken.length ? `Já viraram corte (não repita): ${i.taken.map((t) => `${t.s.toFixed(0)}–${t.e.toFixed(0)}`).join(', ')}` : '',
    i.performanceHint ? `O que tem dado mais views nos cortes do canal: ${i.performanceHint}` : '',
    '',
    'Transcrição (segundos desde o começo do trecho):',
    secondsTranscript(i.words, i.from, i.to)
  ].join('\n')
  return { system, user }
}

/** Ganchos em caixa alta, nota e etiquetas dentro dos limites. */
export function normalizeMoment(m: SegmentMoment): Omit<SegmentMoment, 'start' | 'end'> {
  return {
    score: Math.max(0, Math.min(100, Math.round(Number(m.score) || 0))),
    title: (m.title ?? '').trim().slice(0, 60),
    reason: (m.reason ?? '').trim(),
    tags: (m.tags ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean).slice(0, 4),
    hooks: (m.hooks ?? [])
      .map((h) => stripEmoji(h).toLocaleUpperCase('pt-BR'))
      .filter(Boolean)
      .slice(0, 3)
  }
}
