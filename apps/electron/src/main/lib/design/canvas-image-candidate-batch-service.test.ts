import { createHash } from 'node:crypto'
import { describe, expect, test } from 'bun:test'
import {
  parseCanvasWorkspaceSnapshot,
  type CanvasDocument,
  type CanvasImageCandidateBatch,
  type CanvasImageModuleConfig,
  type CanvasNode,
  type CanvasTarget,
} from '@proma/shared'
import { createCanvasImageCandidateBatchService } from './canvas-image-candidate-batch-service'
import type { CanvasImageCandidateAdoptionIntent } from './canvas-image-candidate-batch-store'
import { createCanvasDependencyStateService } from './canvas-dependency-state-service'

/** 创建 14 节点候选批次 Service 内存夹具。 */
function createFixture() {
  const target: CanvasTarget = { projectId: 'project-1', canvasId: 'canvas-1' }
  const batches = new Map<string, CanvasImageCandidateBatch>()
  const intents = new Map<string, CanvasImageCandidateAdoptionIntent>()
  const configs = new Map<string, CanvasImageModuleConfig>()
  const adopted: string[] = []
  const retried: string[] = []
  const started: string[] = []
  /** 依赖投影调用数用于证明候选阶段不会提前传播。 */
  let dependencyProjectionCalls = 0
  /** fixture 复用真实纯服务，仅在入口外记录调用次数。 */
  const dependencyState = createCanvasDependencyStateService()
  const entries = Array.from({ length: 14 }, (_, index) => {
    const nodeId = `node-${index}`
    configs.set(nodeId, {
      schemaVersion: 2, kind: 'image', contentId: `module-${index}`, revision: 1,
      createdAt: 1, updatedAt: 1, prompt: '生成', selectedModelProfileId: 'model-1',
      aspectRatio: '1:1', imageSize: 'auto', contextMode: 'none', adoptedAssetId: `old-${index}`,
    })
    return {
      nodeId, imageModuleId: `module-${index}`, initialAdoptedAssetId: `old-${index}`,
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
      intents.set(intent.operationId, structuredClone(intent))
      return structuredClone(intent)
    },
  }
  const service = createCanvasImageCandidateBatchService({
    store,
    dependencyState: {
      consumeAndPropagate: (input) => {
        dependencyProjectionCalls += 1
        return dependencyState.consumeAndPropagate(input)
      },
    },
    runExclusive: async (_target, effect) => effect(),
    loadConfig: async (imageTarget) => structuredClone(configs.get(imageTarget.nodeId)!),
    adoptAsset: async (imageTarget, _revision, assetId) => {
      adopted.push(imageTarget.nodeId)
      const current = configs.get(imageTarget.nodeId)!
      const next = { ...current, revision: current.revision + 1, adoptedAssetId: assetId }
      configs.set(imageTarget.nodeId, next)
      return next
    },
    loadCanvas: async () => structuredClone(canvas),
    applyCanvasProjection: async (_target, expectedRevision, nodes) => {
      if (canvas.revision !== expectedRevision) throw new Error('CANVAS_REVISION_CONFLICT')
      const replacements = new Map(nodes.map((node) => [node.id, node]))
      canvas = {
        ...canvas,
        revision: canvas.revision + 1,
        nodes: canvas.nodes.map((node) => replacements.get(node.id) ?? node),
        updatedAt: 100,
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
    target, entries, batches, intents, configs, adopted, retried, started, service,
    get canvas() { return canvas },
    set canvas(value: CanvasDocument) { canvas = value },
    get dependencyProjectionCalls() { return dependencyProjectionCalls },
  }
}

describe('Canvas 图片候选批次 Service', () => {
  test('Given Job 终态完成登记 When 发布批次变化 Then 监听器可立即读取权威终态', async () => {
    const fixture = createFixture()
    await fixture.service.createBatch({
      ...fixture.target, batchId: 'batch-event', source: 'canvas-tool',
      sourceSessionId: 'session-1', sourceToolCallId: 'tool-event', entries: [fixture.entries[0]!],
    })
    const observedStatuses: string[] = []
    const unsubscribe = fixture.service.onChanged((event) => {
      /** 事件回调触发时，内存 store 必须已经持有可重读的权威终态。 */
      observedStatuses.push(fixture.batches.get(event.batchId)?.entries[0]?.status ?? 'missing')
    })

    await fixture.service.recordJobTerminal({
      ...fixture.target, jobId: 'job-0', candidateBatchId: 'batch-event',
      status: 'succeeded', outputAssetId: 'asset-event', error: null,
    })
    unsubscribe()

    expect(observedStatuses).toEqual(['candidate'])
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

    expect(() => parseCanvasWorkspaceSnapshot({
      document: fixture.canvas,
      writable: true,
      nodeIssues: [],
    })).not.toThrow()
    expect(fixture.canvas.nodes.find((node) => node.id === downstream.id)?.upstreamChange)
      .toEqual({ sourceNodeIds: ['node-0', 'node_0'], changedAt: 100 })

    await fixture.service.reconcile(fixture.target)
    await fixture.service.reconcile(fixture.target)

    expect(fixture.intents.get('operation-1')?.expectedGraphSha256).toBe(expectedGraphSha256)
    expect(fixture.canvas.revision).toBe(adoptedRevision)
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
      /** intent 哈希只覆盖稳定图数据，不包含 revision 与时间。 */
      const expectedGraphSha256 = createHash('sha256').update(JSON.stringify({
        viewport: projectedCanvas.viewport,
        nodes: projectedCanvas.nodes,
        edges: projectedCanvas.edges,
      })).digest('hex')
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

      await expect(fixture.service.reconcile(fixture.target)).resolves.toBeUndefined()

      expect([...fixture.configs.values()].slice(0, 2).map((config) => config.revision)).toEqual([2, 2])
      expect(fixture.batches.get('batch-1')?.status).toBe('adopted')
      expect(fixture.intents.get('operation-1')?.state).toBe('batch-committed')
      expect(fixture.canvas.nodes.slice(0, 2).map((node) => node.kind === 'image' ? node.adoptedAssetId : null))
        .toEqual(['new-0', 'new-1'])
      expect(fixture.canvas.nodes.find((node) => node.id === 'node-0')?.upstreamChange).toBeUndefined()
      expect(fixture.canvas.nodes.find((node) => node.id === 'downstream-recovery')?.upstreamChange).toEqual({
        sourceNodeIds: ['node-0', 'node-1', 'pending-source'], changedAt: 100,
      })
    },
  )
})
