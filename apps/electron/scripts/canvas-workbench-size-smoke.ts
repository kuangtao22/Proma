import { strict as assert } from 'node:assert'
import { mkdtempSync } from 'node:fs'
import { rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app, BrowserWindow } from 'electron'

/** 可选端口只复用已运行的开发 Vite，不启动第二个客户端。 */
const fixtureUrl = `http://127.0.0.1:${process.env.PROMA_MEDIA_SMOKE_PORT ?? '5177'}/@fs${join(process.cwd(), 'scripts/canvas-workbench-size-smoke.html')}`
const workbench = '[aria-label="视频工作台"]'
const siblingNodeId = 'workbench-image'

/** 等待真实 DOM 或状态条件，超时错误直接说明缺失的验收点。 */
async function waitFor(window: BrowserWindow, expression: string, message: string): Promise<void> {
  const deadline = Date.now() + 12_000
  while (Date.now() < deadline) {
    if (await window.webContents.executeJavaScript(`Boolean(${expression})`)) return
    await new Promise<void>((resolve) => setTimeout(resolve, 40))
  }
  throw new Error(message)
}

/** 读取工作台世界尺寸、屏幕矩形与正文矩形。 */
async function readGeometry(window: BrowserWindow): Promise<{
  world: { width: number; height: number } | null
  shell: { width: number; height: number }
  body: { width: number; height: number }
}> {
  return window.webContents.executeJavaScript(`(() => {
    const shell = document.querySelector(${JSON.stringify(workbench)});
    const body = shell?.querySelector('[data-smoke-body]');
    const state = window.__canvasWorkbenchSizeSmoke.getState();
    const world = state.workbenchSizesByNodeId['workbench-video'] ?? null;
    const shellRect = shell.getBoundingClientRect();
    const bodyRect = body.getBoundingClientRect();
    return { world, shell: { width: shellRect.width, height: shellRect.height }, body: { width: bodyRect.width, height: bodyRect.height } };
  })()`)
}

/** 通过真实鼠标事件点击带 aria-label 的 Overlay 按钮。 */
async function clickAriaButton(window: BrowserWindow, label: string): Promise<void> {
  const point = await window.webContents.executeJavaScript(`(() => {
    const button = document.querySelector('button[aria-label=' + ${JSON.stringify(JSON.stringify(label))} + ']');
    if (!button || button.disabled) return null;
    const rect = button.getBoundingClientRect();
    return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
  })()`)
  assert.ok(point, `找不到可点击按钮：${label}`)
  window.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 })
  window.webContents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 })
}

/** 拖拽真实缩放手柄，验证屏幕位移正确换算成世界尺寸。 */
async function resizeWorkbench(window: BrowserWindow, delta: { x: number; y: number }): Promise<void> {
  const point = await window.webContents.executeJavaScript(`(() => {
    const handle = document.querySelector('button[aria-label="调整工作台大小"]');
    if (!handle) return null;
    const rect = handle.getBoundingClientRect();
    return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
  })()`)
  assert.ok(point, '找不到工作台缩放手柄')
  window.webContents.sendInputEvent({ type: 'mouseMove', ...point })
  await new Promise<void>((resolve) => setTimeout(resolve, 40))
  window.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 })
  await new Promise<void>((resolve) => setTimeout(resolve, 40))
  window.webContents.sendInputEvent({ type: 'mouseMove', x: point.x + delta.x, y: point.y + delta.y, movementX: delta.x, movementY: delta.y })
  await new Promise<void>((resolve) => setTimeout(resolve, 40))
  window.webContents.sendInputEvent({ type: 'mouseUp', x: point.x + delta.x, y: point.y + delta.y, button: 'left', clickCount: 1 })
}

/** 首次低倍打开只缩小显示，不反向放大世界尺寸。 */
async function verifyLowZoomInitialSize(window: BrowserWindow): Promise<void> {
  await window.webContents.executeJavaScript(`window.__canvasWorkbenchSizeSmoke.resetScenario({ viewport: { x: 0, y: 0, zoom: 0.15 }, surface: { width: 1200, height: 800 } })`)
  await waitFor(window, `window.__canvasWorkbenchSizeSmoke.getState().workbenchSizesByNodeId['workbench-video']?.width === 840`, '低缩放首次尺寸没有保存为 840×560 世界坐标')
  const low = await readGeometry(window)
  assert.deepEqual(low.world, { width: 840, height: 560 })
  assert.ok(Math.abs(low.shell.width - 126) <= 1 && Math.abs(low.shell.height - 84) <= 1, `低缩放屏幕尺寸异常：${JSON.stringify(low.shell)}`)

  /** 同一挂载只改变 viewport，外壳和正文必须等比例变化。 */
  await window.webContents.executeJavaScript(`window.__canvasWorkbenchSizeSmoke.setZoom(0.3)`)
  await waitFor(window, `Math.abs(document.querySelector(${JSON.stringify(workbench)}).getBoundingClientRect().width - 252) <= 1`, '工作台没有随 viewport 放大')
  const doubled = await readGeometry(window)
  assert.deepEqual(doubled.world, low.world)
  assert.ok(Math.abs(doubled.shell.width / low.shell.width - 2) <= 0.02)
  assert.ok(Math.abs(doubled.body.width / low.body.width - 2) <= 0.02)
  assert.ok(Math.abs(doubled.body.height / low.body.height - 2) <= 0.04)

  /** 关闭后改变 zoom 再重开，缓存仍是同一份世界尺寸。 */
  await window.webContents.executeJavaScript(`window.__canvasWorkbenchSizeSmoke.close(); window.__canvasWorkbenchSizeSmoke.setZoom(0.5)`)
  await waitFor(window, `document.querySelector(${JSON.stringify(workbench)}) === null`, '工作台没有关闭')
  await window.webContents.executeJavaScript(`window.__canvasWorkbenchSizeSmoke.open()`)
  await waitFor(window, `Math.abs(document.querySelector(${JSON.stringify(workbench)}).getBoundingClientRect().width - 420) <= 1`, '重开后没有复用世界尺寸')
  assert.deepEqual((await readGeometry(window)).world, { width: 840, height: 560 })
}

/** 用户调整尺寸应提交一次，并在关闭重开后保留。 */
async function verifyResizePersistence(window: BrowserWindow): Promise<void> {
  await window.webContents.executeJavaScript(`window.__canvasWorkbenchSizeSmoke.resetScenario({ viewport: { x: 0, y: 0, zoom: 1 }, surface: { width: 1200, height: 800 } })`)
  await waitFor(window, `window.__canvasWorkbenchSizeSmoke.getState().workbenchSizesByNodeId['workbench-video']?.width === 840`, '缩放场景未完成初始化')
  await resizeWorkbench(window, { x: 90, y: 60 })
  await waitFor(window, `window.__canvasWorkbenchSizeSmoke.getState().workbenchSizesByNodeId['workbench-video']?.width >= 929`, '拖拽尺寸没有提交')
  const resized = (await readGeometry(window)).world
  assert.ok(resized && Math.abs(resized.width - 930) <= 2 && Math.abs(resized.height - 620) <= 2, `拖拽结果异常：${JSON.stringify(resized)}`)
  await window.webContents.executeJavaScript(`window.__canvasWorkbenchSizeSmoke.close()`)
  await waitFor(window, `document.querySelector(${JSON.stringify(workbench)}) === null`, '拖拽后工作台没有关闭')
  await window.webContents.executeJavaScript(`window.__canvasWorkbenchSizeSmoke.setZoom(0.75); window.__canvasWorkbenchSizeSmoke.open()`)
  await waitFor(window, `document.querySelector(${JSON.stringify(workbench)}) !== null`, '拖拽后工作台没有重开')
  assert.deepEqual((await readGeometry(window)).world, resized)
}

/** 旧膨胀缓存只有明确点击恢复后才纠正，并保留其他节点与正文实例。 */
async function verifyExplicitReset(window: BrowserWindow): Promise<void> {
  await window.webContents.executeJavaScript(`window.__canvasWorkbenchSizeSmoke.resetScenario({
    viewport: { x: 0, y: 0, zoom: 0.15 }, surface: { width: 1200, height: 800 },
    sizes: { 'workbench-video': { width: 5600, height: 3733 }, ${JSON.stringify(siblingNodeId)}: { width: 700, height: 500 } }
  })`)
  await waitFor(window, `window.__canvasWorkbenchSizeSmoke.getState().workbenchSizesByNodeId['workbench-video']?.width === 5600`, '旧膨胀缓存未保留')
  const mountsBefore = await window.webContents.executeJavaScript(`window.__canvasWorkbenchSizeSmoke.childMounts`)
  await window.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('[data-smoke-draft]');
    input.value = '尚未保存的用户参数';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`)
  await clickAriaButton(window, '恢复工作台默认大小')
  await waitFor(window, `window.__canvasWorkbenchSizeSmoke.getState().workbenchSizesByNodeId['workbench-video']?.width === 840`, '恢复默认大小没有纠正旧缓存')
  const state = await window.webContents.executeJavaScript(`window.__canvasWorkbenchSizeSmoke.getState()`)
  assert.deepEqual(state.workbenchSizesByNodeId['workbench-video'], { width: 840, height: 560 })
  assert.deepEqual(state.workbenchSizesByNodeId[siblingNodeId], { width: 700, height: 500 })
  assert.equal(await window.webContents.executeJavaScript(`window.__canvasWorkbenchSizeSmoke.childMounts`), mountsBefore, '恢复尺寸不应重挂载正文')
  assert.equal(await window.webContents.executeJavaScript(`document.querySelector('[data-smoke-draft]').value`), '尚未保存的用户参数', '恢复尺寸不应清空正文参数')
  assert.equal(await window.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(workbench)}).dataset.workbenchDirty`), 'true', '恢复尺寸不应清除 dirty 状态')
  await window.webContents.executeJavaScript(`window.__canvasWorkbenchSizeSmoke.close()`)
  await waitFor(window, `document.querySelector(${JSON.stringify(workbench)}) === null`, '恢复后工作台没有关闭')
  await window.webContents.executeJavaScript(`window.__canvasWorkbenchSizeSmoke.setZoom(0.4); window.__canvasWorkbenchSizeSmoke.open()`)
  await waitFor(window, `document.querySelector(${JSON.stringify(workbench)}) !== null`, '恢复后工作台没有重开')
  assert.deepEqual((await readGeometry(window)).world, { width: 840, height: 560 })
}

/** 生成宽窄 surface 截图，并确认窄窗口默认值只向下约束。 */
async function captureResponsiveScreenshots(window: BrowserWindow): Promise<void> {
  window.setContentSize(1260, 920)
  await window.webContents.executeJavaScript(`window.__canvasWorkbenchSizeSmoke.resetScenario({ viewport: { x: 0, y: 0, zoom: 1 }, surface: { width: 1200, height: 800 } })`)
  await waitFor(window, `window.__canvasWorkbenchSizeSmoke.getState().viewport.zoom === 1
    && document.querySelector(${JSON.stringify(workbench)})?.getBoundingClientRect().width === 840`, '宽窗口默认尺寸未完成')
  await writeFile('/private/tmp/canvas-workbench-size-wide.png', (await window.webContents.capturePage()).toPNG())

  window.setContentSize(500, 820)
  await window.webContents.executeJavaScript(`window.__canvasWorkbenchSizeSmoke.resetScenario({ viewport: { x: 0, y: 0, zoom: 1 }, surface: { width: 460, height: 720 } })`)
  await waitFor(window, `window.__canvasWorkbenchSizeSmoke.getState().viewport.zoom === 1
    && window.__canvasWorkbenchSizeSmoke.getState().workbenchSizesByNodeId['workbench-video']?.width === 436`, '窄窗口默认宽度没有限制为可见区域')
  assert.deepEqual((await readGeometry(window)).world, { width: 436, height: 560 })
  await writeFile('/private/tmp/canvas-workbench-size-narrow.png', (await window.webContents.capturePage()).toPNG())
}

/** 在临时 userData 中完成验证，不读取用户客户端或媒体服务。 */
async function run(): Promise<void> {
  const dataPath = mkdtempSync(join(tmpdir(), 'proma-canvas-workbench-size-'))
  app.setPath('userData', dataPath)
  app.on('window-all-closed', () => {})
  await app.whenReady()
  const window = new BrowserWindow({ width: 1260, height: 920, show: false, webPreferences: { backgroundThrottling: false } })
  const rendererErrors: string[] = []
  window.webContents.on('console-message', (event) => { if (event.level === 'error') rendererErrors.push(event.message) })
  try {
    await window.loadURL(fixtureUrl)
    await waitFor(window, `typeof window.__canvasWorkbenchSizeSmoke?.resetScenario === 'function' && document.querySelector(${JSON.stringify(workbench)})`, 'Canvas 工作台 fixture 未完成挂载')
    await verifyLowZoomInitialSize(window)
    await verifyResizePersistence(window)
    await verifyExplicitReset(window)
    await captureResponsiveScreenshots(window)
    assert.deepEqual(rendererErrors, [], '尺寸交互不应产生 Renderer 错误')
    console.log('[Canvas 工作台尺寸] PASS：低倍首次尺寸、同步缩放、关闭重开、拖拽持久化、显式恢复及宽窄截图')
  } finally {
    window.destroy()
    await rm(dataPath, { recursive: true, force: true })
  }
}

void run().then(() => app.quit()).catch((error: unknown) => { console.error(error); app.exit(1) })
