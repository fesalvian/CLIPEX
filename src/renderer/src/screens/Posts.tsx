import { useEffect, useMemo, useState } from 'react'
import type { PostOverviewItem } from '@shared/ipc'
import type { Network } from '@shared/types'
import { call, errorText, useApiEvent } from '../api'
import { AppHeader } from '../components/AppHeader'
import { Icon } from '../components/Icon'
import { TidyQueue } from '../components/TidyQueue'
import { postState, type PostTone } from '../lib/posts'
import { useStore } from '../store'

type Filter = 'queue' | 'sent' | 'failed' | 'all'

const FILTERS: { key: Filter; label: string }[] = [
  { key: 'queue', label: 'Na fila' },
  { key: 'sent', label: 'Enviados' },
  { key: 'failed', label: 'Falhas' },
  { key: 'all', label: 'Todos' }
]

const NET_LABEL: Record<Network, string> = { instagram: 'Reels', tiktok: 'TikTok', youtube: 'Shorts' }
const TONE_COLOR: Record<PostTone, string> = { ok: '#A7F3D0', busy: '#93C5FD', error: '#FF8A8A', muted: 'var(--muted)' }

function inFilter(it: PostOverviewItem, f: Filter): boolean {
  const s = it.post.status
  if (f === 'queue') return s === 'scheduled' || s === 'uploading'
  if (f === 'sent') return s === 'posted' || s === 'draft'
  if (f === 'failed') return s === 'failed'
  return true
}

/** Data que ordena e agrupa: a do agendamento, ou a do envio. */
function whenOf(it: PostOverviewItem): number {
  const iso = it.post.status === 'posted' && it.post.postedAt ? it.post.postedAt : (it.post.scheduledAt ?? it.post.createdAt)
  return new Date(iso).getTime()
}

function dayLabel(t: number): string {
  const d = new Date(t)
  const today = new Date()
  const diff = Math.round((new Date(d).setHours(0, 0, 0, 0) - new Date(today).setHours(0, 0, 0, 0)) / 86_400_000)
  const base = d.toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: '2-digit' })
  return diff === 0 ? `Hoje · ${base}` : diff === 1 ? `Amanhã · ${base}` : diff === -1 ? `Ontem · ${base}` : base
}

/** Todos os posts de todas as lives: o que está na fila, o que já foi e o que falhou. */
export function Posts() {
  const toast = useStore((s) => s.toast)
  const [items, setItems] = useState<PostOverviewItem[] | null>(null)
  const [filter, setFilter] = useState<Filter>('queue')
  const [confirmCancel, setConfirmCancel] = useState<string | null>(null)
  const [now, setNow] = useState(Date.now())
  const [tidyOpen, setTidyOpen] = useState(false)

  const load = (): void => {
    void call('posts:overview').then(setItems)
  }
  useEffect(load, [])
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(t)
  }, [])
  useApiEvent('post:updated', (p) => {
    setItems((cur) => {
      if (!cur) return cur
      if (!cur.some((it) => it.post.id === p.id)) {
        // post novo (agendado em outra tela): busca de novo pra ter o nome do corte
        load()
        return cur
      }
      return cur.map((it) => (it.post.id === p.id ? { ...it, post: p } : it))
    })
  })

  const counts = useMemo(() => {
    const c: Record<Filter, number> = { queue: 0, sent: 0, failed: 0, all: 0 }
    for (const it of items ?? []) for (const f of FILTERS) if (inFilter(it, f.key)) c[f.key]++
    return c
  }, [items])

  const groups = useMemo(() => {
    const list = (items ?? []).filter((it) => inFilter(it, filter))
    // fila: o próximo primeiro; o resto: o mais recente primeiro
    list.sort((a, b) => (filter === 'queue' ? whenOf(a) - whenOf(b) : whenOf(b) - whenOf(a)))
    const out: { label: string; items: PostOverviewItem[] }[] = []
    for (const it of list) {
      const label = dayLabel(whenOf(it))
      const g = out[out.length - 1]
      if (g?.label === label) g.items.push(it)
      else out.push({ label, items: [it] })
    }
    return out
  }, [items, filter])

  const act = async (kind: 'cancel' | 'retry', id: string): Promise<void> => {
    setConfirmCancel(null)
    try {
      await call(kind === 'cancel' ? 'posts:cancel' : 'posts:retry', id)
      toast('info', kind === 'cancel' ? 'Post cancelado.' : 'Enviando de novo.')
    } catch (e) {
      toast('error', errorText(e))
    }
  }

  return (
    <>
      <AppHeader title="Agendados" subtitle="posts de todas as lives" />
      <main className="screen posts">
        <div className="posts-bar">
          <div className="seg compact" role="tablist" aria-label="Filtrar posts">
            {FILTERS.map((f) => (
              <button key={f.key} role="tab" aria-selected={filter === f.key} onClick={() => setFilter(f.key)}>
                {f.label} <span className="mono muted">{counts[f.key]}</span>
              </button>
            ))}
          </div>
          <button className="btn sm" disabled={counts.queue === 0} onClick={() => setTidyOpen(true)}>
            <Icon name="clock" size={14} /> Organizar fila
          </button>
        </div>

        {items === null ? (
          <div className="empty">
            <span className="spinner" />
          </div>
        ) : groups.length === 0 ? (
          <div className="empty">
            <Icon name="clock" size={28} color="#A78BFA" />
            <span>
              {filter === 'queue'
                ? 'Nada na fila. Agende os cortes em "Revisar e postar".'
                : filter === 'failed'
                  ? 'Nenhuma falha.'
                  : 'Nenhum post aqui ainda.'}
            </span>
          </div>
        ) : (
          groups.map((g) => (
            <section key={g.label} className="posts-day" aria-label={g.label}>
              <span className="label">{g.label}</span>
              {g.items.map((it) => {
                const p = it.post
                const st = postState(p, it.render, now)
                const canCancel = !p.remoteId && (p.status === 'scheduled' || p.status === 'failed')
                const time = new Date(whenOf(it)).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
                return (
                  <div key={p.id} className="post-row">
                    <span className="mono post-time">{time}</span>
                    <span className="chip violet post-net">{NET_LABEL[p.network]}</span>
                    <span className="post-names">
                      <span className="post-clip">{it.clipName}</span>
                      <span className="post-project">{it.projectName}</span>
                    </span>
                    <span className="post-state" style={{ color: TONE_COLOR[st.tone] }}>
                      {st.pending && <span className="spinner" style={{ width: 9, height: 9 }} />}
                      {st.label}
                    </span>
                    <span className="post-actions">
                      {p.status === 'failed' && (
                        <button className="btn sm" onClick={() => void act('retry', p.id)}>
                          <Icon name="refresh" size={14} /> Tentar de novo
                        </button>
                      )}
                      {canCancel &&
                        (confirmCancel === p.id ? (
                          <button className="btn sm danger" onClick={() => void act('cancel', p.id)}>
                            Confirmar
                          </button>
                        ) : (
                          <button className="btn sm" onClick={() => setConfirmCancel(p.id)}>
                            <Icon name="x" size={14} /> Cancelar
                          </button>
                        ))}
                      {p.remoteId && p.status === 'scheduled' && <span className="hint">cancele no YouTube Studio</span>}
                    </span>
                  </div>
                )
              })}
            </section>
          ))
        )}
      </main>
      {tidyOpen && (
        <TidyQueue
          onClose={() => {
            setTidyOpen(false)
            load()
          }}
        />
      )}
    </>
  )
}
