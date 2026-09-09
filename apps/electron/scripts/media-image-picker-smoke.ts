import { strict as assert } from 'node:assert'
import { mkdtempSync } from 'node:fs'
import { rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app, BrowserWindow } from 'electron'

/** fixture 端口复用现有 Vite，只加载生产组件与内存数据。 */
const fixtureUrl = `http://127.0.0.1:${process.env.PROMA_MEDIA_SMOKE_PORT ?? '5177'}/@fs${join(process.cwd(), 'scripts/media-image-picker-smoke.html')}`
/** 等待真实 DOM 条件，失败给出当前验证行为。 */
async function waitFor(window: BrowserWindow, expression: string, message: string): Promise<void> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (await window.webContents.executeJavaScript(`Boolean(${expression})`)) return
    await new Promise<void>((resolve) => setTimeout(resolve, 40))
  }
  throw new Error(message)
}
/** 通过真实按钮打开生产图片选择器。 */
async function openPicker(window: BrowserWindow): Promise<void> {
  await waitFor(window, 'document.querySelector("[aria-label=选择参考图]")', '图片入口未挂载')
  await window.webContents.executeJavaScript('document.querySelector("[aria-label=选择参考图]").click()')
  await waitFor(window, 'document.querySelector("[aria-label=搜索图片]")', '搜索框未打开')
}
/** 使用浏览器原生 setter 触发 React 搜索输入。 */
async function search(window: BrowserWindow, value: string): Promise<void> {
  await window.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('[aria-label=搜索图片]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`)
}
/** 给实际窗口派发按键，覆盖 Radix 关闭与 Command 键盘选择。 */
function key(window: BrowserWindow, keyCode: string): void {
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode })
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode })
}
/** 宽窄窗口均验证加载、搜索、选择、失败和资源回收。 */
async function verify(window: BrowserWindow, width: number, theme: string): Promise<void> {
  window.setContentSize(width, 820)
  await window.loadURL(`${fixtureUrl}?theme=${theme}`)
  await waitFor(window, 'document.querySelector("button img")?.naturalWidth > 0', '已选图片没有真实渲染')
  await openPicker(window)
  await waitFor(window, 'document.querySelectorAll("[role=option] img").length >= 3 && [...document.querySelectorAll("[role=option] img")].every(image => image.naturalWidth > 0)', '列表缩略图没有渲染')
  assert.equal(await window.webContents.executeJavaScript('document.querySelectorAll("[role=option]").length'), 100)
  assert.equal(await window.webContents.executeJavaScript('window.__mediaImagePickerSmoke.calls.length < 20'), true, '打开列表一次性读取全部图片')
  await window.webContents.executeJavaScript('Promise.all(document.getAnimations().filter(animation => Number.isFinite(animation.effect?.getComputedTiming().endTime)).map(animation => animation.finished.catch(() => undefined)))')
  assert.equal(await window.webContents.executeJavaScript(`(() => {
    const dialog = document.querySelector('[role=dialog]').getBoundingClientRect();
    const images = [...document.querySelectorAll('[role=option] img')];
    return dialog.left >= 0 && dialog.right <= innerWidth && dialog.bottom <= innerHeight
      && document.documentElement.scrollWidth <= innerWidth && images.every(image => getComputedStyle(image).objectFit === 'contain');
  })()`), true, '弹层越界或图片被裁切')
  await writeFile(`/private/tmp/media-image-picker-${theme}-${width}.png`, (await window.webContents.capturePage()).toPNG())
  // 浏览末尾必须显示原目录剩余图片，不能只展示首屏。
  await window.webContents.executeJavaScript('document.querySelector("[cmdk-list]").scrollTop = 100000')
  await waitFor(window, 'document.querySelector("[data-value=image-99] img")?.naturalWidth > 0', '滚动到底部未加载图片')
  await search(window, '构图-099')
  await waitFor(window, 'document.querySelectorAll("[role=option]").length === 1', '文件名搜索未过滤')
  key(window, 'ArrowDown')
  key(window, 'Return')
  await waitFor(window, 'window.__mediaImagePickerSmoke.input.value === "image-99" && !document.querySelector("[aria-label=搜索图片]")', '键盘选择未回写或收起')
  assert.deepEqual(await window.webContents.executeJavaScript('window.__mediaImagePickerSmoke.input.asset'), {
    assetId: 'image-99', revision: 1, hash: '63'.padStart(64, '0'), mediaKind: 'image',
  })
  await waitFor(window, 'window.__mediaImagePickerSmoke.urls.size === 1', '选择后列表 Blob 未释放')
  await openPicker(window)
  await search(window, '不存在的图片')
  await waitFor(window, 'document.body.textContent.includes("没有匹配的图片")', '搜索空状态缺失')
  key(window, 'Escape')
  await waitFor(window, '!document.querySelector("[aria-label=搜索图片]")', 'Escape 无法关闭列表')
  // 延迟读取在项目切换后才返回，旧列表不得重建 Blob URL。
  await window.webContents.executeJavaScript('window.__mediaImagePickerSmoke.deferred = true')
  await openPicker(window)
  await waitFor(window, 'window.__mediaImagePickerSmoke.pending.length > 0', '没有发起延迟预览')
  await window.webContents.executeJavaScript('window.__mediaImagePickerSmoke.setProject("project-b")')
  await waitFor(window, '!document.querySelector("[aria-label=搜索图片]") && window.__mediaImagePickerSmoke.calls.some(call => call.projectId === "project-b")', '切换项目未关闭旧列表')
  await window.webContents.executeJavaScript('window.__mediaImagePickerSmoke.pending.splice(0).forEach(resolve => resolve())')
  await waitFor(window, 'window.__mediaImagePickerSmoke.urls.size === 1', '迟到预览泄漏或串项目')
  // 缩略图失败仍保留文件名并可选择，不阻断工作流填参。
  await window.webContents.executeJavaScript('window.__mediaImagePickerSmoke.deferred = false; window.__mediaImagePickerSmoke.fail = true')
  await openPicker(window)
  await waitFor(window, 'document.querySelector("[role=option] [aria-label=预览不可用]")', '预览失败状态不可见')
  await window.webContents.executeJavaScript('document.querySelector("[data-value=image-1]").click()')
  await waitFor(window, 'window.__mediaImagePickerSmoke.input.value === "image-1"', '预览失败阻止选择素材')
  await window.webContents.executeJavaScript('window.__mediaImagePickerSmoke.setEmpty(true)')
  await openPicker(window)
  await waitFor(window, 'document.body.textContent.includes("暂无图片")', '空目录提示缺失')
  await window.webContents.executeJavaScript('window.__mediaImagePickerSmoke.unmount()')
  await waitFor(window, 'window.__mediaImagePickerSmoke.urls.size === 0', '卸载后 Blob URL 未全部释放')
}

/** 独立 Electron 数据目录，验证结束销毁，不接触真实项目与生成任务。 */
async function run(): Promise<void> {
  const userDataPath = mkdtempSync(join(tmpdir(), 'proma-image-picker-smoke-'))
  app.setPath('userData', userDataPath)
  app.on('window-all-closed', () => {})
  await app.whenReady()
  const window = new BrowserWindow({ width: 1100, height: 820, show: false, webPreferences: { backgroundThrottling: false } })
  try {
    await verify(window, 1100, 'dark')
    await verify(window, 430, 'light')
    console.log('[图片选择器] PASS：100 张图片、懒加载、搜索、键盘、选择身份、预览错误、切换项目、Blob 回收及宽窄布局')
  } finally {
    window.destroy()
    await rm(userDataPath, { recursive: true, force: true })
  }
}
void run().then(() => app.quit()).catch((error: unknown) => { console.error(error); app.exit(1) })
