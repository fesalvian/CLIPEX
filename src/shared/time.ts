function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

/** 4363.2 → "01:12:43" */
export function fmtClock(sec: number): string {
  const s = Math.max(0, Math.floor(sec))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return `${pad2(h)}:${pad2(m)}:${pad2(s % 60)}`
}

/** 38.4 → "00:38" (minutos:segundos) */
export function fmtDur(sec: number): string {
  const s = Math.max(0, Math.round(sec))
  return `${pad2(Math.floor(s / 60))}:${pad2(s % 60)}`
}

/** 154 → "2min 34s" */
export function fmtTotal(sec: number): string {
  const s = Math.max(0, Math.round(sec))
  return `${Math.floor(s / 60)}min ${pad2(s % 60)}s`
}

/** 18720 → "5h12m" */
export function fmtLong(sec: number): string {
  const s = Math.max(0, Math.round(sec))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return h > 0 ? `${h}h${pad2(m)}m` : `${m}min`
}

/**
 * Data da live a partir do nome do arquivo do OBS: `live_AAAA-MM-DD_hh-mm.mkv`.
 * Aceita também o padrão do OBS (`2026-10-07 21-03-11.mkv`).
 */
export function parseLiveDate(fileName: string): { date: string; time: string | null } | null {
  const m = /(\d{4})-(\d{2})-(\d{2})(?:[ _T](\d{2})-(\d{2}))?/.exec(fileName)
  if (!m) return null
  const [, y, mo, d, hh, mm] = m
  const month = Number(mo)
  const day = Number(d)
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  return { date: `${y}-${mo}-${d}`, time: hh && mm ? `${hh}:${mm}` : null }
}

/** "2026-10-07" → "Live de 07/10" */
export function projectNameFromDate(date: string | null, fallback: string): string {
  if (!date) return fallback
  const [, mo, d] = date.split('-')
  return `Live de ${d}/${mo}`
}
