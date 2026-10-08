import { join } from 'node:path'
import { app, BrowserWindow, Menu, nativeImage, shell, Tray } from 'electron'
import { toast } from './bus'
import { closeDb } from './db'
import { applyDevSettings, applyDevUserData, runDevTour } from './devtour'
import { loadEnv } from './env'
import { registerIpc } from './ipc'
import { handleMediaProtocol, registerMediaScheme } from './media'
import { resourcesDir } from './paths'
import { killAllProcesses } from './proc'
import { resumePending } from './pipeline'
import { hasPendingPosts, startScheduler, stopScheduler } from './posting/scheduler'
import { startWatcher, stopWatcher } from './watcher'

applyDevUserData()
registerMediaScheme()

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let quitting = false
let trayHintShown = false

function createWindow(): BrowserWindow {
  const w = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    title: 'Clipador',
    backgroundColor: '#0A0F2C',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      // o roteiro de teste tira prints com a janela atrás de outras
      backgroundThrottling: !process.env.CLIPADOR_SHOTS
    }
  })
  w.once('ready-to-show', () => w.show())
  w.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  // Fechar a janela manda pra bandeja: os agendamentos continuam valendo.
  w.on('close', (e) => {
    if (quitting) return
    e.preventDefault()
    w.hide()
    if (!trayHintShown && hasPendingPosts()) {
      trayHintShown = true
      tray?.displayBalloon?.({ title: 'Clipador', content: 'Continuo na bandeja pra postar os cortes agendados.' })
    }
  })
  if (process.env.ELECTRON_RENDERER_URL) void w.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void w.loadFile(join(__dirname, '../renderer/index.html'))
  return w
}

function showWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) mainWindow = createWindow()
  mainWindow.show()
  mainWindow.focus()
}

function createTray(): void {
  const icon = nativeImage.createFromPath(join(resourcesDir(), 'icon.png'))
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon.resize({ width: 16, height: 16 }))
  tray.setToolTip('Clipador')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Abrir o Clipador', click: showWindow },
      { type: 'separator' },
      {
        label: 'Sair',
        click: () => {
          quitting = true
          app.quit()
        }
      }
    ])
  )
  tray.on('click', showWindow)
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', showWindow)

  app.whenReady().then(() => {
    app.setAppUserModelId('br.fesalvian.clipador')
    loadEnv()
    handleMediaProtocol()
    registerIpc()
    mainWindow = createWindow()
    createTray()
    applyDevSettings()
    startWatcher()
    startScheduler()
    resumePending()
    void runDevTour(mainWindow)
    process.on('uncaughtException', (e) => toast('error', `Erro interno: ${e.message}`))
  })

  app.on('before-quit', () => {
    quitting = true
    stopWatcher()
    stopScheduler()
    killAllProcesses()
    closeDb()
  })

  app.on('window-all-closed', () => {
    // fica na bandeja
  })
}
