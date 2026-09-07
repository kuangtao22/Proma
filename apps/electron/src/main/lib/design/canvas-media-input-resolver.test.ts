import { createHash } from 'node:crypto'
import { describe, expect, test } from 'bun:test'
import { createCanvasBoundEdge, createEmptyCanvasDocument } from '@proma/shared'
import type {
  CanvasDocument,
  CanvasMediaInputBinding,
  CanvasMediaTarget,
  CanvasNode,
  MediaAssetRecord,
  MediaAssetRef,
} from '@proma/shared'
import type { CanvasMediaModuleState } from './canvas-media-service'
import {
  createCanvasMediaInputResolver,
  type CanvasMediaInputResolverDependencies,
} from './canvas-media-input-resolver'

const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)
const HASH_C = 'c'.repeat(64)

/** 对测试正式文本计算与生产相同的内容 hash。 */
function hashText(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

/** 创建不可变媒体引用。 */
function asset(assetId: string, mediaKind: MediaAssetRef['mediaKind'], hash: string): MediaAssetRef {
  return { assetId, revision: 1, hash, mediaKind }
}

/** 创建满足资产服务精确引用校验的公开记录。 */
function record(reference: MediaAssetRef): MediaAssetRecord {
  const base = {
    id: reference.assetId,
    revision: 1 as const,
    hash: reference.hash,
    filename: `${reference.assetId}.bin`,
    byteSize: 10,
    mediaType: `${reference.mediaKind}/test`,
    createdAt: 1,
  }
  if (reference.mediaKind === 'image') return { ...base, mediaKind: 'image', metadata: { width: 1, height: 1 } }
  if (reference.mediaKind === 'audio') {
    return { ...base, mediaKind: 'audio', metadata: { durationMs: 1, sampleRate: 44_100, channels: 2, codec: 'pcm' } }
  }
  return { ...base, mediaKind: 'video', metadata: { width: 1, height: 1, durationMs: 1, fps: 24, codec: 'h264', hasAudio: false } }
}

/** 创建带正式 Agent、文档、图片和音频上游的目标视频图。 */
function createGraph(): { document: CanvasDocument; target: CanvasMediaTarget; nodes: Record<string, CanvasNode> } {
  const target: CanvasMediaTarget = {
    projectId: 'project-1', canvasId: 'canvas-1', nodeId: 'video-target',
    mediaModuleId: 'video-module', mediaKind: 'video',
  }
  const agentText = '已确认的视频分镜'
  const nodes: Record<string, CanvasNode> = {
    target: { id: target.nodeId, kind: 'video', title: '目标视频', position: { x: 0, y: 0 }, mediaModuleId: target.mediaModuleId },
    agent: {
      id: 'agent-source', kind: 'agent', title: 'Agent', position: { x: 0, y: 0 }, agentSessionId: 'session-1',
      outputPointer: { messageUuid: 'message-1', contentSha256: hashText(agentText), completedAt: 10 },
    },
    document: {
      id: 'document-source', kind: 'document', title: '脚本', position: { x: 0, y: 0 },
      documentId: 'document-1', contentRevision: 3,
    },
    image: {
      id: 'image-source', kind: 'image', title: '首帧', position: { x: 0, y: 0 },
      imageModuleId: 'image-module', adoptedAssetId: 'image-1',
    },
    audio: {
      id: 'audio-source', kind: 'audio', title: '配乐', position: { x: 0, y: 0 }, mediaModuleId: 'audio-module',
    },
    video: {
      id: 'video-source', kind: 'video', title: '参考视频', position: { x: 0, y: 0 }, mediaModuleId: 'source-video-module',
    },
  }
  const document = createEmptyCanvasDocument(target.projectId, target.canvasId, 1)
  document.nodes = Object.values(nodes)
  document.edges = [nodes.agent, nodes.document, nodes.image, nodes.audio].map((source, index) => createCanvasBoundEdge(
    source!, nodes.target!, {
      id: `edge-${index}`, sourceNodeId: source!.id, targetNodeId: nodes.target!.id, relation: 'reference',
    },
  ))
  /** 视频节点 poster 输出按实际图片类型建立显式媒体端口。 */
  document.edges.push(createCanvasBoundEdge(
    { id: nodes.video!.id, kind: 'image' }, nodes.target!, {
      id: 'edge-poster', sourceNodeId: nodes.video!.id, targetNodeId: nodes.target!.id, relation: 'reference',
    },
  ))
  return { document, target, nodes }
}

/** 创建媒体模块持久化状态。 */
function createState(inputs: CanvasMediaInputBinding[]): CanvasMediaModuleState {
  return {
    schemaVersion: 1,
    /** 运行历史 revision 可高于配置 revision。 */
    revision: 8,
    config: {
      schemaVersion: 1, contentId: 'video-module', mediaKind: 'video', revision: 5,
      createdAt: 1, updatedAt: 2, profile: null, inputs, outputs: [], adoptedOutputs: [],
    },
    operations: [],
    candidates: [],
    pendingAdoptionProjection: null,
  }
}

/** 创建可按用例覆盖的完整 resolver 依赖。 */
function createDependencies(
  document: CanvasDocument,
  state: CanvasMediaModuleState,
  overrides: Partial<CanvasMediaInputResolverDependencies> = {},
): CanvasMediaInputResolverDependencies {
  const image = asset('image-1', 'image', HASH_A)
  const audio = asset('audio-1', 'audio', HASH_B)
  return {
    canvasStore: { requireStableAuthoritativeDocument: () => document },
    mediaStore: { load: async () => state },
    imageStore: {
      load: async () => ({
        schemaVersion: 2, kind: 'image', contentId: 'image-module', revision: 2,
        createdAt: 1, updatedAt: 2, prompt: '', selectedModelProfileId: null,
        aspectRatio: '1:1', imageSize: 'auto', contextMode: 'none', adoptedAssetId: image.assetId,
      }),
    },
    getAgentText: async (_sessionId, pointer) => ({
      messageUuid: pointer.messageUuid,
      contentSha256: pointer.contentSha256,
      text: '已确认的视频分镜',
    }),
    readDocument: async () => ({ revision: 3, markdown: '# 正式脚本' }),
    getImageAsset: async () => image,
    getAdoptedOutput: async (_target, outputKey) => {
      if (outputKey === 'music.main') return { asset: audio, candidateId: 'candidate-1', runId: 'run-1', configRevision: 4 }
      if (outputKey === 'poster') return { asset: image, candidateId: 'candidate-2', runId: 'run-2', configRevision: 3 }
      return null
    },
    getAssetRecord: (_projectId, reference) => record(reference),
    ...overrides,
  }
}

describe('Canvas 类型化媒体输入解析器', () => {
  test('Given literal 与四类正式 canvas-output When 解析 Then 返回逐槽来源、hash 和隔离值', async () => {
    const { document, target } = createGraph()
    const literalImage = asset('literal-image', 'image', HASH_C)
    const inputs: CanvasMediaInputBinding[] = [
      { key: 'prompt', kind: 'text', source: { type: 'literal', value: '电影感' } },
      { key: 'steps', kind: 'number', source: { type: 'literal', value: 24 } },
      { key: 'agentPrompt', kind: 'text', source: { type: 'canvas-output', nodeId: 'agent-source', outputKey: 'agent.text' } },
      { key: 'script', kind: 'text', source: { type: 'canvas-output', nodeId: 'document-source', outputKey: 'document.markdown' } },
      { key: 'firstFrame', kind: 'image', source: { type: 'canvas-output', nodeId: 'image-source', outputKey: 'image.asset' } },
      { key: 'music', kind: 'audio', source: { type: 'canvas-output', nodeId: 'audio-source', outputKey: 'music.main' } },
      { key: 'poster', kind: 'image', source: { type: 'canvas-output', nodeId: 'video-source', outputKey: 'poster' } },
      { key: 'mask', kind: 'image', source: { type: 'literal', value: literalImage } },
    ]
    const resolver = createCanvasMediaInputResolver(createDependencies(document, createState(inputs)))

    const result = await resolver.resolveNodeInputs(target)

    expect(result.configRevision).toBe(5)
    expect(result.ready).toBe(true)
    expect(result.bindings.map((binding) => ({
      key: binding.targetInputKey,
      kind: binding.requiredKind,
      node: binding.sourceNodeId,
      output: binding.sourceOutputKey,
      hash: binding.sourceArtifactHash,
      error: binding.errorCode,
    }))).toEqual([
      { key: 'prompt', kind: 'text', node: null, output: null, hash: null, error: null },
      { key: 'steps', kind: 'number', node: null, output: null, hash: null, error: null },
      { key: 'agentPrompt', kind: 'text', node: 'agent-source', output: 'agent.text', hash: hashText('已确认的视频分镜'), error: null },
      { key: 'script', kind: 'text', node: 'document-source', output: 'document.markdown', hash: hashText('# 正式脚本'), error: null },
      { key: 'firstFrame', kind: 'image', node: 'image-source', output: 'image.asset', hash: HASH_A, error: null },
      { key: 'music', kind: 'audio', node: 'audio-source', output: 'music.main', hash: HASH_B, error: null },
      { key: 'poster', kind: 'image', node: 'video-source', output: 'poster', hash: HASH_A, error: null },
      { key: 'mask', kind: 'image', node: null, output: null, hash: null, error: null },
    ])
    expect(result.bindings[2]?.resolvedValue).toEqual({ kind: 'scalar', value: '已确认的视频分镜' })
    expect(result.bindings[5]?.resolvedValue).toEqual({ kind: 'asset', asset: asset('audio-1', 'audio', HASH_B) })
  })

  test('Given canvas-output 没有当前 bound edge 或端口被改写 When 解析 Then 逐槽返回稳定错误', async () => {
    const { document, target } = createGraph()
    document.edges = document.edges.filter((edge) => edge.sourceNodeId !== 'agent-source')
    const imageEdge = document.edges.find((edge) => edge.sourceNodeId === 'image-source')!
    imageEdge.targetPort = 'context.text'
    const state = createState([
      { key: 'agent', kind: 'text', source: { type: 'canvas-output', nodeId: 'agent-source', outputKey: 'agent.text' } },
      { key: 'image', kind: 'image', source: { type: 'canvas-output', nodeId: 'image-source', outputKey: 'image.asset' } },
    ])

    const result = await createCanvasMediaInputResolver(createDependencies(document, state)).resolveNodeInputs(target)

    expect(result.ready).toBe(false)
    expect(result.bindings.map((binding) => binding.errorCode)).toEqual([
      'CANVAS_MEDIA_SOURCE_EDGE_MISSING',
      'CANVAS_MEDIA_SOURCE_EDGE_INVALID',
    ])
    expect(result.bindings.every((binding) => binding.resolvedValue === null)).toBe(true)
  })

  test('Given Agent 没有正式指针、文档 revision 过期且 AV key 未采用 When 解析 Then 不猜展示上下文', async () => {
    const { document, target, nodes } = createGraph()
    delete (nodes.agent as Extract<CanvasNode, { kind: 'agent' }>).outputPointer
    const state = createState([
      { key: 'agent', kind: 'text', source: { type: 'canvas-output', nodeId: 'agent-source', outputKey: 'agent.text' } },
      { key: 'document', kind: 'text', source: { type: 'canvas-output', nodeId: 'document-source', outputKey: 'document.markdown' } },
      { key: 'music', kind: 'audio', source: { type: 'canvas-output', nodeId: 'audio-source', outputKey: 'old.output' } },
    ])
    let agentRead = false
    const dependencies = createDependencies(document, state, {
      getAgentText: async () => { agentRead = true; throw new Error('不应读取') },
      readDocument: async () => ({ revision: 2, markdown: '旧正文' }),
    })

    const result = await createCanvasMediaInputResolver(dependencies).resolveNodeInputs(target)

    expect(result.bindings.map((binding) => binding.errorCode)).toEqual([
      'CANVAS_MEDIA_AGENT_OUTPUT_MISSING',
      'CANVAS_MEDIA_DOCUMENT_OUTPUT_STALE',
      'CANVAS_MEDIA_SOURCE_NOT_ADOPTED',
    ])
    expect(agentRead).toBe(false)
  })

  test('Given literal 资产类型或项目授权不匹配 When 解析 Then 返回资产错误且不运行', async () => {
    const { document, target } = createGraph()
    const state = createState([
      { key: 'music', kind: 'audio', source: { type: 'literal', value: asset('audio-forged', 'audio', HASH_B) } },
    ])
    const dependencies = createDependencies(document, state, {
      getAssetRecord: () => { throw new Error('MEDIA_ASSET_NOT_AUTHORIZED') },
    })

    const result = await createCanvasMediaInputResolver(dependencies).resolveNodeInputs(target)

    expect(result).toMatchObject({
      configRevision: 5,
      ready: false,
      bindings: [{
        targetInputKey: 'music', requiredKind: 'audio', sourceNodeId: null,
        sourceOutputKey: null, sourceArtifactHash: null, resolvedValue: null,
        errorCode: 'CANVAS_MEDIA_LITERAL_ASSET_INVALID',
      }],
    })
  })

  test('Given 正式产物读取期间 bound edge 被解除 When 返回 Then fresh 图复验拒绝旧来源', async () => {
    const { document, target } = createGraph()
    const state = createState([
      { key: 'agent', kind: 'text', source: { type: 'canvas-output', nodeId: 'agent-source', outputKey: 'agent.text' } },
    ])
    const dependencies = createDependencies(document, state, {
      getAgentText: async (_target, pointer) => {
        document.edges = []
        return {
          messageUuid: pointer.messageUuid,
          contentSha256: pointer.contentSha256,
          text: '已确认的视频分镜',
        }
      },
    })

    const result = await createCanvasMediaInputResolver(dependencies).resolveNodeInputs(target)

    expect(result).toMatchObject({
      ready: false,
      bindings: [{
        sourceNodeId: 'agent-source', sourceOutputKey: 'agent.text',
        sourceArtifactHash: null, resolvedValue: null,
        errorCode: 'CANVAS_MEDIA_SOURCE_EDGE_MISSING',
      }],
    })
  })

  test('Given 槽位解析期间模块配置发生变化 When 完成 Then 拒绝混用旧输入', async () => {
    const { document, target } = createGraph()
    const initial = createState([
      { key: 'prompt', kind: 'text', source: { type: 'literal', value: '旧提示' } },
    ])
    const changed = createState([
      { key: 'prompt', kind: 'text', source: { type: 'literal', value: '新提示' } },
    ])
    changed.config.revision = 6
    let loadCount = 0
    const dependencies = createDependencies(document, initial, {
      mediaStore: { load: async () => (++loadCount === 1 ? initial : changed) },
    })

    await expect(createCanvasMediaInputResolver(dependencies).resolveNodeInputs(target))
      .rejects.toThrow('CANVAS_MEDIA_CONFIG_CHANGED')
  })
})
