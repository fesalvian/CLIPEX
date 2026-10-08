import { closeSync, openSync, readSync, writeFileSync } from 'node:fs'

export interface WavInfo {
  sampleRate: number
  channels: number
  bitsPerSample: number
  dataOffset: number
  dataBytes: number
  /** amostras por canal */
  frames: number
}

/** Lê o cabeçalho RIFF procurando os chunks `fmt ` e `data` (o ffmpeg às vezes põe um LIST no meio). */
export function parseWavHeader(buf: Buffer, fileSize?: number): WavInfo {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('WAV inválido')
  }
  let pos = 12
  let fmt: { channels: number; sampleRate: number; bits: number } | null = null
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4)
    const size = buf.readUInt32LE(pos + 4)
    if (id === 'fmt ') {
      fmt = {
        channels: buf.readUInt16LE(pos + 10),
        sampleRate: buf.readUInt32LE(pos + 12),
        bits: buf.readUInt16LE(pos + 22)
      }
    } else if (id === 'data') {
      if (!fmt) throw new Error('WAV sem chunk fmt')
      const dataOffset = pos + 8
      // ffmpeg escrevendo em pipe/arquivo grande pode deixar o tamanho 0 ou 0xFFFFFFFF.
      let dataBytes = size
      if (fileSize !== undefined && (size === 0 || size === 0xffffffff || dataOffset + size > fileSize)) {
        dataBytes = fileSize - dataOffset
      }
      const bytesPerFrame = (fmt.bits / 8) * fmt.channels
      return {
        sampleRate: fmt.sampleRate,
        channels: fmt.channels,
        bitsPerSample: fmt.bits,
        dataOffset,
        dataBytes,
        frames: Math.floor(dataBytes / bytesPerFrame)
      }
    }
    pos += 8 + size + (size % 2)
  }
  throw new Error('WAV sem chunk data')
}

export class WavReader {
  readonly info: WavInfo
  private fd: number

  constructor(path: string, fileSize: number) {
    this.fd = openSync(path, 'r')
    const head = Buffer.alloc(4096)
    const n = readSync(this.fd, head, 0, head.length, 0)
    this.info = parseWavHeader(head.subarray(0, n), fileSize)
    if (this.info.bitsPerSample !== 16 || this.info.channels !== 1) {
      throw new Error('Esperado WAV PCM 16 bits mono')
    }
  }

  /** Amostras em float -1..1. */
  read(startFrame: number, count: number): Float32Array {
    const start = Math.max(0, Math.min(this.info.frames, startFrame))
    const n = Math.max(0, Math.min(count, this.info.frames - start))
    const buf = Buffer.alloc(n * 2)
    readSync(this.fd, buf, 0, buf.length, this.info.dataOffset + start * 2)
    const out = new Float32Array(n)
    for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(i * 2) / 32768
    return out
  }

  readRaw(startFrame: number, count: number): Buffer {
    const start = Math.max(0, Math.min(this.info.frames, startFrame))
    const n = Math.max(0, Math.min(count, this.info.frames - start))
    const buf = Buffer.alloc(n * 2)
    readSync(this.fd, buf, 0, buf.length, this.info.dataOffset + start * 2)
    return buf
  }

  close(): void {
    closeSync(this.fd)
  }
}

export function wavHeader(dataBytes: number, sampleRate: number, channels = 1, bits = 16): Buffer {
  const h = Buffer.alloc(44)
  h.write('RIFF', 0, 'ascii')
  h.writeUInt32LE(36 + dataBytes, 4)
  h.write('WAVE', 8, 'ascii')
  h.write('fmt ', 12, 'ascii')
  h.writeUInt32LE(16, 16)
  h.writeUInt16LE(1, 20)
  h.writeUInt16LE(channels, 22)
  h.writeUInt32LE(sampleRate, 24)
  h.writeUInt32LE((sampleRate * channels * bits) / 8, 28)
  h.writeUInt16LE((channels * bits) / 8, 32)
  h.writeUInt16LE(bits, 34)
  h.write('data', 36, 'ascii')
  h.writeUInt32LE(dataBytes, 40)
  return h
}

/** Escreve um pedaço [fromSec, toSec) do WAV num arquivo novo (entrada do Whisper). */
export function writeWavSlice(reader: WavReader, fromSec: number, toSec: number, out: string): void {
  const sr = reader.info.sampleRate
  const pcm = reader.readRaw(Math.floor(fromSec * sr), Math.ceil((toSec - fromSec) * sr))
  writeFileSync(out, Buffer.concat([wavHeader(pcm.length, sr), pcm]))
}
