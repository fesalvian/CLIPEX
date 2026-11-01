import { join } from 'node:path'
import { app, BrowserWindow, Menu, nativeImage, shell, Tray } from 'electron'
import { applyAutostart, enterLowPower, relaunch, startedHidden } from './autostart'
import { toast } from './bus'
import { closeDb } from './db'
import { applyDevSettings, applyDevUserData, runDevTour } from './devtour'
import { loadEnv } from './env'
import { registerIpc } from './ipc'
import { handleMediaProtocol, registerMediaScheme } from './media'
import { isDev, resourcesDir } from './paths'
import { activeProcessCount, killAllProcesses } from './proc'
import { analysisBusy, onAnalysisDone, resumePending } from './pipeline'
import { resumeAutopilot, runAutopilot } from './autopilot'
import { sourcesBusy, startSources, stopSources } from './sources'
import { resumeClipJobs } from './prepare'
import { markProjectStale } from './render/queue'
import { consumeWatermarkMigration, getSettings } from './settings'
import { projectsRepo } from './db'
import { hasPendingPosts, postingNow, startScheduler, stopScheduler } from './posting/scheduler'
import { startWatcher, stopWatcher } from './watcher'

applyDevUserData()
registerMediaScheme()

// Aberto pelo Windows: modo econômico (só a bandeja, fila de postagem e pasta vigiada).
const lowPower = startedHidden() && !isDev
if (lowPower) enterLowPower()

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let quitting = false
let trayHintShown = false
let idleTimer: NodeJS.Timeout | null = null

/** Render, análise ou envio em andamento: reiniciar o app agora interromperia. */
function busy(): boolean {
  return activeProcessCount() > 0 || analysisBusy() || postingNow() || sourcesBusy()
}

/** Janela fechada: quando nada estiver rodando, reinicia no modo econômico (libera a memória da GPU). */
function lowPowerWhenIdle(): void {
  if (isDev || idleTimer) return
  const check = (): void => {
    if (mainWindow || quitting) {
      if (idleTimer) clearInterval(idleTimer)
      idleTimer = null
      return
    }
    if (busy()) return
    quitting = true
    relaunch(true)
  }
  idleTimer = setInterval(check, 60_000)
  setTimeout(check, 3000)
}

function createWindow(): BrowserWindow {
  const w = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 1280,
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
  // Fechar a janela fecha de verdade (libera a memória da interface) e o app fica na
  // bandeja só com o processo principal: os agendamentos continuam valendo.
  w.on('close', () => {
    if (quitting) return
    if (!trayHintShown && hasPendingPosts()) {
      trayHintShown = true
      tray?.displayBalloon?.({ title: 'Clipador', content: 'Continuo na bandeja pra postar os cortes agendados.' })
    }
  })
  w.on('closed', () => {
    if (mainWindow === w) mainWindow = null
    lowPowerWhenIdle()
  })
  if (process.env.ELECTRON_RENDERER_URL) void w.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void w.loadFile(join(__dirname, '../renderer/index.html'))
  return w
}

function showWindow(): void {
  // no modo econômico a interface ficaria sem aceleração: reabre no modo normal (1 a 2 s)
  if (lowPower && !busy()) {
    quitting = true
    relaunch(false)
    return
  }
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
    // aberto pelo Windows no login: só a bandeja, sem janela
    if (!startedHidden()) mainWindow = createWindow()
    createTray()
    applyAutostart(getSettings().startWithWindows)
    applyDevSettings()
    startWatcher()
    startScheduler()
    // modo automático: canal vigiado baixa sozinho; análise pronta de vídeo automático vai pra fila
    onAnalysisDone((id) => void runAutopilot(id))
    startSources()
    // marca d'água antiga trocada pela logo presa à legenda: renders prontos ficam velhos
    if (consumeWatermarkMigration()) for (const p of projectsRepo.all()) markProjectStale(p.id)
    resumePending()
    resumeClipJobs()
    resumeAutopilot()
    if (mainWindow) void runDevTour(mainWindow)
    process.on('uncaughtException', (e) => toast('error', `Erro interno: ${e.message}`))
  })

  app.on('before-quit', () => {
    quitting = true
    stopWatcher()
    stopScheduler()
    stopSources()
    killAllProcesses()
    closeDb()
  })

  app.on('window-all-closed', () => {
    // fica na bandeja
  })
}
