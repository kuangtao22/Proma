import { createHash } from 'node:crypto'
import { describe, expect, spyOn, test } from 'bun:test'
import {
  type CanvasDocument,
  type CanvasImageCandidateBatch,
  type CanvasImageModuleConfig,
  type CanvasNode,
  type CanvasTarget,
} from '@proma/shared'
import { createCanvasImageCandidateBatchService, createCanvasImageCandidateHash } from './canvas-image-candidate-batch-service'
import type { CanvasImageCandidateAdoptionPublication } from './canvas-image-candidate-batch-service'
import { parseCanvasImageCandidateAdoptionIntent, type CanvasImageCandidateAdoptionIntent } from './canvas-image-candidate-batch-store'
import { createCanvasDependencyStateService } from './canvas-dependency-state-service'
import { parseCanvasDocument } from './canvas-document-store'

test('Given Agent 明确整批采用 When 同 operation 重放或变更模式 Then 不重复提交且不同参数被拒绝', async () => {
  const fixture = createFixture()
  await fixture.service.createBatch({ ...fixture.target, batchId: 'batch-replay', source: 'single',
    sourceSessionId: null, sourceToolCallId: null, entries: [fixture.entries[0]!] })
  await fixture.service.recordJobTerminal({ ...fixture.target, jobId: 'job-0', status: 'succeeded', outputAssetId: 'new-0', error: null })
  const input = { ...fixture.target, batchId: 'batch-replay', mode: 'all' as const }
  let allowed = true
  const execution = { operationId: 'adoption-replay', validateAccess: () => { if (!allowed) throw new Error('ACCESS_REVOKED') } }
  const first = await fixture.service.adopt(input, execution)
  expect(await fixture.service.adopt(input, execution)).toEqual(first)
  expect(fixture.adopted).toEqual(['node-0'])
  await expect(fixture.service.adopt({ ...input, mode: 'succeeded' }, execution)).rejects.toThrow('CANVAS_IMAGE_BATCH_CONFLICT')
  allowed = false
  await expect(fixture.service.adopt(input, execution)).rejects.toThrow('ACCESS_REVOKED')
  expect(fixture.adopted).toEqual(['node-0'])
})

/** 创建 14 节点内存夹具；normalizeDocument 为 true 时复现主进程 Store 的读写重建。 */
function createFixture(input: boolean | { validateCandidate?: () => Promise<void> } = false, initiallyEmpty = false) {
  /** 同时覆盖真实 Store 规范化与异步候选预检。 */
  const normalizeDocument = typeof input === 'boolean' ? input : false
  const options = typeof input === 'boolean' ? {} : input
  const target: CanvasTarget = { projectId: 'project-1', canvasId: 'canvas-1' }
  const batches = new Map<string, CanvasImageCandidateBatch>()
  const intents = new Map<string, CanvasImageCandidateAdoptionIntent>()
  const configs = new Map<string, CanvasImageModuleConfig>()
  const adopted: string[] = []
  /** 记录显式采用恢复通知，首选初始化与其恢复均不能唤醒父流程。 */
  const resumeNotifications: CanvasTarget[] = []
  const retried: string[] = []
  const started: string[] = []
  /** 记录锁外发布的正式素材事实，验证关闭工作台后仍能刷新卡片。 */
  const publications: CanvasImageCandidateAdoptionPublication[] = []
  /** 依赖投影调用数用于证明候选阶段不会提前传播。 */
  let dependencyProjectionCalls = 0
  /** 公开入口获取串行器的次数，用于证明 locked 恢复入口不会重入。 */
  let exclusiveCalls = 0
  /** fixture 复用真实纯服务，仅在入口外记录调用次数。 */
  const dependencyState = createCanvasDependencyStateService()
  const entries = Array.from({ length: 14 }, (_, index) => {
    const nodeId = `node-${index}`
    configs.set(nodeId, {
      schemaVersion: 2, kind: 'image', contentId: `module-${index}`, revision: 1,
      createdAt: 1, updatedAt: 1, prompt: '生成', selectedModelProfileId: 'model-1',
      aspectRatio: '1:1', imageSize: 'auto', contextMode: 'none', adoptedAssetId: initiallyEmpty ? null : `old-${index}`,
    })
    return {
      nodeId, imageModuleId: `module-${index}`, initialAdoptedAssetId: initiallyEmpty ? null : `old-${index}`,
      initialConfigRevision: 1, jobId: `job-${index}`,
    }
  })
  /** 权威 Canvas 文档用于验证整批图投影与关系过滤。 */
  let canvas: CanvasDocument = {
    schemaVersion: 4,
    ...target,
    revision: 3,
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: entries.map((entry, index) => ({
      id: entry.nodeId,
      kind: 'image' as const,
      title: `图片 ${index}`,
      position: { x: index * 10, y: 0 },
      imageModuleId: entry.imageModuleId,
      adoptedAssetId: entry.initialAdoptedAssetId ?? undefined,
    })),
    edges: [],
    createdAt: 1,
    updatedAt: 1,
  }
  const store = {
    listActiveSummaries: async () => [],
    load: async (_target: CanvasTarget, batchId: string) => {
      const value = batches.get(batchId)
      if (!value) throw new Error('CANVAS_IMAGE_BATCH_NOT_FOUND')
      return structuredClone(value)
    },
    save: async (batch: CanvasImageCandidateBatch) => {
      batches.set(batch.batchId, structuredClone(batch)); return structuredClone(batch)
    },
    findByJobId: async (_target: CanvasTarget, jobId: string) => {
      const found = [...batches.values()].find((batch) => batch.entries.some((entry) => entry.jobId === jobId))
      return found ? structuredClone(found) : null
    },
    scanAdoptionIntents: async () => [...intents.values()].map((intent) => structuredClone(intent)),
    loadAdoptionIntent: async (_target: CanvasTarget, operationId: string) => {
      const value = intents.get(operationId)
      if (!value) throw new Error('CANVAS_IMAGE_BATCH_ADOPTION_INTENT_NOT_FOUND')
      return structuredClone(value)
    },
    saveAdoptionIntent: async (intent: CanvasImageCandidateAdoptionIntent) => {
      /** 采用条目必须经过生产 parser，避免内存夹具接受磁盘合同拒绝的数据。 */
      const parsed = parseCanvasImageCandidateAdoptionIntent(intent, target, intent.operationId)
      intents.set(intent.operationId, structuredClone(parsed))
      return structuredClone(parsed)
    },
  }
  const service = createCanvasImageCandidateBatchService({
    store,
    validateCandidate: options.validateCandidate,
    onAdopted: (target) => { resumeNotifications.push(target) },
    publishAdoption: (publication) => { publications.push(structuredClone(publication)) },
    dependencyState: {
      consumeAndPropagate: (input) => {
        dependencyProjectionCalls += 1
        return dependencyState.consumeAndPropagate(input)
      },
    },
    runExclusive: async (_target, effect) => {
      exclusiveCalls += 1
      return effect()
    },
    loadConfig: async (imageTarget) => structuredClone(configs.get(imageTarget.nodeId)!),
    adoptAsset: async (imageTarget, _revision, assetId) => {
      adopted.push(imageTarget.nodeId)
      const current = configs.get(imageTarget.nodeId)!
      const next = { ...current, revision: current.revision + 1, adoptedAssetId: assetId }
      configs.set(imageTarget.nodeId, next)
      return next
    },
    loadCanvas: async () => structuredClone(normalizeDocument
      ? parseCanvasDocument(canvas, target).document
      : canvas),
    applyCanvasProjection: async (_target, expectedRevision, nodes) => {
      if (canvas.revision !== expectedRevision) throw new Error('CANVAS_REVISION_CONFLICT')
      const replacements = new Map(nodes.map((node) => [node.id, node]))
      canvas = {
        ...canvas,
        revision: canvas.revision + 1,
        nodes: canvas.nodes.map((node) => replacements.get(node.id) ?? node),
        updatedAt: 100,
      }
      if (normalizeDocument) {
        canvas = parseCanvasDocument(canvas, target).document
      }
      return structuredClone(canvas)
    },
    retryEntry: async (_batch, entry) => {
      retried.push(entry.jobId)
      const jobId = `${entry.jobId}-retry`
      return { jobId, start: () => { started.push(jobId) } }
    },
    now: () => 100,
    randomUUID: () => 'operation-1',
  })
  return {
    target, entries, batches, intents, configs, adopted, retried, started, service, publications, store, resumeNotifications,
    get canvas() { return canvas },
    set canvas(value: CanvasDocument) { canvas = value },
    get dependencyProjectionCalls() { return dependencyProjectionCalls },
    get exclusiveCalls() { return exclusiveCalls },
  }
}

/** 计算测试图事实哈希；normalize=false 用于构造旧版 raw intent。 */
function createTestGraphSha256(document: CanvasDocument, normalize = true): string {
  const canonical = normalize ? parseCanvasDocument(document, document).document : document
  return createHash('sha256').update(JSON.stringify({
    viewport: canonical.viewport,
    nodes: canonical.nodes,
    edges: canonical.edges,
  })).digest('hex')
}

/** 构造旧 raw hash 已落盘、当前图已被真实 Store parser 规范化的恢复现场。 */
async function createLegacyRawHashRecoveryFixture() {
  const fixture = createFixture(true)
  /** 无旧提示的直接下游用于复现 upstreamChange 新增在对象末尾的旧序列化顺序。 */
  fixture.canvas = parseCanvasDocument({
    ...fixture.canvas,
    nodes: [...fixture.canvas.nodes, {
      id: 'downstream-legacy-hash', kind: 'document', title: '旧哈希下游',
      position: { x: 0, y: 100 }, documentId: 'document-legacy-hash', contentRevision: 1,
    }],
    edges: [{
      id: 'edge-legacy-hash', sourceNodeId: 'node-0', sourcePort: 'image.asset',
      targetNodeId: 'downstream-legacy-hash', targetPort: 'context.image', relation: 'depends-on',
    }],
  }, fixture.target).document
  await fixture.service.createBatch({
    ...fixture.target, batchId: 'batch-legacy-hash', source: 'single',
    sourceSessionId: null, sourceToolCallId: null, entries: [fixture.entries[0]!],
  })
  await fixture.service.recordJobTerminal({
    ...fixture.target, jobId: 'job-0', status: 'succeeded', outputAssetId: 'new-0', error: null,
  })
  /** 旧服务从规范 base 投影，但在 Store 写回前直接按新增字段顺序计算 raw hash。 */
  const baseDocument = parseCanvasDocument(fixture.canvas, fixture.target).document
  const dependencyProjection = createCanvasDependencyStateService().consumeAndPropagate({
    document: baseDocument,
    producerNodeIds: ['node-0'],
    changedAt: 100,
  })
  const projectedByNodeId = new Map(dependencyProjection.nodes.map((node) => [node.id, node]))
  const legacyExpectedDocument: CanvasDocument = {
    ...baseDocument,
    revision: baseDocument.revision + 1,
    nodes: baseDocument.nodes.map((node) => {
      const projected = projectedByNodeId.get(node.id) ?? node
      return projected.id === 'node-0' && projected.kind === 'image'
        ? { ...projected, adoptedAssetId: 'new-0' }
        : projected
    }),
    updatedAt: 100,
  }
  const expectedGraphSha256 = createTestGraphSha256(legacyExpectedDocument, false)
  fixture.configs.set('node-0', {
    ...fixture.configs.get('node-0')!, revision: 2, adoptedAssetId: 'new-0',
  })
  /** 重启 LOAD 只会返回 parser 重建后的规范字段顺序。 */
  fixture.canvas = parseCanvasDocument(legacyExpectedDocument, fixture.target).document
  fixture.intents.set('operation-legacy-hash', {
    schemaVersion: 1,
    operationId: 'operation-legacy-hash',
    batchId: 'batch-legacy-hash',
    ...fixture.target,
    mode: 'all',
    baseCanvasRevision: baseDocument.revision,
    entries: [{
      nodeId: 'node-0', imageModuleId: 'module-0', oldAssetId: 'old-0',
      candidateAssetId: 'new-0', expectedConfigRevision: 1, committedConfigRevision: 2,
    }],
    expectedGraphSha256,
    state: 'modules-committing',
    createdAt: 100,
    updatedAt: 100,
  })
  return { fixture, legacyExpectedDocument, expectedGraphSha256 }
}

describe('Canvas 图片候选批次 Service', () => {
  test('Given 首次生成且没有默认素材 When 第一张成功 Then 自动设为默认并发布图变化', async () => {
    /** 使用真实 parser 重建，锁定正式图而不是单独的预览选中态。 */
    const fixture = createFixture(true, true)
    await fixture.service.createBatch({
      ...fixture.target, batchId: 'batch-first', source: 'single',
      sourceSessionId: null, sourceToolCallId: null, entries: [fixture.entries[0]!],
    })
    await fixture.service.recordJobTerminal({
      ...fixture.target, candidateBatchId: 'batch-first', jobId: 'job-0',
      status: 'succeeded', outputAssetId: 'first-image', error: null,
    })

    expect(fixture.configs.get('node-0')).toMatchObject({ adoptedAssetId: 'first-image', revision: 2 })
    expect(fixture.canvas.nodes[0]).toMatchObject({ adoptedAssetId: 'first-image' })
    expect(fixture.publications).toHaveLength(1)
    expect(fixture.publications[0]?.document.revision).toBe(fixture.canvas.revision)
    expect(fixture.started).toEqual([])
    expect(fixture.resumeNotifications).toEqual([])
    await fixture.service.adopt({ ...fixture.target, batchId: 'batch-first', mode: 'all' })
    expect(fixture.resumeNotifications).toEqual([fixture.target])
    /** 原生采用文件只接受 UUID，批次的 agent-canvas 哈希身份不能直接复用。 */
    expect([...fixture.intents.values()][0]?.operationId)
      .toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/)
  })

  test('Given 首次批量生成 When 部分成功且部分失败 Then 只为成功的空节点选中素材', async () => {
    /** 失败节点保留为空，不能因自动采用一个节点而关闭整个批次。 */
    const fixture = createFixture(true, true)
    await fixture.service.createBatch({
      ...fixture.target, batchId: 'batch-first-many', source: 'canvas-tool',
      sourceSessionId: 'session-1', sourceToolCallId: 'tool-1', entries: fixture.entries.slice(0, 3),
    })
    for (const index of [1, 0]) {
      await fixture.service.recordJobTerminal({
        ...fixture.target, candidateBatchId: 'batch-first-many', jobId: `job-${index}`,
        status: 'succeeded', outputAssetId: `first-${index}`, error: null,
      })
    }
    await fixture.service.recordJobTerminal({
      ...fixture.target, candidateBatchId: 'batch-first-many', jobId: 'job-2',
      status: 'failed', outputAssetId: null, error: '生成失败',
    })
    expect(fixture.configs.get('node-0')?.adoptedAssetId).toBe('first-0')
    expect(fixture.configs.get('node-1')?.adoptedAssetId).toBe('first-1')
    expect(fixture.configs.get('node-2')?.adoptedAssetId).toBeNull()
    expect((await fixture.service.load({ ...fixture.target, batchId: 'batch-first-many' })).status).toBe('partial')
    expect(fixture.publications).toHaveLength(2)
  })

  test('Given 首次素材已采用 When 重放终态且重新生成 Then 保留第一份默认并避免重复写图', async () => {
    /** 同一空基线的迟到任务也不得覆盖先完成的默认素材。 */
    const fixture = createFixture(true, true)
    for (const [batchId, jobId] of [['batch-first', 'job-0'], ['batch-second', 'job-second']]) {
      await fixture.service.createBatch({
        ...fixture.target, batchId: batchId!, source: 'single', sourceSessionId: null, sourceToolCallId: null,
        entries: [{ ...fixture.entries[0]!, jobId: jobId! }],
      })
    }
    /** 重复成功回调必须幂等。 */
    const event = {
      ...fixture.target, candidateBatchId: 'batch-first', jobId: 'job-0',
      status: 'succeeded' as const, outputAssetId: 'first-image', error: null,
    }
    await fixture.service.recordJobTerminal(event)
    await fixture.service.recordJobTerminal(event)
    await fixture.service.recordJobTerminal({
      ...event, candidateBatchId: 'batch-second', jobId: 'job-second', outputAssetId: 'second-image',
    })
    expect(fixture.configs.get('node-0')).toMatchObject({ adoptedAssetId: 'first-image', revision: 2 })
    expect(fixture.adopted).toEqual(['node-0'])
    expect(fixture.publications).toHaveLength(1)
  })

  test('Given 空节点生成期间配置已修改或批次已放弃 When 结果到达 Then 只保存候选', async () => {
    for (const changed of ['config', 'abandoned']) {
      /** 修改配置意味着当前用户意图已不再等同任务固化的空节点基线。 */
      const fixture = createFixture(true, true)
      await fixture.service.createBatch({
        ...fixture.target, batchId: 'batch-stale-first', source: 'single',
        sourceSessionId: null, sourceToolCallId: null, entries: [fixture.entries[0]!],
      })
      if (changed === 'config') {
        fixture.configs.set('node-0', { ...fixture.configs.get('node-0')!, revision: 2, prompt: '新提示词' })
      } else {
        await fixture.service.abandon({ ...fixture.target, batchId: 'batch-stale-first' })
      }
      await fixture.service.recordJobTerminal({
        ...fixture.target, candidateBatchId: 'batch-stale-first', jobId: 'job-0',
        status: 'succeeded', outputAssetId: 'stale-image', error: null,
      })
      expect(fixture.configs.get('node-0')?.adoptedAssetId).toBeNull()
      expect(fixture.adopted).toEqual([])
      expect(fixture.publications).toEqual([])
    }
  })

  test('Given 已自动首选且原批次还有其他新版本 When 显式整批采用 Then 原批次仍可完成', async () => {
    /** 同批次混合首次生成与已存在素材，自动采用不提前关闭原批次。 */
    const fixture = createFixture(true, true)
    fixture.configs.set('node-1', { ...fixture.configs.get('node-1')!, adoptedAssetId: 'old-1' })
    fixture.canvas = {
      ...fixture.canvas,
      nodes: fixture.canvas.nodes.map((node) => node.id === 'node-1' && node.kind === 'image'
        ? { ...node, adoptedAssetId: 'old-1' } : node),
    }
    await fixture.service.createBatch({
      ...fixture.target, batchId: 'batch-mixed', source: 'canvas-tool', sourceSessionId: 'session-1', sourceToolCallId: 'tool-1',
      entries: [fixture.entries[0]!, { ...fixture.entries[1]!, initialAdoptedAssetId: 'old-1' }],
    })
    for (const index of [0, 1]) {
      await fixture.service.recordJobTerminal({
        ...fixture.target, candidateBatchId: 'batch-mixed', jobId: `job-${index}`,
        status: 'succeeded', outputAssetId: `new-${index}`, error: null,
      })
    }
    expect(fixture.configs.get('node-1')?.adoptedAssetId).toBe('old-1')
    await expect(fixture.service.adopt({ ...fixture.target, batchId: 'batch-mixed', mode: 'all' }))
      .resolves.toMatchObject({ status: 'adopted' })
    expect(fixture.configs.get('node-1')?.adoptedAssetId).toBe('new-1')
    expect(fixture.configs.get('node-0')?.revision).toBe(2)
    expect(fixture.adopted).toEqual(['node-0', 'node-1'])
  })

  test('Given 首选已完成但原批次终态被重放 When 工作流查询采用事实 Then 保留真实采用时间', async () => {
    /** 原批次事件时间可以变化，正式采用时间必须来自独立 receipt。 */
    const fixture = createFixture(true, true)
    await fixture.service.createBatch({
      ...fixture.target, batchId: 'batch-stable-time', source: 'single',
      sourceSessionId: null, sourceToolCallId: null, entries: [fixture.entries[0]!],
    })
    await fixture.service.recordJobTerminal({
      ...fixture.target, candidateBatchId: 'batch-stable-time', jobId: 'job-0',
      status: 'succeeded', outputAssetId: 'first-image', error: null,
    })
    /** 模拟恢复重新登记原候选，其更新时间不再等于首次采用时间。 */
    fixture.batches.set('batch-stable-time', { ...fixture.batches.get('batch-stable-time')!, updatedAt: 999 })
    expect(await fixture.service.getCandidateAdoption({
      ...fixture.target, batchId: 'batch-stable-time', nodeId: 'node-0', jobId: 'job-0',
    })).toEqual({ assetId: 'first-image', committedAt: 100 })
    fixture.configs.set('node-0', { ...fixture.configs.get('node-0')!, adoptedAssetId: 'different-image' })
    expect(await fixture.service.getCandidateAdoption({
      ...fixture.target, batchId: 'batch-stable-time', nodeId: 'node-0', jobId: 'job-0',
    })).toBeNull()
  })

  test('Given 全部候选已自动选中 When 整批采用及失败恢复 Then 不重复写入模块或画布', async () => {
    for (const failReceipt of [false, true]) {
      /** 全部候选均为首次成功，之后的验收只确认批次，不改变正式素材。 */
      const fixture = createFixture(true, true)
      await fixture.service.createBatch({
        ...fixture.target, batchId: 'batch-already-selected', source: 'single',
        sourceSessionId: null, sourceToolCallId: null, entries: [fixture.entries[0]!],
      })
      await fixture.service.recordJobTerminal({
        ...fixture.target, candidateBatchId: 'batch-already-selected', jobId: 'job-0',
        status: 'succeeded', outputAssetId: 'first-image', error: null,
      })
      /** 完整图快照同时锁定 revision、内容和下游提示，防止无内容写入。 */
      const selectedDocument = structuredClone(fixture.canvas)
      const save = fixture.store.save
      const failure = spyOn(fixture.store, 'save').mockImplementation(async (batch) => {
        if (failReceipt && batch.status === 'adopted') throw new Error('BATCH_WRITE_FAILED')
        return save(batch)
      })
      const adoption = fixture.service.adopt({ ...fixture.target, batchId: 'batch-already-selected', mode: 'all' })
      if (failReceipt) {
        await expect(adoption).rejects.toThrow('CANVAS_IMAGE_BATCH_RECOVERY_REQUIRED')
        failure.mockRestore()
        expect((await fixture.service.reconcile(fixture.target)).error).toBeUndefined()
      } else {
        await expect(adoption).resolves.toMatchObject({ status: 'adopted' })
        failure.mockRestore()
      }
      expect(fixture.canvas).toEqual(selectedDocument)
      expect(fixture.configs.get('node-0')?.revision).toBe(2)
      expect(fixture.adopted).toEqual(['node-0'])
      expect((await fixture.service.load({ ...fixture.target, batchId: 'batch-already-selected' })).status).toBe('adopted')
    }
  })

  test('Given 首次失败后重试成功 When replacement 返回素材 Then 自动选择首份成功素材', async () => {
    /** 失败不占据默认版本；重试沿原批次空基线完成首次采用。 */
    const fixture = createFixture(true, true)
    await fixture.service.createBatch({
      ...fixture.target, batchId: 'batch-retry-first', source: 'single',
      sourceSessionId: null, sourceToolCallId: null, entries: [fixture.entries[0]!],
    })
    await fixture.service.recordJobTerminal({
      ...fixture.target, candidateBatchId: 'batch-retry-first', jobId: 'job-0',
      status: 'failed', outputAssetId: null, error: '失败',
    })
    await fixture.service.retryJob({ ...fixture.target, batchId: 'batch-retry-first', nodeId: 'node-0', imageModuleId: 'module-0', jobId: 'job-0' })
    await fixture.service.recordJobTerminal({
      ...fixture.target, candidateBatchId: 'batch-retry-first', jobId: 'job-0-retry',
      status: 'succeeded', outputAssetId: 'first-retry', error: null,
    })
    expect(fixture.configs.get('node-0')?.adoptedAssetId).toBe('first-retry')
  })

  test('Given 启动时补登记历史成功任务 When 历史从未手动采用 Then 保留旧选择并且不自动回填', async () => {
    /** 启动恢复历史候选不等同本次首次生成，避免按磁盘枚举顺序选择旧素材。 */
    const fixture = createFixture(true, true)
    await fixture.service.createBatch({
      ...fixture.target, batchId: 'batch-history-first', source: 'single',
      sourceSessionId: null, sourceToolCallId: null, entries: [fixture.entries[0]!],
    })
    await fixture.service.recordJobTerminal({
      ...fixture.target, candidateBatchId: 'batch-history-first', jobId: 'job-0',
      status: 'succeeded', outputAssetId: 'history-image', error: null, skipInitialAdoption: true,
    })
    expect(fixture.configs.get('node-0')?.adoptedAssetId).toBeNull()
    expect(fixture.adopted).toEqual([])
    expect(fixture.publications).toEqual([])
  })

  test('Given 首次采用图已提交但批次终态写失败 When 重放终态 Then 先发布已提交图并幂等恢复', async () => {
    /** 注入一次批次终态持久化故障，模拟图片已显示但 receipt 尚未收口的崩溃窗口。 */
    const fixture = createFixture(true, true)
    await fixture.service.createBatch({
      ...fixture.target, batchId: 'batch-crash-first', source: 'single',
      sourceSessionId: null, sourceToolCallId: null, entries: [fixture.entries[0]!],
    })
    /** 保留真实内存 Store 的写入语义，只在 adopted 批次落盘前拒绝。 */
    const save = fixture.store.save
    const failure = spyOn(fixture.store, 'save').mockImplementation(async (batch) => {
      if (batch.status === 'adopted') throw new Error('BATCH_WRITE_FAILED')
      return save(batch)
    })
    const event = {
      ...fixture.target, candidateBatchId: 'batch-crash-first', jobId: 'job-0',
      status: 'succeeded' as const, outputAssetId: 'first-image', error: null,
    }
    await expect(fixture.service.recordJobTerminal(event)).rejects.toThrow('CANVAS_IMAGE_BATCH_RECOVERY_REQUIRED')
    expect(fixture.canvas.nodes[0]).toMatchObject({ adoptedAssetId: 'first-image' })
    expect(fixture.publications).toHaveLength(1)
    failure.mockRestore()
    await fixture.service.recordJobTerminal(event)
    expect(fixture.configs.get('node-0')).toMatchObject({ adoptedAssetId: 'first-image', revision: 2 })
    expect(fixture.adopted).toEqual(['node-0'])
    expect([...fixture.intents.values()].every((intent) => intent.state === 'batch-committed')).toBe(true)
    expect(fixture.resumeNotifications).toEqual([])
  })

  test('Given 真实 Store 重建新增下游提示的字段顺序 When 采用后用户合法编辑并 LOAD reconcile Then 不再阻断', async () => {
    /** 开启读写规范化，覆盖原内存夹具未模拟的生产边界。 */
    const fixture = createFixture(true)
    fixture.canvas = {
      ...fixture.canvas,
      nodes: [...fixture.canvas.nodes, {
        id: 'downstream-normalized', kind: 'document', title: '下游文档',
        position: { x: 0, y: 100 }, documentId: 'document-normalized', contentRevision: 1,
      }],
      edges: [{
        id: 'edge-normalized', sourceNodeId: 'node-0', sourcePort: 'image.asset',
        targetNodeId: 'downstream-normalized', targetPort: 'context.image', relation: 'depends-on',
      }],
    }
    await fixture.service.createBatch({
      ...fixture.target, batchId: 'batch-normalized', source: 'single',
      sourceSessionId: null, sourceToolCallId: null, entries: [fixture.entries[0]!],
    })
    await fixture.service.recordJobTerminal({
      ...fixture.target, jobId: 'job-0', status: 'succeeded', outputAssetId: 'new-0', error: null,
    })

    await expect(fixture.service.adopt({
      ...fixture.target, batchId: 'batch-normalized', mode: 'all',
    })).resolves.toMatchObject({ status: 'adopted' })
    expect(fixture.intents.get('operation-1')?.state).toBe('batch-committed')
    expect(fixture.canvas.nodes.find((node) => node.id === 'downstream-normalized')?.upstreamChange)
      .toEqual({ sourceNodeIds: ['node-0'], changedAt: 100 })
    expect(fixture.adopted).toEqual(['node-0'])

    /** 模拟采用完成后的合法用户编辑；已完成 intent 不得把后续 revision 当作恢复漂移。 */
    fixture.canvas = parseCanvasDocument({
      ...fixture.canvas,
      revision: fixture.canvas.revision + 1,
      viewport: { x: 24, y: 12, zoom: 1.25 },
      updatedAt: 101,
    }, fixture.target).document
    await expect(fixture.service.reconcile(fixture.target)).resolves.toEqual({ publications: [] })
    expect(fixture.canvas).toMatchObject({
      revision: 5,
      viewport: { x: 24, y: 12, zoom: 1.25 },
    })
  })

  test('Given 调用方已持 Canvas 串行权 When reconcileLocked Then 不重复获取非重入锁', async () => {
    const fixture = createFixture()

    await expect(fixture.service.reconcileLocked(fixture.target)).resolves.toEqual({ publications: [] })

    expect(fixture.exclusiveCalls).toBe(0)
  })

  test('Given 候选预检等待期间撤权 When Agent 采用 Then intent 和正式版本都不写入', async () => {
    /** 在真实服务的异步预检阶段撤销 Host 授权。 */
    let authorized = true
    const fixture = createFixture({ validateCandidate: async () => {
      await Promise.resolve()
      authorized = false
    } })
    await fixture.service.createBatch({
      ...fixture.target, batchId: 'batch-revoked', source: 'canvas-tool',
      sourceSessionId: 'session-1', sourceToolCallId: 'tool-revoked', entries: [fixture.entries[0]!],
    })
    await fixture.service.recordJobTerminal({
      ...fixture.target, jobId: 'job-0', candidateBatchId: 'batch-revoked',
      status: 'succeeded', outputAssetId: 'asset-new', error: null,
    })
    const batch = await fixture.service.load({ ...fixture.target, batchId: 'batch-revoked' })
    await expect(fixture.service.adopt({ ...fixture.target, batchId: 'batch-revoked', mode: 'all' },
      createCanvasImageCandidateHash(batch), () => {
        if (!authorized) throw new Error('ACCESS_REVOKED')
      })).rejects.toThrow('ACCESS_REVOKED')
    expect(fixture.intents.size).toBe(0)
    expect(fixture.adopted).toEqual([])
    expect(fixture.canvas.revision).toBe(3)
  })

  test('Given Agent 持有旧候选指纹 When 采用 Then 在任何版本写入前拒绝', async () => {
    /** 单节点候选用于证明指纹校验发生于事务边界。 */
    const fixture = createFixture()
    await fixture.service.createBatch({
      ...fixture.target, batchId: 'batch-token', source: 'canvas-tool',
      sourceSessionId: 'session-1', sourceToolCallId: 'tool-token', entries: [fixture.entries[0]!],
    })
    await fixture.service.recordJobTerminal({
      ...fixture.target, jobId: 'job-0', candidateBatchId: 'batch-token',
      status: 'succeeded', outputAssetId: 'asset-new', error: null,
    })
    await expect(fixture.service.adopt({
      ...fixture.target, batchId: 'batch-token', mode: 'all',
    }, '0'.repeat(64))).rejects.toThrow('CANVAS_IMAGE_CANDIDATES_CHANGED')
    expect(fixture.adopted).toEqual([])
    expect(fixture.intents.size).toBe(0)
    /** 精确指纹允许同一采用请求重放，而不会再次推进正式版本。 */
    const batch = await fixture.service.load({ ...fixture.target, batchId: 'batch-token' })
    const hash = createCanvasImageCandidateHash(batch)
    await expect(fixture.service.adopt({ ...fixture.target, batchId: 'batch-token', mode: 'all' }, hash,
      () => { throw new Error('ACCESS_REVOKED') })).rejects.toThrow('ACCESS_REVOKED')
    expect(fixture.adopted).toEqual([])
    const first = await fixture.service.adopt({ ...fixture.target, batchId: 'batch-token', mode: 'all' }, hash)
    const replay = await fixture.service.adopt({ ...fixture.target, batchId: 'batch-token', mode: 'all' }, hash)
    expect(replay).toEqual(first)
    expect(fixture.adopted).toEqual(['node-0'])
  })

  test('Given 首个批次监听器抛错 When Job 终态完成登记 Then 持久化成功且继续通知后续监听器', async () => {
    const fixture = createFixture()
    await fixture.service.createBatch({
      ...fixture.target, batchId: 'batch-event', source: 'canvas-tool',
      sourceSessionId: 'session-1', sourceToolCallId: 'tool-event', entries: [fixture.entries[0]!],
    })
    /** 隔离预期中文错误日志，避免失败监听器污染测试输出。 */
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {
      throw new Error('LOGGER_FAILED')
    })
    const observedStatuses: string[] = []
    fixture.service.onChanged(() => { throw new Error('credential=secret') })
    const unsubscribe = fixture.service.onChanged((event) => {
      /** 事件回调触发时，内存 store 必须已经持有可重读的权威终态。 */
      observedStatuses.push(fixture.batches.get(event.batchId)?.entries[0]?.status ?? 'missing')
    })

    try {
      await expect(fixture.service.recordJobTerminal({
        ...fixture.target, jobId: 'job-0', candidateBatchId: 'batch-event',
        status: 'succeeded', outputAssetId: 'asset-event', error: null,
      })).resolves.toBeUndefined()
      expect(observedStatuses).toEqual(['candidate'])
      expect(fixture.batches.get('batch-event')?.entries[0]).toMatchObject({
        status: 'candidate', candidateAssetId: 'asset-event',
      })
      expect(errorSpy).toHaveBeenCalledWith('[CanvasImageDiagnostics] CANVAS_IMAGE_BATCH_LISTENER_FAILED')
      expect(JSON.stringify(errorSpy.mock.calls)).not.toContain('credential=secret')
    } finally {
      unsubscribe()
      errorSpy.mockRestore()
    }
  })

  test('Given 14 节点 When 仅 2 个成功 Then partial 且不采用任何正式版本', async () => {
    const fixture = createFixture()
    const before = structuredClone(fixture.canvas)
    await fixture.service.createBatch({
      ...fixture.target, batchId: 'batch-1', source: 'canvas-tool',
      sourceSessionId: 'session-1', sourceToolCallId: 'tool-1', entries: fixture.entries,
    })
    await fixture.service.recordJobTerminal({ ...fixture.target, jobId: 'job-0', status: 'succeeded', outputAssetId: 'new-0', error: null })
    await fixture.service.recordJobTerminal({ ...fixture.target, jobId: 'job-1', status: 'succeeded', outputAssetId: 'new-1', error: null })
    for (let index = 2; index < 14; index += 1) {
      await fixture.service.recordJobTerminal({ ...fixture.target, jobId: `job-${index}`, status: 'failed', outputAssetId: null, error: '失败' })
    }
    const batch = await fixture.service.load({ ...fixture.target, batchId: 'batch-1' })
    expect(batch.status).toBe('partial')
    expect(batch.entries.filter((entry) => entry.status === 'candidate')).toHaveLength(2)
    expect(fixture.adopted).toEqual([])
    expect(fixture.dependencyProjectionCalls).toBe(0)
    expect(fixture.canvas).toEqual(before)
  })

  test('Given 配置基线已变化 When adopt all Then 冲突且零写入', async () => {
    const fixture = createFixture()
    await fixture.service.createBatch({
      ...fixture.target, batchId: 'batch-1', source: 'single',
      sourceSessionId: null, sourceToolCallId: null, entries: [fixture.entries[0]!],
    })
    await fixture.service.recordJobTerminal({ ...fixture.target, jobId: 'job-0', status: 'succeeded', outputAssetId: 'new-0', error: null })
    fixture.configs.get('node-0')!.revision = 2
    await expect(fixture.service.adopt({ ...fixture.target, batchId: 'batch-1', mode: 'all' }))
      .rejects.toThrow('CANVAS_IMAGE_BATCH_CONFLICT')
    expect(fixture.adopted).toEqual([])
  })

  test('Given 失败条目 When continue Then replacement Job 身份写回批次供终态定位', async () => {
    const fixture = createFixture()
    await fixture.service.createBatch({
      ...fixture.target, batchId: 'batch-1', source: 'single',
      sourceSessionId: null, sourceToolCallId: null, entries: [fixture.entries[0]!],
    })
    await fixture.service.recordJobTerminal({
      ...fixture.target, jobId: 'job-0', status: 'failed', outputAssetId: null, error: '失败',
    })

    const continued = await fixture.service.continueBatch({ ...fixture.target, batchId: 'batch-1' })

    expect(fixture.retried).toEqual(['job-0'])
    expect(fixture.started).toEqual(['job-0-retry'])
    expect(continued.entries[0]).toMatchObject({ jobId: 'job-0-retry', status: 'queued' })
    await expect(fixture.service.recordJobTerminal({
      ...fixture.target, jobId: 'job-0-retry', status: 'succeeded', outputAssetId: 'asset-new', error: null,
    })).resolves.toBeUndefined()
  })

  test('Given 多条失败记录 When 定向重试一条 Then 仅替换目标 Job 且保存后再启动', async () => {
    const fixture = createFixture()
    await fixture.service.createBatch({
      ...fixture.target, batchId: 'batch-1', source: 'canvas-tool',
      sourceSessionId: 'session-1', sourceToolCallId: 'tool-1', entries: fixture.entries.slice(0, 2),
    })
    for (const jobId of ['job-0', 'job-1']) {
      await fixture.service.recordJobTerminal({
        ...fixture.target, jobId, status: 'failed', outputAssetId: null, error: '失败',
      })
    }

    const replacementJobId = await fixture.service.retryJob({
      ...fixture.target, batchId: 'batch-1', nodeId: 'node-0', imageModuleId: 'module-0', jobId: 'job-0',
    })

    expect(replacementJobId).toBe('job-0-retry')
    expect(fixture.retried).toEqual(['job-0'])
    expect(fixture.started).toEqual(['job-0-retry'])
    expect((await fixture.service.load({ ...fixture.target, batchId: 'batch-1' })).entries).toMatchObject([
      { nodeId: 'node-0', jobId: 'job-0-retry', status: 'queued' },
      { nodeId: 'node-1', jobId: 'job-1', status: 'failed' },
    ])
  })

  test('Given 单节点批次文件缺失且任务已有输出 When 登记终态 Then 重建批次并保留候选', async () => {
    const fixture = createFixture()

    await fixture.service.recordJobTerminal({
      ...fixture.target,
      jobId: 'job-retry',
      candidateBatchId: 'batch-missing',
      status: 'succeeded',
      outputAssetId: 'asset-new',
      error: null,
      singleBatchRecovery: {
        nodeId: 'node-0',
        imageModuleId: 'module-0',
        initialAdoptedAssetId: 'old-0',
        initialConfigRevision: 1,
      },
    })

    expect(await fixture.service.load({ ...fixture.target, batchId: 'batch-missing' })).toMatchObject({
      source: 'single',
      status: 'ready',
      entries: [{
        nodeId: 'node-0', imageModuleId: 'module-0', jobId: 'job-retry',
        candidateAssetId: 'asset-new', status: 'candidate',
      }],
    })
  })

  test('Given 单节点批次仍指向旧失败 Job When replacement 成功 Then 修复 Job 身份并保留新候选', async () => {
    const fixture = createFixture()
    await fixture.service.createBatch({
      ...fixture.target, batchId: 'batch-stale', source: 'single',
      sourceSessionId: null, sourceToolCallId: null, entries: [fixture.entries[0]!],
    })
    await fixture.service.recordJobTerminal({
      ...fixture.target, jobId: 'job-0', status: 'cancelled', outputAssetId: null, error: null,
    })

    await fixture.service.recordJobTerminal({
      ...fixture.target,
      jobId: 'job-retry',
      candidateBatchId: 'batch-stale',
      status: 'succeeded',
      outputAssetId: 'asset-new',
      error: null,
      singleBatchRecovery: {
        nodeId: 'node-0', imageModuleId: 'module-0',
        initialAdoptedAssetId: 'old-0', initialConfigRevision: 1,
      },
    })

    expect(await fixture.service.load({ ...fixture.target, batchId: 'batch-stale' })).toMatchObject({
      status: 'ready',
      entries: [{ jobId: 'job-retry', candidateAssetId: 'asset-new', status: 'candidate' }],
    })
  })

  test('Given 缺失批次的旧失败 attempt 携带恢复基线 When 登记终态 Then 仍拒绝创建批次', async () => {
    const fixture = createFixture()

    await expect(fixture.service.recordJobTerminal({
      ...fixture.target,
      jobId: 'job-old',
      candidateBatchId: 'batch-missing',
      status: 'cancelled',
      outputAssetId: null,
      error: null,
      singleBatchRecovery: {
        nodeId: 'node-0', imageModuleId: 'module-0',
        initialAdoptedAssetId: 'old-0', initialConfigRevision: 1,
      },
    })).rejects.toThrow('CANVAS_IMAGE_BATCH_JOB_NOT_FOUND')
  })

  test('Given 旧单节点失败任务的批次文件缺失 When 定向重试 Then 先重建失败条目再替换 Job', async () => {
    const fixture = createFixture()

    const replacementJobId = await fixture.service.retryJob({
      ...fixture.target,
      batchId: 'batch-missing',
      nodeId: 'node-0',
      imageModuleId: 'module-0',
      jobId: 'job-0',
      singleBatchRecovery: {
        nodeId: 'node-0', imageModuleId: 'module-0',
        initialAdoptedAssetId: 'old-0', initialConfigRevision: 1,
      },
    })

    expect(replacementJobId).toBe('job-0-retry')
    expect(await fixture.service.load({ ...fixture.target, batchId: 'batch-missing' })).toMatchObject({
      status: 'running', entries: [{ jobId: 'job-0-retry', status: 'queued' }],
    })
  })

  test('Given 批次文件缺失但没有单节点恢复证据 When 登记终态 Then 拒绝猜测重建', async () => {
    const fixture = createFixture()

    await expect(fixture.service.recordJobTerminal({
      ...fixture.target,
      jobId: 'job-unknown',
      candidateBatchId: 'batch-missing',
      status: 'succeeded',
      outputAssetId: 'asset-new',
      error: null,
    })).rejects.toThrow('CANVAS_IMAGE_BATCH_JOB_NOT_FOUND')
    await expect(fixture.service.load({ ...fixture.target, batchId: 'batch-missing' }))
      .rejects.toThrow('CANVAS_IMAGE_BATCH_NOT_FOUND')
  })

  test('Given 2 成功 12 失败 When adopt succeeded Then 明确记录 adopted 与 kept', async () => {
    const fixture = createFixture()
    await fixture.service.createBatch({
      ...fixture.target, batchId: 'batch-1', source: 'canvas-tool',
      sourceSessionId: 'session-1', sourceToolCallId: 'tool-1', entries: fixture.entries,
    })
    for (let index = 0; index < 14; index += 1) {
      await fixture.service.recordJobTerminal({
        ...fixture.target,
        jobId: `job-${index}`,
        status: index < 2 ? 'succeeded' : 'failed',
        outputAssetId: index < 2 ? `new-${index}` : null,
        error: index < 2 ? null : '失败',
      })
    }

    const result = await fixture.service.adopt({ ...fixture.target, batchId: 'batch-1', mode: 'succeeded' })

    expect(result.adoption).toMatchObject({ mode: 'succeeded' })
    expect(result.adoption?.adoptedNodeIds).toEqual(['node-0', 'node-1'])
    expect(result.adoption?.keptNodeIds).toHaveLength(12)
    expect(fixture.canvas.nodes.slice(0, 2).map((node) => node.kind === 'image' ? node.adoptedAssetId : null))
      .toEqual(['new-0', 'new-1'])
  })

  test('Given 四类直接下游 When adopt Then 只标记数据关系并排除 association', async () => {
    const fixture = createFixture()
    /** producer 在正式采用前仍背负旧上游提示，采用后必须一并消费。 */
    fixture.canvas.nodes[0] = {
      ...fixture.canvas.nodes[0]!,
      upstreamChange: { sourceNodeIds: ['older-source'], changedAt: 20 },
    }
    const downstreamKinds = ['reference', 'depends-on', 'derives', 'association'] as const
    /** 为每种关系追加一个独立文档节点，便于断言结构化提示。 */
    const downstreamNodes: CanvasNode[] = downstreamKinds.map((relation, index) => ({
      id: `downstream-${relation}`,
      kind: 'document',
      title: relation,
      position: { x: index * 10, y: 100 },
      documentId: `document-${index}`,
      contentRevision: 0,
    }))
    fixture.canvas = {
      ...fixture.canvas,
      nodes: [...fixture.canvas.nodes, ...downstreamNodes],
      edges: downstreamKinds.map((relation) => ({
        id: `edge-${relation}`,
        sourceNodeId: 'node-0',
        sourcePort: relation === 'association' ? 'unbound' : 'image.asset',
        targetNodeId: `downstream-${relation}`,
        targetPort: relation === 'association' ? 'unbound' : 'context.image',
        relation,
      })),
    }
    await fixture.service.createBatch({
      ...fixture.target, batchId: 'batch-1', source: 'single',
      sourceSessionId: null, sourceToolCallId: null, entries: [fixture.entries[0]!],
    })
    await fixture.service.recordJobTerminal({
      ...fixture.target, jobId: 'job-0', status: 'succeeded', outputAssetId: 'new-0', error: null,
    })

    const result = await fixture.service.adopt({ ...fixture.target, batchId: 'batch-1', mode: 'all' })

    expect(result.adoption?.invalidatedDownstreamNodeIds).toEqual([
      'downstream-depends-on', 'downstream-derives', 'downstream-reference',
    ])
    const changes = new Map(fixture.canvas.nodes.map((node) => [node.id, node.upstreamChange]))
    expect(changes.get('node-0')).toBeUndefined()
    expect(changes.get('downstream-reference')?.sourceNodeIds).toEqual(['node-0'])
    expect(changes.get('downstream-association')).toBeUndefined()
  })

  test('Given 正式采用同时存在绑定边和旧引用边 When 提交 Then 只标记绑定下游', async () => {
    const fixture = createFixture()
    fixture.canvas.nodes.push({
      id: 'downstream-bound', kind: 'document', title: '已绑定下游',
      position: { x: 0, y: 100 }, documentId: 'document-bound', contentRevision: 0,
    }, {
      id: 'downstream-legacy', kind: 'document', title: '旧边下游',
      position: { x: 100, y: 100 }, documentId: 'document-legacy', contentRevision: 0,
    })
    fixture.canvas.edges = [{
      id: 'edge-bound', sourceNodeId: 'node-0', sourcePort: 'image.asset',
      targetNodeId: 'downstream-bound', targetPort: 'context.image', relation: 'depends-on',
    }, {
      id: 'edge-legacy', sourceNodeId: 'node-0', sourcePort: 'output',
      targetNodeId: 'downstream-legacy', targetPort: 'input', relation: 'reference',
    }]
    await fixture.service.createBatch({
      ...fixture.target, batchId: 'batch-bound', source: 'single',
      sourceSessionId: null, sourceToolCallId: null, entries: [fixture.entries[0]!],
    })
    await fixture.service.recordJobTerminal({
      ...fixture.target, jobId: 'job-0', status: 'succeeded',
      outputAssetId: 'new-0', error: null,
    })

    const result = await fixture.service.adopt({
      ...fixture.target, batchId: 'batch-bound', mode: 'all',
    })

    expect(result.adoption?.invalidatedDownstreamNodeIds).toEqual(['downstream-bound'])
    expect(fixture.canvas.nodes.find((node) => node.id === 'downstream-legacy')?.upstreamChange)
      .toBeUndefined()
  })

  test('Given 已验证历史素材 When 已持锁采用 Then 复用候选事务并更新绑定下游', async () => {
    const fixture = createFixture()
    fixture.canvas.nodes.push({
      id: 'downstream-bound', kind: 'document', title: '已绑定下游',
      position: { x: 0, y: 100 }, documentId: 'document-bound', contentRevision: 0,
    })
    fixture.canvas.edges = [{
      id: 'edge-bound', sourceNodeId: 'node-0', sourcePort: 'image.asset',
      targetNodeId: 'downstream-bound', targetPort: 'context.image', relation: 'reference',
    }]

    const result = await fixture.service.adoptExistingAssetLocked({
      ...fixture.target,
      nodeId: 'node-0',
      imageModuleId: 'module-0',
      jobId: 'job-history',
      assetId: 'asset-history',
      currentAssetId: 'old-0',
      currentConfigRevision: 1,
      batchId: 'batch-history',
    })

    expect(result).toMatchObject({
      status: 'adopted',
      adoption: {
        adoptedNodeIds: ['node-0'],
        invalidatedDownstreamNodeIds: ['downstream-bound'],
      },
    })
    expect(fixture.configs.get('node-0')).toMatchObject({
      revision: 2,
      adoptedAssetId: 'asset-history',
    })
    expect(fixture.canvas.nodes.find((node) => node.id === 'node-0')).toMatchObject({
      adoptedAssetId: 'asset-history',
    })
  })

  test('Given 历史素材采用已提交且用户后来改动节点 When 同 batchId 重放 Then 返回原 receipt 且不回退当前事实', async () => {
    const fixture = createFixture()
    const input = {
      ...fixture.target,
      nodeId: 'node-0',
      imageModuleId: 'module-0',
      jobId: 'job-history',
      assetId: 'asset-history',
      currentAssetId: 'old-0',
      currentConfigRevision: 1,
      batchId: 'batch-history-replay',
    }
    const first = await fixture.service.adoptExistingAssetLocked(input)
    /** 模拟原操作完成后用户又采用了其它素材，重放不得写回旧值。 */
    fixture.configs.set('node-0', {
      ...fixture.configs.get('node-0')!,
      revision: 3,
      adoptedAssetId: 'asset-later',
    })
    fixture.canvas = {
      ...fixture.canvas,
      revision: fixture.canvas.revision + 1,
      nodes: fixture.canvas.nodes.map((node) => node.id === 'node-0' && node.kind === 'image'
        ? { ...node, adoptedAssetId: 'asset-later' }
        : node),
    }
    const beforeReplayCanvas = structuredClone(fixture.canvas)
    const beforeReplayConfig = structuredClone(fixture.configs.get('node-0'))

    const replay = await fixture.service.adoptExistingAssetLocked({
      ...input,
      /** IPC 重放时只能读取当前素材，但必须继续传原请求的 expected revision。 */
      currentAssetId: 'asset-later',
    })

    expect(replay).toEqual(first)
    expect(fixture.configs.get('node-0')).toEqual(beforeReplayConfig)
    expect(fixture.canvas).toEqual(beforeReplayCanvas)
    expect(fixture.adopted).toEqual(['node-0'])
  })

  test('Given 历史素材批次已保存 ready 但采用响应中断 When 同 batchId 重放 Then 从原候选继续提交', async () => {
    const fixture = createFixture()
    const batchId = 'batch-history-ready'
    await fixture.service.createBatchLocked({
      ...fixture.target,
      batchId,
      source: 'single',
      sourceSessionId: null,
      sourceToolCallId: null,
      entries: [{
        nodeId: 'node-0', imageModuleId: 'module-0',
        initialAdoptedAssetId: 'old-0', initialConfigRevision: 1,
        jobId: 'job-history',
      }],
    })
    const created = fixture.batches.get(batchId)!
    fixture.batches.set(batchId, {
      ...created,
      status: 'ready',
      entries: [{
        ...created.entries[0]!,
        candidateAssetId: 'asset-history',
        status: 'candidate',
      }],
    })

    const result = await fixture.service.adoptExistingAssetLocked({
      ...fixture.target,
      nodeId: 'node-0', imageModuleId: 'module-0', jobId: 'job-history',
      assetId: 'asset-history', currentAssetId: 'old-0', currentConfigRevision: 1,
      batchId,
    })

    expect(result.status).toBe('adopted')
    expect(fixture.adopted).toEqual(['node-0'])
  })

  test('Given 下游已有 128 个来源 When 正式采用新增来源 Then 在 intent 和模块写入前稳定拒绝', async () => {
    const fixture = createFixture()
    const downstream: CanvasNode = {
      id: 'downstream-limit', kind: 'document', title: '来源上限', position: { x: 0, y: 100 },
      documentId: 'document-limit', contentRevision: 1,
      upstreamChange: {
        sourceNodeIds: Array.from({ length: 128 }, (_, index) => `source-${index.toString().padStart(3, '0')}`),
        changedAt: 80,
      },
    }
    fixture.canvas = {
      ...fixture.canvas,
      nodes: [...fixture.canvas.nodes, downstream],
      edges: [{
        id: 'edge-limit', sourceNodeId: 'node-0', sourcePort: 'image.asset',
        targetNodeId: downstream.id, targetPort: 'context.image', relation: 'depends-on',
      }],
    }
    await fixture.service.createBatch({
      ...fixture.target, batchId: 'batch-limit', source: 'single',
      sourceSessionId: null, sourceToolCallId: null, entries: [fixture.entries[0]!],
    })
    await fixture.service.recordJobTerminal({
      ...fixture.target, jobId: 'job-0', status: 'succeeded', outputAssetId: 'new-0', error: null,
    })
    /** adoption 前的全部权威事实用于证明溢出是零副作用预检。 */
    const beforeCanvas = structuredClone(fixture.canvas)
    const beforeConfig = structuredClone(fixture.configs.get('node-0'))
    const beforeBatch = structuredClone(fixture.batches.get('batch-limit'))

    await expect(fixture.service.adopt({
      ...fixture.target, batchId: 'batch-limit', mode: 'all',
    })).rejects.toThrow('CANVAS_DEPENDENCY_SOURCE_LIMIT_EXCEEDED')

    expect(fixture.intents.size).toBe(0)
    expect(fixture.adopted).toEqual([])
    expect(fixture.started).toEqual([])
    expect(fixture.retried).toEqual([])
    expect(fixture.configs.get('node-0')).toEqual(beforeConfig)
    expect(fixture.batches.get('batch-limit')).toEqual(beforeBatch)
    expect(fixture.canvas).toEqual(beforeCanvas)
  })

  test('Given 图片节点与旧来源只在标点上不同 When 采用并重复恢复 Then 图可解析且 intent 哈希确定', async () => {
    const fixture = createFixture()
    const downstream: CanvasNode = {
      id: 'downstream-case', kind: 'document', title: '排序下游', position: { x: 0, y: 100 },
      documentId: 'document-case', contentRevision: 1,
      upstreamChange: { sourceNodeIds: ['node_0'], changedAt: 80 },
    }
    fixture.canvas = {
      ...fixture.canvas,
      nodes: [...fixture.canvas.nodes, downstream],
      edges: [{
        id: 'edge-case', sourceNodeId: 'node-0', sourcePort: 'image.asset',
        targetNodeId: downstream.id, targetPort: 'context.image', relation: 'depends-on',
      }],
    }
    await fixture.service.createBatch({
      ...fixture.target, batchId: 'batch-case', source: 'single',
      sourceSessionId: null, sourceToolCallId: null, entries: [fixture.entries[0]!],
    })
    await fixture.service.recordJobTerminal({
      ...fixture.target, jobId: 'job-0', status: 'succeeded', outputAssetId: 'new-0', error: null,
    })

    await expect(fixture.service.adopt({
      ...fixture.target, batchId: 'batch-case', mode: 'all',
    })).resolves.toMatchObject({ status: 'adopted' })
    /** 首次采用固化的图哈希用于证明重复恢复不会漂移。 */
    const expectedGraphSha256 = fixture.intents.get('operation-1')?.expectedGraphSha256
    /** 首次采用后的 revision 用于证明重复恢复不产生额外提交。 */
    const adoptedRevision = fixture.canvas.revision

    expect(() => parseCanvasDocument(fixture.canvas, fixture.target)).not.toThrow()
    expect(fixture.canvas.nodes.find((node) => node.id === downstream.id)?.upstreamChange)
      .toEqual({ sourceNodeIds: ['node-0', 'node_0'], changedAt: 100 })

    await fixture.service.reconcile(fixture.target)
    await fixture.service.reconcile(fixture.target)

    expect(fixture.intents.get('operation-1')?.expectedGraphSha256).toBe(expectedGraphSha256)
    expect(fixture.canvas.revision).toBe(adoptedRevision)
    expect(fixture.configs.get('node-0')?.revision).toBe(2)
  })

  test.each([false, true])('Given 旧字段顺序的采用事务 When 规范化后恢复且内容篡改=%s Then 只接受完整原图证明', async (tampered) => {
    /** 从真实 parser 基线构造旧版本尚未规范化的提交 hash。 */
    const fixture = createFixture()
    fixture.canvas = parseCanvasDocument({ ...fixture.canvas,
      nodes: [...fixture.canvas.nodes, { id: 'legacy-downstream', kind: 'document', title: '旧版下游',
        position: { x: 0, y: 100 }, documentId: 'legacy-doc', contentRevision: 1 }],
      edges: [{ id: 'legacy-edge', sourceNodeId: 'node-0', sourcePort: 'image.asset',
        targetNodeId: 'legacy-downstream', targetPort: 'context.image', relation: 'depends-on' }],
    }, fixture.target).document
    await fixture.service.createBatch({ ...fixture.target, batchId: 'legacy-batch', source: 'single',
      sourceSessionId: null, sourceToolCallId: null, entries: [fixture.entries[0]!] })
    await fixture.service.recordJobTerminal({ ...fixture.target, jobId: 'job-0', status: 'succeeded', outputAssetId: 'new-0', error: null })
    const baseRevision = fixture.canvas.revision
    const legacyGraph: CanvasDocument = { ...fixture.canvas, revision: baseRevision + 1,
      nodes: fixture.canvas.nodes.map((node) => node.id === 'node-0' && node.kind === 'image'
        ? { ...node, adoptedAssetId: 'new-0' }
        : node.id === 'legacy-downstream'
          ? { ...node, upstreamChange: { sourceNodeIds: ['node-0'], changedAt: 100 } }
          : node),
      updatedAt: 100,
    }
    const legacyHash = createHash('sha256').update(JSON.stringify({ viewport: legacyGraph.viewport,
      nodes: legacyGraph.nodes, edges: legacyGraph.edges })).digest('hex')
    fixture.canvas = parseCanvasDocument(legacyGraph, fixture.target).document
    expect(legacyHash).not.toBe(createHash('sha256').update(JSON.stringify({ viewport: fixture.canvas.viewport,
      nodes: fixture.canvas.nodes, edges: fixture.canvas.edges })).digest('hex'))
    fixture.configs.set('node-0', { ...fixture.configs.get('node-0')!, revision: 2, adoptedAssetId: 'new-0' })
    fixture.intents.set('legacy-operation', { schemaVersion: 1, operationId: 'legacy-operation',
      batchId: 'legacy-batch', ...fixture.target, mode: 'all', baseCanvasRevision: baseRevision,
      entries: [{ nodeId: 'node-0', imageModuleId: 'module-0', oldAssetId: 'old-0', candidateAssetId: 'new-0',
        expectedConfigRevision: 1, committedConfigRevision: 2 }],
      expectedGraphSha256: legacyHash, state: 'modules-committing', createdAt: 100, updatedAt: 100,
    })
    if (tampered) {
      fixture.canvas.nodes[1] = { ...fixture.canvas.nodes[1]!, title: '已被修改' }
      await expect(fixture.service.reconcile(fixture.target)).rejects.toThrow('CANVAS_IMAGE_BATCH_RECOVERY_REQUIRED')
      expect(fixture.batches.get('legacy-batch')?.status).toBe('ready')
    } else {
      /** 主线恢复返回已提交发布事实，供锁外通知使用。 */
      const result = await fixture.service.reconcile(fixture.target)
      expect(result.publications).toHaveLength(1)
      expect(result.publications[0]?.document).toEqual(fixture.canvas)
      expect(fixture.batches.get('legacy-batch')?.status).toBe('adopted')
      expect(fixture.intents.get('legacy-operation')?.state).toBe('batch-committed')
    }
    expect(fixture.configs.get('node-0')?.revision).toBe(2)
  })

  test.each(['after-first-module', 'after-all-modules', 'after-graph', 'after-batch'] as const)(
    'Given %s 崩溃 When reconcile Then 不重复 revision 且完成整批采用',
    async (crashPoint) => {
      const fixture = createFixture()
      await fixture.service.createBatch({
        ...fixture.target, batchId: 'batch-1', source: 'single',
        sourceSessionId: null, sourceToolCallId: null, entries: fixture.entries.slice(0, 2),
      })
      for (let index = 0; index < 2; index += 1) {
        await fixture.service.recordJobTerminal({
          ...fixture.target, jobId: `job-${index}`, status: 'succeeded', outputAssetId: `new-${index}`, error: null,
        })
      }
      /** crash 基线同时包含 producer 旧提示与绑定下游，验证恢复哈希覆盖完整依赖投影。 */
      fixture.canvas.nodes[0] = {
        ...fixture.canvas.nodes[0]!,
        upstreamChange: { sourceNodeIds: ['older-source'], changedAt: 20 },
      }
      fixture.canvas.nodes.push({
        id: 'downstream-recovery', kind: 'document', title: '恢复下游', position: { x: 0, y: 100 },
        documentId: 'document-recovery', contentRevision: 1,
        upstreamChange: { sourceNodeIds: ['pending-source'], changedAt: 30 },
      })
      fixture.canvas.edges = [{
        id: 'edge-recovery-0', sourceNodeId: 'node-0', sourcePort: 'image.asset',
        targetNodeId: 'downstream-recovery', targetPort: 'context.image', relation: 'depends-on',
      }, {
        id: 'edge-recovery-1', sourceNodeId: 'node-1', sourcePort: 'image.asset',
        targetNodeId: 'downstream-recovery', targetPort: 'context.image', relation: 'derives',
      }]
      /** 预先计算采用完成后的精确图事实，模拟重启时磁盘上的不同阶段。 */
      const projectedCanvas: CanvasDocument = {
        ...fixture.canvas,
        revision: 4,
        nodes: fixture.canvas.nodes.map((node, index) => {
          if (index < 2 && node.kind === 'image') {
            const { upstreamChange: _consumed, ...producer } = node
            return { ...producer, adoptedAssetId: `new-${index}` }
          }
          return node.id === 'downstream-recovery'
            ? { ...node, upstreamChange: { sourceNodeIds: ['node-0', 'node-1', 'pending-source'], changedAt: 100 } }
            : node
        }),
        updatedAt: 100,
      }
      /** 模拟修复前已落盘的 raw hash，兼容恢复必须精确匹配该旧证明。 */
      const expectedGraphSha256 = createTestGraphSha256(projectedCanvas, false)
      expect(expectedGraphSha256).not.toBe(createTestGraphSha256(projectedCanvas))
      /** 配置提交证据按崩溃点逐步前移。 */
      const committedCount = crashPoint === 'after-first-module' ? 1 : 2
      for (let index = 0; index < committedCount; index += 1) {
        const current = fixture.configs.get(`node-${index}`)!
        fixture.configs.set(`node-${index}`, { ...current, revision: 2, adoptedAssetId: `new-${index}` })
      }
      if (crashPoint === 'after-graph' || crashPoint === 'after-batch') fixture.canvas = projectedCanvas
      const intent: CanvasImageCandidateAdoptionIntent = {
        schemaVersion: 1,
        operationId: 'operation-1',
        batchId: 'batch-1',
        ...fixture.target,
        mode: 'all',
        baseCanvasRevision: 3,
        entries: fixture.entries.slice(0, 2).map((entry, index) => ({
          nodeId: entry.nodeId,
          imageModuleId: entry.imageModuleId,
          oldAssetId: entry.initialAdoptedAssetId,
          candidateAssetId: `new-${index}`,
          expectedConfigRevision: 1,
          committedConfigRevision: index < committedCount && crashPoint !== 'after-first-module' ? 2 : null,
        })),
        expectedGraphSha256,
        state: crashPoint === 'after-batch'
          ? 'graph-committed'
          : 'modules-committing',
        createdAt: 100,
        updatedAt: 100,
      }
      fixture.intents.set(intent.operationId, intent)
      if (crashPoint === 'after-batch') {
        const batch = fixture.batches.get('batch-1')!
        fixture.batches.set('batch-1', {
          ...batch,
          status: 'adopted',
          entries: batch.entries.map((entry) => ({ ...entry, status: 'adopted' })),
          adoption: {
            mode: 'all',
            adoptedNodeIds: ['node-0', 'node-1'],
            keptNodeIds: [],
            invalidatedDownstreamNodeIds: ['downstream-recovery'],
            committedAt: 100,
          },
          updatedAt: 100,
        })
      }

      const reconciliation = await fixture.service.reconcile(fixture.target)

      expect([...fixture.configs.values()].slice(0, 2).map((config) => config.revision)).toEqual([2, 2])
      expect(fixture.batches.get('batch-1')?.status).toBe('adopted')
      expect(fixture.intents.get('operation-1')?.state).toBe('batch-committed')
      expect(fixture.canvas.nodes.slice(0, 2).map((node) => node.kind === 'image' ? node.adoptedAssetId : null))
        .toEqual(['new-0', 'new-1'])
      expect(fixture.canvas.nodes.find((node) => node.id === 'node-0')?.upstreamChange).toBeUndefined()
      expect(fixture.canvas.nodes.find((node) => node.id === 'downstream-recovery')?.upstreamChange).toEqual({
        sourceNodeIds: ['node-0', 'node-1', 'pending-source'], changedAt: 100,
      })
      expect(reconciliation.publications).toEqual([{
        document: fixture.canvas,
        imageTargets: fixture.entries.slice(0, 2).map((entry) => ({
          ...fixture.target,
          nodeId: entry.nodeId,
          imageModuleId: entry.imageModuleId,
        })),
      }])
      await expect(fixture.service.reconcile(fixture.target)).resolves.toEqual({ publications: [] })
      expect(fixture.canvas.revision).toBe(4)
    },
  )

  test('Given 旧 raw hash intent 与真实 Store 规范图可精确对应 When LOAD reconcile Then 完成恢复', async () => {
    const { fixture, legacyExpectedDocument, expectedGraphSha256 } = await createLegacyRawHashRecoveryFixture()
    expect(expectedGraphSha256).not.toBe(createTestGraphSha256(legacyExpectedDocument))

    const reconciliation = await fixture.service.reconcile(fixture.target)

    expect(reconciliation.publications).toEqual([{
      document: fixture.canvas,
      imageTargets: [{
        ...fixture.target,
        nodeId: 'node-0',
        imageModuleId: 'module-0',
      }],
    }])
    expect(fixture.intents.get('operation-legacy-hash')?.state).toBe('batch-committed')
    expect(fixture.batches.get('batch-legacy-hash')?.status).toBe('adopted')
    expect(fixture.canvas).toMatchObject({ revision: 4 })
  })

  test('Given 旧 raw hash intent 对应 revision 的其它图内容被改写 When LOAD reconcile Then fail closed', async () => {
    const { fixture } = await createLegacyRawHashRecoveryFixture()
    /** 保持 revision 不变但修改其它节点内容，验证恢复不能只信 revision。 */
    fixture.canvas = parseCanvasDocument({
      ...fixture.canvas,
      nodes: fixture.canvas.nodes.map((node) => node.id === 'node-1'
        ? { ...node, title: '被其它写入改过' }
        : node),
    }, fixture.target).document
    const driftedCanvas = structuredClone(fixture.canvas)

    await expect(fixture.service.reconcile(fixture.target))
      .rejects.toThrow('CANVAS_IMAGE_BATCH_RECOVERY_REQUIRED')

    expect(fixture.canvas).toEqual(driftedCanvas)
    expect(fixture.batches.get('batch-legacy-hash')?.status).toBe('ready')
    expect(fixture.intents.get('operation-legacy-hash')?.state).toBe('modules-committing')
    expect(fixture.configs.get('node-0')).toMatchObject({ revision: 2, adoptedAssetId: 'new-0' })
  })

  test('Given 未完成 intent 的模块事实已漂移 When locked 恢复 Then fail closed 且不覆盖现有事实', async () => {
    const fixture = createFixture()
    await fixture.service.createBatch({
      ...fixture.target, batchId: 'batch-drift', source: 'single',
      sourceSessionId: null, sourceToolCallId: null, entries: [fixture.entries[0]!],
    })
    const beforeCanvas = structuredClone(fixture.canvas)
    fixture.configs.set('node-0', {
      ...fixture.configs.get('node-0')!, revision: 7, adoptedAssetId: 'foreign-asset',
    })
    fixture.intents.set('operation-drift', {
      schemaVersion: 1,
      operationId: 'operation-drift',
      batchId: 'batch-drift',
      ...fixture.target,
      mode: 'all',
      baseCanvasRevision: fixture.canvas.revision,
      entries: [{
        nodeId: 'node-0', imageModuleId: 'module-0', oldAssetId: 'old-0',
        candidateAssetId: 'new-0', expectedConfigRevision: 1, committedConfigRevision: null,
      }],
      expectedGraphSha256: '0'.repeat(64),
      state: 'prepared',
      createdAt: 100,
      updatedAt: 100,
    })

    const reconciliation = await fixture.service.reconcileLocked(fixture.target)

    expect(reconciliation.publications).toEqual([])
    expect(reconciliation.error?.message).toBe('CANVAS_IMAGE_BATCH_RECOVERY_REQUIRED')
    expect(fixture.canvas).toEqual(beforeCanvas)
    expect(fixture.configs.get('node-0')).toMatchObject({ revision: 7, adoptedAssetId: 'foreign-asset' })
    expect(fixture.intents.get('operation-drift')?.state).toBe('prepared')
  })
})
