import { strict as assert } from 'node:assert'
import { mkdtempSync } from 'node:fs'
import { rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app, BrowserWindow } from 'electron'

/** 独立开发页面地址，默认复用当前 Vite。 */
const fixtureUrl = `http://127.0.0.1:${process.env.PROMA_MEDIA_SMOKE_PORT ?? '5177'}/@fs${join(process.cwd(), 'scripts/canvas-comfyui-ui-smoke.html')}`

/** 有界等待真实 DOM，超时抛出当前交互断言。 */
async function waitFor(window: BrowserWindow, expression: string): Promise<void> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (await window.webContents.executeJavaScript(`Boolean(${expression})`)) return
    await new Promise<void>((resolve) => setTimeout(resolve, 40))
  }
  throw new Error(`界面条件未满足：${expression}`)
}

/** 用原生输入点击可见元素，经过 Radix 的真实 pointer 处理。 */
async function clickElement(window: BrowserWindow, expression: string): Promise<void> {
  await waitFor(window, expression)
  const point = await window.webContents.executeJavaScript(`(() => { const r = (${expression}).getBoundingClientRect(); return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}; })()`)
  window.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 })
  window.webContents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 })
}

/** 深浅主题与宽窄窗口各验证选择、失效保留、清空及边界。 */
async function verify(window: BrowserWindow, theme: string, width: number): Promise<void> {
  window.setContentSize(width, 720)
  await window.loadURL(`${fixtureUrl}?theme=${theme}`)
  /** 统一入口只在弹层中展示服务器，工具栏不再独占一个下拉控件。 */
  const mediaTrigger = `document.querySelector('button[title="画布媒体配置"]')`
  const panel = `document.querySelector('[role="dialog"][aria-label="画布媒体配置"]')`
  const trigger = `document.querySelector('[aria-label="画布默认 ComfyUI 服务器"]')`
  await waitFor(window, mediaTrigger)
  assert.equal(await window.webContents.executeJavaScript(`Boolean(${trigger})`), false)
  await clickElement(window, mediaTrigger)
  await waitFor(window, panel)
  await waitFor(window, trigger)
  assert.equal(await window.webContents.executeJavaScript('window.__comfySmoke.connectionId'), null)
  await clickElement(window, trigger)
  await clickElement(window, `[...document.querySelectorAll('[role=option]')].find((item) => item.textContent.includes('ComfyUI RTX 3090'))`)
  await waitFor(window, "window.__comfySmoke.connectionId === 'gpu-a'")
  await waitFor(window, "!document.querySelector('[role=listbox]')")
  await waitFor(window, panel)
  await clickElement(window, `document.querySelector('input[aria-label="GPT Image 2"]')`)
  await waitFor(window, "window.__comfySmoke.scope.mode === 'selected' && window.__comfySmoke.scope.modelIds.length === 0")
  assert.equal(await window.webContents.executeJavaScript('window.__comfySmoke.connectionId'), 'gpu-a')
  await window.webContents.executeJavaScript('window.__comfySmoke.markUnavailable()')
  await waitFor(window, `${trigger}.textContent.includes('不可用')`)
  await clickElement(window, trigger)
  await waitFor(window, "document.querySelector('[role=listbox]')")
  assert.equal(await window.webContents.executeJavaScript(`[...document.querySelectorAll('[role=option]')].find((item) => item.textContent.includes('ComfyUI RTX 3090')).getAttribute('aria-disabled')`), 'true')
  await window.webContents.executeJavaScript(`Promise.all(document.getAnimations().filter((animation) => Number.isFinite(animation.effect?.getComputedTiming().endTime)).map((animation) => animation.finished.catch(() => undefined))).then(() => true)`)
  await window.webContents.executeJavaScript('new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
  /** 分别记录生产工具栏、Portal 列表和触发器边界，缺失时给出可诊断结果。 */
  const bounds = await window.webContents.executeJavaScript(`['nav', '[role=dialog][aria-label="画布媒体配置"]', '[role=listbox]', '[aria-label="画布默认 ComfyUI 服务器"]'].map((selector) => {
    const element = document.querySelector(selector);
    if (!element) return { selector, present: false, fits: false };
    const rect = element.getBoundingClientRect();
    return { selector, present: true, fits: rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight };
  })`)
  assert.deepEqual(bounds, bounds.map((item: { selector: string }) => ({ selector: item.selector, present: true, fits: true })), `${theme}/${width} 控件缺失或越界`)
  await writeFile(`/private/tmp/canvas-comfyui-${theme}-${width}.png`, (await window.webContents.capturePage()).toPNG())
  await clickElement(window, `[...document.querySelectorAll('[role=option]')].find((item) => item.textContent.includes('不绑定服务器'))`)
  await waitFor(window, 'window.__comfySmoke.connectionId === null')
  assert.deepEqual(await window.webContents.executeJavaScript('window.__comfySmoke.changes'), ['gpu-a', null])
  assert.deepEqual(await window.webContents.executeJavaScript('window.__comfySmoke.scope'), { mode: 'selected', modelIds: [] })
  await waitFor(window, "!document.querySelector('[role=listbox]')")
  await writeFile(`/private/tmp/canvas-media-panel-${theme}-${width}.png`, (await window.webContents.capturePage()).toPNG())
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
  await waitFor(window, `!${panel}`)
  await clickElement(window, mediaTrigger)
  await waitFor(window, panel)
  assert.equal(await window.webContents.executeJavaScript(`document.querySelector('input[aria-label="GPT Image 2"]').checked`), false)
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
  await waitFor(window, `!${panel}`)
}

/** 验证音视频卡片的部分保存、重挂载恢复、错误与运行前校验，全程不点击运行。 */
async function verifyMediaWorkbench(window: BrowserWindow): Promise<void> {
  const media = `document.querySelector('[data-smoke-media]')`
  const save = `[...document.querySelectorAll('[data-smoke-media] button')].find((item) => item.textContent.trim() === '保存')`
  const run = `[...document.querySelectorAll('[data-smoke-media] button')].find((item) => item.textContent.trim() === '运行')`
  await waitFor(window, `${media} && !${media}.textContent.includes('加载媒体模块')`)
  await waitFor(window, `${media}.textContent.includes('待配置：节点 image 的参考图尚未绑定。')`)
  await waitFor(window, `${media}.textContent.includes('运行失败：远端节点 sampler 执行失败。')`)
  assert.equal(await window.webContents.executeJavaScript(`${run}.disabled`), true, '缺少必填素材时运行必须禁用')
  assert.equal(await window.webContents.executeJavaScript(`document.querySelectorAll('[data-smoke-media] details').length`), 1, '高级参数必须共用一个折叠组')
  assert.equal(await window.webContents.executeJavaScript(`${media}.textContent.includes('节点 text · text') && ${media}.textContent.includes('节点 image · image')`), true)

  await clickElement(window, save)
  await waitFor(window, 'window.__comfySmoke.mediaSaveCount === 1')
  await waitFor(window, `!${media}.textContent.includes('待配置：节点 image')`)
  await window.webContents.executeJavaScript('window.__comfySmoke.remountMedia()')
  await waitFor(window, `${media} && !${media}.textContent.includes('加载媒体模块')`)
  assert.equal(await window.webContents.executeJavaScript(`document.querySelector('[aria-label="提示词 值"]').value`), '已保存提示词')
  assert.equal(await window.webContents.executeJavaScript(`${media}.textContent.includes('待选择素材。')`), true)
  assert.equal(await window.webContents.executeJavaScript(`${run}.disabled`), true)

  const assetTrigger = `[...document.querySelectorAll('[data-smoke-media] button')].find((item) => item.textContent.includes('选择素材'))`
  await clickElement(window, assetTrigger)
  await clickElement(window, `[...document.querySelectorAll('[role=option]')].find((item) => item.textContent.includes('reference.png'))`)
  await waitFor(window, `${run} && !${run}.disabled`)
  await waitFor(window, "!document.querySelector('[role=listbox]')")
  assert.equal(await window.webContents.executeJavaScript('window.__comfySmoke.mediaRunCount'), 0, 'smoke 不得提交生成任务')
  await writeFile('/private/tmp/canvas-media-card-first-smoke.png', (await window.webContents.capturePage()).toPNG())
}

/** 隔离 Electron 窗口，退出时清理临时 userData。 */
async function run(): Promise<void> {
  const dataPath = mkdtempSync(join(tmpdir(), 'proma-canvas-comfyui-smoke-'))
  app.setPath('userData', dataPath)
  app.on('window-all-closed', () => {})
  await app.whenReady()
  const window = new BrowserWindow({ width: 1180, height: 720, show: false, webPreferences: { backgroundThrottling: false } })
  /** 将嵌套弹层的尺寸循环及渲染错误纳入回归，不能仅靠点击成功判断界面稳定。 */
  const rendererErrors: string[] = []
  window.webContents.on('console-message', (event) => {
    if (event.level === 'error') { rendererErrors.push(event.message); console.error(`[Canvas ComfyUI renderer] ${event.message}`) }
  })
  window.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedUrl) => {
    console.error(`[Canvas ComfyUI renderer] load failed ${errorCode}: ${errorDescription} (${validatedUrl})`)
  })
  try {
    await verify(window, 'dark', 1180)
    await verifyMediaWorkbench(window)
    await verify(window, 'light', 430)
    assert.deepEqual(rendererErrors, [], '统一媒体配置弹层不应产生渲染或尺寸循环错误')
    console.log('[Canvas ComfyUI smoke] PASS: 统一入口、部分保存重挂载、字段错误、统一高级参数、运行前校验与双主题宽窄窗口通过')
  } finally {
    window.destroy()
    await rm(dataPath, { recursive: true, force: true })
  }
}
void run().then(() => app.quit()).catch((error: unknown) => { console.error(error); app.exit(1) })
