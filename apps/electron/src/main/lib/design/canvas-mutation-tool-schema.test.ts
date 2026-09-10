import { describe, expect, test } from 'bun:test'
import { validateToolArguments } from '@earendil-works/pi-ai'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import { Value } from 'typebox/value'
import {
  CANVAS_AGENT_MUTATION_SCHEMA,
  CANVAS_UPSERT_EDGES_EXAMPLE,
} from './canvas-mutation-tool-schema'

/** 用生产 mutation schema 构造最小工具，验证 Pi 实际返回给模型的字段诊断。 */
const mutationTool = {
  name: 'canvas_apply_changes',
  label: '应用画布修改',
  description: `正确加边示例：${CANVAS_UPSERT_EDGES_EXAMPLE}`,
  parameters: CANVAS_AGENT_MUTATION_SCHEMA,
  execute: async () => ({ content: [], details: {} }),
} satisfies ToolDefinition

describe('Canvas Agent mutation 工具 schema', () => {
  test('Given 图片与视频节点 When 批量建立真实依赖边 Then 公开合同接受确切结构', () => {
    const input = {
      canvasId: 'canvas-1',
      baseRevision: 119,
      operations: [{
        type: 'upsert-edges',
        edges: [
          {
            id: 'edge-image-start-video-1',
            sourceNodeId: 'image-start-1',
            sourcePort: 'image.asset',
            targetNodeId: 'video-1',
            targetPort: 'context.image',
            relation: 'depends-on',
          },
          {
            id: 'edge-image-end-video-1',
            sourceNodeId: 'image-end-1',
            sourcePort: 'image.asset',
            targetNodeId: 'video-1',
            targetPort: 'context.image',
            relation: 'depends-on',
          },
        ],
      }],
    }

    expect(Value.Check(mutationTool.parameters, input)).toBeTrue()
    expect(validateToolArguments(mutationTool, {
      type: 'toolCall', id: 'valid-edges', name: mutationTool.name, arguments: input,
    })).toEqual(input)
  })

  test('Given 五种猜测式加边格式 When Pi 校验参数 Then 指向 operations[0] 且提示正确结构', () => {
    const invalidOperations = [
      { type: 'add-edge', edge: {} },
      { type: 'addEdge', edge: {} },
      { op: 'add-edge', edge: {} },
      { type: 'upsert-edge', edge: {} },
      { op: 'addEdge', edge: {} },
    ]

    for (const operation of invalidOperations) {
      expect(Value.Check(mutationTool.parameters, {
        canvasId: 'canvas-1', baseRevision: 119, operations: [operation],
      })).toBeFalse()
      expect(() => validateToolArguments(mutationTool, {
        type: 'toolCall', id: 'invalid-edge', name: mutationTool.name,
        arguments: { canvasId: 'canvas-1', baseRevision: 119, operations: [operation] },
      })).toThrow('type' in operation ? /operations\.0\.edges/ : /operations\.0\.type/)
    }
    expect(mutationTool.description).toContain('"type":"upsert-edges"')
    expect(mutationTool.description).toContain('"edges"')
  })

  test('Given 未知字段或用户管理 mutation When 校验参数 Then 在执行前拒绝越权结构', () => {
    const invalidOperations = [
      { type: 'upsert-edges', edges: [], serverUrl: 'https://example.invalid' },
      { type: 'set-media-model-scope', scope: { mode: 'all-enabled' } },
      { type: 'set-comfyui-connection', connectionId: 'other-server' },
      { type: 'upsert-nodes', nodes: [{
        id: 'agent-1', kind: 'agent', title: '策划', position: { x: 0, y: 0 },
        agentSessionId: 'session-1', outputPointer: {
          messageUuid: '33333333-3333-4333-8333-333333333333',
          contentSha256: 'a'.repeat(64), completedAt: 1,
        },
      }] },
      { type: 'upsert-nodes', nodes: [{
        id: 'video-1', kind: 'video', title: '镜头', position: { x: 0, y: 0 },
        mediaModuleId: 'media-1', adoptedConfigRevision: 2,
      }] },
    ]

    for (const operation of invalidOperations) {
      expect(Value.Check(mutationTool.parameters, {
        canvasId: 'canvas-1', baseRevision: 119, operations: [operation],
      })).toBeFalse()
    }
  })

  test('Given Store 支持的空操作、大批量与长实体 ID When 校验参数 Then 工具合同不缩窄兼容范围', () => {
    /** Store 对内部空数组保持 no-op，并已有千节点单批写入能力。 */
    const emptyOperations = [
      { type: 'move-nodes', positions: [] },
      { type: 'upsert-nodes', nodes: [] },
      { type: 'remove-nodes', nodeIds: [] },
      { type: 'upsert-edges', edges: [] },
      { type: 'remove-edges', edgeIds: [] },
    ]
    for (const operation of emptyOperations) {
      expect(Value.Check(mutationTool.parameters, {
        canvasId: 'canvas-1', baseRevision: 119, operations: [operation],
      })).toBeTrue()
    }

    /** 实体 ID 沿用 Store 的稳定字符集；canvasId 仍保留路径长度边界。 */
    const longId = `node-${'a'.repeat(256)}`
    const nodes = Array.from({ length: 1_000 }, (_, index) => ({
      id: index === 0 ? longId : `node-${index}`,
      kind: 'agent' as const,
      title: `Agent ${index}`,
      position: { x: index, y: index },
      agentSessionId: `session-${index}`,
    }))
    expect(Value.Check(mutationTool.parameters, {
      canvasId: 'canvas-1', baseRevision: 119,
      operations: [{ type: 'upsert-nodes', nodes }],
    })).toBeTrue()
    expect(Value.Check(mutationTool.parameters, {
      canvasId: `canvas-${'a'.repeat(128)}`, baseRevision: 119, operations: emptyOperations.slice(0, 1),
    })).toBeFalse()
  })

  test('Given 端口、标题或整数超出 Store 合同 When 校验参数 Then 写入前拒绝', () => {
    const edge = {
      id: 'edge-1', sourceNodeId: 'source-1', sourcePort: 'image.asset',
      targetNodeId: 'target-1', targetPort: 'context.image', relation: 'depends-on',
    }
    const invalidOperations = [
      { type: 'upsert-edges', edges: [{ ...edge, sourcePort: 'bad.port' }] },
      { type: 'upsert-edges', edges: [{ ...edge, targetPort: 'foo:bar' }] },
      { type: 'upsert-nodes', nodes: [{
        id: 'agent-1', kind: 'agent', title: '   ', position: { x: 0, y: 0 }, agentSessionId: 'session-1',
      }] },
      { type: 'upsert-nodes', nodes: [{
        id: 'doc-1', kind: 'document', title: '文档', position: { x: 0, y: 0 },
        documentId: 'content-1', contentRevision: Number.MAX_SAFE_INTEGER + 1,
      }] },
      { type: 'upsert-nodes', nodes: [{
        id: 'agent-2', kind: 'agent', title: 'Agent', position: { x: 0, y: 0 }, agentSessionId: 'session-2',
        upstreamChange: { sourceNodeIds: ['source-1'], changedAt: Number.MAX_SAFE_INTEGER + 1 },
      }] },
    ]
    for (const operation of invalidOperations) {
      expect(Value.Check(mutationTool.parameters, {
        canvasId: 'canvas-1', baseRevision: 119, operations: [operation],
      })).toBeFalse()
    }
    expect(Value.Check(mutationTool.parameters, {
      canvasId: 'canvas-1', baseRevision: Number.MAX_SAFE_INTEGER + 1,
      operations: [{ type: 'upsert-edges', edges: [] }],
    })).toBeFalse()
    expect(JSON.stringify(mutationTool.parameters)).toContain('必须按稳定 ID 升序排列')
  })
})
