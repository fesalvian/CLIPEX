// Gera o ícone do app (bandeja e instalador) a partir do logo da interface: tesoura branca
// num quadrado arredondado roxo → azul. Uso: npx electron scripts/make-icon.cjs
const { app, BrowserWindow } = require('electron')
const { writeFileSync, mkdirSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')

const svg = (size) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 256 256">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#7C3AED"/><stop offset="1" stop-color="#2563EB"/></linearGradient></defs>
  <rect x="8" y="8" width="240" height="240" rx="60" fill="url(#g)"/>
  <g transform="translate(40 40) scale(7.33)" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/>
    <path d="M20 4 8.12 15.88"/><path d="M14.47 14.48 20 20"/><path d="M8.12 8.12 12 12"/>
  </g></svg>`

app.disableHardwareAcceleration()
app.whenReady().then(async () => {
  const root = join(__dirname, '..')
  // desenha uma vez grande e reduz (512 pro instalador, 64 pra bandeja)
  const size = 512
  const w = new BrowserWindow({ width: size, height: size, show: false, frame: false, transparent: true, useContentSize: true })
  const tmp = join(tmpdir(), 'clipador-icon.html')
  writeFileSync(tmp, `<html><body style="margin:0;background:transparent">${svg(size)}</body></html>`)
  await w.loadFile(tmp)
  await new Promise((r) => setTimeout(r, 300))
  const img = await w.webContents.capturePage({ x: 0, y: 0, width: size, height: size })
  w.destroy()
  for (const [px, file] of [
    [512, join(root, 'build', 'icon.png')],
    [64, join(root, 'resources', 'icon.png')]
  ]) {
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, img.resize({ width: px, height: px, quality: 'best' }).toPNG())
    console.log('ícone', file, px)
  }
  app.quit()
})
