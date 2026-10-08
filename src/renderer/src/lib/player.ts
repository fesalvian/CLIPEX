import { useCallback, useEffect, useRef, useState } from 'react'
import type { Clip } from '@shared/types'
import { mediaUrl } from '../api'

export interface Player {
  /** <video> escondido que alimenta o canvas do preview */
  videoRef: React.RefObject<HTMLVideoElement | null>
  src: string | null
  clipId: string | null
  playing: boolean
  /** tempo atual na linha do tempo da live (s) */
  time: number
  ready: boolean
  play: () => void
  pause: () => void
  toggle: () => void
  seek: (sourceSec: number) => void
}

/**
 * Toca o trecho do corte no preview da janela (arquivo 360p que começa em `previewStart`)
 * e fica em loop entre o início e o fim do corte.
 */
export function usePreviewPlayer(clip: Clip | null): Player {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const [playing, setPlaying] = useState(false)
  const [time, setTime] = useState(clip?.cutIn ?? 0)
  const [ready, setReady] = useState(false)
  const src = mediaUrl(clip?.previewPath)
  const offset = clip?.previewStart ?? 0
  const cutIn = clip?.cutIn ?? 0
  const cutOut = clip?.cutOut ?? 0
  const bounds = useRef({ cutIn, cutOut, offset })
  bounds.current = { cutIn, cutOut, offset }

  // corte novo: volta pro começo e para
  useEffect(() => {
    setPlaying(false)
    setReady(false)
    setTime(clip?.cutIn ?? 0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clip?.id, src])

  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    const onMeta = (): void => {
      setReady(true)
      v.currentTime = Math.max(0, bounds.current.cutIn - bounds.current.offset)
    }
    v.addEventListener('loadedmetadata', onMeta)
    return () => v.removeEventListener('loadedmetadata', onMeta)
  }, [src])

  useEffect(() => {
    if (!playing) return
    let raf = 0
    const loop = (): void => {
      const v = videoRef.current
      if (v) {
        const b = bounds.current
        const t = b.offset + v.currentTime
        if (t >= b.cutOut - 0.02 || t < b.cutIn - 0.5) v.currentTime = Math.max(0, b.cutIn - b.offset)
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
    if (t < b.cutIn || t >= b.cutOut - 0.05) v.currentTime = Math.max(0, b.cutIn - b.offset)
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

  return { videoRef, src, clipId: clip?.id ?? null, playing, time, ready, play, pause, toggle, seek }
}
