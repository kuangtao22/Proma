import React from 'react'
import ReactDOM from 'react-dom/client'
import { Provider, createStore } from 'jotai'
import type {
  CanvasChangeEvent,
  CanvasImageJobActivity,
  CanvasWorkspaceSnapshot,
  DesignChangeEvent,
  DesignJobRecord,
  ListCanvasImageActivityInput,
  SaveCanvasMutationsInput,
} from '@proma/shared'
import { NativeCanvasWorkspace } from '@/components/design/NativeCanvasWorkspace'
import type { NativeCanvasAdapter } from '@/components/design/NativeCanvasWorkspace'
import '@/styles/globals.css'

/** 隔离 preload 暴露的最小 Canvas fixture 合同。 */
interface CanvasQaBridge {
  loadCanvas: (target: { projectId: string; canvasId: string }) => Promise<CanvasWorkspaceSnapshot>
  saveCanvas: (input: SaveCanvasMutationsInput) => Promise<CanvasWorkspaceSnapshot['document']>
  listCanvasImageActivity: (input: ListCanvasImageActivityInput) => Promise<CanvasImageJobActivity[]>
  listJobs: (projectId: string) => Promise<DesignJobRecord[]>
  setNodeCount: (nodeCount: number) => Promise<number>
  pushActiveUpdates: () => Promise<number>
  getMetrics: () => Promise<Record<string, number>>
  getListenerMetrics: () => CanvasQaListenerMetrics
  onCanvasChanged: (listener: (event: CanvasChangeEvent) => void) => () => void
  onDesignChanged: (listener: (event: DesignChangeEvent) => void) => () => void
}

/** preload 内事件订阅的当前数量与累计释放次数。 */
interface CanvasQaListenerMetrics {
  canvasChanged: number
  designChanged: number
  total: number
  subscriptions: number
  disposals: number
}

/** Playwright 调用的页面控制面，负责挂载、主题切换和帧采样。 */
interface CanvasQaControl {
  mount: (nodeCount: number) => Promise<void>
  unmount: () => Promise<void>
  setTheme: (theme: 'light' | 'dark') => void
  pushActiveUpdates: () => Promise<number>
  startFrameProbe: () => void
  stopFrameProbe: () => { frameCount: number; p95Ms: number; stallsOver100Ms: number; maxMs: number }
  collectResourceSample: () => Promise<{
    heapBytes: number | null
    domNodes: number
    imageCount: number
    loadedImages: number
    minimumImageWidth: number
    minimumImageHeight: number
    listenerMetrics: CanvasQaListenerMetrics
  }>
  getFixtureMetrics: () => Promise<Record<string, number>>
}

declare global {
  interface Window {
    canvasQaBridge: CanvasQaBridge
    canvasQa: CanvasQaControl
    gc?: () => void
  }
}

/** QA 根节点在全部循环中复用，避免 createRoot 自身干扰资源回落。 */
const rootElement = document.getElementById('root')
if (!rootElement) throw new Error('缺少 QA root')
/** React 根实例在不同规模间只替换子树。 */
const root = ReactDOM.createRoot(rootElement)
/** 每轮挂载递增 key，确保 Workspace 完整执行释放与重建。 */
let mountGeneration = 0
/** 当前帧采样缓冲，只覆盖显式交互窗口。 */
let frameDeltas: number[] = []
/** 当前帧采样回调 ID，停止后必须取消。 */
let frameRequestId: number | null = null
/** 上一帧时间戳用于计算真实合成间隔。 */
let previousFrameTime: number | null = null

/** 真实 Workspace 通过隔离 preload 调用专用 IPC fixture。 */
const adapter: NativeCanvasAdapter = {
  loadCanvas: (target) => window.canvasQaBridge.loadCanvas(target),
  saveCanvas: (input) => window.canvasQaBridge.saveCanvas(input),
  onCanvasChanged: (_target, listener) => window.canvasQaBridge.onCanvasChanged(listener),
  listCanvasImageActivity: (input) => window.canvasQaBridge.listCanvasImageActivity(input),
  listJobs: (projectId) => window.canvasQaBridge.listJobs(projectId),
  onChanged: (listener) => window.canvasQaBridge.onDesignChanged(listener),
}

/** 等待两帧，保证 React commit、XYFlow 测量和图片布局已进入浏览器渲染流水线。 */
async function waitForPaint(): Promise<void> {
  await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
}

/** 按百分位读取已排序样本，没有样本时返回 0。 */
function percentile(sortedValues: readonly number[], ratio: number): number {
  if (sortedValues.length === 0) return 0
  return sortedValues[Math.min(sortedValues.length - 1, Math.ceil(sortedValues.length * ratio) - 1)] ?? 0
}

window.canvasQa = {
  mount: async (nodeCount) => {
    /** 先完成旧 Workspace cleanup，避免模块级 controller registry 跨 store 复用旧 lease。 */
    root.render(null)
    await waitForPaint()
    await window.canvasQaBridge.setNodeCount(nodeCount)
    mountGeneration += 1
    /** 每轮使用独立 Jotai store，检测 Workspace 释放后的真实资源回落。 */
    const store = createStore()
    root.render(
      <Provider store={store}>
        <NativeCanvasWorkspace
          key={mountGeneration}
          sessionId={`canvas-qa-session-${mountGeneration}`}
          target={{ projectId: 'canvas-qa-project', canvasId: 'canvas-qa-canvas' }}
          title={`Canvas Completion QA · ${nodeCount} nodes`}
          adapter={adapter}
        />
      </Provider>,
    )
    await waitForPaint()
  },
  unmount: async () => {
    root.render(null)
    await waitForPaint()
  },
  setTheme: (theme) => {
    document.documentElement.className = theme === 'dark' ? 'dark theme-slate-dark' : 'theme-slate-light'
    document.documentElement.style.colorScheme = theme
  },
  pushActiveUpdates: () => window.canvasQaBridge.pushActiveUpdates(),
  startFrameProbe: () => {
    frameDeltas = []
    previousFrameTime = null
    if (frameRequestId !== null) cancelAnimationFrame(frameRequestId)
    /** 每帧记录相邻 RAF 的实际间隔。 */
    const sample = (timestamp: number): void => {
      if (previousFrameTime !== null) frameDeltas.push(timestamp - previousFrameTime)
      previousFrameTime = timestamp
      frameRequestId = requestAnimationFrame(sample)
    }
    frameRequestId = requestAnimationFrame(sample)
  },
  stopFrameProbe: () => {
    if (frameRequestId !== null) cancelAnimationFrame(frameRequestId)
    frameRequestId = null
    /** 排序副本用于稳定计算 p95，同时保留原始 stall 计数。 */
    const sorted = [...frameDeltas].sort((left, right) => left - right)
    return {
      frameCount: frameDeltas.length,
      p95Ms: percentile(sorted, 0.95),
      stallsOver100Ms: frameDeltas.filter((delta) => delta > 100).length,
      maxMs: sorted.at(-1) ?? 0,
    }
  },
  collectResourceSample: async () => {
    window.gc?.()
    await waitForPaint()
    /** performance.memory 仅在 Chromium 提供时读取，缺失时以 null 明示。 */
    const memory = performance as Performance & { memory?: { usedJSHeapSize: number } }
    const images = [...document.images]
    /** 已解码图片的最小自然尺寸证明浏览器消费的不是占位像素。 */
    const loadedImages = images.filter((image) => image.complete && image.naturalWidth > 0)
    return {
      heapBytes: memory.memory?.usedJSHeapSize ?? null,
      domNodes: document.getElementsByTagName('*').length,
      imageCount: images.length,
      loadedImages: loadedImages.length,
      minimumImageWidth: loadedImages.length > 0
        ? Math.min(...loadedImages.map((image) => image.naturalWidth))
        : 0,
      minimumImageHeight: loadedImages.length > 0
        ? Math.min(...loadedImages.map((image) => image.naturalHeight))
        : 0,
      listenerMetrics: window.canvasQaBridge.getListenerMetrics(),
    }
  },
  getFixtureMetrics: () => window.canvasQaBridge.getMetrics(),
}

window.canvasQa.setTheme('light')
document.body.style.margin = '0'
document.body.style.width = '100vw'
document.body.style.height = '100vh'
rootElement.style.width = '100%'
rootElement.style.height = '100%'
document.body.dataset.qaReady = 'true'
