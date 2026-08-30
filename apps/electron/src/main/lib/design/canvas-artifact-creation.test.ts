import { describe, expect, test } from 'bun:test'
import type {
  CanvasBatchOperationEnvelope,
  CanvasDocument,
  CanvasMutation,
} from '@proma/shared'
import { createEmptyCanvasDocument } from '@proma/shared'
import {
  createCanvasArtifactCreationService,
  type CanvasArtifactCreationDependencies,
} from './canvas-artifact-creation'

const target = { projectId: 'project-1', canvasId: 'canvas-1' }

/** 服务测试已控制 envelope 来源，断言前从 JSON 外壳恢复为已验证 mutation。 */
function getBatchOperations(batch: CanvasBatchOperationEnvelope): CanvasMutation[] {
  return batch.operations as unknown as CanvasMutation[]
}

/** 构造可观察内容准备、批量提交与失败补偿的窄测试服务。 */
function createFixture(options: {
  conflictOnce?: boolean
  conflictAlways?: boolean
  commitBeforeError?: boolean
} = {}) {
  let document: CanvasDocument = {
    ...createEmptyCanvasDocument(target.projectId, target.canvasId, 1),
    revision: 3,
    nodes: [{
      id: 'requirements-1',
      kind: 'document',
      title: '页面需求',
      position: { x: 40, y: 60 },
      documentId: 'requirements-content',
      contentRevision: 1,
    }],
  }
  const prepared: Array<{ kind: string; contentId: string; content: string; selectedModelProfileId?: string | null }> = []
  const discarded: Array<{ contentId: string; rollbackId: string }> = []
  const batches: CanvasBatchOperationEnvelope[] = []
  /** 测试 fake 只实现本服务会产生的节点和连线 upsert。 */
  const applyOperations = (operations: CanvasMutation[], revision: number): CanvasDocument => {
    const nodes = [...document.nodes]
    const edges = [...document.edges]
    for (const operation of operations) {
      if (operation.type === 'upsert-nodes') nodes.push(...operation.nodes)
      if (operation.type === 'upsert-edges') edges.push(...operation.edges)
    }
    return { ...document, nodes, edges, revision }
  }
  const dependencies: CanvasArtifactCreationDependencies = {
    documents: { load: () => ({ document: structuredClone(document), writable: true, nodeIssues: [] }) },
    content: {
      prepareArtifactContent: async (_target, input) => { prepared.push(structuredClone(input)) },
      discardPreparedContent: async (_target, input, rollbackId) => {
        discarded.push({ contentId: input.contentId, rollbackId })
      },
    },
    batch: {
      execute: async (input) => {
        batches.push(structuredClone(input))
        const shouldConflict = options.conflictAlways || (options.conflictOnce && batches.length === 1)
        if (shouldConflict) {
          document = { ...document, revision: document.revision + 1 }
          throw new Error('CANVAS_REVISION_CONFLICT')
        }
        const next = applyOperations(getBatchOperations(input), input.baseRevision + 1)
        document = next
        if (options.commitBeforeError) throw new Error('CANVAS_COMMIT_RESULT_UNCERTAIN')
        return { document: structuredClone(document), operationId: `operation-${batches.length}` }
      },
    },
    resolveDefaultImageModelProfileId: () => 'profile-default',
  }
  return {
    service: createCanvasArtifactCreationService(dependencies),
    prepared,
    discarded,
    batches,
    getDocument: () => structuredClone(document),
  }
}

describe('Canvas Agent 产物原子创建服务', () => {
  test('Given WebView 产物关联来源节点 When 创建 Then 先准备真实 HTML 并在来源右侧提交节点与连线', async () => {
    const fixture = createFixture()
    const result = await fixture.service.create({
      ...target,
      baseRevision: 3,
      artifactType: 'webview',
      title: '首页原型',
      content: '<!doctype html><html><body>首页</body></html>',
      sourceNodeId: 'requirements-1',
      source: { sessionId: 'session-1', runStartedAt: 99, toolCallId: 'tool-artifact-1' },
    })

    expect(fixture.prepared).toEqual([expect.objectContaining({
      kind: 'webview', content: '<!doctype html><html><body>首页</body></html>',
    })])
    const operations = fixture.batches[0] ? getBatchOperations(fixture.batches[0]) : []
    const createdNode = operations.find((operation) => operation.type === 'upsert-nodes')
    expect(createdNode).toMatchObject({
      nodes: [{ kind: 'webview', title: '首页原型', position: { x: 400, y: 60 }, contentRevision: 0 }],
    })
    expect(operations.find((operation) => operation.type === 'upsert-edges')).toMatchObject({
      edges: [{ sourceNodeId: 'requirements-1', targetNodeId: result.nodeId }],
    })
    expect(result).toMatchObject({ canvasId: 'canvas-1', revision: 4, artifactType: 'webview' })
    expect(result.nodeId).toMatch(/^artifact-[0-9a-f]{64}$/)
    expect(fixture.discarded).toEqual([])
  })

  test('Given 图片产物 When 创建 Then 使用项目默认模型初始化 prompt 且不自动运行生图', async () => {
    const fixture = createFixture()
    const result = await fixture.service.create({
      ...target,
      baseRevision: 3,
      artifactType: 'image',
      title: '首页设计稿',
      content: '安静克制的首页视觉设计',
      position: { x: 800, y: 120 },
      source: { sessionId: 'session-1', runStartedAt: 99, toolCallId: 'tool-image-1' },
    })

    expect(fixture.prepared).toEqual([expect.objectContaining({
      kind: 'image',
      content: '安静克制的首页视觉设计',
      selectedModelProfileId: 'profile-default',
    })])
    expect(fixture.batches[0]?.operations).toEqual([expect.objectContaining({
      type: 'upsert-nodes',
      nodes: [expect.objectContaining({ id: result.nodeId, kind: 'image', position: { x: 800, y: 120 } })],
    })])
  })

  test('Given 首次 revision 冲突 When 创建 Then 权威重读后只重试一次并保持同一节点身份', async () => {
    const fixture = createFixture({ conflictOnce: true })
    const result = await fixture.service.create({
      ...target,
      baseRevision: 3,
      artifactType: 'webview',
      title: '首页原型',
      content: '<!doctype html><html></html>',
      source: { sessionId: 'session-1', runStartedAt: 99, toolCallId: 'tool-retry-1' },
    })

    expect(fixture.batches.map((batch) => batch.baseRevision)).toEqual([3, 4])
    expect(fixture.batches.map((batch) => batch.sourceToolCallId)).toEqual([
      'tool-retry-1', 'tool-retry-1-retry',
    ])
    const nodeIds = fixture.batches.map((batch) => (
      getBatchOperations(batch)[0] as unknown as Extract<CanvasMutation, { type: 'upsert-nodes' }>
    ).nodes[0]?.id)
    expect(new Set(nodeIds)).toEqual(new Set([result.nodeId]))
    expect(fixture.discarded).toEqual([])
  })

  test('Given 两次 revision 冲突 When 创建失败 Then 清理未进入权威图的 prepared 内容', async () => {
    const fixture = createFixture({ conflictAlways: true })
    await expect(fixture.service.create({
      ...target,
      baseRevision: 3,
      artifactType: 'webview',
      title: '失败原型',
      content: '<!doctype html><html></html>',
      source: { sessionId: 'session-1', runStartedAt: 99, toolCallId: 'tool-failed-1' },
    })).rejects.toThrow('CANVAS_REVISION_CONFLICT')

    expect(fixture.batches).toHaveLength(2)
    expect(fixture.discarded).toEqual([expect.objectContaining({
      rollbackId: expect.stringMatching(/^artifact-rollback-[0-9a-f]{64}$/),
    })])
  })

  test('Given batch 已提交节点但返回不确定错误 When 对账 Then 保留权威内容并返回成功事实', async () => {
    const fixture = createFixture({ commitBeforeError: true })
    const result = await fixture.service.create({
      ...target,
      baseRevision: 3,
      artifactType: 'webview',
      title: '已提交原型',
      content: '<!doctype html><html></html>',
      source: { sessionId: 'session-1', runStartedAt: 99, toolCallId: 'tool-uncertain-1' },
    })

    expect(fixture.getDocument().nodes.some((node) => node.id === result.nodeId)).toBe(true)
    expect(fixture.discarded).toEqual([])
    expect(result.revision).toBe(4)
  })
})
