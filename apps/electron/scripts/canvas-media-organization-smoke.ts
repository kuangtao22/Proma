import { strict as assert } from 'node:assert'
import { mkdtempSync } from 'node:fs'
import { rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app, BrowserWindow } from 'electron'

/** 隔离页面与纯内存观察点，不连接用户应用。 */
const fixtureUrl = `http://127.0.0.1:${process.env.PROMA_CANVAS_SMOKE_PORT ?? '5186'}/@fs${join(process.cwd(), 'scripts/canvas-media-organization-smoke.html')}`
const state = 'window.__canvasOrganizationSmoke'
/** 以真实 DOM 条件有界等待 React 和 Radix。 */
async function waitFor(window: BrowserWindow, expression: string, message: string): Promise<void> {
  const deadline = Date.now() + 12_000
  while (Date.now() < deadline) {
    if (await window.webContents.executeJavaScript(`Boolean(${expression})`)) return
    await new Promise<void>((resolve) => setTimeout(resolve, 40))
  }
  throw new Error(message)
}
/** 发送实际坐标点击，覆盖 Portal 事件链。 */
async function click(window: BrowserWindow, expression: string): Promise<void> {
  const point = await window.webContents.executeJavaScript(`(async () => {
    const element = ${expression}; if (!element || element.disabled) return null;
    element.scrollIntoView({block:'nearest'});
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const r = element.getBoundingClientRect(); return {x: Math.round(r.left+r.width/2), y: Math.round(r.top+r.height/2)};
  })()`)
  assert.ok(point, `找不到可操作控件：${expression}`)
  window.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 })
  window.webContents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 })
}
/** 精确文字只匹配按钮。 */
function button(label: string): string {
  return `[...document.querySelectorAll('button')].find(item => item.textContent.trim() === ${JSON.stringify(label)})`
}
/** 打开来源菜单并选择实际选项。 */
async function choose(window: BrowserWindow, label: string, text: string): Promise<void> {
  await click(window, `document.querySelector('[aria-label="${label}"]')`)
  const option = `[...document.querySelectorAll('[role="option"]')].find(item => item.textContent.includes(${JSON.stringify(text)}))`
  await waitFor(window, option, `未找到选项：${text}`)
  await click(window, option)
  await waitFor(window, `!document.querySelector('[role="listbox"]')`, '菜单没有关闭')
}
/** 验证工作台保存与补线，以及两条独立异步请求链的迟到响应。 */
async function verify(window: BrowserWindow): Promise<void> {
  const js = (expression: string): Promise<unknown> => window.webContents.executeJavaScript(expression)
  await waitFor(window, `document.body.textContent.includes('7 个媒体待准备') && document.querySelector('[aria-label="first 来源节点"]')`, '准备汇总或来源表单未加载')
  assert.equal(await js("document.body.textContent.includes('1 个节点需要处理') && document.body.textContent.includes('待工作流绑定') && !document.body.textContent.includes('节点 ?')"), true)
  await waitFor(window, "[...document.querySelectorAll('[aria-label=\"first 来源节点\"] img')].some(img => img.naturalWidth > 0)", '已授权缩略图未显示')
  await writeFile('/private/tmp/canvas-organization-before-dark.png', (await window.webContents.capturePage()).toPNG())
  await choose(window, 'first 来源节点', '尾帧 · 人物近景')
  await waitFor(window, `${button('补齐输入连线')}?.disabled`, '未保存草稿仍允许补线')
  assert.equal(await js("document.body.textContent.includes('有未保存配置')"), true)
  await click(window, button('保存'))
  await waitFor(window, `${state}.saves.length === 1 && !${button('补齐输入连线')}?.disabled`, '保存后补线未恢复')
  assert.deepEqual(await js(`${state}.saves[0].inputs.filter(item => item.source.type === 'literal').map(item => [item.key,item.source.value])`), [['seed',42],['sound',true],['note','保留镜头备注']], '无工作流保存丢失标量')
  assert.equal(await js(`${state}.saves[0].workflow`), null)
  assert.equal(await js(`${state}.graphSaves`), 0)
  await click(window, button('补齐输入连线'))
  await waitFor(window, `${state}.graphSaves === 1 && !${state}.locked && !${button('补齐输入连线')}`, '补线未完成或结构锁未释放')
  assert.equal(await js(`${state}.graph().edges.length`), 8, '共享来源应只新增一条边并保留七条文档边')
  await waitFor(window, "document.body.textContent.includes('输入已接通') && document.body.textContent.includes('尚未绑定工作流')", '补线后阶段信息错误')
  // 返回新图的未就绪结果后再返回旧 ready，旧状态不能提交。
  await js(`${state}.ready=true; ${state}.holdPreparation=true; ${state}.setGraph({...${state}.graph(),revision:${state}.graph().revision+1})`)
  await waitFor(window, `${state}.delayedPreparation.length===1`, '旧准备请求未进入等待')
  await js(`${state}.ready=false; ${state}.setGraph({...${state}.graph(),revision:${state}.graph().revision+1})`)
  await waitFor(window, `${state}.delayedPreparation.length===2`, '新准备请求未发起')
  await js(`${state}.delayedPreparation[1](); ${state}.delayedPreparation[0](); ${state}.holdPreparation=false`)
  await waitFor(window, "document.querySelector('[aria-label=\"媒体准备阶段\"]').textContent.includes('尚未绑定工作流')", '新准备结果未展示')
  assert.equal(await js("[...document.querySelector('[aria-label=\"媒体准备阶段\"]').querySelectorAll('span')].some(item=>item.textContent==='可运行')"), false)
  await choose(window, '预合成 来源节点', '预合成 A')
  await waitFor(window, `${state}.delayedOutputs.length===1`, 'A 目录未读取')
  await choose(window, '预合成 来源节点', '预合成 B')
  await waitFor(window, `${state}.delayedOutputs.length===2`, 'B 目录未读取')
  await js(`${state}.delayedOutputs[1]()`)
  await waitFor(window, "!document.querySelector('[aria-label=\"预合成 来源输出\"]').disabled", 'B 目录未展示')
  assert.deepEqual(await js(`${state}.selection`), {nodeId:'source-b',outputKey:''}, '不能默认第一个输出')
  await choose(window, '预合成 来源输出', 'source-b.preview')
  await js(`${state}.delayedOutputs[0]()`)
  await waitFor(window, `${state}.selection?.outputKey==='source-b.preview'`, '迟到目录覆盖了选择')
  assert.equal(await js("document.querySelector('[aria-label=\"预合成 来源输出\"]').textContent.includes('source-b.preview')"), true)
  // 旧目标保存仍在途时切换到另一个节点；新草稿必须可编辑且不被旧 LOAD 覆盖。
  await js(`${state}.holdSave=true`)
  await click(window, button('保存'))
  await waitFor(window, `${state}.delayedSaves.length===1`, '旧保存请求未进入等待')
  await js(`${state}.setTargetIndex(1)`)
  await waitFor(window, `document.querySelector('[aria-label="first 来源节点"]') && !document.querySelector('[aria-label="first 来源节点"]').disabled`, '切换节点后旧保存锁住了新详情')
  await choose(window, 'first 来源节点', '尾帧 · 人物近景')
  await js(`${state}.delayedSaves[0](); ${state}.holdSave=false`)
  await waitFor(window, "document.body.textContent.includes('有未保存配置')", '旧保存清除了新节点草稿')
  await click(window, button('保存'))
  await waitFor(window, `${state}.saves.length===3`, '新节点保存未提交')
  assert.equal(await js(`${state}.saves[2].nodeId`), 'shot-2', '新草稿被写入旧节点')
  assert.deepEqual(await js(`${state}.saves[2].inputs.find(item=>item.key==='first').source`), {type:'canvas-output',nodeId:'image-2',outputKey:'image.asset'}, '新草稿来源被旧回调覆盖')
  await js(`${state}.setReadonly(true)`)
  await waitFor(window, "document.querySelector('[aria-label=\"first 来源节点\"]').disabled", '只读模式仍可修改')
  assert.equal(await js(`${button('保存')}.disabled`), true)
  assert.equal(await js(`${state}.runCalls`), 0)
  await writeFile('/private/tmp/canvas-organization-after-dark.png', (await window.webContents.capturePage()).toPNG())
}
/** 隔离 userData 与隐藏窗口，退出回收临时缓存。 */
async function run(): Promise<void> {
  const userDataPath = mkdtempSync(join(tmpdir(), 'proma-canvas-organization-'))
  app.setPath('userData', userDataPath)
  app.on('window-all-closed', () => {})
  await app.whenReady()
  const window = new BrowserWindow({ width:1200,height:1000,show:false,webPreferences:{backgroundThrottling:false} })
  const errors: string[] = []
  window.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message) })
  try {
    await window.loadURL(`${fixtureUrl}?theme=dark`)
    await verify(window)
    await window.loadURL(`${fixtureUrl}?theme=light`)
    await waitFor(window, "document.body.textContent.includes('7 个媒体待准备')", '浅色模式未加载')
    window.setSize(720,1000)
    await window.webContents.executeJavaScript("document.querySelector('[data-smoke-shell]').style.width='430px'")
    await waitFor(window, "document.querySelector('[data-smoke-shell]').getBoundingClientRect().width===430", '窄容器未生效')
    assert.equal(await window.webContents.executeJavaScript("document.querySelector('[data-smoke-shell]').scrollWidth<=430"),true,'窄容器横向溢出')
    assert.equal(await window.webContents.executeJavaScript(`(() => {
      const shell = document.querySelector('[data-smoke-shell]').getBoundingClientRect();
      const preview = document.querySelector('[aria-label="媒体预览与版本"]').getBoundingClientRect();
      const config = document.querySelector('[aria-label="媒体生成配置"]').getBoundingClientRect();
      const footer = document.querySelector('[aria-label="媒体主操作"]').getBoundingClientRect();
      return shell.height === 660 && preview.bottom <= config.top + 1
        && footer.bottom <= shell.bottom + 1 && footer.top >= shell.top;
    })()`), true, '窄容器应上下排列且主操作始终可见')
    await writeFile('/private/tmp/canvas-organization-narrow-light.png',(await window.webContents.capturePage()).toPNG())
    await window.webContents.executeJavaScript(`${state}.unmount()`)
    assert.deepEqual(errors,[],'组件不应产生 React 或资源错误')
    console.log('[画布节点梳理] PASS：七卡汇总、来源缩略图、dirty 门禁、标量保存、一次补边、AV 多输出/迟到响应、准备检查过期、只读、深浅主题、零生成')
  } catch (error) {
    console.error('Renderer errors:',errors)
    await writeFile('/private/tmp/canvas-organization-failure.png',(await window.webContents.capturePage()).toPNG())
    await writeFile('/private/tmp/canvas-organization-failure.txt',await window.webContents.executeJavaScript('document.body.innerText'))
    throw error
  } finally {
    window.destroy()
    await rm(userDataPath,{recursive:true,force:true})
  }
}
void run().then(()=>app.quit()).catch((error:unknown)=>{console.error(error);app.exit(1)})
