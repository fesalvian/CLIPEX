import { useState } from 'react'
import type { DictEntry } from '@shared/types'
import { call } from '../../api'
import { useStore } from '../../store'
import { Modal } from '../Modal'

interface Props {
  dictionary: DictEntry[]
  clipIds: string[]
}

export function DictionaryPanel({ dictionary, clipIds }: Props) {
  const [open, setOpen] = useState(false)
  const shown = dictionary.slice(0, 3)
  const rest = dictionary.length - shown.length
  return (
    <div className="panel" style={{ gap: 10, marginTop: 8, padding: 14 }}>
      <span className="panel-title" style={{ fontSize: 14 }}>
        Dicionário de termos
      </span>
      <span className="hint">Nomes, gírias e termos de jogo que o Whisper costuma errar. Corrige sozinho em todos os cortes.</span>
      <div className="tags">
        {shown.map((d) => (
          <span key={d.term} className="chip mono">
            {d.term}
          </span>
        ))}
        {rest > 0 && <span className="chip mono">+{rest}</span>}
      </div>
      <button className="btn sm" onClick={() => setOpen(true)}>
        Editar dicionário
      </button>
      {open && <DictionaryModal dictionary={dictionary} clipIds={clipIds} onClose={() => setOpen(false)} />}
    </div>
  )
}

function DictionaryModal({ dictionary, clipIds, onClose }: Props & { onClose: () => void }) {
  const updateSettings = useStore((s) => s.updateSettings)
  const upsertClip = useStore((s) => s.upsertClip)
  const toast = useStore((s) => s.toast)
  const [rows, setRows] = useState(dictionary.map((d) => ({ term: d.term, variants: d.variants.join(', ') })))

  const save = async (apply: boolean): Promise<void> => {
    const dict: DictEntry[] = rows
      .map((r) => ({ term: r.term.trim(), variants: r.variants.split(',').map((v) => v.trim()).filter(Boolean) }))
      .filter((r) => r.term)
    await updateSettings({ dictionary: dict })
    if (apply) {
      for (const id of clipIds) upsertClip(await call('clips:apply-dictionary', id))
      toast('success', `Dicionário aplicado em ${clipIds.length} cortes.`)
    }
    onClose()
  }

  return (
    <Modal
      title="Dicionário de termos"
      onClose={onClose}
      wide
      actions={
        <>
          <button className="btn" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn" onClick={() => void save(false)}>
            Salvar
          </button>
          <button className="btn primary" onClick={() => void save(true)}>
            Salvar e aplicar em todos os cortes
          </button>
        </>
      }
    >
      <span className="hint">
        Escreva o termo certo e, separado por vírgula, como o Whisper costuma errar. Os termos também viram dica pro Whisper na próxima transcrição.
      </span>
      <div className="dict-rows">
        <span className="label">Termo certo</span>
        <span className="label">Como sai errado (separe por vírgula)</span>
        <span />
        {rows.map((r, i) => (
          <div key={i} style={{ display: 'contents' }}>
            <input
              className="input mono"
              value={r.term}
              aria-label="Termo certo"
              onChange={(e) => setRows(rows.map((x, k) => (k === i ? { ...x, term: e.target.value } : x)))}
            />
            <input
              className="input"
              value={r.variants}
              aria-label="Grafias erradas"
              onChange={(e) => setRows(rows.map((x, k) => (k === i ? { ...x, variants: e.target.value } : x)))}
            />
            <button className="btn icon-btn ghost" aria-label={`Remover ${r.term}`} onClick={() => setRows(rows.filter((_, k) => k !== i))}>
              ×
            </button>
          </div>
        ))}
      </div>
      <button className="btn sm" style={{ alignSelf: 'flex-start' }} onClick={() => setRows([...rows, { term: '', variants: '' }])}>
        + termo
      </button>
    </Modal>
  )
}
