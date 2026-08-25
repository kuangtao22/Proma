import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createEmptyCanvasDocument } from '@proma/shared'
import type { AgentSessionMeta, CanvasDocument, CanvasTarget } from '@proma/shared'
import {
  CanvasAgentNodeCreationService,
  type CanvasAgentNodeCreationIntent,
} from './canvas-agent-node-creation'

const OPERATION_ID = '11111111-1111-4111-8111-111111111111'
const SESSION_ID = '22222222-2222-4222-8222-222222222222'

/** 创建可变内存文档与真实 intent 目录组合的测试夹具。 */
function createHarness(options: {
  projectId?: string
  canvasId?: string
  failIntentState?: CanvasAgentNodeCreationIntent['state']
  failCreateSession?: boolean
} = {}) {
  /** 测试目标的双重身份。 */
  const target: CanvasTarget = {
    projectId: options.projectId ?? 'project-1',
    canvasId: options.canvasId ?? 'canvas-1',
  }
  /** 每个夹具独占的 Canvas 正式根。 */
  const root = mkdtempSync(join(tmpdir(), 'proma-canvas-agent-create-'))
  /** 内存权威文档模拟 Canvas Store 的 revision 行为。 */
  let document = createEmptyCanvasDocument(target.projectId, target.canvasId, 1)
  /** 当前 Agent 默认值，测试可在 prepared 后切换。 */
  let settings = { agentChannelId: 'channel-old', agentModelId: 'model-old' }
  /** 已持久化内部会话事实。 */
  const sessions = new Map<string, AgentSessionMeta>()
  /** 所有真实创建调用，用于证明恢复不重复创建。 */
  const createdInputs: Array<Record<string, unknown>> = []
  /** intent 写入前可切换的失败阶段。 */
  let failedState = options.failIntentState
  /** 会话创建前可切换的崩溃模拟。 */
  let failCreateSession = options.failCreateSession ?? false

  /** 生成使用当前依赖的新服务，模拟主进程重启。 */
  const createService = (): CanvasAgentNodeCreationService => new CanvasAgentNodeCreationService({
    pathResolver: {
      resolve: () => ({ canvasesRoot: join(root, 'canvases') }) as never,
      resolveCanvas: (projectId, canvasId) => ({
        projectId,
        canvasId,
        canvasRoot: join(root, 'canvases', canvasId),
        documentPath: join(root, 'canvases', canvasId, 'canvas.json'),
        transactionsDir: join(root, 'canvases', canvasId, 'transactions'),
      }) as never,
    },
    store: {
      load: () => ({ document: structuredClone(document), writable: true }),
      mutate: (_target, expectedRevision, mutations) => {
        expect(expectedRevision).toBe(document.revision)
        const upsert = mutations[0]
        if (upsert?.type !== 'upsert-nodes') throw new Error('测试只接受节点 upsert')
        document = {
          ...document,
          revision: document.revision + 1,
          nodes: [...document.nodes.filter((node) => node.id !== upsert.nodes[0]?.id), ...upsert.nodes],
        }
        return structuredClone(document)
      },
    },
    getSettings: () => settings,
    assertModelAvailable: (channelId, modelId) => {
      if (channelId === 'channel-disabled' || modelId === 'model-disabled') {
        throw new Error('Canvas Agent 渠道或模型不可用')
      }
    },
    getSession: (sessionId) => sessions.get(sessionId),
    createSession: (input) => {
      createdInputs.push(input as unknown as Record<string, unknown>)
      if (failCreateSession) throw new Error('模拟 prepared 后崩溃')
      const session: AgentSessionMeta = {
        id: input.trustedSessionId!,
        title: input.title!,
        channelId: input.channelId,
        modelId: input.modelId,
        workspaceId: input.workspaceId,
        sourceCanvasProjectId: input.sourceCanvasProjectId,
        sourceCanvasId: input.sourceCanvasId,
        sourceCanvasNodeId: input.sourceCanvasNodeId,
        createdAt: 1,
        updatedAt: 1,
      }
      sessions.set(session.id, session)
      return session
    },
    now: () => 10,
    randomUUID: () => SESSION_ID,
    writeIntent: (filePath, intent, writeOptions) => {
      if (failedState === intent.state) throw new Error(`模拟 ${intent.state} intent 写失败`)
      const { writeJsonFileAtomicSecure } = require('../safe-file') as typeof import('../safe-file')
      writeJsonFileAtomicSecure(filePath, intent, writeOptions)
    },
  })

  return {
    target,
    sessions,
    createdInputs,
    createService,
    getDocument: () => structuredClone(document),
    setDocument: (next: CanvasDocument) => { document = structuredClone(next) },
    setSettings: (next: typeof settings) => { settings = next },
    setFailedState: (state?: CanvasAgentNodeCreationIntent['state']) => { failedState = state },
    setFailCreateSession: (value: boolean) => { failCreateSession = value },
    intentPath: join(root, 'canvases', target.canvasId, 'transactions', `agent-node-${OPERATION_ID}.json`),
    transactionsDir: join(root, 'canvases', target.canvasId, 'transactions'),
  }
}

/** 创建固定 operation 的公开请求。 */
function createInput(target: CanvasTarget) {
  return {
    ...target,
    operationId: OPERATION_ID,
    nodeId: 'node-1',
    title: '首页设计 Agent',
    position: { x: 120, y: 80 },
  }
}

describe('Canvas Agent 节点创建事务', () => {
  test('Given 同一 operation 重试 When 首次已完整提交 Then 复用 session 和节点且不重复 mutation', () => {
    const harness = createHarness()
    const service = harness.createService()

    const first = service.create(createInput(harness.target))
    const retried = service.create(createInput(harness.target))

    expect(first.document.nodes).toContainEqual(expect.objectContaining({
      id: 'node-1', agentSessionId: SESSION_ID,
    }))
    expect(retried.document).toEqual(first.document)
    expect(retried.session.id).toBe(first.session.id)
    expect(harness.createdInputs).toHaveLength(1)
    expect(harness.getDocument().revision).toBe(1)
  })

  test('Given prepared 后主进程退出且默认模型变化 When 重试 Then 仍使用 intent 固化的旧默认值', () => {
    const harness = createHarness({ failCreateSession: true })
    expect(() => harness.createService().create(createInput(harness.target)))
      .toThrow('模拟 prepared 后崩溃')

    harness.setSettings({ agentChannelId: 'channel-new', agentModelId: 'model-new' })
    harness.setFailCreateSession(false)
    const recovered = harness.createService().create(createInput(harness.target))

    expect(recovered.session).toMatchObject({ channelId: 'channel-old', modelId: 'model-old' })
    expect(harness.createdInputs.at(-1)).toMatchObject({
      channelId: 'channel-old', modelId: 'model-old', trustedSessionId: SESSION_ID,
    })
  })

  test('Given 文档已写入但 committed intent 写失败 When 重启恢复 Then 不重复创建并补写 committed', () => {
    const harness = createHarness({ failIntentState: 'committed' })
    expect(() => harness.createService().create(createInput(harness.target)))
      .toThrow('模拟 committed intent 写失败')
    expect(harness.getDocument().nodes).toContainEqual(expect.objectContaining({ id: 'node-1' }))

    harness.setFailedState(undefined)
    const recovered = harness.createService().reconcile(harness.target)

    expect(recovered.snapshot.document.nodes).toContainEqual(expect.objectContaining({
      id: 'node-1', agentSessionId: SESSION_ID,
    }))
    expect(harness.createdInputs).toHaveLength(1)
    expect(JSON.parse(readFileSync(harness.intentPath, 'utf8'))).toMatchObject({ state: 'committed' })
  })

  test('Given committed 节点后来被用户删除 When 对账 Then 写 detached 且永不重建', () => {
    const harness = createHarness()
    const service = harness.createService()
    service.create(createInput(harness.target))
    harness.setDocument({ ...harness.getDocument(), nodes: [], revision: 2 })

    const reconciled = service.reconcile(harness.target)

    expect(reconciled.snapshot.document.nodes).toEqual([])
    expect(JSON.parse(readFileSync(harness.intentPath, 'utf8'))).toMatchObject({ state: 'detached' })
    expect(() => service.create(createInput(harness.target))).toThrow('已与节点解除关联')
  })

  test('Given prepared 对应半归属或跨 Canvas session When 恢复 Then fail closed 且不写节点', () => {
    const harness = createHarness({ failCreateSession: true })
    expect(() => harness.createService().create(createInput(harness.target))).toThrow()
    harness.setFailCreateSession(false)
    harness.sessions.set(SESSION_ID, {
      id: SESSION_ID,
      title: '首页设计 Agent',
      workspaceId: 'project-1',
      sourceCanvasProjectId: 'project-1',
      sourceCanvasId: 'canvas-other',
      createdAt: 1,
      updatedAt: 1,
    })

    expect(() => harness.createService().reconcile(harness.target)).toThrow('归属损坏')
    expect(harness.getDocument().nodes).toEqual([])
  })

  test('Given 某 Canvas intent 损坏 When 对账其它 Canvas Then 只阻断所属 Canvas', () => {
    const broken = createHarness({ canvasId: 'canvas-broken' })
    expect(() => broken.createService().create(createInput(broken.target))).not.toThrow()
    writeFileSync(broken.intentPath, '{broken', 'utf8')
    expect(() => broken.createService().reconcile(broken.target)).toThrow('创建事务损坏')

    const healthy = createHarness({ canvasId: 'canvas-healthy' })
    expect(() => healthy.createService().reconcile(healthy.target)).not.toThrow()
  })

  test('Given agent-node intent 文件名伪造非 UUID When 对账 Then 不得静默忽略', () => {
    const harness = createHarness()
    harness.createService().reconcile(harness.target)
    writeFileSync(join(harness.transactionsDir, 'agent-node-not-a-uuid.json'), '{}', 'utf8')

    expect(() => harness.createService().reconcile(harness.target))
      .toThrow('创建事务损坏：文件名无效')
  })

  test('Given intent 固化渠道或模型已失效 When 恢复 Then 明确拒绝且不静默换默认值', () => {
    const harness = createHarness({ failCreateSession: true })
    harness.setSettings({ agentChannelId: 'channel-disabled', agentModelId: 'model-disabled' })
    expect(() => harness.createService().create(createInput(harness.target)))
      .toThrow('Canvas Agent 渠道或模型不可用')
    expect(harness.createdInputs).toHaveLength(0)
  })
})
