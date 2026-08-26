import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { applyCanvasMutations, createEmptyCanvasDocument } from '@proma/shared'
import type { AgentSessionMeta, CanvasDocument, CanvasMutation, CanvasTarget } from '@proma/shared'
import {
  CanvasAgentNodeCreationService,
  type CanvasAgentNodeCreationIntent,
} from './canvas-agent-node-creation'
import { createCanvasDocumentStore } from './canvas-document-store'
import { runStableDirectoryNative } from '../stable-directory-native-host'
import type { StableDirectoryNativeWriteOutcome } from '../stable-directory-native-host'
import type { SecureAtomicJsonWriteOptions } from '../safe-file'

const OPERATION_ID = '11111111-1111-4111-8111-111111111111'
const SESSION_ID = '22222222-2222-4222-8222-222222222222'

/** 创建可变内存文档与真实 intent 目录组合的测试夹具。 */
function createHarness(options: {
  projectId?: string
  canvasId?: string
  failIntentState?: CanvasAgentNodeCreationIntent['state']
  failCreateSession?: boolean
  modelError?: Error
  afterLoad?: (paths: { canvasRoot: string; transactionsDir: string }) => void
  beforeGetSettings?: (paths: { canvasRoot: string; transactionsDir: string }) => void
  onWriteIntentCall?: () => void
  afterIntentLstat?: (filePath: string) => void
  afterIntentRead?: (filePath: string) => void
  nativeIntentIo?: boolean
  writeIntentOutcome?: (intent: CanvasAgentNodeCreationIntent) => StableDirectoryNativeWriteOutcome | undefined
  hideUncertainIntent?: boolean
} = {}) {
  /** 测试目标的双重身份。 */
  const target: CanvasTarget = {
    projectId: options.projectId ?? 'project-1',
    canvasId: options.canvasId ?? 'canvas-1',
  }
  /** 每个夹具独占的 Canvas 正式根。 */
  const root = mkdtempSync(join(tmpdir(), 'proma-canvas-agent-create-'))
  /** 真实目录用于覆盖父目录置换竞态，创建服务不得自行递归越界。 */
  const canvasRoot = join(root, 'canvases', target.canvasId)
  const transactionsDir = join(canvasRoot, 'transactions')
  mkdirSync(canvasRoot, { recursive: true })
  mkdirSync(transactionsDir)
  /** 真实 Store 只负责提供与 LOAD 同源的目录 capability，文档 mutation 仍由内存夹具控制。 */
  const pathResolver = {
    resolve: () => ({ canvasesRoot: join(root, 'canvases') }) as never,
    resolveCanvas: (projectId: string, canvasId: string) => ({
      projectId,
      canvasId,
      canvasRoot: join(root, 'canvases', canvasId),
      documentPath: join(root, 'canvases', canvasId, 'canvas.json'),
      transactionsDir: join(root, 'canvases', canvasId, 'transactions'),
    }) as never,
  }
  const directoryStore = createCanvasDocumentStore({
    sessions: { requireNative: () => ({}) as never },
    pathResolver,
    now: () => 1,
  })
  /** 内存权威文档模拟 Canvas Store 的 revision 行为。 */
  let document = createEmptyCanvasDocument(target.projectId, target.canvasId, 1)
  /** 当前 Agent 默认值，测试可在 prepared 后切换。 */
  let settings: { agentChannelId?: string; agentModelId?: string } = {
    agentChannelId: 'channel-old',
    agentModelId: 'model-old',
  }
  /** 已持久化内部会话事实。 */
  const sessions = new Map<string, AgentSessionMeta>()
  /** 所有真实创建调用，用于证明恢复不重复创建。 */
  const createdInputs: Array<Record<string, unknown>> = []
  /** intent 写入前可切换的失败阶段。 */
  let failedState = options.failIntentState
  /** 会话创建前可切换的崩溃模拟。 */
  let failCreateSession = options.failCreateSession ?? false
  /** transactions 目录扫描次数，用于锁定单次 CREATE 的 I/O 上界。 */
  let transactionDirectoryReads = 0
  /** Store 收到的完整 mutation 批次，用于验证节点与边原子提交。 */
  const mutationBatches: CanvasMutation[][] = []

  /** 生成使用当前依赖的新服务，模拟主进程重启。 */
  const createService = (): CanvasAgentNodeCreationService => new CanvasAgentNodeCreationService({
    store: {
      loadWithDirectoryCapability: (loadTarget) => {
        const loaded = directoryStore.loadWithDirectoryCapability(loadTarget)
        options.afterLoad?.({ canvasRoot, transactionsDir })
        return {
          ...loaded,
          snapshot: {
            document: structuredClone(document),
            writable: true as const,
            nodeIssues: [],
          },
        }
      },
      mutate: (_target, expectedRevision, mutations) => {
        expect(expectedRevision).toBe(document.revision)
        mutationBatches.push(structuredClone(mutations))
        const mutated = applyCanvasMutations(document, mutations)
        document = {
          ...mutated,
          revision: document.revision + 1,
        }
        return structuredClone(document)
      },
    },
    getSettings: () => {
      options.beforeGetSettings?.({ canvasRoot, transactionsDir })
      return settings
    },
    assertModelAvailable: (channelId, modelId) => {
      if (channelId === 'channel-disabled' || modelId === 'model-disabled') {
        throw options.modelError ?? new Error('Canvas Agent 渠道或模型不可用')
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
    ...(options.nativeIntentIo
      ? {
          runStableDirectoryNative: (request, authorize) => runStableDirectoryNative(
            request,
            authorize,
            {
              helperPath: () => resolve(
                import.meta.dir,
                `../../../../resources/stable-directory/stable-directory-helper${process.platform === 'win32' ? '.exe' : ''}`,
              ),
            },
          ),
        }
      : {
          readTransactionsDirectory: (directoryPath: string) => {
            transactionDirectoryReads += 1
            return readdirSync(directoryPath, { withFileTypes: true })
          },
          writeIntent: (filePath: string, intent: CanvasAgentNodeCreationIntent, writeOptions?: SecureAtomicJsonWriteOptions) => {
            options.onWriteIntentCall?.()
            if (failedState === intent.state) throw new Error(`模拟 ${intent.state} intent 写失败`)
            const outcome = options.writeIntentOutcome?.(intent)
            if (outcome?.commitVisible === false || (outcome?.durabilityUncertain && options.hideUncertainIntent)) {
              return outcome
            }
            const { writeJsonFileAtomicSecure } = require('../safe-file') as typeof import('../safe-file')
            writeJsonFileAtomicSecure(filePath, intent, writeOptions)
            return outcome
          },
        }),
    afterIntentLstat: options.afterIntentLstat,
    afterIntentRead: options.afterIntentRead,
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
    getTransactionDirectoryReads: () => transactionDirectoryReads,
    resetTransactionDirectoryReads: () => { transactionDirectoryReads = 0 },
    mutationBatches,
    root,
    canvasRoot,
    intentPath: join(transactionsDir, `agent-node-${OPERATION_ID}.json`),
    transactionsDir,
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
  test('Given prepared 写在 rename 前失败 When 创建 Then 不创建 session、节点或发布事实', async () => {
    const harness = createHarness({
      writeIntentOutcome: (intent) => intent.state === 'prepared'
        ? { commitVisible: false, durabilityUncertain: false, error: 'cannot commit canvas intent file' }
        : undefined,
    })

    const outcome = await harness.createService().createReconciled(createInput(harness.target))

    expect(outcome.operationOutcome.ok).toBe(false)
    expect(outcome.reconciliation.documentChanged).toBe(false)
    expect(harness.createdInputs).toEqual([])
    expect(harness.getDocument().nodes).toEqual([])
  })

  test('Given committed rename 可见但目录持久性未确认 When 重扫精确 intent 可见 Then 携带发布事实并返回明确降级错误', async () => {
    const harness = createHarness({
      writeIntentOutcome: (intent) => intent.state === 'committed'
        ? { commitVisible: true, durabilityUncertain: true, error: 'cannot persist canvas transactions directory' }
        : undefined,
    })

    const outcome = await harness.createService().createReconciled(createInput(harness.target))

    expect(outcome.operationOutcome.ok).toBe(false)
    if (outcome.operationOutcome.ok) throw new Error('预期 durability uncertain')
    expect(outcome.operationOutcome.error).toHaveProperty('message', expect.stringContaining('CANVAS_INTENT_DURABILITY_UNCERTAIN'))
    expect(outcome.operationOutcome.publication?.revision).toBe(1)
    expect(harness.getDocument().nodes).toContainEqual(expect.objectContaining({ id: 'node-1' }))
    await expect(harness.createService().reconcile(harness.target)).resolves.toMatchObject({
      documentChanged: false,
      snapshot: { document: { revision: 1 } },
    })
  })

  test('Given helper 声称 committed 可见但重扫找不到目标 When 创建 Then fail closed 且不得发布', async () => {
    const harness = createHarness({
      hideUncertainIntent: true,
      writeIntentOutcome: (intent) => intent.state === 'committed'
        ? { commitVisible: true, durabilityUncertain: true, error: 'cannot persist canvas transactions directory' }
        : undefined,
    })

    const outcome = await harness.createService().createReconciled(createInput(harness.target))

    expect(outcome.operationOutcome.ok).toBe(false)
    if (outcome.operationOutcome.ok) throw new Error('预期 durability uncertain')
    expect(outcome.operationOutcome.publication).toBeUndefined()
    expect(outcome.operationOutcome.error).toHaveProperty('message', expect.stringContaining('CANVAS_INTENT_COMMIT_UNCONFIRMED'))
  })

  test('Given 生产 native intent I/O When 创建并重放同一 operation Then helper 扫描写入且只创建一次 session', async () => {
    const appDir = resolve(import.meta.dir, '../../../..')
    execFileSync(process.execPath, [resolve(appDir, 'scripts/build-stable-directory-native.ts')], { stdio: 'pipe' })
    const harness = createHarness({ nativeIntentIo: true })

    const first = await harness.createService().create(createInput(harness.target))
    const replayed = await harness.createService().create(createInput(harness.target))

    expect(first.session.id).toBe(SESSION_ID)
    expect(replayed.document).toEqual(first.document)
    expect(harness.createdInputs).toHaveLength(1)
    expect(JSON.parse(readFileSync(harness.intentPath, 'utf8'))).toMatchObject({ state: 'committed' })
  })

  test('Given intent 在 lstat 后被同名新 inode 替换 When 打开读取 Then 拒绝 replacement', async () => {
    let replaced = false
    const harness = createHarness({
      afterIntentLstat: (filePath) => {
        if (replaced) return
        replaced = true
        const raw = readFileSync(filePath, 'utf8')
        renameSync(filePath, `${filePath}.original`)
        writeFileSync(filePath, raw, 'utf8')
      },
    })
    await harness.createService().create(createInput(harness.target))

    await expect(harness.createService().reconcile(harness.target))
      .rejects.toThrow('读取前文件已变化')
  })

  test('Given intent 同 inode 被等长改写 When 读取完成 Then 通过 mtime/ctime 拒绝内容变化', async () => {
    let rewritten = false
    const harness = createHarness({
      afterIntentRead: (filePath) => {
        if (rewritten) return
        rewritten = true
        const raw = readFileSync(filePath, 'utf8')
        const changed = raw.replace('首页设计 Agent', '发现设计 Agent')
        expect(Buffer.byteLength(changed)).toBe(Buffer.byteLength(raw))
        writeFileSync(filePath, changed, 'utf8')
      },
    })
    await harness.createService().create(createInput(harness.target))

    await expect(harness.createService().reconcile(harness.target))
      .rejects.toThrow('读取期间文件变化')
  })

  test('Given 历史 intent 对账已发布 When 新 operation 模型校验失败 Then 联合结果保留 revision、原始错误且只扫描一次', async () => {
    const error = new Error('Canvas Agent 渠道或模型不可用')
    const harness = createHarness({ failCreateSession: true, modelError: error })
    await expect(harness.createService().create(createInput(harness.target))).rejects.toThrow('模拟 prepared 后崩溃')
    harness.setFailCreateSession(false)
    harness.setSettings({ agentChannelId: 'channel-disabled', agentModelId: 'model-disabled' })
    harness.resetTransactionDirectoryReads()

    const outcome = await harness.createService().createReconciled({
      ...createInput(harness.target),
      operationId: '33333333-3333-4333-8333-333333333333',
      nodeId: 'node-2',
    })

    expect(outcome.reconciliation.documentChanged).toBe(true)
    expect(outcome.reconciliation.snapshot.document.revision).toBe(1)
    expect(outcome.operationOutcome.ok).toBe(false)
    if (outcome.operationOutcome.ok) throw new Error('预期创建失败')
    expect(outcome.operationOutcome.error).toBe(error)
    expect(harness.getTransactionDirectoryReads()).toBe(1)
  })

  test('Given 同一 operation 重试 When 首次已完整提交 Then 复用 session 和节点且不重复 mutation', async () => {
    const harness = createHarness()
    const service = harness.createService()

    const first = await service.create(createInput(harness.target))
    const retried = await service.create(createInput(harness.target))

    expect(first.document.nodes).toContainEqual(expect.objectContaining({
      id: 'node-1', agentSessionId: SESSION_ID,
    }))
    expect(retried.document).toEqual(first.document)
    expect(retried.session.id).toBe(first.session.id)
    expect(harness.createdInputs).toHaveLength(1)
    expect(harness.getDocument().revision).toBe(1)
  })

  test('Given 健康源节点 When 扩展 Agent Then 节点与边在同一 revision 提交', async () => {
    const harness = createHarness()
    const sourceNode = {
      id: 'source-1',
      kind: 'agent' as const,
      title: '源 Agent',
      position: { x: 20, y: 40 },
      agentSessionId: 'source-session',
    }
    harness.setDocument({
      ...harness.getDocument(),
      nodes: [sourceNode],
    })
    const input = {
      ...createInput(harness.target),
      nodeId: 'target-1',
      relationship: {
        sourceNodeId: sourceNode.id,
        edgeId: '33333333-3333-4333-8333-333333333333',
      },
    }

    const result = await harness.createService().create(input)

    expect(result.document.revision).toBe(1)
    expect(result.document.nodes).toContainEqual(expect.objectContaining({ id: 'target-1' }))
    expect(result.document.edges).toContainEqual({
      id: '33333333-3333-4333-8333-333333333333',
      sourceNodeId: 'source-1',
      sourcePort: 'output',
      targetNodeId: 'target-1',
      targetPort: 'input',
    })
    expect(harness.mutationBatches).toEqual([[
      expect.objectContaining({ type: 'upsert-nodes' }),
      expect.objectContaining({ type: 'upsert-edges' }),
    ]])
  })

  test('Given 相同扩展 operation 已 committed When 重试 Then 不重复节点或边', async () => {
    const harness = createHarness()
    harness.setDocument({
      ...harness.getDocument(),
      nodes: [{
        id: 'source-1',
        kind: 'agent',
        title: '源 Agent',
        position: { x: 20, y: 40 },
        agentSessionId: 'source-session',
      }],
    })
    const input = {
      ...createInput(harness.target),
      nodeId: 'target-1',
      relationship: {
        sourceNodeId: 'source-1',
        edgeId: '33333333-3333-4333-8333-333333333333',
      },
    }
    const service = harness.createService()

    await service.create(input)
    const retried = await service.create(input)

    expect(retried.document.nodes.filter((node) => node.id === 'target-1')).toHaveLength(1)
    expect(retried.document.edges.filter((edge) => edge.id === input.relationship.edgeId)).toHaveLength(1)
    expect(harness.mutationBatches).toHaveLength(1)
  })

  test('Given 源节点存在 node issue When 请求扩展 Then 创建 session 前拒绝且文档不变', async () => {
    const harness = createHarness()
    const service = harness.createService()
    await service.create(createInput(harness.target))
    harness.sessions.delete(SESSION_ID)
    const documentBefore = harness.getDocument()

    await expect(service.create({
      ...createInput(harness.target),
      operationId: '33333333-3333-4333-8333-333333333333',
      nodeId: 'node-2',
      relationship: {
        sourceNodeId: 'node-1',
        edgeId: '44444444-4444-4444-8444-444444444444',
      },
    })).rejects.toThrow('源节点会话不可用')

    expect(harness.getDocument()).toEqual(documentBefore)
    expect(harness.createdInputs).toHaveLength(1)
  })

  test('Given prepared 后主进程退出且默认模型变化 When 重试 Then 仍使用 intent 固化的旧默认值', async () => {
    const harness = createHarness({ failCreateSession: true })
    await expect(harness.createService().create(createInput(harness.target)))
      .rejects.toThrow('模拟 prepared 后崩溃')

    harness.setSettings({ agentChannelId: 'channel-new', agentModelId: 'model-new' })
    harness.setFailCreateSession(false)
    const recovered = await harness.createService().create(createInput(harness.target))

    expect(recovered.session).toMatchObject({ channelId: 'channel-old', modelId: 'model-old' })
    expect(harness.createdInputs.at(-1)).toMatchObject({
      channelId: 'channel-old', modelId: 'model-old', trustedSessionId: SESSION_ID,
    })
  })

  test('Given 文档已写入但 committed intent 写失败 When 同 operation 重试 Then 补写 committed 并发布既有 revision', async () => {
    const harness = createHarness({ failIntentState: 'committed' })
    await expect(harness.createService().create(createInput(harness.target)))
      .rejects.toThrow('模拟 committed intent 写失败')
    expect(harness.getDocument().nodes).toContainEqual(expect.objectContaining({ id: 'node-1' }))

    harness.setFailedState(undefined)
    const recovered = await harness.createService().create(createInput(harness.target))

    expect(recovered.document.nodes).toContainEqual(expect.objectContaining({
      id: 'node-1', agentSessionId: SESSION_ID,
    }))
    expect(recovered.documentChanged).toBe(true)
    expect(harness.createdInputs).toHaveLength(1)
    expect(JSON.parse(readFileSync(harness.intentPath, 'utf8'))).toMatchObject({ state: 'committed' })
  })

  test('Given committed 节点后来被用户删除 When 对账 Then 写 detached 且永不重建', async () => {
    const harness = createHarness()
    const service = harness.createService()
    await service.create(createInput(harness.target))
    harness.setDocument({ ...harness.getDocument(), nodes: [], revision: 2 })
    harness.sessions.delete(SESSION_ID)

    const reconciled = await service.reconcile(harness.target)

    expect(reconciled.snapshot.document.nodes).toEqual([])
    expect(reconciled.snapshot.nodeIssues).toEqual([])
    expect(JSON.parse(readFileSync(harness.intentPath, 'utf8'))).toMatchObject({ state: 'detached' })
    await expect(service.create(createInput(harness.target))).rejects.toThrow('已与节点解除关联')
  })

  test('Given committed 节点的 session 缺失 When LOAD 对账 Then 返回完整文档并只标记目标节点', async () => {
    const harness = createHarness()
    const service = harness.createService()
    await service.create(createInput(harness.target))
    harness.sessions.delete(SESSION_ID)

    const reconciled = await service.reconcile(harness.target)

    expect(reconciled.error).toBeUndefined()
    expect(reconciled.snapshot.document.nodes).toContainEqual(expect.objectContaining({ id: 'node-1' }))
    expect(reconciled.snapshot.nodeIssues).toEqual([{
      nodeId: 'node-1',
      code: 'AGENT_SESSION_UNAVAILABLE',
      allowedActions: ['rebuild-agent-session', 'remove-node'],
    }])
  })

  test('Given committed 节点的 session 归属异常 When LOAD 对账 Then 只派生公开节点问题', async () => {
    const harness = createHarness()
    const service = harness.createService()
    await service.create(createInput(harness.target))
    const session = harness.sessions.get(SESSION_ID)
    if (!session) throw new Error('测试 session 未创建')
    harness.sessions.set(SESSION_ID, { ...session, sourceCanvasId: 'canvas-other' })

    const reconciled = await service.reconcile(harness.target)

    expect(reconciled.snapshot.document.nodes).toHaveLength(1)
    expect(reconciled.snapshot.nodeIssues).toEqual([{
      nodeId: 'node-1',
      code: 'AGENT_SESSION_UNAVAILABLE',
      allowedActions: ['rebuild-agent-session', 'remove-node'],
    }])
  })

  test('Given session-created 未完成事务的 session 缺失 When LOAD 对账 Then 继续 fail closed', async () => {
    const harness = createHarness({ failIntentState: 'committed' })
    const service = harness.createService()
    await expect(service.create(createInput(harness.target)))
      .rejects.toThrow('模拟 committed intent 写失败')
    harness.sessions.delete(SESSION_ID)

    await expect(service.reconcile(harness.target)).rejects.toThrow('归属损坏')
  })

  test('Given detached 写在 rename 前失败 When 对账 Then fail closed 且保留 committed 供重试', async () => {
    const harness = createHarness({
      writeIntentOutcome: (intent) => intent.state === 'detached'
        ? { commitVisible: false, durabilityUncertain: false, error: 'cannot commit canvas intent file' }
        : undefined,
    })
    const service = harness.createService()
    await service.create(createInput(harness.target))
    harness.setDocument({ ...harness.getDocument(), nodes: [], revision: 2 })

    await expect(service.reconcile(harness.target)).rejects.toThrow('CANVAS_INTENT_WRITE_FAILED')
    expect(JSON.parse(readFileSync(harness.intentPath, 'utf8'))).toMatchObject({ state: 'committed' })
    expect(harness.getDocument().nodes).toEqual([])
  })

  test('Given detached rename 可见但目录持久性未确认 When 对账 Then 明确报错且下次不重建或重复发布', async () => {
    let injectUncertain = true
    const harness = createHarness({
      writeIntentOutcome: (intent) => intent.state === 'detached' && injectUncertain
        ? { commitVisible: true, durabilityUncertain: true, error: 'cannot persist canvas transactions directory' }
        : undefined,
    })
    const service = harness.createService()
    await service.create(createInput(harness.target))
    harness.setDocument({ ...harness.getDocument(), nodes: [], revision: 2 })

    const uncertain = await service.reconcile(harness.target)

    expect(uncertain.documentChanged).toBe(false)
    expect(uncertain.error).toHaveProperty(
      'message',
      expect.stringContaining('CANVAS_INTENT_DURABILITY_UNCERTAIN'),
    )
    expect(JSON.parse(readFileSync(harness.intentPath, 'utf8'))).toMatchObject({ state: 'detached' })
    injectUncertain = false
    await expect(service.reconcile(harness.target)).resolves.toMatchObject({
      documentChanged: false,
      snapshot: { document: { revision: 2, nodes: [] } },
    })
    expect(harness.createdInputs).toHaveLength(1)
  })

  test('Given prepared 对应半归属或跨 Canvas session When 恢复 Then fail closed 且不写节点', async () => {
    const harness = createHarness({ failCreateSession: true })
    await expect(harness.createService().create(createInput(harness.target))).rejects.toThrow()
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

    await expect(harness.createService().reconcile(harness.target)).rejects.toThrow('归属损坏')
    expect(harness.getDocument().nodes).toEqual([])
  })

  test.each([
    ['Automation', { sourceAutomationId: 'automation-1' }],
    ['完整 Delegation', {
      parentSessionId: 'parent-1',
      rootSessionId: 'root-1',
      sourceDelegationId: 'delegation-1',
      delegationRole: 'explore' as const,
      delegationStatus: 'running' as const,
      delegationDepth: 1,
      delegationGoal: '分析项目',
    }],
    ['半 Delegation', { sourceDelegationId: 'delegation-1' }],
  ])('Given prepared session 混入%s 来源 When 恢复 Then fail closed 且不写节点', async (_label, contamination) => {
    const harness = createHarness({ failCreateSession: true })
    await expect(harness.createService().create(createInput(harness.target))).rejects.toThrow()
    harness.setFailCreateSession(false)
    harness.sessions.set(SESSION_ID, {
      id: SESSION_ID,
      title: '首页设计 Agent',
      channelId: 'channel-old',
      modelId: 'model-old',
      workspaceId: 'project-1',
      sourceCanvasProjectId: 'project-1',
      sourceCanvasId: 'canvas-1',
      sourceCanvasNodeId: 'node-1',
      ...contamination,
      createdAt: 1,
      updatedAt: 1,
    })

    await expect(harness.createService().reconcile(harness.target)).rejects.toThrow('归属损坏')
    expect(harness.getDocument().nodes).toEqual([])
  })

  test('Given 某 Canvas intent 损坏 When 对账其它 Canvas Then 只阻断所属 Canvas', async () => {
    const broken = createHarness({ canvasId: 'canvas-broken' })
    await expect(broken.createService().create(createInput(broken.target))).resolves.toBeDefined()
    writeFileSync(broken.intentPath, '{broken', 'utf8')
    await expect(broken.createService().reconcile(broken.target)).rejects.toThrow('创建事务损坏')

    const healthy = createHarness({ canvasId: 'canvas-healthy' })
    await expect(healthy.createService().reconcile(healthy.target)).resolves.toBeDefined()
  })

  test('Given agent-node intent 文件名伪造非 UUID When 对账 Then 不得静默忽略', async () => {
    const harness = createHarness()
    await harness.createService().reconcile(harness.target)
    writeFileSync(join(harness.transactionsDir, 'agent-node-not-a-uuid.json'), '{}', 'utf8')

    await expect(harness.createService().reconcile(harness.target))
      .rejects.toThrow('创建事务损坏：文件名无效')
  })

  test('Given intent 固化渠道或模型已失效 When 恢复 Then 明确拒绝且不静默换默认值', async () => {
    const harness = createHarness({ failCreateSession: true })
    harness.setSettings({ agentChannelId: 'channel-disabled', agentModelId: 'model-disabled' })
    await expect(harness.createService().create(createInput(harness.target)))
      .rejects.toThrow('Canvas Agent 渠道或模型不可用')
    expect(harness.createdInputs).toHaveLength(0)
  })

  test('Given Store LOAD 后 Canvas 根被替换为外部 symlink When 打开 transactions Then fail closed 且外部零写入', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'proma-canvas-agent-outside-'))
    let replaced = false
    const harness = createHarness({
      afterLoad: ({ canvasRoot }) => {
        if (replaced) return
        replaced = true
        renameSync(canvasRoot, `${canvasRoot}.original`)
        symlinkSync(outside, canvasRoot, 'dir')
      },
    })

    await expect(harness.createService().reconcile(harness.target)).rejects.toThrow('CANVAS_PATH_UNSAFE')
    expect(readdirSync(outside)).toEqual([])
  })

  test('Given transactions 已捕获后父 Canvas 根被置换 When 写 prepared Then 写边界前 fail closed 且外部零写入', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'proma-canvas-agent-outside-'))
    const outsideTransactions = join(outside, 'transactions')
    mkdirSync(outsideTransactions)
    let writeCalls = 0
    let replaced = false
    const harness = createHarness({
      beforeGetSettings: ({ canvasRoot }) => {
        if (replaced) return
        replaced = true
        renameSync(canvasRoot, `${canvasRoot}.original`)
        symlinkSync(outside, canvasRoot, 'dir')
      },
      onWriteIntentCall: () => { writeCalls += 1 },
    })

    await expect(harness.createService().create(createInput(harness.target)))
      .rejects.toThrow('CANVAS_PATH_UNSAFE')
    expect(writeCalls).toBe(0)
    expect(readdirSync(outsideTransactions)).toEqual([])
  })
})
