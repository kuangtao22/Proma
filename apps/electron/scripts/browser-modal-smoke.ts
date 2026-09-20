import { strict as assert } from 'node:assert'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserViewLayout } from '@proma/shared'
import type { BrowserWindow, WebContentsView } from 'electron'

interface NativeViewRecord {
  view: WebContentsView
  bounds: Electron.Rectangle
  attached: boolean
}

interface LayoutRecord extends BrowserViewLayout {
  at: number
}

/** fixture 地址只指向回环 Vite，不访问真实 ~/.proma 或已运行客户端。 */
const fixturePort = process.env.PROMA_BROWSER_MODAL_SMOKE_PORT ?? '5201'
const fixtureUrl = `http://127.0.0.1:${fixturePort}/@fs${join(process.cwd(), 'scripts/browser-modal-smoke.html')}`
/** 所有截图写入临时目录，便于红灯时核对真实遮挡。 */
const screenshotDir = process.env.PROMA_BROWSER_MODAL_SMOKE_SCREENSHOT_DIR ?? join(tmpdir(), 'proma-browser-modal-smoke')

/** 有界等待 renderer 或布局条件，超时错误直接描述用户可见回归。 */
async function waitFor(window: BrowserWindow, expression: string, message: string, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await window.webContents.executeJavaScript(`Boolean(${expression})`)) return
    await new Promise<void>((resolve) => setTimeout(resolve, 35))
  }
  assert.fail(message)
}

/** 等待两帧，让 React、Radix Portal 和 BrowserSlot 布局上报完成。 */
async function settle(window: BrowserWindow): Promise<void> {
  await window.webContents.executeJavaScript('new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
}

/** 查找按钮中心点，点击仍通过原生 WebContents 的 mouseDown/mouseUp 完成。 */
async function readPoint(window: BrowserWindow, selector: string): Promise<Electron.Point> {
  const point = await window.webContents.executeJavaScript(`(() => {
    const target = document.querySelector(${JSON.stringify(selector)});
    if (!(target instanceof HTMLElement)) return null;
    const rect = target.getBoundingClientRect();
    return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
  })()`)
  assert.ok(point, `找不到原生点击目标：${selector}`)
  return point as Electron.Point
}

/**
 * 按 Electron 原生子视图的顶层命中规则派发鼠标。
 * view 挂载时事件进入真实 WebContentsView；view 被移除后事件才进入宿主 renderer。
 */
async function nativeClick(
  window: BrowserWindow,
  views: Map<string, NativeViewRecord>,
  selector: string,
): Promise<void> {
  const point = await readPoint(window, selector)
  /** 后添加的 view 位于更高层，按逆序寻找命中的真实原生子视图。 */
  const hitView = [...views.values()].reverse().find((record) => record.attached
    && point.x >= record.bounds.x
    && point.x < record.bounds.x + record.bounds.width
    && point.y >= record.bounds.y
    && point.y < record.bounds.y + record.bounds.height)
  const target = hitView?.view.webContents ?? window.webContents
  const translatedPoint = hitView
    ? { x: point.x - hitView.bounds.x, y: point.y - hitView.bounds.y }
    : point
  target.sendInputEvent({ type: 'mouseDown', ...translatedPoint, button: 'left', clickCount: 1 })
  target.sendInputEvent({ type: 'mouseUp', ...translatedPoint, button: 'left', clickCount: 1 })
}

/** 向宿主 renderer 派发真实键盘按下与抬起，验证 Radix 的焦点和关闭行为。 */
async function nativeKey(window: BrowserWindow, keyCode: 'Escape' | 'Return'): Promise<void> {
  if (keyCode === 'Return') {
    if (!window.webContents.debugger.isAttached()) window.webContents.debugger.attach('1.3')
    const enterEvent = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 36 }
    await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', text: '\r', unmodifiedText: '\r', ...enterEvent })
    await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', ...enterEvent })
    return
  }
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode })
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode })
}

/** 汇总真实原生网页收到的鼠标按下次数，用于证明事件是否被子 view 截获。 */
async function readNativeHitCount(views: ReadonlyMap<string, NativeViewRecord>): Promise<number> {
  let total = 0
  for (const record of views.values()) {
    total += await record.view.webContents.executeJavaScript('window.__nativeHits ?? 0') as number
  }
  return total
}

/** 判断指定布局切片是否包含不应出现的 visible=true。 */
function assertNoVisibleLayouts(layouts: readonly LayoutRecord[], start: number, message: string): void {
  assert.equal(layouts.slice(start).some((layout) => layout.visible), false, message)
}

/** 等待两个初始 BrowserSlot 都完成首次展示。 */
async function waitForInitialViews(layouts: readonly LayoutRecord[]): Promise<void> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const visibleTabs = new Set(layouts.filter((layout) => layout.visible).map((layout) => layout.tabId))
    if (visibleTabs.has('left-tab') && visibleTabs.has('right-tab')) return
    await new Promise<void>((resolve) => setTimeout(resolve, 35))
  }
  assert.fail('两个 BrowserSlot 未同时挂载真实 WebContentsView')
}

/** 等待指定 tab 的最新布局达到目标可见性与会话保留语义。 */
async function waitForLayout(
  layouts: readonly LayoutRecord[],
  tabId: string,
  visible: boolean,
  preserveSessionOnHide: boolean,
): Promise<void> {
  const deadline = Date.now() + 4_000
  while (Date.now() < deadline) {
    const latest = [...layouts].reverse().find((layout) => layout.tabId === tabId)
    if (latest?.visible === visible && latest.preserveSessionOnHide === preserveSessionOnHide) return
    await new Promise<void>((resolve) => setTimeout(resolve, 30))
  }
  assert.fail(`${tabId} 未上报 visible=${visible}、preserveSessionOnHide=${preserveSessionOnHide}`)
}

/** 验证原生网页获焦后打开模态框时，键盘转入宿主且恢复的双 Slot 不抢焦。 */
async function verifyModalFocusChain(
  window: BrowserWindow,
  views: Map<string, NativeViewRecord>,
  layouts: LayoutRecord[],
): Promise<void> {
  const leftView = views.get('left-tab')
  assert.ok(leftView, '焦点验证缺少左侧 WebContentsView')
  window.showInactive()
  leftView.view.webContents.focus()
  await new Promise<void>((resolve) => setTimeout(resolve, 120))
  /** 无头桌面可能拒绝 showInactive 的焦点切换；仅在确实观察到原生焦点时强制校验转移。 */
  const nativeFocusObserved = leftView.view.webContents.isFocused()

  await window.webContents.executeJavaScript(`window.__browserModalSmoke.open('alert')`)
  await waitForLayout(layouts, 'left-tab', false, true)
  await waitFor(window, `(() => {
    const dialog = document.querySelector('[data-testid="rollback-dialog"]');
    return dialog instanceof HTMLElement && dialog.contains(document.activeElement);
  })()`, '打开模态框后 DOM 焦点未进入确认回退弹窗')
  if (nativeFocusObserved) {
    assert.equal(leftView.view.webContents.isFocused(), false, '打开模态框后原生网页仍持有焦点')
    assert.equal(window.webContents.isFocused(), true, '打开模态框后宿主 renderer 未获得焦点')
  } else {
    console.log('[浏览器模态 smoke] 焦点限制：无头窗口未观察到 WebContentsView isFocused=true，改用 DOM activeElement 与真实键盘行为作为证据')
  }

  window.webContents.focus()
  await nativeKey(window, 'Escape')
  await waitFor(window, `!document.querySelector('[data-testid="rollback-dialog"]')`, 'Escape 未送达确认回退弹窗')
  await waitForLayout(layouts, 'left-tab', true, false)
  await new Promise<void>((resolve) => setTimeout(resolve, 180))
  assert.equal([...views.values()].some((record) => record.view.webContents.isFocused()), false, '关闭弹窗后某个 BrowserSlot 突然抢走焦点')

  const confirmBaseline = await window.webContents.executeJavaScript('window.__browserModalSmoke.getSnapshot().confirmCount') as number
  await window.webContents.executeJavaScript(`window.__browserModalSmoke.open('alert')`)
  window.webContents.focus()
  await waitFor(window, `(() => {
    const confirm = document.querySelector('[data-testid="rollback-confirm"]');
    if (!(confirm instanceof HTMLElement)) return false;
    confirm.focus();
    return document.activeElement === confirm;
  })()`, '确认按钮无法获得 DOM 焦点')
  await nativeKey(window, 'Return')
  await waitFor(window, `window.__browserModalSmoke.getSnapshot().confirmCount === ${confirmBaseline + 1}`, 'Enter 未送达确认回退按钮')
  await waitForLayout(layouts, 'right-tab', true, false)
  await new Promise<void>((resolve) => setTimeout(resolve, 180))
  assert.equal([...views.values()].some((record) => record.view.webContents.isFocused()), false, 'Enter 关闭弹窗后某个 BrowserSlot 突然抢走焦点')
}

/** 验证普通 Popover 与 Toast 不隐藏原生网页。 */
async function verifyNonModalOverlays(window: BrowserWindow, layouts: LayoutRecord[]): Promise<void> {
  const start = layouts.length
  await window.webContents.executeJavaScript(`window.__browserModalSmoke.open('popover')`)
  await waitFor(window, `document.querySelector('[data-testid="popover-content"]')`, 'Popover 未打开')
  await window.webContents.executeJavaScript('window.__browserModalSmoke.showToast()')
  await waitFor(window, `document.body.textContent?.includes('普通通知不会遮挡网页')`, 'Toast 未显示')
  await window.webContents.executeJavaScript(`window.__browserModalSmoke.open('nonmodal')`)
  await waitFor(window, `document.querySelector('[data-testid="nonmodal-dialog"]')`, 'modal=false Dialog 未打开')
  await settle(window)
  assert.equal(layouts.slice(start).some((layout) => !layout.visible), false, '普通 Popover/Toast/modal=false Dialog 错误隐藏原生网页')
  await window.webContents.executeJavaScript(`window.__browserModalSmoke.close('popover'); window.__browserModalSmoke.close('nonmodal')`)
  await waitFor(window, `!document.querySelector('[data-testid="popover-content"]') && !document.querySelector('[data-testid="nonmodal-dialog"]')`, '非模态浮层退出动画未结束')
}

/** 验证确认回退弹窗可原生命中，且两个网页会话状态均保留。 */
async function verifyRollbackDialog(
  window: BrowserWindow,
  views: Map<string, NativeViewRecord>,
  layouts: LayoutRecord[],
  theme: 'light' | 'dark',
): Promise<void> {
  /** 每个主题独立比较确认次数增量，避免第二轮误用固定累计值。 */
  const confirmBaseline = await window.webContents.executeJavaScript('window.__browserModalSmoke.getSnapshot().confirmCount') as number
  await window.webContents.executeJavaScript(`window.__browserModalSmoke.setTheme(${JSON.stringify(theme)}); window.__browserModalSmoke.open('alert')`)
  await waitFor(window, `(() => {
    const dialog = document.querySelector('[data-testid="rollback-dialog"]');
    return dialog instanceof HTMLElement && dialog.dataset.state === 'open' && Number.parseFloat(getComputedStyle(dialog).opacity) > 0.95;
  })()`, `${theme} 确认回退弹窗未完成打开动画`)
  /** 弹窗左侧必须在网页外、右侧与取消按钮中心必须进入左侧原生 view，才覆盖真实遮挡区域。 */
  const leftViewBounds = views.get('left-tab')?.bounds
  assert.ok(leftViewBounds, '缺少左侧 WebContentsView 边界')
  const overlap = await window.webContents.executeJavaScript(`(() => {
    const dialog = document.querySelector('[data-testid="rollback-dialog"]')?.getBoundingClientRect();
    const cancel = document.querySelector('[data-testid="rollback-cancel"]')?.getBoundingClientRect();
    if (!dialog || !cancel) return null;
    return { dialogLeft: dialog.left, dialogRight: dialog.right, cancelX: cancel.left + cancel.width / 2 };
  })()`)
  assert.ok(overlap, '无法读取确认回退弹窗几何')
  assert.ok(overlap.dialogLeft < leftViewBounds.x && overlap.dialogRight > leftViewBounds.x, '确认回退弹窗没有跨过网页左边界')
  assert.ok(overlap.cancelX >= leftViewBounds.x && overlap.cancelX < leftViewBounds.x + leftViewBounds.width, '取消按钮中心没有落在原生网页区域')
  await mkdir(screenshotDir, { recursive: true })
  await writeFile(join(screenshotDir, `browser-modal-${theme}.png`), (await window.capturePage()).toPNG())
  const nativeHitsBeforeCancel = await readNativeHitCount(views)
  await nativeClick(window, views, '[data-testid="rollback-cancel"]')
  await new Promise<void>((resolve) => setTimeout(resolve, 80))
  assert.equal(await readNativeHitCount(views), nativeHitsBeforeCancel, '取消按钮坐标事件被原生网页吃掉')
  await waitFor(window, `!document.querySelector('[data-testid="rollback-dialog"]')`, '取消按钮被 WebContentsView 截获，确认回退弹窗仍被网页挡住', 700)

  await window.webContents.executeJavaScript(`window.__browserModalSmoke.open('alert')`)
  await waitForLayout(layouts, 'left-tab', false, true)
  await waitForLayout(layouts, 'right-tab', false, true)
  await nativeClick(window, views, '[data-testid="rollback-confirm"]')
  await waitFor(window, `window.__browserModalSmoke.getSnapshot().confirmCount === ${confirmBaseline + 1}`, '确认按钮没有收到原生鼠标事件')
  await waitForLayout(layouts, 'left-tab', true, false)
  await waitForLayout(layouts, 'right-tab', true, false)
  for (const tabId of ['left-tab', 'right-tab']) {
    const state = await views.get(tabId)?.view.webContents.executeJavaScript('window.__smokeState')
    assert.equal(state, `state-${tabId}`, `${tabId} 在临时隐藏后丢失网页状态`)
  }
}

/** 验证嵌套弹窗、新挂 Slot、缩放与退出动画期间都保持隐藏。 */
async function verifyModalEdges(
  window: BrowserWindow,
  views: Map<string, NativeViewRecord>,
  layouts: LayoutRecord[],
): Promise<void> {
  await window.webContents.executeJavaScript(`window.__browserModalSmoke.open('outer'); window.__browserModalSmoke.open('inner')`)
  await waitFor(window, `document.querySelector('[data-testid="inner-dialog"]')`, '嵌套弹窗未打开')
  await waitForLayout(layouts, 'left-tab', false, true)
  await nativeClick(window, views, '[data-testid="close-inner"]')
  await waitFor(window, `!document.querySelector('[data-testid="inner-dialog"]')`, '内层弹窗未关闭')
  assert.equal([...views.values()].some((record) => record.attached), false, '关闭一个嵌套弹窗后网页提前恢复')

  await window.webContents.executeJavaScript('window.__browserModalSmoke.mountLateSlot()')
  await waitForLayout(layouts, 'late-tab', false, true)
  assert.equal(views.get('late-tab')?.attached, false, '弹窗打开时新挂 BrowserSlot 短暂盖住弹窗')

  const resizeStart = layouts.length
  window.setContentSize(1100, 760)
  await window.webContents.setZoomFactor(1.15)
  await new Promise<void>((resolve) => setTimeout(resolve, 120))
  assertNoVisibleLayouts(layouts, resizeStart, '模态弹窗打开时 resize/zoom 重新显示原生网页')

  const closeStart = layouts.length
  await window.webContents.executeJavaScript(`window.__browserModalSmoke.close('outer')`)
  await new Promise<void>((resolve) => setTimeout(resolve, 120))
  assertNoVisibleLayouts(layouts, closeStart, 'Dialog 退出动画期间原生网页提前显示')
  await waitForLayout(layouts, 'left-tab', true, false)
  await waitForLayout(layouts, 'right-tab', true, false)
  await waitForLayout(layouts, 'late-tab', true, false)
}

/** 验证生产 Sheet 同样避让，并在退出动画完成后恢复。 */
async function verifySheet(window: BrowserWindow, views: Map<string, NativeViewRecord>, layouts: LayoutRecord[]): Promise<void> {
  await window.webContents.executeJavaScript(`window.__browserModalSmoke.setTheme('dark'); window.__browserModalSmoke.open('sheet')`)
  await waitFor(window, `document.querySelector('[data-testid="test-sheet"]')`, 'Sheet 未打开')
  await waitForLayout(layouts, 'left-tab', false, true)
  const closeStart = layouts.length
  await nativeClick(window, views, '[data-testid="close-sheet"]')
  await new Promise<void>((resolve) => setTimeout(resolve, 160))
  assertNoVisibleLayouts(layouts, closeStart, 'Sheet 退出动画期间原生网页提前显示')
  await waitForLayout(layouts, 'left-tab', true, false)
}

/** 子进程创建真实 BrowserWindow 与 WebContentsView，运行全部 GUI 回归。 */
async function runElectronSmoke(): Promise<void> {
  const { app, BrowserWindow, WebContentsView, ipcMain, nativeTheme } = await import('electron')
  const userDataPath = await mkdtemp(join(tmpdir(), 'proma-browser-modal-smoke-user-data-'))
  const layouts: LayoutRecord[] = []
  const views = new Map<string, NativeViewRecord>()
  app.setPath('userData', userDataPath)
  app.on('window-all-closed', () => undefined)
  await app.whenReady()
  nativeTheme.themeSource = 'light'
  const window = new BrowserWindow({
    width: 1200,
    height: 780,
    show: false,
    backgroundColor: '#ffffff',
    webPreferences: {
      backgroundThrottling: false,
      contextIsolation: true,
      preload: join(process.cwd(), 'scripts/browser-modal-smoke-preload.cjs'),
      sandbox: false,
    },
  })

  /** 为 BrowserSlot 的每个 tab 懒创建真实原生 WebContentsView。 */
  const ensureView = (tabId: string): NativeViewRecord => {
    const existing = views.get(tabId)
    if (existing) return existing
    const view = new WebContentsView({ webPreferences: { backgroundThrottling: false } })
    const html = `<!doctype html><html><body style="margin:0;background:#dbeafe;font:16px system-ui"><button id="native-hit" style="width:100%;height:100vh;border:0;background:#dbeafe">原生网页 ${tabId}</button><script>window.__smokeState=${JSON.stringify(`state-${tabId}`)};window.__nativeHits=0;document.addEventListener('mousedown',()=>{window.__nativeHits+=1})<\/script></body></html>`
    void view.webContents.loadURL(`data:text/html;charset=UTF-8,${encodeURIComponent(html)}`)
    const record: NativeViewRecord = { view, bounds: { x: 0, y: 0, width: 0, height: 0 }, attached: false }
    views.set(tabId, record)
    return record
  }

  ipcMain.handle('browser-modal-smoke:set-layout', (_event, layout: BrowserViewLayout) => {
    const tabId = layout.tabId ?? 'active-tab'
    const record = ensureView(tabId)
    record.bounds = layout.bounds
    if (layout.visible && !record.attached) {
      window.contentView.addChildView(record.view)
      record.view.setBounds(layout.bounds)
      record.view.setVisible(true)
      record.attached = true
    } else if (layout.visible) {
      record.view.setBounds(layout.bounds)
      record.view.setVisible(true)
    } else if (!layout.visible && record.attached) {
      record.view.setVisible(false)
      window.contentView.removeChildView(record.view)
      record.attached = false
    } else {
      record.view.setVisible(false)
      record.view.setBounds(layout.bounds)
    }
    layouts.push({ ...layout, at: Date.now() })
  })

  try {
    await window.loadURL(fixtureUrl)
    await waitFor(window, `typeof window.__browserModalSmoke?.getSnapshot === 'function'`, 'browser modal fixture 未挂载')
    assert.equal(
      await window.webContents.executeJavaScript(`typeof window.electronAPI?.setAgentBrowserLayout`),
      'function',
      '隔离 preload 未暴露 setAgentBrowserLayout',
    )
    await waitForInitialViews(layouts)
    await verifyModalFocusChain(window, views, layouts)
    await verifyNonModalOverlays(window, layouts)
    await verifyRollbackDialog(window, views, layouts, 'light')
    await verifyRollbackDialog(window, views, layouts, 'dark')
    await verifyModalEdges(window, views, layouts)
    await verifySheet(window, views, layouts)
    await window.webContents.executeJavaScript('window.__browserModalSmoke.unmount()')
    console.log(`[浏览器模态 smoke] PASS：真实 WebContentsView、AlertDialog/Dialog/Sheet、原生按钮命中、嵌套/动态挂载/动画/缩放、双 Slot、Popover/Toast；截图 ${screenshotDir}`)
  } finally {
    ipcMain.removeHandler('browser-modal-smoke:set-layout')
    if (window.webContents.debugger.isAttached()) window.webContents.debugger.detach()
    for (const record of views.values()) record.view.webContents.close()
    window.destroy()
    await rm(userDataPath, { recursive: true, force: true })
  }
}

/** 等待 Vite fixture 可访问，避免固定 sleep 掩盖启动错误。 */
async function waitForVite(url: string): Promise<void> {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url)
      if (response.ok) return
    } catch {
      // Vite 尚未监听时继续有界重试。
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('等待 browser modal smoke Vite 服务超时')
}

/** 让操作系统分配空闲回环端口，避免并行 smoke 冲突。 */
async function findAvailablePort(): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close()
        reject(new Error('无法分配 browser modal smoke 端口'))
        return
      }
      server.close((error) => error ? reject(error) : resolve(String(address.port)))
    })
  })
}

/** Bun 父进程构建临时 Electron 入口、启动 Vite，并回收全部子进程。 */
async function orchestrateSmoke(): Promise<void> {
  const buildDir = await mkdtemp(join(tmpdir(), 'proma-browser-modal-smoke-build-'))
  const build = await Bun.build({
    entrypoints: [join(process.cwd(), 'scripts/browser-modal-smoke.ts')],
    outdir: buildDir,
    target: 'node',
    format: 'cjs',
    external: ['electron'],
  })
  if (!build.success) throw new Error(`构建 browser modal Electron 入口失败：${build.logs.join('\n')}`)
  const outputPath = build.outputs[0]?.path
  if (!outputPath) throw new Error('browser modal Electron 构建没有输出文件')
  const selectedPort = process.env.PROMA_BROWSER_MODAL_SMOKE_PORT ?? await findAvailablePort()
  const selectedFixtureUrl = `http://127.0.0.1:${selectedPort}/@fs${join(process.cwd(), 'scripts/browser-modal-smoke.html')}`
  const vite = spawn(process.execPath, [join(process.cwd(), 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', selectedPort, '--strictPort'], {
    cwd: process.cwd(),
    stdio: 'inherit',
  })
  try {
    await waitForVite(selectedFixtureUrl)
    const electron = spawn(join(process.cwd(), 'node_modules/.bin/electron'), [outputPath], {
      cwd: process.cwd(),
      env: { ...process.env, PROMA_BROWSER_MODAL_SMOKE_CHILD: '1', PROMA_BROWSER_MODAL_SMOKE_PORT: selectedPort },
      stdio: 'inherit',
    })
    const exitCode = await new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(() => {
        electron.kill('SIGTERM')
        reject(new Error('browser modal Electron smoke 超时'))
      }, 90_000)
      electron.once('error', (error) => { clearTimeout(timeout); reject(error) })
      electron.once('exit', (code, signal) => {
        clearTimeout(timeout)
        if (signal) reject(new Error(`browser modal Electron smoke 被信号 ${signal} 终止`))
        else resolve(code ?? 1)
      })
    })
    assert.equal(exitCode, 0, `browser modal Electron smoke 退出码为 ${exitCode}`)
  } finally {
    vite.kill('SIGTERM')
    await rm(buildDir, { recursive: true, force: true })
  }
}

if (process.env.PROMA_BROWSER_MODAL_SMOKE_CHILD === '1') {
  void runElectronSmoke().then(async () => {
    const { app } = await import('electron')
    app.quit()
  }).catch(async (error: unknown) => {
    console.error('[浏览器模态 smoke] FAIL', error)
    const { app } = await import('electron')
    app.exit(1)
  })
} else {
  void orchestrateSmoke().catch((error: unknown) => {
    console.error('[浏览器模态 smoke] FAIL', error)
    process.exitCode = 1
  })
}
