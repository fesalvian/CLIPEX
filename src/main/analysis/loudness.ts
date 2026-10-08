// Loudness momentâneo (EBU R128) a cada 100 ms, lido do log do filtro ebur128.

export const LOUDNESS_RATE = 10 // amostras por segundo
export const SILENCE_LUFS = -70

const LINE = /\bt:\s*([\d.]+)\s+.*?\bM:\s*(-?[\d.]+|-?inf|nan)/i

export function parseEbur128Line(line: string): { t: number; m: number } | null {
  const r = LINE.exec(line)
  if (!r) return null
  const t = Number(r[1])
  const raw = r[2]!.toLowerCase()
  const m = raw.includes('inf') || raw === 'nan' ? SILENCE_LUFS : Math.max(SILENCE_LUFS, Number(raw))
  if (!Number.isFinite(t)) return null
  return { t, m: Number.isFinite(m) ? m : SILENCE_LUFS }
}

/** Acumula as leituras numa série fixa de 10 Hz. */
export class LoudnessCollector {
  private values: number[] = []

  push(line: string): void {
    const r = parseEbur128Line(line)
    if (!r) return
    const idx = Math.max(0, Math.round(r.t * LOUDNESS_RATE) - 1)
    while (this.values.length < idx) this.values.push(this.values[this.values.length - 1] ?? SILENCE_LUFS)
    this.values[idx] = r.m
  }

  result(): Float32Array {
    return Float32Array.from(this.values)
  }
}

/**
 * Converte LUFS em 0..1 pra desenhar a waveform: -60 LUFS vira 0, -10 LUFS vira 1.
 * Cada balde pega o máximo do trecho, pra não sumir com os picos.
 */
export function loudnessBuckets(series: Float32Array, from: number, to: number, buckets: number): number[] {
  const out: number[] = []
  const a = Math.max(0, Math.floor(from * LOUDNESS_RATE))
  const b = Math.min(series.length, Math.ceil(to * LOUDNESS_RATE))
  const span = Math.max(1, b - a)
  for (let i = 0; i < buckets; i++) {
    const s = a + Math.floor((i * span) / buckets)
    const e = Math.max(s + 1, a + Math.floor(((i + 1) * span) / buckets))
    let mx = SILENCE_LUFS
    for (let k = s; k < e && k < series.length; k++) mx = Math.max(mx, series[k]!)
    out.push(Math.max(0, Math.min(1, (mx + 60) / 50)))
  }
  return out
}
