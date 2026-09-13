import { strict as assert } from 'node:assert'
import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app, BrowserWindow } from 'electron'
import type { MouseWheelInputEvent, WebFrameMain } from 'electron'

/** D3、可见 DOM 与文档回显共用的视口结构。 */
interface CanvasViewport { x: number; y: number; zoom: number }
/** 复用主任务已经启动的 Vite，测试进程只创建隔离 Electron 窗口。 */
const fixtureUrl = `http://127.0.0.1:${process.env.PROMA_CANVAS_SMOKE_PORT ?? '5193'}/@fs${join(process.cwd(), 'scripts/canvas-workbench-wheel-smoke.html')}`
const tolerance = 0.02
/** Electron 只接受其声明的键盘修饰符联合。 */
type ElectronModifiers = NonNullable<MouseWheelInputEvent['modifiers']>

/** 有界等待真实 DOM 或手势状态，避免固定长延时掩盖竞态。 */
async function waitFor(window: BrowserWindow, expression: string, message: string, timeout = 12_000): Promise<void> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await window.webContents.executeJavaScript(`Boolean(${expression})`)) return
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(message)
}

/** 读取真实 D3 内部变换与 Jotai 文档回显。 */
async function readViewport(window: BrowserWindow): Promise<{ d3: CanvasViewport; rendered: CanvasViewport; document: CanvasViewport }> {
  return window.webContents.executeJavaScript(`(() => {
    const renderer = document.querySelector('.react-flow__renderer');
    const viewportElement = document.querySelector('.react-flow__viewport');
    if (!renderer?.__zoom || !viewportElement) throw new Error('画布视口尚未就绪');
    const matrix = new DOMMatrixReadOnly(getComputedStyle(viewportElement).transform);
    const viewport = window.__canvasWorkbenchWheelSmoke.document().viewport;
    return {
      d3: { x: renderer.__zoom.x, y: renderer.__zoom.y, zoom: renderer.__zoom.k },
      rendered: { x: matrix.m41, y: matrix.m42, zoom: matrix.m11 },
      document: viewport,
    };
  })()`)
}

/** 获取目标中心点，每次视口变化后重新测量，避免使用过时坐标。 */
async function pointFor(window: BrowserWindow, selector: string): Promise<{ x: number; y: number }> {
  const point = await window.webContents.executeJavaScript(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + Math.min(rect.height / 2, 20)) };
  })()`)
  assert.ok(point, `找不到滚轮目标：${selector}`)
  return point
}

/** 向目标 DOM 发送真实滚轮事件。 */
async function wheel(window: BrowserWindow, selector: string, deltaX: number, deltaY: number, modifiers: ElectronModifiers = []): Promise<void> {
  window.webContents.focus()
  const point = await pointFor(window, selector)
  /** 先更新真实命中目标，Chromium 的跨 frame wheel 路由依赖当前指针位置。 */
  window.webContents.sendInputEvent({ type: 'mouseMove', ...point })
  await new Promise<void>((resolve) => setTimeout(resolve, 20))
  window.webContents.sendInputEvent({ type: 'mouseWheel', ...point, deltaX, deltaY, canScroll: true, modifiers })
}

/** Chromium 调试协议可把真实 wheel 命中 sandbox 子 frame 的合成层。 */
async function iframeWheel(window: BrowserWindow, deltaY: number, modifiers: ElectronModifiers = []): Promise<void> {
  const point = await pointFor(window, 'iframe[title="滚轮 iframe"]')
  if (!window.webContents.debugger.isAttached()) window.webContents.debugger.attach('1.3')
  const modifierMask = (modifiers.includes('control') ? 2 : 0) | (modifiers.includes('meta') ? 4 : 0)
  await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
  await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
    type: 'mouseWheel', ...point, deltaX: 0, deltaY, modifiers: modifierMask,
  })
}

/** 通过真实坐标点击按钮或 Portal trigger。 */
async function click(window: BrowserWindow, selector: string): Promise<void> {
  const point = await pointFor(window, selector)
  window.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 })
  window.webContents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 })
}

/** 对比视口，普通控件 wheel 不允许产生任何画布位移。 */
function assertViewportEqual(actual: CanvasViewport, expected: CanvasViewport, label: string): void {
  assert.ok(Math.abs(actual.x - expected.x) <= tolerance, `${label}.x 应为 ${expected.x}，实际 ${actual.x}`)
  assert.ok(Math.abs(actual.y - expected.y) <= tolerance, `${label}.y 应为 ${expected.y}，实际 ${actual.y}`)
  assert.ok(Math.abs(actual.zoom - expected.zoom) <= tolerance, `${label}.zoom 应为 ${expected.zoom}，实际 ${actual.zoom}`)
}

/** D3 内部值必须真实进入可见 DOM，排除仅状态改变的假阳性。 */
async function assertRenderedMatchesD3(window: BrowserWindow, label: string): Promise<void> {
  await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
  const sample = await readViewport(window)
  assertViewportEqual(sample.rendered, sample.d3, `${label} 可见 transform`)
}

/** 等待当前手势的延迟结束值进入 Jotai 文档，再开始下一个隔离场景。 */
async function waitForViewportCommit(window: BrowserWindow, label: string): Promise<void> {
  const expected = (await readViewport(window)).d3
  await waitFor(window, `(() => { const viewport = window.__canvasWorkbenchWheelSmoke.document().viewport;
    return Math.abs(viewport.x - ${expected.x}) < ${tolerance} && Math.abs(viewport.y - ${expected.y}) < ${tolerance}
      && Math.abs(viewport.zoom - ${expected.zoom}) < ${tolerance}; })()`, `${label}没有提交到 Jotai 文档`, 2_000)
}

/** 直接读取 sandbox 子 frame 的滚动位置，不为生产 iframe 开放同源权限。 */
async function waitForIframeScroll(window: BrowserWindow): Promise<void> {
  const deadline = Date.now() + 1_500
  while (Date.now() < deadline) {
    for (const frame of window.webContents.mainFrame.frames) {
      if (frame === window.webContents.mainFrame || frame.detached) continue
      const scrollY: unknown = await frame.executeJavaScript('window.scrollY')
      if (typeof scrollY === 'number' && scrollY > 0) return
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('iframe 普通滚轮没有保留内部滚动')
}

/** 返回生产预览创建的 sandbox 子 frame。 */
function getIframeFrame(window: BrowserWindow): WebFrameMain {
  const frame = window.webContents.mainFrame.frames.find((candidate) => candidate !== window.webContents.mainFrame && !candidate.detached)
  assert.ok(frame, '找不到 sandbox iframe frame')
  return frame
}

/** 重挂载 Graph 回到稳定视口，并等待真实 D3 完成初始化。 */
async function reset(window: BrowserWindow): Promise<CanvasViewport> {
  await window.webContents.executeJavaScript('window.__canvasWorkbenchWheelSmoke.reset()')
  await waitFor(window, `(() => { const z = document.querySelector('.react-flow__renderer')?.__zoom; return z && Math.abs(z.x) < ${tolerance} && Math.abs(z.y) < ${tolerance} && Math.abs(z.k - 0.5) < ${tolerance}; })()`, '画布没有重置')
  return (await readViewport(window)).d3
}

/** 标题、普通空白及无溢出列表都应把双指平移交给画布。 */
async function verifyCanvasPanRegions(window: BrowserWindow): Promise<void> {
  for (const [selector, label] of [
    ['[aria-label="文档工作台"] > header', '标题'],
    ['[data-smoke-blank] > div:last-child > div:last-child', '详情空白'],
    ['[data-smoke-nonoverflow]', '无溢出列表'],
  ] as const) {
    const before = await reset(window)
    await wheel(window, selector, -24, -10)
    await waitFor(window, `Math.abs(document.querySelector('.react-flow__renderer').__zoom.x - (${before.x - 12})) < ${tolerance}`, `${label}双指平移没有移动画布`, 800)
    const after = (await readViewport(window)).d3
    const expected = { x: before.x - 12, y: before.y - 5, zoom: before.zoom }
    assertViewportEqual(after, expected, `${label}双指平移`)
    await assertRenderedMatchesD3(window, `${label}双指平移`)
    /** 等待本轮延迟结束提交，避免上一场景的合法回显进入下一次 reset。 */
    await waitFor(window, `(() => { const viewport = window.__canvasWorkbenchWheelSmoke.document().viewport;
      return Math.abs(viewport.x - ${expected.x}) < ${tolerance} && Math.abs(viewport.y - ${expected.y}) < ${tolerance}; })()`, `${label}双指平移没有提交文档`, 2_000)
  }
}

/** 真溢出列表及编辑控件保留普通 wheel，画布视口保持不变。 */
async function verifyNativeWheelRegions(window: BrowserWindow): Promise<void> {
  const before = await reset(window)
  const scrollViewport = '[data-smoke-scroll] [data-radix-scroll-area-viewport]'
  await window.webContents.executeJavaScript('window.__canvasWorkbenchWheelSmoke.lastWorkbenchWheelPrevented = null')
  await wheel(window, scrollViewport, 0, -80)
  await waitFor(window, `document.querySelector(${JSON.stringify(scrollViewport)}).scrollTop > 0`, '真溢出列表没有滚动')
  assertViewportEqual((await readViewport(window)).d3, before, '真溢出列表滚动')
  assert.equal(await window.webContents.executeJavaScript('window.__canvasWorkbenchWheelSmoke.lastWorkbenchWheelPrevented'), false, '真溢出列表普通 wheel 不应被阻止')
  await window.webContents.executeJavaScript(`(() => { const element = document.querySelector(${JSON.stringify(scrollViewport)}); element.scrollTop = element.scrollHeight; })()`)
  await wheel(window, scrollViewport, 0, -80)
  await new Promise<void>((resolve) => setTimeout(resolve, 80))
  assertViewportEqual((await readViewport(window)).d3, before, '列表到底继续独占滚动')

  /** Chromium 会锁定一段连续滚轮到首个目标，停顿后再切换编辑控件。 */
  await new Promise<void>((resolve) => setTimeout(resolve, 180))
  await window.webContents.executeJavaScript(`document.querySelector('[data-smoke-textarea]').focus()`)
  await window.webContents.executeJavaScript('window.__canvasWorkbenchWheelSmoke.lastWorkbenchWheelPrevented = null')
  await wheel(window, '[data-smoke-textarea]', 0, -160)
  await waitFor(window, `document.querySelector('[data-smoke-textarea]').scrollTop > 0`, 'textarea 没有保留内部滚动', 1_500)
  assertViewportEqual((await readViewport(window)).d3, before, 'textarea 普通滚动')
  assert.equal(await window.webContents.executeJavaScript('window.__canvasWorkbenchWheelSmoke.lastWorkbenchWheelPrevented'), false, 'textarea 普通 wheel 不应被阻止')
  for (const selector of ['[data-smoke-number]', '[data-smoke-range]', '[data-smoke-media]']) {
    await new Promise<void>((resolve) => setTimeout(resolve, 180))
    await window.webContents.executeJavaScript(`window.__canvasWorkbenchWheelSmoke.lastWorkbenchWheelPrevented = null; document.querySelector(${JSON.stringify(selector)}).focus()`)
    await wheel(window, selector, 0, -40)
    await new Promise<void>((resolve) => setTimeout(resolve, 30))
    assertViewportEqual((await readViewport(window)).d3, before, `${selector} 普通滚动`)
    assert.equal(await window.webContents.executeJavaScript('window.__canvasWorkbenchWheelSmoke.lastWorkbenchWheelPrevented'), false, `${selector} 普通 wheel 不应被阻止`)
  }
}

/** Ctrl 捏合与 Command 滚轮在详情所有关键区域都应缩放画布。 */
async function verifyZoomEverywhere(window: BrowserWindow): Promise<void> {
  const scenarios: ReadonlyArray<readonly [string, ElectronModifiers]> = [
    ['[aria-label="文档工作台"] > header', ['control']],
    ['[data-smoke-scroll] [data-radix-scroll-area-viewport]', ['control']],
    ['[data-smoke-textarea]', ['meta']],
    ['[data-smoke-number]', ['control']],
    ['button[aria-label="调整工作台大小"]', ['meta']],
  ]
  for (const [selector, modifiers] of scenarios) {
    const before = await reset(window)
    const inputValue = await window.webContents.executeJavaScript(`document.querySelector('[data-smoke-number]').value`)
    const listScroll = await window.webContents.executeJavaScript(`document.querySelector('[data-smoke-scroll] [data-radix-scroll-area-viewport]').scrollTop`)
    await wheel(window, selector, 0, 60, modifiers)
    await waitFor(window, `document.querySelector('.react-flow__renderer').__zoom.k > ${before.zoom + tolerance}`, `${selector} 修饰滚轮没有缩放画布`, 800)
    await assertRenderedMatchesD3(window, `${selector} 修饰滚轮缩放`)
    assert.equal(await window.webContents.executeJavaScript(`document.querySelector('[data-smoke-number]').value`), inputValue, '缩放不能修改数字输入')
    assert.equal(await window.webContents.executeJavaScript(`document.querySelector('[data-smoke-scroll] [data-radix-scroll-area-viewport]').scrollTop`), listScroll, '缩放不能滚动详情列表')
    await waitForViewportCommit(window, `${selector} 修饰滚轮缩放`)
  }
}

/** Radix Portal 普通滚动留在菜单，修饰滚轮仍能缩放底层画布。 */
async function verifySelectPortal(window: BrowserWindow): Promise<void> {
  const before = await reset(window)
  await click(window, '[data-smoke-select]')
  await waitFor(window, `document.querySelector('[role="listbox"]')`, 'Select Portal 没有打开')
  await wheel(window, '[role="listbox"]', 0, -80)
  await new Promise<void>((resolve) => setTimeout(resolve, 80))
  assert.ok(await window.webContents.executeJavaScript(`document.querySelector('[role="listbox"]') !== null`), '普通滚动不应关闭 Select')
  assertViewportEqual((await readViewport(window)).d3, before, 'Select Portal 普通滚动')
  await wheel(window, '[role="listbox"]', 0, 60, ['control'])
  await waitFor(window, `document.querySelector('.react-flow__renderer').__zoom.k > ${before.zoom + tolerance}`, 'Select Portal 内不能缩放画布', 800)
  assert.ok(await window.webContents.executeJavaScript(`document.querySelector('[role="listbox"]') !== null`), '缩放不应关闭 Select')
  await waitForViewportCommit(window, 'Select Portal 缩放')
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
}

/** sandbox iframe 内部普通滚动自理，Ctrl 捏合通过生产消息桥缩放画布。 */
async function verifyIframeBridge(window: BrowserWindow): Promise<void> {
  const before = await reset(window)
  await new Promise<void>((resolve) => setTimeout(resolve, 180))
  await iframeWheel(window, 80)
  await waitForIframeScroll(window)
  assertViewportEqual((await readViewport(window)).d3, before, 'iframe 普通滚动')
  await iframeWheel(window, -60, ['control'])
  await waitFor(window, `document.querySelector('.react-flow__renderer').__zoom.k > ${before.zoom + tolerance}`, 'iframe Ctrl 滚轮没有缩放画布', 1_000)
  await assertRenderedMatchesD3(window, 'iframe Ctrl 滚轮缩放')
  await waitForViewportCommit(window, 'iframe Ctrl 滚轮缩放')
  /** 同一真实 iframe 连续接受两类手势，避免测试重挂载制造跨 frame wheel 锁定。 */
  const beforeMeta = (await readViewport(window)).d3
  await iframeWheel(window, -60, ['meta'])
  await waitFor(window, `document.querySelector('.react-flow__renderer').__zoom.k > ${beforeMeta.zoom + tolerance}`, 'iframe Command 滚轮没有缩放画布', 1_000)
  await assertRenderedMatchesD3(window, 'iframe Command 滚轮缩放')
  await waitForViewportCommit(window, 'iframe Command 滚轮缩放')
}

/** iframe 脚本不能伪造公开消息或合成 wheel 来驱动画布。 */
async function verifyIframeForgeryRejected(window: BrowserWindow): Promise<void> {
  const before = await reset(window)
  const frame = getIframeFrame(window)
  await frame.executeJavaScript(`parent.postMessage({
    type: 'proma:canvas-webview-viewport-wheel', deltaX: 0, deltaY: -60, deltaZ: 0, deltaMode: 0,
    clientX: 20, clientY: 20, ctrlKey: true, metaKey: false,
  }, '*')`)
  await new Promise<void>((resolve) => setTimeout(resolve, 250))
  assertViewportEqual((await readViewport(window)).d3, before, 'iframe 公开消息伪造')
  await frame.executeJavaScript(`dispatchEvent(new WheelEvent('wheel', {
    bubbles: true, cancelable: true, deltaY: -60, clientX: 20, clientY: 20, ctrlKey: true,
  }))`)
  await new Promise<void>((resolve) => setTimeout(resolve, 250))
  assertViewportEqual((await readViewport(window)).d3, before, 'iframe 合成 wheel 伪造')
}

/** 缩放后立即连续平移，确保详情事件转发不重新引入旧视口回跳。 */
async function verifyZoomPanRace(window: BrowserWindow): Promise<void> {
  await reset(window)
  await wheel(window, '[aria-label="文档工作台"] > header', 0, 40, ['control'])
  await waitFor(window, `document.querySelector('.react-flow__renderer').__zoom.k > 0.52`, '连续场景缩放未开始', 800)
  const zoomed = (await readViewport(window)).d3
  for (let frame = 1; frame <= 12; frame += 1) {
    await wheel(window, '[aria-label="文档工作台"] > header', -24, -10)
    const expected = { x: zoomed.x - frame * 12, y: zoomed.y - frame * 5, zoom: zoomed.zoom }
    await waitFor(window, `(() => { const z = document.querySelector('.react-flow__renderer').__zoom; return Math.abs(z.x - ${expected.x}) < ${tolerance} && Math.abs(z.y - ${expected.y}) < ${tolerance}; })()`, `连续平移第 ${frame} 帧回跳`, 500)
    assertViewportEqual((await readViewport(window)).d3, expected, `连续平移第 ${frame} 帧`)
    await assertRenderedMatchesD3(window, `连续平移第 ${frame} 帧`)
    await new Promise<void>((resolve) => setTimeout(resolve, 16))
  }
  await waitFor(window, `(() => {
    const z = document.querySelector('.react-flow__renderer').__zoom;
    const viewport = window.__canvasWorkbenchWheelSmoke.document().viewport;
    return Math.abs(z.x - viewport.x) < ${tolerance} && Math.abs(z.y - viewport.y) < ${tolerance} && Math.abs(z.k - viewport.zoom) < ${tolerance};
  })()`, '连续手势最终视口没有提交到 Jotai 文档', 2_000)
}

/** 临时 userData + 隐藏窗口保证不读取或修改用户应用状态。 */
async function run(): Promise<void> {
  const userDataPath = mkdtempSync(join(tmpdir(), 'proma-canvas-workbench-wheel-'))
  app.setPath('userData', userDataPath)
  app.on('window-all-closed', () => {})
  await app.whenReady()
  const window = new BrowserWindow({ show: false, width: 1280, height: 900, webPreferences: { backgroundThrottling: false } })
  const errors: string[] = []
  window.webContents.on('console-message', (event) => {
    if (event.level !== 'error' || event.message.includes("Unrecognized Content-Security-Policy directive 'navigate-to'")) return
    errors.push(event.message)
    console.error('[工作台滚轮页面]', event.message)
  })
  try {
    await window.loadURL(fixtureUrl)
    await waitFor(window, `window.__canvasWorkbenchWheelSmoke?.document && document.querySelector('[aria-label="文档工作台"]') && document.querySelector('.react-flow__renderer')?.__zoom`, '工作台滚轮 fixture 未完成挂载')
    await verifyCanvasPanRegions(window)
    await verifyNativeWheelRegions(window)
    await verifyZoomEverywhere(window)
    await verifySelectPortal(window)
    await verifyIframeForgeryRejected(window)
    await verifyIframeBridge(window)
    await verifyZoomPanRace(window)
    assert.ok(await window.webContents.executeJavaScript('window.__canvasWorkbenchWheelSmoke.viewportMutations > 0'), '视口结束必须回显到 Jotai 文档')
    assert.equal(await window.webContents.executeJavaScript('window.__canvasWorkbenchWheelSmoke.graphMutations'), 0, '滚轮交互不能修改图数据')
    assert.equal(await window.webContents.executeJavaScript('window.__canvasWorkbenchWheelSmoke.closeCalls'), 0, '滚轮交互不能触发详情关闭')
    assert.ok(await window.webContents.executeJavaScript(`document.querySelector('[aria-label="文档工作台"]') !== null`), '滚轮交互不能关闭详情')
    assert.deepEqual(errors, [], '真实页面不能产生 Renderer 错误')
    console.log('[Canvas 工作台滚轮] PASS：标题/空白/无溢出列表可双指平移；溢出列表边界及编辑控件保留普通 wheel；详情和 Select Portal 任意区域可缩放；连续缩放平移无回跳、详情未关闭、图写入 0。')
  } finally {
    if (window.webContents.debugger.isAttached()) window.webContents.debugger.detach()
    window.destroy()
    await rm(userDataPath, { recursive: true, force: true })
  }
}

void run().then(() => app.quit()).catch((error: unknown) => { console.error(error); app.exit(1) })
