import { useEffect, useRef } from 'react'
import type { IpcApi, IpcChannel, IpcEventName, IpcEvents } from '@shared/ipc'

export function call<K extends IpcChannel>(channel: K, ...args: Parameters<IpcApi[K]>): Promise<Awaited<ReturnType<IpcApi[K]>>> {
  return window.api.invoke(channel, ...args)
}

export function mediaUrl(path: string | null | undefined, version?: string | number): string | null {
  if (!path) return null
  const url = window.api.mediaUrl(path)
  return version !== undefined ? `${url}?v=${encodeURIComponent(String(version))}` : url
}

export function useApiEvent<K extends IpcEventName>(event: K, handler: (payload: IpcEvents[K]) => void): void {
  const ref = useRef(handler)
  ref.current = handler
  useEffect(() => window.api.on(event, (p) => ref.current(p)), [event])
}

/** Mensagem de erro do main sem o prefixo "Error invoking remote method ...". */
export function errorText(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e)
  return msg.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}
