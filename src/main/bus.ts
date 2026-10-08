import { BrowserWindow } from 'electron'
import type { IpcEventName, IpcEvents } from '@shared/ipc'

/** Manda um evento pra todas as janelas abertas. */
export function emit<K extends IpcEventName>(event: K, payload: IpcEvents[K]): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(event, payload)
  }
}

export function toast(kind: IpcEvents['toast']['kind'], text: string): void {
  emit('toast', { kind, text })
}
