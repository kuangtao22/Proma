import { describe, expect, test } from 'bun:test'
import type { CanvasNode, CanvasOrchestrationRecord } from '@proma/shared'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  CanvasOrchestrationPanel,
  createCanvasOrchestrationController,
  type CanvasOrchestrationPanelState,
} from './CanvasOrchestrationPanel'

/** 创建面板与控制器测试共用的两阶段专业计划。 */
function createRecord(revision = 1): CanvasOrchestrationRecord {
  return {
    schemaVersion: 1,
    id: 'orchestration-1',
    revision,
    projectId: 'project-1',
    canvasId: 'canvas-1',
    ownerSessionId: 'session-1',
    request: {
      requestId: 'request-1', goal: '制作专业短片', intent: 'produce', constraints: ['18 秒'],
      referenceNodeIds: [], deliverables: [],
    },
    coordinatorNodeId: 'agent-director',
    coordinatorSessionId: 'session-director',
    status: 'running',
    steps: [
      {
        id: 'script', title: '脚本设计', role: '编剧', instruction: '完成叙事脚本', dependsOn: [],
        inputNodeIds: [], outputNodeIds: ['node-script'], agentNodeId: null,
        criteria: ['时长可执行'], status: 'completed', note: '脚本已通过导演评审',
      },
      {
        id: 'shot', title: '镜头设计', role: '分镜师', instruction: '完成镜头表', dependsOn: ['script'],
        inputNodeIds: ['node-script'], outputNodeIds: [], agentNodeId: null,
        criteria: ['镜头可生成'], status: 'running', note: '正在验证动作时长',
      },
    ],
    summary: '脚本完成，正在设计镜头',
    runStartedAt: 2,
    createdAt: 1,
    updatedAt: 3,
  }
}

describe('Canvas 编排计划面板', () => {
  test('Given 没有编排记录 When 渲染 Then 不占用画布空间', () => {
    const html = renderToStaticMarkup(
      <CanvasOrchestrationPanel
        state={{ phase: 'ready', record: null, error: null }}
        nodes={[]}
        onNavigate={() => undefined}
        onRetry={() => undefined}
      />,
    )
    expect(html).toBe('')
  })

  test('Given 专业计划 When 展开面板 Then 展示目标、角色、状态、说明与真实输出节点导航', () => {
    const node = { id: 'node-script', title: '短片脚本', kind: 'document' } as CanvasNode
    const html = renderToStaticMarkup(
      <CanvasOrchestrationPanel
        state={{ phase: 'ready', record: createRecord(), error: null }}
        nodes={[node]}
        defaultOpen
        onNavigate={() => undefined}
        onRetry={() => undefined}
      />,
    )

    expect(html).toContain('制作专业短片')
    expect(html).toContain('脚本完成，正在设计镜头')
    expect(html).toContain('编剧')
    expect(html).toContain('已完成')
    expect(html).toContain('脚本已通过导演评审')
    expect(html).toContain('aria-label="定位输出节点：短片脚本"')
    expect(html).toContain('分镜师')
    expect(html).toContain('运行中')
  })

  test('Given 已挂载当前画布 When 收到更高编排 revision Then 只轻量重读记录', async () => {
    let state: CanvasOrchestrationPanelState = { phase: 'idle', record: null, error: null }
    let listener: ((event: { projectId: string; canvasId: string; revision: number }) => void) | undefined
    const reads: unknown[] = []
    const controller = createCanvasOrchestrationController({
      target: { projectId: 'project-1', canvasId: 'canvas-1' },
      getRecord: async (target) => { reads.push(target); return createRecord(reads.length) },
      onChanged: (_target, nextListener) => { listener = nextListener; return () => undefined },
      onStateChange: (nextState) => { state = nextState },
    })
    await controller.load()
    listener?.({ projectId: 'project-1', canvasId: 'canvas-1', revision: 2 })
    await controller.whenIdle()

    expect(reads).toEqual([
      { projectId: 'project-1', canvasId: 'canvas-1' },
      { projectId: 'project-1', canvasId: 'canvas-1' },
    ])
    expect(state.record?.revision).toBe(2)
    controller.dispose()
  })

  test('Given 旧画布读取尚未返回 When 卸载 Then 迟到结果不再写入且订阅只解绑一次', async () => {
    let resolveRead: ((record: CanvasOrchestrationRecord | null) => void) | undefined
    const states: CanvasOrchestrationPanelState[] = []
    let releases = 0
    const controller = createCanvasOrchestrationController({
      target: { projectId: 'project-1', canvasId: 'canvas-1' },
      getRecord: () => new Promise((resolve) => { resolveRead = resolve }),
      onChanged: () => () => { releases += 1 },
      onStateChange: (state) => states.push(state),
    })
    const pending = controller.load()
    controller.dispose()
    controller.dispose()
    resolveRead?.(createRecord())
    await pending

    expect(states).toEqual([{ phase: 'loading', record: null, error: null }])
    expect(releases).toBe(1)
  })

  test('Given 首次读取失败且没有记录 When 渲染 Then 显示轻量错误与可操作重试按钮', () => {
    const html = renderToStaticMarkup(
      <CanvasOrchestrationPanel
        state={{ phase: 'error', record: null, error: '制作流程暂时无法加载。' }}
        nodes={[]}
        onNavigate={() => undefined}
        onRetry={() => undefined}
      />,
    )

    expect(html).toContain('role="alert"')
    expect(html).toContain('制作流程暂时无法加载。')
    expect(html).toContain('重试')
    expect(html).toContain('type="button"')
  })

  test('Given 已有记录刷新失败 When 面板保持折叠 Then 旧摘要旁仍显示错误和重试入口', () => {
    /** 静态渲染会省略折叠正文，可验证错误无需展开就可见。 */
    const html = renderToStaticMarkup(
      <CanvasOrchestrationPanel
        state={{ phase: 'ready', record: createRecord(), error: '制作流程暂时无法加载。' }}
        nodes={[]}
        onNavigate={() => undefined}
        onRetry={() => undefined}
      />,
    )

    expect(html).toContain('aria-label="展开制作阶段"')
    expect(html).toContain('role="alert"')
    expect(html).toContain('制作流程暂时无法加载。')
    expect(html).toContain('重试')
  })

  test('Given 首次读取失败 When 连续重试且第二次成功 Then 在途请求去重并恢复记录', async () => {
    let reads = 0
    let resolveRetry: ((record: CanvasOrchestrationRecord | null) => void) | undefined
    let state: CanvasOrchestrationPanelState = { phase: 'idle', record: null, error: null }
    const controller = createCanvasOrchestrationController({
      target: { projectId: 'project-1', canvasId: 'canvas-1' },
      getRecord: () => {
        reads += 1
        if (reads === 1) return Promise.reject(new Error('首次读取失败'))
        return new Promise((resolve) => { resolveRetry = resolve })
      },
      onChanged: () => () => undefined,
      onStateChange: (nextState) => { state = nextState },
    })

    await controller.load()
    expect(state).toEqual({ phase: 'error', record: null, error: '制作流程暂时无法加载。' })
    const firstRetry = controller.load()
    const repeatedRetry = controller.load()
    expect(repeatedRetry).toBe(firstRetry)
    expect(reads).toBe(2)
    resolveRetry?.(createRecord(2))
    await firstRetry

    expect(state).toEqual({ phase: 'ready', record: createRecord(2), error: null })
    controller.dispose()
  })

  test('Given 首次读取与重试都失败 When 重试完成 Then 保留公开错误且允许后续再次重试', async () => {
    let reads = 0
    let state: CanvasOrchestrationPanelState = { phase: 'idle', record: null, error: null }
    const controller = createCanvasOrchestrationController({
      target: { projectId: 'project-1', canvasId: 'canvas-1' },
      getRecord: async () => { reads += 1; throw new Error('内部路径不得泄漏') },
      onChanged: () => () => undefined,
      onStateChange: (nextState) => { state = nextState },
    })

    await controller.load()
    await controller.load()

    expect(reads).toBe(2)
    expect(state).toEqual({ phase: 'error', record: null, error: '制作流程暂时无法加载。' })
    controller.dispose()
  })

  test('Given 变化事件读取后记录仍为空 When 请求完成 Then 不自行轮询完整画布或编排记录', async () => {
    let listener: ((event: { projectId: string; canvasId: string; revision: number }) => void) | undefined
    let reads = 0
    const controller = createCanvasOrchestrationController({
      target: { projectId: 'project-1', canvasId: 'canvas-1' },
      getRecord: async () => { reads += 1; return null },
      onChanged: (_target, nextListener) => { listener = nextListener; return () => undefined },
      onStateChange: () => undefined,
    })

    listener?.({ projectId: 'project-1', canvasId: 'canvas-1', revision: 2 })
    await controller.whenIdle()
    await Promise.resolve()

    expect(reads).toBe(1)
    controller.dispose()
  })
})
