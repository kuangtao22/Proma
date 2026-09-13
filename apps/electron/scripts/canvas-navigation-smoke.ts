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
  console.error('[导航测试超时现场]', await window.webContents.executeJavaScript(`({
    statuses: Array.from(document.querySelectorAll('[role="status"]'), element => element.textContent),
    nodes: Array.from(document.querySelectorAll('[data-canvas-navigation-node]'), element => element.getAttribute('data-canvas-navigation-node')),
    search: document.querySelector('[aria-label="搜索画布节点"]')?.value,
  })`))
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
  await window.webContents.executeJavaScript(`document.querySelector('[aria-label="搜索画布节点"]').select()`)
  if (text) await window.webContents.insertText(text)
  else key(window, 'Backspace')
}
/** Command 与 Radix 的键盘组合行为。 */
function key(window: BrowserWindow, keyCode: string): void {
  window.webContents.focus()
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode })
  // 原生按钮依赖 keypress 默认动作，单发 keyDown 只能覆盖 cmdk 的自定义处理器。
  if (keyCode === 'Enter' || keyCode === 'Space') {
    window.webContents.sendInputEvent({ type: 'char', keyCode: keyCode === 'Enter' ? '\r' : ' ' })
  }
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
    // Given 混合类型图 When 打开菜单 Then 六类入口及数量完整，默认显示全部。
    assert.equal(await js(`document.querySelectorAll('[data-canvas-navigation-kind]').length`), 7)
    assert.equal(await js(`document.querySelector('[data-canvas-navigation-kind="all"]').getAttribute('aria-pressed')`), 'true')
    assert.deepEqual(await js(`Array.from(document.querySelectorAll('[data-canvas-navigation-kind]'), button => button.textContent)`),
      ['全部4', 'Agent0', '生图1', '文档2', '原型0', '音频0', '视频1'])
    await writeFile('/private/tmp/canvas-navigation-dark.png', (await window.webContents.capturePage()).toPNG())
    // Given 类型与关键词同时存在 When 切换类型 Then 取交集并保留关键词和跨类型关系。
    await click(window, `document.querySelector('[data-canvas-navigation-kind="video"]')`)
    await waitFor(window, `document.querySelectorAll('[data-canvas-navigation-node]').length === 1`)
    assert.equal(await js(`document.querySelector('[data-canvas-navigation-node]').getAttribute('data-canvas-navigation-node')`), 'node-b')
    assert.equal(await js(`document.querySelector('[data-canvas-navigation-node="node-b"]').textContent.includes('上游：首帧母版（依赖）')`), true)
    assert.equal(await js(`document.querySelector('[data-canvas-navigation-node="node-b"]').textContent.includes('关联：镜头')`), true)
    await search(window, '镜头')
    await click(window, `document.querySelector('[data-canvas-navigation-kind="document"]')`)
    await waitFor(window, `document.querySelector('[data-canvas-navigation-node="node-c"]') && document.querySelectorAll('[data-canvas-navigation-node]').length === 1`)
    assert.equal(await js(`document.querySelector('[aria-label="搜索画布节点"]').value`), '镜头')
    await waitFor(window, `document.querySelector('[role="dialog"] [role="status"]').textContent === '文档 · 1 / 4'`)
    // Given 搜索无结果或该类型不存在 When 筛选 Then 提供正确空状态，恢复全部后节点可达。
    await search(window, '不存在的节点')
    await waitFor(window, `document.body.textContent.includes('没有匹配的节点')`)
    await waitFor(window, `document.querySelector('[role="dialog"] [role="status"]').textContent === '文档 · 0 / 4'`)
    await search(window, '')
    await waitFor(window, `document.querySelectorAll('[data-canvas-navigation-node]').length === 2`)
    await click(window, `document.querySelector('[data-canvas-navigation-kind="audio"]')`)
    await waitFor(window, `document.body.textContent.includes('画布中暂无音频节点')`)
    await click(window, `document.querySelector('[data-canvas-navigation-kind="all"]')`)
    await waitFor(window, `document.querySelectorAll('[data-canvas-navigation-node]').length === 4`)
    assert.equal(await js(`JSON.stringify(${state}.graph())`), originalGraph)
    assert.equal(await js(`${state}.saveCalls`), 0)
    // Given 焦点位于类型按钮 When Enter 或 Space Then 仅切换筛选，不触发节点定位或关闭菜单。
    await js(`document.querySelector('[data-canvas-navigation-kind="video"]').focus()`)
    key(window, 'Enter')
    await waitFor(window, `document.querySelector('[data-canvas-navigation-kind="video"]')?.getAttribute('aria-pressed') === 'true'`)
    await js(`document.querySelector('[data-canvas-navigation-kind="document"]').focus()`)
    key(window, 'Space')
    await waitFor(window, `document.querySelector('[data-canvas-navigation-kind="document"]')?.getAttribute('aria-pressed') === 'true'`)
    await click(window, `document.querySelector('[data-canvas-navigation-kind="all"]')`)
    await search(window, '镜头')
    await waitFor(window, `document.querySelectorAll('[data-canvas-navigation-node]').length === 2`)
    await click(window, `document.querySelector('[data-canvas-navigation-node="node-c"]')`)
    await assertFocused(window, 'node-c')
    await openMenu(window)
    assert.equal(await js(`document.querySelector('[data-canvas-navigation-kind="all"]').getAttribute('aria-pressed')`), 'true')
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
    await click(window, `document.querySelector('[data-canvas-navigation-kind="image"]')`)
    await click(window, `document.querySelector('[data-canvas-navigation-node="node-a"]')`)
    await assertFocused(window, 'node-a')
    await openMenu(window)
    await click(window, `document.querySelector('[data-canvas-navigation-kind="video"]')`)
    // Given 菜单保持打开 When 权威图变为空再恢复 Then 类型计数和结果随快照更新。
    await js(`${state}.replace(true, false)`)
    await waitFor(window, `document.body.textContent.includes('画布中暂无节点')`)
    await waitFor(window, `document.querySelector('[data-canvas-navigation-kind="all"]').textContent === '全部0'`)
    await js(`${state}.replace(false, false)`)
    await waitFor(window, `document.querySelector('[data-canvas-navigation-node="node-b"]') && document.querySelectorAll('[data-canvas-navigation-node]').length === 1`)
    key(window, 'Escape')
    await js(`${state}.replace(false, false); document.documentElement.classList.remove('dark')`)
    window.setSize(420, 740)
    await openMenu(window)
    await waitFor(window, `document.querySelector('[role="dialog"]').getBoundingClientRect().width <= 420`)
    await click(window, `document.querySelector('[data-canvas-navigation-kind="document"]')`)
    await waitFor(window, `document.querySelector('[data-canvas-navigation-kind="document"]').getAttribute('aria-pressed') === 'true'
      && document.querySelectorAll('[data-canvas-navigation-node]').length === 2`)
    assert.equal(await js(`(() => {
      const menu = document.querySelector('[role="dialog"]').getBoundingClientRect();
      return Array.from(document.querySelectorAll('[data-canvas-navigation-kind]')).every(button => {
        const rect = button.getBoundingClientRect();
        return rect.left >= menu.left && rect.right <= menu.right;
      });
    })()`), true)
    // DOM 更新与合成帧不同步，等两帧再截图，避免隐藏窗口保留上一次筛选画面。
    await js(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`)
    await writeFile('/private/tmp/canvas-navigation-light-narrow.png', (await window.webContents.capturePage()).toPNG())
    await search(window, '独立备注')
    await waitFor(window, `document.querySelectorAll('[data-canvas-navigation-node]').length === 1`)
    key(window, 'Enter')
    await assertFocused(window, 'node-d')
    assert.deepEqual(errors, [], '真实页面不能产生运行错误')
    console.log('[画布节点导航] PASS：真实 Workspace/Graph、六类筛选及计数、关键词交集、跨类型关联、无结果/空类型/动态图、筛选按钮 Enter/Space、重开重置、鼠标/键盘定位、Escape焦点、只读、窄面板、深浅主题；图保存为 0。')
  } finally {
    window.destroy()
    await rm(userDataPath, { recursive: true, force: true })
  }
}
void run().then(() => app.quit()).catch((error: unknown) => { console.error(error); app.exit(1) })
