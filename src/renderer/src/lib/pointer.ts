import type { PointerEvent as RPointerEvent } from 'react'

/** Prende o ponteiro no elemento pra o arraste continuar fora dele (sem quebrar se o ponteiro já soltou). */
export function capturePointer(e: RPointerEvent): void {
  try {
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  } catch {
    // ponteiro inválido (já soltou, ou evento sintético): segue sem captura
  }
}
