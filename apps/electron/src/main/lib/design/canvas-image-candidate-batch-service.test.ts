import { createHash } from 'node:crypto'
import { describe, expect, test } from 'bun:test'
import type {
  CanvasDocument,
  CanvasImageCandidateBatch,
  CanvasImageModuleConfig,
  CanvasNode,
  CanvasTarget,
} from '@proma/shared'
import { createCanvasImageCandidateBatchService } from './canvas-image-candidate-batch-service'
import type { CanvasImageCandidateAdoptionIntent } from './canvas-image-candidate-batch-store'

/** 创建 14 节点候选批次 Service 内存夹具。 */
function createFixture() {
  const target: CanvasTarget = { projectId: 'project-1', canvasId: 'canvas-1' }
  const batches = new Map<string, CanvasImageCandidateBatch>()
  const intents = new Map<string, CanvasImageCandidateAdoptionIntent>()
  const configs = new Map<string, CanvasImageModuleConfig>()
  const adopted: string[] = []
  const retried: string[] = []
  const started: string[] = []
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
  }
}

describe('Canvas 图片候选批次 Service', () => {
  test('Given 14 节点 When 仅 2 个成功 Then partial 且不采用任何正式版本', async () => {
    const fixture = createFixture()
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
        sourceNodeId: 'node-0', sourcePort: 'output',
        targetNodeId: `downstream-${relation}`, targetPort: 'input', relation,
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
    expect(changes.get('downstream-reference')?.sourceNodeIds).toEqual(['node-0'])
    expect(changes.get('downstream-association')).toBeUndefined()
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
      /** 预先计算采用完成后的精确图事实，模拟重启时磁盘上的不同阶段。 */
      const projectedCanvas: CanvasDocument = {
        ...fixture.canvas,
        revision: 4,
        nodes: fixture.canvas.nodes.map((node, index) => (
          index < 2 && node.kind === 'image' ? { ...node, adoptedAssetId: `new-${index}` } : node
        )),
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
            invalidatedDownstreamNodeIds: [],
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
    },
  )
})
