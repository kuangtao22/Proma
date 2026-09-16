import { strict as assert } from 'node:assert'
import { mkdtempSync } from 'node:fs'
import { rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app, BrowserWindow } from 'electron'

/** 隔离测试页面和真实 XYFlow 节点选择器。 */
const fixtureUrl = `http://127.0.0.1:${process.env.PROMA_VIDEO_CARD_SMOKE_PORT ?? '5193'}/@fs${join(process.cwd(), 'scripts/canvas-video-node-preview-smoke.html')}`
const card = '.react-flow__node[data-id="video-1"]'
const empty = '.react-flow__node[data-id="video-empty"]'
/** 等待真实 DOM 条件，失败提供具体业务断言。 */
async function waitFor(window: BrowserWindow, expression: string, message: string): Promise<void> {
  const deadline = Date.now() + 12_000
  while (Date.now() < deadline) {
    if (await window.webContents.executeJavaScript(`Boolean(${expression})`)) return
    await new Promise<void>((resolve) => setTimeout(resolve, 40))
  }
  throw new Error(message)
}
/** 等待视口与 IntersectionObserver 稳定，排除尚未触发的额外请求。 */
async function settle(window: BrowserWindow): Promise<void> {
  await window.webContents.executeJavaScript('new Promise(resolve => setTimeout(resolve, 250))')
}
/** 验证当前采用身份与可解码首帧，不把 video 标签存在当成功。 */
async function frame(window: BrowserWindow, candidate: string): Promise<void> {
  await waitFor(window, `(() => {
    const video = document.querySelector('${card} video');
    const lease = [...window.__videoCardSmoke.leases.values()].find(item => item.candidateId === ${JSON.stringify(candidate)});
    return video && lease && video.src === lease.url && video.readyState >= 2 && video.videoWidth === ${candidate === 'candidate-b' ? 180 : 320};
  })()`, `${candidate} 未显示真实首帧`)
  /** 高度沿用图片节点规则；元数据缺失时回落为空卡。 */
  const expectedHeight = candidate === 'candidate-b' ? 368 : candidate === 'candidate-no-metadata' ? 144 : 210
  await waitFor(window, `(() => {
    const node = document.querySelector('${card}');
    const body = node?.querySelector('article');
    const handle = node?.querySelector('.react-flow__handle-right');
    if (!body || !handle) return false;
    const rect = body.getBoundingClientRect();
    const port = handle.getBoundingClientRect();
    const edge = document.querySelector('.react-flow__edge-path');
    const path = edge?.getAttribute('d')?.match(/-?[0-9]+(?:[.][0-9]+)?/g);
    const edgeY = Number(path?.[1]);
    return Math.abs(edgeY - (80 + ${expectedHeight} / 2)) <= 2 && Math.abs(rect.height - ${expectedHeight}) <= 2
      && Math.abs((port.top + port.bottom) / 2 - (rect.top + rect.bottom) / 2) <= 2;
  })()`, `${candidate} 比例高度或连线端口未同步`)
  assert.equal(await window.webContents.executeJavaScript(`(() => {
    const video = document.querySelector('${card} video');
    return video.paused && !video.autoplay && !video.controls && video.muted;
  })()`), true, '卡片应暂停静音且不拦截画布手势')
}
/** 验证采用版本、进度去重、迟到读取、离屏回收和错误路径。 */
async function verify(window: BrowserWindow): Promise<void> {
  /** 精简控制台调用仅操作内存 fixture。 */
  const run = (code: string): Promise<unknown> => window.webContents.executeJavaScript(code)
  await waitFor(window, `window.__videoCardSmoke && document.querySelector('.react-flow')`, '画布未挂载')
  await settle(window)
  assert.equal(await run('window.__videoCardSmoke.reads.length'), 0, '初始离屏不能申请视频')
  await run('window.__videoCardSmoke.setVisible(true)')
  await frame(window, 'candidate-a')
  assert.equal(await run(`document.querySelector('${empty} video') === null`), true, '未采用不能显示候选')
  assert.equal(await run('window.__videoCardSmoke.reads.length'), 1)
  await writeFile('/private/tmp/proma-video-card-dark.png', (await window.webContents.capturePage()).toPNG())
  await run('window.__videoCardSmoke.progress()')
  await settle(window)
  assert.equal(await run('window.__videoCardSmoke.reads.length'), 1, '进度不应重读视频')
  assert.equal(await run(`document.querySelector('${card}').textContent.includes('sampler · 1/20')`), true)
  await run('window.__videoCardSmoke.setCandidate("candidate-b")')
  await frame(window, 'candidate-b')
  await writeFile('/private/tmp/proma-video-card-portrait.png', (await window.webContents.capturePage()).toPNG())
  assert.equal(await run('window.__videoCardSmoke.released.length'), 1)
  await run('window.__videoCardSmoke.delayNext = true; window.__videoCardSmoke.setCandidate("candidate-late")')
  await waitFor(window, 'window.__videoCardSmoke.resolvePending !== null', '迟到请求未发起')
  await run('window.__videoCardSmoke.setCandidate("candidate-current")')
  await frame(window, 'candidate-current')
  await run('window.__videoCardSmoke.resolvePending()')
  await waitFor(window, 'window.__videoCardSmoke.released.length === 3', '迟到响应未释放')
  await frame(window, 'candidate-current')
  assert.equal(await run('window.__videoCardSmoke.leases.size'), 1)
  await run('window.__videoCardSmoke.setVisible(false)')
  await waitFor(window, 'window.__videoCardSmoke.leases.size === 0', '离屏未释放lease')
  assert.equal(await run(`document.querySelector('${card} video') === null`), true, '离屏未卸载video')
  await run('window.__videoCardSmoke.setVisible(true)')
  await frame(window, 'candidate-current')
  await run('window.__videoCardSmoke.setCandidate(null)')
  await waitFor(window, `window.__videoCardSmoke.leases.size === 0 && !document.querySelector('${card} video')`, '清除采用后仍保留旧预览')
  await run('window.__videoCardSmoke.failNext = true; window.__videoCardSmoke.setCandidate("candidate-error")')
  await waitFor(window, `document.querySelector('${card} [data-preview-state="error"]')`, '读取失败缺少错误态')
  /** 失败后用新运行事件验证不会触发隐式重试。 */
  const failedCount = await run('window.__videoCardSmoke.reads.length')
  await run('window.__videoCardSmoke.progress()')
  await settle(window)
  assert.equal(await run('window.__videoCardSmoke.reads.length'), failedCount)
  assert.equal(await run(`document.querySelector('${card}').textContent.includes('已采用')`), true, '失败不能抹除采用事实')
  await run('window.__videoCardSmoke.corruptNext = true; window.__videoCardSmoke.setCandidate("candidate-corrupt")')
  await waitFor(window, `document.querySelector('${card} [data-preview-state="error"]') && window.__videoCardSmoke.leases.size === 0`, '解码失败未释放资源')
  await run('window.__videoCardSmoke.setCandidate("candidate-final")')
  await frame(window, 'candidate-final')
  await run('document.documentElement.classList.remove("dark")')
  await settle(window)
  await writeFile('/private/tmp/proma-video-card-light.png', (await window.webContents.capturePage()).toPNG())
  await run('window.__videoCardSmoke.setCandidate("candidate-no-metadata")')
  await frame(window, 'candidate-no-metadata')
  await run('window.__videoCardSmoke.unmount()')
  await waitFor(window, 'window.__videoCardSmoke.leases.size === 0', '画布卸载未释放lease')
}
/** 独立 Electron userData 和隐藏窗口，不连接用户客户端或真实业务。 */
async function run(): Promise<void> {
  const userDataPath = mkdtempSync(join(tmpdir(), 'proma-video-card-smoke-'))
  app.setPath('userData', userDataPath)
  app.on('window-all-closed', () => {})
  await app.whenReady()
  const window = new BrowserWindow({ width: 960, height: 600, show: false, webPreferences: { backgroundThrottling: false } })
  const rendererErrors: string[] = []
  window.webContents.on('console-message', (event) => { if (event.level === 'error') rendererErrors.push(event.message) })
  try {
    await window.loadURL(fixtureUrl)
    await verify(window)
    assert.deepEqual(rendererErrors, [], 'Renderer 不应报错')
    console.log('[视频节点卡片] PASS：横竖比例与端口、缺失尺寸回退、首帧解码、无自动播放、采用切换、未采用隐藏、进度去重、迟到响应、离屏/卸载释放、读取/解码失败、深浅主题')
  } catch (error) {
    console.error('Renderer errors:', rendererErrors)
    console.error(await window.webContents.executeJavaScript('document.body.innerText'))
    throw error
  } finally {
    window.destroy()
    await rm(userDataPath, { recursive: true, force: true })
  }
}
void run().then(() => app.quit()).catch((error: unknown) => { console.error(error); app.exit(1) })
