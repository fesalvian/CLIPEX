import { useEffect, useMemo, useState } from 'react'
import { applyDictFixes, applyDictionary, buildCues, cueText, findDictFixes, retimeCue } from '@shared/subtitles'
import { fmtDur } from '@shared/time'
import type { Clip, DictEntry, SubtitleCue } from '@shared/types'
import { call } from '../../api'
import { useStore } from '../../store'

interface Props {
  clip: Clip
  dictionary: DictEntry[]
  onSeek: (sec: number) => void
}

function CueRow({
  cue,
  base,
  dictionary,
  onCommit,
  onSeek
}: {
  cue: SubtitleCue
  base: number
  dictionary: DictEntry[]
  onCommit: (c: SubtitleCue) => void
  onSeek: (sec: number) => void
}) {
  const [text, setText] = useState(cueText(cue))
  useEffect(() => setText(cueText(cue)), [cue])
  const fixes = findDictFixes(cue, dictionary)
  const fixed = fixes.length ? cueText(applyDictFixes(cue, fixes)) : null
  const t = fmtDur(cue.start - base)
  return (
    <div className="cue">
      <div className="cue-line">
        <button className="cue-time mono" onClick={() => onSeek(cue.start)} aria-label={`Ir pra ${t}`}>
          {t}
        </button>
        <input
          className={`cue-input${fixes.length ? ' flag' : ''}`}
          value={text}
          aria-label={`Legenda em ${t}`}
          onChange={(e) => setText(e.target.value)}
          onBlur={() => {
            if (text !== cueText(cue)) onCommit(retimeCue(cue, text))
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          }}
        />
      </div>
      {fixed && (
        <span className="cue-fix">
          Pelo dicionário: "{fixed}" ·{' '}
          <button className="link-btn" onClick={() => onCommit(applyDictFixes(cue, fixes))}>
            aplicar
          </button>
        </span>
      )}
    </div>
  )
}

/** Legenda editável trecho a trecho, com as sugestões do dicionário marcadas. */
export function SubtitlePanel({ clip, dictionary, onSeek }: Props) {
  const patchClip = useStore((s) => s.patchClip)
  const upsertClip = useStore((s) => s.upsertClip)
  // mesma regra do main: sem edição, a legenda sai da transcrição já com o dicionário aplicado
  const cues = useMemo(
    () => clip.cues ?? (clip.words ? applyDictionary(buildCues(clip.words, clip.cutIn, clip.cutOut), dictionary) : []),
    [clip, dictionary]
  )
  const flagged = cues.filter((c) => findDictFixes(c, dictionary).length > 0).length

  const commit = (next: SubtitleCue): void => {
    void patchClip(clip.id, { cues: cues.map((c) => (c.id === next.id ? next : c)) })
  }

  return (
    <div className="panel" style={{ gap: 10 }}>
      <div className="panel-head">
        <span className="panel-title">Legenda</span>
        {flagged > 0 && (
          <span style={{ fontSize: 12, color: 'var(--warn)' }}>
            {flagged} {flagged === 1 ? 'trecho' : 'trechos'} pra conferir
          </span>
        )}
      </div>
      {!clip.words && <span className="hint">A legenda aparece quando a transcrição do corte terminar.</span>}
      {clip.words && cues.length === 0 && <span className="hint">Ninguém fala nesse trecho.</span>}
      <div className="cues">
        {cues.map((c) => (
          <CueRow key={`${clip.id}-${c.id}`} cue={c} base={clip.cutIn} dictionary={dictionary} onCommit={commit} onSeek={onSeek} />
        ))}
      </div>
      {clip.cues && (
        <button
          className="btn xs ghost"
          style={{ alignSelf: 'flex-start' }}
          onClick={() => void call('clips:reset-cues', clip.id).then(upsertClip)}
          title="Descarta as edições e refaz a legenda a partir da transcrição"
        >
          Refazer da transcrição
        </button>
      )}
    </div>
  )
}
