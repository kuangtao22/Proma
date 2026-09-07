import { createHash } from 'node:crypto'
import { resolveCanvasEdgeBinding } from '@proma/shared'
import type {
  CanvasAgentOutputPointer,
  CanvasDocument,
  CanvasMediaInputBinding,
  CanvasMediaTarget,
  CanvasNode,
  MediaAssetRecord,
  MediaAssetRef,
  MediaInputValue,
} from '@proma/shared'
import type { CanvasDocumentStore } from './canvas-document-store'
import type { CanvasImageModuleStore } from './canvas-image-module-store'
import type {
  CanvasMediaModuleStore,
  CanvasMediaResolvedInput,
  CanvasMediaResolvedInputs,
} from './canvas-media-service'

/** Agent 正式文本必须与图节点 outputPointer 精确对应。 */
export interface CanvasMediaAgentTextOutput {
  messageUuid: string
  contentSha256: string
  text: string
}

/** 已提交 Markdown 的权威快照。 */
export interface CanvasMediaDocumentOutput {
  revision: number
  markdown: string
}

/** 音视频模块按输出 key 查询到的当前正式采用结果。 */
export interface CanvasMediaAdoptedOutput {
  asset: MediaAssetRef
  candidateId: string
  runId: string
  configRevision: number
}

/** Resolver 在一次读取中返回配置 revision 与逐槽解析事实。 */
export interface CanvasMediaNodeInputResolution extends CanvasMediaResolvedInputs {
  configRevision: number
}

/** Canvas 音视频节点类型化输入解析器。 */
export interface CanvasMediaInputResolver {
  resolveNodeInputs(target: CanvasMediaTarget): Promise<CanvasMediaNodeInputResolution>
}

/** Resolver 只读取权威 Canvas、模块配置和正式产物。 */
export interface CanvasMediaInputResolverDependencies {
  canvasStore: Pick<CanvasDocumentStore, 'requireStableAuthoritativeDocument'>
  mediaStore: Pick<CanvasMediaModuleStore, 'load'>
  imageStore: Pick<CanvasImageModuleStore, 'load'>
  getAgentText(
    sessionId: string,
    pointer: CanvasAgentOutputPointer,
  ): Promise<CanvasMediaAgentTextOutput>
  readDocument(
    target: Pick<CanvasMediaTarget, 'projectId' | 'canvasId'>,
    documentId: string,
  ): Promise<CanvasMediaDocumentOutput>
  getImageAsset(projectId: string, assetId: string): MediaAssetRef | Promise<MediaAssetRef>
  getAdoptedOutput(
    target: CanvasMediaTarget,
    outputKey: string,
  ): Promise<CanvasMediaAdoptedOutput | null>
  getAssetRecord(projectId: string, asset: MediaAssetRef): MediaAssetRecord
}

/** 收窄由 Canvas 正式输出提供的输入绑定。 */
function isCanvasOutputBinding(
  input: CanvasMediaInputBinding,
): input is Extract<CanvasMediaInputBinding, { source: { type: 'canvas-output' } }> {
  return input.source.type === 'canvas-output'
}

/** 对文本正式产物计算稳定内容 hash。 */
function hashText(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

/** 比较不可变媒体引用的全部业务身份字段。 */
function isSameAsset(left: MediaAssetRef, right: MediaAssetRef): boolean {
  return left.assetId === right.assetId
    && left.revision === right.revision
    && left.hash === right.hash
    && left.mediaKind === right.mediaKind
}

/** 创建一个保留槽位与来源字段的失败结果。 */
function failedBinding(
  input: CanvasMediaInputBinding,
  errorCode: string,
): CanvasMediaResolvedInput {
  return {
    targetInputKey: input.key,
    requiredKind: input.kind,
    sourceNodeId: input.source.type === 'canvas-output' ? input.source.nodeId : null,
    sourceOutputKey: input.source.type === 'canvas-output' ? input.source.outputKey : null,
    sourceArtifactHash: null,
    resolvedValue: null,
    errorCode,
  }
}

/** 验证不可变资产引用仍属于当前项目且类型与槽位一致。 */
function validateAsset(
  dependencies: CanvasMediaInputResolverDependencies,
  projectId: string,
  asset: MediaAssetRef,
  expectedKind: CanvasMediaInputBinding['kind'],
): MediaAssetRef {
  if (expectedKind === 'text' || expectedKind === 'number' || expectedKind === 'boolean'
    || asset.mediaKind !== expectedKind) throw new Error('CANVAS_MEDIA_SOURCE_KIND_MISMATCH')
  const record = dependencies.getAssetRecord(projectId, asset)
  if (record.id !== asset.assetId || record.revision !== asset.revision
    || record.hash !== asset.hash || record.mediaKind !== asset.mediaKind) {
    throw new Error('CANVAS_MEDIA_ASSET_INVALID')
  }
  return structuredClone(asset)
}

/** 返回来源类型对应的唯一公开边端口。 */
function expectedSourcePort(kind: CanvasNode['kind']): string {
  switch (kind) {
    case 'agent': return 'agent.text'
    case 'image': return 'image.asset'
    case 'audio': return 'audio.asset'
    case 'video': return 'video.asset'
    case 'document': return 'document.markdown'
    case 'webview': return 'webview.html'
  }
}

/** 验证 source binding 在当前图中仍由显式类型化直接边支撑。 */
function validateBoundEdge(
  document: CanvasDocument,
  source: CanvasNode,
  target: CanvasNode,
  requiredKind: CanvasMediaInputBinding['kind'],
  outputMediaKind?: MediaAssetRef['mediaKind'],
): string | null {
  const directEdges = document.edges.filter((edge) => (
    edge.sourceNodeId === source.id
    && edge.targetNodeId === target.id
    && edge.relation !== 'association'
  ))
  if (directEdges.length === 0) return 'CANVAS_MEDIA_SOURCE_EDGE_MISSING'
  /** AV 节点的 poster/audio 等多角色输出以 adopted asset 实际类型决定端口。 */
  const sourceKind = outputMediaKind ?? source.kind
  for (const edge of directEdges) {
    const binding = resolveCanvasEdgeBinding(edge, sourceKind, target.kind)
    if (binding.state !== 'bound' || binding.sourceCapability !== expectedSourcePort(sourceKind)) continue
    if (requiredKind === 'text' && binding.targetSlot === 'context.text') return null
    if (requiredKind === 'image' && binding.targetSlot === 'context.image') return null
    if (requiredKind === 'audio'
      && (binding.targetSlot === 'audio.reference' || binding.targetSlot === 'context.audio')) return null
    if (requiredKind === 'video'
      && (binding.targetSlot === 'video.reference' || binding.targetSlot === 'context.video')) return null
  }
  return 'CANVAS_MEDIA_SOURCE_EDGE_INVALID'
}

/** 判断异步读取后来源节点仍是同一业务身份。 */
function isSameSourceIdentity(before: CanvasNode, after: CanvasNode): boolean {
  if (before.kind !== after.kind || before.id !== after.id) return false
  switch (before.kind) {
    case 'agent': return after.kind === 'agent' && before.agentSessionId === after.agentSessionId
      && JSON.stringify(before.outputPointer ?? null) === JSON.stringify(after.outputPointer ?? null)
    case 'image': return after.kind === 'image' && before.imageModuleId === after.imageModuleId
      && before.adoptedAssetId === after.adoptedAssetId
    case 'audio':
    case 'video': return after.kind === before.kind && before.mediaModuleId === after.mediaModuleId
    case 'document': return after.kind === 'document' && before.documentId === after.documentId
      && before.contentRevision === after.contentRevision
    case 'webview': return after.kind === 'webview' && before.prototypeId === after.prototypeId
      && before.contentRevision === after.contentRevision
  }
}

/** 异步读取完成后重新证明目标、来源和显式绑定仍是当前事实。 */
function validateFreshBinding(
  dependencies: CanvasMediaInputResolverDependencies,
  target: CanvasMediaTarget,
  source: CanvasNode,
  requiredKind: CanvasMediaInputBinding['kind'],
  outputMediaKind?: MediaAssetRef['mediaKind'],
): string | null {
  const document = dependencies.canvasStore.requireStableAuthoritativeDocument(target)
  const targetNode = document.nodes.find((node) => node.id === target.nodeId)
  const sourceNode = document.nodes.find((node) => node.id === source.id)
  if (!targetNode || targetNode.kind !== target.mediaKind || targetNode.mediaModuleId !== target.mediaModuleId) {
    return 'CANVAS_MEDIA_TARGET_INVALID'
  }
  if (!sourceNode || !isSameSourceIdentity(source, sourceNode)) return 'CANVAS_MEDIA_SOURCE_CHANGED'
  return validateBoundEdge(document, sourceNode, targetNode, requiredKind, outputMediaKind)
}

/** 将 literal 输入验证并转换为运行时 MediaInputValue。 */
function resolveLiteral(
  dependencies: CanvasMediaInputResolverDependencies,
  projectId: string,
  input: CanvasMediaInputBinding,
): CanvasMediaResolvedInput {
  if (input.source.type !== 'literal') return failedBinding(input, 'CANVAS_MEDIA_INPUT_INVALID')
  try {
    const resolvedValue: MediaInputValue = input.kind === 'text'
      || input.kind === 'number'
      || input.kind === 'boolean'
      ? { kind: 'scalar', value: input.source.value }
      : { kind: 'asset', asset: validateAsset(dependencies, projectId, input.source.value, input.kind) }
    return {
      targetInputKey: input.key,
      requiredKind: input.kind,
      sourceNodeId: null,
      sourceOutputKey: null,
      sourceArtifactHash: null,
      resolvedValue,
      errorCode: null,
    }
  } catch {
    return failedBinding(input, 'CANVAS_MEDIA_LITERAL_ASSET_INVALID')
  }
}

/** 解析 Agent、文档、图片和音视频节点的正式输出。 */
async function resolveCanvasOutput(
  dependencies: CanvasMediaInputResolverDependencies,
  target: CanvasMediaTarget,
  document: CanvasDocument,
  targetNode: CanvasNode,
  nodesById: ReadonlyMap<string, CanvasNode>,
  input: Extract<CanvasMediaInputBinding, { source: { type: 'canvas-output' } }>,
): Promise<CanvasMediaResolvedInput> {
  const source = nodesById.get(input.source.nodeId)
  if (!source) return failedBinding(input, 'CANVAS_MEDIA_SOURCE_NODE_MISSING')
  const isAvSource = source.kind === 'audio' || source.kind === 'video'
  if (!isAvSource) {
    const edgeError = validateBoundEdge(document, source, targetNode, input.kind)
    if (edgeError) return failedBinding(input, edgeError)
  }
  const expectedOutputKey = expectedSourcePort(source.kind)
  if (source.kind !== 'audio' && source.kind !== 'video' && input.source.outputKey !== expectedOutputKey) {
    return failedBinding(input, 'CANVAS_MEDIA_SOURCE_OUTPUT_KEY_INVALID')
  }
  if ((input.kind === 'text') !== (source.kind === 'agent' || source.kind === 'document')) {
    return failedBinding(input, 'CANVAS_MEDIA_SOURCE_KIND_MISMATCH')
  }
  try {
    let resolvedValue: MediaInputValue
    let sourceArtifactHash: string
    let outputMediaKind: MediaAssetRef['mediaKind'] | undefined
    let adoptedSnapshot: CanvasMediaAdoptedOutput | undefined
    let adoptedTarget: CanvasMediaTarget | undefined
    if (source.kind === 'agent') {
      if (!source.outputPointer) return failedBinding(input, 'CANVAS_MEDIA_AGENT_OUTPUT_MISSING')
      const output = await dependencies.getAgentText(source.agentSessionId, source.outputPointer)
      if (output.messageUuid !== source.outputPointer.messageUuid
        || output.contentSha256 !== source.outputPointer.contentSha256
        || hashText(output.text) !== source.outputPointer.contentSha256) {
        return failedBinding(input, 'CANVAS_MEDIA_AGENT_OUTPUT_STALE')
      }
      resolvedValue = { kind: 'scalar', value: output.text }
      sourceArtifactHash = output.contentSha256
    } else if (source.kind === 'document') {
      const output = await dependencies.readDocument(target, source.documentId)
      if (output.revision !== source.contentRevision) {
        return failedBinding(input, 'CANVAS_MEDIA_DOCUMENT_OUTPUT_STALE')
      }
      resolvedValue = { kind: 'scalar', value: output.markdown }
      sourceArtifactHash = hashText(output.markdown)
    } else if (source.kind === 'image') {
      const config = await dependencies.imageStore.load({
        projectId: target.projectId,
        canvasId: target.canvasId,
        nodeId: source.id,
        imageModuleId: source.imageModuleId,
      })
      if (!config.adoptedAssetId
        || (source.adoptedAssetId !== undefined && source.adoptedAssetId !== config.adoptedAssetId)) {
        return failedBinding(input, 'CANVAS_MEDIA_IMAGE_OUTPUT_NOT_ADOPTED')
      }
      const asset = validateAsset(
        dependencies,
        target.projectId,
        await dependencies.getImageAsset(target.projectId, config.adoptedAssetId),
        input.kind,
      )
      resolvedValue = { kind: 'asset', asset }
      sourceArtifactHash = asset.hash
    } else if (source.kind === 'audio' || source.kind === 'video') {
      adoptedTarget = {
        projectId: target.projectId,
        canvasId: target.canvasId,
        nodeId: source.id,
        mediaModuleId: source.mediaModuleId,
        mediaKind: source.kind,
      }
      const adopted = await dependencies.getAdoptedOutput(adoptedTarget, input.source.outputKey)
      if (!adopted) return failedBinding(input, 'CANVAS_MEDIA_SOURCE_NOT_ADOPTED')
      const asset = validateAsset(dependencies, target.projectId, adopted.asset, input.kind)
      const edgeError = validateBoundEdge(document, source, targetNode, input.kind, asset.mediaKind)
      if (edgeError) return failedBinding(input, edgeError)
      resolvedValue = { kind: 'asset', asset }
      sourceArtifactHash = asset.hash
      outputMediaKind = asset.mediaKind
      adoptedSnapshot = adopted
    } else {
      return failedBinding(input, 'CANVAS_MEDIA_SOURCE_KIND_UNSUPPORTED')
    }
    if (adoptedSnapshot && adoptedTarget) {
      /** AV 采用状态独立于图 revision，异步读取后必须按 run/key/asset 精确复验。 */
      const refreshedAdopted = await dependencies.getAdoptedOutput(adoptedTarget, input.source.outputKey)
      if (!refreshedAdopted
        || refreshedAdopted.candidateId !== adoptedSnapshot.candidateId
        || refreshedAdopted.runId !== adoptedSnapshot.runId
        || refreshedAdopted.configRevision !== adoptedSnapshot.configRevision
        || !isSameAsset(refreshedAdopted.asset, adoptedSnapshot.asset)) {
        return failedBinding(input, 'CANVAS_MEDIA_SOURCE_CHANGED')
      }
    }
    const freshBindingError = validateFreshBinding(dependencies, target, source, input.kind, outputMediaKind)
    if (freshBindingError) return failedBinding(input, freshBindingError)
    return {
      targetInputKey: input.key,
      requiredKind: input.kind,
      sourceNodeId: source.id,
      sourceOutputKey: input.source.outputKey,
      sourceArtifactHash,
      resolvedValue,
      errorCode: null,
    }
  } catch {
    const errorCode = source.kind === 'agent'
      ? 'CANVAS_MEDIA_AGENT_OUTPUT_INVALID'
      : source.kind === 'document'
        ? 'CANVAS_MEDIA_DOCUMENT_OUTPUT_INVALID'
        : 'CANVAS_MEDIA_SOURCE_ASSET_INVALID'
    return failedBinding(input, errorCode)
  }
}

/** 创建只读取正式产物与当前 bound edge 的类型化媒体输入解析器。 */
export function createCanvasMediaInputResolver(
  dependencies: CanvasMediaInputResolverDependencies,
): CanvasMediaInputResolver {
  return {
    resolveNodeInputs: async (target) => {
      const document = dependencies.canvasStore.requireStableAuthoritativeDocument(target)
      const nodesById = new Map(document.nodes.map((node) => [node.id, node]))
      const targetNode = nodesById.get(target.nodeId)
      if (!targetNode || targetNode.kind !== target.mediaKind
        || targetNode.mediaModuleId !== target.mediaModuleId) {
        throw new Error('CANVAS_MEDIA_TARGET_INVALID')
      }
      const state = await dependencies.mediaStore.load(target)
      if (state.config.contentId !== target.mediaModuleId
        || state.config.mediaKind !== target.mediaKind) {
        throw new Error('CANVAS_MEDIA_CONFIG_INVALID')
      }
      const bindings: CanvasMediaResolvedInput[] = []
      for (const input of state.config.inputs) {
        bindings.push(isCanvasOutputBinding(input)
          ? await resolveCanvasOutput(dependencies, target, document, targetNode, nodesById, input)
          : resolveLiteral(dependencies, target.projectId, input))
      }
      /** 运行历史可独立增长；这里只拒绝解析期间配置 revision 或输入绑定变化。 */
      const refreshedState = await dependencies.mediaStore.load(target)
      if (refreshedState.config.revision !== state.config.revision
        || JSON.stringify(refreshedState.config.inputs) !== JSON.stringify(state.config.inputs)) {
        throw new Error('CANVAS_MEDIA_CONFIG_CHANGED')
      }
      return {
        configRevision: state.config.revision,
        ready: bindings.every((binding) => binding.errorCode === null && binding.resolvedValue !== null),
        bindings,
      }
    },
  }
}
