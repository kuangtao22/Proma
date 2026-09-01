import { describe, expect, test } from 'bun:test'
import {
  createCanvasLayoutSpatialIndex,
  findCompactCanvasSlot,
} from './canvas-layout'

describe('Canvas 共享紧凑布局', () => {
  test('Given 14 个连续候选 When 从同一锚点分配 Then 形成紧凑矩形而非单行', () => {
    const index = createCanvasLayoutSpatialIndex([], 24)
    /** 按稳定顺序逐项占用最近槽位，模拟 Agent 不知道批次总数的连续创建。 */
    const positions = Array.from({ length: 14 }, (_, order) => {
      const position = findCompactCanvasSlot(index, {
        anchor: { x: 0, y: 0 },
        size: { width: 288, height: 144 },
        order,
        direction: 'ring',
      })
      index.insert({ id: `node-${order}`, ...position, width: 288, height: 144 })
      return position
    })

    expect(new Set(positions.map((position) => position.y)).size).toBeGreaterThan(1)
    expect(Math.max(...positions.map((position) => position.x))).toBeLessThan(1_600)
  })

  test('Given 动态尺寸矩形占据首选槽位 When 寻找右侧槽位 Then 避让真实边界和净间距', () => {
    const index = createCanvasLayoutSpatialIndex([{
      id: 'desktop-webview', x: 312, y: 0, width: 384, height: 316,
    }], 24)

    const position = findCompactCanvasSlot(index, {
      anchor: { x: 312, y: 0 },
      size: { width: 232, height: 578 },
      order: 0,
      direction: 'right',
    })

    expect(position).not.toEqual({ x: 312, y: 0 })
    expect(index.overlaps({ ...position, width: 232, height: 578 })).toBe(false)
  })

  test('Given 相同占用和顺序 When 重复计算 Then 返回同一稳定位置', () => {
    /** 每次创建独立索引，证明结果不依赖隐藏的可变全局状态。 */
    const resolve = () => findCompactCanvasSlot(createCanvasLayoutSpatialIndex([{
      id: 'source', x: 0, y: 0, width: 288, height: 144,
    }], 24), {
      anchor: { x: 312, y: 0 },
      size: { width: 288, height: 144 },
      order: 3,
      direction: 'right',
    })

    expect(resolve()).toEqual(resolve())
  })

  test('Given 非有限坐标或非法尺寸 When 建立索引或寻找槽位 Then 明确拒绝', () => {
    expect(() => createCanvasLayoutSpatialIndex([{
      id: 'invalid', x: Number.NaN, y: 0, width: 288, height: 144,
    }], 24)).toThrow('CANVAS_LAYOUT_RECT_INVALID')
    const index = createCanvasLayoutSpatialIndex([], 24)
    expect(() => findCompactCanvasSlot(index, {
      anchor: { x: Number.POSITIVE_INFINITY, y: 0 },
      size: { width: 288, height: 144 },
      order: 0,
      direction: 'ring',
    })).toThrow('CANVAS_LAYOUT_INPUT_INVALID')
  })
})
