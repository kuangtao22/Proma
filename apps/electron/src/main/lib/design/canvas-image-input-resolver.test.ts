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
    { id: 'webview-1', kind: 'webview', title: '原型', position: { x: 0, y: 0 }, prototypeId: 'prototype-content', contentRevision: 3, devicePreset: 'desktop' },
    { id: 'document-indirect', kind: 'document', title: '间接文档', position: { x: 0, y: 0 }, documentId: 'document-indirect-content', contentRevision: 4 },
  ]
  /** 显式元组避免数组解构把节点 ID 推断为可选值。 */
  const edgePairs: Array<[string, string]> = [
    ['agent-1', target.nodeId], ['image-1', target.nodeId],
    ['document-1', target.nodeId], ['webview-1', target.nodeId],
    ['document-indirect', 'document-1'],
  ]
  /** 每条边的端口由来源与目标节点类型决定，间接边只用于证明不递归。 */
  document.edges = edgePairs.map(([sourceNodeId, targetNodeId], index) => {
    /** 来源节点必然来自上方固定夹具。 */
    const sourceNode = document.nodes.find((node) => node.id === sourceNodeId)!
    /** 图片来源进入媒体槽，其余来源只提供文本上下文。 */
    const ports = sourceNode.kind === 'image'
      ? { sourcePort: 'image.asset', targetPort: 'image.reference' }
      : sourceNode.kind === 'agent'
        ? { sourcePort: 'agent.text', targetPort: 'context.text' }
        : sourceNode.kind === 'document'
          ? { sourcePort: 'document.markdown', targetPort: 'context.text' }
          : { sourcePort: 'webview.html', targetPort: 'context.text' }
    return {
      id: `edge-${index}`, sourceNodeId, ...ports, targetNodeId,
      relation: 'reference' as const,
    }
  })
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
    resolveAssetPath: (_projectId, assetId) => `/project/assets/${assetId}.png`,
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
      assetId: reference.assetId, sourcePort: reference.sourcePort, targetPort: reference.targetPort,
    }))).toEqual([
      { nodeId: 'agent-1', kind: 'agent', revision: 4, assetId: undefined, sourcePort: 'agent.text', targetPort: 'context.text' },
      { nodeId: 'image-1', kind: 'image', revision: 5, assetId: 'asset-reference', sourcePort: 'image.asset', targetPort: 'image.reference' },
      { nodeId: 'document-1', kind: 'document', revision: 2, assetId: undefined, sourcePort: 'document.markdown', targetPort: 'context.text' },
      { nodeId: 'webview-1', kind: 'webview', revision: 3, assetId: undefined, sourcePort: 'webview.html', targetPort: 'context.text' },
    ])
    expect(references.some((reference) => reference.nodeId === 'document-indirect')).toBe(false)
    expect(references[0]?.summary).toContain('最近明确输出')
    expect(references.every((reference) => /^[a-f0-9]{64}$/.test(reference.summaryHash))).toBe(true)
  })

  test('Given 纯关联直接入边 When 解析图片输入 Then 不读取上游事实', async () => {
    const { document, target } = createDocument()
    /** association 只表达业务关系，永远不形成执行输入。 */
    document.edges = [{
      id: 'edge-association', sourceNodeId: 'agent-1', sourcePort: 'unbound',
      targetNodeId: target.nodeId, targetPort: 'unbound', relation: 'association',
    }]
    /** 所有事实读取器在被误调用时立即暴露自动消费回归。 */
    const resolver = createCanvasImageInputResolver({
      canvasStore: { requireStableAuthoritativeDocument: () => document },
      getAgentOutput: async () => { throw new Error('不应读取 Agent') },
      imageStore: { load: async () => { throw new Error('不应读取图片') } },
      resolveAssetPath: () => { throw new Error('不应读取素材路径') },
      readDocument: async () => { throw new Error('不应读取文档') },
      readPrototype: async () => { throw new Error('不应读取原型') },
    })

    await expect(resolver.resolve(target)).resolves.toEqual([])
  })

  test('Given 直接入边和摘要超过预算 When 解析 Then 引用、文本和媒体均保持硬上限', async () => {
    const { document, target } = createDocument()
    document.nodes = [document.nodes[0]!, ...Array.from({ length: 24 }, (_, index) => ({
      id: `image-${index}`, kind: 'image' as const, title: `图片 ${index}`,
      position: { x: 0, y: 0 }, imageModuleId: `module-${index}`, adoptedAssetId: `asset-module-${index}`,
    })), {
      id: 'document-after-images', kind: 'document' as const, title: '候选上限外文档',
      position: { x: 0, y: 0 }, documentId: 'document-after-images', contentRevision: 1,
    }]
    const directEdges = document.nodes.slice(1).map((node, index) => ({
      id: `edge-${index}`, sourceNodeId: node.id, sourcePort: node.kind === 'image' ? 'image.asset' : 'document.markdown',
      targetNodeId: target.nodeId, targetPort: node.kind === 'image' ? 'image.reference' : 'context.text', relation: 'reference' as const,
    }))
    /** 大量重复边不得扩大候选或实际读取工作量。 */
    document.edges = [...directEdges, ...Array.from({ length: 80 }, (_, index) => ({
      id: `duplicate-${index}`, sourceNodeId: `image-${index % 24}`, sourcePort: 'image.asset',
      targetNodeId: target.nodeId, targetPort: 'image.reference', relation: 'reference' as const,
    }))]
    let imageLoadCount = 0
    let documentReadCount = 0
    let prototypeReadCount = 0
    const resolver = createCanvasImageInputResolver({
      canvasStore: { requireStableAuthoritativeDocument: () => document },
      getAgentOutput: async () => ({ revision: 0, messages: [] }),
      imageStore: {
        load: async (input) => {
          imageLoadCount += 1
          return {
            schemaVersion: 2, kind: 'image', contentId: input.imageModuleId,
            revision: 1, createdAt: 1, updatedAt: 1, prompt: '', selectedModelProfileId: null,
            aspectRatio: '1:1', imageSize: 'auto', contextMode: 'none', adoptedAssetId: `asset-${input.imageModuleId}`,
          }
        },
      },
      resolveAssetPath: (_projectId, assetId) => `/project/assets/${assetId}.png`,
      readDocument: async () => {
        documentReadCount += 1
        return { revision: 1, markdown: 'x'.repeat(CANVAS_IMAGE_INPUT_MAX_TEXT * 2) }
      },
      readPrototype: async () => {
        prototypeReadCount += 1
        return { revision: 1, summary: 'x'.repeat(CANVAS_IMAGE_INPUT_MAX_TEXT * 2) }
      },
    })

    const references = await resolver.resolve(target)

    expect(references.length).toBeLessThanOrEqual(CANVAS_IMAGE_INPUT_MAX_REFERENCES)
    expect(references.reduce((total, reference) => total + reference.summary.length, 0))
      .toBeLessThanOrEqual(CANVAS_IMAGE_INPUT_MAX_TEXT)
    expect(references.filter((reference) => reference.assetId).length)
      .toBeLessThanOrEqual(CANVAS_IMAGE_INPUT_MAX_MEDIA)
    expect(imageLoadCount).toBe(CANVAS_IMAGE_INPUT_MAX_MEDIA)
    expect(documentReadCount).toBe(0)
    expect(prototypeReadCount).toBe(0)
  })

  test('Given WebView 绑定 context.text When 解析 Then 只提供安全文本且没有媒体身份', async () => {
    const { document, target } = createDocument()
    document.edges = [{
      id: 'edge-web', sourceNodeId: 'webview-1', sourcePort: 'webview.html',
      targetNodeId: target.nodeId, targetPort: 'context.text', relation: 'reference',
    }]

    const references = await createResolver(document).resolve(target)

    expect(references).toEqual([expect.objectContaining({
      nodeId: 'webview-1', sourcePort: 'webview.html', targetPort: 'context.text',
    })])
    expect(references[0]).not.toHaveProperty('assetId')
  })

  test('Given WebView 被伪装为图片参考 When 解析 Then 在任何素材读取前拒绝', async () => {
    const { document, target } = createDocument()
    document.edges = [{
      id: 'edge-invalid', sourceNodeId: 'webview-1', sourcePort: 'webview.html',
      targetNodeId: target.nodeId, targetPort: 'image.reference', relation: 'reference',
    }]

    await expect(createResolver(document).resolve(target)).rejects
      .toThrow('CANVAS_IMAGE_INPUT_INVALID')
  })

  test('Given 图片参考没有正式采用素材 When 解析 Then 明确阻断缺少媒体', async () => {
    const { document, target } = createDocument()
    /** 节点和模块同时没有正式 adopted 素材，不能静默跳过引用意图。 */
    const source = document.nodes.find((node) => node.id === 'image-1')
    if (source?.kind === 'image') delete source.adoptedAssetId
    document.edges = [{
      id: 'edge-image', sourceNodeId: 'image-1', sourcePort: 'image.asset',
      targetNodeId: target.nodeId, targetPort: 'image.reference', relation: 'reference',
    }]
    /** 自定义 resolver 固定返回未采用图片配置。 */
    const resolver = createCanvasImageInputResolver({
      canvasStore: { requireStableAuthoritativeDocument: () => document },
      getAgentOutput: async () => ({ revision: 0, messages: [] }),
      imageStore: { load: async (input) => ({
        schemaVersion: 2, kind: 'image', contentId: input.imageModuleId,
        revision: 5, createdAt: 1, updatedAt: 2, prompt: '', selectedModelProfileId: null,
        aspectRatio: '1:1', imageSize: 'auto', contextMode: 'auto', adoptedAssetId: null,
      }) },
      resolveAssetPath: () => { throw new Error('缺少素材时不应解析路径') },
      readDocument: async () => ({ revision: 0, markdown: '' }),
      readPrototype: async () => ({ revision: 0, summary: '' }),
    })

    await expect(resolver.resolve(target)).rejects.toThrow('CANVAS_IMAGE_INPUT_MISSING')
  })

  test('Given 历史 reference 边尚未确认 When 解析 Then 不静默猜测用途', async () => {
    const { document, target } = createDocument()
    document.edges = [{
      id: 'edge-legacy', sourceNodeId: 'image-1', sourcePort: 'output',
      targetNodeId: target.nodeId, targetPort: 'input', relation: 'reference',
    }]

    await expect(createResolver(document).resolve(target)).rejects
      .toThrow('CANVAS_IMAGE_INPUT_CONFIRMATION_REQUIRED')
  })

  test('Given 合法图片参考 When 解析 Then 验证正式素材路径且快照不暴露路径', async () => {
    const { document, target } = createDocument()
    document.edges = [{
      id: 'edge-image', sourceNodeId: 'image-1', sourcePort: 'image.asset',
      targetNodeId: target.nodeId, targetPort: 'image.reference', relation: 'reference',
    }]
    /** 收集 Asset Service 校验调用，证明 adopted ID 对应真实媒体。 */
    const resolvedAssets: Array<{ projectId: string; assetId: string }> = []
    const resolver = createCanvasImageInputResolver({
      canvasStore: { requireStableAuthoritativeDocument: () => document },
      getAgentOutput: async () => ({ revision: 0, messages: [] }),
      imageStore: {
        load: async (input) => ({
          schemaVersion: 2, kind: 'image', contentId: input.imageModuleId,
          revision: 5, createdAt: 1, updatedAt: 2, prompt: '', selectedModelProfileId: null,
          aspectRatio: '1:1', imageSize: 'auto', contextMode: 'auto', adoptedAssetId: 'asset-reference',
        }),
      },
      resolveAssetPath: (projectId, assetId) => {
        resolvedAssets.push({ projectId, assetId })
        return `/project/assets/${assetId}.png`
      },
      readDocument: async () => ({ revision: 0, markdown: '' }),
      readPrototype: async () => ({ revision: 0, summary: '' }),
    })

    const references = await resolver.resolve(target)

    expect(resolvedAssets).toEqual([{ projectId: 'project-1', assetId: 'asset-reference' }])
    expect(references[0]).toMatchObject({ assetId: 'asset-reference' })
    expect(references[0]).not.toHaveProperty('path')
  })
})
