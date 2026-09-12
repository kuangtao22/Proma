import { describe, expect, test } from 'bun:test'
import { createEmptyCanvasDocument } from '@proma/shared'
import type { CanvasDocument, CanvasNode, DesignPoint } from '@proma/shared'
import { resolveCanvasAgentReviewPosition } from './canvas-agent-review-layout'

/** 创建布局测试使用的完整 Canvas 文档，边只用于验证纯函数不会改写业务图。 */
function createDocument(nodes: CanvasNode[]): CanvasDocument {
  return {
    ...createEmptyCanvasDocument('project-1', 'canvas-1', 1),
    revision: 1,
    nodes,
    edges: [{
      id: 'reference-edge', sourceNodeId: 'reference', sourcePort: 'unbound',
      targetNodeId: 'shot-a', targetPort: 'unbound', relation: 'reference',
    }],
  }
}

/** 创建不含运行时消息的最小 Agent 节点。 */
function agent(id: string, position: DesignPoint): CanvasNode {
  return { id, kind: 'agent', title: id, position, agentSessionId: `session-${id}` }
}

/** 创建图片制作节点；已采用素材会在 Renderer 中按预览比例增加高度。 */
function image(id: string, position: DesignPoint, adoptedAssetId?: string): CanvasNode {
  return {
    id,
    kind: 'image',
    title: id,
    position,
    imageModuleId: `image-${id}`,
    ...(adoptedAssetId === undefined ? {} : { adoptedAssetId }),
  }
}

/** 创建具有真实桌面或手机尺寸的 WebView 节点。 */
function webview(id: string, position: DesignPoint, devicePreset: 'desktop' | 'mobile' = 'desktop'): CanvasNode {
  return { id, kind: 'webview', title: id, position, prototypeId: `prototype-${id}`, contentRevision: 1, devicePreset }
}

describe('Canvas Agent 审核布局', () => {
  test('Given 制作节点 When 定位审核 Agent Then 左置紧邻目标且不改写业务边或其它节点', () => {
    const document = createDocument([
      agent('reviewer', { x: 1_000, y: 900 }),
      image('reference', { x: -200, y: 200 }),
      image('shot-a', { x: 600, y: 200 }),
    ])
    const original = structuredClone(document)

    const position = resolveCanvasAgentReviewPosition(document, 'reviewer', ['shot-a'])

    expect(position).toEqual({ x: 288, y: 200 })
    expect(position.x + 288 + 24).toBeLessThanOrEqual(600)
    expect(document).toEqual(original)
  })

  test('Given 参考素材占据首选左侧位置 When 定位审核 Agent Then 保留素材并寻找不重叠槽位', () => {
    const document = createDocument([
      agent('reviewer', { x: 1_000, y: 900 }),
      image('reference', { x: 288, y: 200 }),
      image('shot-a', { x: 600, y: 200 }),
    ])

    const position = resolveCanvasAgentReviewPosition(document, 'reviewer', ['shot-a'])

    expect(position).toEqual({ x: 288, y: 368 })
    expect(position.x + 288 + 24).toBeLessThanOrEqual(600)
  })

  test('Given 已采用的纵向参考图占据首选槽位 When 定位审核 Agent Then 避开其最大预览高度', () => {
    const document = createDocument([
      agent('reviewer', { x: 1_000, y: 900 }),
      image('reference', { x: 288, y: 200 }, 'asset-portrait'),
      image('shot-a', { x: 600, y: 200 }),
    ])

    const position = resolveCanvasAgentReviewPosition(document, 'reviewer', ['shot-a'])

    expect(position).not.toEqual({ x: 288, y: 368 })
    expect(
      position.y + 144 + 24 <= 200
      || position.y >= 200 + 368 + 24
      || position.x + 288 + 24 <= 288,
    ).toBeTrue()
    expect(position.x + 288 + 24).toBeLessThanOrEqual(600)
  })

  test('Given Agent 已在合法左侧相邻位置 When 重复定位 Then 返回原坐标', () => {
    const document = createDocument([
      agent('reviewer', { x: 288, y: 200 }),
      image('reference', { x: -200, y: 200 }),
      image('shot-a', { x: 600, y: 200 }),
    ])

    expect(resolveCanvasAgentReviewPosition(document, 'reviewer', ['shot-a'])).toEqual({ x: 288, y: 200 })
  })

  test('Given 无效 Agent 或目标集合 When 定位 Then 严格拒绝未知、自引用、重复与越界输入', () => {
    const document = createDocument([
      agent('reviewer', { x: 0, y: 0 }),
      image('shot-a', { x: 600, y: 200 }),
    ])

    expect(() => resolveCanvasAgentReviewPosition(document, 'missing', ['shot-a']))
      .toThrow('CANVAS_AGENT_REVIEW_AGENT_INVALID')
    expect(() => resolveCanvasAgentReviewPosition(document, 'shot-a', ['reviewer']))
      .toThrow('CANVAS_AGENT_REVIEW_AGENT_INVALID')
    expect(() => resolveCanvasAgentReviewPosition(document, 'reviewer', []))
      .toThrow('CANVAS_AGENT_REVIEW_TARGETS_INVALID')
    expect(() => resolveCanvasAgentReviewPosition(document, 'reviewer', ['missing']))
      .toThrow('CANVAS_AGENT_REVIEW_TARGET_INVALID')
    expect(() => resolveCanvasAgentReviewPosition(document, 'reviewer', ['reviewer']))
      .toThrow('CANVAS_AGENT_REVIEW_TARGET_SELF')
    expect(() => resolveCanvasAgentReviewPosition(document, 'reviewer', ['shot-a', 'shot-a']))
      .toThrow('CANVAS_AGENT_REVIEW_TARGETS_DUPLICATE')
    expect(() => resolveCanvasAgentReviewPosition(document, 'reviewer', Array.from({ length: 129 }, (_, index) => `node-${index}`)))
      .toThrow('CANVAS_AGENT_REVIEW_TARGETS_INVALID')
  })

  test('Given 多个制作节点以不同顺序传入 When 定位 Then 使用同一稳定左置位置', () => {
    const document = createDocument([
      agent('reviewer', { x: 1_000, y: 900 }),
      image('shot-a', { x: 900, y: 0 }),
      webview('shot-b', { x: 600, y: 100 }, 'mobile'),
    ])

    const forward = resolveCanvasAgentReviewPosition(document, 'reviewer', ['shot-a', 'shot-b'])
    const reverse = resolveCanvasAgentReviewPosition(document, 'reviewer', ['shot-b', 'shot-a'])

    expect(forward).toEqual(reverse)
    expect(forward.x + 288 + 24).toBeLessThanOrEqual(600)
  })

  test('Given 一千个节点 When 重复定位 Then 返回稳定位置且不依赖遍历耗时阈值', () => {
    /** 网格化障碍模拟大型项目，测试只约束正确性和确定性。 */
    const blockers = Array.from({ length: 998 }, (_, index) => image(`blocker-${index}`, {
      x: 5_000 + (index % 32) * 312,
      y: Math.floor(index / 32) * 168,
    }))
    const document = createDocument([
      agent('reviewer', { x: -10_000, y: -10_000 }),
      image('shot-a', { x: 600, y: 200 }),
      ...blockers,
    ])

    const first = resolveCanvasAgentReviewPosition(document, 'reviewer', ['shot-a'])
    const second = resolveCanvasAgentReviewPosition(document, 'reviewer', ['shot-a'])

    expect(first).toEqual(second)
    expect(first.x + 288 + 24).toBeLessThanOrEqual(600)
  })
})
