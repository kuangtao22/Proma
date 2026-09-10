import { describe, expect, test } from 'bun:test'
import type { CanvasDocument, CanvasEdge, CanvasNode } from './canvas'
import type { CanvasMediaInputBinding, CanvasMediaTarget } from './canvas-media'
import { inspectCanvasMediaInputConnections } from './canvas-media-connections'

/** 测试目标始终绑定同一画布内的确切视频模块。 */
const target: CanvasMediaTarget = { projectId: 'project', canvasId: 'canvas', nodeId: 'video', mediaModuleId: 'module', mediaKind: 'video' }
/** 两个输入复用首帧来源，用于验证补边去重。 */
const inputs: CanvasMediaInputBinding[] = ['first', 'last'].map((key) => ({ key, kind: 'image', source: { type: 'canvas-output', nodeId: 'image', outputKey: 'image.asset' } }))
/** 构造不含磁盘内容的真实类型化图。 */
function graph(edges: CanvasEdge[] = [], extra: CanvasNode[] = []): CanvasDocument {
  return { schemaVersion: 4, canvasId: 'canvas', projectId: 'project', revision: 3, viewport: { x: 0, y: 0, zoom: 1 }, createdAt: 1, updatedAt: 1,
    nodes: [{ id: 'image', kind: 'image', imageModuleId: 'image-module', title: '首帧', position: { x: 0, y: 0 } },
      { id: 'video', kind: 'video', mediaModuleId: 'module', title: '视频', position: { x: 500, y: 0 } }, ...extra], edges }
}

describe('媒体输入连接检查', () => {
  test('Given 两个槽位引用同图图片但无边 When 检查 Then 两项缺边只规划一条真实依赖', () => {
    const result = inspectCanvasMediaInputConnections(graph(), target, inputs)
    expect(result.connected).toBe(false)
    expect(result.bindings.map((binding) => binding.errorCode)).toEqual(['CANVAS_MEDIA_SOURCE_EDGE_MISSING', 'CANVAS_MEDIA_SOURCE_EDGE_MISSING'])
    expect(result.missingEdges).toEqual([{ sourceNodeId: 'image', sourcePort: 'image.asset', targetNodeId: 'video', targetPort: 'context.image', relation: 'depends-on' }])
  })
  test('Given 精确依赖已接通 When 重复检查 Then 幂等且不改原边', () => {
    const document = graph([{ id: 'original', sourceNodeId: 'image', targetNodeId: 'video', sourcePort: 'image.asset', targetPort: 'context.image', relation: 'reference' }])
    const before = JSON.stringify(document)
    expect(inspectCanvasMediaInputConnections(document, target, inputs)).toMatchObject({ connected: true, missingEdges: [] })
    expect(JSON.stringify(document)).toBe(before)
  })
  test('Given 只有关联或错误端口 When 检查 Then 不当作已接通且保留旧关系', () => {
    const document = graph([{ id: 'association', sourceNodeId: 'image', targetNodeId: 'video', sourcePort: 'unbound', targetPort: 'unbound', relation: 'association' },
      { id: 'wrong', sourceNodeId: 'image', targetNodeId: 'video', sourcePort: 'image.asset', targetPort: 'context.text', relation: 'depends-on' }])
    const result = inspectCanvasMediaInputConnections(document, target, inputs)
    expect(result.bindings[0]?.errorCode).toBe('CANVAS_MEDIA_SOURCE_EDGE_INVALID')
    expect(result.missingEdges).toHaveLength(1)
    expect(document.edges).toHaveLength(2)
  })
  test('Given 来源缺失、key错误或跨类型 When 检查 Then 定位错误且不规划伪造边', () => {
    const result = inspectCanvasMediaInputConnections(graph(), target, [
      { key: 'missing', kind: 'image', source: { type: 'canvas-output', nodeId: 'other-canvas-node', outputKey: 'image.asset' } },
      { key: 'wrong-key', kind: 'image', source: { type: 'canvas-output', nodeId: 'image', outputKey: 'image.wrong' } },
      { key: 'wrong-kind', kind: 'text', source: { type: 'canvas-output', nodeId: 'image', outputKey: 'image.asset' } },
    ])
    expect(result.bindings.map((binding) => binding.errorCode)).toEqual(['CANVAS_MEDIA_SOURCE_NODE_MISSING', 'CANVAS_MEDIA_SOURCE_OUTPUT_KEY_INVALID', 'CANVAS_MEDIA_SOURCE_KIND_MISMATCH'])
    expect(result.missingEdges).toEqual([])
  })
  test('Given 文档输入与直接值 When 检查 Then 文档使用正式Markdown端口且直接值无需连线', () => {
    const document = graph([], [{ id: 'doc', kind: 'document', documentId: 'doc-content', contentRevision: 0, title: '动态提示词', position: { x: 0, y: 250 } }])
    const result = inspectCanvasMediaInputConnections(document, target, [
      { key: 'prompt', kind: 'text', source: { type: 'canvas-output', nodeId: 'doc', outputKey: 'document.markdown' } },
      { key: 'seed', kind: 'number', source: { type: 'literal', value: 42 } },
    ])
    expect(result.missingEdges[0]?.sourcePort).toBe('document.markdown')
    expect(result.bindings[1]?.errorCode).toBeNull()
  })
  test('Given 目标身份被替换或来自其它画布 When 检查 Then 拒绝过期目标', () => {
    expect(() => inspectCanvasMediaInputConnections(graph(), { ...target, mediaModuleId: 'replaced' }, inputs)).toThrow('CANVAS_MEDIA_TARGET_INVALID')
    expect(() => inspectCanvasMediaInputConnections(graph(), { ...target, canvasId: 'other' }, inputs)).toThrow('CANVAS_MEDIA_TARGET_INVALID')
  })
})
