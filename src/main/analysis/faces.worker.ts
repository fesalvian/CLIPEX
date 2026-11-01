// Detecta rostos (UltraFace RFB-320) quadro a quadro num trecho do vídeo, numa worker thread.
// Também mede quanto a boca de cada rosto mexeu desde o quadro anterior (quem está falando)
// e marca as trocas de câmera. Saída: FaceFrame[] (tempo na fonte).

import { spawn } from 'node:child_process'
import { parentPort, workerData } from 'node:worker_threads'
import * as ort from 'onnxruntime-node'
import type { FaceBox, FaceFrame } from '@shared/faces'

interface Input {
  ffmpeg: string
  args: string[]
  modelPath: string
  /** tempo na fonte do primeiro quadro */
  start: number
  fps: number
  /** quadros esperados (progresso) */
  expected: number
}

/** tamanho dos quadros que o ffmpeg manda (bate com faceFramesArgs) */
const FACE_W = 320
const FACE_H = 240
const SCORE_MIN = 0.7
/** diferença média (0..255) acima disso entre dois quadros = trocou de câmera */
const CUT_DIFF = 28

function iou(a: number[], b: number[]): number {
  const x1 = Math.max(a[0]!, b[0]!)
  const y1 = Math.max(a[1]!, b[1]!)
  const x2 = Math.min(a[2]!, b[2]!)
  const y2 = Math.min(a[3]!, b[3]!)
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1)
  const area = (r: number[]): number => (r[2]! - r[0]!) * (r[3]! - r[1]!)
  return inter / Math.max(1e-9, area(a) + area(b) - inter)
}

function detect(scores: Float32Array, boxes: Float32Array): number[][] {
  const cand: { s: number; b: number[] }[] = []
  for (let i = 0; i < scores.length / 2; i++) {
    const s = scores[i * 2 + 1]!
    if (s < SCORE_MIN) continue
    cand.push({ s, b: [boxes[i * 4]!, boxes[i * 4 + 1]!, boxes[i * 4 + 2]!, boxes[i * 4 + 3]!] })
  }
  cand.sort((a, b) => b.s - a.s)
  const keep: { s: number; b: number[] }[] = []
  for (const c of cand) {
    if (keep.length >= 6) break
    if (keep.every((k) => iou(k.b, c.b) < 0.3)) keep.push(c)
  }
  return keep.map((k) => [...k.b, k.s])
}

function gray(rgb: Buffer): Uint8Array {
  const g = new Uint8Array(FACE_W * FACE_H)
  for (let i = 0, j = 0; i < g.length; i++, j += 3) g[i] = (rgb[j]! * 77 + rgb[j + 1]! * 150 + rgb[j + 2]! * 29) >> 8
  return g
}

function meanDiff(a: Uint8Array, b: Uint8Array, x0: number, y0: number, x1: number, y1: number, step = 1): number {
  let sum = 0
  let n = 0
  for (let y = Math.max(0, y0); y < Math.min(FACE_H, y1); y += step) {
    for (let x = Math.max(0, x0); x < Math.min(FACE_W, x1); x += step) {
      sum += Math.abs(a[y * FACE_W + x]! - b[y * FACE_W + x]!)
      n++
    }
  }
  return n ? sum / n : 0
}

async function main(): Promise<void> {
  const { ffmpeg, args, modelPath, start, fps, expected } = workerData as Input
  const session = await ort.InferenceSession.create(modelPath, { intraOpNumThreads: 2, logSeverityLevel: 3 })
  const input = new Float32Array(3 * FACE_W * FACE_H)
  const frameBytes = FACE_W * FACE_H * 3
  const frames: FaceFrame[] = []
  let prev: Uint8Array | null = null
  let pending = Buffer.alloc(0)
  let index = 0
  let queued = 0

  const handle = async (rgb: Buffer): Promise<void> => {
    const plane = FACE_W * FACE_H
    for (let i = 0, j = 0; i < plane; i++, j += 3) {
      input[i] = (rgb[j]! - 127) / 128
      input[plane + i] = (rgb[j + 1]! - 127) / 128
      input[plane * 2 + i] = (rgb[j + 2]! - 127) / 128
    }
    const res = await session.run({ input: new ort.Tensor('float32', input, [1, 3, FACE_H, FACE_W]) })
    const found = detect(res.scores!.data as Float32Array, res.boxes!.data as Float32Array)
    const g = gray(rgb)
    const cut = prev ? meanDiff(prev, g, 0, 0, FACE_W, FACE_H, 4) > CUT_DIFF : false
    const faces: FaceBox[] = found.map(([x1, y1, x2, y2, score]) => {
      const x = Math.max(0, x1!)
      const y = Math.max(0, y1!)
      const w = Math.min(1, x2!) - x
      const h = Math.min(1, y2!) - y
      // boca e queixo: o terço de baixo do rosto
      const motion =
        prev && !cut
          ? meanDiff(prev, g, Math.round((x + w * 0.2) * FACE_W), Math.round((y + h * 0.62) * FACE_H), Math.round((x + w * 0.8) * FACE_W), Math.round((y + h) * FACE_H)) / 255
          : 0
      return { x, y, w, h, score: score!, motion }
    })
    frames.push({ t: start + index / fps, faces, cut })
    prev = g
    index++
    if (index % 10 === 0) parentPort?.postMessage({ type: 'progress', value: Math.min(1, index / Math.max(1, expected)) })
  }

  await new Promise<void>((resolve, reject) => {
    const proc = spawn(ffmpeg, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let err = ''
    let chain = Promise.resolve()
    proc.stderr.on('data', (d: Buffer) => {
      err = (err + d.toString()).slice(-2000)
    })
    proc.stdout.on('data', (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk])
      while (pending.length >= frameBytes) {
        const frame = Buffer.from(pending.subarray(0, frameBytes))
        pending = pending.subarray(frameBytes)
        queued++
        chain = chain.then(() => handle(frame))
      }
      // segura o ffmpeg enquanto a detecção não alcança (memória)
      if (queued - index > 30) {
        proc.stdout.pause()
        void chain.then(() => proc.stdout.resume())
      }
    })
    proc.on('error', reject)
    proc.on('close', (code) => {
      chain.then(() => (code === 0 ? resolve() : reject(new Error(`ffmpeg saiu com código ${code}: ${err.trim().split('\n').pop() ?? ''}`))), reject)
    })
  })
  parentPort?.postMessage({ type: 'done', frames })
}

main().catch((e: unknown) => {
  parentPort?.postMessage({ type: 'error', message: e instanceof Error ? e.message : String(e) })
})
