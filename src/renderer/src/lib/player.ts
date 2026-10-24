import { useCallback, useEffect, useRef, useState } from 'react'
import { cutsOf } from '@shared/cuts'
import type { Clip, Cut } from '@shared/types'
import { mediaUrl } from '../api'

export interface Player {
  /** <video> escondido que alimenta o canvas do preview e o editor de recorte */
  videoRef: React.RefObject<HTMLVideoElement | null>
  src: string | null
  /** onde o arquivo tocando começa na live (s) */
  offset: number
  clipId: string | null
  playing: boolean
  /** tempo atual na linha do tempo da live (s) */
  time: number
  ready: boolean
  /** o trecho leve ainda não cobre o corte (sendo gerado) */
  loadingPreview: boolean
  play: () => void
  pause: () => void
  toggle: () => void
  seek: (sourceSec: number) => void
}

function previewCovers(c: Clip): boolean {
  if (!c.previewPath || c.previewStart === null) return false
  const end = c.previewEnd ?? c.winEnd + 2
  return c.cutIn >= c.previewStart - 0.1 && c.cutOut <= end + 0.1
}

/**
 * Pra onde o vídeo tem que pular: antes de um trecho (começo ou buraco entre trechos) vai pro
 * início dele; passou do fim do último volta pro começo; null = está tocando dentro de um trecho.
 */
function jumpTarget(cuts: Cut[], t: number): number | null {
  for (let i = 0; i < cuts.length; i++) {
    const k = cuts[i]!
    // folga maior no começo: o seek do <video> pode cair um pouco antes
    if (t < k.s - (i === 0 ? 0.5 : 0.1)) return k.s
    if (t < k.e - 0.02) return null
  }
  return cuts[0]?.s ?? null
}

/**
 * Toca o corte em loop entre o início e o fim, pulando o que fica entre os trechos. Usa o trecho leve do corte quando ele
 * cobre o corte; senão o proxy da live inteira (se já existir) enquanto o trecho é gerado.
 */
export function usePreviewPlayer(clip: Clip | null, proxyPath: string | null): Player {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const [playing, setPlaying] = useState(false)
  const [time, setTime] = useState(clip?.cutIn ?? 0)
  const [ready, setReady] = useState(false)

  const covers = clip ? previewCovers(clip) : false
  let src: string | null = null
  let offset = 0
  if (clip && covers) {
    src = mediaUrl(clip.previewPath)
    offset = clip.previewStart ?? 0
  } else if (clip && proxyPath) {
    src = mediaUrl(proxyPath)
  } else if (clip?.previewPath) {
    src = mediaUrl(clip.previewPath)
    offset = clip.previewStart ?? 0
  }
  const cutIn = clip?.cutIn ?? 0
  const cutOut = clip?.cutOut ?? 0
  const cuts = clip ? cutsOf(clip) : []
  const bounds = useRef({ cutIn, cutOut, offset, cuts })
  bounds.current = { cutIn, cutOut, offset, cuts }

  // corte novo: volta pro começo e para
  useEffect(() => {
    setPlaying(false)
    setTime(clip?.cutIn ?? 0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clip?.id])

  // arquivo novo (preview regenerado ou troca pro proxy): mantém a posição
  useEffect(() => {
    setReady(false)
    const v = videoRef.current
    if (!v) return
    const onMeta = (): void => {
      setReady(true)
      const b = bounds.current
      v.currentTime = Math.max(0, Math.max(b.cutIn, Math.min(time, b.cutOut)) - b.offset)
    }
    v.addEventListener('loadedmetadata', onMeta)
    return () => v.removeEventListener('loadedmetadata', onMeta)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src])

  useEffect(() => {
    if (!playing) return
    let raf = 0
    const loop = (): void => {
      const v = videoRef.current
      if (v) {
        const b = bounds.current
        const t = b.offset + v.currentTime
        const to = jumpTarget(b.cuts, t)
        if (to !== null) v.currentTime = Math.max(0, to - b.offset)
        setTime(b.offset + v.currentTime)
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [playing])

  const play = useCallback(() => {
    const v = videoRef.current
    if (!v || !src) return
    const b = bounds.current
    const t = b.offset + v.currentTime
    const to = t >= b.cutOut - 0.05 ? b.cutIn : jumpTarget(b.cuts, t)
    if (to !== null) v.currentTime = Math.max(0, to - b.offset)
    void v.play().then(
      () => setPlaying(true),
      () => setPlaying(false)
    )
  }, [src])

  const pause = useCallback(() => {
    videoRef.current?.pause()
    setPlaying(false)
  }, [])

  const toggle = useCallback(() => (playing ? pause() : play()), [playing, play, pause])

  const seek = useCallback((sec: number) => {
    const v = videoRef.current
    setTime(sec)
    if (v) v.currentTime = Math.max(0, sec - bounds.current.offset)
  }, [])

  return {
    videoRef,
    src,
    offset,
    clipId: clip?.id ?? null,
    playing,
    time,
    ready,
    loadingPreview: !!clip && !covers,
    play,
    pause,
    toggle,
    seek
  }
}
