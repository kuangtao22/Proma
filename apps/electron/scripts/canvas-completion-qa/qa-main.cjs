const { app, BrowserWindow, ipcMain } = require('electron')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

/** QA 固定业务身份，避免 fixture 与任何真实项目发生名称碰撞。 */
const target = { projectId: 'canvas-qa-project', canvasId: 'canvas-qa-canvas' }
/** 完整历史仅保留在隔离主进程内存，Renderer 每次最多读取 12 条活动摘要。 */
const historyJobs = Array.from({ length: 5_000 }, (_, index) => ({
  id: `history-job-${index + 1}`,
  projectId: target.projectId,
  target: {
    kind: 'canvas-image',
    canvasId: target.canvasId,
    nodeId: `node-${(index % 250) + 1}`,
    imageModuleId: `image-module-${(index % 250) + 1}`,
  },
  status: 'succeeded',
  createdAt: index + 1,
  updatedAt: index + 1,
  outputAssetId: `asset-${(index % 4) + 1}`,
}))
/** 12 条活动任务用于验证事件合批和卡片活动态更新。 */
const activeJobs = Array.from({ length: 12 }, (_, index) => ({
  id: `active-job-${index + 1}`,
  projectId: target.projectId,
  target: {
    kind: 'canvas-image',
    canvasId: target.canvasId,
    nodeId: `node-${index + 1}`,
    imageModuleId: `image-module-${index + 1}`,
  },
  status: 'queued',
  createdAt: 6_000 + index,
  updatedAt: 6_000 + index,
}))
/** 主进程 fixture 指标用于证明历史没有全量跨 IPC。 */
const metrics = {
  canvasLoadCount: 0,
  loaded1000Count: 0,
  loaded3000Count: 0,
  activityReadCount: 0,
  maxReturnedJobs: 0,
  activeEventCount: 0,
  historyCount: historyJobs.length,
}
/** 当前压力规模由 QA 页面显式切换。 */
let nodeCount = 1_000
/** 当前 BrowserWindow，仅向隔离页面发送 fixture 事件。 */
let mainWindow = null

/** 按四类节点均匀构造真实 Canvas 文档。 */
function createNodes(count) {
  return Array.from({ length: count }, (_, index) => {
    /** 节点编号从 1 开始，与活动任务 nodeId 对齐。 */
    const number = index + 1
    /** 生产最大桌面卡片为 384x316；额外间距避免动态图片预览和 WebView 相互覆盖。 */
    const position = { x: (index % 50) * 432, y: Math.floor(index / 50) * 360 }
    /** 图片节点放在每组首位，确保前 12 个活动任务均指向有效图片节点。 */
    if (index < 12 || index % 4 === 0) {
      return {
        id: `node-${number}`,
        kind: 'image',
        title: `图片 ${number}`,
        imageModuleId: `image-module-${number}`,
        adoptedAssetId: `asset-${(index % 4) + 1}`,
        position,
      }
    }
    if (index % 4 === 1) {
      return { id: `node-${number}`, kind: 'agent', title: `Agent ${number}`, agentSessionId: `agent-session-${number}`, position }
    }
    if (index % 4 === 2) {
      return { id: `node-${number}`, kind: 'document', title: `文档 ${number}`, documentId: `document-${number}`, contentRevision: 1, position }
    }
    return {
      id: `node-${number}`,
      kind: 'webview',
      title: `原型 ${number}`,
      prototypeId: `prototype-${number}`,
      contentRevision: 1,
      devicePreset: 'desktop',
      position,
    }
  })
}

/** 从 QA 产物目录生成 file URL，确保 Chromium 解码的是真实本地 PNG。 */
function createImagePreviews() {
  /** Runner 在启动 Electron 前写入四张本地 PNG。 */
  const thumbnailDirectory = process.env.PROMA_CANVAS_QA_THUMBNAILS
  if (!thumbnailDirectory) throw new Error('缺少 PROMA_CANVAS_QA_THUMBNAILS')
  return Array.from({ length: 4 }, (_, index) => ({
    assetId: `asset-${index + 1}`,
    previewUrl: pathToFileURL(path.join(thumbnailDirectory, `thumbnail-${index + 1}.png`)).href,
    width: 320,
    height: 200,
  }))
}

/** 返回 Workspace 实际消费的权威快照。 */
function createSnapshot() {
  return {
    document: {
      projectId: target.projectId,
      canvasId: target.canvasId,
      revision: 1,
      nodes: createNodes(nodeCount),
      edges: [],
      viewport: { x: 36, y: 70, zoom: 0.78 },
      createdAt: 1,
      updatedAt: 1,
    },
    writable: true,
    nodeIssues: [],
    imagePreviews: createImagePreviews(),
  }
}

/** 注册专用 IPC，所有状态只存在于本 QA 进程。 */
function registerQaIpc() {
  ipcMain.handle('qa:load-canvas', () => {
    metrics.canvasLoadCount += 1
    if (nodeCount === 1_000) metrics.loaded1000Count += 1
    if (nodeCount === 3_000) metrics.loaded3000Count += 1
    return createSnapshot()
  })
  ipcMain.handle('qa:save-canvas', () => createSnapshot().document)
  ipcMain.handle('qa:list-image-activity', () => {
    metrics.activityReadCount += 1
    metrics.maxReturnedJobs = Math.max(metrics.maxReturnedJobs, activeJobs.length)
    return activeJobs
  })
  ipcMain.handle('qa:list-jobs', () => activeJobs)
  ipcMain.handle('qa:set-node-count', (_event, nextNodeCount) => {
    nodeCount = nextNodeCount
    return nodeCount
  })
  ipcMain.handle('qa:push-active-updates', () => {
    for (const [index, job] of activeJobs.entries()) {
      job.status = index % 3 === 0 ? 'succeeded' : 'running'
      job.updatedAt += 100
      if (job.status === 'succeeded') job.outputAssetId = `asset-${(index % 4) + 1}`
      metrics.activeEventCount += 1
      mainWindow?.webContents.send('qa:design-changed', {
        projectId: target.projectId,
        revision: metrics.activeEventCount,
        cause: 'job',
      })
    }
    return activeJobs.length
  })
  ipcMain.handle('qa:get-metrics', () => ({ ...metrics, nodeCount }))
}

/** 创建不加载生产 main/preload 的隔离 BrowserWindow。 */
async function createWindow() {
  /** QA 页面位置由 runner 传入，路径不依赖用户配置。 */
  const entryPath = process.env.PROMA_CANVAS_QA_ENTRY
  if (!entryPath) throw new Error('缺少 PROMA_CANVAS_QA_ENTRY')
  mainWindow = new BrowserWindow({
    width: 1_440,
    height: 900,
    show: true,
    backgroundColor: '#ffffff',
    webPreferences: {
      preload: path.join(__dirname, 'qa-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })
  await mainWindow.loadFile(entryPath)
}

app.commandLine.appendSwitch('js-flags', '--expose-gc')
app.whenReady().then(async () => {
  registerQaIpc()
  await createWindow()
})

app.on('window-all-closed', () => app.quit())
