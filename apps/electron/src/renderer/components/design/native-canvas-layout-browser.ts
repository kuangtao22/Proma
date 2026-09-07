import elkWorkerUrl from 'elkjs/lib/elk-worker.min.js?url'
import {
  withNativeCanvasLayoutEngine,
} from './native-canvas-layout-client'
import type { NativeCanvasLayoutEngine } from './native-canvas-layout-client'

/** 在 Vite Renderer 中使用独立 module Worker 执行一次 Canvas 布局任务。 */
export function withBrowserNativeCanvasLayoutEngine<T>(
  run: (layout: NativeCanvasLayoutEngine) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  return withNativeCanvasLayoutEngine(run, {
    signal,
    workerFactory: () => new Worker(elkWorkerUrl, {
      type: 'module',
      name: 'proma-native-canvas-layout',
    }),
  })
}
