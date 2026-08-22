import { describe, expect, test } from 'bun:test'
import { createEmptyDesignDocument } from '@proma/shared'
import type { DesignWorkspaceSnapshot } from '@proma/shared'
import { createStore, Provider } from 'jotai'
import { renderToStaticMarkup } from 'react-dom/server'
import { createInitialDesignProjectState } from '@/atoms/design-atoms'
import { currentAgentWorkspaceIdAtom } from '@/atoms/agent-atoms'
import { DesignWorkspaceStateView, DesignWorkspaceView } from './DesignWorkspaceView'

/** 创建可覆盖状态的测试快照。 */
function createSnapshot(overrides: Partial<DesignWorkspaceSnapshot> = {}): DesignWorkspaceSnapshot {
  return {
    document: createEmptyDesignDocument('project-1', 10),
    writable: true,
    ...overrides,
  }
}

describe('Design 工作区页面状态', () => {
  test('Given 正在加载 When 渲染 Then 显示稳定骨架状态', () => {
    const html = renderToStaticMarkup(
      <DesignWorkspaceStateView
        state={{ ...createInitialDesignProjectState(), phase: 'loading' }}
        onRetry={() => undefined}
        onRetrySave={() => undefined}
      />,
    )
    expect(html).toContain('正在加载设计工作区')
  })

  test('Given 空画布 When 渲染 Then 直接提供导入和 AI 生成入口', () => {
    const html = renderToStaticMarkup(
      <DesignWorkspaceStateView
        state={{ ...createInitialDesignProjectState(), phase: 'ready', snapshot: createSnapshot() }}
        onRetry={() => undefined}
        onRetrySave={() => undefined}
      />,
    )
    expect(html).toContain('导入图片')
    expect(html).toContain('AI 生成')
  })

  test('Given 只读快照 When 渲染 Then 保留画布并显示只读原因', () => {
    const html = renderToStaticMarkup(
      <DesignWorkspaceStateView
        state={{
          ...createInitialDesignProjectState(),
          phase: 'ready',
          snapshot: createSnapshot({ writable: false, readOnlyReason: '项目路径不可访问' }),
        }}
        onRetry={() => undefined}
        onRetrySave={() => undefined}
      />,
    )
    expect(html).toContain('项目路径不可访问')
    expect(html).toContain('data-design-canvas-slot')
  })

  test('Given 从恢复文件加载 When 渲染 Then 不常驻显示一次性恢复提示', () => {
    const html = renderToStaticMarkup(
      <DesignWorkspaceStateView
        state={{
          ...createInitialDesignProjectState(),
          phase: 'ready',
          snapshot: createSnapshot({ recoveredFrom: 'tmp' }),
        }}
        onRetry={() => undefined}
        onRetrySave={() => undefined}
      />,
    )
    expect(html).not.toContain('设计画布已从临时文件恢复')
  })

  test('Given 自动保存失败 When 渲染 Then 明确内存修改仍保留', () => {
    const html = renderToStaticMarkup(
      <DesignWorkspaceStateView
        state={{
          ...createInitialDesignProjectState(),
          phase: 'ready',
          snapshot: createSnapshot(),
          saveState: 'failed',
          error: '磁盘暂时不可写',
        }}
        onRetry={() => undefined}
        onRetrySave={() => undefined}
      />,
    )
    expect(html).toContain('保存失败，内存修改已保留')
    expect(html).toContain('磁盘暂时不可写')
    expect(html).toContain('重试保存')
  })

  test('Given 选中 job 且历史会结构修改 job When 渲染 Then 分组取消分组与历史命令均禁用', () => {
    /** job 节点及其结构历史不能进入 Renderer 乐观编辑。 */
    const document = createEmptyDesignDocument('project-1', 10)
    const jobNode = {
      id: 'job-node',
      kind: 'job' as const,
      jobId: 'job-1',
      position: { x: 0, y: 0 },
      width: 320,
      height: 240,
      zIndex: 0,
    }
    document.nodes = [jobNode]
    const unsafeHistory = {
      forward: [{ type: 'patch-nodes' as const, removeIds: ['job-node'], upserts: [] }],
      inverse: [{
        type: 'patch-nodes' as const,
        removeIds: [],
        upserts: [{ entity: jobNode, index: 0 }],
      }],
    }
    const html = renderToStaticMarkup(
      <DesignWorkspaceStateView
        state={{
          ...createInitialDesignProjectState(),
          phase: 'ready',
          snapshot: { document, writable: true },
          selectedNodeIds: ['job-node'],
          history: [unsafeHistory],
          future: [unsafeHistory],
        }}
        onRetry={() => undefined}
        onRetrySave={() => undefined}
      />,
    )

    for (const label of ['撤销', '重做', '分组', '取消分组']) {
      expect(html).toMatch(new RegExp(`aria-label="${label}"[^>]*disabled=""`))
    }
  })

  test('Given 结构冲突采用远端基线 When 渲染 Then 显示重新编辑提示且不提供重试保存', () => {
    /** 这些命令在普通可写状态下均可用，确保 disabled 只来自冲突阻断。 */
    const conflictDocument = createEmptyDesignDocument('project-1', 10)
    conflictDocument.nodes = ['n1', 'n2'].map((id, index) => ({
      id,
      kind: 'asset' as const,
      assetId: `asset-${id}`,
      position: { x: index * 20, y: index * 20 },
      width: 320,
      height: 240,
      zIndex: index,
    }))
    const safeHistory = {
      forward: [{ type: 'set-viewport' as const, viewport: { x: 1, y: 1, zoom: 1 } }],
      inverse: [{ type: 'set-viewport' as const, viewport: { x: 0, y: 0, zoom: 1 } }],
    }
    const html = renderToStaticMarkup(
      <DesignWorkspaceStateView
        state={{
          ...createInitialDesignProjectState(),
          phase: 'ready',
          snapshot: { document: conflictDocument, writable: true },
          selectedNodeIds: ['n1', 'n2'],
          history: [safeHistory],
          future: [safeHistory],
          saveState: 'failed',
          conflictRecoveryPending: true,
          error: '保存冲突：远端画布结构已更新，本地结构修改未自动应用，请基于远端版本重新编辑',
        }}
        onRetry={() => undefined}
        onRetrySave={() => undefined}
        onAcceptRemoteVersion={() => undefined}
        onImportAssets={() => undefined}
      />,
    )

    expect(html).toContain('本地结构修改未自动应用')
    expect(html).not.toContain('重试保存')
    expect(html).toContain('采用远端版本')
    for (const label of ['撤销', '重做', '分组', '取消分组', '箭头批注', '画笔蒙版', '导入图片']) {
      expect(html).toMatch(new RegExp(`aria-label="${label}"[^>]*disabled=""`))
    }
  })

  test('Given 项目加载失败 When 渲染 Then 显示错误和重新加载入口', () => {
    const html = renderToStaticMarkup(
      <DesignWorkspaceStateView
        state={{ ...createInitialDesignProjectState(), phase: 'error', error: '项目目录不可访问' }}
        onRetry={() => undefined}
        onRetrySave={() => undefined}
      />,
    )
    expect(html).toContain('项目目录不可访问')
    expect(html).toContain('重试')
  })

  test('Given 未选择项目 When 渲染设计页面 Then 显示项目选择空状态', () => {
    /** 隔离默认 Jotai store，确保当前项目为空。 */
    const store = createStore()
    store.set(currentAgentWorkspaceIdAtom, null)
    const html = renderToStaticMarkup(
      <Provider store={store}>
        <DesignWorkspaceView />
      </Provider>,
    )
    expect(html).toContain('请选择一个项目')
  })
})
