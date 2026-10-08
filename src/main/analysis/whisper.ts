import { readFileSync, rmSync } from 'node:fs'
import { normalizeTerm } from '@shared/subtitles'
import type { Word } from '@shared/types'
import { runProcess, type RunHandle } from '../proc'

interface WhisperSegment {
  offsets: { from: number; to: number }
  text: string
}

/** Frases que o Whisper inventa em silêncio/música (alucinações comuns em PT). */
const HALLUCINATIONS = [
  'legendas pela comunidade amaraorg',
  'legenda adriana zanotto',
  'obrigado por assistir',
  'inscrevase no canal',
  'legendas pela comunidade',
  'amaraorg'
]

export function stripHallucinations(words: Word[]): Word[] {
  const norm = words.map((w) => normalizeTerm(w.w).replace(/\s/g, ''))
  const drop = new Set<number>()
  for (const phrase of HALLUCINATIONS) {
    const target = phrase.replace(/\s/g, '')
    for (let i = 0; i < norm.length; i++) {
      let acc = ''
      for (let k = i; k < norm.length && acc.length < target.length; k++) {
        acc += norm[k]
        if (acc === target) {
          for (let x = i; x <= k; x++) drop.add(x)
          break
        }
        if (!target.startsWith(acc)) break
      }
    }
  }
  return words.filter((_, i) => !drop.has(i))
}

/** Converte o JSON do whisper-cli (`-ml 1 -sow -oj`) em palavras com tempo absoluto. */
export function parseWhisperJson(json: unknown, offsetSec: number): Word[] {
  const segs = (json as { transcription?: WhisperSegment[] }).transcription ?? []
  const words: Word[] = []
  for (const seg of segs) {
    const w = seg.text.trim()
    if (!w) continue
    const s = offsetSec + seg.offsets.from / 1000
    const e = offsetSec + Math.max(seg.offsets.to, seg.offsets.from + 50) / 1000
    words.push({ w, s: Math.round(s * 1000) / 1000, e: Math.round(e * 1000) / 1000 })
  }
  return stripHallucinations(words)
}

export interface WhisperJob {
  exe: string
  model: string
  wav: string
  /** caminho de saída sem extensão */
  outBase: string
  offsetSec: number
  prompt: string
  useGpu: boolean
}

export function dtwPreset(model: string): string | null {
  const m = model.toLowerCase()
  if (m.includes('large-v3-turbo')) return 'large.v3.turbo'
  if (m.includes('large-v3')) return 'large.v3'
  if (m.includes('large-v2')) return 'large.v2'
  if (m.includes('medium')) return m.includes('.en') ? 'medium.en' : 'medium'
  if (m.includes('small')) return 'small'
  if (m.includes('base')) return 'base'
  return null
}

export function whisperArgs(j: WhisperJob): string[] {
  const args = ['-m', j.model, '-f', j.wav, '-l', 'pt', '-ml', '1', '-sow', '-oj', '-of', j.outBase, '-np', '-pp']
  if (j.prompt) args.push('--prompt', j.prompt)
  const dtw = dtwPreset(j.model)
  // DTW dá tempos de palavra bem melhores; não funciona junto com flash attention.
  if (dtw) args.push('-dtw', dtw, '-nfa')
  if (!j.useGpu) args.push('-ng')
  return args
}

export function transcribe(j: WhisperJob, onProgress?: (p: number) => void): RunHandle<Word[]> {
  const handle = runProcess(j.exe, whisperArgs(j), {
    onStderrLine: (line) => {
      const m = /progress\s*=\s*(\d+)%/.exec(line)
      if (m && onProgress) onProgress(Number(m[1]) / 100)
    }
  })
  return {
    cancel: handle.cancel,
    done: handle.done.then(() => {
      const path = `${j.outBase}.json`
      const words = parseWhisperJson(JSON.parse(readFileSync(path, 'utf8')), j.offsetSec)
      rmSync(path, { force: true })
      return words
    })
  }
}
