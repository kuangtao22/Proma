import { strict as assert } from 'node:assert'
import { mkdtempSync } from 'node:fs'
import { rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app, BrowserWindow } from 'electron'

/** 可选端口只改变隔离 fixture 的 Vite 地址。 */
const fixturePort = process.env.PROMA_MEDIA_SMOKE_PORT ?? '5177'
/** fixture 使用生产设置组件及内存接口，不访问用户配置或远端。 */
const fixtureUrl = `http://127.0.0.1:${fixturePort}/@fs${join(process.cwd(), 'scripts/media-workflow-ui-smoke.html')}`

/** 有界等待 DOM 条件，失败时报告对应交互。 */
async function waitFor(window: BrowserWindow, expression: string, message: string): Promise<void> {
  /** 本条断言的截止时间。 */
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (await window.webContents.executeJavaScript(`Boolean(${expression})`)) return
    await new Promise<void>((resolve) => setTimeout(resolve, 40))
  }
  throw new Error(message)
}

/** 点击精确的文本或可访问标签，并等待实际按钮就绪。 */
async function click(window: BrowserWindow, label: string): Promise<void> {
  /** 只定位当前真实 DOM 中的按钮/页签。 */
  const target = `[...document.querySelectorAll('button')].find((button) => button.textContent?.trim() === ${JSON.stringify(label)} || button.getAttribute('aria-label') === ${JSON.stringify(label)})`
  await waitFor(window, target, `缺少入口：${label}`)
  await window.webContents.executeJavaScript(`(() => {
    const button = ${target};
    if (button.getAttribute('role') === 'tab') button.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    button.click();
  })()`)
}

/** 验证整个设置导航链，最终回到稳定工作流列表。 */
async function openWorkflows(window: BrowserWindow, theme: string): Promise<void> {
  await window.loadURL(`${fixtureUrl}?theme=${theme}`)
  await click(window, '服务连接')
  await click(window, '编辑 测试服务')
  await click(window, '工作流')
  await waitFor(window, "[...document.querySelectorAll('button')].some((button) => button.textContent?.startsWith('ui.json'))", '工作流列表未就绪')
}

/** 用点击条目打开详情，不能退回行内展开。 */
async function openFile(window: BrowserWindow, name = 'ui.json'): Promise<void> {
  await window.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find((button) => button.textContent?.startsWith(${JSON.stringify(name)}))?.click()`)
  await waitFor(window, "document.querySelector('[role=dialog]')", '点击工作流没有打开弹窗')
}

/** 检查实际代码编辑器完整性、虚拟化、复制和只读行为。 */
async function verifyEditor(window: BrowserWindow): Promise<void> {
  await waitFor(window, "window.__mediaWorkflowSmoke.getEditor()", '代码编辑器未挂载')
  /** 完整文档来自 CodeMirror 状态，可视行数证明没有全量 DOM。 */
  const result = await window.webContents.executeJavaScript(`(() => {
    const view = window.__mediaWorkflowSmoke.getEditor();
    return {
      complete: view.state.doc.toString() === window.__mediaWorkflowSmoke.expected,
      readonly: view.contentDOM.getAttribute('aria-readonly'),
      editable: view.contentDOM.getAttribute('contenteditable'),
      lines: view.state.doc.lines,
      renderedLines: document.querySelectorAll('.cm-line').length,
      gutters: document.querySelectorAll('.cm-lineNumbers').length,
    };
  })()`)
  assert.equal(result.complete, true, '编辑器丢失正文或节点尾部字段')
  assert.equal(result.readonly, 'true')
  assert.equal(result.editable, 'false')
  assert.ok(result.lines > 1000 && result.renderedLines < 300, '大型 JSON 未按视口渲染')
  assert.ok(result.gutters > 0, '缺少行号')
  await window.webContents.executeJavaScript('window.__mediaWorkflowSmoke.getEditor().focus()')
  await window.webContents.insertText('不得改动')
  assert.equal(await window.webContents.executeJavaScript('window.__mediaWorkflowSmoke.getEditor().state.doc.toString() === window.__mediaWorkflowSmoke.expected'), true)
  await click(window, '复制完整工作流 JSON')
  await waitFor(window, 'window.__mediaWorkflowSmoke.copied === window.__mediaWorkflowSmoke.expected', '复制没有保留完整正文')
}

/** 使用真实键盘 Esc 关闭，并确认编辑器被销毁。 */
async function closeWithEscape(window: BrowserWindow): Promise<void> {
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
  await waitFor(window, "!document.querySelector('[role=dialog]') && !document.querySelector('.cm-editor')", 'Esc 关闭后仍保留弹窗或编辑器')
}

/** 验证关闭、重开、读取中关闭、失败重试与显式导入。 */
async function verifyInteractions(window: BrowserWindow): Promise<void> {
  await openWorkflows(window, 'dark')
  assert.equal(await window.webContents.executeJavaScript('window.__mediaWorkflowSmoke.readCount'), 0, '列表提前读取正文')
  await openFile(window)
  await verifyEditor(window)
  assert.equal(await window.webContents.executeJavaScript(`(() => {
    const issues = document.querySelector('[aria-label="工作流分析问题"]')?.textContent ?? '';
    return issues.includes('UI_WIDGET_UNMAPPED') && issues.includes('节点 5') && issues.includes('字段 image')
      && ![...document.querySelectorAll('[role=dialog] button')].some((button) => button.textContent.includes('导入公共草稿'));
  })()`), true, '阻塞问题缺少定位或仍允许导入')
  await closeWithEscape(window)
  assert.equal(await window.webContents.executeJavaScript("document.activeElement?.textContent?.startsWith('ui.json')"), true, '关闭后焦点没有回到原条目')
  await openFile(window)
  await click(window, '关闭')
  await waitFor(window, "!document.querySelector('[role=dialog]')", '关闭按钮无效')
  await openFile(window)
  /** 点击遮罩可关闭只读详情。 */
  window.webContents.sendInputEvent({ type: 'mouseDown', x: 3, y: 3, button: 'left', clickCount: 1 })
  window.webContents.sendInputEvent({ type: 'mouseUp', x: 3, y: 3, button: 'left', clickCount: 1 })
  await waitFor(window, "!document.querySelector('[role=dialog]')", '点击遮罩没有关闭弹窗')
  await window.webContents.executeJavaScript("window.__mediaWorkflowSmoke.readMode = 'deferred'")
  await openFile(window)
  await waitFor(window, "document.querySelector('[role=status]')", '读取中没有加载状态')
  await closeWithEscape(window)
  await window.webContents.executeJavaScript('window.__mediaWorkflowSmoke.release()')
  await window.webContents.executeJavaScript('new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
  assert.equal(await window.webContents.executeJavaScript("Boolean(document.querySelector('.cm-editor'))"), false, '迟到响应重新打开详情')
  await window.webContents.executeJavaScript("window.__mediaWorkflowSmoke.readMode = 'fail'")
  await openFile(window)
  await waitFor(window, "document.querySelector('[role=alert]')?.textContent.includes('测试读取失败')", '读取失败没有局部错误')
  await window.webContents.executeJavaScript("window.__mediaWorkflowSmoke.readMode = 'normal'")
  await click(window, '重试')
  await verifyEditor(window)
  await closeWithEscape(window)
  await openFile(window, 'api.json')
  await click(window, '导入公共草稿')
  await waitFor(window, "!document.querySelector('[role=dialog]') && document.body.textContent.includes('工作流名称')", '导入后未进入公共草稿或弹窗未关闭')
  await openWorkflows(window, 'light')
  await openFile(window, 'converted.json')
  await waitFor(window, "document.body.textContent.includes('已转换并通过校验')", '可转换 UI 未展示校验状态')
  await click(window, '导入公共草稿')
  await waitFor(window, "!document.querySelector('[role=dialog]') && document.body.textContent.includes('工作流名称')", '可转换 UI 未进入公共草稿')
}

/** 截图前检查弹窗、编辑器、关闭按钮均在视口内。 */
async function capture(window: BrowserWindow, theme: string, width: number): Promise<void> {
  window.setContentSize(width, 820)
  await openWorkflows(window, theme)
  await openFile(window)
  await verifyEditor(window)
  // 等待弹窗入场动画结束，避免半透明过渡影响截图判断。
  await window.webContents.executeJavaScript(`Promise.all(document.getAnimations()
    .filter((animation) => Number.isFinite(animation.effect?.getComputedTiming().endTime))
    .map((animation) => animation.finished.catch(() => undefined)))`)
  await window.webContents.executeJavaScript('new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
  /** 弹窗与内部编辑器的几何边界。 */
  const fits = await window.webContents.executeJavaScript(`['[role=dialog]', '.cm-editor'].every((selector) => {
    const rect = document.querySelector(selector).getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight;
  })`)
  assert.equal(fits, true, `${theme}/${width} 弹窗或编辑器越界`)
  /** 只保存隔离 fixture 截图，不包含用户实际资源内容。 */
  const screenshot = await window.webContents.capturePage()
  assert.equal(screenshot.isEmpty(), false)
  await writeFile(`/private/tmp/media-workflow-${theme}-${width}.png`, screenshot.toPNG())
  await closeWithEscape(window)
}

/** 独立 Electron 实例只运行内存 fixture，结束后释放所有临时状态。 */
async function run(): Promise<void> {
  console.log('[Media workflow smoke] START')
  /** Electron 内部数据使用临时目录，避免污染用户实例。 */
  const userDataPath = mkdtempSync(join(tmpdir(), 'proma-media-workflow-smoke-'))
  app.setPath('userData', userDataPath)
  app.on('window-all-closed', () => {})
  await app.whenReady()
  /** 隐藏测试窗口仍保持真实渲染与输入事件。 */
  const window = new BrowserWindow({ width: 1180, height: 820, show: false, webPreferences: { backgroundThrottling: false } })
  window.webContents.on('console-message', (event) => {
    if (event.level === 'error') console.error(`[Media workflow renderer] ${event.message}`)
  })
  try {
    await verifyInteractions(window)
    await capture(window, 'dark', 1180)
    await capture(window, 'light', 430)
    console.log('[Media workflow smoke] PASS: 问题定位、阻塞导入、UI/API 导入、弹窗交互、完整复制、只读、虚拟化及双主题尺寸验证通过')
  } finally {
    window.destroy()
    await rm(userDataPath, { recursive: true, force: true })
  }
}
void run().then(() => app.quit()).catch((error: unknown) => { console.error(error); app.exit(1) })
