import { describe, expect, test } from 'bun:test'
import type { JsonObject } from '@proma/shared'
import * as subgraphModule from './media-ui-workflow-subgraphs'

interface ExpectedSubgraphModule {
  flattenComfyUiSubgraphs(body: JsonObject): {
    definition: JsonObject
    inputOverrides: Record<string, Record<string, import('@proma/shared').JsonValue>>
    issues: Array<{ code: string; message: string; nodeId?: string; input?: string }>
  }
}

/** RED 阶段通过期望接口读取尚未实现的模块。 */
function subject(): ExpectedSubgraphModule {
  return subgraphModule as unknown as ExpectedSubgraphModule
}

/** 创建包含一个 canonical 子图实例的最小 UI 图。 */
function canonicalBody(hostId: number, prompt = 'host prompt'): JsonObject {
  return {
    nodes: [
      { id: 1, type: 'Source', inputs: [], outputs: [{ name: 'IMAGE', type: 'IMAGE', links: [10] }], widgets_values: [] },
      { id: hostId, type: 'subgraph-image', mode: 0, inputs: [
        { id: 'host-image', name: 'image', type: 'IMAGE', link: 10 },
        { id: 'host-prompt', name: 'prompt', type: 'STRING', widget: { name: 'prompt' }, link: null },
      ], outputs: [{ id: 'host-output', name: 'IMAGE', type: 'IMAGE', links: [11] }], widgets_values: [prompt] },
      { id: 200, type: 'Sink', inputs: [{ name: 'images', type: 'IMAGE', link: 11 }], outputs: [], widgets_values: [] },
    ],
    links: [[10, 1, 0, hostId, 0, 'IMAGE'], [11, hostId, 0, 200, 0, 'IMAGE']],
    definitions: { subgraphs: [{
      id: 'subgraph-image', version: 1, inputNode: { id: -10 }, outputNode: { id: -20 },
      inputs: [
        { id: 'interface-image', name: 'image', type: 'IMAGE', linkIds: [101] },
        { id: 'interface-prompt', name: 'prompt', type: 'STRING', linkIds: [102] },
      ],
      outputs: [{ id: 'interface-output', name: 'IMAGE', type: 'IMAGE', linkIds: [103] }],
      widgets: [],
      nodes: [{ id: 2, type: 'InnerNode', mode: 0, inputs: [
        { name: 'image', type: 'IMAGE', link: 101 },
        { name: 'prompt', type: 'STRING', widget: { name: 'prompt' }, link: 102 },
      ], outputs: [{ name: 'IMAGE', type: 'IMAGE', links: [103] }], widgets_values: ['definition default'] }],
      links: [
        { id: 101, origin_id: -10, origin_slot: 0, target_id: 2, target_slot: 0, type: 'IMAGE' },
        { id: 102, origin_id: -10, origin_slot: 1, target_id: 2, target_slot: 1, type: 'STRING' },
        { id: 103, origin_id: 2, origin_slot: 0, target_id: -20, target_slot: 0, type: 'IMAGE' },
      ],
    }] },
  }
}

describe('ComfyUI canonical 子图展开', () => {
  test('Given canonical 边界和 host widget When 展开 Then 重接输入输出并返回显式字段覆盖', () => {
    const result = subject().flattenComfyUiSubgraphs(canonicalBody(100))
    expect(result.issues).toEqual([])
    expect((result.definition.nodes as JsonObject[]).map((node) => node.id)).toEqual([1, '100::2', 200])
    expect(result.definition.links).toEqual([
      ['10', '1', 0, '100::2', 0, 'IMAGE'],
      ['11', '100::2', 0, '200', 0, 'IMAGE'],
    ])
    expect(result.inputOverrides).toEqual({ '100::2': { prompt: 'host prompt' } })
  })

  test('Given 同一定义的两个实例 When 展开 Then 内部节点身份和 widget 值按实例隔离', () => {
    const first = canonicalBody(100, 'first')
    const secondHost = structuredClone((first.nodes as JsonObject[])[1]!)
    secondHost.id = 101
    secondHost.widgets_values = ['second']
    secondHost.inputs = [
      { id: 'host-image-2', name: 'image', type: 'IMAGE', link: 12 },
      { id: 'host-prompt-2', name: 'prompt', type: 'STRING', widget: { name: 'prompt' }, link: null },
    ]
    secondHost.outputs = [{ id: 'host-output-2', name: 'IMAGE', type: 'IMAGE', links: [13] }]
    ;(((first.nodes as JsonObject[])[0]!.outputs as JsonObject[])[0]!).links = [10, 12]
    ;(first.nodes as JsonObject[]).push(secondHost, { id: 201, type: 'Sink', inputs: [{ name: 'images', link: 13 }], outputs: [], widgets_values: [] })
    ;(first.links as import('@proma/shared').JsonValue[]).push([12, 1, 0, 101, 0, 'IMAGE'], [13, 101, 0, 201, 0, 'IMAGE'])
    const result = subject().flattenComfyUiSubgraphs(first)
    expect(result.issues).toEqual([])
    expect((result.definition.nodes as JsonObject[]).map((node) => node.id)).toEqual(expect.arrayContaining(['100::2', '101::2']))
    expect(result.inputOverrides).toEqual({ '100::2': { prompt: 'first' }, '101::2': { prompt: 'second' } })
  })

  test('Given host 遗留 proxy 或 widget 数量无法一一映射 When 展开 Then 隔离该实例并返回稳定原因', () => {
    const proxy = canonicalBody(100)
    ;((proxy.nodes as JsonObject[])[1]!.properties as JsonObject) = { proxyWidgets: [['prompt', 2, 'prompt']] }
    const proxyResult = subject().flattenComfyUiSubgraphs(proxy)
    expect(proxyResult.issues).toContainEqual(expect.objectContaining({ code: 'UI_SUBGRAPH_PROXY_UNSUPPORTED', nodeId: '100' }))
    expect(JSON.stringify(proxyResult.definition)).toContain('subgraph-image')

    const widgets = canonicalBody(100)
    ;(widgets.nodes as JsonObject[])[1]!.widgets_values = ['prompt', 'orphan']
    const widgetResult = subject().flattenComfyUiSubgraphs(widgets)
    expect(widgetResult.issues).toContainEqual(expect.objectContaining({ code: 'UI_SUBGRAPH_WIDGET_MAPPING_UNSUPPORTED', nodeId: '100' }))
  })

  test('Given MiniMax 旧图的 host 仅有部分接口且根 link 槽位冲突 When 展开 Then 不猜测修复并精确报告接口问题', () => {
    const body = canonicalBody(105)
    const host = (body.nodes as JsonObject[])[1]!
    host.inputs = (host.inputs as import('@proma/shared').JsonValue[]).slice(0, 1)
    ;(body.links as import('@proma/shared').JsonValue[])[0] = [10, 1, 0, 105, 2, 'IMAGE']
    const result = subject().flattenComfyUiSubgraphs(body)
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'UI_SUBGRAPH_INPUT_MISMATCH', nodeId: '105' }))
    expect(result.inputOverrides).toEqual({})
    expect(JSON.stringify(result.definition)).toContain('subgraph-image')
  })

  test('Given 子图定义形成递归或展开超过节点上限 When 展开 Then 有界失败且不产生半展开结果', () => {
    const cycle = canonicalBody(100)
    const definition = (((cycle.definitions as JsonObject).subgraphs as JsonObject[])[0]!)
    definition.nodes = [{ id: 2, type: 'subgraph-image', inputs: [
      { id: 'nested-image', name: 'image', type: 'IMAGE', link: 101 },
      { id: 'nested-prompt', name: 'prompt', type: 'STRING', widget: { name: 'prompt' }, link: 102 },
    ], outputs: [{ id: 'nested-output', name: 'IMAGE', type: 'IMAGE', links: [103] }], widgets_values: ['nested'] }]
    const cycleResult = subject().flattenComfyUiSubgraphs(cycle)
    expect(cycleResult.issues).toContainEqual(expect.objectContaining({ code: 'UI_SUBGRAPH_CYCLE' }))
    expect(JSON.stringify(cycleResult.definition)).toContain('subgraph-image')

    const oversized = canonicalBody(100)
    const oversizedDefinition = ((((oversized.definitions as JsonObject).subgraphs as JsonObject[])[0]!))
    const boundaryNode = (oversizedDefinition.nodes as JsonObject[])[0]!
    oversizedDefinition.nodes = [boundaryNode, ...Array.from({ length: 511 }, (_, index) => ({ id: index + 3, type: 'InnerNode', inputs: [], outputs: [], widgets_values: [] }))]
    const oversizedResult = subject().flattenComfyUiSubgraphs(oversized)
    expect(oversizedResult.issues).toContainEqual(expect.objectContaining({ code: 'UI_SUBGRAPH_LIMIT_EXCEEDED', nodeId: '100' }))
  })

  test('Given 外层 host widget 覆盖嵌套子图输入 When 逐层展开 Then 具名值传到最终内部节点且不保留中间覆盖', () => {
    const body = canonicalBody(100, 'outer prompt')
    const definitions = (body.definitions as JsonObject).subgraphs as JsonObject[]
    const innerDefinition = structuredClone(definitions[0]!)
    innerDefinition.id = 'subgraph-inner'
    const outerNode = ((definitions[0]!.nodes as JsonObject[])[0]!)
    outerNode.type = 'subgraph-inner'
    outerNode.inputs = [
      { id: 'nested-image', name: 'image', type: 'IMAGE', link: 101 },
      { id: 'nested-prompt', name: 'prompt', type: 'STRING', widget: { name: 'prompt' }, link: 102 },
    ]
    outerNode.outputs = [{ id: 'nested-output', name: 'IMAGE', type: 'IMAGE', links: [103] }]
    definitions.push(innerDefinition)
    const result = subject().flattenComfyUiSubgraphs(body)
    expect(result.issues).toEqual([])
    expect((result.definition.nodes as JsonObject[]).map((node) => node.id)).toContain('100::2::2')
    expect(result.inputOverrides).toEqual({ '100::2::2': { prompt: 'outer prompt' } })
  })

  test('Given 内部普通边 target 声明矛盾或存在未登记边界边 When 展开 Then 不静默修复或丢边', () => {
    const contradictory = canonicalBody(100)
    const subgraph = (((contradictory.definitions as JsonObject).subgraphs as JsonObject[])[0]!)
    const source = (subgraph.nodes as JsonObject[])[0]!
    source.outputs = [{ name: 'IMAGE', type: 'IMAGE', links: [104] }]
    ;(subgraph.nodes as JsonObject[]).push({ id: 3, type: 'SecondInner', inputs: [{ name: 'image', type: 'IMAGE', link: 999 }], outputs: [{ name: 'IMAGE', type: 'IMAGE', links: [103] }], widgets_values: [] })
    ;(subgraph.links as JsonObject[])[2] = { id: 103, origin_id: 3, origin_slot: 0, target_id: -20, target_slot: 0, type: 'IMAGE' }
    ;(subgraph.links as JsonObject[]).push({ id: 104, origin_id: 2, origin_slot: 0, target_id: 3, target_slot: 0, type: 'IMAGE' })
    expect(subject().flattenComfyUiSubgraphs(contradictory).issues)
      .toContainEqual(expect.objectContaining({ code: 'UI_SUBGRAPH_LINK_INVALID', nodeId: '100' }))

    const undeclared = canonicalBody(100)
    const undeclaredDefinition = (((undeclared.definitions as JsonObject).subgraphs as JsonObject[])[0]!)
    ;(undeclaredDefinition.links as JsonObject[]).push({ id: 104, origin_id: -10, origin_slot: 0, target_id: 2, target_slot: 0, type: 'IMAGE' })
    expect(subject().flattenComfyUiSubgraphs(undeclared).issues)
      .toContainEqual(expect.objectContaining({ code: 'UI_SUBGRAPH_LINK_INVALID', nodeId: '100' }))
  })

  test('Given 一个外部输入扇出到多个内部节点 When 展开 Then 同步更新 source output 的完整边列表', () => {
    const body = canonicalBody(100)
    const subgraph = (((body.definitions as JsonObject).subgraphs as JsonObject[])[0]!)
    ;(subgraph.inputs as JsonObject[])[0]!.linkIds = [101, 104]
    ;(subgraph.nodes as JsonObject[]).push({ id: 3, type: 'SecondInner', inputs: [{ name: 'image', type: 'IMAGE', link: 104 }], outputs: [], widgets_values: [] })
    ;(subgraph.links as JsonObject[]).push({ id: 104, origin_id: -10, origin_slot: 0, target_id: 3, target_slot: 0, type: 'IMAGE' })
    const result = subject().flattenComfyUiSubgraphs(body)
    expect(result.issues).toEqual([])
    const source = (result.definition.nodes as JsonObject[]).find((node) => node.id === 1)!
    expect(((source.outputs as JsonObject[])[0]!).links).toEqual(['10', '100::input:104'])
    expect(result.definition.links).toEqual(expect.arrayContaining([
      ['10', '1', 0, '100::2', 0, 'IMAGE'],
      ['100::input:104', '1', 0, '100::3', 0, 'IMAGE'],
    ]))
  })
})
