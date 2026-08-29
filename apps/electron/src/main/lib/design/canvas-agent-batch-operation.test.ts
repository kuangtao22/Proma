import { describe, expect, spyOn, test } from 'bun:test'
import { applyCanvasMutations, createEmptyCanvasDocument } from '@proma/shared'
import type { AgentSessionMeta, CanvasBatchOperationEnvelope, CanvasDocument, CanvasMutation, CanvasTrashEntry } from '@proma/shared'
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
  /** Agent session 回收失败，用于验证恢复证据不会被吞掉。 */
  failSessionCleanup?: boolean
  /** 图写入前确定失败，用于验证已移入 trash 的内容会恢复。 */
  mutateFailsBeforeCommit?: boolean
  busySessionId?: string
  /** 指定 revision 的发布失败，验证后续事实仍继续广播。 */
  publishFailsAtRevision?: number
} = {}) {
  let document: CanvasDocument = { ...createEmptyCanvasDocument(target.projectId, target.canvasId, 1), revision: 7 }
  const intents = new Map<string, CanvasBatchOperationIntent>()
  const intentWrites: CanvasBatchOperationIntent[] = []
  const events: string[] = []
  const contents = new Set<string>()
  const trash = new Map<string, CanvasTrashEntry>()
  const sessions = new Map<string, AgentSessionMeta>()
  let mutateCalls = 0
  let activeMutations = 0
  let maxActiveMutations = 0
  const publicationAttempts: number[] = []
  const publishedRevisions: number[] = []
  /** 记录 Agent session 探测，证明身份冲突在任何外部资源读取前拒绝。 */
  const agentSessionInspections: string[] = []
  /** 模拟生产 IPC 注入的按 Canvas 共享串行器。 */
  const tails = new Map<string, Promise<void>>()
  const store = {
    load: () => ({ document, writable: true as const, nodeIssues: [] }),
    planBatchOperations: (_target: object, baseRevision: number, operations: unknown[]) => {
      if (baseRevision !== document.revision) throw new Error('CANVAS_REVISION_CONFLICT')
      const normalized = structuredClone(operations) as CanvasMutation[]
      return {
        baseDocument: structuredClone(document),
        operations: normalized,
        expectedDocument: applyCanvasMutations(document, normalized),
      }
    },
    mutate: async (_target: object, baseRevision: number, operations: CanvasMutation[]) => {
      if (baseRevision !== document.revision) throw new Error('CANVAS_REVISION_CONFLICT')
      if (options.mutateFailsBeforeCommit) throw new Error('MUTATE_FAILED_BEFORE_COMMIT')
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
    runExclusive: async (operationTarget, effect) => {
      const key = `${operationTarget.projectId}\0${operationTarget.canvasId}`
      const previous = tails.get(key) ?? Promise.resolve()
      const result = previous.catch(() => undefined).then(effect)
      const tail = result.then(() => undefined, () => undefined)
      tails.set(key, tail)
      try {
        return await result
      } finally {
        if (tails.get(key) === tail) tails.delete(key)
      }
    },
    randomUUID: () => `11111111-1111-4111-8111-${String(++uuid).padStart(12, '0')}`,
    publish: async (_target, publication) => {
      publicationAttempts.push(publication.revision)
      if (publication.revision === options.publishFailsAtRevision) throw new Error('PUBLISH_FAILED')
      publishedRevisions.push(publication.revision)
    },
    scanIntents: async () => [...intents.values()].map((intent) => structuredClone(intent)),
    writeIntent: async (intent) => {
      intentWrites.push(structuredClone(intent))
      const firstResource = intent.preparedResources[0]
      events.push(`write:${firstResource?.state ?? 'none'}:${String(firstResource?.createdByOperation)}`)
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
      inspectBatchContent: async (_target, input) => ({ exists: contents.has(input.contentId) }),
      prepareBatchContent: async (_target, input) => {
        events.push(`prepare:${input.contentId}`)
        if (input.contentId === options.failContentId) throw new Error('PREPARE_FAILED')
        const created = !contents.has(input.contentId)
        contents.add(input.contentId)
        return { created }
      },
      cleanupBatchContent: async (_target, input) => { contents.delete(input.contentId) },
      prepareBatchDeletion: async (_target, entry) => {
        if (trash.has(entry.trashId)) return
        if (!contents.delete(entry.contentId)) throw new Error('CANVAS_CONTENT_NOT_FOUND')
        trash.set(entry.trashId, structuredClone(entry))
      },
      restoreBatchDeletion: async (_target, entry) => {
        const stored = trash.get(entry.trashId)
        if (!stored) {
          if (contents.has(entry.contentId)) return
          throw new Error('CANVAS_TRASH_ENTRY_NOT_FOUND')
        }
        trash.delete(entry.trashId)
        contents.add(entry.contentId)
      },
      assertBatchAgentNodeIdle: (_nodeId, sessionId) => {
        if (sessionId === options.busySessionId) throw new Error('AGENT_SESSION_BUSY')
      },
    },
    agentNodeCreation: {
      inspectBatchSession: (input) => {
        agentSessionInspections.push(input.sessionId)
        return { exists: sessions.has(input.sessionId) }
      },
      prepareBatchSession: (input) => {
        events.push(`prepare:${input.sessionId}`)
        const existing = sessions.get(input.sessionId)
        if (existing) return { session: existing, created: false }
        const session = { id: input.sessionId, title: input.title, createdAt: 1, updatedAt: 1, workspaceId: input.projectId, sourceCanvasProjectId: input.projectId, sourceCanvasId: input.canvasId, sourceCanvasNodeId: input.nodeId } as AgentSessionMeta
        sessions.set(session.id, session)
        return { session, created: true }
      },
      cleanupBatchSession: (input) => {
        if (options.failSessionCleanup) throw new Error('SESSION_CLEANUP_FAILED')
        sessions.delete(input.sessionId)
      },
    },
  })
  return {
    service,
    intents,
    intentWrites,
    events,
    contents,
    trash,
    sessions,
    publicationAttempts,
    publishedRevisions,
    agentSessionInspections,
    getDocument: () => document,
    getMutateCalls: () => mutateCalls,
    getMaxActiveMutations: () => maxActiveMutations,
  }
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
    expect(fixture.agentSessionInspections).toEqual(['session-agent-1'])
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

  test('Given resources-created intent rename 耐久不确定 When 执行 Then 保留资源与可恢复 intent', async () => {
    const fixture = createFixture({ uncertainState: 'resources-created' })
    await expect(fixture.service.execute(batch())).rejects.toThrow('CANVAS_BATCH_RECOVERY_REQUIRED')
    expect(fixture.contents.size).toBe(2)
    expect(fixture.sessions.size).toBe(1)
    expect([...fixture.intents.values()][0]?.state).toBe('resources-created')
    expect(fixture.getMutateCalls()).toBe(0)
  })

  test('Given 第一项资源创建完成 When 第二项 prepare 失败 Then 下一项开始前已持久化资源归属', async () => {
    const fixture = createFixture({ failContentId: 'content-doc-1' })
    await expect(fixture.service.execute(batch())).rejects.toThrow('PREPARE_FAILED')
    const ownershipWrite = fixture.intentWrites.find((intent) => (
      intent.preparedResources[0]?.createdByOperation === true
      && intent.preparedResources[0]?.state === 'ready'
    ))
    expect(ownershipWrite).toBeDefined()
    const ownershipIndex = fixture.events.indexOf('write:preparing:true')
    const creationIndex = fixture.events.indexOf('prepare:session-agent-1')
    expect(ownershipIndex).toBeGreaterThanOrEqual(0)
    expect(ownershipIndex).toBeLessThan(creationIndex)
  })

  test('Given 资源回收失败 When prepare 失败 Then 返回恢复错误并持久化 cleanup-pending', async () => {
    const fixture = createFixture({ failContentId: 'content-doc-1', failSessionCleanup: true })
    await expect(fixture.service.execute(batch())).rejects.toThrow('CANVAS_BATCH_RECOVERY_REQUIRED')
    expect(fixture.sessions.has('session-agent-1')).toBe(true)
    expect([...fixture.intents.values()][0]?.preparedResources[0]?.state).toBe('cleanup-pending')
  })

  test('Given resources-created intent 未提交图 When reconcile Then 完成单次图提交', async () => {
    const fixture = createFixture({ uncertainState: 'resources-created' })
    await expect(fixture.service.execute(batch())).rejects.toThrow('CANVAS_BATCH_RECOVERY_REQUIRED')
    const result = await fixture.service.reconcile(target)
    expect(result.document.revision).toBe(8)
    expect(fixture.getMutateCalls()).toBe(1)
    expect([...fixture.intents.values()][0]?.state).toBe('committed')
  })

  test('Given 旧 resources-created intent When 新 tool call 执行 Then 先收敛旧批次再创建新 intent', async () => {
    const fixture = createFixture({ uncertainState: 'resources-created' })
    await expect(fixture.service.execute(batch())).rejects.toThrow('CANVAS_BATCH_RECOVERY_REQUIRED')
    const result = await fixture.service.execute({
      ...batch(),
      baseRevision: 8,
      sourceToolCallId: 'tool-call-after-recovery',
      operations: [{ type: 'set-viewport', viewport: { x: 20, y: 30, zoom: 1.5 } }],
    })
    expect(result.document.revision).toBe(9)
    expect(fixture.getMutateCalls()).toBe(2)
    expect([...fixture.intents.values()].map((intent) => intent.state)).toEqual(['committed', 'committed'])
  })

  test('Given 顺序 mutation 中间事实被后续覆盖 When mutate 提交后报不确定 Then 只按最终事实确认提交', async () => {
    const fixture = createFixture({ mutateReturnsUncertain: true })
    const result = await fixture.service.execute({
      ...batch(),
      operations: [
        { type: 'set-viewport', viewport: { x: 1, y: 1, zoom: 1 } },
        { type: 'set-viewport', viewport: { x: 9, y: 8, zoom: 2 } },
        { type: 'upsert-nodes', nodes: [
          { id: 'agent-sequential', kind: 'agent', title: '顺序节点', position: { x: 0, y: 0 }, agentSessionId: 'session-sequential' },
        ] },
        { type: 'move-nodes', positions: [{ nodeId: 'agent-sequential', position: { x: 50, y: 60 } }] },
        { type: 'upsert-edges', edges: [
          { id: 'edge-self', sourceNodeId: 'agent-sequential', sourcePort: 'output', targetNodeId: 'agent-sequential', targetPort: 'input' },
        ] },
        { type: 'remove-edges', edgeIds: ['edge-self'] },
      ],
    })
    expect(result.document.revision).toBe(8)
    expect(result.document.viewport).toEqual({ x: 9, y: 8, zoom: 2 })
    expect(result.document.nodes[0]?.position).toEqual({ x: 50, y: 60 })
    expect(result.document.edges).toEqual([])
    expect(fixture.sessions.has('session-sequential')).toBe(true)
  })

  test.each([
    ['image', { id: 'net-image', kind: 'image', title: '图片', position: { x: 0, y: 0 }, imageModuleId: 'net-image-content' }],
    ['document', { id: 'net-document', kind: 'document', title: '文档', position: { x: 0, y: 0 }, documentId: 'net-document-content', contentRevision: 0 }],
    ['webview', { id: 'net-webview', kind: 'webview', title: '原型', position: { x: 0, y: 0 }, prototypeId: 'net-webview-content', contentRevision: 0 }],
    ['agent', { id: 'net-agent', kind: 'agent', title: 'Agent', position: { x: 0, y: 0 }, agentSessionId: 'net-agent-session' }],
  ] as const)('Given %s 节点同批 create→remove When 提交 Then 不创建孤立资源', async (_kind, node) => {
    const fixture = createFixture()
    const result = await fixture.service.execute({
      ...batch(),
      operations: [
        { type: 'upsert-nodes', nodes: [node] },
        { type: 'remove-nodes', nodeIds: [node.id] },
      ],
    })
    expect(result.document.nodes).toEqual([])
    expect(fixture.contents.size).toBe(0)
    expect(fixture.trash.size).toBe(0)
    expect(fixture.sessions.size).toBe(0)
  })

  test.each([
    ['image',
      { id: 'image-a', kind: 'image', title: '图片 A', position: { x: 0, y: 0 }, imageModuleId: 'shared-image' },
      { id: 'image-b', kind: 'image', title: '图片 B', position: { x: 1, y: 1 }, imageModuleId: 'shared-image' }],
    ['document',
      { id: 'document-a', kind: 'document', title: '文档 A', position: { x: 0, y: 0 }, documentId: 'shared-document', contentRevision: 0 },
      { id: 'document-b', kind: 'document', title: '文档 B', position: { x: 1, y: 1 }, documentId: 'shared-document', contentRevision: 0 }],
    ['webview',
      { id: 'webview-a', kind: 'webview', title: '原型 A', position: { x: 0, y: 0 }, prototypeId: 'shared-webview', contentRevision: 0 },
      { id: 'webview-b', kind: 'webview', title: '原型 B', position: { x: 1, y: 1 }, prototypeId: 'shared-webview', contentRevision: 0 }],
  ] as const)('Given %s 内容从 A 转移到 B When 同批删除并复用 identity Then 保留活动目录且不进入 trash', async (_kind, previous, next) => {
    const fixture = createFixture()
    fixture.getDocument().nodes.push(previous)
    const contentId = previous.kind === 'image' ? previous.imageModuleId
      : previous.kind === 'document' ? previous.documentId : previous.prototypeId
    fixture.contents.add(contentId)

    await fixture.service.execute({
      ...batch(),
      operations: [
        { type: 'remove-nodes', nodeIds: [previous.id] },
        { type: 'upsert-nodes', nodes: [next] },
      ],
    })

    expect(fixture.contents.has(contentId)).toBe(true)
    expect(fixture.trash.size).toBe(0)
    expect(fixture.getDocument().nodes.map((node) => node.id)).toEqual([next.id])
  })

  test('Given Agent session 归属节点 A When 同批删除 A 并由 B 复用 Then intent 与 inspect 前拒绝', async () => {
    const fixture = createFixture()
    fixture.getDocument().nodes.push({
      id: 'agent-a', kind: 'agent', title: 'Agent A', position: { x: 0, y: 0 }, agentSessionId: 'shared-agent-session',
    })
    fixture.sessions.set('shared-agent-session', {
      id: 'shared-agent-session', title: 'Agent A', createdAt: 1, updatedAt: 1,
      workspaceId: target.projectId, sourceCanvasProjectId: target.projectId,
      sourceCanvasId: target.canvasId, sourceCanvasNodeId: 'agent-a',
    } as AgentSessionMeta)

    await expect(fixture.service.execute({
      ...batch(),
      operations: [
        { type: 'remove-nodes', nodeIds: ['agent-a'] },
        { type: 'upsert-nodes', nodes: [{
          id: 'agent-b', kind: 'agent', title: 'Agent B', position: { x: 1, y: 1 }, agentSessionId: 'shared-agent-session',
        }] },
      ],
    })).rejects.toThrow('CANVAS_BATCH_AGENT_SESSION_IDENTITY_CONFLICT')

    expect(fixture.getDocument().revision).toBe(7)
    expect(fixture.getDocument().nodes.map((node) => node.id)).toEqual(['agent-a'])
    expect(fixture.intents.size).toBe(0)
    expect(fixture.agentSessionInspections).toEqual([])
    expect(fixture.events).toEqual([])
    expect(fixture.getMutateCalls()).toBe(0)
  })

  test('Given 同图两个 Agent 节点共享 session When 规划任意批次 Then intent 前拒绝', async () => {
    const fixture = createFixture()
    fixture.getDocument().nodes.push(
      { id: 'agent-duplicate-a', kind: 'agent', title: 'A', position: { x: 0, y: 0 }, agentSessionId: 'duplicate-session' },
      { id: 'agent-duplicate-b', kind: 'agent', title: 'B', position: { x: 1, y: 1 }, agentSessionId: 'duplicate-session' },
    )

    await expect(fixture.service.execute({
      ...batch(), operations: [{ type: 'set-viewport', viewport: { x: 1, y: 2, zoom: 1 } }],
    })).rejects.toThrow('CANVAS_BATCH_AGENT_SESSION_IDENTITY_CONFLICT')

    expect(fixture.getDocument().revision).toBe(7)
    expect(fixture.intents.size).toBe(0)
    expect(fixture.agentSessionInspections).toEqual([])
    expect(fixture.events).toEqual([])
    expect(fixture.getMutateCalls()).toBe(0)
  })

  test('Given Agent session 仍绑定同一节点 When 更新标题与位置 Then 合法提交并保留 session', async () => {
    const fixture = createFixture()
    fixture.getDocument().nodes.push({
      id: 'agent-stable', kind: 'agent', title: '旧标题', position: { x: 0, y: 0 }, agentSessionId: 'stable-session',
    })
    fixture.sessions.set('stable-session', {
      id: 'stable-session', title: '旧标题', createdAt: 1, updatedAt: 1,
      workspaceId: target.projectId, sourceCanvasProjectId: target.projectId,
      sourceCanvasId: target.canvasId, sourceCanvasNodeId: 'agent-stable',
    } as AgentSessionMeta)

    const result = await fixture.service.execute({
      ...batch(), operations: [{ type: 'upsert-nodes', nodes: [{
        id: 'agent-stable', kind: 'agent', title: '新标题', position: { x: 4, y: 5 }, agentSessionId: 'stable-session',
      }] }],
    })

    expect(result.document.revision).toBe(8)
    expect(result.document.nodes[0]).toMatchObject({ id: 'agent-stable', title: '新标题', position: { x: 4, y: 5 } })
    expect(fixture.sessions.has('stable-session')).toBe(true)
    expect(fixture.agentSessionInspections).toEqual([])
  })

  test('Given 两个节点共享同一内容 When 只删除一个引用 Then 内容仍保持活动', async () => {
    const fixture = createFixture()
    fixture.getDocument().nodes.push(
      { id: 'shared-a', kind: 'document', title: 'A', position: { x: 0, y: 0 }, documentId: 'shared-content', contentRevision: 0 },
      { id: 'shared-b', kind: 'document', title: 'B', position: { x: 1, y: 1 }, documentId: 'shared-content', contentRevision: 0 },
    )
    fixture.contents.add('shared-content')

    await fixture.service.execute({
      ...batch(), operations: [{ type: 'remove-nodes', nodeIds: ['shared-a'] }],
    })

    expect(fixture.contents.has('shared-content')).toBe(true)
    expect(fixture.trash.size).toBe(0)
  })

  test('Given 最后两个内容引用同批删除 When 提交 Then identity 只移动一次到 trash', async () => {
    const fixture = createFixture()
    fixture.getDocument().nodes.push(
      { id: 'last-a', kind: 'webview', title: 'A', position: { x: 0, y: 0 }, prototypeId: 'last-content', contentRevision: 0 },
      { id: 'last-b', kind: 'webview', title: 'B', position: { x: 1, y: 1 }, prototypeId: 'last-content', contentRevision: 0 },
    )
    fixture.contents.add('last-content')

    await fixture.service.execute({
      ...batch(), operations: [{ type: 'remove-nodes', nodeIds: ['last-a', 'last-b'] }],
    })

    expect(fixture.contents.has('last-content')).toBe(false)
    expect(fixture.trash.size).toBe(1)
  })

  test('Given 跨类型节点复用同一 contentId When 批量转移 Then intent 与资源副作用前拒绝', async () => {
    const fixture = createFixture()
    fixture.getDocument().nodes.push({
      id: 'cross-image', kind: 'image', title: '图片', position: { x: 0, y: 0 }, imageModuleId: 'cross-content',
    })
    fixture.contents.add('cross-content')

    await expect(fixture.service.execute({
      ...batch(),
      operations: [
        { type: 'remove-nodes', nodeIds: ['cross-image'] },
        { type: 'upsert-nodes', nodes: [{
          id: 'cross-document', kind: 'document', title: '文档', position: { x: 1, y: 1 },
          documentId: 'cross-content', contentRevision: 0,
        }] },
      ],
    })).rejects.toThrow('CANVAS_BATCH_CONTENT_IDENTITY_CONFLICT')
    expect(fixture.intents.size).toBe(0)
    expect(fixture.contents.has('cross-content')).toBe(true)
    expect(fixture.trash.size).toBe(0)
  })

  test('Given 已有内容节点 remove→recreate 同 ID When 规划资源 Then 在副作用前明确拒绝', async () => {
    const fixture = createFixture()
    fixture.getDocument().nodes.push({
      id: 'recreate-doc', kind: 'document', title: '旧文档', position: { x: 0, y: 0 },
      documentId: 'recreate-content', contentRevision: 0,
    })
    fixture.contents.add('recreate-content')
    await expect(fixture.service.execute({
      ...batch(),
      operations: [
        { type: 'remove-nodes', nodeIds: ['recreate-doc'] },
        { type: 'upsert-nodes', nodes: [{
          id: 'recreate-doc', kind: 'document', title: '新文档', position: { x: 1, y: 1 },
          documentId: 'recreate-content', contentRevision: 0,
        }] },
      ],
    })).rejects.toThrow('CANVAS_BATCH_REMOVE_RECREATE_UNSUPPORTED')
    expect(fixture.intents.size).toBe(0)
    expect(fixture.trash.size).toBe(0)
    expect(fixture.contents.has('recreate-content')).toBe(true)
  })

  test('Given 三类内容节点 When 批量删除 Then 单次图提交且内容全部进入 trash', async () => {
    const fixture = createFixture()
    fixture.getDocument().nodes.push(
      { id: 'image-existing', kind: 'image', title: '图片', position: { x: 0, y: 0 }, imageModuleId: 'content-image' },
      { id: 'doc-existing', kind: 'document', title: '文档', position: { x: 1, y: 0 }, documentId: 'content-doc', contentRevision: 0 },
      { id: 'web-existing', kind: 'webview', title: '原型', position: { x: 2, y: 0 }, prototypeId: 'content-web', contentRevision: 0 },
    )
    fixture.contents.add('content-image')
    fixture.contents.add('content-doc')
    fixture.contents.add('content-web')
    const result = await fixture.service.execute({
      ...batch(),
      operations: [{ type: 'remove-nodes', nodeIds: ['image-existing', 'doc-existing', 'web-existing'] }],
    })
    expect(result.document.nodes).toHaveLength(0)
    expect(fixture.contents.size).toBe(0)
    expect(fixture.trash.size).toBe(3)
    expect(fixture.getMutateCalls()).toBe(1)
  })

  test('Given 内容已移入 trash When 图提交前失败 Then 全部恢复到 nodes 内容目录', async () => {
    const fixture = createFixture({ mutateFailsBeforeCommit: true })
    fixture.getDocument().nodes.push({
      id: 'doc-existing', kind: 'document', title: '文档', position: { x: 0, y: 0 },
      documentId: 'content-doc', contentRevision: 0,
    })
    fixture.contents.add('content-doc')
    await expect(fixture.service.execute({
      ...batch(), operations: [{ type: 'remove-nodes', nodeIds: ['doc-existing'] }],
    })).rejects.toThrow('MUTATE_FAILED_BEFORE_COMMIT')
    expect(fixture.contents.has('content-doc')).toBe(true)
    expect(fixture.trash.size).toBe(0)
    expect(fixture.getDocument().nodes).toHaveLength(1)
  })

  test('Given 删除资源已入 trash 且 resources-created 不确定 When LOAD reconcile Then 提交图并保留 trash', async () => {
    const fixture = createFixture({ uncertainState: 'resources-created' })
    fixture.getDocument().nodes.push({
      id: 'web-existing', kind: 'webview', title: '原型', position: { x: 0, y: 0 },
      prototypeId: 'content-web', contentRevision: 0,
    })
    fixture.contents.add('content-web')
    const input = { ...batch(), operations: [{ type: 'remove-nodes', nodeIds: ['web-existing'] }] }
    await expect(fixture.service.execute(input)).rejects.toThrow('CANVAS_BATCH_RECOVERY_REQUIRED')
    expect(fixture.trash.size).toBe(1)
    await fixture.service.reconcile(target)
    expect(fixture.getDocument().nodes).toHaveLength(0)
    expect(fixture.trash.size).toBe(1)
  })

  test('Given 图已提交但 committed rename 前失败 When 重启重试 Then LOAD 对账不重复 revision', async () => {
    const fixture = createFixture({ failCommittedOnce: true })
    await expect(fixture.service.execute(batch())).rejects.toThrow('CANVAS_BATCH_INTENT_WRITE_FAILED')
    expect([...fixture.intents.values()][0]?.state).toBe('resources-created')
    const recovered = await fixture.service.execute(batch())
    expect(recovered.document.revision).toBe(8)
    expect(fixture.getMutateCalls()).toBe(1)
  })

  test('Given 旧 recovery 已提交 When 当前 base 冲突 Then lease 释放后仍发布旧 revision', async () => {
    const fixture = createFixture({ uncertainState: 'resources-created' })
    await expect(fixture.service.execute(batch())).rejects.toThrow('CANVAS_BATCH_RECOVERY_REQUIRED')

    await expect(fixture.service.execute({
      ...batch(), sourceToolCallId: 'tool-conflict-after-recovery',
    })).rejects.toThrow('CANVAS_REVISION_CONFLICT')

    expect(fixture.publishedRevisions).toEqual([8])
  })

  test('Given 旧 recovery 与当前批次都提交 When lease 释放 Then 按旧到新顺序发布', async () => {
    const fixture = createFixture({ uncertainState: 'resources-created' })
    await expect(fixture.service.execute(batch())).rejects.toThrow('CANVAS_BATCH_RECOVERY_REQUIRED')

    const result = await fixture.service.execute({
      ...batch(), baseRevision: 8, sourceToolCallId: 'tool-success-after-recovery',
      operations: [{ type: 'set-viewport', viewport: { x: 4, y: 5, zoom: 1.5 } }],
    })

    expect(result.document.revision).toBe(9)
    expect(fixture.publishedRevisions).toEqual([8, 9])
  })

  test('Given 旧 publication 发送失败 When 当前提交成功 Then 隔离失败并继续发布新 revision', async () => {
    const errorSpy = spyOn(console, 'error').mockImplementation(() => undefined)
    const fixture = createFixture({ uncertainState: 'resources-created', publishFailsAtRevision: 8 })
    await expect(fixture.service.execute(batch())).rejects.toThrow('CANVAS_BATCH_RECOVERY_REQUIRED')

    const result = await fixture.service.execute({
      ...batch(), baseRevision: 8, sourceToolCallId: 'tool-publish-failure',
      operations: [{ type: 'set-viewport', viewport: { x: 6, y: 7, zoom: 2 } }],
    })

    expect(result.document.revision).toBe(9)
    expect(fixture.publicationAttempts).toEqual([8, 9])
    expect(fixture.publishedRevisions).toEqual([9])
    errorSpy.mockRestore()
  })
})
