import { spawn, type ChildProcess } from 'node:child_process'
import { constants, setPriority } from 'node:os'

export interface RunOptions {
  cwd?: string
  onStdoutLine?: (line: string) => void
  onStderrLine?: (line: string) => void
  /** prioridade baixa no Windows (BELOW_NORMAL) pra não pesar no PC */
  lowPriority?: boolean
}

export interface RunHandle<T = void> {
  done: Promise<T>
  cancel: () => void
}

export class ProcessError extends Error {
  constructor(
    message: string,
    readonly code: number | null,
    readonly stderrTail: string
  ) {
    super(message)
  }
}

export class CanceledError extends Error {
  constructor() {
    super('Cancelado')
  }
}

function lineSplitter(cb: ((line: string) => void) | undefined): (chunk: Buffer) => void {
  let rest = ''
  return (chunk) => {
    if (!cb) return
    rest += chunk.toString('utf8')
    const lines = rest.split(/\r?\n|\r/)
    rest = lines.pop() ?? ''
    for (const l of lines) if (l) cb(l)
  }
}

const active = new Set<ChildProcess>()

/** ffmpeg, Whisper etc. rodando agora. */
export function activeProcessCount(): number {
  return active.size
}

/** No Windows os filhos sobrevivem ao app: mata tudo que ainda roda ao sair. */
export function killAllProcesses(): void {
  for (const c of active) {
    try {
      c.kill()
    } catch {
      // já saiu
    }
  }
  active.clear()
}

/** Roda um executável, entrega as linhas de saída e rejeita com o fim do stderr em caso de erro. */
export function runProcess(exe: string, args: string[], opts: RunOptions = {}): RunHandle {
  const child = spawn(exe, args, { cwd: opts.cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  active.add(child)
  child.on('exit', () => active.delete(child))
  if (opts.lowPriority && child.pid) {
    try {
      setPriority(child.pid, constants.priority.PRIORITY_BELOW_NORMAL)
    } catch {
      // sem permissão: segue na prioridade normal
    }
  }
  let canceled = false
  const tail: string[] = []
  const errLine = lineSplitter((l) => {
    tail.push(l)
    if (tail.length > 40) tail.shift()
    opts.onStderrLine?.(l)
  })
  child.stdout.on('data', lineSplitter(opts.onStdoutLine))
  child.stderr.on('data', errLine)
  const done = new Promise<void>((resolve, reject) => {
    child.on('error', (e) => reject(new ProcessError(`Não consegui iniciar ${exe}: ${e.message}`, null, '')))
    child.on('close', (code) => {
      if (canceled) return reject(new CanceledError())
      if (code === 0) resolve()
      else {
        const t = tail.join('\n')
        reject(new ProcessError(`${exe.split(/[\\/]/).pop()} saiu com código ${code}\n${t.slice(-1500)}`, code, t))
      }
    })
  })
  return {
    done,
    cancel: () => {
      canceled = true
      child.kill()
    }
  }
}

/** Lê `-progress pipe:1` do ffmpeg e devolve a fração concluída. */
export function ffmpegProgress(totalSec: number, cb: (p: number) => void): (line: string) => void {
  return (line) => {
    const m = /^out_time_(?:us|ms)=(\d+)/.exec(line)
    if (m && totalSec > 0) cb(Math.max(0, Math.min(1, Number(m[1]) / 1e6 / totalSec)))
  }
}
