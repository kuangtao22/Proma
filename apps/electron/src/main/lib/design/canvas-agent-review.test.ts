import { describe, expect, test } from 'bun:test'
import { createEmptyCanvasDocument } from '@proma/shared'
import type { CanvasDocument } from '@proma/shared'
import { createCanvasAgentReviewTracker, resolveCanvasAgentReviewContext } from './canvas-agent-review'

/** 构造同一视频内含孤立节点的审核快照，未连线不意味着范围外。 */
function reviewDocument(): CanvasDocument {
  return {
    ...createEmptyCanvasDocument('project-1', 'canvas-1', 1), revision: 3,
    nodes: [
      { id: 'director', kind: 'agent', title: '导演', position: { x: 0, y: 0 }, agentSessionId: 'session-1' },
      { id: 'script', kind: 'document', title: '脚本', position: { x: 320, y: 0 }, documentId: 'script-content', contentRevision: 1 },
      { id: 'frame', kind: 'image', title: '未连线首帧', position: { x: 640, y: 0 }, imageModuleId: 'frame-module' },
    ],
    edges: [{ id: 'input', sourceNodeId: 'script', sourcePort: 'document.markdown', targetNodeId: 'director', targetPort: 'context.text', relation: 'reference' }],
  }
}

/** 单节点完整读取夹具：当前正文或配置真实送达，历史目录不冒充必读全文。 */
function readEntry(document: CanvasDocument, nodeId: string) {
  /** 按权威身份查找目标，测试拒绝用标题替代ID。 */
  const node = document.nodes.find(candidate => candidate.id === nodeId)!
  return { node, content: '正文', contentLength: 2, artifact: { kind: node.kind } }
}

describe('Canvas 专业 Agent 审核范围与读取覆盖', () => {
  test('Given 首次接管整张视频画布 When 解析范围 Then 包含未连线节点并排除导演自身', () => {
    /** 整图范围由Host快照展开，不由模型猜测数量。 */
    const context = resolveCanvasAgentReviewContext(reviewDocument(), 'director', { mode: 'canvas' })
    expect(context).toMatchObject({ canvasId: 'canvas-1', revision: 3, mode: 'canvas', nodeIds: ['script', 'frame'] })
    expect(context.edges.map(edge => edge.id)).toEqual(['input'])
  })

  test('Given 局部复核 When 显式选择节点 Then 不加入无关节点或伪造关系', () => {
    /** 有界显式范围适用于受影响镜头，无连线节点仍可单独复核。 */
    const context = resolveCanvasAgentReviewContext(reviewDocument(), 'director', { mode: 'nodes', nodeIds: ['frame', 'frame'] })
    expect(context.nodeIds).toEqual(['frame'])
    expect(context.edges).toEqual([])
    expect(() => resolveCanvasAgentReviewContext(reviewDocument(), 'director', { mode: 'nodes', nodeIds: ['missing'] })).toThrow('CANVAS_REVIEW_NODE_NOT_FOUND')
    expect(() => resolveCanvasAgentReviewContext(reviewDocument(), 'director', { mode: 'nodes', nodeIds: [] })).toThrow('CANVAS_REVIEW_SCOPE_INVALID')
    expect(() => resolveCanvasAgentReviewContext(reviewDocument(), 'director', { mode: 'canvas', nodeIds: ['frame'] })).toThrow('CANVAS_REVIEW_SCOPE_INVALID')
  })

  test('Given 分批读取当前正文及关系 When 所有实际结果送达 Then 累积覆盖但不宣称内容质量通过', () => {
    /** 模拟两次节点读取和一次跨范围关系补读。 */
    const document = reviewDocument()
    const tracker = createCanvasAgentReviewTracker(resolveCanvasAgentReviewContext(document, 'director', { mode: 'canvas' }))
    expect(tracker.status()).toMatchObject({ totalNodes: 2, readNodes: 0, unreadNodes: 2, complete: false })
    tracker.record({ canvasId: 'canvas-1', revision: 3, nodes: [readEntry(document, 'script')], edges: [] })
    tracker.record({ canvasId: 'canvas-1', revision: 3, nodes: [{ ...readEntry(document, 'frame'), artifact: { kind: 'image', config: { prompt: '正文' } } }], edges: [] })
    expect(tracker.status()).toMatchObject({ readNodes: 2, missingEdges: 1, complete: false })
    tracker.record({ canvasId: 'canvas-1', revision: 3, nodes: [], edges: document.edges })
    expect(tracker.status()).toMatchObject({ scopeRevision: 3, readNodes: 2, unreadNodes: 0, missingEdges: 0, complete: true, qualityVerdict: 'not-assessed' })
  })

  test('Given 读取失败或正文配置被裁剪 When 记录结果 Then 明确保留未完整项且补读可恢复', () => {
    /** 一份失败正文和一份被裁剪的图片配置均不能算作已完整读取。 */
    const document = reviewDocument()
    const tracker = createCanvasAgentReviewTracker(resolveCanvasAgentReviewContext(document, 'director', { mode: 'canvas' }))
    tracker.record({ canvasId: 'canvas-1', revision: 3, edges: [], nodes: [
      { ...readEntry(document, 'script'), readError: { stage: 'artifact-content' } },
      { ...readEntry(document, 'frame'), artifact: { kind: 'image', configOmitted: true } },
    ] })
    expect(tracker.status()).toMatchObject({ failedNodes: 1, incompleteNodes: 1, readNodes: 0, unreadNodes: 0, failedNodeIds: ['script'], incompleteNodeIds: ['frame'] })
    tracker.record({ canvasId: 'canvas-1', revision: 3, edges: document.edges, nodes: [readEntry(document, 'script')] })
    expect(tracker.status()).toMatchObject({ failedNodes: 0, readNodes: 1, incompleteNodes: 1, complete: false })
    /** 相同图版本下配置也可能独立变化，最新回执被截断不能保留之前的完整状态。 */
    tracker.record({ canvasId: 'canvas-1', revision: 3, edges: [], nodes: [{ ...readEntry(document, 'script'), content: '' }] })
    expect(tracker.status()).toMatchObject({ readNodes: 0, incompleteNodes: 2 })
  })

  test('Given 换画布或读取版本变化 When 结果到达 Then 不合并成同一份审核证据', () => {
    /** 相同ID不能跨图或跨revision增加本轮覆盖。 */
    const document = reviewDocument()
    const tracker = createCanvasAgentReviewTracker(resolveCanvasAgentReviewContext(document, 'director', { mode: 'canvas' }))
    for (const identity of [{ canvasId: 'other', revision: 3 }, { canvasId: 'canvas-1', revision: 4 }]) {
      tracker.record({ ...identity, nodes: [readEntry(document, 'script')], edges: document.edges })
    }
    expect(tracker.status()).toMatchObject({ readNodes: 0, unreadNodes: 2, missingEdges: 1 })
  })

  test('Given 很多未读节点 When 获取进度 Then 只返回有界样本而不复制全图内容', () => {
    /** 大图状态仍提供准确总数，每种诊断最多32个ID。 */
    const document = reviewDocument()
    document.nodes.push(...Array.from({ length: 1000 }, (_, index) => ({
      id: `extra-${index}`, kind: 'image' as const, title: '素材', position: { x: 0, y: index * 200 }, imageModuleId: `module-${index}`,
    })))
    const tracker = createCanvasAgentReviewTracker(resolveCanvasAgentReviewContext(document, 'director', { mode: 'canvas' }))
    expect(tracker.status().unreadNodes).toBe(1002)
    expect(tracker.status().unreadNodeIds).toHaveLength(32)
    expect(JSON.stringify(tracker.status()).length).toBeLessThan(8000)
  })
})
