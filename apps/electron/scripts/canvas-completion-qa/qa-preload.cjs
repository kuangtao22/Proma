const { contextBridge, ipcRenderer } = require('electron')

/** 记录 preload 实际持有的事件监听器，供反复挂载释放断言读取。 */
const listenerMetrics = {
  canvasChanged: 0,
  designChanged: 0,
  subscriptions: 0,
  disposals: 0,
}

/** 创建可重复释放的 IPC 事件订阅，避免五轮挂载后残留 Renderer listener。 */
function subscribe(channel, metricKey, listener) {
  /** 将 Electron event 从公开回调参数中剥离。 */
  const wrapped = (_event, payload) => listener(payload)
  ipcRenderer.on(channel, wrapped)
  listenerMetrics[metricKey] += 1
  listenerMetrics.subscriptions += 1
  let released = false
  return () => {
    /** React 清理可能重复调用，计数和 removeListener 必须保持幂等。 */
    if (released) return
    released = true
    ipcRenderer.removeListener(channel, wrapped)
    listenerMetrics[metricKey] -= 1
    listenerMetrics.disposals += 1
  }
}

contextBridge.exposeInMainWorld('canvasQaBridge', {
  loadCanvas: (target) => ipcRenderer.invoke('qa:load-canvas', target),
  saveCanvas: (input) => ipcRenderer.invoke('qa:save-canvas', input),
  listCanvasImageActivity: (input) => ipcRenderer.invoke('qa:list-image-activity', input),
  listJobs: (projectId) => ipcRenderer.invoke('qa:list-jobs', projectId),
  setNodeCount: (nodeCount) => ipcRenderer.invoke('qa:set-node-count', nodeCount),
  pushActiveUpdates: () => ipcRenderer.invoke('qa:push-active-updates'),
  getMetrics: () => ipcRenderer.invoke('qa:get-metrics'),
  getListenerMetrics: () => ({
    ...listenerMetrics,
    total: listenerMetrics.canvasChanged + listenerMetrics.designChanged,
  }),
  onCanvasChanged: (listener) => subscribe('qa:canvas-changed', 'canvasChanged', listener),
  onDesignChanged: (listener) => subscribe('qa:design-changed', 'designChanged', listener),
})
