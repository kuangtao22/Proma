import { strict as assert } from 'node:assert'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'

type SmokeTheme = 'light' | 'dark'
interface SmokeViewport { width: number; height: number }
interface SmokeSnapshot {
  currentTab: string
  domContainsFakeSecret: boolean
  cancelCalls: string[]
  replacePayloads: Array<{
    expectedRevision: number
    profiles: Array<{
      profile: { id: string; provider: string; legacyMediaProfileId?: string }
      credentialUpdate: { mode: string; apiKey?: string }
    }>
  }>
  testRequestIds: string[]
  currentTestState: string | null
}

/** fixture 使用的独立端口，避免读取或修改真实客户端。 */
const fixturePort = process.env.PROMA_AUDIO_GENERATION_SMOKE_PORT ?? '5198'
const fixtureUrl = `http://127.0.0.1:${fixturePort}/@fs${join(process.cwd(), 'scripts/audio-generation-settings-smoke.html')}`
const fakeSecret = 'secret-key-audio-smoke'
const privatePath = '/Users/smoke/private/audio-generation-profiles.json'
const viewports: readonly SmokeViewport[] = [{ width: 1440, height: 900 }, { width: 1024, height: 768 }]
const themes: readonly SmokeTheme[] = ['light', 'dark']

/** 等待真实 DOM 或 fixture 状态，超时错误直接指向验收点。 */
async function waitFor(window: BrowserWindow, expression: string, message: string): Promise<void> {
  const deadline = Date.now() + 12_000
  while (Date.now() < deadline) {
    if (await window.webContents.executeJavaScript(`Boolean(${expression})`)) return
    await new Promise<void>((resolve) => setTimeout(resolve, 40))
  }
  assert.fail(message)
}

/** 等待两帧，使 Radix Portal、焦点和主题样式完成提交。 */
async function settle(window: BrowserWindow): Promise<void> {
  await window.webContents.executeJavaScript(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`)
}

/** 使用真实鼠标事件点击稳定选择器匹配的元素。 */
async function clickSelector(window: BrowserWindow, selector: string, message: string): Promise<void> {
  const point = await window.webContents.executeJavaScript(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!(element instanceof HTMLElement) || element.matches(':disabled')) return null;
    const rect = element.getBoundingClientRect();
    element.scrollIntoView({ block: 'center', inline: 'nearest' });
    const next = element.getBoundingClientRect();
    return { x: Math.round(next.left + next.width / 2), y: Math.round(next.top + next.height / 2) };
  })()`)
  assert.ok(point, message)
  window.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 })
  window.webContents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 })
}

/** 按精确可见文本点击按钮，可选限制在指定容器内。 */
async function clickButton(window: BrowserWindow, label: string, container = 'body'): Promise<void> {
  const clicked = await window.webContents.executeJavaScript(`(() => {
    const root = document.querySelector(${JSON.stringify(container)});
    const button = [...(root?.querySelectorAll('button') ?? [])].find((entry) => entry.textContent?.trim() === ${JSON.stringify(label)});
    if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
    button.scrollIntoView({ block: 'center', inline: 'nearest' });
    button.click();
    return true;
  })()`)
  assert.equal(clicked, true, `找不到可点击按钮：${label}`)
}

/** 按精确可见文案点击 Radix Select option。 */
async function clickOption(window: BrowserWindow, label: string): Promise<void> {
  const point = await window.webContents.executeJavaScript(`(() => {
    const option = [...document.querySelectorAll('[role="option"]')]
      .find((entry) => entry.textContent?.trim() === ${JSON.stringify(label)});
    if (!(option instanceof HTMLElement)) return null;
    const rect = option.getBoundingClientRect();
    return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
  })()`)
  assert.ok(point, `找不到供应商选项：${label}`)
  window.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 })
  window.webContents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 })
}

/** 使用原生 value setter 触发 React 输入事件。 */
async function fillInput(window: BrowserWindow, selector: string, value: string): Promise<void> {
  const changed = await window.webContents.executeJavaScript(`(() => {
    const input = document.querySelector(${JSON.stringify(selector)});
    if (!(input instanceof HTMLInputElement)) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`)
  assert.equal(changed, true, `找不到输入框：${selector}`)
}

/** 获取 fixture 的隔离只读快照。 */
async function readSnapshot(window: BrowserWindow): Promise<SmokeSnapshot> {
  return window.webContents.executeJavaScript('window.__audioGenerationSmoke.getSnapshot()')
}

/** 验证一级标签精确文案与键盘焦点合同。 */
async function verifyTabsAndFocus(window: BrowserWindow): Promise<void> {
  const labels = await window.webContents.executeJavaScript(`[
    ...document.querySelectorAll('[role="tablist"][aria-label="媒体配置"] [role="tab"]')
  ].map((tab) => tab.textContent?.trim())`)
  assert.deepEqual(labels, ['生图模型', '音频生成', '服务链接', '本地工作流'])
  const text = await window.webContents.executeJavaScript('document.body.textContent ?? ""') as string
  assert.equal(text.includes('媒体模型'), false, '页面仍显示旧“媒体模型”文案')
  assert.equal(text.includes('服务连接'), false, '页面仍显示旧“服务连接”文案')
  /** 使用项目已验证的 CDP 导航键通道，避免受宿主桌面前台应用影响。 */
  await window.webContents.executeJavaScript(`document.querySelector('[role="tab"][data-state="active"]')?.focus()`)
  if (!window.webContents.debugger.isAttached()) window.webContents.debugger.attach('1.3')
  const keyEvent = { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 }
  await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...keyEvent })
  await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', ...keyEvent })
  await waitFor(window, `window.__audioGenerationSmoke.getSnapshot().currentTab === 'audio-generation'`, 'ArrowRight 未切换到音频生成')
  await waitFor(window, `document.activeElement?.getAttribute('role') === 'tab' && document.activeElement?.textContent?.trim() === '音频生成'`, '活动页签未获得焦点')
  await window.webContents.executeJavaScript('window.__audioGenerationSmoke.rerender()')
  await settle(window)
  assert.equal(await window.webContents.executeJavaScript(`document.activeElement?.textContent?.trim()`), '音频生成', '无关重渲染抢走页签焦点')
}

/** 验证列表、旧迁移提示与秘密/私密路径边界。 */
async function verifyInitialAudioList(window: BrowserWindow): Promise<void> {
  await waitFor(window, `document.body.textContent?.includes('小米配音测试') && document.body.textContent?.includes('MiniMax 配音测试')`, '音频目录未完成加载')
  const bodyText = await window.webContents.executeJavaScript('document.body.textContent ?? ""') as string
  assert.ok(bodyText.includes('旧 MiniMax Speech'), '旧 minimax-speech 迁移摘要不可见')
  assert.ok(bodyText.includes('旧配置，需要重新填写独立凭据'), '旧配置非破坏迁移提示不可见')
  assert.equal(bodyText.includes(fakeSecret), false, '公开正文泄漏测试 API Key')
  assert.equal(bodyText.includes(privatePath), false, '公开正文泄漏完整私密路径')
  assert.equal((await readSnapshot(window)).domContainsFakeSecret, false, '公开 DOM 泄漏测试 API Key')
}

/** 验证供应商判别联合驱动 Group ID 动态字段。 */
async function verifyProviderFields(window: BrowserWindow): Promise<void> {
  await clickButton(window, '添加音频配置')
  await waitFor(window, `document.querySelector('#audio-provider') && !document.querySelector('#audio-group-id')`, '小米草稿字段不正确')
  /** 新建小米配置必须自动带入官方默认服务地址与默认模型。 */
  assert.equal(await window.webContents.executeJavaScript(`document.querySelector('#audio-base-url')?.value`), 'https://api.xiaomimimo.com/v1', '小米草稿未自动填入默认服务地址')
  assert.equal(await window.webContents.executeJavaScript(`document.querySelector('#audio-model-id')?.value`), 'mimo-v2.5-tts', '小米草稿未自动填入默认模型')
  assert.equal(await window.webContents.executeJavaScript(`document.body.textContent?.includes('预览：https://api.xiaomimimo.com/v1/chat/completions')`), true, '服务地址预览未展示真实请求路径')
  await clickSelector(window, '#audio-provider', '供应商选择器不可点击')
  await waitFor(window, `document.querySelector('[role="option"]')`, '供应商选项未打开')
  await clickOption(window, 'MiniMax Speech')
  await waitFor(window, `document.querySelector('#audio-group-id')`, 'MiniMax 未显示 Group ID')
  assert.equal(await window.webContents.executeJavaScript(`document.querySelector('#audio-base-url')?.value`), 'https://api.minimax.cn/v1', 'MiniMax 草稿未自动填入默认服务地址')
  await clickSelector(window, '#audio-provider', '供应商选择器不可再次点击')
  await waitFor(window, `document.querySelector('[role="option"]')`, '小米选项未打开')
  await clickOption(window, '小米 TTS')
  await waitFor(window, `!document.querySelector('#audio-group-id')`, '切回小米后 Group ID 未隐藏')
  await clickButton(window, '取消')
  await waitFor(window, `document.querySelector('button[aria-label="编辑 小米配音测试"]')`, '取消草稿后未返回音频配置列表')
}

/** 验证编辑留空 preserve，以及复制不继承凭据和旧目录引用。 */
async function verifyCredentialPayloads(window: BrowserWindow, screenshotDir: string, label: string): Promise<void> {
  await clickSelector(window, 'button[aria-label="编辑 小米配音测试"]', '找不到小米编辑入口')
  await waitFor(window, `document.querySelector('#audio-api-key')?.placeholder === '留空以保留已保存凭据'`, '编辑表单未提供留空保留语义')
  assert.equal(await window.webContents.executeJavaScript(`document.querySelector('#audio-api-key')?.value`), '', '编辑表单回填了 API Key')
  /** 编辑表单必须渲染已启用音色列表与手填添加行，而不是旧单值输入框。 */
  assert.equal(await window.webContents.executeJavaScript(`Boolean(
    document.body.textContent?.includes('已启用音色')
      && document.body.textContent?.includes('小米 smoke 音色')
      && document.querySelector('button[aria-label="移除音色 小米 smoke 音色"]')
      && document.querySelector('#audio-voice-id')
      && !document.querySelector('button[aria-label="音色 ID"]')
  )`), true, '编辑表单未渲染音色列表编辑器')
  await captureScreenshot(window, join(screenshotDir, `audio-generation-settings-${label}-draft.png`), `${label} 编辑表单`)
  await clickButton(window, '保存')
  await waitFor(window, `window.__audioGenerationSmoke.getSnapshot().replacePayloads.length === 1 && document.body.textContent?.includes('小米配音测试')`, '编辑保存未完成')
  const preserve = (await readSnapshot(window)).replacePayloads[0]
  const xiaomiEntry = preserve?.profiles.find((entry) => entry.profile.id === 'xiaomi-smoke')
  assert.equal(xiaomiEntry?.credentialUpdate.mode, 'preserve', '编辑留空未提交 preserve')

  await clickSelector(window, 'button[aria-label="复制 MiniMax 配音测试"]', '找不到 MiniMax 复制入口')
  await waitFor(window, `document.querySelector('#audio-provider') && document.querySelector('#audio-group-id')`, '复制未打开 MiniMax 草稿')
  assert.equal(await window.webContents.executeJavaScript(`document.querySelector('#audio-api-key')?.value`), '', '复制继承了 API Key')
  assert.equal(await window.webContents.executeJavaScript(`document.querySelector('#audio-api-key')?.placeholder`), '请输入 API Key', '复制错误沿用已有凭据状态')
  await fillInput(window, '#audio-api-key', fakeSecret)
  await clickButton(window, '保存')
  await waitFor(window, `window.__audioGenerationSmoke.getSnapshot().replacePayloads.length === 2 && document.body.textContent?.includes('MiniMax 配音测试 副本')`, '复制保存未完成')
  const copiedRequest = (await readSnapshot(window)).replacePayloads[1]
  const copied = copiedRequest?.profiles.find((entry) => entry.profile.id !== 'xiaomi-smoke' && entry.profile.id !== 'minimax-smoke')
  assert.equal(copied?.credentialUpdate.mode, 'replace', '复制未要求新凭据')
  assert.equal(copied?.credentialUpdate.apiKey, fakeSecret, '复制没有提交测试输入的新凭据')
  assert.equal(copied?.profile.legacyMediaProfileId, undefined, '复制继承了旧目录引用')
  assert.equal((await readSnapshot(window)).domContainsFakeSecret, false, '保存后公开 DOM 仍包含测试 API Key')
}

/** 验证第二次测试先取消，迟到的旧 requestId 不覆盖新结果。 */
async function verifyLateResultIgnored(window: BrowserWindow): Promise<void> {
  await clickSelector(window, 'button[aria-label="测试 小米配音测试"]', '找不到小米测试入口')
  await waitFor(window, `window.__audioGenerationSmoke.getSnapshot().testRequestIds.length === 1 && window.__audioGenerationSmoke.getSnapshot().currentTestState === 'loading'`, '第一次测试未进入 loading')
  const firstId = (await readSnapshot(window)).testRequestIds[0]!
  await clickSelector(window, 'button[aria-label="测试 小米配音测试"]', '第二次测试入口不可点击')
  await waitFor(window, `window.__audioGenerationSmoke.getSnapshot().cancelCalls[0] === ${JSON.stringify(firstId)} && window.__audioGenerationSmoke.getSnapshot().testRequestIds.length === 2`, '第二次测试未先取消旧请求')
  const secondId = (await readSnapshot(window)).testRequestIds[1]!
  assert.notEqual(secondId, firstId, '两次测试复用了 requestId')
  assert.equal(await window.webContents.executeJavaScript(`window.__audioGenerationSmoke.resolveTest(${JSON.stringify(secondId)}, 'unavailable')`), true)
  await waitFor(window, `window.__audioGenerationSmoke.getSnapshot().currentTestState === 'unavailable'`, '新请求结果未显示')
  assert.equal(await window.webContents.executeJavaScript(`window.__audioGenerationSmoke.resolveTest(${JSON.stringify(firstId)}, 'success')`), true)
  await new Promise<void>((resolve) => setTimeout(resolve, 120))
  assert.equal((await readSnapshot(window)).currentTestState, 'unavailable', '迟到旧结果覆盖了新请求状态')
}

/** 验证删除 CAS 冲突时受控 AlertDialog 保持打开并显示稳定错误。 */
async function verifyDeleteConflict(window: BrowserWindow): Promise<void> {
  await window.webContents.executeJavaScript(`window.__audioGenerationSmoke.setNextReplaceFailure('conflict')`)
  await clickSelector(window, 'button[aria-label="删除 小米配音测试"]', '找不到小米删除入口')
  await waitFor(window, `document.querySelector('[role="alertdialog"]')?.textContent?.includes('删除音频配置？')`, '删除确认框未打开')
  await clickButton(window, '删除', '[role="alertdialog"]')
  await waitFor(window, `document.querySelector('[role="alertdialog"]')?.textContent?.includes('音频配置已被其他窗口更新')`, '删除冲突未在确认框显示')
  assert.ok(await window.webContents.executeJavaScript(`document.querySelector('[role="alertdialog"]') !== null`), '删除失败后确认框错误关闭')
  await clickButton(window, '取消', '[role="alertdialog"]')
  await waitFor(window, `document.querySelector('[role="alertdialog"]') === null`, '删除确认框无法由用户取消')
}

/** 验证横向边界、标签文字不重叠及关键主题色存在。 */
async function verifyGeometryAndTheme(window: BrowserWindow, label: string): Promise<void> {
  const result = await window.webContents.executeJavaScript(`(() => {
    const tabs = [...document.querySelectorAll('[role="tablist"][aria-label="媒体配置"] [role="tab"]')]
      .map((element) => element.getBoundingClientRect());
    const tabsOverlap = tabs.some((left, index) => tabs.slice(index + 1).some((right) =>
      left.left < right.right && left.right > right.left && left.top < right.bottom && left.bottom > right.top));
    const visibleControls = [...document.querySelectorAll('button, input, [role="switch"], [role="tab"]')]
      .filter((element) => { const rect = element.getBoundingClientRect(); return rect.width > 0 && rect.height > 0; });
    const horizontalBounds = visibleControls.every((element) => {
      const rect = element.getBoundingClientRect();
      return rect.left >= -1 && rect.right <= document.documentElement.clientWidth + 1;
    });
    const shellStyle = getComputedStyle(document.querySelector('[data-smoke-shell]'));
    return {
      overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      tabsOverlap,
      horizontalBounds,
      background: shellStyle.backgroundColor,
      color: shellStyle.color,
    };
  })()`)
  assert.equal(result.overflow, false, `${label} 页面发生横向溢出`)
  assert.equal(result.tabsOverlap, false, `${label} 页签文字发生重叠`)
  assert.equal(result.horizontalBounds, true, `${label} 按钮或输入框超出 viewport`)
  assert.notEqual(result.background, 'rgba(0, 0, 0, 0)', `${label} 背景透明`)
  assert.notEqual(result.background, 'transparent', `${label} 背景透明`)
  assert.notEqual(result.color, result.background, `${label} 关键文本与背景颜色相同`)
}

/** 捕获截图并拒绝空帧。 */
async function captureScreenshot(window: BrowserWindow, outputPath: string, label: string): Promise<void> {
  const image = await window.webContents.capturePage()
  assert.equal(image.isEmpty(), false, `${label} 截图为空`)
  const bitmap = image.toBitmap()
  const colors = new Set<string>()
  /** 251 像素步长不与任一验收宽度对齐，避免只采到同一背景列。 */
  for (let offset = 0; offset + 3 < bitmap.length; offset += 4 * 251) {
    colors.add(`${bitmap[offset]}:${bitmap[offset + 1]}:${bitmap[offset + 2]}`)
    if (colors.size >= 4) break
  }
  assert.ok(colors.size >= 4, `${label} 截图为单色空帧`)
  await writeFile(outputPath, image.toPNG())
  console.log(`[音频设置 smoke] screenshot: ${outputPath}`)
}

/** 对单个主题与 viewport 重跑完整真实交互。 */
async function verifyCombination(
  window: BrowserWindow,
  theme: SmokeTheme,
  viewport: SmokeViewport,
  screenshotDir: string,
): Promise<void> {
  const label = `${viewport.width}x${viewport.height}-${theme}`
  window.setContentSize(viewport.width, viewport.height)
  await window.loadURL(`${fixtureUrl}?theme=${theme}`)
  await waitFor(window, `typeof window.__audioGenerationSmoke?.getSnapshot === 'function'`, `${label} fixture 未挂载`)
  await settle(window)
  await verifyTabsAndFocus(window)
  await verifyInitialAudioList(window)
  await verifyProviderFields(window)
  await verifyCredentialPayloads(window, screenshotDir, label)
  await verifyLateResultIgnored(window)
  await verifyDeleteConflict(window)
  await verifyGeometryAndTheme(window, label)
  await captureScreenshot(window, join(screenshotDir, `audio-generation-settings-${label}.png`), label)
}

/** Electron 子进程使用真实 BrowserWindow 完成四组视觉与交互验收。 */
async function runElectronSmoke(): Promise<void> {
  const { app, BrowserWindow, nativeTheme } = await import('electron')
  /** 独立 userData 确保 smoke 不读取真实 Proma 配置。 */
  const userDataPath = await mkdtemp(join(tmpdir(), 'proma-audio-generation-settings-'))
  const screenshotDir = process.env.PROMA_AUDIO_GENERATION_SMOKE_SCREENSHOT_DIR
    ?? join(tmpdir(), 'proma-audio-generation-settings-smoke-screenshots')
  await mkdir(screenshotDir, { recursive: true })
  app.setPath('userData', userDataPath)
  app.on('window-all-closed', () => undefined)
  await app.whenReady()
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    show: false,
    backgroundColor: '#ffffff',
    webPreferences: { backgroundThrottling: false },
  })
  const rendererErrors: string[] = []
  window.webContents.on('console-message', (event) => {
    if (event.level === 'error') rendererErrors.push(event.message)
  })
  try {
    for (const viewport of viewports) {
      for (const theme of themes) {
        nativeTheme.themeSource = theme
        await verifyCombination(window, theme, viewport, screenshotDir)
      }
    }
    assert.deepEqual(rendererErrors, [], `Renderer 控制台出现错误：${rendererErrors.join('\n')}`)
    console.log('[音频设置 smoke] PASS：双 viewport、深浅主题、键盘、供应商字段、凭据、迟到结果、冲突弹窗与布局全部通过')
  } finally {
    if (window.webContents.debugger.isAttached()) window.webContents.debugger.detach()
    window.destroy()
    await rm(userDataPath, { recursive: true, force: true })
  }
}

/** 等待 Vite fixture 可访问，避免用固定 sleep 掩盖启动失败。 */
async function waitForVite(url: string): Promise<void> {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url)
      if (response.ok) return
    } catch {
      // Vite 尚未监听时继续有界重试。
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('等待音频设置 smoke Vite 服务超时')
}

/** 让操作系统分配空闲回环端口，避免并行 smoke 相互占用固定端口。 */
async function findAvailablePort(): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close()
        reject(new Error('无法分配音频设置 smoke 端口'))
        return
      }
      server.close((error) => error ? reject(error) : resolve(String(address.port)))
    })
  })
}

/** Bun 父进程构建 Electron 入口、启动 Vite，并在退出时回收全部子进程。 */
async function orchestrateSmoke(): Promise<void> {
  const buildDir = await mkdtemp(join(tmpdir(), 'proma-audio-generation-smoke-build-'))
  const build = await Bun.build({
    entrypoints: [join(process.cwd(), 'scripts/audio-generation-settings-smoke.ts')],
    outdir: buildDir,
    target: 'node',
    format: 'cjs',
    external: ['electron'],
  })
  if (!build.success) throw new Error(`构建 Electron smoke 入口失败：${build.logs.join('\n')}`)
  const outputPath = build.outputs[0]?.path
  if (!outputPath) throw new Error('Electron smoke 构建没有输出文件')
  /** 显式环境变量仍可固定端口；默认使用系统分配的空闲端口。 */
  const selectedPort = process.env.PROMA_AUDIO_GENERATION_SMOKE_PORT ?? await findAvailablePort()
  const selectedFixtureUrl = `http://127.0.0.1:${selectedPort}/@fs${join(process.cwd(), 'scripts/audio-generation-settings-smoke.html')}`
  const vite = spawn(process.execPath, [join(process.cwd(), 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', selectedPort, '--strictPort'], {
    cwd: process.cwd(),
    stdio: 'inherit',
  })
  try {
    await waitForVite(selectedFixtureUrl)
    const electron = spawn(join(process.cwd(), 'node_modules/.bin/electron'), [outputPath], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PROMA_AUDIO_GENERATION_SMOKE_CHILD: '1',
        PROMA_AUDIO_GENERATION_SMOKE_PORT: selectedPort,
      },
      stdio: 'inherit',
    })
    const exitCode = await new Promise<number>((resolve, reject) => {
      /** 有界超时避免失败窗口或 timer 悬挂 CI。 */
      const timeout = setTimeout(() => {
        electron.kill('SIGTERM')
        reject(new Error('音频设置 Electron smoke 超时'))
      }, 120_000)
      electron.once('error', (error) => { clearTimeout(timeout); reject(error) })
      electron.once('exit', (code, signal) => {
        clearTimeout(timeout)
        if (signal) reject(new Error(`Electron smoke 被信号 ${signal} 终止`))
        else resolve(code ?? 1)
      })
    })
    assert.equal(exitCode, 0, `Electron smoke 退出码为 ${exitCode}`)
  } finally {
    vite.kill('SIGTERM')
    await rm(buildDir, { recursive: true, force: true })
  }
}

if (process.env.PROMA_AUDIO_GENERATION_SMOKE_CHILD === '1') {
  void runElectronSmoke().then(async () => {
    const { app } = await import('electron')
    app.quit()
  }).catch(async (error: unknown) => {
    console.error('[音频设置 smoke] FAIL', error)
    const { app } = await import('electron')
    app.exit(1)
  })
} else {
  void orchestrateSmoke().catch((error: unknown) => {
    console.error('[音频设置 smoke] FAIL', error)
    process.exitCode = 1
  })
}
