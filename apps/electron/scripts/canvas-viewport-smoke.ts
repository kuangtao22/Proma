import { strict as assert } from 'node:assert'
import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app, BrowserWindow } from 'electron'

/** 描述 D3、可见 DOM 与会话共用的二维画布视口。 */
interface CanvasViewport {
  x: number
  y: number
  zoom: number
}

/** 汇总一次真实页面采样，便于比较三层视口是否同步。 */
interface CanvasViewportSample {
  d3: CanvasViewport
  rendered: CanvasViewport
  session: CanvasViewport | null
}

/** 复用已启动的隔离 Vite，并加载真实 Workspace 内存 fixture。 */
const fixtureUrl = `http://127.0.0.1:${process.env.PROMA_CANVAS_SMOKE_PORT ?? '5193'}/@fs${join(process.cwd(), 'scripts/canvas-navigation-smoke.html')}`
/** 允许浏览器浮点计算产生极小误差，但不放宽可见位移合同。 */
const viewportTolerance = 0.01
/** 双指平移事件采用稳定输入，XYFlow 默认速度会把位移折半。 */
const panInput = { deltaX: -24, deltaY: -10 }
/** 每个输入对应的实际视口位移，用于逐帧识别回跳。 */
const panStep = { x: -12, y: -5 }
/** 连续输入总数覆盖旧 150ms 结束窗口。 */
const panFrameCount = 12

/** 按条件有界等待页面或手势状态；入参为浏览器表达式和超时，返回无值。 */
async function waitFor(window: BrowserWindow, expression: string, timeout = 12_000): Promise<void> {
  /** 截止时间限制页面编译或事件失效时的等待。 */
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await window.webContents.executeJavaScript(`Boolean(${expression})`)) return
    await new Promise<void>((resolve) => setTimeout(resolve, 8))
  }
  throw new Error(`等待失败：${expression}`)
}

/** 等待两次绘制，确保读取到 React 与 XYFlow 已提交的可见 transform。 */
async function waitForTwoFrames(window: BrowserWindow): Promise<void> {
  await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
}

/** 从真实页面读取 D3、DOM 矩阵和会话视图；入参为测试窗口，返回三层视口。 */
async function readViewport(window: BrowserWindow): Promise<CanvasViewportSample> {
  return window.webContents.executeJavaScript(`(() => {
    const renderer = document.querySelector('.react-flow__renderer');
    const viewport = document.querySelector('.react-flow__viewport');
    const session = window.__canvasNavigationSmoke.view()?.viewport ?? null;
    if (!renderer?.__zoom || !viewport) throw new Error('画布视口尚未就绪');
    const matrix = new DOMMatrixReadOnly(getComputedStyle(viewport).transform);
    return {
      d3: { x: renderer.__zoom.x, y: renderer.__zoom.y, zoom: renderer.__zoom.k },
      rendered: { x: matrix.m41, y: matrix.m42, zoom: matrix.m11 },
      session,
    };
  })()`)
}

/** 比较单个数值并输出明确坐标名；入参为实际值、预期值和名称，返回无值。 */
function assertClose(actual: number, expected: number, label: string): void {
  assert.ok(Math.abs(actual - expected) <= viewportTolerance,
    `${label} 应为 ${expected}，实际为 ${actual}`)
}

/** 比较完整视口；入参为实际视口、预期视口和名称，返回无值。 */
function assertViewportClose(actual: CanvasViewport, expected: CanvasViewport, label: string): void {
  assertClose(actual.x, expected.x, `${label}.x`)
  assertClose(actual.y, expected.y, `${label}.y`)
  assertClose(actual.zoom, expected.zoom, `${label}.zoom`)
}

/** 验证受控 DOM 与 D3 内部视口逐帧一致；入参为一次采样和场景名，返回无值。 */
function assertRenderedMatchesD3(sample: CanvasViewportSample, label: string): void {
  assertViewportClose(sample.rendered, sample.d3, `${label} 可见 transform`)
}

/** 向画布中心发送真实滚轮事件；入参为窗口、滚轮位移和修饰键，返回无值。 */
function wheel(window: BrowserWindow, deltaX: number, deltaY: number, modifiers: string[] = []): void {
  window.webContents.focus()
  window.webContents.sendInputEvent({
    type: 'mouseWheel', x: 600, y: 500, deltaX, deltaY, canScroll: true, modifiers,
  })
}

/** 用真实坐标点击工具栏控件；入参为窗口和 CSS 选择器，返回无值。 */
async function click(window: BrowserWindow, selector: string): Promise<void> {
  /** 点击位置来自隔离页面自身 DOM。 */
  const point = await window.webContents.executeJavaScript(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element || element.disabled) return null;
    const rect = element.getBoundingClientRect();
    return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
  })()`)
  assert.ok(point, `无法点击：${selector}`)
  window.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 })
  window.webContents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 })
}

/** 等待会话视图收敛到 D3 当前值；入参为窗口，返回最终采样。 */
async function waitForSessionCommit(window: BrowserWindow): Promise<CanvasViewportSample> {
  await waitFor(window, `(() => {
    const zoom = document.querySelector('.react-flow__renderer')?.__zoom;
    const session = window.__canvasNavigationSmoke.view()?.viewport;
    return zoom && session && Math.abs(zoom.x - session.x) <= ${viewportTolerance}
      && Math.abs(zoom.y - session.y) <= ${viewportTolerance}
      && Math.abs(zoom.k - session.zoom) <= ${viewportTolerance};
  })()`, 2_000)
  return readViewport(window)
}

/** Given 低倍画布 When 缩小后立即连续双指平移 Then 不回跳且三层最终一致。 */
async function verifyContinuousTrackpadPan(window: BrowserWindow): Promise<void> {
  /** 初始状态来自真实 fixture，不经过程序化视口注入。 */
  const initial = await readViewport(window)
  assertViewportClose(initial.d3, { x: 0, y: 0, zoom: 0.1 }, '初始 D3')
  assertRenderedMatchesD3(initial, '初始')

  /** Ctrl 滚轮先改变低倍视口，随后立即进入双指平移。 */
  wheel(window, 0, -30, ['control'])
  await waitFor(window, `Math.abs(document.querySelector('.react-flow__renderer').__zoom.k - ${initial.d3.zoom}) > ${viewportTolerance}`, 300)
  /** 缩放结束前的视口作为连续平移位移基线。 */
  const zoomed = await readViewport(window)
  assertRenderedMatchesD3(zoomed, '缩小后')

  for (let frame = 1; frame <= panFrameCount; frame += 1) {
    wheel(window, panInput.deltaX, panInput.deltaY)
    /** 当前帧期望值严格累计，旧结束事件造成的回跳会在这里直接失败。 */
    const expected = {
      x: zoomed.d3.x + panStep.x * frame,
      y: zoomed.d3.y + panStep.y * frame,
      zoom: zoomed.d3.zoom,
    }
    await waitFor(window, `(() => {
      const viewport = document.querySelector('.react-flow__renderer').__zoom;
      return Math.abs(viewport.x - ${expected.x}) <= ${viewportTolerance}
        && Math.abs(viewport.y - ${expected.y}) <= ${viewportTolerance};
    })()`, 250)
    /** 首次输入只等待绘制帧，验证用户能及时看到位移。 */
    if (frame === 1) await waitForTwoFrames(window)
    /** 每帧读取真实状态，同时让 12 帧输入跨越旧 150ms 结束窗口。 */
    const sample = await readViewport(window)
    assertViewportClose(sample.d3, expected, `双指平移第 ${frame} 帧 D3`)
    assertRenderedMatchesD3(sample, `双指平移第 ${frame} 帧`)
    await new Promise<void>((resolve) => setTimeout(resolve, 16))
  }

  /** 手势结束后会话只提交最终值，不保留过时缩放位置。 */
  const committed = await waitForSessionCommit(window)
  assertRenderedMatchesD3(committed, '双指平移结束')
  assert.ok(committed.session, '双指平移结束后必须写入会话视图')
  assertViewportClose(committed.session, committed.d3, '双指平移最终会话')
}

/** Given 连续手势已结束 When 使用工具栏缩小和 Fit View Then 最终会话视图仍正确写入。 */
async function verifyToolbarViewportActions(window: BrowserWindow): Promise<void> {
  /** 工具栏缩小前采样用于证明按钮真实改变缩放。 */
  const beforeZoomOut = await readViewport(window)
  await click(window, '.react-flow__controls-zoomout')
  await waitFor(window, `document.querySelector('.react-flow__renderer').__zoom.k < ${beforeZoomOut.d3.zoom}`, 1_000)
  /** 缩小按钮最终值须同时进入 DOM 和会话视图。 */
  const zoomedOut = await waitForSessionCommit(window)
  assertRenderedMatchesD3(zoomedOut, '工具栏缩小')
  assert.ok(zoomedOut.session, '工具栏缩小后必须写入会话视图')
  assertViewportClose(zoomedOut.session, zoomedOut.d3, '工具栏缩小会话')

  /** Fit View 前位置不同，确保按钮执行的是实际重新取景。 */
  const beforeFitView = zoomedOut.d3
  await click(window, '.react-flow__controls-fitview')
  await waitFor(window, `(() => {
    const viewport = document.querySelector('.react-flow__renderer').__zoom;
    return Math.abs(viewport.x - ${beforeFitView.x}) > ${viewportTolerance}
      || Math.abs(viewport.y - ${beforeFitView.y}) > ${viewportTolerance}
      || Math.abs(viewport.k - ${beforeFitView.zoom}) > ${viewportTolerance};
  })()`, 1_000)
  /** Fit View 动画结束后最终状态须三层一致。 */
  const fitted = await waitForSessionCommit(window)
  assertRenderedMatchesD3(fitted, 'Fit View')
  assert.ok(fitted.session, 'Fit View 后必须写入会话视图')
  assertViewportClose(fitted.session, fitted.d3, 'Fit View 会话')
}

/** 在隔离 Electron 中执行真实 Workspace 视口回归，不连接用户数据。 */
async function run(): Promise<void> {
  /** 临时 userData 只属于本次测试进程。 */
  const userDataPath = mkdtempSync(join(tmpdir(), 'proma-canvas-viewport-'))
  app.setPath('userData', userDataPath)
  app.on('window-all-closed', () => {})
  await app.whenReady()
  /** 隐藏窗口关闭后台节流，保留真实输入与绘制时序。 */
  const window = new BrowserWindow({
    show: false,
    width: 1200,
    height: 800,
    webPreferences: { backgroundThrottling: false },
  })
  /** 运行时错误必须作为回归失败，而非仅打印日志。 */
  const errors: string[] = []
  window.webContents.on('console-message', (event) => {
    if (event.level === 'error') errors.push(event.message)
  })
  try {
    await window.loadURL(fixtureUrl)
    await waitFor(window, `Boolean(window.__canvasNavigationSmoke?.view()
      && document.querySelector('.react-flow__renderer')?.__zoom
      && document.querySelector('.react-flow__controls-fitview'))`)
    await click(window, '[aria-label="平移工具"]')
    /** 原始权威图用于证明视口交互没有修改节点或连线。 */
    const originalGraph = await window.webContents.executeJavaScript('JSON.stringify(window.__canvasNavigationSmoke.graph())')

    await verifyContinuousTrackpadPan(window)
    await verifyToolbarViewportActions(window)

    assert.equal(await window.webContents.executeJavaScript('JSON.stringify(window.__canvasNavigationSmoke.graph())'), originalGraph)
    assert.equal(await window.webContents.executeJavaScript('window.__canvasNavigationSmoke.saveCalls'), 0)
    assert.deepEqual(errors, [], '真实页面不能产生运行错误')
    console.log('[画布视口] PASS：低倍缩小后连续双指平移逐帧无回跳，首帧及时显示，D3/可见 transform/最终会话一致；工具栏缩小与 Fit View 正常，原图不变、保存 0、控制台错误 0。')
  } finally {
    window.destroy()
    await rm(userDataPath, { recursive: true, force: true })
  }
}

void run().then(() => app.quit()).catch((error: unknown) => { console.error(error); app.exit(1) })
