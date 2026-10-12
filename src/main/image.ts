// Recorta a borda transparente de um PNG (logo/marca d'água). Assim a caixa da logo é o
// desenho de verdade e dá pra encostar na legenda sem a borda invisível atrapalhar.

import { execFile } from 'node:child_process'
import { copyFileSync } from 'node:fs'
import { promisify } from 'node:util'
import { ffmpegPath } from './components'

const pexec = promisify(execFile)

export interface CropBox {
  w: number
  h: number
  x: number
  y: number
}

/** Último `crop=w:h:x:y` do log do cropdetect. */
export function parseCropdetect(log: string): CropBox | null {
  const all = [...log.matchAll(/crop=(\d+):(\d+):(\d+):(\d+)/g)]
  const m = all[all.length - 1]
  if (!m) return null
  const [w, h, x, y] = m.slice(1).map(Number) as [number, number, number, number]
  return w > 0 && h > 0 ? { w, h, x, y } : null
}

/** Copia `src` pra `dest` sem as bordas transparentes. Devolve o tamanho final. */
export async function trimTransparent(src: string, dest: string, size: { w: number; h: number }): Promise<{ w: number; h: number }> {
  try {
    const r = await pexec(
      ffmpegPath(),
      ['-hide_banner', '-loop', '1', '-t', '0.2', '-i', src, '-vf', 'alphaextract,format=gray,cropdetect=limit=0.03:round=2:reset=0:skip=0', '-f', 'null', '-'],
      { windowsHide: true, timeout: 30000 }
    )
    const box = parseCropdetect(`${r.stdout}\n${r.stderr}`)
    // nada pra recortar (ou quase): usa o arquivo como veio
    if (!box || (box.w >= size.w - 4 && box.h >= size.h - 4)) {
      copyFileSync(src, dest)
      return size
    }
    await pexec(ffmpegPath(), ['-hide_banner', '-y', '-i', src, '-vf', `crop=${box.w}:${box.h}:${box.x}:${box.y}`, '-pix_fmt', 'rgba', dest], {
      windowsHide: true,
      timeout: 30000
    })
    return { w: box.w, h: box.h }
  } catch {
    // PNG sem canal alfa (alphaextract falha): não tem borda transparente
    copyFileSync(src, dest)
    return size
  }
}
