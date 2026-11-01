/**
 * Limita quantas tarefas de um tipo rodam ao mesmo tempo (ex.: 1 Whisper na GPU).
 * Tarefas com prioridade (pedidas na tela) passam na frente das do lote.
 */
export class Semaphore {
  private waiting: { resolve: () => void; priority: boolean }[] = []
  private active = 0

  constructor(private readonly slots: number) {}

  async run<T>(fn: () => Promise<T>, opts: { priority?: boolean } = {}): Promise<T> {
    if (this.active >= this.slots) {
      await new Promise<void>((resolve) => {
        const item = { resolve, priority: !!opts.priority }
        if (item.priority) {
          // entra depois das outras prioritárias, antes do lote
          const firstBatch = this.waiting.findIndex((w) => !w.priority)
          if (firstBatch < 0) this.waiting.push(item)
          else this.waiting.splice(firstBatch, 0, item)
        } else {
          this.waiting.push(item)
        }
      })
    }
    this.active++
    try {
      return await fn()
    } finally {
      this.active--
      this.waiting.shift()?.resolve()
    }
  }

  get pending(): number {
    return this.waiting.length
  }
}

/** Uma GPU, um Whisper por vez. */
export const whisperLane = new Semaphore(1)
/** Previews dos cortes (ffmpeg leve). */
export const previewLane = new Semaphore(1)
/** Proxy da live inteira: fila própria, senão segura os previews por dezenas de minutos. */
export const proxyLane = new Semaphore(1)
/** Detecção de rosto (câmera seguindo quem fala). */
export const facesLane = new Semaphore(1)
/** Chamadas de LLM em paralelo. */
export const llmLane = new Semaphore(2)
