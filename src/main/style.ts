// "Meu jeito de escrever": exemplos reais do streamer (cadastrados à mão ou aprendidos do
// que ele posta depois de editar) que vão pro prompt, pra IA escrever como ele em vez de
// soar genérica.

import { randomUUID } from 'node:crypto'
import { normalizeTerm } from '@shared/subtitles'
import { hookTextFor } from '@shared/text'
import { NETWORKS, type Clip, type Network, type StyleExample } from '@shared/types'
import { settingsRepo } from './db'
import { getSettings } from './settings'

const KEY = 'styleExamples'
const MAX = 400

export function listExamples(): StyleExample[] {
  return settingsRepo.get<StyleExample[]>(KEY) ?? []
}

function save(list: StyleExample[]): StyleExample[] {
  const trimmed = list.slice(-MAX)
  settingsRepo.set(KEY, trimmed)
  return trimmed
}

function sameText(a: string, b: string): boolean {
  return normalizeTerm(a) === normalizeTerm(b)
}

export function addExample(ex: Omit<StyleExample, 'id' | 'createdAt'>): StyleExample[] {
  const text = ex.text.trim()
  if (!text) return listExamples()
  // o mesmo texto não entra duas vezes (o mais novo fica)
  const rest = listExamples().filter((e) => !(e.kind === ex.kind && e.network === ex.network && sameText(e.text, text)))
  return save([...rest, { ...ex, text, id: randomUUID().slice(0, 10), createdAt: new Date().toISOString() }])
}

export function removeExample(id: string): StyleExample[] {
  return save(listExamples().filter((e) => e.id !== id))
}

/**
 * Guarda como exemplo o que foi de fato usado (agendado/postado/baixado): legenda de cada
 * rede e o gancho do vídeo. Só se o "aprender com o que eu posto" estiver ligado.
 */
export function learnFromClip(c: Clip, networks: Network[] = NETWORKS.slice()): void {
  const s = getSettings()
  if (!s.style.learn) return
  for (const n of networks) {
    const cap = c.captions?.[n]
    if (cap?.text.trim()) addExample({ kind: 'caption', network: n, text: cap.text, title: cap.title, hashtags: cap.hashtags, source: 'posted' })
  }
  const hook = hookTextFor(c, s.text)
  if (hook) addExample({ kind: 'hook', network: null, text: hook, hashtags: [], source: 'posted' })
}

function bullets(list: string[]): string {
  return list.map((t) => `- ${t.replace(/\s*\n\s*/g, ' / ')}`).join('\n')
}

/** Bloco de estilo pro prompt das legendas das redes. */
export function captionStyleBlock(game: string | null): string {
  const s = getSettings().style
  const ex = listExamples().filter((e) => e.kind === 'caption')
  const parts: string[] = []
  if (game) parts.push(`Jogo da live: ${game}. Use esse nome nas hashtags e na legenda quando fizer sentido; não cite outro jogo.`)
  else parts.push('O jogo da live não foi informado: não chute o nome do jogo nem use hashtag de jogo específico.')
  if (s.notes.trim()) parts.push(`Como o Felipe escreve (siga isto):\n${s.notes.trim()}`)
  if (s.avoid.trim()) parts.push(`Nunca use estas palavras/expressões: ${s.avoid.trim()}`)
  for (const n of NETWORKS) {
    // os mais recentes primeiro; os da própria rede valem mais que os gerais
    const mine = [...ex.filter((e) => e.network === n), ...ex.filter((e) => e.network === null)].slice(-6).reverse()
    if (mine.length === 0) continue
    const label = { instagram: 'Instagram', tiktok: 'TikTok', youtube: 'YouTube Shorts' }[n]
    parts.push(
      `Legendas reais do Felipe no ${label} (copie o tom, o tamanho e o jeito, não o conteúdo):\n${bullets(
        mine.map((e) => [e.title ? `Título: ${e.title}` : '', e.text, e.hashtags.length ? e.hashtags.join(' ') : ''].filter(Boolean).join(' | '))
      )}`
    )
  }
  return parts.join('\n\n')
}

/** Bloco de estilo pros ganchos (texto da tela nos primeiros segundos). */
export function hookStyleBlock(game: string | null): string {
  const s = getSettings().style
  const hooks = listExamples()
    .filter((e) => e.kind === 'hook')
    .slice(-10)
    .reverse()
  const parts: string[] = []
  if (game) parts.push(`Jogo da live: ${game}.`)
  if (s.notes.trim()) parts.push(`Como o Felipe escreve:\n${s.notes.trim()}`)
  if (s.avoid.trim()) parts.push(`Nunca use: ${s.avoid.trim()}`)
  if (hooks.length) parts.push(`Ganchos que o Felipe já usou (copie o tom e o tamanho, não o conteúdo):\n${bullets(hooks.map((h) => h.text))}`)
  return parts.join('\n\n')
}
