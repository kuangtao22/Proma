import { strict as assert } from 'node:assert'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { mkdtempSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import { createApiCatalogSnapshotExport, createApiRequestDraft } from '@proma/shared'

/** 等待真实 DOM 条件成立。 */
async function waitFor(window: BrowserWindow, expression: string, message: string): Promise<void> {
  const deadline = Date.now() + 12_000
  while (Date.now() < deadline) {
    if (await window.webContents.executeJavaScript(`Boolean(${expression})`)) return
    await new Promise<void>((resolve) => setTimeout(resolve, 40))
  }
  assert.fail(message)
}

/** React 受控输入必须通过原生 setter 触发 input。 */
async function fill(window: BrowserWindow, selector: string, value: string): Promise<void> {
  const changed = await window.webContents.executeJavaScript(`(() => {
    const field = document.querySelector(${JSON.stringify(selector)})
    if (field instanceof HTMLTextAreaElement) {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(field, ${JSON.stringify(value)})
      field.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    }
    if (!(field instanceof HTMLInputElement)) return false
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(field, ${JSON.stringify(value)})
    field.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  assert.equal(changed, true, `找不到输入框 ${selector}`)
}

/** 按 aria-label 点击生产控件。 */
async function clickLabel(window: BrowserWindow, label: string): Promise<void> {
  const clicked = await window.webContents.executeJavaScript(`(() => { const item = document.querySelector(${JSON.stringify(`[aria-label="${label}"]`)}); if (!(item instanceof HTMLElement)) return false; item.click(); return true })()`)
  assert.equal(clicked, true, `找不到控件 ${label}`)
}

/** 按精确文本点击按钮。 */
async function clickText(window: BrowserWindow, text: string): Promise<void> {
  const clicked = await window.webContents.executeJavaScript(`(() => { const item = [...document.querySelectorAll('button')].find((button) => button.textContent?.trim() === ${JSON.stringify(text)}); if (!(item instanceof HTMLButtonElement)) return false; item.click(); return true })()`)
  assert.equal(clicked, true, `找不到按钮 ${text}`)
}

/** 等待 Radix 弹层完成退出动画，避免截图捕获关闭中的残影。 */
async function waitForClosedLayersToLeave(window: BrowserWindow): Promise<void> {
  await waitFor(window, `![...document.querySelectorAll('[data-state="closed"]')].some((item) => {
    if (!(item instanceof HTMLElement)) return false
    const style = getComputedStyle(item)
    const rect = item.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0 && (item.getAttribute('role') === 'dialog' || style.position === 'fixed')
  })`, '关闭态弹层未完成离场')
}

/** 取得空闲回环端口。 */
async function availablePort(): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') { server.close(); reject(new Error('无法分配 smoke 端口')); return }
      server.close(() => resolve(String(address.port)))
    })
  })
}

/** Electron 子进程执行真实组件交互与截图。 */
async function runElectronSmoke(app: import('electron').App, BrowserWindow: typeof import('electron').BrowserWindow, userData: string): Promise<void> {
  const window = new BrowserWindow({ width: 1180, height: 820, show: false, backgroundColor: '#ffffff', webPreferences: { backgroundThrottling: false } })
  window.webContents.on('console-message', (_event, _level, message, lineNumber, sourceId) => console.log(`[API Workbench UI smoke] renderer ${sourceId}:${lineNumber}: ${message}`))
  window.webContents.on('did-fail-load', (_event, code, description) => console.error(`[API Workbench UI smoke] load failed ${code}: ${description}`))
  try {
    console.log('[API Workbench UI smoke] 加载组件页面')
    await window.loadURL(process.env.PROMA_API_UI_SMOKE_URL!)
    await waitFor(window, "document.body.dataset.smokeReady === 'true' && document.body.textContent?.includes('默认集合')", '接口工作台未挂载')
    console.log('[API Workbench UI smoke] 组件已挂载')
    await clickLabel(window, '新建集合')
    await waitFor(window, "document.querySelector('[role=dialog]') && document.body.textContent?.includes('新建集合')", '新建集合 Dialog 未打开')
    await fill(window, 'input[aria-label="新建集合"]', 'Smoke 集合')
    await clickText(window, '确认')
    await waitFor(window, "document.body.textContent?.includes('Smoke 集合')", '新集合未保存')
    console.log('[API Workbench UI smoke] 集合 Dialog 已验证')
    const opened = await window.webContents.executeJavaScript(`(() => { const section = [...document.querySelectorAll('section')].find((item) => item.textContent?.includes('Smoke 集合')); const button = section?.querySelector('button[aria-label="新建请求"]'); if (!(button instanceof HTMLButtonElement)) return false; button.click(); return true })()`)
    assert.equal(opened, true, '新集合中没有新建请求入口')
    await fill(window, 'input[aria-label="请求名称"]', 'Smoke 请求')
    await fill(window, 'input[aria-label="请求 URL"]', 'http://127.0.0.1:8080/smoke')
    await clickLabel(window, '保存请求 (⌘S)')
    await waitFor(window, "window.__apiWorkbenchSmoke.catalog.requests.length === 1", '请求未保存')
    await clickText(window, '发送')
    await waitFor(window, "window.__apiWorkbenchSmoke.sendCalls === 1 && document.body.textContent?.includes('200')", '请求未进入响应视图')
    console.log('[API Workbench UI smoke] 保存与发送已验证')
    await clickLabel(window, '查看本地原始内容')
    await waitFor(window, "window.__apiWorkbenchSmoke.revealGetRunCalls === 1 && window.__apiWorkbenchSmoke.revealBodyCalls === 1 && document.body.textContent?.includes('本地原始内容')", '原始内容 reveal 未完成')
    console.log('[API Workbench UI smoke] 原始内容 reveal 已验证')
    /** 导入 cURL：先预览，再作为草稿打开，最后可保存到集合。 */
    await clickLabel(window, '导入接口')
    await waitFor(window, "document.querySelector('textarea[aria-label=\"粘贴 cURL 或集合快照\"]')", '导入对话框未打开')
    await fill(window, 'textarea[aria-label="粘贴 cURL 或集合快照"]', "curl -X POST https://api.example.com/imported -H 'X-From: curl' -d 'a=1'")
    await waitFor(window, "document.body.textContent?.includes('识别到 1 条请求')", '未识别到 cURL 草稿')
    /** 等上层离场动画结束后再截图，避免把已关闭的弹层拍进证据。 */
    await waitForClosedLayersToLeave(window)
    const importShot = await window.webContents.capturePage()
    await writeFile('/private/tmp/api-workbench-ui-import.png', importShot.toPNG())
    await clickText(window, '确认导入')
    await waitFor(window, "document.body.textContent?.includes('已导入 1 条请求草稿')", '导入草稿后没有反馈')
    await clickLabel(window, '保存请求 (⌘S)')
    await waitFor(window, "window.__apiWorkbenchSmoke.catalog.requests.length === 2", '导入的草稿未保存成功')
    const imported = await window.webContents.executeJavaScript("window.__apiWorkbenchSmoke.catalog.requests.find((item) => item.url === 'https://api.example.com/imported')")
    assert.equal(imported?.method, 'POST', '导入请求的方法不正确')
    assert.equal(imported?.body.kind, 'urlencoded', '导入请求的正文类型不正确')
    assert.equal(imported?.headers[0]?.value, 'curl', '导入请求的请求头不正确')
    console.log('[API Workbench UI smoke] cURL 导入与保存已验证')
    /** 导入集合快照：以新增方式合并，并提示需要重填的秘密。 */
    const snapshot = createApiCatalogSnapshotExport({
      version: 1,
      revision: 0,
      collections: [{ id: 'shared', name: '共享集合', description: '', variables: [] }],
      environments: [],
      requests: [{
        ...createApiRequestDraft('shared'),
        id: 'shared-req',
        revision: 1,
        updatedAt: 1,
        name: '共享请求',
        url: 'https://api.example.com/shared',
        headers: [{ id: 'shared-h', name: 'Authorization', value: 'Bearer shared-secret', enabled: true, secret: true }],
      }],
    }, Date.now())
    assert.equal(snapshot.text.includes('shared-secret'), false, '快照仍包含秘密明文')
    await clickLabel(window, '导入接口')
    await fill(window, 'textarea[aria-label="粘贴 cURL 或集合快照"]', snapshot.text)
    await waitFor(window, "document.body.textContent?.includes('全部作为新增内容导入')", '快照预览未显示')
    assert.equal(await window.webContents.executeJavaScript("document.body.textContent?.includes('需要重新填写') ?? false"), true, '未提示需要重填的秘密')
    await clickText(window, '确认导入')
    await waitFor(window, "window.__apiWorkbenchSmoke.catalog.collections.length === 3 && window.__apiWorkbenchSmoke.catalog.requests.length === 3", '快照导入未生效')
    assert.equal(await window.webContents.executeJavaScript("document.body.textContent?.includes('已导入 1 个集合') ?? false"), true, '快照导入后没有反馈')
    assert.equal(await window.webContents.executeJavaScript("Boolean(document.querySelector('[aria-label=\"复制为 cURL\"]'))"), true, '缺少复制为 cURL 入口')
    assert.equal(await window.webContents.executeJavaScript("Boolean(document.querySelector('[aria-label=\"复制集合快照\"]'))"), true, '缺少复制集合快照入口')
    console.log('[API Workbench UI smoke] 集合快照导入与导出入口已验证')
    /** 事件流：实时增量在界面可见，且首事件耗时与心跳注释都能读到。 */
    await window.webContents.executeJavaScript(`window.__apiWorkbenchEmitStream({ sessionId: 'session-smoke', runId: 'run-smoke', events: [
      { index: 0, receivedMs: 12, event: '', id: '', comment: 'keep-alive', data: '', raw: ': keep-alive\\n\\n', truncated: false },
      { index: 1, receivedMs: 48, event: 'delta', id: '7', comment: '', data: '第一段', raw: 'event: delta\\nid: 7\\ndata: 第一段\\n\\n', truncated: false },
    ] })`)
    await waitFor(window, "document.body.textContent?.includes('实时接收中')", '事件流实时状态未显示')
    await waitFor(window, "document.body.textContent?.includes('第一段') && document.body.textContent?.includes('心跳')", '实时事件明细未渲染')
    /** 等一帧再截图，确保隐藏窗口已经完成这次重绘。 */
    await new Promise((resolve) => setTimeout(resolve, 200))
    assert.equal(await window.webContents.executeJavaScript("document.body.textContent?.includes('实时接收中') ?? false"), true, '实时状态在截图前消失')
    const streamShot = await window.webContents.capturePage()
    await writeFile('/private/tmp/api-workbench-ui-sse.png', streamShot.toPNG())
    console.log('[API Workbench UI smoke] 事件流实时渲染已验证')
    await clickLabel(window, '运行历史')
    await waitFor(window, "document.body.textContent?.includes('历史') && document.body.textContent?.includes('Smoke 请求')", '历史未打开')
    await clickLabel(window, '打开运行 Smoke 请求')
    await waitFor(window, "window.__apiWorkbenchSmoke.getRunCalls === 2", '历史运行未读取')
    /** 落盘的事件明细走运行记录分区，同样不重发请求。 */
    await clickText(window, '事件')
    await waitFor(window, "document.body.textContent?.includes('事件总数 2')", '事件分区未显示落盘明细')
    assert.equal(await window.webContents.executeJavaScript('window.__apiWorkbenchSmoke.sendCalls'), 1, '打开历史导致重复发送')
    /** 用当前定义重发：复用已保存请求的最新版本，秘密无需重新输入。 */
    await clickLabel(window, '用当前定义重发')
    await waitFor(window, "window.__apiWorkbenchSmoke.sendCalls === 2 && document.body.textContent?.includes('已按当前定义重发')", '重发没有触发第二次发送')
    console.log('[API Workbench UI smoke] 历史重发已验证')
    /** 运行时变量面板：只显示元数据，并可一键清空。 */
    await clickLabel(window, '运行时变量')
    await waitFor(window, "document.body.textContent?.includes('sessionToken') && document.body.textContent?.includes('秘密')", '运行时变量面板未显示元数据')
    assert.equal(await window.webContents.executeJavaScript("document.body.textContent?.includes('请求「Smoke 请求」') ?? false"), true, '运行时变量面板未显示来源')
    await clickText(window, '清空')
    await waitFor(window, "document.body.textContent?.includes('还没有提取到变量')", '清空后没有空状态')
    console.log('[API Workbench UI smoke] 运行时变量面板已验证')
    await waitForClosedLayersToLeave(window)
    await waitFor(window, `(() => {
      const request = document.querySelector('input[aria-label="请求 URL"]')
      const status = [...document.querySelectorAll('body *')].find((item) => item.children.length === 0 && item.textContent?.trim() === '200')
      if (!(request instanceof HTMLElement) || !(status instanceof HTMLElement)) return false
      const requestRect = request.getBoundingClientRect()
      const statusRect = status.getBoundingClientRect()
      return requestRect.width > 0 && requestRect.bottom <= innerHeight && statusRect.width > 0 && statusRect.bottom <= innerHeight
    })()`, '宽布局未同时显示请求与响应')
    await new Promise<void>((resolve) => setTimeout(resolve, 300))
    const wideImage = await window.webContents.capturePage()
    const widePng = wideImage.toPNG()
    assert.equal(wideImage.isEmpty(), false, '接口工作台宽布局截图为空')
    assert.ok(widePng.byteLength > 10_000, '接口工作台宽布局截图内容不足')
    const wideOutput = '/private/tmp/api-workbench-ui-wide.png'
    await writeFile(wideOutput, widePng)
    window.setContentSize(560, 780)
    await waitFor(window, "document.querySelector('button[aria-label=" + JSON.stringify('打开目录') + "]')", '窄 Pane 未显示目录入口')
    await clickLabel(window, '打开目录')
    await waitFor(window, `(() => {
      const input = document.querySelector('input[aria-label="搜索请求"]')
      const drawer = input?.closest('[role="dialog"]')
      if (!(drawer instanceof HTMLElement) || drawer.dataset.state !== 'open') return false
      const rect = drawer.getBoundingClientRect()
      const transform = getComputedStyle(drawer).transform
      return Math.abs(rect.left) <= 1 && rect.width >= 300 && rect.height >= 700 && (transform === 'none' || transform === 'matrix(1, 0, 0, 1, 0, 0)')
    })()`, '窄 Pane 目录抽屉未稳定打开')
    await waitForClosedLayersToLeave(window)
    await new Promise<void>((resolve) => setTimeout(resolve, 300))
    const lightImage = await window.webContents.capturePage()
    const lightPng = lightImage.toPNG()
    assert.equal(lightImage.isEmpty(), false, '接口工作台亮色截图为空')
    assert.ok(lightPng.byteLength > 10_000, '接口工作台亮色截图内容不足')
    const lightOutput = '/private/tmp/api-workbench-ui-narrow.png'
    await writeFile(lightOutput, lightPng)
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
    await waitFor(window, "!document.querySelector('input[aria-label=" + JSON.stringify('搜索请求') + "]')", '窄 Pane 目录抽屉未关闭')
    await window.webContents.executeJavaScript("document.documentElement.classList.add('dark'); document.documentElement.style.colorScheme = 'dark'")
    await new Promise<void>((resolve) => setTimeout(resolve, 250))
    const darkImage = await window.webContents.capturePage()
    const darkPng = darkImage.toPNG()
    assert.equal(darkImage.isEmpty(), false, '接口工作台暗色截图为空')
    assert.ok(darkPng.byteLength > 10_000, '接口工作台暗色截图内容不足')
    const darkOutput = '/private/tmp/api-workbench-ui-narrow-dark.png'
    await writeFile(darkOutput, darkPng)
    console.log(`[API Workbench UI smoke] screenshots: ${wideOutput}, ${lightOutput}, ${darkOutput}`)
    console.log('[API Workbench UI smoke] PASS: Dialog、保存、发送、原文、cURL 导入、快照导入、历史只读、宽布局、亮暗主题与窄 Pane 已验证')
  } catch (error) {
    console.error('[API Workbench UI smoke] 组件交互失败', error)
    throw error
  } finally {
    window.destroy()
    await rm(userData, { recursive: true, force: true })
  }
}

/** Bun 父进程启动临时 Vite 与真实 Electron。 */
async function orchestrate(): Promise<void> {
  const port = await availablePort()
  const url = `http://127.0.0.1:${port}/@fs${join(process.cwd(), 'scripts/api-workbench-ui-smoke.html')}`
  const vite = spawn(process.execPath, [join(process.cwd(), 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', port, '--strictPort'], { cwd: process.cwd(), stdio: 'inherit' })
  try {
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline) { try { if ((await fetch(url)).ok) break } catch { /* 等待 Vite */ } await new Promise((resolve) => setTimeout(resolve, 100)) }
    const buildDir = await mkdtemp(join(tmpdir(), 'proma-api-ui-smoke-build-'))
    try {
      const build = await Bun.build({ entrypoints: [join(process.cwd(), 'scripts/api-workbench-ui-smoke.ts')], outdir: buildDir, target: 'node', format: 'cjs', external: ['electron'] })
      if (!build.success || !build.outputs[0]) throw new Error('构建 API UI smoke 入口失败')
      const electronPath = process.env.PROMA_ELECTRON_PATH ?? join(process.cwd(), 'node_modules/.bin/electron')
      const electron = spawn(electronPath, [build.outputs[0].path], { cwd: process.cwd(), env: { ...process.env, PROMA_API_UI_SMOKE_CHILD: '1', PROMA_API_UI_SMOKE_URL: url }, stdio: 'inherit' })
      const code = await new Promise<number>((resolve, reject) => { const timeout = setTimeout(() => { electron.kill('SIGTERM'); reject(new Error('API UI smoke 超时')) }, 90_000); electron.once('error', reject); electron.once('exit', (value) => { clearTimeout(timeout); resolve(value ?? 1) }) })
      assert.equal(code, 0, `Electron smoke 退出码 ${code}`)
    } finally { await rm(buildDir, { recursive: true, force: true }) }
  } finally { vite.kill('SIGTERM') }
}

if (process.env.PROMA_API_UI_SMOKE_CHILD === '1') {
  /** 顶层同步注册 Electron ready，防止无窗口阶段提前退出。 */
  const electron = require('electron') as typeof import('electron')
  /** 隔离 userData，smoke 不读取真实客户端状态。 */
  const userData = mkdtempSync(join(tmpdir(), 'proma-api-ui-smoke-'))
  electron.app.setPath('userData', userData)
  console.log('[API Workbench UI smoke] Electron 子进程已启动')
  /** macOS 隐藏窗口创建前保留事件循环，ready 后由 BrowserWindow 接管生命周期。 */
  const keepAlive = setInterval(() => undefined, 1_000)
  void electron.app.whenReady().then(() => { clearInterval(keepAlive); return runElectronSmoke(electron.app, electron.BrowserWindow, userData) }).then(() => electron.app.quit()).catch((error: unknown) => { clearInterval(keepAlive); console.error('[API Workbench UI smoke] FAIL', error); process.exitCode = 1; electron.app.quit() })
} else {
  void orchestrate().catch((error: unknown) => { console.error('[API Workbench UI smoke] FAIL', error); process.exitCode = 1 })
}
