import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

/** QA 脚本目录用于解析 fixture、构建产物和 Electron main。 */
const qaRoot = path.dirname(fileURLToPath(import.meta.url))
/** Electron 包根目录用于解析项目内 Vite 与 Electron。 */
const electronRoot = path.resolve(qaRoot, '../..')
/** 默认按 Node 规则解析 Playwright，本机或 CI 可通过环境变量指定模块目录。 */
const playwrightSpecifier = process.env.PROMA_CANVAS_QA_PLAYWRIGHT ?? 'playwright'
/** 从 Electron 项目依赖图解析可执行文件和 Vite CLI。 */
const appRequire = createRequire(path.join(electronRoot, 'package.json'))
/** 复用应用已固定的 Sharp 生成确定性缩略图，不引入新依赖。 */
const sharp = appRequire('sharp')
/** Playwright Electron driver 不绑定开发者主目录。 */
const { _electron: electron } = createRequire(import.meta.url)(playwrightSpecifier)
/** 每次运行创建独立结果目录，截图和指标不会覆盖生产资源。 */
const resultsRoot = process.env.PROMA_CANVAS_QA_RESULTS
  ?? path.join('/tmp', `proma-canvas-completion-qa-${Date.now()}`)
/** 四张本地 PNG 的运行时目录。 */
const thumbnailRoot = path.join(resultsRoot, 'thumbnails')
/** QA 页面构建产物与截图保存在同一隔离结果目录。 */
const qaDist = path.join(resultsRoot, 'dist')
mkdirSync(thumbnailRoot, { recursive: true })

/** 320x200 像素面用于产生有纹理的真实 PNG 解码与缩放负载。 */
const thumbnailWidth = 320
const thumbnailHeight = 200
for (let fixtureIndex = 0; fixtureIndex < 4; fixtureIndex += 1) {
  /** RGB 原始像素通过坐标、棋盘格和 fixture 编号确定性生成。 */
  const pixels = Buffer.alloc(thumbnailWidth * thumbnailHeight * 3)
  for (let y = 0; y < thumbnailHeight; y += 1) {
    for (let x = 0; x < thumbnailWidth; x += 1) {
      const offset = (y * thumbnailWidth + x) * 3
      const checker = (Math.floor(x / 32) + Math.floor(y / 25) + fixtureIndex) % 2
      pixels[offset] = (x + fixtureIndex * 61 + checker * 80) % 256
      pixels[offset + 1] = (y * 2 + fixtureIndex * 37 + checker * 45) % 256
      pixels[offset + 2] = (x + y + fixtureIndex * 89 + checker * 110) % 256
    }
  }
  await sharp(pixels, {
    raw: { width: thumbnailWidth, height: thumbnailHeight, channels: 3 },
  }).png().toFile(path.join(thumbnailRoot, `thumbnail-${fixtureIndex + 1}.png`))
}

/** 主机硬件信息用于解释不同机器上的加载和帧测量差异。 */
const hostEnvironment = {
  platform: os.platform(),
  release: os.release(),
  arch: os.arch(),
  cpuModel: os.cpus()[0]?.model ?? 'unknown',
  logicalCpuCount: os.cpus().length,
  totalMemoryBytes: os.totalmem(),
}

/** 使用当前 bundled Node 执行项目内 Vite，避免引入额外运行时。 */
const viteBin = path.join(path.dirname(appRequire.resolve('vite/package.json')), 'bin/vite.js')
const buildResult = spawnSync(process.execPath, [viteBin, 'build', '--config', path.join(qaRoot, 'vite.config.ts')], {
  cwd: electronRoot,
  encoding: 'utf8',
  env: { ...process.env, PROMA_CANVAS_QA_DIST: qaDist },
})
if (buildResult.status !== 0) {
  process.stderr.write(buildResult.stdout)
  process.stderr.write(buildResult.stderr)
  process.exit(buildResult.status ?? 1)
}

/** Electron 可执行文件由 apps/electron 当前依赖解析。 */
const electronExecutable = appRequire('electron')
/** 页面 console 与 runtime error 统一收集进最终证据。 */
const runtimeErrors = []
/** 独立 Electron 应用实例，不加载 Proma 生产 main。 */
const application = await electron.launch({
  executablePath: electronExecutable,
  args: [path.join(qaRoot, 'qa-main.cjs')],
  cwd: electronRoot,
  env: {
    ...process.env,
    PROMA_CANVAS_QA_ENTRY: path.join(qaDist, 'index.html'),
    PROMA_CANVAS_QA_THUMBNAILS: thumbnailRoot,
  },
})

try {
  /** QA main 只创建一个窗口。 */
  const page = await application.firstWindow()
  /** CDP 直接读取 V8 heap，避免 performance.memory 粗粒度缓存产生固定假样本。 */
  const cdpSession = await page.context().newCDPSession(page)
  await cdpSession.send('HeapProfiler.enable')
  page.on('console', (message) => {
    if (message.type() === 'error') runtimeErrors.push(`console: ${message.text()}`)
  })
  page.on('pageerror', (error) => runtimeErrors.push(`pageerror: ${error.message}`))
  await page.locator('body[data-qa-ready="true"]').waitFor()

  /** 空闲 RAF 中位间隔用于估算当前显示刷新率，不依赖系统私有 API。 */
  const rendererEnvironment = await page.evaluate(async () => {
    const frameDeltas = []
    let previous = null
    await new Promise((resolve) => {
      const sample = (timestamp) => {
        if (previous !== null) frameDeltas.push(timestamp - previous)
        previous = timestamp
        if (frameDeltas.length >= 90) resolve()
        else requestAnimationFrame(sample)
      }
      requestAnimationFrame(sample)
    })
    frameDeltas.sort((left, right) => left - right)
    const medianFrameMs = frameDeltas[Math.floor(frameDeltas.length / 2)] ?? 0
    return {
      userAgent: navigator.userAgent,
      hardwareConcurrency: navigator.hardwareConcurrency,
      deviceMemoryGiB: navigator.deviceMemory ?? null,
      devicePixelRatio: window.devicePixelRatio,
      screen: { width: screen.width, height: screen.height },
      medianFrameMs,
      estimatedRefreshHz: medianFrameMs > 0 ? Math.round(1_000 / medianFrameMs) : null,
      performanceMemoryAvailable: 'memory' in performance,
    }
  })

  /** 挂载指定规模并等待真实 Canvas 表面和至少一个可见 XYFlow 节点。 */
  async function mountScenario(nodeCount) {
    const startedAt = performance.now()
    await page.evaluate((count) => window.canvasQa.mount(count), nodeCount)
    await page.locator('[data-native-canvas-surface]').waitFor()
    await page.locator('.react-flow__node').first().waitFor()
    return performance.now() - startedAt
  }

  /** 先收集 DOM/图片/监听器，再强制 V8 GC 并读取当前 isolate 的真实 heap。 */
  async function collectResourceSample() {
    const rendererSample = await page.evaluate(() => window.canvasQa.collectResourceSample())
    await cdpSession.send('HeapProfiler.collectGarbage')
    const heapUsage = await cdpSession.send('Runtime.getHeapUsage')
    return {
      ...rendererSample,
      cdpHeapBytes: heapUsage.usedSize,
      cdpHeapTotalBytes: heapUsage.totalSize,
      cdpEmbedderHeapBytes: heapUsage.embedderHeapUsedSize ?? null,
      cdpBackingStorageBytes: heapUsage.backingStorageSize ?? null,
    }
  }

  /** 对当前规模执行同一套平移、缩放和选择交互，并独立采集帧间隔。 */
  async function probeCanvasInteraction(pushUpdates = false) {
    await page.evaluate(() => window.canvasQa.startFrameProbe())
    await page.getByRole('button', { name: '平移工具' }).click()
    const canvasBox = await page.locator('[aria-label="Canvas 画布"]').boundingBox()
    if (!canvasBox) throw new Error('Canvas 画布没有可交互边界')
    await page.mouse.move(canvasBox.x + canvasBox.width * 0.55, canvasBox.y + canvasBox.height * 0.55)
    await page.mouse.down()
    await page.mouse.move(canvasBox.x + canvasBox.width * 0.42, canvasBox.y + canvasBox.height * 0.44, { steps: 12 })
    await page.mouse.up()
    await page.mouse.wheel(0, -420)
    await page.getByRole('button', { name: '选择工具' }).click()
    await page.locator('.react-flow__node').first().click()
    const pushedUpdateCount = pushUpdates
      ? await page.evaluate(() => window.canvasQa.pushActiveUpdates())
      : 0
    await page.waitForTimeout(350)
    return {
      pushedUpdateCount,
      frameMetrics: await page.evaluate(() => window.canvasQa.stopFrameProbe()),
    }
  }

  /** 截图覆盖桌面/窄屏和明/暗主题。 */
  await page.setViewportSize({ width: 1_440, height: 900 })
  const load1000Ms = await mountScenario(1_000)
  const initialResources = await collectResourceSample()
  await page.screenshot({ path: path.join(resultsRoot, 'desktop-light-1000.png'), fullPage: true })
  await page.evaluate(() => window.canvasQa.setTheme('dark'))
  await page.screenshot({ path: path.join(resultsRoot, 'desktop-dark-1000.png'), fullPage: true })

  /** 在真实 Canvas 上执行平移、缩放和选择，并只采集该交互窗口的帧间隔。 */
  const initialInteraction = await probeCanvasInteraction(true)
  const pushedUpdates = initialInteraction.pushedUpdateCount
  const frameMetrics = initialInteraction.frameMetrics

  await page.setViewportSize({ width: 430, height: 800 })
  await page.evaluate(() => window.canvasQa.setTheme('light'))
  await page.screenshot({ path: path.join(resultsRoot, 'narrow-light-1000.png'), fullPage: true })
  await page.evaluate(() => window.canvasQa.setTheme('dark'))
  await page.screenshot({ path: path.join(resultsRoot, 'narrow-dark-1000.png'), fullPage: true })

  /** 3000 节点单独挂载并截图，记录端到端可交互时间。 */
  await page.setViewportSize({ width: 1_440, height: 900 })
  await page.evaluate(() => window.canvasQa.setTheme('light'))
  const load3000Ms = await mountScenario(3_000)
  const stressResources = await collectResourceSample()
  await page.screenshot({ path: path.join(resultsRoot, 'desktop-light-3000.png'), fullPage: true })
  /** 3000 节点场景使用同一交互序列独立测量，不能复用 1000 节点结果。 */
  const stressFrameMetrics = (await probeCanvasInteraction()).frameMetrics

  /** 五轮 1000/3000 节点挂载与卸载，观察 GC 后堆和 DOM 是否回落。 */
  const resourceCycles = []
  for (let cycle = 1; cycle <= 5; cycle += 1) {
    const cycleNodeCount = cycle % 2 === 0 ? 3_000 : 1_000
    await mountScenario(cycleNodeCount)
    const mounted = await collectResourceSample()
    await page.evaluate(() => window.canvasQa.unmount())
    const released = await collectResourceSample()
    resourceCycles.push({ cycle, nodeCount: cycleNodeCount, mounted, released })
  }

  /** 主进程指标证明 5000 历史仅在 fixture 内，Renderer 单次最多拿到 12 条摘要。 */
  const fixtureMetrics = await page.evaluate(() => window.canvasQa.getFixtureMetrics())
  const firstReleasedHeap = resourceCycles[0]?.released.cdpHeapBytes ?? null
  const finalReleasedHeap = resourceCycles.at(-1)?.released.cdpHeapBytes ?? null
  /** GC 后允许 16 MiB JIT/缓存波动，同时限制相对增长不超过 35%。 */
  const heapRecovered = firstReleasedHeap === null || finalReleasedHeap === null
    ? null
    : finalReleasedHeap <= firstReleasedHeap * 1.35 + 16 * 1024 * 1024
  /** DOM 卸载后只应保留 QA 页面壳。 */
  const domRecovered = resourceCycles.every((cycle) => cycle.released.domNodes <= 12)
  /** 两个 preload channel 在每次完整卸载后都必须释放到零。 */
  const listenersRecovered = resourceCycles.every((cycle) => (
    cycle.released.listenerMetrics.canvasChanged === 0
    && cycle.released.listenerMetrics.designChanged === 0
    && cycle.released.listenerMetrics.total === 0
  ))
  /** 核心断言聚焦可证伪的功能、IPC 有界性、帧 stall 与资源释放。 */
  const assertions = {
    loaded1000Nodes: fixtureMetrics.loaded1000Count > 0 && load1000Ms > 0,
    loaded3000Nodes: fixtureMetrics.loaded3000Count > 0 && load3000Ms > 0,
    pushed12ActiveUpdates: pushedUpdates === 12 && fixtureMetrics.activeEventCount === 12,
    retained5000HistoryJobs: fixtureMetrics.historyCount === 5_000,
    boundedActivityIpc: fixtureMetrics.maxReturnedJobs === 12,
    decodedLocalThumbnails: initialResources.loadedImages > 0
      && stressResources.loadedImages > 0
      && initialResources.minimumImageWidth >= thumbnailWidth
      && initialResources.minimumImageHeight >= thumbnailHeight,
    no1000NodeInteractionStallOver100Ms: frameMetrics.stallsOver100Ms === 0,
    interaction1000NodeP95Under33Ms: frameMetrics.p95Ms <= 33,
    no3000NodeInteractionStallOver100Ms: stressFrameMetrics.stallsOver100Ms === 0,
    interaction3000NodeP95Under33Ms: stressFrameMetrics.p95Ms <= 33,
    domRecoveredAfterFiveCycles: domRecovered,
    heapRecoveredAfterFiveCycles: heapRecovered,
    listenersRecoveredAfterEveryCycle: listenersRecovered,
    noRuntimeErrors: runtimeErrors.length === 0,
  }
  /** JSON 是后续阶段复核的机器可读证据。 */
  const report = {
    scope: 'isolated-electron-native-canvas-workspace',
    limitation: '不覆盖生产 App bootstrap、真实主进程 IPC 注册或 ~/.proma 配置读取。',
    resultsRoot,
    hostEnvironment,
    rendererEnvironment,
    load1000Ms,
    load3000Ms,
    pushedUpdates,
    frameMetrics,
    stressFrameMetrics,
    initialResources,
    stressResources,
    resourceCycles,
    performanceMemory: {
      available: initialResources.heapBytes !== null,
      sampleCount: [initialResources, stressResources, ...resourceCycles.flatMap((cycle) => [cycle.mounted, cycle.released])]
        .filter((sample) => sample.heapBytes !== null).length,
    },
    cdpHeap: {
      collector: 'HeapProfiler.collectGarbage + Runtime.getHeapUsage',
      sampleCount: 2 + resourceCycles.length * 2,
      firstReleasedHeapBytes: firstReleasedHeap,
      finalReleasedHeapBytes: finalReleasedHeap,
    },
    fixtureMetrics,
    runtimeErrors,
    assertions,
    passed: Object.values(assertions).every((value) => value !== false),
  }
  writeFileSync(path.join(resultsRoot, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  if (!report.passed) process.exitCode = 1
} finally {
  await application.close()
}
