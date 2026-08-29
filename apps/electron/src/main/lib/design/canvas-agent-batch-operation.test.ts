import { describe, expect, test } from 'bun:test'
import { applyCanvasMutations, createEmptyCanvasDocument } from '@proma/shared'
import type { AgentSessionMeta, CanvasBatchOperationEnvelope, CanvasDocument, CanvasMutation } from '@proma/shared'
import {
  createCanvasAgentBatchOperationService,
  type CanvasBatchOperationIntent,
} from './canvas-agent-batch-operation'

const target = { projectId: 'project-1', canvasId: 'canvas-1' }

/** 构造可观察资源副作用与单次图提交的批量事务测试夹具。 */
function createFixture(options: {
  failContentId?: string
  /** 指定阶段第一次写入返回 rename 已可见但耐久不确定。 */
  uncertainState?: CanvasBatchOperationIntent['state']
  /** 模拟 Store 已提交图后向调用方返回不确定错误。 */
  mutateReturnsUncertain?: boolean
  /** 第一次 committed intent 写在 rename 前失败。 */
  failCommittedOnce?: boolean
  busySessionId?: string
} = {}) {
  let document: CanvasDocument = { ...createEmptyCanvasDocument(target.projectId, target.canvasId, 1), revision: 7 }
  const intents = new Map<string, CanvasBatchOperationIntent>()
  const contents = new Set<string>()
  const sessions = new Map<string, AgentSessionMeta>()
  let mutateCalls = 0
  let activeMutations = 0
  let maxActiveMutations = 0
  const store = {
    load: () => ({ document, writable: true as const, nodeIssues: [] }),
    validateBatchOperations: (_target: object, baseRevision: number, operations: unknown[]) => {
      if (baseRevision !== document.revision) throw new Error('CANVAS_REVISION_CONFLICT')
      return structuredClone(operations) as CanvasMutation[]
    },
    mutate: async (_target: object, baseRevision: number, operations: CanvasMutation[]) => {
      if (baseRevision !== document.revision) throw new Error('CANVAS_REVISION_CONFLICT')
      mutateCalls += 1
      activeMutations += 1
      maxActiveMutations = Math.max(maxActiveMutations, activeMutations)
      await Promise.resolve()
      document = { ...applyCanvasMutations(document, operations), revision: document.revision + 1 }
      activeMutations -= 1
      if (options.mutateReturnsUncertain) throw new Error('CANVAS_COMMIT_UNCERTAIN')
      return document
    },
  }
  let uuid = 0
  const service = createCanvasAgentBatchOperationService({
    store,
    runWorkspaceWrite: (_projectId, effect) => effect(),
    randomUUID: () => `11111111-1111-4111-8111-${String(++uuid).padStart(12, '0')}`,
    scanIntents: async () => [...intents.values()].map((intent) => structuredClone(intent)),
    writeIntent: async (intent) => {
      if (options.failCommittedOnce && intent.state === 'committed') {
        options.failCommittedOnce = false
        return { commitVisible: false, durabilityUncertain: false, error: 'injected' }
      }
      intents.set(intent.operationId, structuredClone(intent))
      if (options.uncertainState === intent.state) {
        options.uncertainState = undefined
        return { commitVisible: true, durabilityUncertain: true, error: 'injected' }
      }
      return { commitVisible: true, durabilityUncertain: false }
    },
    contentLifecycle: {
      prepareBatchContent: async (_target, input) => {
        if (input.contentId === options.failContentId) throw new Error('PREPARE_FAILED')
        const created = !contents.has(input.contentId)
        contents.add(input.contentId)
        return { created }
      },
      cleanupBatchContent: async (_target, input) => { contents.delete(input.contentId) },
      assertBatchAgentNodeIdle: (_nodeId, sessionId) => {
        if (sessionId === options.busySessionId) throw new Error('AGENT_SESSION_BUSY')
      },
    },
    agentNodeCreation: {
      prepareBatchSession: (input) => {
        const existing = sessions.get(input.sessionId)
        if (existing) return { session: existing, created: false }
        const session = { id: input.sessionId, title: input.title, createdAt: 1, updatedAt: 1, workspaceId: input.projectId, sourceCanvasProjectId: input.projectId, sourceCanvasId: input.canvasId, sourceCanvasNodeId: input.nodeId } as AgentSessionMeta
        sessions.set(session.id, session)
        return { session, created: true }
      },
      cleanupBatchSession: (input) => { sessions.delete(input.sessionId) },
    },
  })
  return { service, intents, contents, sessions, getDocument: () => document, getMutateCalls: () => mutateCalls, getMaxActiveMutations: () => maxActiveMutations }
}

/** 三节点两连线批次，覆盖 Agent、文档和原型资源。 */
function batch(): CanvasBatchOperationEnvelope {
  return {
    ...target,
    baseRevision: 7,
    sourceSessionId: 'source-session',
    sourceRunStartedAt: 99,
    sourceToolCallId: 'tool-call-1',
    operations: structuredClone([
      { type: 'upsert-nodes', nodes: [
        { id: 'agent-1', kind: 'agent', title: '研究', position: { x: 0, y: 0 }, agentSessionId: 'session-agent-1' },
        { id: 'doc-1', kind: 'document', title: '结论', position: { x: 100, y: 0 }, documentId: 'content-doc-1', contentRevision: 0 },
        { id: 'web-1', kind: 'webview', title: '原型', position: { x: 200, y: 0 }, prototypeId: 'content-web-1', contentRevision: 0 },
      ] },
      { type: 'upsert-edges', edges: [
        { id: 'edge-1', sourceNodeId: 'agent-1', sourcePort: 'output', targetNodeId: 'doc-1', targetPort: 'input' },
        { id: 'edge-2', sourceNodeId: 'doc-1', sourcePort: 'output', targetNodeId: 'web-1', targetPort: 'input' },
      ] },
    ]) as unknown as CanvasBatchOperationEnvelope['operations'],
  }
}

describe('CanvasAgentBatchOperationService', () => {
  test('Given 三节点两边 When 执行 Then 只提交一次且 revision 7 到 8', async () => {
    const fixture = createFixture()
    const result = await fixture.service.execute(batch())
    expect(result.document.revision).toBe(8)
    expect(result.document.nodes).toHaveLength(3)
    expect(result.document.edges).toHaveLength(2)
    expect(fixture.getMutateCalls()).toBe(1)
    expect([...fixture.intents.values()][0]?.state).toBe('committed')
  })

  test('Given 第二个内容目录 prepare 失败 When 执行 Then 清理第一项且图零提交', async () => {
    const fixture = createFixture({ failContentId: 'content-web-1' })
    await expect(fixture.service.execute(batch())).rejects.toThrow('PREPARE_FAILED')
    expect(fixture.contents.size).toBe(0)
    expect(fixture.sessions.size).toBe(0)
    expect(fixture.getMutateCalls()).toBe(0)
    expect(fixture.getDocument().revision).toBe(7)
  })

  test('Given base revision 冲突 When 执行 Then intent 与资源均零副作用', async () => {
    const fixture = createFixture()
    await expect(fixture.service.execute({ ...batch(), baseRevision: 6 })).rejects.toThrow('CANVAS_REVISION_CONFLICT')
    expect(fixture.intents.size).toBe(0)
    expect(fixture.contents.size).toBe(0)
    expect(fixture.sessions.size).toBe(0)
  })

  test('Given 批量删除运行中 Agent 节点 When 执行 Then 整批在 prepared intent 前阻断', async () => {
    const fixture = createFixture({ busySessionId: 'busy-session' })
    fixture.getDocument().nodes.push({ id: 'busy-agent', kind: 'agent', title: '运行中', position: { x: 0, y: 0 }, agentSessionId: 'busy-session' })
    const input = { ...batch(), operations: [{ type: 'remove-nodes', nodeIds: ['busy-agent'] }] }
    await expect(fixture.service.execute(input)).rejects.toThrow('AGENT_SESSION_BUSY')
    expect(fixture.intents.size).toBe(0)
    expect(fixture.getMutateCalls()).toBe(0)
  })

  test('Given 相同 sourceToolCallId When 重放 Then 返回相同事实且不重复 revision', async () => {
    const fixture = createFixture()
    const first = await fixture.service.execute(batch())
    const repeated = await fixture.service.execute(batch())
    expect(repeated.document).toEqual(first.document)
    expect(fixture.getMutateCalls()).toBe(1)
  })

  test('Given 同 Canvas 两个批次并发 When 执行 Then 串行进入提交区', async () => {
    const fixture = createFixture()
    const first = fixture.service.execute(batch())
    const second = fixture.service.execute({ ...batch(), baseRevision: 8, sourceToolCallId: 'tool-call-2', operations: [{ type: 'set-viewport', viewport: { x: 1, y: 2, zoom: 1 } }] })
    await Promise.all([first, second])
    expect(fixture.getMaxActiveMutations()).toBe(1)
    expect(fixture.getDocument().revision).toBe(9)
  })

  test('Given 图提交已可见但 mutate 返回不确定 When 执行 Then LOAD 对账且不回滚资源', async () => {
    const fixture = createFixture({ mutateReturnsUncertain: true })
    const result = await fixture.service.execute(batch())
    expect(result.document.revision).toBe(8)
    expect(fixture.contents.size).toBe(2)
    expect(fixture.sessions.size).toBe(1)
    expect([...fixture.intents.values()][0]?.state).toBe('committed')
  })

  test('Given committed intent rename 耐久不确定 When 重试 Then LOAD 返回单 revision 事实', async () => {
    const fixture = createFixture({ uncertainState: 'committed' })
    await expect(fixture.service.execute(batch())).rejects.toThrow('CANVAS_BATCH_INTENT_DURABILITY_UNCERTAIN')
    const recovered = await fixture.service.execute(batch())
    expect(recovered.document.revision).toBe(8)
    expect(fixture.getMutateCalls()).toBe(1)
  })

  test('Given 图已提交但 committed rename 前失败 When 重启重试 Then LOAD 对账不重复 revision', async () => {
    const fixture = createFixture({ failCommittedOnce: true })
    await expect(fixture.service.execute(batch())).rejects.toThrow('CANVAS_BATCH_INTENT_WRITE_FAILED')
    expect([...fixture.intents.values()][0]?.state).toBe('resources-created')
    const recovered = await fixture.service.execute(batch())
    expect(recovered.document.revision).toBe(8)
    expect(fixture.getMutateCalls()).toBe(1)
  })
})
