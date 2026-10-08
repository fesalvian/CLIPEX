// Roda o YAMNet (AudioSet, 521 classes) sobre o WAV do microfone numa worker thread.
// Saída: Float32Array intercalado [risada, grito, fala] por frame de 0,48 s.

import { statSync, writeFileSync } from 'node:fs'
import { parentPort, workerData } from 'node:worker_threads'
import * as ort from 'onnxruntime-node'
import { WavReader } from './wav'
import { EVENT_CHANNELS, LAUGH_CLASSES, SCREAM_CLASSES, SPEECH_CLASS, YAMNET_HOP, YAMNET_WINDOW } from './events'

interface Input {
  wavPath: string
  modelPath: string
  outPath: string
}

const SR = 16000
const HOP = YAMNET_HOP * SR // 7680
const KEEP = 125 // frames por pedaço (60 s)
const CHUNK = KEEP * HOP + YAMNET_WINDOW * SR // 61,44 s (127 frames, os 2 últimos ficam pro próximo pedaço)

async function main(): Promise<void> {
  const { wavPath, modelPath, outPath } = workerData as Input
  const session = await ort.InferenceSession.create(modelPath, { intraOpNumThreads: 2 })
  const inputName = session.inputNames[0]!
  const outName = session.outputNames[0]!
  const reader = new WavReader(wavPath, statSync(wavPath).size)
  const total = reader.info.frames
  const frames: number[] = []
  try {
    for (let start = 0; start < total; start += KEEP * HOP) {
      const samples = reader.read(start, CHUNK)
      if (samples.length < SR * 0.2) break
      const res = await session.run({ [inputName]: new ort.Tensor('float32', samples, [samples.length]) })
      const scores = res[outName]!.data as Float32Array
      const n = res[outName]!.dims[0]!
      const isLast = start + CHUNK >= total
      const keep = isLast ? n : Math.min(KEEP, n)
      for (let j = 0; j < keep; j++) {
        const row = j * 521
        let laugh = 0
        let scream = 0
        for (const c of LAUGH_CLASSES) laugh = Math.max(laugh, scores[row + c]!)
        for (const c of SCREAM_CLASSES) scream = Math.max(scream, scores[row + c]!)
        frames.push(laugh, scream, scores[row + SPEECH_CLASS]!)
      }
      parentPort?.postMessage({ type: 'progress', value: Math.min(1, (start + CHUNK) / total) })
      if (isLast) break
    }
  } finally {
    reader.close()
  }
  const arr = Float32Array.from(frames)
  writeFileSync(outPath, Buffer.from(arr.buffer))
  parentPort?.postMessage({ type: 'done', frames: arr.length / EVENT_CHANNELS })
}

main().catch((e: unknown) => {
  parentPort?.postMessage({ type: 'error', message: e instanceof Error ? e.message : String(e) })
})
