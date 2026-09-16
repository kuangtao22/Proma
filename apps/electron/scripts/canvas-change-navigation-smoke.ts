import { strict as assert } from 'node:assert'
import { mkdtempSync } from 'node:fs'
import { rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app, BrowserWindow } from 'electron'

/** 复用既有 Vite，隐藏测试窗口不连接用户客户端。 */
const fixtureUrl = `http://127.0.0.1:${process.env.PROMA_CANVAS_SMOKE_PORT ?? '5193'}/@fs${join(process.cwd(), 'scripts/canvas-change-navigation-smoke.html')}`
/** 仅观察隔离内存。 */
const state = 'window.__canvasNavigationSmoke'
/** 按 DOM/atom 条件有界等待真实交互完成。 */
async function waitFor(window: BrowserWindow, expression: string): Promise<void> {
  const deadline = Date.now() + 45_000
  while (Date.now() < deadline) {
    if (await window.webContents.executeJavaScript(`Boolean(${expression})`)) return
    await new Promise<void>((resolve) => setTimeout(resolve, 40))
  }
  console.error('[导航测试超时现场]', await window.webContents.executeJavaScript(`({
    smoke: Object.keys(window.__canvasNavigationSmoke ?? {}), body: document.body.textContent.slice(0, 1000),
    statuses: Array.from(document.querySelectorAll('[role="status"]'), element => element.textContent),
    nodes: Array.from(document.querySelectorAll('[data-canvas-navigation-node]'), element => element.getAttribute('data-canvas-navigation-node')),
    search: document.querySelector('[aria-label="搜索画布节点"]')?.value,
  })`))
  throw new Error(`等待失败：${expression}`)
}

/** 验证实际 XYFlow 卡片进入视口，而非仅选中 atom 改变。 */
async function visible(window: BrowserWindow, nodeId: string): Promise<void> {
  await waitFor(window, `(() => {
    const card = document.querySelector('.react-flow__node[data-id="${nodeId}"]');
    const surface = document.querySelector('[data-native-canvas-surface]');
    if (!card || !surface) return false;
    const r = card.getBoundingClientRect(), s = surface.getBoundingClientRect();
    return card.classList.contains('selected') && r.left >= s.left && r.right <= s.right && r.top >= s.top && r.bottom <= s.bottom;
  })()`)
}
/** 隔离 Electron 验证消费回执、摘要与真实 Workspace，不连接业务目录。 */
async function run(): Promise<void> {
  const userDataPath = mkdtempSync(join(tmpdir(), 'proma-canvas-change-'))
  app.setPath('userData', userDataPath)
  app.on('window-all-closed', () => {})
  await app.whenReady()
  const window = new BrowserWindow({ show: false, width: 1200, height: 900, webPreferences: { backgroundThrottling: false } })
  const errors: string[] = []
  window.webContents.on('console-message', event => { if (event.level === 'error') { errors.push(event.message); console.error(event.message) } })
  const js = (code: string): Promise<unknown> => window.webContents.executeJavaScript(code)
  try {
    await window.loadURL(`${fixtureUrl}?theme=dark`)
    await waitFor(window, `${state}.start`)
    assert.equal(await js("Boolean(document.querySelector('[data-native-canvas-surface]'))"), false)
    await js(`${state}.run(1); ${state}.start('first'); ${state}.change('first', ['node-c'])`)
    await visible(window, 'node-c')
    assert.equal(await js(`${state}.view().expandedNodeId`), 'node-c')
    const viewport = await js(`JSON.stringify(${state}.view().viewport)`)
    await js(`${state}.start('second'); ${state}.change('second', ['node-d'])`)
    await waitFor(window, `${state}.notice().changes === 2`)
    assert.equal(await js(`JSON.stringify(${state}.view().viewport)`), viewport, '连续修改不能再次跳页')
    await js(`document.querySelector('details').open = true; Array.from(document.querySelectorAll('button')).find(b => b.textContent === '查看位置').click()`)
    await visible(window, 'node-c'); await visible(window, 'node-d')
    assert.equal(await js(`${state}.view().expandedNodeId`), null)
    await js(`${state}.run(2); ${state}.start('late'); ${state}.change('late', ['node-b'], 5)`)
    await waitFor(window, `${state}.notice().revision === 5`)
    assert.equal(await js(`${state}.view().selectedNodeId`), 'node-c')
    await js(`${state}.graphRevision(5)`)
    await visible(window, 'node-b')
    await js(`${state}.dirty(true); ${state}.run(3); ${state}.start('dirty'); ${state}.change('dirty', ['node-d'], 5)`)
    await waitFor(window, `${state}.notice().nodeIds[0] === 'node-d'`)
    assert.equal(await js(`${state}.view().selectedNodeId`), 'node-b')
    await writeFile('/private/tmp/proma-canvas-change-dark.png', (await window.webContents.capturePage()).toPNG())
    await js(`${state}.dirty(false); document.documentElement.classList.remove('dark')`)
    window.setSize(620, 800)
    await js(`Array.from(document.querySelectorAll('button')).find(b => b.textContent === '查看位置').click()`)
    await visible(window, 'node-d')
    await writeFile('/private/tmp/proma-canvas-change-light.png', (await window.webContents.capturePage()).toPNG())
    assert.equal(await js(`${state}.saveCalls`), 0, '导航不得保存业务图')
    assert.deepEqual(errors, [])
    console.log('PASS：首次自动打开、单节点详情、批量摘要定位、后续不抢焦点、迟到 LOAD、草稿保护、深浅主题与窄视口；业务保存 0 次。')
  } finally { window.destroy(); await rm(userDataPath, { recursive: true, force: true }) }
}
void run().then(() => app.quit()).catch(error => { console.error(error); app.exit(1) })
