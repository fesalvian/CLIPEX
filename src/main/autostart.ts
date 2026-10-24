// Abrir com o Windows direto na bandeja, sem janela: só o processo principal fica rodando
// (fila de postagem e pasta vigiada). Só vale no app instalado: no dev o caminho seria o
// electron.exe do projeto.

import { app } from 'electron'
import { isDev } from './paths'

export const HIDDEN_ARG = '--hidden'

export function applyAutostart(on: boolean): void {
  if (isDev) return
  app.setLoginItemSettings({ openAtLogin: on, args: [HIDDEN_ARG] })
}

/**
 * Modo econômico (aberto pelo Windows): sem aceleração de vídeo e sem o processo reserva do
 * Chromium. Chamar antes do app ficar pronto. Ao abrir a janela, o app reinicia no modo normal.
 */
export function enterLowPower(): void {
  app.disableHardwareAcceleration()
  app.commandLine.appendSwitch('disable-features', 'SpareRendererForSitePerProcess')
}

/** Reinicia o app (o novo abre quando este fecha). `hidden`: volta pro modo econômico, sem janela. */
export function relaunch(hidden: boolean): void {
  const args = process.argv.slice(1).filter((a) => a !== HIDDEN_ARG)
  app.relaunch({ args: hidden ? [...args, HIDDEN_ARG] : args })
  app.quit()
}

/** Aberto pelo Windows no login: não mostra janela. */
export function startedHidden(): boolean {
  return process.argv.includes(HIDDEN_ARG)
}
