import { describe, expect, test } from 'bun:test'
import { createEmptyCanvasDocument } from '@proma/shared'
import type { CanvasLayoutRect, CanvasMutation, DesignViewport } from '@proma/shared'
import * as React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import {
  NativeCanvasGraph,
  createNativeCanvasTransientGeometryStore,
} from './NativeCanvasGraph'
import type {
  NativeCanvasFlowProps,
  NativeCanvasTransientGeometryStore,
} from './NativeCanvasGraph'

interface MinimalEventTarget {
  addEventListener: () => void
  removeEventListener: () => void
}

interface MinimalNode extends MinimalEventTarget {
  nodeType: number
  nodeName: string
  tagName?: string
  namespaceURI?: string
  ownerDocument: MinimalDocument
  parentNode: MinimalNode | null
  childNodes: MinimalNode[]
  style: Record<string, string>
  appendChild: (child: MinimalNode) => MinimalNode
  insertBefore: (child: MinimalNode, before: MinimalNode | null) => MinimalNode
  removeChild: (child: MinimalNode) => MinimalNode
  setAttribute: (name: string, value: string) => void
  removeAttribute: (name: string) => void
}

interface MinimalDocument extends MinimalEventTarget {
  nodeType: 9
  defaultView: MinimalWindow
  activeElement: null
  body: MinimalNode | null
  documentElement: { namespaceURI: string }
  createElement: (tagName: string) => MinimalNode
  createElementNS: (_namespace: string, tagName: string) => MinimalNode
  createTextNode: (text: string) => MinimalNode
}

interface MinimalWindow extends MinimalEventTarget {
  event: undefined
  HTMLIFrameElement: new () => object
}

/** 创建足够挂载单个 div 的最小 DOM 节点，不引入浏览器测试依赖。 */
function createMinimalNode(
  document: MinimalDocument,
  nodeType: number,
  nodeName: string,
): MinimalNode {
  const attributes = new Map<string, string>()
  const node: MinimalNode = {
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    nodeType,
    nodeName,
    tagName: nodeType === 1 ? nodeName : undefined,
    namespaceURI: 'http://www.w3.org/1999/xhtml',
    ownerDocument: document,
    parentNode: null,
    childNodes: [],
    style: {},
    appendChild: (child) => {
      child.parentNode = node
      node.childNodes.push(child)
      return child
    },
    insertBefore: (child, before) => {
      child.parentNode = node
      const index = before ? node.childNodes.indexOf(before) : -1
      if (index < 0) node.childNodes.push(child)
      else node.childNodes.splice(index, 0, child)
      return child
    },
    removeChild: (child) => {
      const index = node.childNodes.indexOf(child)
      if (index >= 0) node.childNodes.splice(index, 1)
      child.parentNode = null
      return child
    },
    setAttribute: (name, value) => { attributes.set(name, value) },
    removeAttribute: (name) => { attributes.delete(name) },
  }
  return node
}

/** 创建可渲染 NativeCanvasGraph 的 React 根，并在测试后恢复全局 DOM。 */
function createGraphRoot(): {
  render: (node: React.ReactElement) => void
  unmount: () => void
  restore: () => void
  /** 读取轻量位置壳的真实 DOM 样式，不依赖详情重渲染次数推断移动。 */
  workbenchTransform: () => string | undefined
} {
  const eventTarget: MinimalEventTarget = {
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }
  class FakeHtmlIFrameElement {}
  const fakeWindow: MinimalWindow = {
    ...eventTarget,
    event: undefined,
    HTMLIFrameElement: FakeHtmlIFrameElement,
  }
  const fakeDocument = {
    ...eventTarget,
    nodeType: 9 as const,
    defaultView: fakeWindow,
    activeElement: null,
    body: null,
    documentElement: { namespaceURI: 'http://www.w3.org/1999/xhtml' },
  } as MinimalDocument
  fakeDocument.createElement = (tagName) => createMinimalNode(fakeDocument, 1, tagName.toUpperCase())
  fakeDocument.createElementNS = (_namespace, tagName) => createMinimalNode(fakeDocument, 1, tagName.toUpperCase())
  fakeDocument.createTextNode = () => createMinimalNode(fakeDocument, 3, '#text')
  const container = createMinimalNode(fakeDocument, 1, 'DIV')
  const globals = globalThis as unknown as {
    window?: unknown
    document?: unknown
    IS_REACT_ACT_ENVIRONMENT?: boolean
  }
  const previousWindow = globals.window
  const previousDocument = globals.document
  const previousActEnvironment = globals.IS_REACT_ACT_ENVIRONMENT
  globals.window = fakeWindow
  globals.document = fakeDocument
  globals.IS_REACT_ACT_ENVIRONMENT = true
  const root = createRoot(container as unknown as Element)
  return {
    workbenchTransform: () => container.childNodes[0]?.childNodes[0]?.style.transform,
    render: (node) => { root.render(node) },
    unmount: () => { root.unmount() },
    restore: () => {
      globals.window = previousWindow
      globals.document = previousDocument
      globals.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
    },
  }
}

/** 包装瞬时几何 Store，记录 React 工作台订阅是否按挂载生命周期释放。 */
function observeGeometrySubscriptions(
  store: NativeCanvasTransientGeometryStore,
): NativeCanvasTransientGeometryStore & { getActiveSubscriberCount: () => number } {
  let activeSubscriberCount = 0
  return {
    ...store,
    subscribe: (listener) => {
      activeSubscriberCount += 1
      const unsubscribe = store.subscribe(listener)
      return () => {
        activeSubscriberCount -= 1
        unsubscribe()
      }
    },
    getActiveSubscriberCount: () => activeSubscriberCount,
  }
}

/** 创建测试 Graph 的稳定公共属性，避免父级回调身份干扰重渲染计数。 */
function createGraphProps(
  geometryStore: NativeCanvasTransientGeometryStore,
  onMutation: (mutation: CanvasMutation) => void,
  flowRenderer: (props: NativeCanvasFlowProps) => React.ReactNode,
) {
  return {
    writable: true,
    selectedNodeId: null,
    transientGeometryStore: geometryStore,
    onMutation,
    onNodeSelect: () => undefined,
    onConversationNodeChange: () => undefined,
    flowRenderer,
  }
}

describe('原生 Canvas 缩放挂载回归', () => {
  test('Given 未展开工作台 When 瞬时 viewport 更新 Then Graph 不重渲染且没有残留订阅', () => {
    const document = createEmptyCanvasDocument('project-1', 'canvas-1', 1)
    const geometryStore = observeGeometrySubscriptions(createNativeCanvasTransientGeometryStore(document))
    let graphRenderCount = 0
    const graphProps = createGraphProps(geometryStore, () => undefined, () => {
      graphRenderCount += 1
      return null
    })
    const host = createGraphRoot()

    try {
      act(() => { host.render(<NativeCanvasGraph document={document} {...graphProps} />) })
      const mountedRenderCount = graphRenderCount

      act(() => { geometryStore.updateViewport({ x: 80, y: 60, zoom: 1.8 }) })

      expect(graphRenderCount).toBe(mountedRenderCount)
      expect(geometryStore.getActiveSubscriberCount()).toBe(0)
    } finally {
      act(() => { host.unmount() })
      host.restore()
    }
  })

  test('Given 下挂工作台 When 平移缩放或拖动卡片 Then 仅位置壳移动且正文不重渲染', () => {
    const document = createEmptyCanvasDocument('project-1', 'canvas-1', 1)
    document.nodes = [{
      id: 'agent-1', kind: 'agent', title: 'Agent',
      agentSessionId: 'session-1', position: { x: 10, y: 20 },
    }]
    const geometryStore = observeGeometrySubscriptions(createNativeCanvasTransientGeometryStore(document))
    let graphRenderCount = 0
    let workbenchRenderCount = 0
    /** 独立正文组件计数，证明没有通过父壳渲染间接刷新重内容。 */
    let contentRenderCount = 0
    /** 模拟详情保存所依赖的最新画布版本，缓存不能阻断业务更新。 */
    let renderedRevision = document.revision
    function DetailContent({ revision = document.revision }: { revision?: number }): null {
      contentRenderCount += 1
      renderedRevision = revision
      return null
    }
    /** 记录世界矩形，验证瞬时卡片移动不被 viewport 重复投影。 */
    let lastWorkbenchBounds: CanvasLayoutRect | undefined
    const graphProps = createGraphProps(geometryStore, () => undefined, () => {
      graphRenderCount += 1
      return null
    })
    const renderWorkbench = (_node: typeof document.nodes[number], rect: CanvasLayoutRect) => {
      workbenchRenderCount += 1
      lastWorkbenchBounds = rect
      return <DetailContent />
    }
    const host = createGraphRoot()

    try {
      act(() => {
        host.render(
          <NativeCanvasGraph
            document={document}
            {...graphProps}
            workbenchNode={document.nodes[0]}
            renderWorkbench={renderWorkbench}
          />,
        )
      })
      const mountedGraphRenderCount = graphRenderCount
      const mountedWorkbenchRenderCount = workbenchRenderCount
      const mountedContentRenderCount = contentRenderCount
      expect(geometryStore.getActiveSubscriberCount()).toBe(1)

      act(() => { geometryStore.updateViewport({ x: 100, y: 200, zoom: 2 }) })

      expect(graphRenderCount).toBe(mountedGraphRenderCount)
      expect(workbenchRenderCount).toBe(mountedWorkbenchRenderCount)
      expect(lastWorkbenchBounds).toMatchObject({ x: 10, y: 20 })

      act(() => { geometryStore.updateNodePositions([{ nodeId: 'other', position: { x: 800, y: 900 } }]) })
      expect(workbenchRenderCount).toBe(mountedWorkbenchRenderCount)

      act(() => { geometryStore.updateNodePositions([{ nodeId: 'agent-1', position: { x: -40, y: 70 } }]) })
      expect(graphRenderCount).toBe(mountedGraphRenderCount)
      expect(workbenchRenderCount).toBe(mountedWorkbenchRenderCount)
      expect(contentRenderCount).toBe(mountedContentRenderCount)
      expect(lastWorkbenchBounds).toMatchObject({ x: 10, y: 20 })
      expect(host.workbenchTransform()).toBe('translate(-50px, 50px)')

      /** 其他节点提交新 revision 后，Workspace 更新的正文回调应立即被采用。 */
      const nextDocument = { ...document, revision: document.revision + 1 }
      act(() => {
        host.render(<NativeCanvasGraph document={nextDocument} {...graphProps}
          workbenchNode={document.nodes[0]}
          renderWorkbench={() => <DetailContent revision={nextDocument.revision} />}
        />)
      })
      expect(renderedRevision).toBe(nextDocument.revision)
      expect(contentRenderCount).toBe(mountedContentRenderCount + 1)

      act(() => { host.render(<NativeCanvasGraph document={document} {...graphProps} />) })
      expect(geometryStore.getActiveSubscriberCount()).toBe(0)
      const closedWorkbenchRenderCount = workbenchRenderCount

      act(() => { geometryStore.updateViewport({ x: 200, y: 300, zoom: 3 }) })
      expect(workbenchRenderCount).toBe(closedWorkbenchRenderCount)
    } finally {
      act(() => { host.unmount() })
      host.restore()
    }
  })

  test('Given 图片卡片比例变化 When 预览尺寸更新 Then 详情使用同一投影高度而非默认卡片高度', () => {
    /** 模拟图片成功后按素材比例显示的卡片。 */
    const document = createEmptyCanvasDocument('project-1', 'canvas-1', 1)
    document.nodes = [{
      id: 'image-1', kind: 'image', title: '图片', imageModuleId: 'module-1',
      adoptedAssetId: 'asset-1', position: { x: 20, y: 30 },
    }]
    const geometryStore = createNativeCanvasTransientGeometryStore(document)
    const graphProps = createGraphProps(geometryStore, () => undefined, () => null)
    /** 记录详情入口实际拿到的宽高，避免测试只覆盖 Overlay 的传入参数。 */
    let bounds: CanvasLayoutRect | undefined
    const renderWorkbench = (_node: typeof document.nodes[number], rect: CanvasLayoutRect) => {
      bounds = rect
      return null
    }
    const host = createGraphRoot()
    try {
      for (const [width, height, expectedHeight] of [[1200, 800, 240], [400, 1200, 368]] as const) {
        act(() => {
          host.render(<NativeCanvasGraph document={document} {...graphProps}
            workbenchNode={document.nodes[0]} renderWorkbench={renderWorkbench}
            imagePreviews={new Map([['asset-1', { assetId: 'asset-1', previewUrl: 'preview.png', width, height }]])}
          />)
        })
        expect(bounds).toEqual({ id: 'image-1', x: 20, y: 30, width: 288, height: expectedHeight })
      }
    } finally {
      act(() => { host.unmount() })
      host.restore()
    }
  })

  test('Given 受控 viewport 手势 When 移动与结束 Then 逐帧更新但只在结束提交一次', () => {
    const document = createEmptyCanvasDocument('project-1', 'canvas-1', 1)
    const geometryStore = createNativeCanvasTransientGeometryStore(document)
    const mutations: CanvasMutation[] = []
    let captured: NativeCanvasFlowProps | undefined
    const graphProps = createGraphProps(
      geometryStore,
      (mutation) => mutations.push(mutation),
      (props) => { captured = props; return null },
    )
    const host = createGraphRoot()

    try {
      act(() => { host.render(<NativeCanvasGraph document={document} {...graphProps} />) })
      const movingViewport: DesignViewport = { x: 30, y: 40, zoom: 1.4 }
      const finalViewport: DesignViewport = { x: 50, y: 60, zoom: 1.6 }

      act(() => { captured!.onMoveStart?.({} as never, movingViewport) })
      act(() => { captured!.onMove?.({} as never, movingViewport) })
      expect(captured?.viewport).toEqual(movingViewport)
      expect(geometryStore.getSnapshot().viewport).toEqual(movingViewport)
      expect(mutations).toEqual([])

      act(() => { captured!.onMoveEnd?.({} as never, finalViewport) })
      expect(captured?.viewport).toEqual(finalViewport)
      expect(mutations).toEqual([{ type: 'set-viewport', viewport: finalViewport }])
    } finally {
      act(() => { host.unmount() })
      host.restore()
    }
  })

  test('Given 手势中收到权威 viewport When 本地手势结束 Then defer 接管且不回写陈旧值', () => {
    const document = createEmptyCanvasDocument('project-1', 'canvas-1', 1)
    const geometryStore = createNativeCanvasTransientGeometryStore(document)
    const mutations: CanvasMutation[] = []
    let captured: NativeCanvasFlowProps | undefined
    const graphProps = createGraphProps(
      geometryStore,
      (mutation) => mutations.push(mutation),
      (props) => { captured = props; return null },
    )
    const host = createGraphRoot()

    try {
      act(() => { host.render(<NativeCanvasGraph document={document} {...graphProps} />) })
      const localViewport: DesignViewport = { x: 10, y: 20, zoom: 1.5 }
      const authoritativeViewport: DesignViewport = { x: 90, y: 80, zoom: 0.8 }

      act(() => { captured!.onMoveStart?.({} as never, localViewport) })
      act(() => { captured!.onMove?.({} as never, localViewport) })
      act(() => {
        host.render(
          <NativeCanvasGraph
            document={{ ...document, revision: document.revision + 1, viewport: authoritativeViewport }}
            {...graphProps}
          />,
        )
      })
      expect(captured?.viewport).toEqual(localViewport)

      act(() => { captured!.onMoveEnd?.({} as never, localViewport) })

      expect(captured?.viewport).toEqual(authoritativeViewport)
      expect(geometryStore.getSnapshot().viewport).toEqual(authoritativeViewport)
      expect(mutations).toEqual([])
    } finally {
      act(() => { host.unmount() })
      host.restore()
    }
  })
})
