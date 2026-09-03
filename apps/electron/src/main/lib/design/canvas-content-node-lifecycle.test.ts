import { describe, expect, test } from 'bun:test'
import { applyCanvasMutations, createEmptyCanvasDocument, parseCanvasTrashEntry } from '@proma/shared'
import type {
  CanvasContentKind,
  CanvasDocument,
  CanvasImageTarget,
  CanvasMutation,
  CanvasNode,
  CanvasTrashEntry,
} from '@proma/shared'
import { createCanvasContentNodeLifecycle, parseCanvasContentNodeIntent } from './canvas-content-node-lifecycle'
import type { CanvasContentNodeIntent } from './canvas-content-node-lifecycle'

/** 创建可观察的内存生命周期环境，避免测试依赖真实磁盘正文。 */
function createFixture(options: {
  writeOutcome?: (intent: CanvasContentNodeIntent) => { commitVisible: boolean; durabilityUncertain: boolean; error?: string }
  migratedSeeds?: Array<{ kind: 'image' | 'document' | 'webview'; contentId: string; adoptedAssetId?: string; legacySourceUrl?: string }>
  /** 为 true 时不注入测试 UUID，覆盖生产默认生成器。 */
  useDefaultRandomUUID?: boolean
  /** 创建图片节点时解析并固化的项目默认生图模型。 */
  defaultImageModelProfileId?: string | null
  /** 图片删除前可注入的任务取消行为。 */
  cancelActiveImageJobs?: (target: CanvasImageTarget) => Promise<void>
} = {}) {
  /** 当前权威图文档。 */
  let document = createEmptyCanvasDocument('project-1', 'canvas-1', 10)
  /** 按 operationId 持久化的 intent tombstone。 */
  const intents = new Map<string, CanvasContentNodeIntent>()
  /** 回收区的公开业务条目。 */
  const trash = new Map<string, CanvasTrashEntry>()
  /** 共享内容从回收区回到活动目录的真实物理移动次数。 */
  let trashRestoreCalls = 0
  /** 已准备的内容身份。 */
  const contents = new Set<string>()
  /** 内容 Store 收到的空内容准备输入。 */
  const preparedInputs: Array<{ contentId: string; selectedModelProfileId?: string | null }> = []
  /** 图片删除的关键副作用顺序。 */
  const imageDeleteCalls: string[] = []
  /** 模拟仍运行中的 Agent 节点。 */
  const running = new Set<string>()
  /** 迁移提交次数用于证明内容全部准备后只提交一次图。 */
  let migrationCommits = 0
  /** 模拟 v1 CAS 成功后后续 LOAD 只返回 v2 capability 与空 seeds。 */
  let migrationPending = options.migratedSeeds !== undefined
  /** intent 扫描次数用于锁定单次公开操作只执行一次内容对账。 */
  let scanCount = 0
  const store = {
    loadWithMigrationCapability: () => ({
      snapshot: { document, writable: true as const, nodeIssues: [] }, migratedFrom: migrationPending ? 1 as const : undefined,
      legacyContentSeeds: migrationPending ? options.migratedSeeds ?? [] : [], openSingleChildDirectory: () => { throw new Error('unused') },
      commitMigration: () => { migrationCommits += 1; migrationPending = false; return document },
    }),
    mutate: (_target: object, expectedRevision: number, mutations: CanvasMutation[]) => {
      if (expectedRevision !== document.revision) throw new Error('CANVAS_REVISION_CONFLICT')
      if (mutations.some((mutation) => mutation.type === 'remove-nodes')) {
        imageDeleteCalls.push('remove-node')
      }
      document = { ...applyCanvasMutations(document, mutations), revision: document.revision + 1, updatedAt: document.updatedAt + 1 }
      return document
    },
  }
  const contentStore = {
    prepareEmptyContent: async (_target: object, input: { contentId: string; selectedModelProfileId?: string | null }) => {
      preparedInputs.push({ ...input })
      contents.add(input.contentId)
    },
    prepareArtifactContent: async (_target: object, input: { contentId: string; selectedModelProfileId?: string | null }) => {
      preparedInputs.push({ ...input })
      contents.add(input.contentId)
    },
    prepareMigratedContent: async (_target: object, seed: { contentId: string }) => { contents.add(seed.contentId) },
    assertContent: async (_target: object, input: { contentId: string }) => {
      if (!contents.has(input.contentId)) throw new Error('CANVAS_CONTENT_NOT_FOUND')
      return { schemaVersion: 1 as const, kind: 'document' as const, contentId: input.contentId, revision: 0, createdAt: 1, updatedAt: 1 }
    },
    discardPreparedContent: async (_target: object, input: { contentId: string }) => { contents.delete(input.contentId) },
    moveToTrash: async (_target: object, entry: CanvasTrashEntry) => {
      imageDeleteCalls.push('move-to-trash')
      contents.delete(entry.contentId)
      trash.set(entry.trashId, entry)
    },
    moveManyToTrash: async (_target: object, entries: readonly CanvasTrashEntry[]) => {
      const firstEntry = entries[0]
      if (!firstEntry) throw new Error('CANVAS_TRASH_ENTRY_INVALID')
      imageDeleteCalls.push('move-to-trash')
      contents.delete(firstEntry.contentId)
      for (const entry of entries) trash.set(entry.trashId, entry)
    },
    restoreFromTrash: async (_target: object, trashId: string) => {
      const entry = trash.get(trashId)
      if (!entry) throw new Error('CANVAS_TRASH_ENTRY_NOT_FOUND')
      if (!contents.has(entry.contentId)) trashRestoreCalls += 1
      contents.add(entry.contentId)
      return entry
    },
    listTrash: async () => [...trash.values()],
  }
  /** 每次删除使用独立回收身份。 */
  let uuidCounter = 0
  /** 每次构造都模拟一次新的主进程生命周期服务实例。 */
  const createService = () => createCanvasContentNodeLifecycle({
    store, contentStore,
    scanIntents: async () => { scanCount += 1; return [...intents.values()] },
    writeIntent: async (intent) => {
      const outcome = options.writeOutcome?.(intent) ?? { commitVisible: true, durabilityUncertain: false }
      if (outcome.commitVisible) intents.set(intent.operationId, structuredClone(intent))
      return outcome as { commitVisible: true; durabilityUncertain: false } | { commitVisible: false; durabilityUncertain: false; error: string } | { commitVisible: true; durabilityUncertain: true; error: string }
    },
    assertAgentNodeIdle: (nodeId) => { if (running.has(nodeId)) throw new Error('AGENT_SESSION_BUSY') },
    cancelActiveImageJobs: async (imageTarget) => {
      imageDeleteCalls.push('cancel-job')
      await options.cancelActiveImageJobs?.(imageTarget)
    },
    resolveDefaultImageModelProfileId: () => options.defaultImageModelProfileId ?? null,
    now: (() => { let value = 100; return () => value++ })(),
    ...(options.useDefaultRandomUUID ? {} : {
      randomUUID: () => `aaaaaaaa-aaaa-4aaa-8aaa-${String(++uuidCounter).padStart(12, '0')}`,
    }),
  })
  const service = createService()
  return {
    service,
    restartService: createService,
    intents,
    trash,
    contents,
    preparedInputs,
    running,
    imageDeleteCalls,
    getTrashRestoreCalls: () => trashRestoreCalls,
    getDocument: () => document,
    setDocument: (next: CanvasDocument) => { document = next },
    getMigrationCommits: () => migrationCommits,
    getScanCount: () => scanCount,
  }
}

const target = { projectId: 'project-1', canvasId: 'canvas-1' }
/** 三类受管内容节点，用于参数化全部中断阶段。 */
const contentKinds: CanvasContentKind[] = ['image', 'document', 'webview']
/** 测试 helper 只返回三类内容节点，排除 Agent 可选字段。 */
type TestContentNode = Extract<CanvasNode, { kind: CanvasContentKind }>

/** 按内容类别构造严格 v2 intent 节点。 */
function createIntentNode(kind: CanvasContentKind, position = { x: 1, y: 2 }): TestContentNode {
  const base = { id: 'node-strict', title: '严格节点', position }
  if (kind === 'image') return { ...base, kind, imageModuleId: 'content-strict' }
  if (kind === 'document') return { ...base, kind, documentId: 'content-strict', contentRevision: 0 }
  return { ...base, kind, prototypeId: 'content-strict', contentRevision: 0, devicePreset: 'desktop' }
}

describe('CanvasContentNodeLifecycle', () => {
  test('Given 批量内容准备 When 首次创建、复用并回滚 Then 只回收本轮 active 内容', async () => {
    const fixture = createFixture()
    const input = { kind: 'document' as const, contentId: 'batch-content' }

    await expect(fixture.service.prepareBatchContent(target, input)).resolves.toEqual({ created: true })
    await expect(fixture.service.prepareBatchContent(target, input)).resolves.toEqual({ created: false })
    await fixture.service.cleanupBatchContent(target, input, 'batch-rollback-1')
    expect(fixture.contents.has(input.contentId)).toBe(false)
  })

  test.each(contentKinds)('Given %s 批量删除 When prepare 后 restore Then 复用真实 trash 身份往返', async (kind) => {
    const fixture = createFixture()
    const entry = parseCanvasTrashEntry({
      schemaVersion: 1,
      trashId: `trash-batch-${kind}`,
      nodeId: `node-batch-${kind}`,
      kind,
      contentId: `content-batch-${kind}`,
      title: '批量删除',
      position: { x: 1, y: 2 },
      deletedRevision: 3,
      deletedAt: 10,
    })
    fixture.contents.add(entry.contentId)
    await fixture.service.prepareBatchDeletion(target, entry)
    expect(fixture.contents.has(entry.contentId)).toBe(false)
    expect(fixture.trash.get(entry.trashId)).toEqual(entry)
    await fixture.service.restoreBatchDeletion(target, entry)
    expect(fixture.contents.has(entry.contentId)).toBe(true)
    if (kind === 'image') expect(fixture.imageDeleteCalls[0]).toBe('cancel-job')
  })

  test('Given content intent When 严格解析 Then 拒绝未知字段、不可达状态与时间倒退', () => {
    const value = {
      schemaVersion: 1, operation: 'create', state: 'prepared',
      operationId: '11111111-1111-4111-8111-111111111111', ...target,
      node: { id: 'node-1', kind: 'document', title: '文档', position: { x: 0, y: 0 }, documentId: 'content-1', contentRevision: 0 },
      expectedRevision: 0, createdAt: 10, updatedAt: 10,
    }
    expect(parseCanvasContentNodeIntent(value, target, value.operationId).state).toBe('prepared')
    expect(() => parseCanvasContentNodeIntent({ ...value, state: 'trashed' }, target, value.operationId)).toThrow('CANVAS_CONTENT_INTENT_INVALID')
    expect(() => parseCanvasContentNodeIntent({ ...value, updatedAt: 9 }, target, value.operationId)).toThrow('CANVAS_CONTENT_INTENT_INVALID')
    expect(() => parseCanvasContentNodeIntent({ ...value, extra: true }, target, value.operationId)).toThrow('CANVAS_CONTENT_INTENT_INVALID')
  })

  test('Given 恶意 Agent content intent When 解析或推进 Then create/restore 均 fail closed', async () => {
    const operationId = '23232323-2323-4323-8323-232323232323'
    const agentNode = { id: 'agent-evil', kind: 'agent', title: 'Agent', position: { x: 0, y: 0 }, agentSessionId: 'session-evil' } as const
    const createIntent = { schemaVersion: 1, operation: 'create', state: 'prepared', operationId, ...target, node: agentNode, expectedRevision: 0, createdAt: 10, updatedAt: 10 } as const
    const trashEntry = { schemaVersion: 1, trashId: 'trash-evil', nodeId: agentNode.id, kind: 'document', contentId: 'content-evil', title: agentNode.title, position: agentNode.position, deletedRevision: 0, deletedAt: 10 } as const
    expect(() => parseCanvasContentNodeIntent(createIntent, target, operationId)).toThrow('CANVAS_CONTENT_INTENT_INVALID')
    expect(() => parseCanvasContentNodeIntent({ ...createIntent, operation: 'restore', trashId: trashEntry.trashId, trashEntry }, target, operationId)).toThrow('CANVAS_CONTENT_INTENT_INVALID')
    expect(() => parseCanvasContentNodeIntent({ ...createIntent, operation: 'delete', trashId: trashEntry.trashId, trashEntry }, target, operationId)).toThrow('CANVAS_CONTENT_INTENT_INVALID')
    expect(() => parseCanvasContentNodeIntent({ ...createIntent, operation: 'migrate', legacyContentSeeds: [], migrationDocument: createEmptyCanvasDocument(target.projectId, target.canvasId, 1) }, target, operationId)).toThrow('CANVAS_CONTENT_INTENT_INVALID')
    const fixture = createFixture()
    fixture.intents.set(operationId, structuredClone(createIntent) as unknown as CanvasContentNodeIntent)
    await expect(fixture.service.reconcile(target)).rejects.toThrow('CANVAS_CONTENT_INTENT_INVALID')
    expect(fixture.getDocument().nodes).toHaveLength(0)
  })

  test.each(contentKinds)('Given %s delete/restore trash 绑定 When 任一身份错配 Then parser 拒绝', (kind) => {
    const operationId = '24242424-2424-4424-8424-242424242424'
    const node = createIntentNode(kind)
    const identity = node.kind === 'image' ? node.imageModuleId : node.kind === 'document' ? node.documentId : node.prototypeId
    const trashEntry = { schemaVersion: 1, trashId: 'trash-strict', nodeId: node.id, kind, contentId: identity, title: node.title, position: node.position, deletedRevision: 4, deletedAt: 10 } as const
    const base = { schemaVersion: 1, operation: 'delete', state: 'prepared', operationId, ...target, node, expectedRevision: 4, trashId: trashEntry.trashId, trashEntry, createdAt: 10, updatedAt: 10 } as const
    /** 历史 schema1 条目在 intent 解析边界统一升级为规范化 schema2。 */
    expect(parseCanvasContentNodeIntent(base, target, operationId).trashEntry?.schemaVersion).toBe(2)
    const mismatches = [
      { ...base, trashId: 'trash-other' },
      { ...base, trashEntry: { ...trashEntry, kind: kind === 'image' ? 'document' : 'image' } },
      { ...base, trashEntry: { ...trashEntry, contentId: 'content-other' } },
      { ...base, trashEntry: { ...trashEntry, title: '其他标题' } },
      { ...base, trashEntry: { ...trashEntry, position: { x: 9, y: 9 } } },
      { ...base, trashEntry: { ...trashEntry, deletedRevision: 3 } },
    ]
    for (const mismatch of mismatches) {
      expect(() => parseCanvasContentNodeIntent(mismatch, target, operationId)).toThrow('CANVAS_CONTENT_INTENT_INVALID')
    }
    const restore = { ...base, operation: 'restore', state: 'restored', expectedRevision: 5, node: { ...node, position: { x: 20, y: 30 } } } as const
    expect(parseCanvasContentNodeIntent(restore, target, operationId).node.position).toEqual({ x: 20, y: 30 })
    expect(() => parseCanvasContentNodeIntent({ ...restore, trashEntry: { ...trashEntry, title: '错配' } }, target, operationId)).toThrow('CANVAS_CONTENT_INTENT_INVALID')
  })

  test.each(contentKinds)('Given %s 创建 When 执行 Then 内容与图在 committed 后同时可见', async (kind) => {
    const fixture = createFixture()
    const result = await fixture.service.create({
      ...target, operationId: '11111111-1111-4111-8111-111111111111',
      nodeId: 'node-1', kind, contentId: 'content-1', title: '首页', position: { x: 1, y: 2 }, expectedRevision: 0,
    })
    expect(result.snapshot.document.nodes[0]?.kind).toBe(kind)
    expect(fixture.contents.has('content-1')).toBe(true)
    expect(fixture.intents.values().next().value?.state).toBe('committed')
  })

  test('Given 项目有默认生图模型 When 创建图片节点 Then intent 固化模型且重放不重新解析', async () => {
    const fixture = createFixture({ defaultImageModelProfileId: 'profile-1' })
    await fixture.service.create({
      ...target,
      operationId: '41414141-4141-4141-8141-414141414141',
      nodeId: 'node-image-default',
      kind: 'image',
      contentId: 'module-image-default',
      title: '首页主视觉',
      position: { x: 0, y: 0 },
      expectedRevision: 0,
    })

    expect(fixture.intents.values().next().value?.imageModelProfileId).toBe('profile-1')
    expect(fixture.preparedInputs[0]?.selectedModelProfileId).toBe('profile-1')
  })

  test.each(contentKinds)('Given %s prepared intent 写失败 When 创建 Then 内容和图均零副作用', async (kind) => {
    const fixture = createFixture({ writeOutcome: (intent) => intent.state === 'prepared'
      ? { commitVisible: false, durabilityUncertain: false, error: 'injected' }
      : { commitVisible: true, durabilityUncertain: false } })
    await expect(fixture.service.create({
      ...target, operationId: '17171717-1717-4717-8717-171717171717',
      nodeId: 'node-17', kind, contentId: 'content-17', title: '内容', position: { x: 0, y: 0 }, expectedRevision: 0,
    })).rejects.toThrow('CANVAS_CONTENT_INTENT_WRITE_FAILED')
    expect(fixture.contents.size).toBe(0)
    expect(fixture.getDocument().nodes).toHaveLength(0)
  })

  test('Given v1 私有 seeds When LOAD 迁移 Then 全部内容先物化再提交且图 revision 不变', async () => {
    const seeds = [
      { kind: 'image' as const, contentId: 'asset-1', adoptedAssetId: 'asset-1' },
      { kind: 'document' as const, contentId: 'doc-1' },
      { kind: 'webview' as const, contentId: 'web-1', legacySourceUrl: 'https://example.com' },
    ]
    const fixture = createFixture({ migratedSeeds: seeds })
    fixture.setDocument({ ...fixture.getDocument(), revision: 7, createdAt: 10, updatedAt: 17, nodes: [{ id: 'node-image', kind: 'image', title: '图片', position: { x: 0, y: 0 }, imageModuleId: 'asset-1', adoptedAssetId: 'asset-1' }] })
    const result = await fixture.service.load(target)
    expect([...fixture.contents].sort()).toEqual(['asset-1', 'doc-1', 'web-1'])
    expect(fixture.getMigrationCommits()).toBe(1)
    expect(result.snapshot.document.revision).toBe(7)
    expect(fixture.intents.values().next().value?.state).toBe('committed')
  })

  test('Given v1 私有 seeds 且未注入 UUID When LOAD 迁移 Then 默认生成的 operationId 可通过 intent parser', async () => {
    /** 使用生产默认 UUID 路径，复现 Electron 主进程 Web Crypto 接收者约束。 */
    const fixture = createFixture({
      migratedSeeds: [{ kind: 'document', contentId: 'document-default-uuid' }],
      useDefaultRandomUUID: true,
    })
    fixture.setDocument({
      ...fixture.getDocument(),
      nodes: [{
        id: 'node-default-uuid', kind: 'document', title: '默认 UUID 文档',
        position: { x: 0, y: 0 }, documentId: 'document-default-uuid', contentRevision: 0,
      }],
    })

    await fixture.service.load(target)

    /** 已持久化 intent 必须携带可由严格 parser 接受的 UUID。 */
    const intent = fixture.intents.values().next().value
    if (!intent) throw new Error('迁移 intent 未生成')
    expect(parseCanvasContentNodeIntent(intent, target, intent.operationId).operationId)
      .toBe(intent.operationId)
  })

  test('Given 迁移 CAS 已提交但 committed rename 前失败 When 重启对账 Then 用 v2 文档补写并发布一次', async () => {
    let failed = false
    const fixture = createFixture({
      migratedSeeds: [{ kind: 'document', contentId: 'doc-restart' }],
      writeOutcome: (intent) => {
        if (intent.operation === 'migrate' && intent.state === 'committed' && !failed) {
          failed = true
          return { commitVisible: false, durabilityUncertain: false, error: 'injected' }
        }
        return { commitVisible: true, durabilityUncertain: false }
      },
    })
    fixture.setDocument({
      ...fixture.getDocument(), revision: 7, createdAt: 10, updatedAt: 17,
      nodes: [{ id: 'node-migration-restart', kind: 'document', title: '迁移文档', position: { x: 0, y: 0 }, documentId: 'doc-restart', contentRevision: 0 }],
    })
    const first = await fixture.service.load(target)
    expect(first.error).toBeDefined()
    const committedDocument = structuredClone(fixture.getDocument())
    const restarted = fixture.restartService()
    const reconciled = await restarted.reconcile(target)
    expect(reconciled.documentChanged).toBe(true)
    expect(reconciled.publication).toEqual(committedDocument)
    expect(reconciled.snapshot.document).toEqual(committedDocument)
    expect(fixture.intents.values().next().value?.state).toBe('committed')
    expect(fixture.getMigrationCommits()).toBe(1)
    const repeated = await restarted.reconcile(target)
    expect(repeated.documentChanged).toBe(false)
    expect(repeated.publication).toBeUndefined()
  })

  test('Given 迁移 CAS 已提交但 v2 文档已变化 When 重启对账 Then fail closed', async () => {
    let failed = false
    const fixture = createFixture({
      migratedSeeds: [{ kind: 'document', contentId: 'doc-conflict' }],
      writeOutcome: (intent) => {
        if (intent.operation === 'migrate' && intent.state === 'committed' && !failed) {
          failed = true
          return { commitVisible: false, durabilityUncertain: false, error: 'injected' }
        }
        return { commitVisible: true, durabilityUncertain: false }
      },
    })
    fixture.setDocument({
      ...fixture.getDocument(), revision: 3,
      nodes: [{ id: 'node-migration-conflict', kind: 'document', title: '原文档', position: { x: 0, y: 0 }, documentId: 'doc-conflict', contentRevision: 0 }],
    })
    expect((await fixture.service.load(target)).error).toBeDefined()
    fixture.setDocument({
      ...fixture.getDocument(),
      nodes: fixture.getDocument().nodes.map((node) => ({ ...node, title: '冲突标题' })),
    })
    await expect(fixture.restartService().reconcile(target)).rejects.toThrow('CANVAS_MIGRATION_IDENTITY_CONFLICT')
  })

  test('Given 扩展创建 When 提交 Then 节点与边共享一个 revision 且重放不重复', async () => {
    const fixture = createFixture()
    fixture.setDocument({
      ...fixture.getDocument(), nodes: [{ id: 'source-1', kind: 'agent', title: '源', position: { x: 0, y: 0 }, agentSessionId: 'session-1' }],
    })
    const input = { ...target, operationId: '22222222-2222-4222-8222-222222222222', nodeId: 'node-2', kind: 'document' as const, contentId: 'content-2', title: '文档', position: { x: 3, y: 4 }, expectedRevision: 0, relationship: { sourceNodeId: 'source-1', edgeId: 'edge-1', relation: 'derives' as const } }
    const first = await fixture.service.create(input)
    const second = await fixture.service.create(input)
    expect(first.snapshot.document.revision).toBe(1)
    expect(second.snapshot.document.revision).toBe(1)
    expect(second.snapshot.document.edges).toHaveLength(1)
    expect(second.snapshot.document.edges[0]).toMatchObject({
      relation: 'derives', sourcePort: 'agent.text', targetPort: 'context.text',
    })
    await expect(fixture.service.create({ ...input, title: '冲突' })).rejects.toThrow('CANVAS_OPERATION_CONFLICT')
  })

  test.each(contentKinds)('Given %s create 在 content-created tombstone 前中断 When 重试 Then 从 prepared 收敛', async (kind) => {
    let failed = false
    const fixture = createFixture({ writeOutcome: (intent) => {
      if (intent.state === 'content-created' && !failed) {
        failed = true
        return { commitVisible: false, durabilityUncertain: false, error: 'injected' }
      }
      return { commitVisible: true, durabilityUncertain: false }
    } })
    const input = { ...target, operationId: '88888888-8888-4888-8888-888888888888', nodeId: 'node-8', kind, contentId: 'content-8', title: '内容', position: { x: 0, y: 0 }, expectedRevision: 0 }
    await expect(fixture.service.create(input)).rejects.toThrow('CANVAS_CONTENT_INTENT_WRITE_FAILED')
    expect(fixture.getDocument().nodes).toHaveLength(0)
    const retried = await fixture.service.create(input)
    expect(retried.snapshot.document.nodes).toHaveLength(1)
  })

  test.each(contentKinds)('Given %s graph 已提交但 committed intent 耐久未确认 When create Then 保留发布 revision', async (kind) => {
    const fixture = createFixture({ writeOutcome: (intent) => intent.state === 'committed'
      ? { commitVisible: true, durabilityUncertain: true, error: 'injected' }
      : { commitVisible: true, durabilityUncertain: false } })
    const input = { ...target, operationId: '99999999-9999-4999-8999-999999999999', nodeId: 'node-9', kind, contentId: 'content-9', title: '内容', position: { x: 0, y: 0 }, expectedRevision: 0 }
    try {
      await fixture.service.create(input)
      throw new Error('expected published error')
    } catch (error) {
      expect(error).toHaveProperty('document.revision', 1)
      expect(fixture.getDocument().nodes).toHaveLength(1)
    }
  })

  test('Given create 图已提交但 committed rename 前失败 When 重启对账 Then 补写后仍发布一次', async () => {
    let failed = false
    const fixture = createFixture({ writeOutcome: (intent) => {
      if (intent.operation === 'create' && intent.state === 'committed' && !failed) {
        failed = true
        return { commitVisible: false, durabilityUncertain: false, error: 'injected' }
      }
      return { commitVisible: true, durabilityUncertain: false }
    } })
    await expect(fixture.service.create({ ...target, operationId: '30303030-3030-4030-8030-303030303030', nodeId: 'node-30', kind: 'document', contentId: 'content-30', title: '文档', position: { x: 0, y: 0 }, expectedRevision: 0 })).rejects.toHaveProperty('document.revision', 1)
    const restarted = fixture.restartService()
    const reconciled = await restarted.reconcile(target)
    expect(reconciled.documentChanged).toBe(true)
    expect(reconciled.publication?.revision).toBe(1)
    expect((await restarted.reconcile(target)).publication).toBeUndefined()
  })

  test('Given 内容节点 When 删除恢复再删除 Then 内容身份稳定且 trashId 每次独立', async () => {
    const fixture = createFixture()
    await fixture.service.create({ ...target, operationId: '33333333-3333-4333-8333-333333333333', nodeId: 'node-3', kind: 'webview', contentId: 'content-3', title: '原型', position: { x: 5, y: 6 }, expectedRevision: 0 })
    const deleted = await fixture.service.delete({ ...target, nodeId: 'node-3', operationId: '44444444-4444-4444-8444-444444444444', expectedRevision: 1 })
    expect(deleted.trashEntry?.contentId).toBe('content-3')
    const restored = await fixture.service.restore({ ...target, operationId: '55555555-5555-4555-8555-555555555555', trashId: deleted.trashEntry!.trashId, expectedRevision: 2, position: { x: 8, y: 9 } })
    expect(restored.snapshot.document.nodes[0]?.position).toEqual({ x: 8, y: 9 })
    const deletedAgain = await fixture.service.delete({ ...target, nodeId: 'node-3', operationId: '66666666-6666-4666-8666-666666666666', expectedRevision: 3 })
    expect(deletedAgain.trashEntry?.trashId).not.toBe(deleted.trashEntry?.trashId)
  })

  test.each([
    {
      kind: 'image' as const,
      node: { id: 'image-lossless', kind: 'image' as const, title: '图片', position: { x: 1, y: 2 }, imageModuleId: 'image-content', adoptedAssetId: 'asset-adopted' },
      contentId: 'image-content',
    },
    {
      kind: 'document' as const,
      node: { id: 'document-lossless', kind: 'document' as const, title: '文档', position: { x: 3, y: 4 }, documentId: 'document-content', contentRevision: 7 },
      contentId: 'document-content',
    },
    {
      kind: 'webview' as const,
      node: { id: 'webview-lossless', kind: 'webview' as const, title: '原型', position: { x: 5, y: 6 }, prototypeId: 'webview-content', contentRevision: 9, devicePreset: 'mobile' as const },
      contentId: 'webview-content',
    },
  ])('Given $kind 真实节点状态 When 删除并恢复 Then v2 trash 与节点状态无损往返', async ({ node, contentId }) => {
    const fixture = createFixture()
    /** 直接设置非默认节点状态，证明删除读取真实图事实而非内容默认值。 */
    fixture.setDocument({ ...fixture.getDocument(), revision: 7, nodes: [node] })
    fixture.contents.add(contentId)

    const deleted = await fixture.service.delete({
      ...target, nodeId: node.id,
      operationId: '71717171-7171-4171-8171-717171717171', expectedRevision: 7,
    })
    expect(deleted.trashEntry?.schemaVersion).toBe(2)
    const restored = await fixture.service.restore({
      ...target, trashId: deleted.trashEntry!.trashId,
      operationId: '72727272-7272-4272-8272-727272727272',
      expectedRevision: 8, position: { x: 20, y: 30 },
    })

    expect(restored.snapshot.document.nodes[0]).toEqual({
      ...node,
      position: { x: 20, y: 30 },
    })
  })

  test('Given 回收区有两个共享内容的 WebView 快照 When 分别恢复 Then 两个原节点状态回归且内容只移动一次', async () => {
    const fixture = createFixture()
    const entries: CanvasTrashEntry[] = [
      { schemaVersion: 2, trashId: 'trash-shared-a', nodeId: 'web-shared-a', kind: 'webview', contentId: 'content-shared', title: '原型 A', position: { x: 10, y: 20 }, deletedRevision: 0, deletedAt: 10, contentRevision: 3, devicePreset: 'desktop' },
      { schemaVersion: 2, trashId: 'trash-shared-b', nodeId: 'web-shared-b', kind: 'webview', contentId: 'content-shared', title: '原型 B', position: { x: 30, y: 40 }, deletedRevision: 0, deletedAt: 10, contentRevision: 7, devicePreset: 'mobile' },
    ].map(parseCanvasTrashEntry)
    for (const entry of entries) fixture.trash.set(entry.trashId, entry)

    await fixture.service.restore({ ...target, operationId: '73737373-7373-4373-8373-737373737373', trashId: entries[0]!.trashId, expectedRevision: 0, position: entries[0]!.position })
    const restored = await fixture.service.restore({ ...target, operationId: '74747474-7474-4474-8474-747474747474', trashId: entries[1]!.trashId, expectedRevision: 1, position: entries[1]!.position })

    expect(restored.snapshot.document.nodes).toEqual([
      { id: 'web-shared-a', kind: 'webview', title: '原型 A', position: { x: 10, y: 20 }, prototypeId: 'content-shared', contentRevision: 3, devicePreset: 'desktop' },
      { id: 'web-shared-b', kind: 'webview', title: '原型 B', position: { x: 30, y: 40 }, prototypeId: 'content-shared', contentRevision: 7, devicePreset: 'mobile' },
    ])
    expect(fixture.getTrashRestoreCalls()).toBe(1)
  })

  test('Given 图片节点有运行任务 When 删除 Then 先取消任务再进入回收事务', async () => {
    const fixture = createFixture()
    await fixture.service.create({
      ...target,
      operationId: '41414141-4141-4141-8141-414141414141',
      nodeId: 'node-image-running',
      kind: 'image',
      contentId: 'content-image-running',
      title: '运行中图片',
      position: { x: 0, y: 0 },
      expectedRevision: 0,
    })
    fixture.imageDeleteCalls.length = 0

    await fixture.service.delete({
      ...target,
      nodeId: 'node-image-running',
      operationId: '42424242-4242-4242-8242-424242424242',
      expectedRevision: 1,
    })

    expect(fixture.imageDeleteCalls).toEqual(['cancel-job', 'move-to-trash', 'remove-node'])
  })

  test('Given 图片任务取消失败 When 删除 Then 不写删除意图且完整保留节点和内容', async () => {
    const fixture = createFixture({
      cancelActiveImageJobs: async () => { throw new Error('图片任务取消失败') },
    })
    await fixture.service.create({
      ...target,
      operationId: '43434343-4343-4343-8343-434343434343',
      nodeId: 'node-image-cancel-failed',
      kind: 'image',
      contentId: 'content-image-cancel-failed',
      title: '保留图片',
      position: { x: 0, y: 0 },
      expectedRevision: 0,
    })
    fixture.imageDeleteCalls.length = 0

    await expect(fixture.service.delete({
      ...target,
      nodeId: 'node-image-cancel-failed',
      operationId: '44444444-4343-4343-8343-434343434343',
      expectedRevision: 1,
    })).rejects.toThrow('图片任务取消失败')

    expect(fixture.imageDeleteCalls).toEqual(['cancel-job'])
    expect(fixture.getDocument().nodes.map((node) => node.id)).toEqual(['node-image-cancel-failed'])
    expect(fixture.contents.has('content-image-cancel-failed')).toBe(true)
    expect(fixture.intents.has('44444444-4343-4343-8343-434343434343')).toBe(false)
  })

  test.each(contentKinds)('Given %s delete prepared intent 写失败 Then 内容与图保持可见', async (kind) => {
    let failPrepared = false
    const fixture = createFixture({ writeOutcome: (intent) => failPrepared && intent.operation === 'delete' && intent.state === 'prepared'
      ? { commitVisible: false, durabilityUncertain: false, error: 'injected' }
      : { commitVisible: true, durabilityUncertain: false } })
    await fixture.service.create({ ...target, operationId: '25252525-2525-4525-8525-252525252525', nodeId: 'node-25', kind, contentId: 'content-25', title: '内容', position: { x: 0, y: 0 }, expectedRevision: 0 })
    failPrepared = true
    await expect(fixture.service.delete({ ...target, nodeId: 'node-25', operationId: '26262626-2626-4626-8626-262626262626', expectedRevision: 1 })).rejects.toThrow('CANVAS_CONTENT_INTENT_WRITE_FAILED')
    expect(fixture.contents.has('content-25')).toBe(true)
    expect(fixture.getDocument().nodes).toHaveLength(1)
  })

  test.each(contentKinds)('Given %s delete 在 trashed tombstone 前中断 When 重试 Then 图引用只删除一次', async (kind) => {
    let failed = false
    const fixture = createFixture({ writeOutcome: (intent) => {
      if (intent.state === 'trashed' && !failed) { failed = true; return { commitVisible: false, durabilityUncertain: false, error: 'injected' } }
      return { commitVisible: true, durabilityUncertain: false }
    } })
    await fixture.service.create({ ...target, operationId: '12121212-1212-4212-8212-121212121212', nodeId: 'node-12', kind, contentId: 'content-12', title: '内容', position: { x: 0, y: 0 }, expectedRevision: 0 })
    const input = { ...target, nodeId: 'node-12', operationId: '13131313-1313-4313-8313-131313131313', expectedRevision: 1 }
    await expect(fixture.service.delete(input)).rejects.toThrow('CANVAS_CONTENT_INTENT_WRITE_FAILED')
    expect(fixture.getDocument().nodes).toHaveLength(1)
    const retried = await fixture.service.delete(input)
    expect(retried.snapshot.document.revision).toBe(2)
    expect(retried.snapshot.document.nodes).toHaveLength(0)
  })

  test('Given delete 图已提交但 committed rename 前失败 When 重启对账 Then 补写后仍发布一次', async () => {
    let failCommitted = false
    let failed = false
    const fixture = createFixture({ writeOutcome: (intent) => {
      if (failCommitted && intent.operation === 'delete' && intent.state === 'committed' && !failed) {
        failed = true
        return { commitVisible: false, durabilityUncertain: false, error: 'injected' }
      }
      return { commitVisible: true, durabilityUncertain: false }
    } })
    await fixture.service.create({ ...target, operationId: '31313131-3131-4131-8131-313131313131', nodeId: 'node-31', kind: 'image', contentId: 'content-31', title: '图片', position: { x: 0, y: 0 }, expectedRevision: 0 })
    failCommitted = true
    await expect(fixture.service.delete({ ...target, operationId: '32323232-3232-4232-8232-323232323232', nodeId: 'node-31', expectedRevision: 1 })).rejects.toHaveProperty('document.revision', 2)
    const restarted = fixture.restartService()
    const reconciled = await restarted.reconcile(target)
    expect(reconciled.documentChanged).toBe(true)
    expect(reconciled.publication?.revision).toBe(2)
    expect((await restarted.reconcile(target)).publication).toBeUndefined()
  })

  test.each(contentKinds)('Given %s restore prepared intent 写失败 Then 仍留在回收区且图不变', async (kind) => {
    let failPrepared = false
    const fixture = createFixture({ writeOutcome: (intent) => failPrepared && intent.operation === 'restore' && intent.state === 'prepared'
      ? { commitVisible: false, durabilityUncertain: false, error: 'injected' }
      : { commitVisible: true, durabilityUncertain: false } })
    await fixture.service.create({ ...target, operationId: '27272727-2727-4727-8727-272727272727', nodeId: 'node-27', kind, contentId: 'content-27', title: '内容', position: { x: 0, y: 0 }, expectedRevision: 0 })
    const deleted = await fixture.service.delete({ ...target, nodeId: 'node-27', operationId: '28282828-2828-4828-8828-282828282828', expectedRevision: 1 })
    failPrepared = true
    await expect(fixture.service.restore({ ...target, operationId: '29292929-2929-4929-8929-292929292929', trashId: deleted.trashEntry!.trashId, expectedRevision: 2, position: { x: 4, y: 5 } })).rejects.toThrow('CANVAS_CONTENT_INTENT_WRITE_FAILED')
    expect(fixture.contents.has('content-27')).toBe(false)
    expect(fixture.getDocument().nodes).toHaveLength(0)
  })

  test.each(contentKinds)('Given %s restore 在 restored tombstone 前中断 When 重试 Then 节点只提交一次', async (kind) => {
    let failRestore = false
    const fixture = createFixture({ writeOutcome: (intent) => {
      if (intent.state === 'restored' && failRestore) { failRestore = false; return { commitVisible: false, durabilityUncertain: false, error: 'injected' } }
      return { commitVisible: true, durabilityUncertain: false }
    } })
    await fixture.service.create({ ...target, operationId: '14141414-1414-4414-8414-141414141414', nodeId: 'node-14', kind, contentId: 'content-14', title: '内容', position: { x: 0, y: 0 }, expectedRevision: 0 })
    const deleted = await fixture.service.delete({ ...target, nodeId: 'node-14', operationId: '15151515-1515-4515-8515-151515151515', expectedRevision: 1 })
    failRestore = true
    const input = { ...target, operationId: '16161616-1616-4616-8616-161616161616', trashId: deleted.trashEntry!.trashId, expectedRevision: 2, position: { x: 4, y: 5 } }
    await expect(fixture.service.restore(input)).rejects.toThrow('CANVAS_CONTENT_INTENT_WRITE_FAILED')
    expect(fixture.getDocument().nodes).toHaveLength(0)
    const retried = await fixture.service.restore(input)
    expect(retried.snapshot.document.revision).toBe(3)
    expect(retried.snapshot.document.nodes).toHaveLength(1)
  })

  test('Given restore 图已提交但 committed rename 前失败 When 重启对账 Then 补写后仍发布一次', async () => {
    let failCommitted = false
    let failed = false
    const fixture = createFixture({ writeOutcome: (intent) => {
      if (failCommitted && intent.operation === 'restore' && intent.state === 'committed' && !failed) {
        failed = true
        return { commitVisible: false, durabilityUncertain: false, error: 'injected' }
      }
      return { commitVisible: true, durabilityUncertain: false }
    } })
    await fixture.service.create({ ...target, operationId: '33333333-3333-4333-8333-333333333330', nodeId: 'node-33', kind: 'webview', contentId: 'content-33', title: '原型', position: { x: 0, y: 0 }, expectedRevision: 0 })
    const deleted = await fixture.service.delete({ ...target, operationId: '34343434-3434-4434-8434-343434343434', nodeId: 'node-33', expectedRevision: 1 })
    failCommitted = true
    await expect(fixture.service.restore({ ...target, operationId: '35353535-3535-4535-8535-353535353535', trashId: deleted.trashEntry!.trashId, expectedRevision: 2, position: { x: 3, y: 3 } })).rejects.toHaveProperty('document.revision', 3)
    const restarted = fixture.restartService()
    const reconciled = await restarted.reconcile(target)
    expect(reconciled.documentChanged).toBe(true)
    expect(reconciled.publication?.revision).toBe(3)
    expect((await restarted.reconcile(target)).publication).toBeUndefined()
  })

  test.each(contentKinds.flatMap((kind) => ['delete', 'restore'].map((operation) => [kind, operation] as const)))('Given %s %s 图已提交但 committed intent 耐久未确认 Then 错误携带发布 revision', async (kind, operation) => {
    let enableUncertain = false
    const fixture = createFixture({ writeOutcome: (intent) => enableUncertain && intent.state === 'committed'
      ? { commitVisible: true, durabilityUncertain: true, error: 'injected' }
      : { commitVisible: true, durabilityUncertain: false } })
    await fixture.service.create({ ...target, operationId: '18181818-1818-4818-8818-181818181818', nodeId: 'node-18', kind, contentId: 'content-18', title: '内容', position: { x: 0, y: 0 }, expectedRevision: 0 })
    const deleted = await fixture.service.delete({ ...target, nodeId: 'node-18', operationId: '19191919-1919-4919-8919-191919191919', expectedRevision: 1 })
    if (operation === 'restore') enableUncertain = true
    try {
      if (operation === 'delete') {
        await fixture.service.restore({ ...target, operationId: '20202020-2020-4020-8020-202020202020', trashId: deleted.trashEntry!.trashId, expectedRevision: 2, position: { x: 1, y: 1 } })
        enableUncertain = true
        await fixture.service.delete({ ...target, nodeId: 'node-18', operationId: '21212121-2121-4121-8121-212121212121', expectedRevision: 3 })
      } else {
        await fixture.service.restore({ ...target, operationId: '22222222-2222-4222-8222-222222222222', trashId: deleted.trashEntry!.trashId, expectedRevision: 2, position: { x: 1, y: 1 } })
      }
      throw new Error('expected published error')
    } catch (error) {
      expect(error).toHaveProperty('document.revision', operation === 'delete' ? 4 : 3)
    }
  })

  test('Given Agent 节点 When 删除 Then 运行中拒绝，空闲时只移除图引用', async () => {
    const fixture = createFixture()
    fixture.setDocument({ ...fixture.getDocument(), nodes: [{ id: 'agent-1', kind: 'agent', title: 'Agent', position: { x: 0, y: 0 }, agentSessionId: 'session-keep' }] })
    fixture.running.add('agent-1')
    const input = { ...target, nodeId: 'agent-1', operationId: '77777777-7777-4777-8777-777777777777', expectedRevision: 0 }
    await expect(fixture.service.delete(input)).rejects.toThrow('AGENT_SESSION_BUSY')
    fixture.running.clear()
    const result = await fixture.service.delete(input)
    expect(result.snapshot.document.nodes).toHaveLength(0)
    expect(result.trashEntry).toBeUndefined()
    expect(fixture.intents.size).toBe(0)
  })

  test('Given 历史图发布后当前创建 revision 冲突 When createReconciled Then 分离发布与当前错误且只扫描一次', async () => {
    let failCommitted = false
    const fixture = createFixture({ writeOutcome: (intent) => {
      if (failCommitted && intent.state === 'committed') {
        failCommitted = false
        return { commitVisible: false, durabilityUncertain: false, error: 'injected' }
      }
      return { commitVisible: true, durabilityUncertain: false }
    } })
    failCommitted = true
    await expect(fixture.service.create({
      ...target, operationId: '41414141-4141-4141-8141-414141414141', nodeId: 'node-41',
      kind: 'document', contentId: 'content-41', title: '历史文档', position: { x: 0, y: 0 }, expectedRevision: 0,
    })).rejects.toHaveProperty('document.revision', 1)
    const restarted = fixture.restartService()
    const before = fixture.getScanCount()

    const result = await restarted.createReconciled({
      ...target, operationId: '42424242-4242-4242-8242-424242424242', nodeId: 'node-42',
      kind: 'image', contentId: 'content-42', title: '当前图片', position: { x: 10, y: 20 }, expectedRevision: 0,
    })

    expect(result.reconciliation.publication?.revision).toBe(1)
    expect(result.operationOutcome.ok).toBe(false)
    if (!result.operationOutcome.ok) expect(result.operationOutcome.error).toHaveProperty('message', 'CANVAS_REVISION_CONFLICT')
    expect(fixture.getScanCount() - before).toBe(1)
  })

  test('Given 回收区存在条目 When listTrashReconciled Then 对账一次并返回公开条目', async () => {
    const fixture = createFixture()
    await fixture.service.create({
      ...target, operationId: '43434343-4343-4343-8343-434343434343', nodeId: 'node-43',
      kind: 'webview', contentId: 'content-43', title: '原型', position: { x: 0, y: 0 }, expectedRevision: 0,
    })
    await fixture.service.delete({
      ...target, operationId: '44444444-4444-4444-8444-444444444444', nodeId: 'node-43', expectedRevision: 1,
    })
    const before = fixture.getScanCount()

    const result = await fixture.service.listTrashReconciled(target)

    expect(result.operationOutcome).toMatchObject({ ok: true, value: [{ nodeId: 'node-43', kind: 'webview' }] })
    expect(fixture.getScanCount() - before).toBe(1)
  })
})
