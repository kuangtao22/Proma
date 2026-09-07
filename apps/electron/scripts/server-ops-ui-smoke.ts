import { strict as assert } from 'node:assert'
import { mkdtempSync } from 'node:fs'
import { rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app, BrowserWindow } from 'electron'

type SmokeTheme = 'light' | 'dark'
type SmokeView = 'workspace' | 'files' | 'docker' | 'leave'

/** Vite 默认端口上的隔离页面地址。 */
const smokeHtmlUrl = `http://127.0.0.1:5174/@fs${join(process.cwd(), 'scripts/server-ops-ui-smoke.html')}`

/** 等待 Renderer 条件成立，超时后保留明确断言上下文。 */
async function waitForCondition(window: BrowserWindow, expression: string, message: string): Promise<void> {
  const deadline = Date.now() + 8_000
  while (Date.now() < deadline) {
    const matched = await window.webContents.executeJavaScript(`Boolean(${expression})`) as boolean
    if (matched) return
    await new Promise<void>((resolve) => setTimeout(resolve, 50))
  }
  assert.fail(message)
}

/** 加载指定主题和视图，并等待 smoke 页面挂载完成。 */
async function loadView(window: BrowserWindow, theme: SmokeTheme, view: SmokeView): Promise<void> {
  await window.loadURL(`${smokeHtmlUrl}?theme=${theme}&view=${view}`)
  await waitForCondition(window, "document.body.dataset.smokeReady === 'true'", `等待 ${theme}/${view} 页面就绪超时`)
  /** 主题在 React effect 中切换；等待有限颜色过渡结束，避免把中间帧当作最终样式。 */
  await window.webContents.executeJavaScript(`(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    await Promise.all(document.getAnimations().filter((animation) =>
      Number.isFinite(animation.effect?.getComputedTiming().endTime)
    ).map((animation) => animation.finished.catch(() => undefined)));
  })()`)
}

/** 断言文件页的上传、下载、目录和文本编辑入口。 */
async function verifyFiles(window: BrowserWindow): Promise<void> {
  await waitForCondition(window, "document.querySelector('[data-server-ops-files-panel]') && [...document.querySelectorAll('button')].some((button) => button.textContent?.includes('上传'))", '文件页未显示上传入口')
  await window.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'app.conf')?.click()`)
  await waitForCondition(window, "document.querySelector('textarea[aria-label=\"远程文本内容\"]') && document.querySelector('button[title=\"下载\"]')", '文件页未显示下载或编辑入口')
  const directoryPath = await window.webContents.executeJavaScript(`(() => { const button = [...document.querySelectorAll('button')].find((entry) => entry.textContent?.trim() === 'var-log'); if (!button) return ''; button.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); return 'clicked' })()`) as string
  assert.equal(directoryPath, 'clicked', '文件页未显示目录入口')
  await waitForCondition(window, "document.querySelector('input[aria-label=\"远程目录路径\"]')?.value === '/var/log'", '双击目录后未进入目标路径')
}

/** 断言 Docker 列表、详情、动作、日志和终端入口。 */
async function verifyDocker(window: BrowserWindow): Promise<void> {
  await waitForCondition(window, "document.querySelector('[data-server-ops-docker-panel]') && [...document.querySelectorAll('button')].some((button) => button.getAttribute('aria-label') === '查看容器 api 详情')", 'Docker 容器列表未显示')
  await window.webContents.executeJavaScript(`document.querySelector('button[aria-label="查看容器 api 详情"]')?.click()`)
  await waitForCondition(window, "document.querySelector('[data-server-ops-docker-detail-grid=\"true\"]') && document.querySelector('button[aria-label=\"重启容器 api\"]') && document.querySelector('button[aria-label=\"查看容器 api 日志\"]') && document.querySelector('button[aria-label=\"打开容器 api 终端\"]')", 'Docker 详情或动作入口未显示')
  await window.webContents.executeJavaScript(`document.querySelector('button[aria-label="查看容器 api 日志"]')?.click()`)
  await waitForCondition(window, "document.querySelector('[data-smoke-last-action]')?.textContent?.includes('日志入口')", 'Docker 日志入口未触发')
  await window.webContents.executeJavaScript(`document.querySelector('button[aria-label="打开容器 api 终端"]')?.click()`)
  await waitForCondition(window, "document.querySelector('[data-smoke-last-action]')?.textContent?.includes('终端入口')", 'Docker 终端入口未触发')
  await window.webContents.executeJavaScript(`document.querySelector('button[aria-label="重启容器 api"]')?.click()`)
  await waitForCondition(window, "document.body.textContent?.includes('确认重启容器 api')", 'Docker 动作确认未显示')
}

/** 验证生产 leave hook 的取消、await close 和旧 scope 失效语义。 */
async function verifyTransferLeave(window: BrowserWindow): Promise<void> {
  const state = "document.querySelector('[data-smoke-leave-state]')"
  const clickButton = async (label: string): Promise<void> => {
    await window.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find((button) => button.textContent?.trim() === ${JSON.stringify(label)})?.click()`)
  }

  await clickButton('请求离开')
  await waitForCondition(window, "document.body.textContent?.includes('仍有 1 项文件传输')", '活动传输未显示离开确认')
  await clickButton('继续传输')
  await waitForCondition(window, `${state}?.dataset.closeCount === '0' && ${state}?.dataset.navigationCount === '0'`, '取消离开不应关闭 owner 或导航')

  await clickButton('请求离开')
  await waitForCondition(window, "document.body.textContent?.includes('仍有 1 项文件传输')", '第二次离开未显示确认')
  await clickButton('取消传输并离开')
  await waitForCondition(window, `${state}?.dataset.closeCount === '1' && ${state}?.dataset.navigationCount === '0'`, '导航必须等待 owner 关闭完成')
  await clickButton('完成关闭')
  await waitForCondition(window, `${state}?.dataset.navigationCount === '1'`, 'owner 关闭完成后未执行导航')

  await clickButton('请求离开')
  await waitForCondition(window, "document.body.textContent?.includes('仍有 1 项文件传输')", '第三次离开未显示确认')
  await clickButton('取消传输并离开')
  await waitForCondition(window, `${state}?.dataset.closeCount === '2'`, 'scope 失效场景未开始关闭 owner')
  await clickButton('切换作用域')
  await clickButton('完成关闭')
  await new Promise<void>((resolve) => setTimeout(resolve, 100))
  const navigationCount = await window.webContents.executeJavaScript(`${state}?.dataset.navigationCount`) as string
  assert.equal(navigationCount, '1', 'scopeKey 变化后旧 pending 导航仍被执行')
}

/** 将截图视图推进到能直接展示关键入口的稳定状态。 */
async function prepareViewForCapture(window: BrowserWindow, view: SmokeView): Promise<void> {
  if (view === 'files') {
    await waitForCondition(window, "[...document.querySelectorAll('button')].some((button) => button.textContent?.trim() === 'app.conf')", '截图前文件列表未就绪')
    await window.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'app.conf')?.click()`)
    await waitForCondition(window, "document.querySelector('textarea[aria-label=\"远程文本内容\"]')", '截图前文件编辑区未就绪')
  } else if (view === 'docker') {
    await waitForCondition(window, "document.querySelector('button[aria-label=\"查看容器 api 详情\"]')", '截图前 Docker 列表未就绪')
    await window.webContents.executeJavaScript(`document.querySelector('button[aria-label="查看容器 api 详情"]')?.click()`)
    await waitForCondition(window, "document.querySelector('[data-server-ops-docker-detail-grid=\"true\"]')", '截图前 Docker 详情未就绪')
  } else if (view === 'workspace') {
    await waitForCondition(window, "document.querySelector('[data-server-ops-workspace]')", '截图前工作区未就绪')
  }
  await window.webContents.executeJavaScript(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`)
}

/** 采样截图像素，拒绝隐藏窗口偶发产生的单色空帧。 */
function assertImageHasContent(bitmap: Buffer, label: string): void {
  const colors = new Set<string>()
  for (let offset = 0; offset + 3 < bitmap.length; offset += 4_096) {
    colors.add(`${bitmap[offset]}:${bitmap[offset + 1]}:${bitmap[offset + 2]}`)
    if (colors.size >= 4) return
  }
  assert.fail(`${label} 截图为单色空帧`)
}

/** 捕获一个尺寸与主题组合，并拒绝明显的横向页面溢出。 */
async function capture(window: BrowserWindow, theme: SmokeTheme, width: number, label: string, view: SmokeView): Promise<void> {
  window.setContentSize(width, 820)
  await loadView(window, theme, view)
  await prepareViewForCapture(window, view)
  const overflow = await window.webContents.executeJavaScript(`document.documentElement.scrollWidth > document.documentElement.clientWidth`) as boolean
  assert.equal(overflow, false, `${label} 页面发生横向溢出`)
  const image = await window.webContents.capturePage()
  assert.equal(image.isEmpty(), false, `${label} 截图为空`)
  assertImageHasContent(image.toBitmap(), label)
  const outputPath = `/private/tmp/server-ops-ui-${label}.png`
  await writeFile(outputPath, image.toPNG())
  console.log(`[Server Ops UI smoke] screenshot: ${outputPath}`)
}

/** 使用一次性 BrowserWindow 完成隔离 UI 断言与四组视觉基线。 */
async function runSmoke(): Promise<void> {
  const userDataPath = mkdtempSync(join(tmpdir(), 'proma-server-ops-ui-smoke-'))
  app.setPath('userData', userDataPath)
  await app.whenReady()
  const window = new BrowserWindow({
    width: 1180,
    height: 820,
    show: false,
    backgroundColor: '#111111',
    webPreferences: { backgroundThrottling: false },
  })
  try {
    await loadView(window, 'light', 'files')
    await verifyFiles(window)
    await loadView(window, 'dark', 'docker')
    await verifyDocker(window)
    await loadView(window, 'light', 'leave')
    await verifyTransferLeave(window)
    await capture(window, 'dark', 430, 'narrow-dark-workspace', 'workspace')
    await capture(window, 'light', 430, 'narrow-light-files', 'files')
    await capture(window, 'light', 1180, 'wide-light-files', 'files')
    await capture(window, 'dark', 1180, 'wide-dark-docker', 'docker')
    console.log('[Server Ops UI smoke] PASS: fixture 已验证工作区、文件与 Docker 入口；未连接真实服务器')
  } finally {
    window.destroy()
    await rm(userDataPath, { recursive: true, force: true })
  }
}

void runSmoke().then(() => app.quit()).catch((error: unknown) => {
  console.error('[Server Ops UI smoke] FAIL', error)
  process.exit(1)
})
