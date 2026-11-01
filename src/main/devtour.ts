// Roteiro de teste de ponta a ponta (só em dev). Ativado por variáveis de ambiente:
//   CLIPADOR_USERDATA  pasta de dados separada (não mexe nos dados reais)
//   CLIPADOR_SHOTS     pasta onde salvar os prints de cada tela
//   CLIPADOR_IMPORT    vídeo pra importar no começo
//   CLIPADOR_LLM       "local" ou "openai"
//   CLIPADOR_QUIT=1    fecha o app no fim

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, type BrowserWindow } from 'electron'
import { clipsRepo, postsRepo, projectsRepo } from './db'
import { createProfile, selectProfile, updateProfile } from './profiles'
import { createProject } from './projects'
import { enqueueAnalysis } from './pipeline'
import { defaultAutoPost } from '@shared/defaults'
import { isDev } from './paths'
import { killAllProcesses } from './proc'
import { updateSettings } from './settings'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export function applyDevUserData(): void {
  const dir = process.env.CLIPADOR_USERDATA
  // também no app instalado: medir consumo e testar sem tocar nos dados reais
  if (dir) {
    mkdirSync(dir, { recursive: true })
    app.setPath('userData', dir)
  }
  if (isDev && process.env.CLIPADOR_SHOTS) {
    // janela coberta por outras deixa de pintar no Windows e o print sai velho
    app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')
    app.commandLine.appendSwitch('disable-renderer-backgrounding')
    app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
  }
}

/** Antes de ligar a pasta vigiada: aponta pra pasta de teste (CLIPADOR_WATCH). */
export function applyDevSettings(): void {
  if (!isDev || !process.env.CLIPADOR_USERDATA) return
  const watch = process.env.CLIPADOR_WATCH
  updateSettings(watch ? { watchFolder: watch, watchEnabled: true } : { watchEnabled: false })
  if (process.env.CLIPADOR_LLM === 'local' || process.env.CLIPADOR_LLM === 'openai') {
    updateSettings({ llmProvider: process.env.CLIPADOR_LLM })
  }
}

async function waitFor(cond: () => boolean, timeoutMs: number, stepMs = 1000): Promise<boolean> {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    if (cond()) return true
    await sleep(stepMs)
  }
  return cond()
}

export async function runDevTour(win: BrowserWindow): Promise<void> {
  const dir = process.env.CLIPADOR_SHOTS
  if (!isDev || !dir) return
  mkdirSync(dir, { recursive: true })
  const log = (m: string): void => console.log(`[tour] ${m}`)
  const js = <T = unknown>(code: string): Promise<T> => win.webContents.executeJavaScript(code) as Promise<T>
  const shot = async (name: string): Promise<void> => {
    // janela atrás de outras não repinta sozinha: força um frame novo antes do print
    win.webContents.invalidate()
    await sleep(900)
    const img = await win.webContents.capturePage()
    writeFileSync(join(dir, `${name}.png`), img.toPNG())
    log(`print ${name}`)
  }
  const store = (expr: string): Promise<unknown> => js(`(async () => { const s = window.__store.getState(); ${expr} })()`)

  try {
    await waitFor(() => !win.webContents.isLoading(), 30000)
    await sleep(1500)

    // CLIPADOR_TOUR=quick: só prints das telas de um projeto já analisado
    if (process.env.CLIPADOR_TOUR === 'quick') {
      const p = projectsRepo.all()[0]
      if (p) {
        await store(`await s.openProject(${JSON.stringify(p.id)}, 'revisar')`)
        await sleep(3000)
        await shot('q1-revisar')
        await store(`await s.openProject(${JSON.stringify(p.id)}, 'clipar')`)
        await sleep(3000)
        await shot('q2-clipar')
        await js(`[...document.querySelectorAll('button')].find((b) => b.textContent.includes('Adicionar corte manual'))?.click()`)
        await sleep(2500)
        await shot('q2b-corte-manual')
        await js(`document.querySelector('[aria-label="Aproximar"]')?.click()`)
        await sleep(300)
        await js(`document.querySelector('[aria-label="Aproximar"]')?.click()`)
        await sleep(1500)
        await shot('q2c-corte-manual-zoom')
        await js(`document.querySelector('.modal-actions .btn')?.click()`)
      }
      await store(`s.go({ name: 'settings' })`)
      await sleep(2500)
      await shot('q3-configuracoes')
      await js(`document.querySelector('.screen')?.scrollTo(0, 820)`)
      await sleep(800)
      await shot('q4-configuracoes-estilo')
      await store(`s.go({ name: 'posts' })`)
      await sleep(2000)
      await shot('q5-agendados')
      await js(`[...document.querySelectorAll('[role=tab]')].find((b) => b.textContent.startsWith('Todos'))?.click()`)
      await sleep(800)
      await shot('q6-agendados-todos')
      if (p) {
        await store(`s.go({ name: 'home', focus: ${JSON.stringify(p.id)} })`)
        await sleep(1500)
        await shot('q7-inicio-analise')
      }
      return
    }

    // CLIPADOR_TOUR=podcast: perfil de podcast com postagem automática, vídeo importado como automático
    if (process.env.CLIPADOR_TOUR === 'podcast') {
      await podcastTour(shot, store, js, log)
      return
    }

    await shot('01-inicio')

    const file = process.env.CLIPADOR_IMPORT
    if (file) await js(`window.api.invoke('projects:import', ${JSON.stringify(file)})`)
    const project = () => projectsRepo.all()[0] ?? null
    // sem import explícito, espera a pasta vigiada pegar o arquivo
    await waitFor(() => project() !== null, 2 * 60 * 1000)
    await sleep(4000)
    await shot('02-inicio-analisando')

    const p0 = project()
    if (!p0) return
    // abre a tela de clipar enquanto ainda analisa (liberação progressiva)
    await waitFor(() => clipsRepo.byProject(p0.id).length > 0, 10 * 60 * 1000)
    await store(`await s.openProject(${JSON.stringify(p0.id)}, 'clipar')`)
    await sleep(2500)
    await shot('03-clipar-progressivo')

    await waitFor(() => project()?.status === 'ready' || project()?.status === 'error', 20 * 60 * 1000, 2000)
    log(`análise: ${project()?.status} ${project()?.error ?? ''}`)
    const clips = clipsRepo.byProject(p0.id)
    log(`cortes: ${clips.map((c) => `${c.number}:${c.stage}:${c.llm?.score ?? '-'}:${c.stageError ?? ''}`).join(' | ')}`)
    await store(`await s.openProject(${JSON.stringify(p0.id)}, 'clipar')`)
    await sleep(2500)
    // toca o primeiro corte uns segundos pro preview ter imagem
    await js(`document.querySelector('.play-btn')?.click()`)
    await sleep(3500)
    await shot('04-clipar')
    await js(`document.querySelector('.play-btn.on')?.click()`)
    await sleep(800)
    // pausado: textos editáveis; arrasta o gancho pra baixo e a timeline do 1º corte (anda pela live)
    await js(`(() => {
      const drag = (el, x0, y0, x1, y1) => {
        const o = (x, y) => ({ bubbles: true, clientX: x, clientY: y, pointerId: 7, button: 0, pointerType: 'mouse', isPrimary: true })
        el.dispatchEvent(new PointerEvent('pointerdown', o(x0, y0)))
        for (let i = 1; i <= 10; i++) el.dispatchEvent(new PointerEvent('pointermove', o(x0 + ((x1 - x0) * i) / 10, y0 + ((y1 - y0) * i) / 10)))
        el.dispatchEvent(new PointerEvent('pointerup', o(x1, y1)))
      }
      const hook = document.querySelector('.text-box.hook')
      if (hook) { const r = hook.getBoundingClientRect(); drag(hook, r.x + r.width / 2, r.y + r.height / 2, r.x + r.width / 2, r.y + r.height / 2 + 60) }
      const wave = document.querySelector('.clip-row.sel .wave')
      if (wave) { const r = wave.getBoundingClientRect(); drag(wave, r.x + r.width * 0.97, r.y + 30, r.x + r.width * 0.6, r.y + 30) }
    })()`)
    await sleep(1500)
    await shot('04b-clipar-textos-e-timeline')
    const c1 = clipsRepo.byProject(p0.id).sort((a, b) => a.number - b.number)[0]!
    log(`timeline: janela ${c1.winStart}-${c1.winEnd} · ${JSON.stringify(c1.hookStyle)}`)

    // corte manual: quanto tempo até o preview aparecer (o proxy está rodando agora)
    const t0 = Date.now()
    const manual = await js<{ id: string }>(`window.api.invoke('clips:create-manual', ${JSON.stringify(p0.id)}, 200)`)
    await waitFor(() => !!clipsRepo.get(manual.id)?.previewPath, 3 * 60 * 1000, 250)
    log(`corte manual: preview em ${((Date.now() - t0) / 1000).toFixed(1)} s (proxy: ${projectsRepo.get(p0.id)?.stages.proxy.status})`)
    await waitFor(() => !!clipsRepo.get(manual.id)?.words, 3 * 60 * 1000, 250)
    log(`corte manual: transcrição em ${((Date.now() - t0) / 1000).toFixed(1)} s`)

    // move um corte pra fora da janela original: tem que gerar preview e transcrição do pedaço novo
    const before = clipsRepo.get(c1.id)!
    const newIn = Math.round(before.winEnd + 20)
    const t1 = Date.now()
    await js(`window.api.invoke('clips:update', ${JSON.stringify(c1.id)}, { cutIn: ${newIn}, cutOut: ${newIn + 20} })`)
    await waitFor(() => {
      const x = clipsRepo.get(c1.id)!
      return x.previewStart !== null && x.previewEnd !== null && x.previewStart <= x.cutIn && x.previewEnd >= x.cutOut && (x.wordsTo ?? 0) >= x.cutOut
    }, 3 * 60 * 1000, 250)
    const after = clipsRepo.get(c1.id)!
    log(
      `corte movido: ${before.cutIn}-${before.cutOut} → ${after.cutIn}-${after.cutOut}, janela ${after.winStart}-${after.winEnd}, ` +
        `preview ${after.previewStart}-${after.previewEnd}, palavras ${before.words?.length}→${after.words?.length} ` +
        `(${after.wordsFrom}-${after.wordsTo}) em ${((Date.now() - t1) / 1000).toFixed(1)} s`
    )
    await store(`await s.openProject(${JSON.stringify(p0.id)}, 'clipar')`)
    await sleep(1500)
    await js(`document.querySelector('.filter-btn:last-child')?.click()`)
    await sleep(1200)
    await shot('04c-clipar-filtro-manuais')
    await js(`document.querySelector('.filter-btn')?.click()`)

    // aprova os 2 melhores e manda preparar
    const best = [...clips].sort((a, b) => (b.llm?.score ?? b.signalScore * 100) - (a.llm?.score ?? a.signalScore * 100)).slice(0, 2)
    for (const c of best) await js(`window.api.invoke('clips:update', ${JSON.stringify(c.id)}, { approved: true, zoomEnabled: true })`)
    await js(`window.api.invoke('clips:prepare', ${JSON.stringify(best.map((c) => c.id))})`)
    await store(`await s.openProject(${JSON.stringify(p0.id)}, 'revisar')`)
    await sleep(2500)
    await shot('05-revisar-preparando')

    await waitFor(
      () => best.every((c) => {
        const x = clipsRepo.get(c.id)
        return x?.render.status === 'done' || x?.render.status === 'error' || x?.prep === 'error'
      }),
      10 * 60 * 1000,
      2000
    )
    for (const c of best) {
      const x = clipsRepo.get(c.id)
      log(`render ${x?.number}: ${x?.render.status} ${x?.render.path ?? ''} ${x?.render.error ?? ''} prep=${x?.prep} ${x?.prepMessage ?? ''}`)
    }
    await store(`await s.openProject(${JSON.stringify(p0.id)}, 'revisar')`)
    await sleep(2000)
    await js(`document.querySelector('.p916-canvas, .p916-placeholder')?.click()`)
    await sleep(1200)
    await shot('06-revisar')
    await js(`document.querySelector('.p916-canvas')?.click()`)

    await store(`s.go({ name: 'settings' })`)
    await sleep(2500)
    await shot('07-configuracoes')
    // aba do texto inicial com máquina de escrever, e modo posicionar
    await js(`document.querySelectorAll('.style-form [role=tab]')[1]?.click()`)
    await sleep(400)
    await js(`(() => { const s = [...document.querySelectorAll('.style-form select')].find((x) => [...x.options].some((o) => o.value === 'typewriter')); if (s) { const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set; set.call(s, 'typewriter'); s.dispatchEvent(new Event('change', { bubbles: true })) } })()`)
    await sleep(1300)
    await shot('08-config-texto-inicial')
  } catch (e) {
    log(`erro: ${(e as Error).stack ?? e}`)
  } finally {
    if (process.env.CLIPADOR_QUIT === '1') {
      log('fim')
      // app.exit não dispara before-quit
      killAllProcesses()
      app.exit(0)
    }
  }
}

async function podcastTour(
  shot: (name: string) => Promise<void>,
  store: (expr: string) => Promise<unknown>,
  js: <T = unknown>(code: string) => Promise<T>,
  log: (m: string) => void
): Promise<void> {
  const prof = createProfile({ name: 'cortes do broxada', kind: 'podcast', subject: 'podcast Broxada Sinistra' })
  updateProfile(prof.id, { autoPost: { ...defaultAutoPost(), enabled: true, minScore: 50, networks: ['youtube', 'tiktok'] } })
  createProfile({ name: 'cortes alanzoka', kind: 'gameplay', subject: 'streamer Alanzoka' })
  selectProfile(prof.id)
  await store(`s.set({ profiles: await window.api.invoke('profiles:list') }); s.go({ name: 'profiles' })`)
  await sleep(1500)
  await shot('p1-perfis')
  await js(`[...document.querySelectorAll('.profile-tile')].find((b) => b.textContent.includes('Novo perfil'))?.click()`)
  await sleep(800)
  await shot('p2-novo-perfil')
  await js(`document.querySelector('.modal-actions .btn')?.click()`)
  await store(`await s.selectProfile(${JSON.stringify(prof.id)})`)
  const file = process.env.CLIPADOR_IMPORT
  if (!file) return
  const p0 = createProject(file, { profileId: prof.id, auto: true, name: 'EP teste' })
  enqueueAnalysis(p0.id)
  await sleep(3000)
  await shot('p3-inicio-podcast')
  await waitFor(() => clipsRepo.byProject(p0.id).length > 0, 15 * 60 * 1000)
  await store(`await s.openProject(${JSON.stringify(p0.id)}, 'clipar')`)
  await sleep(3000)
  await shot('p4-clipar-progressivo')
  await waitFor(() => ['ready', 'error'].includes(projectsRepo.get(p0.id)?.status ?? ''), 20 * 60 * 1000, 2000)
  const p = projectsRepo.get(p0.id)!
  log(`análise: ${p.status} ${p.error ?? ''} · etapas ${JSON.stringify(Object.fromEntries(Object.entries(p.stages).map(([k, v]) => [k, v.status])))}`)
  for (const c of clipsRepo.byProject(p0.id)) {
    log(`corte ${c.number}: ${c.cutIn}-${c.cutOut} (${(c.cutOut - c.cutIn).toFixed(0)} s) nota ${c.llm?.score} "${c.llm?.title}" ganchos ${JSON.stringify(c.llm?.hooks)}`)
    const text = (c.words ?? []).filter((w) => w.s >= c.cutIn && w.e <= c.cutOut).map((w) => w.w).join(' ')
    log(`   texto: ${text.slice(0, 160)} … ${text.slice(-160)}`)
  }
  // postagem automática: espera os posts aparecerem (agendados sem conta conectada: ficam esperando)
  await waitFor(() => postsRepo.all(p0.id).length > 0, 10 * 60 * 1000, 2000)
  for (const post of postsRepo.all(p0.id)) log(`post ${post.network} ${post.scheduledAt} auto=${post.auto} "${post.title ?? post.text.slice(0, 60)}"`)
  await waitFor(
    () => clipsRepo.byProject(p0.id).filter((c) => c.approved).every((c) => ['done', 'error'].includes(c.render.status)),
    15 * 60 * 1000,
    2000
  )
  for (const c of clipsRepo.byProject(p0.id).filter((x) => x.approved)) {
    log(`render ${c.number} (${c.layout}): ${c.render.status} ${c.render.path ?? ''} ${c.render.error ?? ''} planos ${JSON.stringify(c.faces?.shots)}`)
  }
  await store(`await s.openProject(${JSON.stringify(p0.id)}, 'clipar')`)
  await sleep(2500)
  await js(`document.querySelector('.play-btn')?.click()`)
  await sleep(4000)
  await shot('p5-clipar-seguindo-rosto')
  await js(`document.querySelector('.play-btn.on')?.click()`)
  await js(`[...document.querySelectorAll('.seg button')].find((b) => b.textContent === 'Vídeo inteiro')?.click()`)
  await sleep(2500)
  await shot('p6-clipar-video-inteiro')
  await store(`await s.openProject(${JSON.stringify(p0.id)}, 'revisar')`)
  await sleep(2500)
  await shot('p7-revisar')
  await store(`s.go({ name: 'home' })`)
  await sleep(1500)
  await shot('p8-inicio-pronto')
  await store(`s.go({ name: 'settings' })`)
  await sleep(2500)
  await shot('p9-config-perfil')
  await store(`s.go({ name: 'posts' })`)
  await sleep(2000)
  await shot('p10-agendados')
}
