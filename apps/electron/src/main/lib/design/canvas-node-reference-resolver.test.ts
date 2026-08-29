import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { createEmptyCanvasDocument } from '@proma/shared'
import type {
  AgentCanvasBinding,
  AgentSessionMeta,
  CanvasDocument,
  CanvasNodeReference,
  CanvasSessionMeta,
} from '@proma/shared'
import { createCanvasNodeReferenceResolver } from './canvas-node-reference-resolver'

/** 构造普通顶层用户 Agent 会话。 */
function createSession(overrides: Partial<AgentSessionMeta> = {}): AgentSessionMeta {
  return {
    id: 'session-1',
    title: '普通 Agent',
    workspaceId: 'project-1',
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  }
}

/** 构造 Renderer 选中节点时携带的旧快照。 */
function createReference(overrides: Partial<CanvasNodeReference> = {}): CanvasNodeReference {
  return {
    projectId: 'project-1',
    canvasId: 'canvas-1',
    nodeId: 'node-1',
    nodeType: 'document',
    nodeRevision: 3,
    title: '旧标题',
    ...overrides,
  }
}

/** 构造发送时的权威 Canvas 文档。 */
function createDocument(overrides: Partial<CanvasDocument> = {}): CanvasDocument {
  return {
    ...createEmptyCanvasDocument('project-1', 'canvas-1', 1),
    revision: 4,
    nodes: [{
      id: 'node-1',
      kind: 'document',
      title: '权威标题',
      position: { x: 0, y: 0 },
      documentId: 'document-1',
      contentRevision: 2,
    }],
    ...overrides,
  }
}

/** 构造单元测试 resolver，并暴露依赖调用记录。 */
function createHarness(options: {
  session?: AgentSessionMeta
  binding?: AgentCanvasBinding | null
  document?: CanvasDocument
} = {}) {
  const session = options.session ?? createSession()
  const binding = options.binding === undefined ? {
    projectId: 'project-1',
    sessionId: 'session-1',
    defaultCanvasId: 'canvas-1',
    linkedCanvasIds: ['canvas-1', 'canvas-2'],
    lastActiveCanvasId: 'canvas-2',
    updatedAt: 10,
  } satisfies AgentCanvasBinding : options.binding
  const document = options.document ?? createDocument()
  const loadTargets: Array<{ projectId: string; canvasId: string }> = []
  const canvasTitles = new Map([
    ['canvas-1', '需求画布'],
    ['canvas-2', '交付画布'],
  ])
  const resolver = createCanvasNodeReferenceResolver({
    getSession: (sessionId) => sessionId === session.id ? session : undefined,
    getBinding: () => binding,
    requireCanvas: (projectId, canvasId): CanvasSessionMeta => ({
      id: canvasId,
      projectId,
      title: canvasTitles.get(canvasId) ?? '未知画布',
      archived: false,
      createdAt: 1,
      updatedAt: 2,
    }),
    loadCanvas: (target) => {
      loadTargets.push(target)
      return { document, writable: true, nodeIssues: [] }
    },
  })
  return { resolver, loadTargets }
}

describe('CanvasNodeReferenceResolver', () => {
  test('Given 选中 rev3 后文档更新到 rev4 When 发送 Then 返回发送时权威快照和变化节点', () => {
    const { resolver, loadTargets } = createHarness()

    const result = resolver.resolveForSend({
      sessionId: 'session-1',
      mode: 'latest',
      references: [createReference()],
    })

    expect(result.references).toEqual([{
      projectId: 'project-1',
      canvasId: 'canvas-1',
      nodeId: 'node-1',
      nodeType: 'document',
      nodeRevision: 4,
      title: '权威标题',
    }])
    expect(result.changedNodeIds).toEqual(['node-1'])
    expect(loadTargets).toEqual([{ projectId: 'project-1', canvasId: 'canvas-1' }])
    expect(result.promptSummary).toContain('默认画布：需求画布')
    expect(result.promptSummary).toContain('活动画布：交付画布')
    expect(result.promptSummary).toContain('已关联画布：需求画布、交付画布')
    expect(result.promptSummary).toContain('document「权威标题」')
    expect(result.promptSummary).not.toContain('project-1')
    expect(result.promptSummary).not.toContain('session-1')
    expect(result.promptSummary).not.toContain('document-1')
  })

  test('Given 同一节点被重复引用 When 发送 Then 只保留一个权威快照且只加载一次文档', () => {
    const { resolver, loadTargets } = createHarness()

    const result = resolver.resolveForSend({
      sessionId: 'session-1',
      mode: 'latest',
      references: [createReference(), createReference({ title: '重复旧标题' })],
    })

    expect(result.references).toHaveLength(1)
    expect(result.changedNodeIds).toEqual(['node-1'])
    expect(loadTargets).toHaveLength(1)
  })

  test.each([
    ['节点已删除', { document: createDocument({ nodes: [] }) }],
    ['节点类型变化', { document: createDocument({ nodes: [{ id: 'node-1', kind: 'image', title: '图片', position: { x: 0, y: 0 }, imageModuleId: 'image-1' }] }) }],
    ['Canvas 未关联', { binding: { projectId: 'project-1', sessionId: 'session-1', linkedCanvasIds: ['canvas-2'], defaultCanvasId: 'canvas-2', updatedAt: 1 } satisfies AgentCanvasBinding }],
    ['会话跨项目', { session: createSession({ workspaceId: 'project-2' }) }],
    ['Canvas Agent 作为宿主', { session: createSession({ sourceCanvasProjectId: 'project-1', sourceCanvasId: 'canvas-1', sourceCanvasNodeId: 'agent-node' }) }],
    ['Design Agent 作为宿主', { session: createSession({ sourceDesignProjectId: 'project-1', sourceDesignJobId: 'job-1' }) }],
    ['Automation 作为宿主', { session: createSession({ sourceAutomationId: 'automation-1' }) }],
    ['会话已归档', { session: createSession({ archived: true }) }],
    ['探索子会话作为宿主', { session: createSession({ explorationParentSessionId: 'parent-session' }) }],
  ])('Given %s When 发送 Then 以稳定公开错误拒绝', (_label, options) => {
    const { resolver } = createHarness(options)

    expect(() => resolver.resolveForSend({
      sessionId: 'session-1',
      mode: 'latest',
      references: [createReference()],
    })).toThrow('CANVAS_REFERENCE_INVALID')
  })

  test('Given 引用伪造其它项目 When 发送 Then 在读取 Canvas 前拒绝', () => {
    const { resolver, loadTargets } = createHarness()

    expect(() => resolver.resolveForSend({
      sessionId: 'session-1',
      mode: 'latest',
      references: [createReference({ projectId: 'project-2' })],
    })).toThrow('CANVAS_REFERENCE_INVALID')
    expect(loadTargets).toEqual([])
  })

  test('Given 历史 rev3 且当前文档已到 rev4 When exact 重试 Then 拒绝而不静默替换', () => {
    const { resolver } = createHarness()

    expect(() => resolver.resolveForSend({
      sessionId: 'session-1',
      mode: 'exact',
      references: [createReference()],
    })).toThrow('CANVAS_REFERENCE_INVALID')
  })

  test('Given 历史 rev3 且当前文档仍为 rev3 When exact 重试 Then 保持原始快照 revision', () => {
    const reference = createReference({ title: '权威标题' })
    const { resolver } = createHarness({ document: createDocument({ revision: 3 }) })

    const result = resolver.resolveForSend({
      sessionId: 'session-1',
      mode: 'exact',
      references: [reference],
    })

    expect(result.references).toEqual([reference])
    expect(result.changedNodeIds).toEqual([])
  })

  test.each([
    { sourceAutomationId: '' },
    { parentSessionId: '' },
    { rootSessionId: '' },
    { sourceDelegationId: '' },
    { delegationRole: 'explore' as const },
    { delegationStatus: 'running' as const },
    { delegationDepth: 0 },
    { delegationGoal: '' },
    { sourceCanvasProjectId: '' },
    { sourceDesignProjectId: '' },
  ])('Given 残缺内部归属元数据 %o When 解析引用 Then 复用 canonical 资格规则 fail closed', (overrides) => {
    const { resolver } = createHarness({ session: createSession(overrides) })

    expect(() => resolver.resolveForSend({
      sessionId: 'session-1',
      mode: 'latest',
      references: [createReference()],
    })).toThrow('CANVAS_REFERENCE_INVALID')
  })

  test('Given resolver 检查 Agent 资格 When 审计实现 Then 只复用 canonical helper', () => {
    const source = readFileSync(new URL('./canvas-node-reference-resolver.ts', import.meta.url), 'utf8')

    expect(source).toContain('isEligibleProjectAgent(session, session.workspaceId)')
    expect(source).not.toContain('session.archived')
    expect(source).not.toContain('session.explorationParentSessionId')
  })
})
