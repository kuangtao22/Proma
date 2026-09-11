import { strict as assert } from 'node:assert'
import { mkdtempSync } from 'node:fs'
import { rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app, BrowserWindow } from 'electron'

/** 复用既有 Vite，隐藏测试窗口不连接用户客户端。 */
const fixtureUrl = `http://127.0.0.1:${process.env.PROMA_CANVAS_SMOKE_PORT ?? '5174'}/@fs${join(process.cwd(), 'scripts/canvas-navigation-smoke.html')}`
/** 仅观察隔离内存。 */
const state = 'window.__canvasNavigationSmoke'
/** 按 DOM/atom 条件有界等待真实交互完成。 */
async function waitFor(window: BrowserWindow, expression: string): Promise<void> {
  const deadline = Date.now() + 12_000
  while (Date.now() < deadline) {
    if (await window.webContents.executeJavaScript(`Boolean(${expression})`)) return
    await new Promise<void>((resolve) => setTimeout(resolve, 40))
  }
  throw new Error(`等待失败：${expression}`)
}
/** 实际坐标点击覆盖 Portal 与焦点链路。 */
async function click(window: BrowserWindow, expression: string): Promise<void> {
  const point = await window.webContents.executeJavaScript(`(async () => {
    const element = ${expression}; if (!element || element.disabled) return null;
    element.scrollIntoView({block:'nearest'});
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const rect = element.getBoundingClientRect();
    return {x: Math.round(rect.left+rect.width/2), y: Math.round(rect.top+rect.height/2)};
  })()`)
  assert.ok(point, `无法点击：${expression}`)
  window.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 })
  window.webContents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 })
}
/** 用真实输入事件更新受控中文搜索框。 */
async function search(window: BrowserWindow, text: string): Promise<void> {
  await window.webContents.executeJavaScript(`document.querySelector('[aria-label="搜索画布节点"]').focus()`)
  await window.webContents.insertText(text)
}
/** Command 与 Radix 的键盘组合行为。 */
function key(window: BrowserWindow, keyCode: string): void {
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode })
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode })
}
/** 打开实际工具栏菜单。 */
async function openMenu(window: BrowserWindow): Promise<void> {
  await click(window, `document.querySelector('[aria-label="查看节点"]')`)
  await waitFor(window, `document.querySelector('[aria-label="搜索画布节点"]')`)
  await waitFor(window, `(() => {
    const menu = document.querySelector('[role="dialog"]');
    return menu && getComputedStyle(menu).opacity === '1'
      && menu.getAnimations().every(animation => animation.playState === 'finished');
  })()`)
}
/** 生产 Graph 中的卡片必须真的进入视口并选中。 */
async function assertFocused(window: BrowserWindow, nodeId: string): Promise<void> {
  await waitFor(window, `${state}.view()?.selectedNodeId === ${JSON.stringify(nodeId)}`)
  await waitFor(window, `!document.querySelector('[aria-label="搜索画布节点"]')`)
  await waitFor(window, `(() => {
    const surface = document.querySelector('[data-native-canvas-surface]').getBoundingClientRect();
    const card = document.querySelector('.react-flow__node[data-id="${nodeId}"]');
    if (!card || !card.classList.contains('selected')) return false;
    const rect = card.getBoundingClientRect();
    return rect.width > 100 && rect.left >= surface.left && rect.right <= surface.right
      && rect.top >= surface.top + 40 && rect.bottom <= surface.bottom;
  })()`)
  assert.equal(await window.webContents.executeJavaScript(`${state}.saveCalls`), 0)
}
/** 验证真实 Workspace、Graph、关系菜单及键鼠导航。 */
async function run(): Promise<void> {
  const userDataPath = mkdtempSync(join(tmpdir(), 'proma-canvas-navigation-'))
  app.setPath('userData', userDataPath)
  app.on('window-all-closed', () => {})
  await app.whenReady()
  const window = new BrowserWindow({ show: false, width: 1200, height: 800, webPreferences: { backgroundThrottling: false } })
  const errors: string[] = []
  window.webContents.on('console-message', (event) => {
    if (event.level === 'error') { errors.push(event.message); console.error('[测试页面]', event.message) }
  })
  /** JS 检查均限于测试窗口。 */
  const js = (expression: string): Promise<unknown> => window.webContents.executeJavaScript(expression)
  try {
    await window.loadURL(`${fixtureUrl}?theme=dark`)
    await waitFor(window, `document.querySelector('[aria-label="查看节点"]')`)
    const originalGraph = await js(`JSON.stringify(${state}.graph())`)
    await openMenu(window)
    assert.equal(await js(`document.querySelectorAll('[data-canvas-navigation-node]').length`), 4)
    assert.equal(await js(`document.querySelector('[data-canvas-navigation-node="node-a"]').textContent.includes('下游：镜头（依赖）')`), true)
    assert.equal(await js(`document.querySelector('[data-canvas-navigation-node="node-b"]').textContent.includes('上游：首帧母版（依赖）')`), true)
    assert.equal(await js(`document.querySelector('[data-canvas-navigation-node="node-b"]').textContent.includes('关联：镜头')`), true)
    assert.equal(await js(`document.querySelector('[data-canvas-navigation-node="node-d"]').textContent.includes('暂无关联')`), true)
    await writeFile('/private/tmp/canvas-navigation-dark.png', (await window.webContents.capturePage()).toPNG())
    await search(window, '镜头')
    await waitFor(window, `document.querySelectorAll('[data-canvas-navigation-node]').length === 2`)
    await click(window, `document.querySelector('[data-canvas-navigation-node="node-c"]')`)
    await assertFocused(window, 'node-c')
    await openMenu(window)
    await search(window, '视频')
    await waitFor(window, `document.querySelectorAll('[data-canvas-navigation-node]').length === 1`)
    key(window, 'Enter')
    await assertFocused(window, 'node-b')
    await openMenu(window)
    key(window, 'Escape')
    await waitFor(window, `!document.querySelector('[aria-label="搜索画布节点"]')`)
    assert.equal(await js(`document.activeElement?.getAttribute('aria-label')`), '查看节点')
    assert.equal(await js(`JSON.stringify(${state}.graph())`), originalGraph)
    await js(`${state}.replace(false, false)`)
    await openMenu(window)
    await click(window, `document.querySelector('[data-canvas-navigation-node="node-a"]')`)
    await assertFocused(window, 'node-a')
    await js(`${state}.replace(true, false)`)
    await openMenu(window)
    await waitFor(window, `document.body.textContent.includes('画布中暂无节点')`)
    key(window, 'Escape')
    await js(`${state}.replace(false, false); document.documentElement.classList.remove('dark')`)
    window.setSize(420, 740)
    await openMenu(window)
    await waitFor(window, `document.querySelector('[role="dialog"]').getBoundingClientRect().width <= 420`)
    await writeFile('/private/tmp/canvas-navigation-light-narrow.png', (await window.webContents.capturePage()).toPNG())
    await search(window, '独立备注')
    await waitFor(window, `document.querySelectorAll('[data-canvas-navigation-node]').length === 1`)
    key(window, 'Enter')
    await assertFocused(window, 'node-d')
    assert.deepEqual(errors, [], '真实页面不能产生运行错误')
    console.log('[画布节点导航] PASS：真实 Workspace/Graph、全部关联、中文搜索、重名、鼠标/键盘定位、Escape焦点、只读、空图、窄面板、深浅主题；图保存为 0。')
  } finally {
    window.destroy()
    await rm(userDataPath, { recursive: true, force: true })
  }
}
void run().then(() => app.quit()).catch((error: unknown) => { console.error(error); app.exit(1) })
