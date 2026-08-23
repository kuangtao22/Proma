import { describe, expect, test } from 'bun:test'
import { createEmptyDesignDocument } from '@proma/shared'
import type { NodeProps } from '@xyflow/react'
import { createStore, Provider } from 'jotai'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  createInitialDesignProjectState,
  designProjectStatesAtom,
  updateDesignProjectStateAtom,
} from '@/atoms/design-atoms'
import { TooltipProvider } from '@/components/ui/tooltip'
import {
  DesignAssetNode,
  type DesignAssetFlowNode,
  type DesignAssetNodeData,
} from './DesignAssetNode'
import { DesignToolbar } from './DesignToolbar'
import { DesignWorkspaceStateView } from './DesignWorkspaceView'
import {
  DesignCanvas,
  type DesignCanvasFlowProps,
} from './DesignCanvas'

/** 创建 XYFlow 自定义节点静态渲染所需的完整属性。 */
function createNodeProps(data: DesignAssetNodeData): NodeProps<DesignAssetFlowNode> {
  return {
    id: 'node-1',
    type: 'designAsset',
    data,
    width: 320,
    height: 240,
    dragging: false,
    zIndex: 1,
    selectable: true,
    deletable: false,
    selected: false,
    draggable: true,
    isConnectable: false,
    positionAbsoluteX: 0,
    positionAbsoluteY: 0,
  }
}

/** 静态渲染一种节点状态，便于验证无浏览器环境下的稳定 HTML。 */
function renderStatus(data: DesignAssetNodeData): string {
  return renderToStaticMarkup(<DesignAssetNode {...createNodeProps(data)} />)
}

/** 将 renderer 回调捕获值收窄为可调用 Flow 属性。 */
function requireFlowProps(value: DesignCanvasFlowProps | null): DesignCanvasFlowProps {
  if (!value) throw new Error('DesignCanvas 未调用可观察 Flow renderer')
  return value
}

describe('Design 素材节点', () => {
  test('Given 已完成素材 When 渲染 Then 使用固定尺寸且图片不可原生拖拽', () => {
    const html = renderStatus({
      kind: 'asset',
      status: 'success',
      assetId: 'asset-1',
      title: '海报.png',
      pixelWidth: 1600,
      pixelHeight: 1200,
      previewUrl: 'proma-file://thumbs/poster.webp',
    })

    expect(html).toContain('style="width:320px;height:240px"')
    expect(html).toContain('src="proma-file://thumbs/poster.webp"')
    expect(html).toContain('alt="海报.png"')
    expect(html).toContain('draggable="false"')
    expect(html).toContain('已完成')
    expect(html).not.toContain('重试生成')
  })

  test('Given 排队和运行任务 When 渲染 Then 显示明确进度状态且不提供重试', () => {
    const queued = renderStatus({
      kind: 'job', status: 'queued', projectId: 'project-1', jobId: 'job-1', title: '图片任务',
      writable: true, authoritativeRecoveryState: 'idle',
    })
    const running = renderStatus({
      kind: 'job', status: 'running', projectId: 'project-1', jobId: 'job-2', title: '图片任务',
      writable: true, authoritativeRecoveryState: 'idle',
    })

    expect(queued).toContain('等待生成')
    expect(running).toContain('正在生成')
    expect(queued).not.toContain('重试生成')
    expect(running).not.toContain('重试生成')
    expect(queued).toMatch(/type="button"(?![^>]*disabled)[^>]*>[\s\S]*取消生成/)
    expect(running).toMatch(/type="button"(?![^>]*disabled)[^>]*>[\s\S]*取消生成/)
  })

  test('Given 失败、取消或中断任务 When 渲染 Then 这些终态提供重试入口', () => {
    const failed = renderStatus({
      kind: 'job',
      status: 'failed',
      jobId: 'job-1',
      title: '图片任务',
      error: '模型返回失败',
    })
    const cancelled = renderStatus({ kind: 'job', status: 'cancelled', jobId: 'job-2', title: '图片任务' })
    const interrupted = renderStatus({
      kind: 'job',
      status: 'interrupted',
      projectId: 'project-1',
      jobId: 'job-3',
      title: '图片任务',
      writable: true,
      authoritativeRecoveryState: 'idle',
    })

    expect(failed).toContain('生成失败')
    expect(failed).toContain('模型返回失败')
    expect(failed).toContain('重试生成')
    expect(cancelled).toContain('已取消')
    expect(cancelled).toContain('重试生成')
    expect(interrupted).toContain('已中断')
    expect(interrupted).toContain('重试生成')
    expect(interrupted).toMatch(/type="button"(?![^>]*disabled)[^>]*>[\s\S]*重试生成/)
  })

  test('Given 任务节点只读或权威恢复未完成 When 渲染 Then 重试和取消命令保持禁用', () => {
    const readOnlyRetry = renderStatus({
      kind: 'job', status: 'failed', projectId: 'project-1', jobId: 'job-1', title: '图片任务',
      writable: false, authoritativeRecoveryState: 'idle',
    })
    const loadingCancel = renderStatus({
      kind: 'job', status: 'running', projectId: 'project-1', jobId: 'job-2', title: '图片任务',
      writable: true, authoritativeRecoveryState: 'loading',
    })
    const failedRetry = renderStatus({
      kind: 'job', status: 'interrupted', projectId: 'project-1', jobId: 'job-3', title: '图片任务',
      writable: true, authoritativeRecoveryState: 'failed',
    })

    expect(readOnlyRetry).toMatch(/type="button"[^>]*disabled=""[^>]*>[\s\S]*重试生成/)
    expect(loadingCancel).toMatch(/type="button"[^>]*disabled=""[^>]*>[\s\S]*取消生成/)
    expect(failedRetry).toMatch(/type="button"[^>]*disabled=""[^>]*>[\s\S]*重试生成/)
  })

  test('Given 素材记录缺失 When 渲染 Then 明确提示素材缺失且不提供任务重试', () => {
    const html = renderStatus({
      kind: 'asset',
      status: 'missing',
      assetId: 'asset-1',
      title: '素材缺失',
    })

    expect(html).toContain('素材缺失')
    expect(html).not.toContain('<img')
    expect(html).not.toContain('重试生成')
  })
})

describe('Design 画布工具栏', () => {
  test('Given 可写画布 When 渲染 Then 提供选择平移分段模式和全部图标命令', () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <DesignToolbar
          activeTool="select"
          writable
          canUndo
          canRedo
          onToolChange={() => undefined}
          onUndo={() => undefined}
          onRedo={() => undefined}
          onGroup={() => undefined}
          onUngroup={() => undefined}
          onImportAssets={() => undefined}
        />
      </TooltipProvider>,
    )

    for (const label of ['选择', '平移', '撤销', '重做', '分组', '取消分组', '箭头批注', '画笔蒙版', '导入图片']) {
      expect(html).toContain(`aria-label="${label}"`)
    }
    expect(html).toContain('aria-pressed="true"')
    expect(html).toContain('role="group"')
  })

  test('Given 只读画布 When 渲染 Then 保留导航模式但禁用全部写命令', () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <DesignToolbar
          activeTool="pan"
          writable={false}
          canUndo
          canRedo
          onToolChange={() => undefined}
          onUndo={() => undefined}
          onRedo={() => undefined}
          onGroup={() => undefined}
          onUngroup={() => undefined}
          onImportAssets={() => undefined}
        />
      </TooltipProvider>,
    )

    expect(html).toMatch(/aria-label="选择"[^>]*aria-pressed="false"/)
    expect(html).toMatch(/aria-label="平移"[^>]*aria-pressed="true"/)
    for (const label of ['撤销', '重做', '分组', '取消分组', '箭头批注', '画笔蒙版', '导入图片']) {
      expect(html).toMatch(new RegExp(`aria-label="${label}"[^>]*disabled=""`))
    }
  })
})

describe('Design 工作区画布接入', () => {
  test('Given 可写空项目 When 渲染工作区 Then 同时保留工具栏、画布和两个空画布入口', () => {
    /** 空项目快照用于验证首屏工作流不会被 XYFlow 接入替换。 */
    const document = createEmptyDesignDocument('project-1', 100)
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <DesignWorkspaceStateView
          state={{
            ...createInitialDesignProjectState(),
            phase: 'ready',
            snapshot: { document, writable: true, thumbnailBaseUrl: 'proma-file://thumbs' },
          }}
          onRetry={() => undefined}
          onRetrySave={() => undefined}
          onImportAssets={() => undefined}
          onCreateJob={() => undefined}
        />
      </TooltipProvider>,
    )

    expect(html).toContain('aria-label="画布模式"')
    expect(html).toContain('aria-label="设计画布"')
    expect(html).toContain('导入图片')
    expect(html).toContain('AI 生成')
  })

  test('Given prop 滞后但项目 atom 选区相同 When XYFlow 回报选区 Then 不重复写项目 atom', () => {
    /** 记录组件传给可观察 Flow renderer 的真实回调。 */
    let flowProps: DesignCanvasFlowProps | null = null
    /** 使用独立 Jotai store 观察是否发生冗余 Map 写入。 */
    const store = createStore()
    const document = createDocumentWithNode('project-a', 'node-a')
    store.set(designProjectStatesAtom, new Map([[
      'project-a',
      {
        ...createInitialDesignProjectState(),
        phase: 'ready',
        snapshot: { document, writable: true },
        selectedNodeIds: ['node-a'],
      },
    ]]))
    /** atom 订阅写次数，用于区分内容相同的空操作。 */
    let writes = 0
    const unsubscribe = store.sub(designProjectStatesAtom, () => { writes += 1 })

    renderToStaticMarkup(
      <Provider store={store}>
        <DesignCanvas
          document={document}
          writable
          authoritativeRecoveryState="idle"
          activeTool="select"
          selectedNodeIds={[]}
          flowRenderer={(props) => {
            flowProps = props
            return <div data-flow-observer />
          }}
        />
      </Provider>,
    )
    expect(flowProps).not.toBeNull()
    /** 已确认 renderer 被调用后的稳定 Flow 属性。 */
    const capturedFlowProps = requireFlowProps(flowProps)
    capturedFlowProps.onSelectionChange({
      nodes: [capturedFlowProps.nodes[0]!],
      edges: [],
    })

    expect(writes).toBe(0)
    unsubscribe()
  })

  test('Given 已切换到项目 B When 项目 A 的旧回调迟到 Then 不污染项目 B 选区', () => {
    /** 分别捕获两个项目实例的 selection 回调。 */
    let projectAFlowProps: DesignCanvasFlowProps | null = null
    let projectBFlowProps: DesignCanvasFlowProps | null = null
    const store = createStore()
    const projectADocument = createDocumentWithNode('project-a', 'node-a')
    const projectBDocument = createDocumentWithNode('project-b', 'node-b')
    store.set(designProjectStatesAtom, new Map([
      ['project-a', {
        ...createInitialDesignProjectState(),
        phase: 'ready',
        snapshot: { document: projectADocument, writable: true },
        selectedNodeIds: ['node-a'],
      }],
      ['project-b', {
        ...createInitialDesignProjectState(),
        phase: 'ready',
        snapshot: { document: projectBDocument, writable: true },
        selectedNodeIds: ['node-b'],
      }],
    ]))

    renderToStaticMarkup(
      <Provider store={store}>
        <DesignCanvas
          document={projectADocument}
          writable
          authoritativeRecoveryState="idle"
          activeTool="select"
          selectedNodeIds={['node-a']}
          flowRenderer={(props) => {
            projectAFlowProps = props
            return <div data-project="a" />
          }}
        />
      </Provider>,
    )
    renderToStaticMarkup(
      <Provider store={store}>
        <DesignCanvas
          document={projectBDocument}
          writable
          authoritativeRecoveryState="idle"
          activeTool="select"
          selectedNodeIds={['node-b']}
          flowRenderer={(props) => {
            projectBFlowProps = props
            return <div data-project="b" />
          }}
        />
      </Provider>,
    )
    expect(projectAFlowProps).not.toBeNull()
    expect(projectBFlowProps).not.toBeNull()
    /** 迟到的 A 回调清空 A，但不得写入当前项目 B。 */
    requireFlowProps(projectAFlowProps).onSelectionChange({ nodes: [], edges: [] })

    const states = store.get(designProjectStatesAtom)
    expect(states.get('project-a')?.selectedNodeIds).toEqual([])
    expect(states.get('project-b')?.selectedNodeIds).toEqual(['node-b'])
  })

  test('Given 画布 writable prop 尚未更新但权威恢复已开始 When 旧视口回调迟到 Then 不写旧快照 mutation', () => {
    let flowProps: DesignCanvasFlowProps | null = null
    const store = createStore()
    const document = createDocumentWithNode('project-a', 'node-a')
    store.set(designProjectStatesAtom, new Map([['project-a', {
      ...createInitialDesignProjectState(),
      phase: 'ready',
      snapshot: { document, writable: true },
    }]]))
    renderToStaticMarkup(
      <Provider store={store}>
        <DesignCanvas
          document={document}
          writable
          authoritativeRecoveryState="idle"
          activeTool="select"
          selectedNodeIds={[]}
          flowRenderer={(props) => {
            flowProps = props
            return <div data-flow-observer />
          }}
        />
      </Provider>,
    )
    /** controller 已同步阻断，但 React 还未用 writable=false 重渲染画布。 */
    store.set(updateDesignProjectStateAtom, {
      projectId: 'project-a',
      update: {
        authoritativeRecoveryState: 'loading',
        saveState: 'failed',
      },
    })

    requireFlowProps(flowProps).onMoveEnd(null, { x: 90, y: 80, zoom: 2 })

    const state = store.get(designProjectStatesAtom).get('project-a')!
    expect(state.snapshot?.document.viewport).toEqual({ x: 0, y: 0, zoom: 1 })
    expect(state.pendingMutations).toEqual([])
  })
})

/** 创建含单节点的项目文档，供组件回调隔离测试使用。 */
function createDocumentWithNode(projectId: string, nodeId: string) {
  /** 固定时间的项目测试文档。 */
  const document = createEmptyDesignDocument(projectId, 100)
  document.nodes = [{
    id: nodeId,
    kind: 'asset',
    assetId: `${nodeId}-asset`,
    position: { x: 0, y: 0 },
    width: 320,
    height: 240,
    zIndex: 0,
  }]
  return document
}
