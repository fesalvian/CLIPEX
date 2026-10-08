import type { ExposedApi } from '../shared/ipc'

declare global {
  interface Window {
    api: ExposedApi
  }
}

export {}
