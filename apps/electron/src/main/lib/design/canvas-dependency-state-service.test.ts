import { describe, expect, test } from 'bun:test'
import { createCanvasBoundEdge } from '@proma/shared'
import type { CanvasDocument, CanvasNode } from '@proma/shared'
import { createCanvasDependencyStateService } from './canvas-dependency-state-service'

/** 创建依赖传播测试使用的最小文档节点。 */
function createDocumentNode(id: string, upstreamSourceNodeIds?: string[]): CanvasNode {
  return {
    id,
    kind: 'document',
    title: id,
    position: { x: 0, y: 0 },
    documentId: `content-${id}`,
    contentRevision: 1,
    ...(upstreamSourceNodeIds
      ? { upstreamChange: { sourceNodeIds: upstreamSourceNodeIds, changedAt: 10 } }
      : {}),
  }
}

/** 创建依赖传播测试使用的权威 Canvas 图。 */
function createDocument(nodes: CanvasNode[]): CanvasDocument {
  return {
    schemaVersion: 4,
    projectId: 'project-1',
    canvasId: 'canvas-1',
    revision: 7,
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes,
    edges: [],
    createdAt: 1,
    updatedAt: 1,
  }
}

/** 创建指定数量且稳定排序的既有待更新来源。 */
function createSourceNodeIds(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `source-${index.toString().padStart(3, '0')}`)
}

/** 创建单条 document 到 document 的可信依赖边。 */
function connectProducer(document: CanvasDocument, producer: CanvasNode, downstream: CanvasNode): void {
  document.edges = [createCanvasBoundEdge(producer, downstream, {
    id: 'edge-limit', sourceNodeId: producer.id, targetNodeId: downstream.id, relation: 'depends-on',
  })]
}

describe('Canvas Dependency State Service', () => {
  test('Given producer 已有待更新来源 When 提交正式输出 Then 清除自身提示并保持无关节点语义不变', () => {
    const service = createCanvasDependencyStateService()
    const producer = createDocumentNode('producer', ['older-source'])
    const untouched = createDocumentNode('untouched', ['pending-source'])
    const document = createDocument([producer, untouched])

    const result = service.consumeAndPropagate({
      document,
      producerNodeIds: ['producer'],
      changedAt: 20,
    })

    expect(result.nodes).toHaveLength(1)
    expect(result.nodes[0]).toMatchObject({ id: 'producer', contentRevision: 1 })
    expect(result.nodes[0]?.upstreamChange).toBeUndefined()
    expect(result.downstreamNodeIds).toEqual([])
    expect(document.nodes).toEqual([producer, untouched])
    expect(result.nodes).not.toContain(untouched)
  })

  test('Given 四类关系和异常边 When producer 提交 Then 只传播直接正向 bound 数据边', () => {
    const service = createCanvasDependencyStateService()
    const producer = createDocumentNode('producer')
    const reference = createDocumentNode('reference')
    const dependsOn = createDocumentNode('depends-on')
    const derives = createDocumentNode('derives')
    const association = createDocumentNode('association')
    const unresolved = createDocumentNode('unresolved')
    const incompatible = createDocumentNode('incompatible')
    const reverseSource = createDocumentNode('reverse-source')
    const document = createDocument([
      producer, reference, dependsOn, derives, association, unresolved, incompatible, reverseSource,
    ])
    document.edges = [
      createCanvasBoundEdge(producer, reference, {
        id: 'edge-reference', sourceNodeId: producer.id, targetNodeId: reference.id, relation: 'reference',
      }),
      createCanvasBoundEdge(producer, dependsOn, {
        id: 'edge-depends-on', sourceNodeId: producer.id, targetNodeId: dependsOn.id, relation: 'depends-on',
      }),
      createCanvasBoundEdge(producer, derives, {
        id: 'edge-derives', sourceNodeId: producer.id, targetNodeId: derives.id, relation: 'derives',
      }),
      createCanvasBoundEdge(producer, association, {
        id: 'edge-association', sourceNodeId: producer.id, targetNodeId: association.id, relation: 'association',
      }),
      {
        id: 'edge-unresolved', sourceNodeId: producer.id, sourcePort: 'legacy-output',
        targetNodeId: unresolved.id, targetPort: 'legacy-input', relation: 'reference',
      },
      {
        id: 'edge-incompatible', sourceNodeId: producer.id, sourcePort: 'document.markdown',
        targetNodeId: incompatible.id, targetPort: 'context.image', relation: 'reference',
      },
      {
        id: 'edge-dangling', sourceNodeId: producer.id, sourcePort: 'document.markdown',
        targetNodeId: 'missing', targetPort: 'context.text', relation: 'reference',
      },
      createCanvasBoundEdge(reverseSource, producer, {
        id: 'edge-reverse', sourceNodeId: reverseSource.id, targetNodeId: producer.id, relation: 'depends-on',
      }),
    ]

    const result = service.consumeAndPropagate({
      document,
      producerNodeIds: ['producer'],
      changedAt: 30,
    })

    expect(result.downstreamNodeIds).toEqual(['depends-on', 'derives', 'reference'])
    expect(result.nodes.map((node) => node.id)).toEqual([
      'producer', 'reference', 'depends-on', 'derives',
    ])
    expect(result.nodes.filter((node) => node.id !== 'producer').every((node) => (
      node.upstreamChange?.changedAt === 30
      && JSON.stringify(node.upstreamChange.sourceNodeIds) === JSON.stringify(['producer'])
    ))).toBeTrue()
  })

  test('Given 多个 producer 指向同一下游且下游已有 pending When 同批提交 Then 合并去重并稳定排序来源', () => {
    const service = createCanvasDependencyStateService()
    const producerZ = createDocumentNode('producer-z', ['old-z'])
    const producerA = createDocumentNode('producer-a', ['old-a'])
    const downstream = createDocumentNode('downstream', ['source-z', 'producer-z'])
    const document = createDocument([producerZ, downstream, producerA])
    document.edges = [
      createCanvasBoundEdge(producerZ, downstream, {
        id: 'edge-z', sourceNodeId: producerZ.id, targetNodeId: downstream.id, relation: 'reference',
      }),
      createCanvasBoundEdge(producerA, downstream, {
        id: 'edge-a', sourceNodeId: producerA.id, targetNodeId: downstream.id, relation: 'derives',
      }),
      createCanvasBoundEdge(producerA, downstream, {
        id: 'edge-a-duplicate', sourceNodeId: producerA.id, targetNodeId: downstream.id, relation: 'depends-on',
      }),
    ]

    const result = service.consumeAndPropagate({
      document,
      producerNodeIds: ['producer-z', 'producer-a', 'producer-a'],
      changedAt: 40,
    })

    expect(result.downstreamNodeIds).toEqual(['downstream'])
    expect(result.nodes.map((node) => node.id)).toEqual(['producer-z', 'downstream', 'producer-a'])
    expect(result.nodes.find((node) => node.id === 'producer-z')?.upstreamChange).toBeUndefined()
    expect(result.nodes.find((node) => node.id === 'producer-a')?.upstreamChange).toBeUndefined()
    expect(result.nodes.find((node) => node.id === 'downstream')?.upstreamChange).toEqual({
      sourceNodeIds: ['producer-a', 'producer-z', 'source-z'],
      changedAt: 40,
    })
  })

  test('Given 下游已有 127 个来源 When 新 producer 提交 Then 无损合并为 128 个来源', () => {
    const service = createCanvasDependencyStateService()
    const producer = createDocumentNode('producer-new')
    const downstream = createDocumentNode('downstream', createSourceNodeIds(127))
    const document = createDocument([producer, downstream])
    connectProducer(document, producer, downstream)

    const result = service.consumeAndPropagate({ document, producerNodeIds: [producer.id], changedAt: 20 })

    expect(result.nodes.find((node) => node.id === downstream.id)?.upstreamChange?.sourceNodeIds)
      .toHaveLength(128)
  })

  test('Given 下游已有 128 个来源且包含 producer When 重复传播 Then 去重后仍成功', () => {
    const service = createCanvasDependencyStateService()
    const producer = createDocumentNode('producer-existing')
    const existingSources = [...createSourceNodeIds(127), producer.id].sort()
    const downstream = createDocumentNode('downstream', existingSources)
    const document = createDocument([producer, downstream])
    connectProducer(document, producer, downstream)

    const result = service.consumeAndPropagate({ document, producerNodeIds: [producer.id], changedAt: 20 })

    expect(result.nodes.find((node) => node.id === downstream.id)?.upstreamChange?.sourceNodeIds)
      .toEqual(existingSources)
  })

  test('Given 下游已有 128 个不同来源 When 新 producer 提交 Then 稳定拒绝且不返回非法投影', () => {
    const service = createCanvasDependencyStateService()
    const producer = createDocumentNode('producer-new')
    const downstream = createDocumentNode('downstream', createSourceNodeIds(128))
    const document = createDocument([producer, downstream])
    connectProducer(document, producer, downstream)

    expect(() => service.consumeAndPropagate({
      document,
      producerNodeIds: [producer.id],
      changedAt: 20,
    })).toThrow('CANVAS_DEPENDENCY_SOURCE_LIMIT_EXCEEDED')
    expect(document.nodes[1]).toEqual(downstream)
  })

  test('Given 下游已有较新的 changedAt When 迟到 producer 变化传播 Then 时间不倒退', () => {
    const service = createCanvasDependencyStateService()
    const producer = createDocumentNode('producer-new')
    const downstream = createDocumentNode('downstream', ['older-source'])
    downstream.upstreamChange = { sourceNodeIds: ['older-source'], changedAt: 100 }
    const document = createDocument([producer, downstream])
    connectProducer(document, producer, downstream)

    const result = service.consumeAndPropagate({ document, producerNodeIds: [producer.id], changedAt: 50 })

    expect(result.nodes.find((node) => node.id === downstream.id)?.upstreamChange?.changedAt).toBe(100)
  })
})
