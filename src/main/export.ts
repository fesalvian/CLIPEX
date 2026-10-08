// Plano B: baixar o vídeo pronto (ou todos num .zip) com um .txt das legendas de cada rede.

import { copyFileSync, createWriteStream, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BrowserWindow, dialog } from 'electron'
import { ZipFile } from 'yazl'
import type { ExportResult } from '@shared/ipc'
import { fullCaptionText } from '@shared/platformRules'
import { fmtDur } from '@shared/time'
import { NETWORKS, type Clip } from '@shared/types'
import { clipName } from './clips'
import { clipsRepo, projectsRepo } from './db'
import { ensureRendered, outputName } from './render/queue'
import { getSettings, platformRules } from './settings'

export function captionsTxt(c: Clip): string {
  const rules = platformRules()
  const acc = getSettings().accounts
  const handle = { instagram: acc.instagram, tiktok: acc.tiktok, youtube: acc.youtube }
  const lines = [`${clipName(c)}${c.llm?.title ? ` — ${c.llm.title}` : ''}`, `Duração: ${fmtDur(c.cutOut - c.cutIn)}`, '']
  for (const net of NETWORKS) {
    const cap = c.captions?.[net]
    lines.push(`=== ${rules[net].product} · ${handle[net]} ===`)
    if (!cap) {
      lines.push('(sem legenda gerada)', '')
      continue
    }
    if (cap.title) lines.push(`Título: ${cap.title}`, '')
    lines.push(fullCaptionText(cap), '')
  }
  return lines.join('\r\n')
}

function win(): BrowserWindow | undefined {
  return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
}

export async function exportClip(clipId: string): Promise<ExportResult> {
  const c = await ensureRendered(clipId)
  const name = outputName(c)
  const w = win()
  const opts = { defaultPath: `${name}.mp4`, filters: [{ name: 'Vídeo', extensions: ['mp4'] }] }
  const res = w ? await dialog.showSaveDialog(w, opts) : await dialog.showSaveDialog(opts)
  if (res.canceled || !res.filePath) return { ok: false, path: null, error: null }
  copyFileSync(c.render.path!, res.filePath)
  writeFileSync(res.filePath.replace(/\.mp4$/i, '.txt'), captionsTxt(c), 'utf8')
  return { ok: true, path: res.filePath, error: null }
}

export async function exportZip(projectId: string, clipIds: string[]): Promise<ExportResult> {
  const p = projectsRepo.get(projectId)
  if (!p) throw new Error('Projeto não encontrado')
  const ids = clipIds.length > 0 ? clipIds : clipsRepo.byProject(projectId).filter((c) => c.approved).map((c) => c.id)
  if (ids.length === 0) return { ok: false, path: null, error: 'Nenhum corte aprovado.' }
  const w = win()
  const opts = { defaultPath: `cortes_${p.liveDate ?? p.id}.zip`, filters: [{ name: 'Zip', extensions: ['zip'] }] }
  const res = w ? await dialog.showSaveDialog(w, opts) : await dialog.showSaveDialog(opts)
  if (res.canceled || !res.filePath) return { ok: false, path: null, error: null }
  const rendered: Clip[] = []
  for (const id of ids) rendered.push(await ensureRendered(id))
  const zip = new ZipFile()
  for (const c of rendered) {
    const name = outputName(c)
    // vídeo já é comprimido: guarda sem compressão
    zip.addFile(c.render.path!, `${name}.mp4`, { compress: false })
    zip.addBuffer(Buffer.from(captionsTxt(c), 'utf8'), `${name}.txt`)
  }
  zip.end()
  await new Promise<void>((resolve, reject) => {
    const out = createWriteStream(res.filePath!)
    zip.outputStream.pipe(out).on('close', resolve).on('error', reject)
  })
  return { ok: true, path: res.filePath, error: null }
}

export function rendersFolder(projectId: string): string | null {
  const p = projectsRepo.get(projectId)
  return p ? join(p.dir, 'renders') : null
}
