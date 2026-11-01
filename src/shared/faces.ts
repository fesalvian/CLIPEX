// Câmera seguindo quem fala (layout 'face'): a partir dos rostos detectados em cada quadro,
// escolhe pra onde o recorte 9:16 olha e transforma isso em "planos" parados, com corte seco
// entre eles (como um editor faria), em vez de uma câmera tremendo atrás de cada movimento.

import type { Cut, FaceShot, FaceTrack } from './types'

/** Rosto num quadro, normalizado (0..1). `motion`: quanto a boca/queixo mexeu desde o quadro anterior. */
export interface FaceBox {
  x: number
  y: number
  w: number
  h: number
  score: number
  motion: number
}

export interface FaceFrame {
  /** tempo na fonte (s) */
  t: number
  faces: FaceBox[]
  /** mudou de câmera entre o quadro anterior e este */
  cut: boolean
}

/** Largura do recorte 9:16 em fração da largura da fonte (16:9 → 0,316). */
export function cropFraction(srcW: number, srcH: number): number {
  return Math.min(1, (srcH * 9) / 16 / Math.max(1, srcW))
}

function center(f: FaceBox): number {
  return f.x + f.w / 2
}

/**
 * Pra onde olhar em cada quadro: sem rosto, onde estava; rostos que cabem juntos no recorte,
 * o meio do grupo; senão, quem está mexendo a boca nos quadros vizinhos (quem fala), e na
 * dúvida o maior rosto.
 */
export function targets(frames: FaceFrame[], crop: number, window = 3): (number | null)[] {
  return frames.map((fr, i) => {
    const faces = fr.faces.filter((f) => f.w * f.h > 0.0004)
    if (faces.length === 0) return null
    if (faces.length === 1) return center(faces[0]!)
    const left = Math.min(...faces.map((f) => f.x))
    const right = Math.max(...faces.map((f) => f.x + f.w))
    if (right - left <= crop * 0.9) return (left + right) / 2
    // fala: soma do movimento do rosto mais perto (mesma pessoa) nos quadros em volta, sem atravessar troca de câmera
    let best: FaceBox | null = null
    let bestTalk = -1
    for (const f of faces) {
      let talk = f.motion
      for (const dir of [-1, 1]) {
        for (let k = 1; k <= window; k++) {
          const j = i + dir * k
          const other = frames[j]
          if (!other) break
          if ((dir < 0 && frames[j + 1]!.cut) || (dir > 0 && other.cut)) break
          const near = nearest(other.faces, center(f))
          if (near && Math.abs(center(near) - center(f)) < 0.08) talk += near.motion
        }
      }
      if (talk > bestTalk + 1e-6 || (Math.abs(talk - bestTalk) <= 1e-6 && best && f.w * f.h > best.w * best.h)) {
        best = f
        bestTalk = talk
      }
    }
    // ninguém mexendo a boca: o maior rosto
    if (bestTalk <= 0.002) best = faces.reduce((a, b) => (b.w * b.h > a.w * a.h ? b : a))
    return center(best!)
  })
}

function nearest(faces: FaceBox[], x: number): FaceBox | null {
  let best: FaceBox | null = null
  for (const f of faces) if (!best || Math.abs(center(f) - x) < Math.abs(center(best) - x)) best = f
  return best
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]!
}

export interface ShotOptions {
  /** quanto o alvo precisa andar pra virar outro plano (fração da largura) */
  moveMin?: number
  /** por quanto tempo o alvo novo precisa se manter (s) */
  hold?: number
  /** duração mínima de um plano (s) */
  minShot?: number
}

/**
 * Planos parados: o recorte só muda quando o alvo anda bastante e fica lá por um tempo
 * (ou quando a própria fonte troca de câmera). Cada plano olha pra mediana do alvo.
 */
export function buildShots(frames: FaceFrame[], tg: (number | null)[], crop: number, from: number, to: number, o: ShotOptions = {}): FaceShot[] {
  const moveMin = o.moveMin ?? 0.07
  const hold = o.hold ?? 0.6
  const minShot = o.minShot ?? 1.2
  const half = crop / 2
  const clampX = (x: number): number => Math.max(half, Math.min(1 - half, x))
  // sem rosto: segura o último alvo (no começo, o primeiro que aparecer; nada, o centro)
  const firstSeen = tg.find((x) => x !== null) ?? 0.5
  let last = firstSeen
  const xs = tg.map((x) => (x === null ? last : (last = x)))
  if (frames.length === 0) return [{ s: from, e: to, x: clampX(0.5) }]

  const shots: { s: number; xs: number[] }[] = [{ s: from, xs: [xs[0]!] }]
  let pendingAt: number | null = null
  for (let i = 1; i < frames.length; i++) {
    const cur = shots[shots.length - 1]!
    const ref = median(cur.xs)
    const t = frames[i]!.t
    const far = Math.abs(xs[i]! - ref) > moveMin
    if (frames[i]!.cut && far && t - cur.s >= 0.4) {
      shots.push({ s: t, xs: [xs[i]!] })
      pendingAt = null
      continue
    }
    if (!far) {
      pendingAt = null
      cur.xs.push(xs[i]!)
      continue
    }
    pendingAt ??= t
    if (t - pendingAt >= hold && pendingAt - cur.s >= minShot) {
      // o plano novo começa quando o alvo mudou de lugar
      const k = frames.findIndex((f) => f.t >= pendingAt!)
      shots.push({ s: pendingAt, xs: xs.slice(k, i + 1) })
      pendingAt = null
    }
  }
  return shots.map((sh, i) => ({
    s: round2(sh.s),
    e: round2(i + 1 < shots.length ? shots[i + 1]!.s : to),
    x: round3(clampX(median(sh.xs)))
  }))
}

/** Centro do recorte num instante (tempo na fonte). */
export function faceXAt(track: FaceTrack | null, t: number): number {
  if (!track || track.shots.length === 0) return 0.5
  const shot = track.shots.find((s) => t >= s.s && t < s.e)
  if (shot) return shot.x
  return t < track.shots[0]!.s ? track.shots[0]!.x : track.shots[track.shots.length - 1]!.x
}

/** A câmera calculada cobre o corte inteiro. */
export function trackCovers(track: FaceTrack | null, cuts: Cut[]): boolean {
  if (!track || cuts.length === 0) return false
  return cuts[0]!.s >= track.from - 0.5 && cuts[cuts.length - 1]!.e <= track.to + 0.5
}

/**
 * Expressão do `x` do crop do ffmpeg no tempo do vídeo final (os trechos colados): um valor
 * por plano, com corte seco. `cropW`/`srcW` em pixels.
 */
export function faceCropExpr(track: FaceTrack | null, cuts: Cut[], srcW: number, cropW: number, offset = 0): string {
  const px = (x: number): number => Math.round(Math.max(0, Math.min(srcW - cropW, x * srcW - cropW / 2)) + offset)
  if (!track || track.shots.length === 0) return String(px(0.5))
  // pontos de troca em tempo de saída
  const steps: { at: number; x: number }[] = []
  let acc = 0
  for (const k of cuts) {
    for (const sh of track.shots) {
      const a = Math.max(k.s, sh.s)
      const b = Math.min(k.e, sh.e)
      if (b - a <= 0.01) continue
      steps.push({ at: acc + (a - k.s), x: px(sh.x) })
    }
    acc += k.e - k.s
  }
  if (steps.length === 0) return String(px(faceXAt(track, cuts[0]?.s ?? 0)))
  // planos vizinhos iguais viram um só
  const merged = steps.filter((st, i) => i === 0 || st.x !== steps[i - 1]!.x)
  let expr = String(merged[merged.length - 1]!.x)
  for (let i = merged.length - 2; i >= 0; i--) expr = `if(lt(t,${round2(merged[i + 1]!.at)}),${merged[i]!.x},${expr})`
  return expr
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000
}
