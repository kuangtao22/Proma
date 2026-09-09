import { strict as assert } from 'node:assert'
import { mkdtempSync } from 'node:fs'
import { rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app, BrowserWindow } from 'electron'

/** 可选端口仅指向已运行的隔离 Vite，不启动或访问用户任务。 */
const fixtureUrl = `http://127.0.0.1:${process.env.PROMA_MEDIA_SMOKE_PORT ?? '5177'}/@fs${join(process.cwd(), 'scripts/canvas-node-motion-smoke.html')}`

/** 有界等待真实 DOM，失败时保留具体条件用于定位。 */
async function waitFor(window: BrowserWindow, expression: string): Promise<void> {
  /** 十秒只用于隔离页面首次编译，不增加产品运行时轮询。 */
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (await window.webContents.executeJavaScript(`Boolean(${expression})`)) return
    await new Promise<void>((resolve) => setTimeout(resolve, 40))
  }
  throw new Error(`界面条件未满足：${expression}`)
}

/** 点击 fixture 内明确命名的状态按钮。 */
async function clickState(window: BrowserWindow, label: string): Promise<void> {
  /** 按钮坐标只来自隔离页面自身 DOM。 */
  const point = await window.webContents.executeJavaScript(`(() => {
    const button = [...document.querySelectorAll('button')].find((item) => item.textContent?.trim() === ${JSON.stringify(label)});
    if (!button) return null;
    const rect = button.getBoundingClientRect();
    return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
  })()`)
  assert.ok(point, `找不到状态按钮：${label}`)
  window.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 })
  window.webContents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 })
}

/** 读取统一加载图标的实际样式与当前位置。 */
async function readMotion(window: BrowserWindow): Promise<Array<{ animationName: string; transform: string; visible: boolean }>> {
  return window.webContents.executeJavaScript(`[...document.querySelectorAll('[data-canvas-node-loading-indicator] svg')].map((element) => {
    const style = getComputedStyle(element);
    return { animationName: style.animationName, transform: style.transform,
      visible: element.getClientRects().length > 0 && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0' };
  })`)
}

/** 验证指定窗口和动态偏好下的完整状态变化。 */
async function verify(window: BrowserWindow, width: number, reducedMotion: boolean): Promise<void> {
  console.log(`[Canvas node motion smoke] 开始 ${width}px / ${reducedMotion ? 'reduce' : 'no-preference'}`)
  window.setContentSize(width, 760)
  if (reducedMotion) {
    /** CDP 只覆盖当前隔离窗口的媒体特性，退出即释放。 */
    window.webContents.debugger.attach('1.3')
    await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
    })
    /** 监听真实页面完成事件，避免调试器附着后的 loadURL Promise 不收口。 */
    const loaded = new Promise<void>((resolve) => window.webContents.once('did-finish-load', () => resolve()))
    window.webContents.reloadIgnoringCache()
    await loaded
  } else {
    await window.loadURL(fixtureUrl)
  }
  await waitFor(window, "document.querySelectorAll('[data-smoke-node]').length === 6")
  console.log('[Canvas node motion smoke] 页面已加载')
  assert.equal(await window.webContents.executeJavaScript("document.querySelector('[data-smoke-node=image] img') !== null"), true)

  await clickState(window, '排队')
  await waitFor(window, "document.querySelectorAll('[data-canvas-node-loading-indicator]').length === 6")
  await clickState(window, '运行')
  await waitFor(window, "document.querySelector('[data-smoke-state]').textContent.includes('running')")
  /** 第一帧和后续帧用于证明 transform 真实变化，而非只存在动画类名。 */
  const first = await readMotion(window)
  await new Promise<void>((resolve) => setTimeout(resolve, 180))
  const second = await readMotion(window)
  console.log('[Canvas node motion smoke] 动画帧已采样')
  assert.equal(first.length, 6)
  assert.equal(first.every((item) => item.visible), true)
  assert.equal(first.every((item) => reducedMotion ? item.animationName === 'none' : item.animationName !== 'none'), true)
  assert.equal(reducedMotion
    ? first.every((item, index) => item.transform === second[index]?.transform)
    : first.some((item, index) => item.transform !== second[index]?.transform), true)
  /** 重跑不替换已有图片内容，终态只移除加载反馈。 */
  assert.equal(await window.webContents.executeJavaScript("document.querySelector('[data-smoke-node=image] img') !== null"), true)
  await writeFile(`/private/tmp/canvas-node-motion-${width}-${reducedMotion ? 'reduced' : 'animated'}.png`, (await window.webContents.capturePage()).toPNG())
  await clickState(window, '终态')
  await waitFor(window, "document.querySelectorAll('[data-canvas-node-loading-indicator]').length === 0")
  assert.equal(await window.webContents.executeJavaScript("document.querySelector('[data-smoke-node=image] img') !== null"), true)
  console.log('[Canvas node motion smoke] 状态收口与截图完成')
}

/** 在临时 userData 中启动隐藏 Electron 窗口，完成后清理全部状态。 */
async function run(): Promise<void> {
  /** 隔离 userData 避免读取或覆盖用户客户端配置。 */
  const dataPath = mkdtempSync(join(tmpdir(), 'proma-canvas-node-motion-'))
  app.setPath('userData', dataPath)
  app.on('window-all-closed', () => {})
  await app.whenReady()
  console.log('[Canvas node motion smoke] Electron 已就绪')
  /** 隐藏窗口仍保留背景动画，便于采样真实 CSS 帧。 */
  const window = new BrowserWindow({ width: 1180, height: 760, show: false, webPreferences: { backgroundThrottling: false } })
  try {
    await verify(window, 1180, false)
    await verify(window, 430, false)
    await verify(window, 430, true)
    console.log('[Canvas node motion smoke] PASS: 宽窄窗口、首次运行、已有内容重跑、终态与减少动态效果通过')
  } finally {
    if (window.webContents.debugger.isAttached()) window.webContents.debugger.detach()
    window.destroy()
    await rm(dataPath, { recursive: true, force: true })
  }
}

void run().then(() => app.quit()).catch((error: unknown) => { console.error(error); app.exit(1) })
