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

/**
 * 在历史列表里按行内文本条件点击一条运行。
 * 同一请求名会出现多条运行，只按 aria-label 无法区分，因此必须用行内文本（用例名/状态）来挑。
 */
async function clickHistoryRow(window: BrowserWindow, options: { includes?: string; excludes?: string }): Promise<void> {
  const clicked = await window.webContents.executeJavaScript(`(() => {
    const includes = ${JSON.stringify(options.includes ?? null)}
    const excludes = ${JSON.stringify(options.excludes ?? null)}
    const button = [...document.querySelectorAll('[aria-label^="打开运行"]')].find((item) => {
      const text = item.textContent ?? ''
      if (includes !== null && !text.includes(includes)) return false
      if (excludes !== null && text.includes(excludes)) return false
      return true
    })
    if (!(button instanceof HTMLButtonElement)) return false
    button.click()
    return true
  })()`)
  assert.equal(clicked, true, `找不到历史运行 ${JSON.stringify(options)}`)
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
    /** 关掉运行时变量面板，后续弹层与截图不应叠在它上面。 */
    await clickText(window, '关闭')
    await waitFor(window, "![...document.querySelectorAll('[role=dialog]')].some((item) => item.getAttribute('data-state') === 'open')", '运行时变量面板未关闭')
    console.log('[API Workbench UI smoke] 运行时变量面板已验证')
    /** 具名用例：新增两条用例后一键跑完，报告与复制文本都按真实运行核对。 */
    await clickText(window, '用例')
    await waitFor(window, "document.body.textContent?.includes('还没有用例')", '用例分区未打开')
    await clickText(window, '新增用例')
    await waitFor(window, "document.querySelectorAll('input[aria-label=\"用例名称\"]').length === 1", '用例未创建')
    await fill(window, 'input[aria-label="用例名称"]', '正常用例')
    await clickText(window, '新增用例')
    await waitFor(window, "document.querySelectorAll('input[aria-label=\"用例名称\"]').length === 2", '第二条用例未创建')
    /** 第二条输入框必须按索引定位，避免改到第一条。 */
    const renamed = await window.webContents.executeJavaScript(`(() => {
      const fields = document.querySelectorAll('input[aria-label="用例名称"]')
      const field = fields[1]
      if (!(field instanceof HTMLInputElement)) return false
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(field, '越权用例')
      field.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)
    assert.equal(renamed, true, '第二条用例改名失败')
    /** 选中用例后断言页必须标明编辑对象，避免把断言写到请求默认断言上。 */
    await clickText(window, '断言')
    await waitFor(window, "document.body.textContent?.includes('正在编辑：用例')", '断言页未标明当前用例')
    await clickLabel(window, '保存请求 (⌘S)')
    await waitFor(window, "window.__apiWorkbenchSmoke.catalog.requests.find((item) => item.url === 'http://127.0.0.1:8080/smoke')?.cases.length === 2", '用例未随请求保存')
    /** 目录要能一眼看出哪些接口带测试用例。 */
    assert.equal(await window.webContents.executeJavaScript(`(() => {
      const section = [...document.querySelectorAll('section')].find((item) => item.textContent?.includes('Smoke 集合'))
      const header = section?.querySelector('button')
      if (!(header instanceof HTMLButtonElement)) return false
      if (!section?.textContent?.includes('2 用例')) header.click()
      return true
    })()`), true, '找不到 Smoke 集合')
    await waitFor(window, "document.body.textContent?.includes('2 用例')", '目录未显示用例数量')
    /** 跑全部用例：顺序两次真实发送，跑完再汇总。 */
    const sendsBeforeCases = await window.webContents.executeJavaScript('window.__apiWorkbenchSmoke.sendCalls')
    await clickLabel(window, '跑全部用例')
    await waitFor(window, "document.body.textContent?.includes('用例报告') && document.body.textContent?.includes('1/2 通过')", '用例报告未出现')
    await waitFor(window, "document.body.textContent?.includes('正在跑剩余用例') === false", '用例报告未跑完')
    assert.equal(await window.webContents.executeJavaScript('window.__apiWorkbenchSmoke.sendCalls'), sendsBeforeCases + 2, '跑全部用例没有逐条发送')
    assert.equal(await window.webContents.executeJavaScript("(document.body.textContent?.includes('正常用例') && document.body.textContent?.includes('越权用例')) ?? false"), true, '报告缺少用例名')
    assert.equal(await window.webContents.executeJavaScript("document.body.textContent?.includes('期望 401，实际 200') ?? false"), true, '报告缺少失败原因')
    await waitForClosedLayersToLeave(window)
    await new Promise<void>((resolve) => setTimeout(resolve, 200))
    const caseShot = await window.webContents.capturePage()
    await writeFile('/private/tmp/api-workbench-ui-cases.png', caseShot.toPNG())
    /** 复制报告：文本与表格同源，且不含响应正文。 */
    await clickText(window, '复制报告')
    await waitFor(window, "window.__apiWorkbenchSmoke.clipboard.includes('1/2 通过')", '复制报告没有写入剪贴板')
    const reportText = await window.webContents.executeJavaScript('window.__apiWorkbenchSmoke.clipboard')
    assert.ok(reportText.includes('| 用例 | 来源 | 结果 | 状态码 | 断言 | 耗时 | 备注 |'), '复制报告缺少表头')
    assert.ok(reportText.includes('| 正常用例 | 人工 | 通过 | 200 | 1/1 |'), reportText)
    assert.ok(reportText.includes('| 越权用例 | 人工 | 失败 | 200 | 0/1 |'), reportText)
    /** 逐条打开 runId：报告关闭并切到该次运行的响应面板。 */
    const getsBeforeOpen = await window.webContents.executeJavaScript('window.__apiWorkbenchSmoke.getRunCalls')
    await clickText(window, '打开运行')
    await waitFor(window, `window.__apiWorkbenchSmoke.getRunCalls === ${getsBeforeOpen + 1} && document.body.textContent?.includes('用例 正常用例')`, '报告行未能打开对应运行')
    /** Radix 关闭后仍会短暂保留节点，因此按 data-state 判断报告确实关掉了。 */
    await waitFor(window, "![...document.querySelectorAll('[role=dialog]')].some((item) => item.getAttribute('data-state') === 'open')", '打开运行后报告未关闭')
    /** 删除用例：界面立即减少一条，保存后目录也同步。 */
    await clickText(window, '用例')
    await clickLabel(window, '删除用例 越权用例')
    await waitFor(window, "document.querySelectorAll('input[aria-label=\"用例名称\"]').length === 1", '删除用例后界面未更新')
    await clickLabel(window, '保存请求 (⌘S)')
    await waitFor(window, "window.__apiWorkbenchSmoke.catalog.requests.find((item) => item.url === 'http://127.0.0.1:8080/smoke')?.cases.length === 1", '删除的用例未同步到目录')
    assert.equal(await window.webContents.executeJavaScript("document.querySelectorAll('input[aria-label=\"用例名称\"]')[0]?.value ?? ''"), '正常用例', '删除后残留的用例不正确')
    console.log('[API Workbench UI smoke] 用例页签、跑全部用例与复制报告已验证')
    /** 自动 Cookie：请求设置里有开关，面板只展示元数据并可一键清空。 */
    await clickText(window, '设置')
    await waitFor(window, "document.body.textContent?.includes('自动 Cookie（仅本机内存）')", '请求设置缺少自动 Cookie 开关')
    assert.equal(await window.webContents.executeJavaScript('window.__apiWorkbenchSmokeSeedCookies()'), true, '准备 Cookie 元数据失败')
    await clickLabel(window, 'Cookie')
    await waitFor(window, "document.body.textContent?.includes('会话 cookie') && document.body.textContent?.includes('127.0.0.1/app')", 'Cookie 面板未显示元数据')
    assert.equal(await window.webContents.executeJavaScript("document.body.textContent?.includes('HttpOnly') ?? false"), true, 'Cookie 面板缺少 HttpOnly 标记')
    /** 等一帧再截图，确保弹层完成这次重绘。 */
    await new Promise<void>((resolve) => setTimeout(resolve, 200))
    await writeFile('/private/tmp/api-workbench-ui-cookie-jar.png', (await window.webContents.capturePage()).toPNG())
    await clickText(window, '清空')
    await waitFor(window, "document.body.textContent?.includes('还没有 cookie')", '清空 Cookie 后没有空状态')
    assert.equal(await window.webContents.executeJavaScript('window.__apiWorkbenchSmoke.cookies.length'), 0, 'Cookie 未真正清空')
    /** 已关闭的弹层仍会留在 DOM 里，因此只在「当前打开的那个」弹层里点关闭。 */
    assert.equal(await window.webContents.executeJavaScript(`(() => {
      const dialog = [...document.querySelectorAll('[role=dialog]')].find((item) => item.getAttribute('data-state') === 'open')
      const button = [...(dialog?.querySelectorAll('button') ?? [])].find((item) => item.textContent?.trim() === '关闭')
      if (!(button instanceof HTMLButtonElement)) return false
      button.click()
      return true
    })()`), true, '找不到 Cookie 面板的关闭按钮')
    await waitFor(window, "![...document.querySelectorAll('[role=dialog]')].some((item) => item.getAttribute('data-state') === 'open')", 'Cookie 面板未关闭')
    console.log('[API Workbench UI smoke] 自动 Cookie 开关与面板已验证')
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
    /** Agent 来源徽标：单独一个窗口，夹具扮演 Host 提供一条 Agent 创建的用例。 */
    const agentWindow = new BrowserWindow({ width: 1180, height: 760, show: false, backgroundColor: '#ffffff', webPreferences: { backgroundThrottling: false } })
    try {
      await agentWindow.loadURL(`${process.env.PROMA_API_UI_SMOKE_URL!}?agent-case=1`)
      await waitFor(agentWindow, "document.body.dataset.smokeReady === 'true' && document.body.textContent?.includes('Agent 集合')", 'Agent 用例页面未挂载')
      assert.equal(await agentWindow.webContents.executeJavaScript(`(() => {
        const button = [...document.querySelectorAll('aside button')].find((item) => item.textContent?.includes('Agent 建的接口'))
        if (!(button instanceof HTMLButtonElement)) return false
        button.click()
        return true
      })()`), true, '打开 Agent 请求失败')
      await clickText(agentWindow, '用例')
      await waitFor(agentWindow, `(() => {
        const field = document.querySelector('input[aria-label="用例名称"]')
        const row = field?.closest('div')
        return Boolean(row && row.textContent?.includes('Agent'))
      })()`, 'Agent 用例没有来源徽标')
      await new Promise<void>((resolve) => setTimeout(resolve, 200))
      await writeFile('/private/tmp/api-workbench-ui-agent-case.png', (await agentWindow.webContents.capturePage()).toPNG())
      console.log('[API Workbench UI smoke] Agent 用例来源徽标已验证')
    } finally {
      agentWindow.destroy()
    }
    /** 审批卡：真实点击「允许」必须走 respondPermission 通道，附件行显示的是 realpath 与大小。 */
    const approvalWindow = new BrowserWindow({ width: 900, height: 520, show: false, backgroundColor: '#ffffff', webPreferences: { backgroundThrottling: false } })
    try {
      await approvalWindow.loadURL(`${process.env.PROMA_API_UI_SMOKE_URL!}?approval=1`)
      await waitFor(approvalWindow, "document.body.dataset.smokeReady === 'true' && document.body.textContent?.includes('本次将读取并上传的文件')", '审批卡未挂载')
      assert.equal(await approvalWindow.webContents.executeJavaScript("document.body.textContent.includes('字段 file：/Users/ada/secret/id_rsa（1675 字节）')"), true, '审批卡没有逐行显示字段/真实路径/大小')
      assert.equal(await approvalWindow.webContents.executeJavaScript("document.body.textContent.includes('POST https://example.test/upload')"), true, '审批卡缺少目标请求')
      /** 「总是允许」对出网审批必须缺席：附件审批只能逐次确认。 */
      assert.equal(await approvalWindow.webContents.executeJavaScript("[...document.querySelectorAll('button')].some((item) => item.textContent?.includes('总是允许'))"), false, '出网审批不该提供会话白名单')
      await clickText(approvalWindow, '允许')
      await waitFor(approvalWindow, 'window.__apiWorkbenchSmoke.respondPermissionCalls.length === 1', '「允许」没有走 respondPermission 通道')
      const response = await approvalWindow.webContents.executeJavaScript('window.__apiWorkbenchSmoke.respondPermissionCalls[0]')
      assert.deepEqual(response, { requestId: 'permission-smoke', behavior: 'allow', alwaysAllow: false })
      /** 批准后卡片必须出队，不能留在聊天流里重复展示。 */
      await waitFor(approvalWindow, "!document.body.textContent.includes('本次将读取并上传的文件')", '批准后审批卡没有出队')
      await new Promise<void>((resolve) => setTimeout(resolve, 200))
      await writeFile('/private/tmp/api-workbench-ui-approval.png', (await approvalWindow.webContents.capturePage()).toPNG())
      console.log('[API Workbench UI smoke] 审批卡附件行与「允许」通道已验证')
    } finally {
      approvalWindow.destroy()
    }
    /** 历史载入编辑器：把运行里的真实请求还原成未保存草稿，并列出必须重填的遮罩位置。 */
    await clickLabel(window, '运行历史')
    await clickLabel(window, '打开运行 Smoke 请求')
    await waitFor(window, "document.body.textContent?.includes('200')", '历史运行未打开')
    await clickLabel(window, '载入编辑器')
    await waitFor(window, "document.querySelector('input[aria-label=\"请求名称\"]')?.value.includes('历史还原') ?? false", '历史草稿未打开')
    assert.equal(await window.webContents.executeJavaScript('document.body.textContent?.includes("必须重新填写") ?? false'), true, '缺少需要重填的提示')
    assert.equal(await window.webContents.executeJavaScript('document.body.textContent?.includes("Header X-Api-Key") ?? false'), true, '提示没有列出被遮罩的 Header')
    /** 被遮罩的取值留空并取消勾选：宁可少发，也不发出空值或假值。 */
    await clickText(window, 'Headers')
    await waitFor(window, "Boolean(document.querySelector('input[aria-label=\"启用 X-Api-Key\"]'))", 'Header 行未渲染')
    assert.equal(await window.webContents.executeJavaScript("document.querySelector('input[aria-label=\"启用 X-Api-Key\"]')?.checked ?? true"), false, '被遮罩的 Header 没有被取消勾选')
    assert.equal(await window.webContents.executeJavaScript(`(() => {
      const box = document.querySelector('input[aria-label="启用 X-Api-Key"]')
      const row = box?.closest('div')
      return Boolean(row && [...row.querySelectorAll('input')].some((item) => item.value === ''))
    })()`), true, '被遮罩的 Header 取值没有留空')
    assert.equal(await window.webContents.executeJavaScript("document.querySelector('input[aria-label=\"请求 URL\"]')?.value ?? ''"), 'http://127.0.0.1:8080/smoke', 'URL 还原不正确')
    await new Promise<void>((resolve) => setTimeout(resolve, 200))
    await writeFile('/private/tmp/api-workbench-ui-load-run.png', (await window.webContents.capturePage()).toPNG())
    console.log('[API Workbench UI smoke] 历史载入编辑器已验证')
    /** 运行对比：把当前运行设为基线，再打开另一条运行对比。 */
    /** 前面的窄 Pane 截图把窗口调小了，对比步骤先恢复到宽布局。 */
    window.setContentSize(1180, 820)
    await waitFor(window, "document.querySelector('button[aria-label=\"打开目录\"]') === null", '宽布局未恢复')
    await clickLabel(window, '运行历史')
    await waitFor(window, "Boolean(document.querySelector('[aria-label^=\"打开运行\"]'))", '历史列表未渲染')
    /** 基线选不带用例的那条运行；带用例的运行留作对比候选。 */
    await clickHistoryRow(window, { excludes: '用例' })
    await waitFor(window, "document.body.textContent?.includes('200')", '基线运行未打开')
    await clickLabel(window, '设为对比基线')
    await waitFor(window, "document.body.textContent?.includes('设为对比基线；打开另一条运行') ?? false", '设置基线后没有提示')
    /** 对比候选选带用例的那条运行（需重新打开历史列表）。 */
    await clickLabel(window, '运行历史')
    await waitFor(window, "Boolean(document.querySelector('[aria-label^=\"打开运行\"]'))", '历史列表第二次未渲染')
    await clickHistoryRow(window, { includes: '正常用例' })
    await waitFor(window, "document.body.textContent?.includes('用例 正常用例')", '对比候选未打开')
    await waitFor(window, "Boolean(document.querySelector('[aria-label=\"与基线对比\"]:not([disabled])'))", '对比入口不可用')
    await clickLabel(window, '与基线对比')
    await waitFor(window, "document.body.textContent?.includes('运行对比') && document.body.textContent?.includes('两次运行一致') === false", '对比面板未显示差异结论')
    assert.equal(await window.webContents.executeJavaScript("document.body.textContent?.includes('正文相同') ?? false"), true, '对比面板缺少正文结论')
    assert.equal(await window.webContents.executeJavaScript("document.body.textContent?.includes('用例') ?? false"), true, '对比面板缺少用例差异')
    assert.equal(await window.webContents.executeJavaScript("document.body.textContent?.includes('断言结论变化') ?? false"), true, '对比面板缺少断言差异')
    await new Promise<void>((resolve) => setTimeout(resolve, 200))
    await writeFile('/private/tmp/api-workbench-ui-run-diff.png', (await window.webContents.capturePage()).toPNG())
    console.log('[API Workbench UI smoke] 运行对比已验证')
    /** multipart 文件上传：原生对话框（夹具扮演主进程）→ 文件行 → 保存后只存引用元数据。 */
    assert.equal(await window.webContents.executeJavaScript(`(() => {
      const dialog = [...document.querySelectorAll('[role=dialog]')].find((item) => item.getAttribute('data-state') === 'open')
      const button = [...(dialog?.querySelectorAll('button') ?? [])].find((item) => item.textContent?.trim() === '关闭')
      if (button instanceof HTMLButtonElement) button.click()
      return true
    })()`), true, '对比面板未关闭')
    await waitFor(window, "![...document.querySelectorAll('[role=dialog]')].some((item) => item.getAttribute('data-state') === 'open')", '对比面板仍在原位')
    await clickText(window, 'Body')
    await waitFor(window, "Boolean(document.querySelector('[role=combobox]'))", 'Body 分区未渲染')
    /** Radix Select 用指针事件打开与选中，直接 click 不会生效。 */
    assert.equal(await window.webContents.executeJavaScript(`(() => {
      const press = (node) => {
        if (!(node instanceof HTMLElement)) return false
        node.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }))
        node.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true }))
        node.click()
        return true
      }
      const trigger = [...document.querySelectorAll('[role=combobox]')].find((item) => item.textContent?.trim() === 'none')
      return press(trigger)
    })()`), true, '找不到正文类型选择器')
    await waitFor(window, "Boolean(document.querySelector('[role=option]'))", '正文类型下拉未展开')
    assert.equal(await window.webContents.executeJavaScript(`(() => {
      const node = [...document.querySelectorAll('[role=option]')].find((item) => item.textContent?.trim() === 'multipart/form-data')
      if (!(node instanceof HTMLElement)) return false
      node.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }))
      node.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true }))
      node.click()
      return true
    })()`), true, '找不到 multipart 选项')
    await waitFor(window, "document.body.textContent?.includes('选择文件')", 'multipart 正文未出现文件入口')
    await clickText(window, '选择文件')
    await waitFor(window, "document.body.textContent?.includes('smoke.png')", '选中的文件没有出现在编辑器里')
    assert.equal(await window.webContents.executeJavaScript("document.body.textContent?.includes('附件内容不写入运行记录') ?? false"), true, '缺少附件不落盘说明')
    await clickLabel(window, '保存请求 (⌘S)')
    /** 载入的历史草稿会另存为一条新请求，因此按「任意请求上出现该文件」判断。 */
    await waitFor(window, "window.__apiWorkbenchSmoke.catalog.requests.some((item) => (item.body.files ?? []).some((file) => file.fileName === 'smoke.png'))", '文件引用没有随请求保存')
    /** 定义里只有引用与展示元数据：出现路径字段即失败（注意 MIME 里的斜杠不算路径）。 */
    assert.equal(await window.webContents.executeJavaScript("JSON.stringify(Object.keys(window.__apiWorkbenchSmoke.catalog.requests.flatMap((item) => item.body.files ?? [])[0] ?? {}).sort())"), '["contentType","fileName","id","name","ref","sizeBytes"]', '文件元数据字段不符合预期')
    await new Promise<void>((resolve) => setTimeout(resolve, 200))
    await writeFile('/private/tmp/api-workbench-ui-multipart.png', (await window.webContents.capturePage()).toPNG())
    console.log('[API Workbench UI smoke] multipart 选择文件与保存已验证')
    console.log('[API Workbench UI smoke] PASS: Dialog、保存、发送、原文、cURL 导入、快照导入、历史只读、用例页签与报告（含来源列）、Agent 用例徽标、审批卡附件行与「允许」通道、自动 Cookie 开关与面板、历史载入编辑器、运行对比、multipart 选择文件、宽布局、亮暗主题与窄 Pane 已验证')
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
