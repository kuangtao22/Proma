import { describe, expect, test } from 'bun:test'
import type { CanvasLayoutRect } from '@proma/shared'
import { arrangeNativeCanvasLayout } from './native-canvas-layout'
import type { NativeCanvasLayoutInput } from './native-canvas-layout'
import { withNativeCanvasLayoutEngine } from './native-canvas-layout-client'

/** 将简洁的关系 fixture 转成只含几何的真实引擎请求。 */
function createInput(ids: string[], edges: NativeCanvasLayoutInput['edges'] = []): NativeCanvasLayoutInput {
  return {
    nodes: ids.map((id) => ({ id, x: 200, y: 100, width: 288, height: 144 })),
    edges, scopeNodeIds: ids, blockedNodeIds: new Set(),
  }
}

/** 每项测试创建并释放真实 Worker，不让假引擎证明布局质量。 */
async function arrange(input: NativeCanvasLayoutInput): Promise<CanvasLayoutRect[]> {
  const mutation = await withNativeCanvasLayoutEngine((layout) => arrangeNativeCanvasLayout(input, layout), {
    workerFactory: () => new Worker(import.meta.resolve('elkjs/lib/elk-worker.min.js')),
  })
  const positions = new Map(mutation.positions.map((entry) => [entry.nodeId, entry.position]))
  return input.nodes.map((node) => ({ ...node, ...positions.get(node.id) }))
}

/** 以真实矩形逐对验证净间距；测试规模小，不复用生产空间索引以免同错同过。 */
function expectSeparated(nodes: readonly CanvasLayoutRect[]): void {
  for (let left = 0; left < nodes.length; left += 1) for (let right = left + 1; right < nodes.length; right += 1) {
    const a = nodes[left]!
    const b = nodes[right]!
    expect(a.x + a.width + 24 <= b.x || b.x + b.width + 24 <= a.x
      || a.y + a.height + 24 <= b.y || b.y + b.height + 24 <= a.y).toBeTrue()
  }
}

describe('Canvas 关系布局真实 Worker', () => {
  test('Given 分叉汇合和反向引用 When 整理 Then 真实依赖层级不被弱引用反转', async () => {
    const input = createInput(['a', 'b', 'c', 'd'], [
      { sourceNodeId: 'a', targetNodeId: 'b', relation: 'depends-on' },
      { sourceNodeId: 'a', targetNodeId: 'c', relation: 'derives' },
      { sourceNodeId: 'b', targetNodeId: 'd', relation: 'depends-on' },
      { sourceNodeId: 'c', targetNodeId: 'd', relation: 'depends-on' },
      { sourceNodeId: 'd', targetNodeId: 'a', relation: 'reference' },
    ])
    const before = structuredClone(input)
    const result = await arrange(input)
    const positions = new Map(result.map((node) => [node.id, node]))
    for (const edge of input.edges.filter((edge) => edge.relation !== 'reference')) {
      const source = positions.get(edge.sourceNodeId)!
      expect(positions.get(edge.targetNodeId)!.x).toBeGreaterThanOrEqual(source.x + source.width + 24)
    }
    expectSeparated(result)
    expect(input).toEqual(before)
  })

  test('Given 共用参考素材连接两条流程 When 整理 Then 素材在流程前且各自上下游仍对齐', async () => {
    const input = createInput(['reference', 'a', 'a-result', 'b', 'b-result'], [
      { sourceNodeId: 'reference', targetNodeId: 'a', relation: 'reference' },
      { sourceNodeId: 'reference', targetNodeId: 'b', relation: 'reference' },
      { sourceNodeId: 'a', targetNodeId: 'a-result', relation: 'depends-on' },
      { sourceNodeId: 'b', targetNodeId: 'b-result', relation: 'depends-on' },
    ])
    const result = await arrange(input)
    const positions = new Map(result.map((node) => [node.id, node]))
    for (const id of ['a', 'b']) {
      expect(positions.get(id)!.x).toBeGreaterThan(positions.get('reference')!.x)
      expect(positions.get(id)!.y).toBe(positions.get(`${id}-result`)!.y)
    }
    expectSeparated(result)
  })

  test('Given 只有无向关联的四张卡片 When 交换关联端点 Then 布局相同且不会被拉成长链', async () => {
    const input = createInput(['a', 'b', 'c', 'd'], ['b', 'c', 'd'].map((id, index) => ({
      sourceNodeId: ['a', 'b', 'c'][index]!, targetNodeId: id, relation: 'association',
    })))
    const result = await arrange(input)
    const reversed = await arrange({ ...input, edges: input.edges.map((edge) => ({
      ...edge, sourceNodeId: edge.targetNodeId, targetNodeId: edge.sourceNodeId,
    })) })
    expect(reversed).toEqual(result)
    expect(Math.max(...result.map((node) => node.x)) - Math.min(...result.map((node) => node.x)))
      .toBeLessThan(3 * 288)
    expectSeparated(result)
  })

  test('Given 同一参考素材引用十六条末端流程 When 整理 Then 流程以网格聚拢且内部层级不变', async () => {
    const branches = Array.from({ length: 16 }, (_, index) => [`start-${index}`, `end-${index}`])
    const input = createInput(['reference', ...branches.flat()], branches.flatMap(([start, end]) => [
      { sourceNodeId: 'reference', targetNodeId: start!, relation: 'reference' as const },
      { sourceNodeId: start!, targetNodeId: end!, relation: 'depends-on' as const },
    ]))
    const result = await arrange(input)
    const positions = new Map(result.map((node) => [node.id, node]))
    const starts = branches.map(([start]) => positions.get(start!)!)
    expect(new Set(starts.map((node) => node.x)).size).toBeGreaterThan(1)
    expect(new Set(starts.map((node) => node.y)).size).toBeGreaterThan(1)
    for (const [start, end] of branches) {
      expect(positions.get(start!)!.y).toBe(positions.get(end!)!.y)
      expect(positions.get(end!)!.x).toBeGreaterThan(positions.get(start!)!.x)
      expect(positions.get(start!)!.x).toBeGreaterThan(positions.get('reference')!.x)
    }
    expectSeparated(result)
  })

  test('Given 依赖循环和断开节点 When 整理两次 Then 有限完成且第二次不产生位置漂移', async () => {
    const input = createInput(['a', 'b', 'c', 'isolated'], [
      { sourceNodeId: 'a', targetNodeId: 'b', relation: 'derives' },
      { sourceNodeId: 'b', targetNodeId: 'c', relation: 'depends-on' },
      { sourceNodeId: 'c', targetNodeId: 'a', relation: 'depends-on' },
    ])
    const first = await arrange(input)
    expect(await arrange({ ...input, nodes: first, scopeNodeIds: [...input.scopeNodeIds].reverse() })).toEqual(first)
    expectSeparated(first)
  })

  test('Given 同源末端混有多来源和后续引用 When 整理 Then 保留汇合与后续流程方向', async () => {
    const sinks = Array.from({ length: 8 }, (_, index) => `sink-${index}`)
    const input = createInput(['reference', 'other', ...sinks, 'tail'], [
      ...sinks.map((id) => ({ sourceNodeId: 'reference', targetNodeId: id, relation: 'reference' as const })),
      { sourceNodeId: 'other', targetNodeId: 'sink-6', relation: 'reference' },
      { sourceNodeId: 'sink-7', targetNodeId: 'tail', relation: 'reference' },
    ])
    const result = await arrange(input)
    const positions = new Map(result.map((node) => [node.id, node]))
    for (const edge of input.edges) {
      expect(positions.get(edge.targetNodeId)!.x).toBeGreaterThan(positions.get(edge.sourceNodeId)!.x)
    }
    expectSeparated(result)
  })

  test('Given 混合卡片尺寸且选区外有高卡片 When 整理 Then 整体避障并保留内部层级', async () => {
    const input = createInput(['fixed', 'a', 'b', 'c'], [
      { sourceNodeId: 'a', targetNodeId: 'b', relation: 'depends-on' },
      { sourceNodeId: 'b', targetNodeId: 'c', relation: 'derives' },
    ])
    input.nodes[0]!.height = 1000
    input.nodes[1]!.height = 368
    input.nodes[2]!.width = 384
    input.nodes[2]!.height = 316
    input.nodes[3]!.height = 578
    input.scopeNodeIds = ['a', 'b', 'c']
    const result = await arrange(input)
    expect(result[0]).toEqual(input.nodes[0])
    expect(result[2]!.x).toBeGreaterThan(result[1]!.x + result[1]!.width)
    expect(result[3]!.x).toBeGreaterThan(result[2]!.x + result[2]!.width)
    expectSeparated(result)
  })

  test('Given 全部节点正在运行 When 整理 Then 不调用布局引擎', async () => {
    const input = createInput(['a', 'b'])
    input.blockedNodeIds = new Set(['a', 'b'])
    const result = await arrangeNativeCanvasLayout(input, async () => { throw new Error('不应启动引擎') })
    expect(result.positions).toEqual([])
  })

  test('Given 固定卡片接近坐标上限 When 避障超过几何范围 Then 拒绝输出越界位置', async () => {
    const input = createInput(['fixed', 'movable'])
    input.nodes.forEach((node) => { node.y = 1e9 })
    input.scopeNodeIds = ['movable']
    await expect(arrangeNativeCanvasLayout(input, async () => { throw new Error('单节点不应启动引擎') }))
      .rejects.toThrow('CANVAS_LAYOUT_GEOMETRY_INVALID')
  })

  test('Given 引擎缺少节点或返回非有限坐标 When 整理 Then 拒绝整个结果', async () => {
    const input = createInput(['a', 'b'])
    await expect(arrangeNativeCanvasLayout(input, async () => ({
      id: 'root', children: [{ id: 'a', x: 0, y: 0 }],
    }))).rejects.toThrow('CANVAS_LAYOUT_RESULT_INVALID')
    await expect(arrangeNativeCanvasLayout(input, async () => ({
      id: 'root', children: [{ id: 'a', x: NaN, y: 0 }, { id: 'b', x: 400, y: 0 }],
    }))).rejects.toThrow('CANVAS_LAYOUT_RESULT_INVALID')
  })

  test('Given 引擎返回重叠卡片 When 整理 Then 不输出部分成功位置', async () => {
    await expect(arrangeNativeCanvasLayout(createInput(['a', 'b']), async () => ({
      id: 'root', children: [{ id: 'a', x: 0, y: 0 }, { id: 'b', x: 0, y: 0 }],
    }))).rejects.toThrow('CANVAS_LAYOUT_RESULT_OVERLAP')
  })

  test('Given 超过单次预算 When 整理 Then 在发往引擎前要求缩小范围', async () => {
    const input = createInput(Array.from({ length: 2001 }, (_, index) => `node-${index}`))
    await expect(arrangeNativeCanvasLayout(input, async () => { throw new Error('不应启动计算') }))
      .rejects.toThrow('CANVAS_LAYOUT_TOO_LARGE')
  })
})
