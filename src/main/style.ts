// "Meu jeito de escrever": exemplos reais do streamer (cadastrados à mão ou aprendidos do
// que ele posta depois de editar) que vão pro prompt, pra IA escrever como ele em vez de
// soar genérica.

import { randomUUID } from 'node:crypto'
import { normalizeTerm } from '@shared/subtitles'
import { hookTextFor } from '@shared/text'
import { NETWORKS, type Clip, type Network, type StyleExample } from '@shared/types'
import { DEFAULT_PROFILE_ID } from '@shared/defaults'
import { projectsRepo, settingsRepo } from './db'
import { getProfile, secretKey } from './profiles'
import { activeProfileId, getSettings } from './settings'

const KEY = 'styleExamples'
const MAX = 400

/** Exemplos de um perfil (cada canal tem o seu jeito de escrever). */
export function listExamples(profileId: string = activeProfileId()): StyleExample[] {
  return settingsRepo.get<StyleExample[]>(secretKey(KEY, profileId)) ?? []
}

function save(list: StyleExample[], profileId: string): StyleExample[] {
  const trimmed = list.slice(-MAX)
  settingsRepo.set(secretKey(KEY, profileId), trimmed)
  return trimmed
}

/** Quem escreve, no prompt: o Felipe no perfil dele, "o canal" nos outros. */
function writer(profileId: string): string {
  return profileId === DEFAULT_PROFILE_ID ? 'o Felipe' : 'o canal'
}

function sameText(a: string, b: string): boolean {
  return normalizeTerm(a) === normalizeTerm(b)
}

export function addExample(ex: Omit<StyleExample, 'id' | 'createdAt'>, profileId: string = activeProfileId()): StyleExample[] {
  const text = ex.text.trim()
  if (!text) return listExamples(profileId)
  // o mesmo texto não entra duas vezes (o mais novo fica)
  const rest = listExamples(profileId).filter((e) => !(e.kind === ex.kind && e.network === ex.network && sameText(e.text, text)))
  return save([...rest, { ...ex, text, id: randomUUID().slice(0, 10), createdAt: new Date().toISOString() }], profileId)
}

export function removeExample(id: string, profileId: string = activeProfileId()): StyleExample[] {
  return save(
    listExamples(profileId).filter((e) => e.id !== id),
    profileId
  )
}

/**
 * Guarda como exemplo o que foi de fato usado (agendado/postado/baixado): legenda de cada
 * rede e o gancho do vídeo. Só se o "aprender com o que eu posto" estiver ligado.
 */
export function learnFromClip(c: Clip, networks: Network[] = NETWORKS.slice()): void {
  const pid = projectsRepo.get(c.projectId)?.profileId ?? DEFAULT_PROFILE_ID
  const s = getSettings(pid)
  if (!s.style.learn) return
  for (const n of networks) {
    const cap = c.captions?.[n]
    if (cap?.text.trim()) {
      addExample({ kind: 'caption', network: n, text: cap.text, title: cap.title, hashtags: cap.hashtags, source: 'posted' }, pid)
    }
  }
  const hook = hookTextFor(c, s.text)
  if (hook) addExample({ kind: 'hook', network: null, text: hook, hashtags: [], source: 'posted' }, pid)
}

function bullets(list: string[]): string {
  return list.map((t) => `- ${t.replace(/\s*\n\s*/g, ' / ')}`).join('\n')
}

/** Bloco de estilo pro prompt das legendas das redes. */
export function captionStyleBlock(profileId: string, game: string | null): string {
  const s = getSettings(profileId).style
  const ex = listExamples(profileId).filter((e) => e.kind === 'caption')
  const who = writer(profileId)
  const gameplay = getProfile(profileId).kind === 'gameplay'
  const parts: string[] = []
  if (game) {
    parts.push(
      gameplay
        ? `Jogo da live: ${game}. Use esse nome nas hashtags e na legenda quando fizer sentido; não cite outro jogo.`
        : `Assunto do vídeo: ${game}. Use nas hashtags e na legenda quando fizer sentido.`
    )
  } else if (gameplay) parts.push('O jogo da live não foi informado: não chute o nome do jogo nem use hashtag de jogo específico.')
  if (s.notes.trim()) parts.push(`Como ${who} escreve (siga isto):\n${s.notes.trim()}`)
  if (s.avoid.trim()) parts.push(`Nunca use estas palavras/expressões: ${s.avoid.trim()}`)
  for (const n of NETWORKS) {
    // os mais recentes primeiro; os da própria rede valem mais que os gerais
    const mine = [...ex.filter((e) => e.network === n), ...ex.filter((e) => e.network === null)].slice(-6).reverse()
    if (mine.length === 0) continue
    const label = { instagram: 'Instagram', tiktok: 'TikTok', youtube: 'YouTube Shorts' }[n]
    parts.push(
      `Legendas reais que ${who} já usou no ${label} (copie o tom, o tamanho e o jeito, não o conteúdo):\n${bullets(
        mine.map((e) => [e.title ? `Título: ${e.title}` : '', e.text, e.hashtags.length ? e.hashtags.join(' ') : ''].filter(Boolean).join(' | '))
      )}`
    )
  }
  return parts.join('\n\n')
}

/** Bloco de estilo pros ganchos (texto da tela nos primeiros segundos). */
export function hookStyleBlock(profileId: string, game: string | null): string {
  const s = getSettings(profileId).style
  const hooks = listExamples(profileId)
    .filter((e) => e.kind === 'hook')
    .slice(-10)
    .reverse()
  const who = writer(profileId)
  const parts: string[] = []
  if (game) parts.push(`${getProfile(profileId).kind === 'gameplay' ? 'Jogo da live' : 'Assunto do vídeo'}: ${game}.`)
  if (s.notes.trim()) parts.push(`Como ${who} escreve:\n${s.notes.trim()}`)
  if (s.avoid.trim()) parts.push(`Nunca use: ${s.avoid.trim()}`)
  if (hooks.length) parts.push(`Ganchos que ${who} já usou (copie o tom e o tamanho, não o conteúdo):\n${bullets(hooks.map((h) => h.text))}`)
  return parts.join('\n\n')
}
