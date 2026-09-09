import '@fontsource-variable/inter/index.css'
import * as React from 'react'
import type { CanvasNode, DesignViewport } from '@proma/shared'
import { Provider, atom, useAtom } from 'jotai'
import { createRoot } from 'react-dom/client'
import { ReactFlow, ViewportPortal } from '@xyflow/react'
import existingPreviewUrl from '../src/renderer/assets/onboarding/hopper-seaside-white-house.png'
import {
  createAgentCanvasWorkbenchGeometryUpdate,
  createInitialAgentCanvasViewState,
  resolveAgentCanvasWorkbenchSize,
  type AgentCanvasViewState,
  type AgentCanvasWorkbenchSize,
} from '../src/renderer/atoms/agent-canvas-atoms'
import { CanvasNodeWorkbenchOverlay } from '../src/renderer/components/design/CanvasNodeWorkbenchOverlay'
import '../src/renderer/styles/globals.css'

/** 隔离验证使用的主视频节点。 */
const videoNode: CanvasNode = {
  id: 'workbench-video', kind: 'video', title: 'MiniMax Ref｜单镜头试片',
  position: { x: 20, y: 20 }, mediaModuleId: 'workbench-video-content',
}
/** 另一节点只用于证明恢复默认尺寸不会覆盖相邻缓存。 */
const siblingNodeId = 'workbench-image'
/** 卡片世界矩形保持稳定，工作台固定挂在它下方。 */
const nodeBounds = { x: 20, y: 20, width: 180, height: 100 }
/** 页面初始视图模拟用户截图中的低缩放。 */
const initialViewport: DesignViewport = { x: 0, y: 0, zoom: 0.15 }

/** 重新创建完整视图，场景切换仍走生产初始化函数。 */
function createViewState(
  viewport: DesignViewport,
  sizes: Record<string, AgentCanvasWorkbenchSize> = {},
): AgentCanvasViewState {
  return {
    ...createInitialAgentCanvasViewState(viewport),
    expandedNodeId: videoNode.id,
    workbenchSizesByNodeId: structuredClone(sizes),
  }
}

/** fixture 的唯一 Jotai 事实源。 */
const viewStateAtom = atom<AgentCanvasViewState>(createViewState(initialViewport))

/** Electron 断言与页面交互之间的窄接口。 */
interface WorkbenchSizeSmokeApi {
  childMounts: number
  resetScenario: (input: {
    viewport: DesignViewport
    surface: AgentCanvasWorkbenchSize
    sizes?: Record<string, AgentCanvasWorkbenchSize>
  }) => void
  setZoom: (zoom: number) => void
  setSurface: (surface: AgentCanvasWorkbenchSize) => void
  close: () => void
  open: () => void
  getState: () => AgentCanvasViewState
}

declare global {
  interface Window { __canvasWorkbenchSizeSmoke: WorkbenchSizeSmokeApi }
}

/** 正文挂载计数用于确认恢复尺寸不会重建媒体工作台。 */
function WorkbenchBody(): React.ReactElement {
  React.useEffect(() => {
    window.__canvasWorkbenchSizeSmoke.childMounts += 1
  }, [])
  return <div data-smoke-body className="flex h-full min-h-0 flex-col gap-3 overflow-hidden p-4 text-sm">
    <div className="min-h-0 flex-1 overflow-hidden rounded border border-border bg-muted">
      <img className="h-full w-full object-cover" src={existingPreviewUrl} alt="视频工作台测试预览" />
    </div>
    <label className="shrink-0">工作流参数
      <input data-smoke-draft className="ml-2 border border-border bg-background px-2 py-1" defaultValue="初始参数" />
    </label>
    <p className="shrink-0">正文随外壳使用同一个画布缩放。</p>
  </div>
}

/** 真实挂载 ReactFlow ViewportPortal、Overlay 和 Jotai 会话几何链路。 */
function Fixture(): React.ReactElement {
  const [viewState, setViewState] = useAtom(viewStateAtom)
  const [surface, setSurface] = React.useState<AgentCanvasWorkbenchSize>({ width: 1_200, height: 800 })
  const [scenarioRevision, setScenarioRevision] = React.useState(0)
  const viewStateRef = React.useRef(viewState)
  viewStateRef.current = viewState
  const size = resolveAgentCanvasWorkbenchSize(viewState, videoNode.id)

  /** 所有尺寸提交使用生产更新函数，确保按节点隔离和空间标记参与验证。 */
  const updateSize = React.useCallback((nextSize: AgentCanvasWorkbenchSize): void => {
    setViewState((current) => ({
      ...current,
      ...createAgentCanvasWorkbenchGeometryUpdate(current, videoNode.id, { size: nextSize }),
    }))
  }, [setViewState])

  window.__canvasWorkbenchSizeSmoke.resetScenario = (input) => {
    setSurface({ ...input.surface })
    setViewState(createViewState(input.viewport, input.sizes))
    setScenarioRevision((revision) => revision + 1)
  }
  window.__canvasWorkbenchSizeSmoke.setZoom = (zoom) => {
    setViewState((current) => ({ ...current, viewport: { ...current.viewport, zoom } }))
  }
  window.__canvasWorkbenchSizeSmoke.setSurface = (nextSurface) => setSurface({ ...nextSurface })
  window.__canvasWorkbenchSizeSmoke.close = () => setViewState((current) => ({ ...current, expandedNodeId: null }))
  window.__canvasWorkbenchSizeSmoke.open = () => setViewState((current) => ({ ...current, expandedNodeId: videoNode.id }))
  window.__canvasWorkbenchSizeSmoke.getState = () => viewStateRef.current

  return <main className="design-canvas h-screen overflow-hidden bg-muted p-4 text-foreground">
    <div className="mb-3 flex h-8 items-center justify-between text-sm">
      <strong>Canvas 工作台尺寸隔离验证</strong>
      <span data-smoke-readout>{viewState.viewport.zoom.toFixed(2)} / {size ? `${Math.round(size.width)}×${Math.round(size.height)}` : '初始化中'}</span>
    </div>
    <section data-smoke-surface className="overflow-hidden border border-border bg-background shadow-sm" style={{ width: surface.width, height: surface.height }}>
      <ReactFlow
        nodes={[]}
        edges={[]}
        viewport={viewState.viewport}
        minZoom={0.05}
        maxZoom={4}
        panOnDrag={false}
        zoomOnScroll={false}
        zoomOnPinch={false}
        zoomOnDoubleClick={false}
        nodesDraggable={false}
        elementsSelectable={false}
        proOptions={{ hideAttribution: true }}
      >
        {viewState.expandedNodeId === videoNode.id ? <ViewportPortal>
          <CanvasNodeWorkbenchOverlay
            key={scenarioRevision}
            node={videoNode}
            nodeBounds={nodeBounds}
            viewport={viewState.viewport}
            surfaceSize={surface}
            size={size}
            dirty
            onSizeChange={updateSize}
            onDirtyChange={() => undefined}
            onClose={() => setViewState((current) => ({ ...current, expandedNodeId: null }))}
          >
            <WorkbenchBody />
          </CanvasNodeWorkbenchOverlay>
        </ViewportPortal> : null}
      </ReactFlow>
    </section>
  </main>
}

window.__canvasWorkbenchSizeSmoke = {
  childMounts: 0,
  resetScenario: () => undefined,
  setZoom: () => undefined,
  setSurface: () => undefined,
  close: () => undefined,
  open: () => undefined,
  getState: () => createViewState(initialViewport, { [siblingNodeId]: { width: 700, height: 500 } }),
}

createRoot(document.getElementById('root')!).render(<Provider><Fixture /></Provider>)
