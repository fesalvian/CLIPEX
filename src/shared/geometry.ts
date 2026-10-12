import { OUT_H, OUT_W } from './consts'
import type { CamSplit, ClipLayout, Rect } from './types'

export interface PixelRect {
  x: number
  y: number
  w: number
  h: number
}

export interface Pane {
  kind: 'cam' | 'game'
  /** posição no vídeo final */
  out: PixelRect
}

function even(n: number): number {
  return Math.max(2, Math.round(n / 2) * 2)
}

/** Como o 1080×1920 é dividido entre webcam e jogo. */
export function layoutPanes(layout: ClipLayout, split: CamSplit, outW = OUT_W, outH = OUT_H): Pane[] {
  if (layout === 'game') return [{ kind: 'game', out: { x: 0, y: 0, w: outW, h: outH } }]
  if (layout === 'cam') return [{ kind: 'cam', out: { x: 0, y: 0, w: outW, h: outH } }]
  const camH = even((outH * split) / 100)
  return [
    { kind: 'cam', out: { x: 0, y: 0, w: outW, h: camH } },
    { kind: 'game', out: { x: 0, y: camH, w: outW, h: outH - camH } }
  ]
}

/**
 * Recorte efetivo, em pixels da fonte, de um retângulo normalizado preenchendo um painel
 * de proporção `targetAspect` (largura/altura). Mantém o centro do retângulo escolhido e
 * corta o excesso (equivalente a `object-fit: cover`). O resultado tem a proporção exata
 * do painel, então o render e o preview usam a mesma conta.
 */
export function coverCrop(rect: Rect, srcW: number, srcH: number, targetAspect: number): PixelRect {
  const rx = clamp01(rect.x) * srcW
  const ry = clamp01(rect.y) * srcH
  const rw = Math.max(2, Math.min(srcW - rx, rect.w * srcW))
  const rh = Math.max(2, Math.min(srcH - ry, rect.h * srcH))
  let w = rw
  let h = rh
  if (rw / rh > targetAspect) w = rh * targetAspect
  else h = rw / targetAspect
  const cx = rx + rw / 2
  const cy = ry + rh / 2
  let x = cx - w / 2
  let y = cy - h / 2
  x = Math.max(0, Math.min(srcW - w, x))
  y = Math.max(0, Math.min(srcH - h, y))
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) }
}

/** Recorte "zoom" centralizado dentro de outro recorte (punch-in). */
export function zoomCrop(crop: PixelRect, factor: number): PixelRect {
  const w = crop.w / factor
  const h = crop.h / factor
  return {
    x: Math.round(crop.x + (crop.w - w) / 2),
    y: Math.round(crop.y + (crop.h - h) / 2),
    w: Math.round(w),
    h: Math.round(h)
  }
}

export function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n))
}

export function clampRect(r: Rect, minSize = 0.04): Rect {
  const w = Math.max(minSize, Math.min(1, r.w))
  const h = Math.max(minSize, Math.min(1, r.h))
  return { x: Math.max(0, Math.min(1 - w, r.x)), y: Math.max(0, Math.min(1 - h, r.y)), w, h }
}

/** Topo da legenda no vídeo final, em fração da altura. */
export function captionAnchor(layout: ClipLayout, split: CamSplit): number {
  return layout === 'both' ? split / 100 : 0.62
}
