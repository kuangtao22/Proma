import { describe, expect, test } from 'bun:test'
import { createEmptyCanvasDocument } from '@proma/shared'
import type { CanvasDocument, CanvasNode } from '@proma/shared'
import { createStore } from 'jotai'
import {
  agentCanvasViewStatesAtom,
  createAgentCanvasViewKey,
  createInitialAgentCanvasViewState,
  updateAgentCanvasViewStateAtom,
} from '@/atoms/agent-canvas-atoms'
import { buildNativeCanvasNavigationItems, createNativeCanvasNodeFocusUpdate, createNativeCanvasChangedNodesFocusUpdate } from './native-canvas-navigation'

/** 构造只包含导航所需数据的文档节点。 */
function documentNode(id: string, title = id): CanvasNode {
  return { id, title, kind: 'document', documentId: id, contentRevision: 0, position: { x: 6000, y: -3000 } }
}

describe('画布节点导航', () => {
  test('Given 重名、孤立与循环关联 When 构建菜单 Then 所有节点保留且方向与真实连线一致', () => {
    /** 多父与循环不能被导航菜单强行转成单父树。 */
    const nodes = [documentNode('a', '同名'), documentNode('b', '同名'), documentNode('c'), documentNode('d')]
    const items = buildNativeCanvasNavigationItems(nodes, [
      { id: 'ab', sourceNodeId: 'a', targetNodeId: 'b', relation: 'reference' },
      { id: 'cb', sourceNodeId: 'c', targetNodeId: 'b', relation: 'depends-on' },
      { id: 'ba', sourceNodeId: 'b', targetNodeId: 'a', relation: 'derives' },
      { id: 'ac', sourceNodeId: 'a', targetNodeId: 'c', relation: 'association' },
      { id: 'missing', sourceNodeId: 'missing', targetNodeId: 'd', relation: 'reference' },
    ])
    expect(items.map((item) => item.id)).toEqual(['a', 'b', 'c', 'd'])
    expect(items[0]?.relations.map((link) => [link.direction, link.nodeId, link.relation]))
      .toEqual([['downstream', 'b', 'reference'], ['upstream', 'b', 'derives'], ['association', 'c', 'association']])
    expect(items[1]?.relations.filter((link) => link.direction === 'upstream').map((link) => link.nodeId)).toEqual(['a', 'c'])
    expect(items[2]?.relations.at(-1)?.direction).toBe('association')
    expect(items[3]?.relations).toEqual([])
    expect(nodes.map((node) => node.title)).toEqual(['同名', '同名', 'c', 'd'])
  })

  test('Given 空画布 When 构建导航 Then 返回空列表', () => {
    expect(buildNativeCanvasNavigationItems([], [])).toEqual([])
  })

  test('Given 远处节点与极小缩放 When 定位 Then 卡片进入视口并恢复可读缩放', () => {
    /** 定位只返回视图补丁，不包含业务图 mutation。 */
    const update = createNativeCanvasNodeFocusUpdate(documentNode('far'), { width: 288, height: 144 },
      { x: 10, y: 20, zoom: 0.05 }, { width: 900, height: 600 })
    expect(update.selectedNodeIds).toEqual(['far'])
    expect(update.selectedNodeId).toBe('far')
    expect(update.viewport.zoom).toBeGreaterThanOrEqual(0.75)
    expect((6000 + 144) * update.viewport.zoom + update.viewport.x).toBeCloseTo(450)
    expect((-3000 + 72) * update.viewport.zoom + update.viewport.y).toBeCloseTo(320)
    expect(Object.keys(update).sort()).toEqual(['selectedNodeId', 'selectedNodeIds', 'viewport'])
  })

  test('Given 窄面板与高卡片 When 定位 Then 按实际尺寸缩小并留出工具栏空间', () => {
    const update = createNativeCanvasNodeFocusUpdate(documentNode('tall'), { width: 232, height: 578 },
      { x: 0, y: 0, zoom: 2 }, { width: 340, height: 420 })
    expect(update.viewport.zoom).toBeLessThan(1)
    expect(-3000 * update.viewport.zoom + update.viewport.y).toBeGreaterThanOrEqual(64)
    expect((-3000 + 578) * update.viewport.zoom + update.viewport.y).toBeLessThanOrEqual(396)
  })

  test('Given 面板暂未测量 When 定位 Then 仍能选择且不写入无效视口', () => {
    const viewport = { x: 10, y: 20, zoom: 1 }
    const update = createNativeCanvasNodeFocusUpdate(documentNode('a'), { width: 288, height: 144 },
      viewport, { width: 0, height: 0 })
    expect(update.viewport).toEqual(viewport)
    expect(update.selectedNodeId).toBe('a')
  })

  test('Given 两个会话共用画布 When 当前会话定位 Then 不改变另一会话、图或工作台草稿', () => {
    const store = createStore()
    const document: CanvasDocument = createEmptyCanvasDocument('project-1', 'canvas-1', 1)
    document.nodes = [documentNode('a')]
    const original = structuredClone(document)
    const key = createAgentCanvasViewKey('session-1', 'project-1', 'canvas-1')
    const otherKey = createAgentCanvasViewKey('session-2', 'project-1', 'canvas-1')
    const view = { ...createInitialAgentCanvasViewState(document.viewport), expandedNodeId: 'draft-node' }
    store.set(agentCanvasViewStatesAtom, new Map([[key, view], [otherKey, view]]))
    store.set(updateAgentCanvasViewStateAtom, { key, update: createNativeCanvasNodeFocusUpdate(document.nodes[0]!,
      { width: 288, height: 144 }, view.viewport, { width: 900, height: 600 }) })
    expect(store.get(agentCanvasViewStatesAtom).get(key)?.selectedNodeId).toBe('a')
    expect(store.get(agentCanvasViewStatesAtom).get(key)?.expandedNodeId).toBe('draft-node')
    expect(store.get(agentCanvasViewStatesAtom).get(otherKey)).toBe(view)
    expect(document).toEqual(original)
  })
})


describe('画布修改批量定位', () => {
  test('Given 两个远处节点与已删除节点 When 定位修改 Then 包围现存节点且剔除删除节点', () => {
    const nodes = [
      { id: 'a', position: { x: 6000, y: -3000 } },
      { id: 'b', position: { x: 6400, y: -2600 } },
    ]
    const sizes = new Map([['a', { width: 288, height: 210 }], ['b', { width: 288, height: 368 }]])
    const update = createNativeCanvasChangedNodesFocusUpdate(nodes, ['a', 'b', 'deleted'], sizes,
      { x: 0, y: 0, zoom: 0.1 }, { width: 900, height: 800 })
    expect(update.selectedNodeIds).toEqual(['a', 'b'])
    expect(6000 * update.viewport.zoom + update.viewport.x).toBeGreaterThan(0)
    expect((6400 + 288) * update.viewport.zoom + update.viewport.x).toBeLessThan(900)
    expect((-2600 + 368) * update.viewport.zoom + update.viewport.y).toBeLessThan(800)
  })
  test('Given 回执目标已全部删除 When 定位 Then 保持原视口且清除选区', () => {
    const viewport = { x: 10, y: 20, zoom: 0.5 }
    expect(createNativeCanvasChangedNodesFocusUpdate([], ['deleted'], new Map(), viewport, { width: 900, height: 600 }))
      .toEqual({ viewport, selectedNodeId: null, selectedNodeIds: [] })
  })
})
