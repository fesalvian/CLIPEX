// Classes do YAMNet (yamnet_class_map.csv do AudioSet) usadas na detecção.

export const SPEECH_CLASS = 0
/** Shout, Bellow, Whoop, Yell, Children shouting, Screaming */
export const SCREAM_CLASSES = [6, 7, 8, 9, 10, 11]
/** Laughter, Baby laughter, Giggle, Snicker, Belly laugh, Chuckle */
export const LAUGH_CLASSES = [13, 14, 15, 16, 17, 18]

export const YAMNET_HOP = 0.48
export const YAMNET_WINDOW = 0.96
export const EVENT_CHANNELS = 3

export interface EventSeries {
  laugh: Float32Array
  scream: Float32Array
  speech: Float32Array
  /** passo entre frames (s) */
  hop: number
}

export function splitEvents(interleaved: Float32Array, hop = YAMNET_HOP): EventSeries {
  const n = Math.floor(interleaved.length / EVENT_CHANNELS)
  const laugh = new Float32Array(n)
  const scream = new Float32Array(n)
  const speech = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    laugh[i] = interleaved[i * 3]!
    scream[i] = interleaved[i * 3 + 1]!
    speech[i] = interleaved[i * 3 + 2]!
  }
  return { laugh, scream, speech, hop }
}
