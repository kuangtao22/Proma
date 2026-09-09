import { strict as assert } from 'node:assert'
import { mkdtempSync } from 'node:fs'
import { rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app, BrowserWindow } from 'electron'

/** fixture 复用现有 Vite，只挂载生产 CanvasMediaWorkbench 与内存适配器。 */
const fixtureUrl = `http://127.0.0.1:${process.env.PROMA_MEDIA_SMOKE_PORT ?? '5177'}/@fs${join(process.cwd(), 'scripts/media-workbench-layout-smoke.html')}`
/** 工作台根节点的稳定选择器。 */
const workbench = '.canvas-media-workbench-container'
/** 左右区域使用用户可理解的 aria 名称作为业务合同。 */
const previewSection = '[aria-label="媒体预览与版本"]'
/** 右侧配置区包含表单和独立滚动容器。 */
const configSection = '[aria-label="媒体生成配置"]'
/** 主操作 footer 在右栏滚动之外固定。 */
const operationFooter = '[aria-label="媒体主操作"]'

/** 等待真实 DOM 条件，失败保留明确验收点。 */
async function waitFor(window: BrowserWindow, expression: string, message: string): Promise<void> {
  const deadline = Date.now() + 12_000
  while (Date.now() < deadline) {
    if (await window.webContents.executeJavaScript(`Boolean(${expression})`)) return
    await new Promise<void>((resolve) => setTimeout(resolve, 40))
  }
  throw new Error(message)
}
/** 使用真实坐标点击可见按钮，覆盖 React 与 Radix 事件链。 */
async function clickButton(window: BrowserWindow, label: string, scope = workbench, index = 0): Promise<void> {
  const point = await window.webContents.executeJavaScript(`(() => {
    const root = document.querySelector(${JSON.stringify(scope)});
    const buttons = [...(root?.querySelectorAll('button') ?? [])].filter((item) => item.textContent?.trim() === ${JSON.stringify(label)});
    const button = buttons[${index}];
    if (!button || button.disabled) return null;
    button.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => {
      const rect = button.getBoundingClientRect();
      resolve({ x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) });
    })));
  })()`)
  assert.ok(point, `找不到可点击按钮：${label}#${index}`)
  window.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 })
  window.webContents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 })
}
/** 切换 fixture 模式并等待新工作台完成 LOAD。 */
async function setMode(window: BrowserWindow, mode: 'normal' | 'readonly' | 'empty' | 'error' | 'preview-error'): Promise<void> {
  await window.webContents.executeJavaScript(`window.__mediaWorkbenchLayoutSmoke.setMode(${JSON.stringify(mode)})`)
  await waitFor(window, `document.querySelector(${JSON.stringify(workbench)}) || document.body.textContent.includes('隔离加载失败')`, `模式 ${mode} 未挂载`)
  if (mode !== 'error') await waitFor(window, `!document.body.textContent.includes('加载媒体模块')`, `模式 ${mode} 未完成加载`)
}
/** 验证桌面左右布局、独立滚动、媒体预览和全部业务按钮参数。 */
async function verifyWide(window: BrowserWindow): Promise<void> {
  await window.webContents.executeJavaScript('window.__mediaWorkbenchLayoutSmoke.setWidth(1040)')
  await waitFor(window, `document.querySelector(${JSON.stringify(previewSection)}) && document.querySelector(${JSON.stringify(configSection)}) && document.querySelector(${JSON.stringify(operationFooter)})`, '左右工作台区域未挂载')
  assert.equal(await window.webContents.executeJavaScript(`(() => {
    const shell = document.querySelector('[data-smoke-shell]').getBoundingClientRect();
    const left = document.querySelector(${JSON.stringify(previewSection)}).getBoundingClientRect();
    const right = document.querySelector(${JSON.stringify(configSection)}).getBoundingClientRect();
    return left.left >= shell.left && right.right <= shell.right && left.right <= right.left
      && Math.abs(left.top - right.top) <= 2 && Math.abs(left.height - right.height) <= 2;
  })()`), true, '宽容器没有形成左预览、右配置的并列布局')
  await waitFor(window, `document.querySelector(${JSON.stringify(`${previewSection} video`)})?.readyState >= 2`, '视频工作台没有自动加载首份主输出')
  assert.deepEqual(await window.webContents.executeJavaScript('window.__mediaWorkbenchLayoutSmoke.previewCalls.slice(0, 1)'), [
    { candidateId: 'candidate-1', outputKey: '92.video', outputOrder: 0 },
  ], '空选择应按创建时间自动预览首份视频主输出')
  assert.equal(await window.webContents.executeJavaScript(`(() => {
    const pane = document.querySelector(${JSON.stringify(previewSection)});
    const confirm = [...pane.querySelectorAll('button')].find((button) => button.textContent.trim() === '确认采用');
    return pane.textContent.includes('当前默认') && confirm && !confirm.disabled;
  })()`), true, '自动首选应标记为当前默认，并保留显式确认采用入口')

  await window.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(configSection)} + ' details')?.setAttribute('open', '')`)
  const stableRects = await window.webContents.executeJavaScript(`(() => {
    const left = document.querySelector(${JSON.stringify(previewSection)}).getBoundingClientRect();
    const footer = document.querySelector(${JSON.stringify(operationFooter)}).getBoundingClientRect();
    const viewport = document.querySelector(${JSON.stringify(configSection)} + ' .canvas-media-config-scroll [data-radix-scroll-area-viewport]');
    viewport.scrollTop = viewport.scrollHeight;
    return { leftTop: left.top, footerTop: footer.top, scrollTop: viewport.scrollTop };
  })()`)
  assert.ok(stableRects.scrollTop > 0, '长表单没有在右栏内部滚动')
  await new Promise<void>((resolve) => setTimeout(resolve, 100))
  assert.equal(await window.webContents.executeJavaScript(`(() => {
    const left = document.querySelector(${JSON.stringify(previewSection)}).getBoundingClientRect();
    const footer = document.querySelector(${JSON.stringify(operationFooter)}).getBoundingClientRect();
    return Math.abs(left.top - ${stableRects.leftTop}) <= 1 && Math.abs(footer.top - ${stableRects.footerTop}) <= 1;
  })()`), true, '配置滚动改变了左栏或主操作 footer 的位置')

  await clickButton(window, '预览', previewSection, 0)
  await waitFor(window, `document.querySelector(${JSON.stringify(`${previewSection} video`)})?.readyState >= 2`, '视频候选没有加载真实媒体帧')
  assert.equal(await window.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(`${previewSection} video`)}).videoWidth > 0`), true, '视频候选没有可解码画面')
  await window.webContents.executeJavaScript(`(() => {
    const video = document.querySelector(${JSON.stringify(`${previewSection} video`)});
    video.muted = true;
    return video.play();
  })()`)
  await waitFor(window, `document.querySelector(${JSON.stringify(`${previewSection} video`)}).currentTime > 0`, '视频候选没有播放到真实画面')
  await window.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(`${previewSection} video`)}).pause()`)
  await window.webContents.executeJavaScript(`document.querySelectorAll(${JSON.stringify(`${workbench} [data-radix-scroll-area-viewport]`)}).forEach((viewport) => { viewport.scrollTop = 0 })`)
  await new Promise<void>((resolve) => setTimeout(resolve, 120))
  await writeFile('/private/tmp/media-workbench-layout-wide-dark.png', (await window.webContents.capturePage()).toPNG())
  await clickButton(window, '预览', previewSection, 1)
  await waitFor(window, `document.querySelector(${JSON.stringify(`${previewSection} audio`)})?.readyState >= 1`, '音频候选没有加载真实媒体元数据')
  assert.deepEqual(await window.webContents.executeJavaScript('window.__mediaWorkbenchLayoutSmoke.previewCalls.slice(0, 3)'), [
    { candidateId: 'candidate-1', outputKey: '92.video', outputOrder: 0 },
    { candidateId: 'candidate-2', outputKey: '92.video', outputOrder: 0 },
    { candidateId: 'candidate-2', outputKey: '92.audio', outputOrder: 1 },
  ])
  assert.equal(await window.webContents.executeJavaScript('window.__mediaWorkbenchLayoutSmoke.releasedLeases.length'), 2, '自动预览与手动切换没有逐次释放旧 lease')

  await clickButton(window, '保存', operationFooter)
  await waitFor(window, 'window.__mediaWorkbenchLayoutSmoke.saveCalls.length === 1', '保存按钮未调用适配器')
  assert.equal(await window.webContents.executeJavaScript(`(() => {
    const call = window.__mediaWorkbenchLayoutSmoke.saveCalls[0];
    return call.inputs.length === 5
      && call.inputs.filter((input) => input.kind === 'image').map((input) => input.source.value.assetId).join(',') === 'reference-137,reference-139,reference-144'
      && call.inputs.find((input) => input.key === '131.expression').source.value.length === ${JSON.stringify('固定机位，角色轻微抬头并克制地点赞，桌面道具保持静止；保持参考图人物、服装、材质、灯光与镜头关系一致，不新增文字、数字、Logo、旁白或音乐。'.repeat(5).length)}
      && call.inputs.find((input) => input.key === '138.value').source.value === 73;
  })()`), true, '保存改变了参考图、提示词或数值参数')

  await clickButton(window, '运行', operationFooter)
  await waitFor(window, 'window.__mediaWorkbenchLayoutSmoke.runCalls.length === 1', '运行按钮未调用适配器')
  assert.equal(await window.webContents.executeJavaScript(`(() => {
    const save = window.__mediaWorkbenchLayoutSmoke.saveCalls.at(-1);
    const run = window.__mediaWorkbenchLayoutSmoke.runCalls[0];
    return save.expectedConfigRevision === 5 && run.expectedConfigRevision === 6 && typeof run.operationId === 'string' && run.operationId.length > 10;
  })()`), true, '运行没有先保存或 revision/operationId 丢失')
  await waitFor(window, `[...document.querySelectorAll(${JSON.stringify(operationFooter)} + ' button')].some((button) => button.textContent.trim() === '取消')`, '运行后未显示取消')
  await clickButton(window, '取消', operationFooter)
  await waitFor(window, 'window.__mediaWorkbenchLayoutSmoke.cancelCalls.length === 1', '取消按钮未调用适配器')
  assert.equal(await window.webContents.executeJavaScript('window.__mediaWorkbenchLayoutSmoke.cancelCalls[0].runId'), 'run-live')

  await clickButton(window, '导出', previewSection, 0)
  await waitFor(window, 'window.__mediaWorkbenchLayoutSmoke.exportCalls.length === 1', '导出按钮未调用适配器')
  await clickButton(window, '采用 final 组', previewSection, 0)
  await waitFor(window, 'window.__mediaWorkbenchLayoutSmoke.adoptCalls.length === 1', '采用按钮未调用适配器')
  await waitFor(window, 'window.__mediaWorkbenchLayoutSmoke.previewCalls.length === 4', '显式采用后没有切换到被采用的视频输出')
  assert.deepEqual(await window.webContents.executeJavaScript('window.__mediaWorkbenchLayoutSmoke.exportCalls[0]'), {
    projectId: 'layout-project', canvasId: 'layout-canvas', nodeId: 'layout-node', mediaModuleId: 'layout-media', mediaKind: 'video',
    candidateId: 'candidate-2', outputKey: '92.video', outputOrder: 0,
  })
  assert.deepEqual(await window.webContents.executeJavaScript('window.__mediaWorkbenchLayoutSmoke.adoptCalls[0].selectedKeys'), ['92.video', '92.audio'])
  assert.deepEqual(await window.webContents.executeJavaScript('window.__mediaWorkbenchLayoutSmoke.previewCalls[3]'), {
    candidateId: 'candidate-2', outputKey: '92.video', outputOrder: 0,
  })
}

/** 验证只读、空候选和 LOAD 错误均在新布局中保留原语义。 */
async function verifyStates(window: BrowserWindow): Promise<void> {
  await setMode(window, 'readonly')
  assert.equal(await window.webContents.executeJavaScript(`(() => {
    const footer = document.querySelector(${JSON.stringify(operationFooter)});
    const buttons = [...document.querySelectorAll('button')];
    const disabled = (label) => buttons.filter((button) => button.textContent.trim() === label).every((button) => button.disabled);
    return ['保存', '运行', '采用 final 组'].every(disabled)
      && document.querySelector('#canvas-media-workflow').disabled
      && document.querySelector('#canvas-media-connection').disabled
      && [...document.querySelectorAll(${JSON.stringify(`${configSection} textarea, ${configSection} input[type=number]`)})].every((field) => field.disabled)
      && footer !== null;
  })()`), true, '只读模式仍允许修改配置或采用候选')
  await setMode(window, 'empty')
  await waitFor(window, `document.querySelector(${JSON.stringify(previewSection)})?.textContent.includes('暂无历史版本')`, '空候选提示缺失')
  assert.equal(await window.webContents.executeJavaScript(`document.querySelectorAll(${JSON.stringify(`${previewSection} button`)}).length`), 0, '空候选仍显示候选操作')
  const previewCallsBeforeFailure = await window.webContents.executeJavaScript('window.__mediaWorkbenchLayoutSmoke.previewCalls.length')
  await setMode(window, 'preview-error')
  await waitFor(window, `document.querySelector(${JSON.stringify(`${previewSection} [role=alert]`)})?.textContent.includes('隔离预览读取失败')`, '默认预览读取错误没有显示')
  await new Promise<void>((resolve) => setTimeout(resolve, 200))
  assert.equal(await window.webContents.executeJavaScript('window.__mediaWorkbenchLayoutSmoke.previewCalls.length'), previewCallsBeforeFailure + 1, '默认预览失败后发生了无限自动重试')
  await clickButton(window, '预览', previewSection, 0)
  await waitFor(window, `document.querySelector(${JSON.stringify(`${previewSection} video`)})?.readyState >= 2`, '用户手动重试没有恢复视频预览')
  assert.equal(await window.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(`${previewSection} [role=alert]`)}) === null`), true, '手动重试成功后仍残留预览错误')
  await setMode(window, 'error')
  await waitFor(window, `document.body.textContent.includes('隔离加载失败') && [...document.querySelectorAll('button')].some((button) => button.textContent.trim() === '重试')`, 'LOAD 错误或重试入口不可见')
}

/** 验证窄容器采用上下布局、内容无横向溢出且两区仍可滚动访问。 */
async function verifyNarrow(window: BrowserWindow): Promise<void> {
  await setMode(window, 'normal')
  await window.webContents.executeJavaScript('window.__mediaWorkbenchLayoutSmoke.setWidth(430); window.__mediaWorkbenchLayoutSmoke.setHeight(720)')
  await waitFor(window, `document.querySelector('[data-smoke-shell]').getBoundingClientRect().width < 440`, '窄容器宽度未生效')
  assert.equal(await window.webContents.executeJavaScript(`(() => {
    const shell = document.querySelector('[data-smoke-shell]');
    const left = document.querySelector(${JSON.stringify(previewSection)}).getBoundingClientRect();
    const right = document.querySelector(${JSON.stringify(configSection)}).getBoundingClientRect();
    const footer = document.querySelector(${JSON.stringify(operationFooter)}).getBoundingClientRect();
    const viewports = [...document.querySelectorAll(${JSON.stringify(`${workbench} [data-radix-scroll-area-viewport]`)})];
    return left.bottom <= right.top + 2 && footer.bottom <= shell.getBoundingClientRect().bottom + 1
      && shell.scrollWidth <= shell.clientWidth && document.documentElement.scrollWidth <= innerWidth
      && viewports.length >= 2 && viewports.every((viewport) => viewport.clientHeight > 0)
      && [...shell.querySelectorAll('input, textarea, button')].every((element) => element.getBoundingClientRect().right <= shell.getBoundingClientRect().right + 1);
  })()`), true, '窄容器没有上下排列、出现横向溢出或滚动区不可达')
  await window.webContents.executeJavaScript(`(() => {
    const viewport = document.querySelector(${JSON.stringify(`${previewSection} .canvas-media-preview-scroll [data-radix-scroll-area-viewport]`)});
    viewport.scrollTop = viewport.scrollHeight;
  })()`)
  await clickButton(window, '预览', previewSection, 0)
  await waitFor(window, `document.querySelector(${JSON.stringify(`${previewSection} video`)})?.readyState >= 2`, '窄布局视频预览未加载')
  await window.webContents.executeJavaScript(`(() => {
    const video = document.querySelector(${JSON.stringify(`${previewSection} video`)});
    video.muted = true;
    return video.play();
  })()`)
  await waitFor(window, `document.querySelector(${JSON.stringify(`${previewSection} video`)}).currentTime > 0`, '窄布局视频没有显示真实画面')
  await window.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(`${previewSection} video`)}).pause()`)
  await window.webContents.executeJavaScript(`document.querySelectorAll(${JSON.stringify(`${workbench} [data-radix-scroll-area-viewport]`)}).forEach((viewport) => { viewport.scrollTop = 0 })`)
  await new Promise<void>((resolve) => setTimeout(resolve, 120))
  await writeFile('/private/tmp/media-workbench-layout-narrow-light.png', (await window.webContents.capturePage()).toPNG())
  await window.webContents.executeJavaScript('window.__mediaWorkbenchLayoutSmoke.setHeight(320)')
  await waitFor(window, `Math.abs(document.querySelector('[data-smoke-shell]').getBoundingClientRect().height - 320) <= 1`, '320px 最小高度未生效')
  assert.equal(await window.webContents.executeJavaScript(`(() => {
    const shell = document.querySelector('[data-smoke-shell]').getBoundingClientRect();
    const footer = document.querySelector(${JSON.stringify(operationFooter)}).getBoundingClientRect();
    const panes = [document.querySelector(${JSON.stringify(previewSection)}), document.querySelector(${JSON.stringify(configSection)})];
    return footer.top >= shell.top && footer.bottom <= shell.bottom + 1
      && panes.every((pane) => pane.getBoundingClientRect().height > 0)
      && document.querySelector(${JSON.stringify(operationFooter)} + ' button') !== null;
  })()`), true, '430x320 工作台的主操作或上下区域不可见')
  await window.webContents.executeJavaScript('window.__mediaWorkbenchLayoutSmoke.failNextSave = true')
  await clickButton(window, '保存', operationFooter)
  await waitFor(window, `document.querySelector(${JSON.stringify(`${operationFooter} [role=alert]`)})?.textContent.includes('保存失败')`, '保存失败没有显示在固定操作区')
  const errorGeometry = await window.webContents.executeJavaScript(`(() => {
    const shell = document.querySelector('[data-smoke-shell]').getBoundingClientRect();
    const footer = document.querySelector(${JSON.stringify(operationFooter)}).getBoundingClientRect();
    const configViewport = document.querySelector(${JSON.stringify(`${configSection} .canvas-media-config-scroll [data-radix-scroll-area-viewport]`)});
    const buttons = [...document.querySelectorAll(${JSON.stringify(`${operationFooter} button`)})].map((button) => button.getBoundingClientRect());
    return {
      shell: { top: shell.top, bottom: shell.bottom, height: shell.height },
      footer: { top: footer.top, bottom: footer.bottom, height: footer.height },
      configViewport: { clientHeight: configViewport.clientHeight, scrollHeight: configViewport.scrollHeight },
      buttons: buttons.map((button) => ({ left: button.left, right: button.right, bottom: button.bottom })),
      valid: footer.top >= shell.top && footer.bottom <= shell.bottom + 1
        && configViewport.clientHeight > 0 && configViewport.scrollHeight > configViewport.clientHeight
        && buttons.every((button) => button.left >= shell.left && button.right <= shell.right + 1 && button.bottom <= shell.bottom + 1),
    };
  })()`)
  console.log(`[媒体工作台布局] 430x320 错误态几何 ${JSON.stringify(errorGeometry)}`)
  assert.equal(errorGeometry.valid, true, `长保存错误挤出了配置滚动区或主操作按钮：${JSON.stringify(errorGeometry)}`)
  await writeFile('/private/tmp/media-workbench-layout-430x320-light.png', (await window.webContents.capturePage()).toPNG())
  await waitFor(window, 'window.__mediaWorkbenchLayoutSmoke.previewUrls.size === 1', '窄布局未取得预览 lease')
  await window.webContents.executeJavaScript('window.__mediaWorkbenchLayoutSmoke.unmount()')
  await waitFor(window, 'window.__mediaWorkbenchLayoutSmoke.previewUrls.size === 0', '卸载后预览 Blob/lease 未释放')
}

/** 使用独立 Electron userData 运行，不连接用户客户端和真实媒体服务。 */
async function run(): Promise<void> {
  const userDataPath = mkdtempSync(join(tmpdir(), 'proma-media-workbench-layout-'))
  app.setPath('userData', userDataPath)
  app.on('window-all-closed', () => {})
  await app.whenReady()
  const window = new BrowserWindow({ width: 1100, height: 820, show: false, webPreferences: { backgroundThrottling: false } })
  const rendererErrors: string[] = []
  window.webContents.on('console-message', (event) => {
    if (event.level === 'error') rendererErrors.push(event.message)
  })
  try {
    await window.loadURL(`${fixtureUrl}?theme=dark`)
    await waitFor(window, `document.querySelector(${JSON.stringify(workbench)}) && !document.body.textContent.includes('加载媒体模块')`, '媒体工作台未完成首次加载')
    await verifyWide(window)
    await verifyStates(window)
    await window.loadURL(`${fixtureUrl}?theme=light`)
    await waitFor(window, `document.querySelector(${JSON.stringify(workbench)}) && !document.body.textContent.includes('加载媒体模块')`, '浅色工作台未完成加载')
    await verifyNarrow(window)
    assert.deepEqual(rendererErrors, [], '布局与媒体交互不应产生 Renderer 错误')
    console.log('[媒体工作台布局] PASS：左右/上下布局、独立滚动、固定主操作、音视频预览、保存/运行/取消/导出/采用、状态与 lease 回收')
  } finally {
    window.destroy()
    await rm(userDataPath, { recursive: true, force: true })
  }
}

void run().then(() => app.quit()).catch((error: unknown) => { console.error(error); app.exit(1) })
