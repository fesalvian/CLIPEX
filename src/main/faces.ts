// Câmera seguindo quem fala (layout 'face'): detecta os rostos no trecho do corte (no preview
// leve quando ele cobre o trecho) e guarda os planos no corte. O render e o preview usam os planos.

import { existsSync } from 'node:fs'
import { cutsOf } from '@shared/cuts'
import { buildShots, cropFraction, targets, trackCovers, type FaceFrame } from '@shared/faces'
import type { Clip } from '@shared/types'
import createFacesWorker from './analysis/faces.worker?nodeWorker'
import { markStale, mutateClip } from './clips'
import { downloadComponent, facesModelPath, ffmpegPath } from './components'
import { clipsRepo, projectsRepo } from './db'
import { faceFramesArgs } from './ffmpeg/args'
import { facesLane } from './sema'

const FPS = 5
/** Timeline afastada: detecta só em volta do corte, não na janela inteira. */
const WINDOW_MAX = 4 * 60

let modelTried = false

async function model(): Promise<string | null> {
  const m = facesModelPath()
  if (m || modelTried) return m
  // modelo pequeno (1,2 MB): baixa sozinho na primeira vez
  modelTried = true
  await downloadComponent('faces').catch(() => undefined)
  return facesModelPath()
}

function detect(file: string, start: number, duration: number, sourceStart: number, modelPath: string): Promise<FaceFrame[]> {
  return new Promise((resolve, reject) => {
    const w = createFacesWorker({
      workerData: {
        ffmpeg: ffmpegPath(),
        args: faceFramesArgs(file, start, duration, FPS),
        modelPath,
        start: sourceStart,
        fps: FPS,
        expected: Math.ceil(duration * FPS)
      }
    })
    w.on('message', (m: { type: string; frames?: FaceFrame[]; message?: string }) => {
      if (m.type === 'done') resolve(m.frames ?? [])
      else if (m.type === 'error') reject(new Error(m.message))
    })
    w.on('error', reject)
    w.on('exit', (code) => {
      if (code !== 0) reject(new Error(`Detector de rosto parou com código ${code}`))
    })
  })
}

/** Garante os planos da câmera cobrindo o corte (calcula se faltar). Sem o modelo, fica no centro. */
export async function ensureFaces(clipId: string): Promise<Clip | null> {
  const c = clipsRepo.get(clipId)
  if (!c || trackCovers(c.faces, cutsOf(c))) return c
  const modelPath = await model()
  if (!modelPath) return c
  return facesLane.run(async () => {
    const cur = clipsRepo.get(clipId)
    if (!cur || trackCovers(cur.faces, cutsOf(cur))) return cur
    const p = projectsRepo.get(cur.projectId)
    if (!p?.source) return cur
    const dur = p.source.durationSec
    const wide = cur.winEnd - cur.winStart > WINDOW_MAX
    const from = Math.max(0, (wide ? cur.cutIn - 5 : Math.min(cur.winStart, cur.cutIn)) - 1)
    const to = Math.min(dur, (wide ? cur.cutOut + 5 : Math.max(cur.winEnd, cur.cutOut)) + 1)
    // preview leve cobrindo o trecho: decodifica bem mais rápido que o original
    const usePreview =
      !!cur.previewPath &&
      existsSync(cur.previewPath) &&
      cur.previewStart !== null &&
      cur.previewEnd !== null &&
      cur.previewStart <= from + 0.1 &&
      cur.previewEnd >= to - 0.1
    const file = usePreview ? cur.previewPath! : p.sourcePath
    if (!existsSync(file)) return cur
    const start = usePreview ? from - cur.previewStart! : from
    const frames = await detect(file, start, to - from, from, modelPath)
    const crop = cropFraction(p.source.width, p.source.height)
    const shots = buildShots(frames, targets(frames, crop), crop, from, to)
    return mutateClip(clipId, (x) => {
      x.faces = { from, to, shots }
      markStale(x)
    })
  })
}
