/** Limita quantas tarefas de um tipo rodam ao mesmo tempo (ex.: 1 Whisper na GPU). */
export class Semaphore {
  private waiting: (() => void)[] = []
  private active = 0

  constructor(private readonly slots: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.slots) await new Promise<void>((r) => this.waiting.push(r))
    this.active++
    try {
      return await fn()
    } finally {
      this.active--
      this.waiting.shift()?.()
    }
  }
}

/** Uma GPU, um Whisper por vez. */
export const whisperLane = new Semaphore(1)
/** Previews e proxy (ffmpeg leve). */
export const previewLane = new Semaphore(1)
/** Chamadas de LLM em paralelo. */
export const llmLane = new Semaphore(2)
