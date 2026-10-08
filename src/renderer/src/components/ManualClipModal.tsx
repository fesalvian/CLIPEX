import { useEffect, useRef, useState } from 'react'
import { fmtClock } from '@shared/time'
import type { Clip, Project } from '@shared/types'
import { call, errorText } from '../api'
import { clipList, useStore } from '../store'
import { Modal } from './Modal'

interface Props {
  project: Project
  onClose: () => void
  onCreated: (c: Clip) => void
}

function parseClock(s: string): number | null {
  const parts = s.trim().split(':').map(Number)
  if (parts.some((n) => !Number.isFinite(n))) return null
  return parts.reduce((acc, n) => acc * 60 + n, 0)
}

/** Escolhe um ponto da live (pela linha do tempo de volume ou digitando o horário). */
export function ManualClipModal({ project, onClose, onCreated }: Props) {
  const duration = project.source?.durationSec ?? 0
  const clips = clipList(useStore((s) => s.clips))
  const upsertClip = useStore((s) => s.upsertClip)
  const toast = useStore((s) => s.toast)
  const [wave, setWave] = useState<number[]>([])
  const [at, setAt] = useState(duration / 2)
  const [text, setText] = useState(fmtClock(duration / 2))
  const [busy, setBusy] = useState(false)
  const ref = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    void call('clips:loudness', project.id, 0, duration, 360).then((r) => setWave(r.values))
  }, [project.id, duration])

  const pick = (clientX: number): void => {
    const r = ref.current!.getBoundingClientRect()
    const t = Math.round(Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * duration)
    setAt(t)
    setText(fmtClock(t))
  }

  const create = async (): Promise<void> => {
    setBusy(true)
    try {
      const c = await call('clips:create-manual', project.id, at)
      upsertClip(c)
      onCreated(c)
      toast('success', 'Corte manual criado. Transcrição e preview a caminho.')
    } catch (e) {
      toast('error', errorText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title="Adicionar corte manual"
      onClose={onClose}
      wide
      actions={
        <>
          <button className="btn" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn primary" disabled={busy} onClick={() => void create()}>
            Criar corte em {fmtClock(at)}
          </button>
        </>
      }
    >
      <span className="hint">Clique na linha do tempo da live inteira (volume do microfone) ou digite o horário. O corte começa 15 s antes e termina 15 s depois; dá pra ajustar nas alças.</span>
      <div ref={ref} className="overview" onClick={(e) => pick(e.clientX)}>
        <div className="overview-bars">
          {wave.map((v, i) => (
            <span key={i} style={{ height: `${Math.round(4 + v * 70)}px` }} />
          ))}
        </div>
        {clips.map((c) => (
          <i key={c.id} className="overview-clip" style={{ left: `${(c.peakSec / Math.max(1, duration)) * 100}%` }} title={fmtClock(c.peakSec)} />
        ))}
        <div className="overview-cursor" style={{ left: `${(at / Math.max(1, duration)) * 100}%` }} />
      </div>
      <div className="mono" style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--muted-2)' }}>
        <span>00:00:00</span>
        <span>{fmtClock(duration)}</span>
      </div>
      <label className="field" style={{ maxWidth: 220 }}>
        Horário na live
        <input
          className="input mono"
          value={text}
          onChange={(e) => {
            setText(e.target.value)
            const t = parseClock(e.target.value)
            if (t !== null) setAt(Math.max(0, Math.min(duration, t)))
          }}
        />
      </label>
    </Modal>
  )
}
