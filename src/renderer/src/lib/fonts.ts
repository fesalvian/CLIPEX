import type { FontInfo } from '@shared/types'
import { mediaUrl } from '../api'

const loaded = new Set<string>()

/**
 * Registra no navegador as fontes do app e as importadas, com o mesmo nome de família
 * que o libass usa no render. Assim o preview mostra a fonte que vai sair no vídeo.
 */
export async function loadFontFaces(fonts: FontInfo[]): Promise<void> {
  await Promise.all(
    fonts.map(async (f) => {
      const key = `${f.family}|${f.file}`
      if (loaded.has(key)) return
      loaded.add(key)
      try {
        const face = new FontFace(f.family, `url("${mediaUrl(f.file)}")`, { weight: f.bold ? '700' : '400' })
        await face.load()
        document.fonts.add(face)
      } catch {
        loaded.delete(key)
      }
    })
  )
}

/** Pilha de fontes CSS pra uma família (com reserva se ainda não carregou). */
export function fontStack(family: string): string {
  return `"${family}", "Montserrat Caption", "Space Grotesk", sans-serif`
}
