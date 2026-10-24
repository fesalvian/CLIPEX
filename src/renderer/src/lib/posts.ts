// Estado de um post em palavras, igual no modal de resultado e na tela de agendados.

import type { ClipRender, Post } from '@shared/types'

export type PostTone = 'ok' | 'busy' | 'error' | 'muted'

export interface PostState {
  tone: PostTone
  label: string
  /** ainda vai mudar sozinho (enviando, na fila, renderizando) */
  pending: boolean
}

export function fmtWhen(iso: string | null): string {
  if (!iso) return 'agora'
  return new Date(iso).toLocaleString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
}

export function postState(p: Post, render: Pick<ClipRender, 'status' | 'error'> | null, now = Date.now()): PostState {
  if (p.status === 'failed') return { tone: 'error', label: p.error?.split('\n')[0] ?? 'Falhou', pending: false }
  if (p.status === 'canceled') return { tone: 'muted', label: 'Cancelado', pending: false }
  if (p.status === 'uploading') return { tone: 'busy', label: 'Enviando…', pending: true }
  if (p.status === 'posted') return { tone: 'ok', label: p.note ? `Publicado (${p.note})` : 'Publicado', pending: false }
  if (p.status === 'draft') return { tone: 'ok', label: 'Rascunho no TikTok: publique pelo app', pending: false }
  // agendado
  if (p.remoteId) return { tone: 'ok', label: `Agendado no YouTube pra ${fmtWhen(p.scheduledAt)}`, pending: false }
  if (render?.status === 'error') return { tone: 'error', label: `Render falhou: ${render.error?.split('\n')[0] ?? ''}`, pending: false }
  const due = !p.scheduledAt || new Date(p.scheduledAt).getTime() <= now + 60_000
  if (due || p.network === 'youtube') {
    const rendering = render?.status === 'queued' || render?.status === 'rendering'
    return { tone: 'busy', label: rendering ? 'Renderizando…' : 'Na fila de envio', pending: true }
  }
  return { tone: 'ok', label: `Agendado pra ${fmtWhen(p.scheduledAt)}`, pending: false }
}
