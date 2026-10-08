// Gera uma "live" de teste em MKV no formato do OBS (5 faixas de áudio) pra testar o app
// sem precisar de uma gravação de verdade.
//   npm run sample            → .data/sample/live_2026-10-07_21-03.mkv
//   npm run sample -- <fala.wav>   usa esse WAV como voz no microfone (senão usa a voz do Windows)

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

const require = createRequire(import.meta.url)
const ffmpeg = require('ffmpeg-static')
const root = resolve(import.meta.dirname, '..')
const outDir = join(root, '.data', 'sample')
mkdirSync(outDir, { recursive: true })

const DURATION = 360
const SHOUTS = [70, 175, 290]

let speech = process.argv[2]
if (!speech) {
  speech = join(outDir, 'fala.wav')
  if (!existsSync(speech)) {
    const text =
      'Mano, mano, olha ali. Ele tá vindo direto pra mim. Calma que eu tô de AWP. Não, não, não! Ele me viu. Que clutch absurdo, Salvian! Bora pra próxima, chat.'
    const ps = `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; ` +
      `$v = $s.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Culture.Name -eq 'pt-BR' } | Select-Object -First 1; ` +
      `if ($v) { $s.SelectVoice($v.VoiceInfo.Name) }; $s.SetOutputToWaveFile('${speech}'); $s.Speak('${text}'); $s.Dispose()`
    execFileSync('powershell', ['-NoProfile', '-Command', ps], { stdio: 'inherit' })
  }
}

const out = join(outDir, 'live_2026-10-07_21-03.mkv')
// Microfone: fala em loop baixinha + 3 "gritos" (a mesma fala 14 dB mais alta).
const shoutInputs = SHOUTS.flatMap(() => ['-i', speech])
const shoutFilters = SHOUTS.map((t, i) => `[${i + 2}:a]atrim=0:6,volume=14dB,adelay=${t * 1000}|${t * 1000}[s${i}]`).join(';')
const mixIn = ['[base]', ...SHOUTS.map((_, i) => `[s${i}]`)].join('')
const graph = [
  // vídeo: jogo em tela cheia + webcam no canto inferior direito
  `[0:v]scale=1920:1080,format=yuv420p[game]`,
  `gradients=s=400x360:r=60:speed=0.03:c0=0xFF9F45:c1=0x7C3AED:c2=0x1E1240,drawbox=x=150:y=90:w=100:h=120:color=0xFFE0C0@0.9:t=fill,format=yuv420p[cam]`,
  `[game][cam]overlay=x=1470:y=640:shortest=1[v]`,
  `[1:a]volume=-6dB,apad,atrim=0:${DURATION}[base]`,
  shoutFilters,
  `${mixIn}amix=inputs=${SHOUTS.length + 1}:duration=first:normalize=0,alimiter=limit=0.95,asplit=2[mic][micmix]`,
  `sine=f=330:d=${DURATION},volume=-26dB,asplit=2[gameaud][gamemix]`,
  `anoisesrc=d=${DURATION}:a=0.004,asplit=2[disc][discmix]`,
  `sine=f=196:d=${DURATION},volume=-24dB,asplit=2[music][musicmix]`,
  `[micmix][gamemix][discmix][musicmix]amix=inputs=4:normalize=0[mix]`
].join(';')

execFileSync(
  ffmpeg,
  [
    '-hide_banner', '-y',
    '-f', 'lavfi', '-i', `testsrc2=s=1920x1080:r=60:d=${DURATION}`,
    '-stream_loop', '-1', '-i', speech,
    ...shoutInputs,
    '-filter_complex', graph,
    '-map', '[v]', '-map', '[mix]', '-map', '[mic]', '-map', '[gameaud]', '-map', '[disc]', '-map', '[music]',
    '-t', String(DURATION),
    '-c:v', 'h264_nvenc', '-preset', 'p1', '-b:v', '6M',
    '-c:a', 'aac', '-b:a', '128k',
    out
  ],
  { stdio: 'inherit' }
)
writeFileSync(join(outDir, 'README.txt'), `Live de teste gerada por scripts/make-sample-live.mjs\nGritos em: ${SHOUTS.join(', ')} s\n`)
console.log(`\nPronto: ${out}`)
