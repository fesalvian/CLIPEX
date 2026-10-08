import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { MEDIA_SCHEME, type ExposedApi } from '@shared/ipc'

const api: ExposedApi = {
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  on: (event, listener) => {
    const wrapped = (_e: IpcRendererEvent, payload: unknown): void => listener(payload as never)
    ipcRenderer.on(event, wrapped)
    return () => ipcRenderer.removeListener(event, wrapped)
  },
  mediaUrl: (path) => `${MEDIA_SCHEME}://local/${encodeURIComponent(path)}`
}

contextBridge.exposeInMainWorld('api', api)
