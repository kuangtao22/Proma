import { describe, expect, test } from 'bun:test'
import { createEmptyCanvasDocument } from '@proma/shared'
import type { CanvasDocument, CanvasImageTarget, SDKMessage } from '@proma/shared'
import {
  CANVAS_IMAGE_INPUT_MAX_MEDIA,
  CANVAS_IMAGE_INPUT_MAX_REFERENCES,
  CANVAS_IMAGE_INPUT_MAX_TEXT,
  createCanvasImageInputResolver,
} from './canvas-image-input-resolver'

/** 创建固定目标与包含四类直接入边的权威图。 */
function createDocument(): { document: CanvasDocument; target: CanvasImageTarget } {
  const target: CanvasImageTarget = {
    projectId: 'project-1', canvasId: 'canvas-1',
    nodeId: 'image-target', imageModuleId: 'module-target',
  }
  const document = createEmptyCanvasDocument(target.projectId, target.canvasId, 1)
  document.nodes = [
    { id: target.nodeId, kind: 'image', title: '目标', position: { x: 0, y: 0 }, imageModuleId: target.imageModuleId },
    { id: 'agent-1', kind: 'agent', title: 'Agent', position: { x: 0, y: 0 }, agentSessionId: 'session-1' },
    { id: 'image-1', kind: 'image', title: '参考图', position: { x: 0, y: 0 }, imageModuleId: 'module-reference', adoptedAssetId: 'asset-reference' },
    { id: 'document-1', kind: 'document', title: '文档', position: { x: 0, y: 0 }, documentId: 'document-content', contentRevision: 2 },
    { id: 'webview-1', kind: 'webview', title: '原型', position: { x: 0, y: 0 }, prototypeId: 'prototype-content', contentRevision: 3 },
    { id: 'document-indirect', kind: 'document', title: '间接文档', position: { x: 0, y: 0 }, documentId: 'document-indirect-content', contentRevision: 4 },
  ]
  /** 显式元组避免数组解构把节点 ID 推断为可选值。 */
  const edgePairs: Array<[string, string]> = [
    ['agent-1', target.nodeId], ['image-1', target.nodeId],
    ['document-1', target.nodeId], ['webview-1', target.nodeId],
    ['document-indirect', 'document-1'],
  ]
  document.edges = edgePairs.map(([sourceNodeId, targetNodeId], index) => ({
    id: `edge-${index}`, sourceNodeId, sourcePort: 'output', targetNodeId, targetPort: 'input',
  }))
  return { document, target }
}

/** 创建覆盖四类已提交事实的输入解析器。 */
function createResolver(document: CanvasDocument) {
  const messages: SDKMessage[] = [{
    type: 'assistant', parent_tool_use_id: null,
    message: { content: [{ type: 'text', text: '较早输出' }, { type: 'text', text: '最近明确输出：首页保持安静层级' }] },
  }]
  return createCanvasImageInputResolver({
    canvasStore: { requireStableAuthoritativeDocument: () => document },
    getAgentOutput: async () => ({ revision: 4, messages }),
    imageStore: {
      load: async (target) => ({
        schemaVersion: 2, kind: 'image', contentId: target.imageModuleId,
        revision: 5, createdAt: 1, updatedAt: 2, prompt: '', selectedModelProfileId: null,
        aspectRatio: '1:1', imageSize: 'auto', contextMode: 'auto', adoptedAssetId: 'asset-reference',
      }),
    },
    readDocument: async () => ({ revision: 2, markdown: '# 首页\n强调主要行动' }),
    readPrototype: async () => ({ revision: 3, summary: '已提交原型：首页顶部导航与内容流' }),
  })
}

describe('Canvas 图片直接输入解析器', () => {
  test('Given 四类直接入边和一条间接入边 When 解析 Then 只固化直接已提交事实', async () => {
    const { document, target } = createDocument()

    const references = await createResolver(document).resolve(target)

    expect(references.map((reference) => ({
      nodeId: reference.nodeId, kind: reference.kind, revision: reference.revision,
      assetId: reference.assetId,
    }))).toEqual([
      { nodeId: 'agent-1', kind: 'agent', revision: 4, assetId: undefined },
      { nodeId: 'image-1', kind: 'image', revision: 5, assetId: 'asset-reference' },
      { nodeId: 'document-1', kind: 'document', revision: 2, assetId: undefined },
      { nodeId: 'webview-1', kind: 'webview', revision: 3, assetId: undefined },
    ])
    expect(references.some((reference) => reference.nodeId === 'document-indirect')).toBe(false)
    expect(references[0]?.summary).toContain('最近明确输出')
    expect(references.every((reference) => /^[a-f0-9]{64}$/.test(reference.summaryHash))).toBe(true)
  })

  test('Given 直接入边和摘要超过预算 When 解析 Then 引用、文本和媒体均保持硬上限', async () => {
    const { document, target } = createDocument()
    document.nodes = [document.nodes[0]!, ...Array.from({ length: 20 }, (_, index) => ({
      id: `image-${index}`, kind: 'image' as const, title: `图片 ${index}`,
      position: { x: 0, y: 0 }, imageModuleId: `module-${index}`, adoptedAssetId: `asset-${index}`,
    }))]
    document.edges = document.nodes.slice(1).map((node, index) => ({
      id: `edge-${index}`, sourceNodeId: node.id, sourcePort: 'output',
      targetNodeId: target.nodeId, targetPort: 'input',
    }))
    const resolver = createCanvasImageInputResolver({
      canvasStore: { requireStableAuthoritativeDocument: () => document },
      getAgentOutput: async () => ({ revision: 0, messages: [] }),
      imageStore: {
        load: async (input) => ({
          schemaVersion: 2, kind: 'image', contentId: input.imageModuleId,
          revision: 1, createdAt: 1, updatedAt: 1, prompt: '', selectedModelProfileId: null,
          aspectRatio: '1:1', imageSize: 'auto', contextMode: 'none', adoptedAssetId: `asset-${input.imageModuleId}`,
        }),
      },
      readDocument: async () => ({ revision: 1, markdown: 'x'.repeat(CANVAS_IMAGE_INPUT_MAX_TEXT * 2) }),
      readPrototype: async () => ({ revision: 1, summary: 'x'.repeat(CANVAS_IMAGE_INPUT_MAX_TEXT * 2) }),
    })

    const references = await resolver.resolve(target)

    expect(references.length).toBeLessThanOrEqual(CANVAS_IMAGE_INPUT_MAX_REFERENCES)
    expect(references.reduce((total, reference) => total + reference.summary.length, 0))
      .toBeLessThanOrEqual(CANVAS_IMAGE_INPUT_MAX_TEXT)
    expect(references.filter((reference) => reference.assetId).length)
      .toBeLessThanOrEqual(CANVAS_IMAGE_INPUT_MAX_MEDIA)
  })
})
