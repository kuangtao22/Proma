import { createHash } from 'node:crypto'
import type { ImageContent, TextContent } from '@earendil-works/pi-ai'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { AgentToolResult } from '@earendil-works/pi-agent-core'
import sharp from 'sharp'
import type {
  AgentCanvasBinding,
  CanvasAgentTarget,
  CanvasBatchOperationEnvelope,
  CanvasDocument,
  CanvasEdgeRelation,
  CanvasImageTarget,
  CanvasImageModuleConfig,
  CanvasMutation,
  CanvasNode,
  CanvasNodeReference,
  CanvasRunNodesResult,
  SaveCanvasImageModuleInput,
  CanvasTarget,
  CanvasWorkspaceSnapshot,
  DesignJobRecord,
  DesignAsset,
  DesignPoint,
} from '@proma/shared'
import { parseCanvasBatchOperationEnvelope } from '@proma/shared'
import { Type } from 'typebox'
import type { TSchema } from 'typebox'
import type { AgentRunExtensions } from '../agent-run-extensions'
import { isValidImageBytes } from '../image-content-validation'
import type { CanvasBatchOperationResult } from './canvas-agent-batch-operation'
import type {
  CanvasArtifactCreationResult,
  CanvasArtifactCreationService,
} from './canvas-artifact-creation'
import type { CanvasTextArtifactService } from './canvas-text-artifact-service'
import type { CanvasToolAccessFacade } from './canvas-tool-access-facade'

const MAX_READ_NODES = 32
const MAX_READ_RESPONSE_CHARS = 32_768
const MAX_READ_HISTORY_ENTRIES = 32
const DEFAULT_LIST_NODES_LIMIT = 50
const MAX_LIST_NODES_LIMIT = 100
const MAX_INSPECT_IMAGE_NODES = 4
const MAX_INSPECT_IMAGE_BYTES = 512 * 1024
const MAX_INSPECT_BATCH_BYTES = 2 * 1024 * 1024
const MAX_INSPECT_IMAGE_PIXELS = 64_000_000
const CANVAS_NODE_KINDS: CanvasNode['kind'][] = ['agent', 'image', 'document', 'webview']

/** 不透明分页游标绑定的权威读取边界。 */
interface CanvasNodeCursorPayload {
  projectId: string
  canvasId: string
  revision: number
  kind: CanvasNode['kind'] | null
  offset: number
}

/** Agent 图片检查可读取的受控缩略图。 */
interface CanvasInspectionThumbnail {
  bytes: Buffer
  mediaType: DesignAsset['mediaType']
}

/** 内存校验与压缩后的结果，区分不可读和无法压入预算。 */
interface PreparedInspectionThumbnail {
  thumbnail?: CanvasInspectionThumbnail
  failure?: 'image-unavailable' | 'image-too-large'
}

/** 图片检查结果只暴露节点身份和公开状态。 */
interface CanvasImageInspectionSummary {
  nodeId: string
  title: string
  status: 'ready' | 'node-not-found' | 'invalid-node-kind' | 'missing-adopted-asset'
    | 'adopted-asset-mismatch' | 'image-unavailable' | 'image-too-large'
}

/** 判断未知值是否为 Canvas 固定节点类型。 */
function isCanvasNodeKind(value: unknown): value is CanvasNode['kind'] {
  return typeof value === 'string' && CANVAS_NODE_KINDS.includes(value as CanvasNode['kind'])
}

/** 创建带摘要校验的不透明分页游标，避免调用方直接拼接页偏移。 */
function encodeCanvasNodeCursor(payload: CanvasNodeCursorPayload): string {
  const encodedPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  const digest = createHash('sha256').update(encodedPayload).digest('base64url')
  return `${encodedPayload}.${digest}`
}

/** 解析并严格校验分页游标结构与摘要。 */
function decodeCanvasNodeCursor(cursor: string): CanvasNodeCursorPayload {
  try {
    const [encodedPayload, digest, extra] = cursor.split('.')
    if (!encodedPayload || !digest || extra !== undefined) throw new Error('invalid cursor shape')
    const expectedDigest = createHash('sha256').update(encodedPayload).digest('base64url')
    if (digest !== expectedDigest) throw new Error('invalid cursor digest')
    const value: unknown = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid cursor payload')
    const record = value as Record<string, unknown>
    if (Object.keys(record).sort().join(',') !== 'canvasId,kind,offset,projectId,revision'
      || typeof record.projectId !== 'string'
      || typeof record.canvasId !== 'string'
      || !Number.isSafeInteger(record.revision) || Number(record.revision) < 0
      || (record.kind !== null && !isCanvasNodeKind(record.kind))
      || !Number.isSafeInteger(record.offset) || Number(record.offset) < 0) {
      throw new Error('invalid cursor payload')
    }
    return {
      projectId: record.projectId,
      canvasId: record.canvasId,
      revision: Number(record.revision),
      kind: record.kind as CanvasNode['kind'] | null,
      offset: Number(record.offset),
    }
  } catch {
    throw new Error('CANVAS_CURSOR_INVALID')
  }
}

/** 把受控缩略图压入单张预算；压缩只发生在内存，不修改正式素材。 */
async function prepareInspectionThumbnail(thumbnail: CanvasInspectionThumbnail): Promise<PreparedInspectionThumbnail> {
  if (!isValidImageBytes(thumbnail.mediaType, thumbnail.bytes)) return { failure: 'image-unavailable' }
  try {
    const metadata = await sharp(thumbnail.bytes, { limitInputPixels: MAX_INSPECT_IMAGE_PIXELS }).metadata()
    if (!metadata.width || !metadata.height) return { failure: 'image-unavailable' }
  } catch {
    return { failure: 'image-unavailable' }
  }
  if (thumbnail.bytes.byteLength <= MAX_INSPECT_IMAGE_BYTES) return { thumbnail }
  for (const width of [512, 384, 256]) {
    for (const quality of [76, 60, 44]) {
      try {
        const bytes = await sharp(thumbnail.bytes, { limitInputPixels: MAX_INSPECT_IMAGE_PIXELS })
          .resize({ width, height: width, fit: 'inside', withoutEnlargement: true })
          .webp({ quality })
          .toBuffer()
        if (bytes.byteLength <= MAX_INSPECT_IMAGE_BYTES && isValidImageBytes('image/webp', bytes)) {
          return { thumbnail: { bytes, mediaType: 'image/webp' } }
        }
      } catch {
        return { failure: 'image-unavailable' }
      }
    }
  }
  return { failure: 'image-too-large' }
}

/** canvas_read 单节点的内部预算条目，完整正文不直接进入最终响应。 */
interface CanvasReadBudgetEntry {
  node: CanvasNode | { id: string; kind: CanvasNode['kind']; title: string }
  content: string
  contentLength: number
  artifact?: Record<string, unknown>
}

/** canvas_read 最终结构化响应，所有字段共同受统一字符预算约束。 */
interface CanvasReadBudgetDetails {
  canvasId: string
  revision: number
  nodes: CanvasReadBudgetEntry[]
  edges: CanvasDocument['edges']
  omittedEdgeCount: number
  truncated: boolean
}

/** 返回结构化 JSON 的精确字符数，与 Agent 上下文断言保持一致。 */
function canvasReadJsonLength(details: CanvasReadBudgetDetails): number {
  return JSON.stringify(details).length
}

/** 从 artifact 安全读取数组字段，供预算收缩阶段使用。 */
function readArtifactArray(artifact: Record<string, unknown> | undefined, key: string): unknown[] | undefined {
  const value = artifact?.[key]
  return Array.isArray(value) ? value : undefined
}

/** 在保留每个节点 revision 摘要的前提下，把完整结构化响应压入统一预算。 */
function applyCanvasReadBudget(
  details: CanvasReadBudgetDetails,
  fullContents: string[],
): CanvasReadBudgetDetails {
  /** 先移除可选历史、边和图片配置，最小节点与 revision 摘要始终保留。 */
  while (canvasReadJsonLength(details) > MAX_READ_RESPONSE_CHARS) {
    const history = [...details.nodes].reverse()
      .map((entry) => readArtifactArray(entry.artifact, 'jobHistory'))
      .find((candidate) => candidate && candidate.length > 0)
    if (history) {
      history.pop()
      continue
    }
    const revisions = [...details.nodes].reverse()
      .map((entry) => readArtifactArray(entry.artifact, 'availableRevisions'))
      .find((candidate) => candidate && candidate.length > 0)
    if (revisions) {
      revisions.pop()
      continue
    }
    if (details.edges.length > 0) {
      details.edges.pop()
      details.omittedEdgeCount += 1
      continue
    }
    const configurable = [...details.nodes].reverse().find((entry) => entry.artifact?.config)
    if (configurable?.artifact) {
      delete configurable.artifact.config
      configurable.artifact.configOmitted = true
      continue
    }
    const compactable = [...details.nodes].reverse().find((entry) => 'position' in entry.node)
    if (compactable) {
      compactable.node = {
        id: compactable.node.id,
        kind: compactable.node.kind,
        title: compactable.node.title.slice(0, 32),
      }
      continue
    }
    break
  }

  /** 正文按节点顺序使用剩余预算；二分避免逐字符反复序列化。 */
  for (const [index, entry] of details.nodes.entries()) {
    const fullContent = fullContents[index] ?? ''
    const imageConfig = entry.artifact?.config as CanvasImageModuleConfig | undefined
    if (!fullContent || (entry.artifact?.kind === 'image' && !imageConfig)) continue
    let lower = 0
    let upper = fullContent.length
    while (lower < upper) {
      const candidateLength = Math.ceil((lower + upper) / 2)
      const candidate = fullContent.slice(0, candidateLength)
      if (imageConfig) imageConfig.prompt = candidate
      else entry.content = candidate
      if (canvasReadJsonLength(details) <= MAX_READ_RESPONSE_CHARS) lower = candidateLength
      else upper = candidateLength - 1
    }
    const accepted = fullContent.slice(0, lower)
    if (imageConfig) imageConfig.prompt = accepted
    else entry.content = accepted
  }

  /** 省略计数与正文原长让后续节点即使无正文也不会丢失版本语义。 */
  details.truncated = details.omittedEdgeCount > 0 || details.nodes.some((entry, index) => {
    const artifact = entry.artifact
    const fullContent = fullContents[index] ?? ''
    const returnedContent = artifact?.kind === 'image'
      ? ((artifact.config as CanvasImageModuleConfig | undefined)?.prompt ?? '')
      : entry.content
    const revisionCount = typeof artifact?.availableRevisionCount === 'number'
      ? artifact.availableRevisionCount
      : 0
    const jobCount = typeof artifact?.jobHistoryCount === 'number' ? artifact.jobHistoryCount : 0
    return returnedContent.length < fullContent.length
      || (readArtifactArray(artifact, 'availableRevisions')?.length ?? 0) < revisionCount
      || (readArtifactArray(artifact, 'jobHistory')?.length ?? 0) < jobCount
      || artifact?.configOmitted === true
  })
  /** false 比 true 多一个字符；极限命中时保守声明截断以维持硬上限。 */
  if (canvasReadJsonLength(details) > MAX_READ_RESPONSE_CHARS) details.truncated = true
  return details
}

/** 普通项目 Agent 单轮可用的十一个 Canvas 工具。 */
export const CANVAS_TOOL_NAMES = [
  'canvas_get_context',
  'canvas_manage',
  'canvas_list_nodes',
  'canvas_inspect_images',
  'canvas_read',
  'canvas_apply_changes',
  'canvas_create_agent',
  'canvas_import_image',
  'canvas_create_artifact',
  'canvas_update_artifact',
  'canvas_run_nodes',
] as const

/** Host 只执法会话权限上限，不从用户文本推断业务意图。 */
export type CanvasToolPermissionCeiling = 'plan' | 'execute'

/** 引用完成权威解析后构造的单轮可信上下文。 */
export interface CanvasToolRunContext {
  projectId: string
  sessionId: string
  runStartedAt: number
  explicitReferences: CanvasNodeReference[]
  permissionCeiling: CanvasToolPermissionCeiling
  /** Canvas 内部 Agent 只能访问自身所属画布，不能管理普通 Agent 的画布关联。 */
  canvasAgentTarget?: CanvasAgentTarget
}

/** Provider 交给主进程路径授权边界的本地图片导入请求。 */
export interface CanvasToolImageImportInput extends CanvasTarget {
  baseRevision: number
  title: string
  localPath: string
  prompt?: string
  position?: DesignPoint
  sourceNodeId?: string
  relation?: CanvasEdgeRelation
  source: {
    sessionId: string
    runStartedAt: number
    toolCallId: string
  }
}

/** Provider 只依赖现有权威 Store、Task8 batch 与执行接缝。 */
export interface CanvasToolProviderDependencies {
  access: Pick<CanvasToolAccessFacade,
    | 'authorizeRead'
    | 'getBinding'
    | 'requireLinkedCanvas'
    | 'runWrite'
    | 'createAndLink'
    | 'link'
    | 'unlink'
    | 'setDefault'>
  documents: {
    load: (target: CanvasTarget) => CanvasWorkspaceSnapshot
    validateBatchOperations: (target: CanvasTarget, expectedRevision: number, operations: unknown[]) => CanvasMutation[]
  }
  readNodeContent?: (target: CanvasTarget, node: CanvasNode) => Promise<string>
  artifacts: Pick<CanvasArtifactCreationService, 'create' | 'createAgent'>
  /** 主进程在调用导入事务前负责解析并验证本地路径。 */
  importImage: (input: CanvasToolImageImportInput) => Promise<CanvasArtifactCreationResult>
  textArtifacts: Pick<CanvasTextArtifactService, 'read' | 'listVersions' | 'update'>
  images: {
    loadConfig: (target: CanvasImageTarget) => Promise<CanvasImageModuleConfig>
    load: (target: CanvasImageTarget) => Promise<{
      config: CanvasImageModuleConfig
      jobs: DesignJobRecord[]
    }>
    save: (input: SaveCanvasImageModuleInput) => Promise<CanvasImageModuleConfig>
    readThumbnail: (projectId: string, assetId: string) => Promise<CanvasInspectionThumbnail>
  }
  batch: { execute: (input: CanvasBatchOperationEnvelope) => Promise<CanvasBatchOperationResult> }
  runNodes: (
    context: CanvasToolRunContext,
    target: CanvasTarget,
    nodes: CanvasNode[],
    toolCallId: string,
  ) => Promise<CanvasRunNodesResult>
}

/** Provider 产出的单轮扩展；extend 保留普通 Agent 原有工具。 */
export interface CanvasToolRun extends Required<Pick<AgentRunExtensions, 'systemPromptAppend' | 'piCustomTools' | 'allowedToolNames' | 'singleApprovalToolNames'>> {
  allowedToolNamesMode: 'extend'
}

/** 构造同时写入文本与结构化 details 的 Pi 工具结果。 */
function toolResult(details: Record<string, unknown>, compact = false): AgentToolResult<unknown> {
  /** canvas_read 使用紧凑文本以复用同一预算口径，其它短响应保留格式化可读性。 */
  const text = compact ? JSON.stringify(details) : JSON.stringify(details, null, 2)
  return { content: [{ type: 'text', text }], details }
}

/** 保留 TypeBox schema 对 execute 参数的静态推断。 */
function defineCanvasTool<TParams extends TSchema, TDetails = unknown>(
  tool: ToolDefinition<TParams, TDetails>,
): ToolDefinition<TParams, TDetails> {
  return tool
}

/** 删除与覆盖现有节点或边均属于破坏性修改。 */
function hasDestructiveMutation(document: CanvasDocument, operations: CanvasMutation[]): boolean {
  const existingNodeIds = new Set(document.nodes.map((node) => node.id))
  const existingEdgeIds = new Set(document.edges.map((edge) => edge.id))
  return operations.some((operation) => (
    operation.type === 'remove-nodes'
    || operation.type === 'remove-edges'
    || (operation.type === 'upsert-nodes' && operation.nodes.some((node) => existingNodeIds.has(node.id)))
    || (operation.type === 'upsert-edges' && operation.edges.some((edge) => existingEdgeIds.has(edge.id)))
  ))
}

/** plan 只能新增节点与边，任何覆盖或其它 mutation 都必须升级为 execute。 */
function isPlanSafeMutation(document: CanvasDocument, operations: CanvasMutation[]): boolean {
  /** 当前节点和边 ID 用于拒绝 plan 覆盖已有结构。 */
  const existingNodeIds = new Set(document.nodes.map((node) => node.id))
  const existingEdgeIds = new Set(document.edges.map((edge) => edge.id))
  return operations.every((operation) => {
    if (operation.type === 'upsert-nodes') {
      return operation.nodes.every((node) => !existingNodeIds.has(node.id))
    }
    if (operation.type === 'upsert-edges') {
      return operation.edges.every((edge) => !existingEdgeIds.has(edge.id))
    }
    return false
  })
}

function isRevisionConflict(error: unknown): boolean {
  return error instanceof Error && (
    error.message.includes('CANVAS_REVISION_CONFLICT')
    || error.message.includes('CANVAS_BATCH_INTENT_PLAN_CONFLICT')
  )
}

/** 在共享 128 字符 ID 边界内生成唯一重试身份。 */
function createRetrySourceToolCallId(toolCallId: string): string {
  const suffix = '-retry'
  return `${toolCallId.slice(0, 128 - suffix.length)}${suffix}`
}

/** 从执行身份派生跨进程稳定 Canvas ID，不读取或扫描项目内其它 Canvas。 */
function createManagedCanvasId(context: CanvasToolRunContext, toolCallId: string): string {
  /** 长度前缀编码避免不同字段拼接产生边界碰撞。 */
  const identity = [context.projectId, context.sessionId, String(context.runStartedAt), toolCallId]
    .map((value) => `${value.length}:${value}`)
    .join('|')
  return `agent-canvas-${createHash('sha256').update(identity).digest('hex')}`
}

/** 从工具调用稳定派生共享文本事务要求的 UUID v4。 */
function createArtifactOperationId(context: CanvasToolRunContext, toolCallId: string): string {
  /** 固定执行身份 hash 用于重放时命中同一 operationId。 */
  const hash = createHash('sha256')
    .update(`${context.projectId}\u0000${context.sessionId}\u0000${context.runStartedAt}\u0000${toolCallId}`)
    .digest('hex')
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`
}

/** 为普通项目 Agent 创建不持久化的单轮 Canvas 工具。 */
export function createCanvasToolRun(
  dependencies: CanvasToolProviderDependencies,
  context: CanvasToolRunContext,
): CanvasToolRun {
  /** 本轮访问上下文始终 fresh-read binding，不缓存扩大后的权限。 */
  const getContext = (): AgentCanvasBinding | null => dependencies.access.getBinding(context)

  const tools: ToolDefinition[] = [
    defineCanvasTool({
      name: 'canvas_get_context', label: '获取画布上下文',
      description: '返回当前 Agent 已关联、默认、活动画布和本轮明确引用摘要；不会扫描项目全部画布。',
      parameters: Type.Object({}),
      execute: async () => {
        dependencies.access.authorizeRead(context)
        const binding = getContext()
        return toolResult({
          projectId: context.projectId,
          linkedCanvasIds: binding?.linkedCanvasIds ?? [],
          defaultCanvasId: binding?.defaultCanvasId ?? null,
          activeCanvasId: binding?.lastActiveCanvasId ?? null,
          explicitReferences: context.explicitReferences.map((reference) => ({
            canvasId: reference.canvasId, nodeId: reference.nodeId, nodeType: reference.nodeType,
            nodeRevision: reference.nodeRevision, title: reference.title,
          })),
          permissionCeiling: context.permissionCeiling,
        })
      },
    }),
    defineCanvasTool({
      name: 'canvas_manage', label: '管理画布关联',
      description: '创建、关联、解除关联或设置默认画布。创建和新增关联必须来自明确任务或用户选择。',
      parameters: Type.Object({
        action: Type.Union([Type.Literal('create'), Type.Literal('link'), Type.Literal('unlink'), Type.Literal('set-default')]),
        canvasId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
        title: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
        makeDefault: Type.Optional(Type.Boolean()),
      }),
      execute: async (toolCallId, params) => {
        dependencies.access.authorizeRead(context)
        if (context.permissionCeiling === 'plan' && params.action === 'create') {
          throw new Error('CANVAS_EXECUTE_INTENT_REQUIRED')
        }
        if (context.permissionCeiling === 'plan' && params.action !== 'create' && params.action !== 'link') {
          throw new Error('CANVAS_EXECUTE_INTENT_REQUIRED')
        }
        if (params.action === 'create') {
          /** 同一 tool call 始终命中同一索引记录，首次 link 失败后也可安全重放。 */
          const canvasId = createManagedCanvasId(context, toolCallId)
          const { session, binding } = dependencies.access.createAndLink(context, {
            canvasId,
            ...(params.title ? { title: params.title } : {}),
            makeDefault: params.makeDefault ?? true,
          })
          return toolResult({ action: params.action, canvasId: session.id, session, binding })
        }
        if (!params.canvasId) throw new Error('CANVAS_ID_REQUIRED')
        if (params.action === 'link') {
          /** 关联只能复用已有 binding 或本轮权威节点引用，模型自报参数不能扩权。 */
          const binding = getContext()
          const authorizedCanvasIds = new Set([
            ...(binding?.linkedCanvasIds ?? []),
            ...context.explicitReferences.map((reference) => reference.canvasId),
          ])
          if (!authorizedCanvasIds.has(params.canvasId)) throw new Error('CANVAS_EXPLICIT_SELECTION_REQUIRED')
          const nextBinding = dependencies.access.link(context, params.canvasId, params.makeDefault ?? false)
          return toolResult({ action: params.action, canvasId: params.canvasId, binding: nextBinding })
        }
        dependencies.access.requireLinkedCanvas(context, params.canvasId)
        const binding = params.action === 'unlink'
          ? dependencies.access.unlink(context, params.canvasId)
          : dependencies.access.setDefault(context, params.canvasId)
        return toolResult({ action: params.action, canvasId: params.canvasId, binding })
      },
    }),
    defineCanvasTool({
      name: 'canvas_list_nodes', label: '枚举画布节点',
      description: '分页枚举当前会话已关联画布的权威节点摘要；可按节点类型过滤，不返回素材 ID、媒体 URL 或本地路径。',
      parameters: Type.Object({
        canvasId: Type.String({ minLength: 1, maxLength: 128 }),
        kind: Type.Optional(Type.Union([
          Type.Literal('agent'), Type.Literal('image'), Type.Literal('document'), Type.Literal('webview'),
        ])),
        cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 2048 })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_LIST_NODES_LIMIT })),
      }),
      execute: async (_toolCallId, params) => {
        dependencies.access.authorizeRead(context)
        dependencies.access.requireLinkedCanvas(context, params.canvasId)
        const target = { projectId: context.projectId, canvasId: params.canvasId }
        const document = dependencies.documents.load(target).document
        /** 游标只能继续同项目、同画布、同过滤条件和同一 revision 的读取。 */
        const cursor = params.cursor ? decodeCanvasNodeCursor(params.cursor) : undefined
        if (cursor && (cursor.projectId !== context.projectId
          || cursor.canvasId !== params.canvasId
          || cursor.kind !== (params.kind ?? null))) {
          throw new Error('CANVAS_CURSOR_INVALID')
        }
        if (cursor && cursor.revision !== document.revision) throw new Error('CANVAS_REVISION_CONFLICT')
        const offset = cursor?.offset ?? 0
        const limit = params.limit ?? DEFAULT_LIST_NODES_LIMIT
        const filteredNodes = params.kind
          ? document.nodes.filter((node) => node.kind === params.kind)
          : document.nodes
        const pageNodes = filteredNodes.slice(offset, offset + limit)
        /** 图片配置只读取当前页，避免为未返回节点加载模块 JSON 或任务历史。 */
        const nodes = await Promise.all(pageNodes.map(async (node) => {
          if (node.kind === 'image') {
            const config = await dependencies.images.loadConfig({ ...target, nodeId: node.id, imageModuleId: node.imageModuleId })
            return {
              nodeId: node.id,
              kind: node.kind,
              title: node.title,
              configRevision: config.revision,
              hasAdoptedAsset: Boolean(node.adoptedAssetId && config.adoptedAssetId),
            }
          }
          return {
            nodeId: node.id,
            kind: node.kind,
            title: node.title,
            ...((node.kind === 'document' || node.kind === 'webview')
              ? { contentRevision: node.contentRevision }
              : {}),
          }
        }))
        const nextOffset = offset + pageNodes.length
        const hasMore = nextOffset < filteredNodes.length
        return toolResult({
          canvasId: params.canvasId,
          revision: document.revision,
          nodes,
          hasMore,
          nextCursor: hasMore
            ? encodeCanvasNodeCursor({
              projectId: context.projectId,
              canvasId: params.canvasId,
              revision: document.revision,
              kind: params.kind ?? null,
              offset: nextOffset,
            })
            : null,
        })
      },
    }),
    defineCanvasTool({
      name: 'canvas_inspect_images', label: '检查画布图片',
      description: '按节点读取同一画布 revision 下当前正式采用的受限缩略图；只用于视觉核对，不修改提示词、不生图、不采用候选。',
      parameters: Type.Object({
        canvasId: Type.String({ minLength: 1, maxLength: 128 }),
        nodeIds: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), {
          minItems: 1,
          maxItems: MAX_INSPECT_IMAGE_NODES,
        }),
        expectedRevision: Type.Integer({ minimum: 0 }),
      }),
      execute: async (_toolCallId, params) => {
        dependencies.access.authorizeRead(context)
        dependencies.access.requireLinkedCanvas(context, params.canvasId)
        if (params.nodeIds.length < 1 || params.nodeIds.length > MAX_INSPECT_IMAGE_NODES) {
          throw new Error('CANVAS_IMAGE_BATCH_LIMIT')
        }
        const target = { projectId: context.projectId, canvasId: params.canvasId }
        const document = dependencies.documents.load(target).document
        /** revision 必须在任何图片模块或缩略图读取前复核，避免混合新旧正式状态。 */
        if (document.revision !== params.expectedRevision) throw new Error('CANVAS_REVISION_CONFLICT')
        const nodeIds = [...new Set(params.nodeIds)]
        const content: Array<TextContent | ImageContent> = []
        const inspections: CanvasImageInspectionSummary[] = []
        let totalImageBytes = 0
        /** 公开失败只描述节点级状态，底层素材身份和磁盘错误不得进入工具结果。 */
        const appendStatus = (summary: CanvasImageInspectionSummary): void => {
          inspections.push(summary)
          content.push({ type: 'text', text: JSON.stringify(summary) })
        }
        for (const nodeId of nodeIds) {
          const node = document.nodes.find((candidate) => candidate.id === nodeId)
          if (!node) {
            appendStatus({ nodeId, title: '', status: 'node-not-found' })
            continue
          }
          if (node.kind !== 'image') {
            appendStatus({ nodeId, title: node.title, status: 'invalid-node-kind' })
            continue
          }
          let config: CanvasImageModuleConfig
          try {
            config = await dependencies.images.loadConfig({ ...target, nodeId: node.id, imageModuleId: node.imageModuleId })
          } catch {
            appendStatus({ nodeId, title: node.title, status: 'image-unavailable' })
            continue
          }
          if (!node.adoptedAssetId && !config.adoptedAssetId) {
            appendStatus({ nodeId, title: node.title, status: 'missing-adopted-asset' })
            continue
          }
          if (!node.adoptedAssetId || node.adoptedAssetId !== config.adoptedAssetId) {
            appendStatus({ nodeId, title: node.title, status: 'adopted-asset-mismatch' })
            continue
          }
          let thumbnail: CanvasInspectionThumbnail
          try {
            thumbnail = await dependencies.images.readThumbnail(context.projectId, node.adoptedAssetId)
          } catch {
            appendStatus({ nodeId, title: node.title, status: 'image-unavailable' })
            continue
          }
          const prepared = await prepareInspectionThumbnail(thumbnail)
          if (!prepared.thumbnail) {
            appendStatus({ nodeId, title: node.title, status: prepared.failure ?? 'image-unavailable' })
            continue
          }
          if (totalImageBytes + prepared.thumbnail.bytes.byteLength > MAX_INSPECT_BATCH_BYTES) {
            appendStatus({ nodeId, title: node.title, status: 'image-too-large' })
            continue
          }
          totalImageBytes += prepared.thumbnail.bytes.byteLength
          const summary: CanvasImageInspectionSummary = { nodeId, title: node.title, status: 'ready' }
          appendStatus(summary)
          content.push({
            type: 'image',
            data: prepared.thumbnail.bytes.toString('base64'),
            mimeType: prepared.thumbnail.mediaType,
          })
        }
        return {
          content,
          details: {
            canvasId: params.canvasId,
            revision: document.revision,
            inspections,
            imageCount: inspections.filter((entry) => entry.status === 'ready').length,
            totalImageBytes,
          },
        } satisfies AgentToolResult<unknown>
      },
    }),
    defineCanvasTool({
      name: 'canvas_read', label: '读取画布节点',
      description: '按 ID 权威读取当前会话已关联画布的有限节点、正文与必要邻接。',
      parameters: Type.Object({
        canvasId: Type.String({ minLength: 1, maxLength: 128 }),
        nodeIds: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { minItems: 1, maxItems: MAX_READ_NODES }),
        includeNeighbors: Type.Optional(Type.Boolean()),
      }),
      execute: async (_toolCallId, params) => {
        dependencies.access.authorizeRead(context)
        dependencies.access.requireLinkedCanvas(context, params.canvasId)
        const target = { projectId: context.projectId, canvasId: params.canvasId }
        const document = dependencies.documents.load(target).document
        const explicitNodeIds = new Set(params.nodeIds)
        const requestedIds = new Set(explicitNodeIds)
        if (params.includeNeighbors) {
          for (const edge of document.edges) {
            if (requestedIds.size >= MAX_READ_NODES) break
            if (explicitNodeIds.has(edge.sourceNodeId)) requestedIds.add(edge.targetNodeId)
            else if (explicitNodeIds.has(edge.targetNodeId)) requestedIds.add(edge.sourceNodeId)
          }
        }
        const nodes = document.nodes.filter((node) => requestedIds.has(node.id)).slice(0, MAX_READ_NODES)
        const returnedNodeIds = new Set(nodes.map((node) => node.id))
        /** revision 与图片任务历史分别共享全局上限，不能按节点各放大 32 倍。 */
        let remainingRevisionEntries = MAX_READ_HISTORY_ENTRIES
        let remainingJobEntries = MAX_READ_HISTORY_ENTRIES
        const entries: CanvasReadBudgetEntry[] = []
        const fullContents: string[] = []
        for (const node of nodes) {
          /** 内容节点按权威类型加载统一产物投影。 */
          let artifact: Record<string, unknown> | undefined
          let fullContent = ''
          if (node.kind === 'document' || node.kind === 'webview') {
            /** 节点类别决定稳定正文 ID。 */
            const contentId = node.kind === 'document' ? node.documentId : node.prototypeId
            /** 当前采用正文和已提交历史。 */
            const artifactTarget = { ...target, nodeId: node.id, kind: node.kind, contentId, contentRevision: node.contentRevision }
            const [snapshot, versions] = await Promise.all([
              dependencies.textArtifacts.read(artifactTarget),
              dependencies.textArtifacts.listVersions({ ...target, nodeId: node.id, kind: node.kind, contentId }),
            ])
            fullContent = snapshot.content
            const availableRevisions = versions
              .slice(0, remainingRevisionEntries)
              .map((version) => version.revision)
            remainingRevisionEntries -= availableRevisions.length
            artifact = {
              nodeId: node.id,
              kind: node.kind,
              currentRevision: node.contentRevision,
              availableRevisions,
              availableRevisionCount: versions.length,
            }
          } else if (node.kind === 'image') {
            /** 图片读取复用现有模块快照，不复制任务或素材事实。 */
            const image = await dependencies.images.load({ ...target, nodeId: node.id, imageModuleId: node.imageModuleId })
            /** 图片提示词同样计入单次正文预算，避免配置绕过上下文上限。 */
            fullContent = image.config.prompt
            const jobs = remainingJobEntries > 0
              ? image.jobs.slice(-remainingJobEntries)
              : []
            remainingJobEntries -= jobs.length
            const allRevisions = [...new Set(image.jobs
              .map((job) => job.canvasImageConfigRevision)
              .filter((revision): revision is number => revision !== undefined))]
            const availableRevisions = allRevisions.slice(0, remainingRevisionEntries)
            remainingRevisionEntries -= availableRevisions.length
            artifact = {
              nodeId: node.id,
              kind: 'image',
              currentRevision: image.config.revision,
              availableRevisions,
              availableRevisionCount: allRevisions.length,
              jobHistory: jobs.map((job) => ({
                id: job.id,
                status: job.status,
                configRevision: job.canvasImageConfigRevision,
                outputAssetId: job.outputAssetId,
                createdAt: job.createdAt,
              })),
              jobHistoryCount: image.jobs.length,
              config: { ...image.config, prompt: '' },
              adoptedAssetId: image.config.adoptedAssetId,
            }
          } else {
            fullContent = dependencies.readNodeContent ? await dependencies.readNodeContent(target, node) : ''
          }
          fullContents.push(fullContent)
          entries.push({ node, content: '', contentLength: fullContent.length, ...(artifact ? { artifact } : {}) })
        }
        /** 最终 details 自身而非单一正文字段受统一硬预算。 */
        const details = applyCanvasReadBudget({
          canvasId: params.canvasId,
          revision: document.revision,
          nodes: entries,
          edges: document.edges.filter((edge) => returnedNodeIds.has(edge.sourceNodeId) && returnedNodeIds.has(edge.targetNodeId)),
          omittedEdgeCount: 0,
          truncated: true,
        }, fullContents)
        return toolResult(details as unknown as Record<string, unknown>, true)
      },
    }),
    defineCanvasTool({
      name: 'canvas_apply_changes', label: '应用画布修改',
      description: '只通过受控批量事务提交画布修改；删除或覆盖必须声明 destructiveIntent=explicit。',
      parameters: Type.Object({
        canvasId: Type.String({ minLength: 1, maxLength: 128 }),
        baseRevision: Type.Integer({ minimum: 0 }),
        operations: Type.Array(Type.Any(), { minItems: 1, maxItems: 128 }),
        destructiveIntent: Type.Optional(Type.Literal('explicit')),
      }),
      execute: async (toolCallId, params) => {
        dependencies.access.authorizeRead(context)
        return dependencies.access.runWrite(context, async () => {
          dependencies.access.requireLinkedCanvas(context, params.canvasId)
          const target = { projectId: context.projectId, canvasId: params.canvasId }
          const rawOperations = structuredClone(params.operations)
          const execute = (baseRevision: number, sourceToolCallId: string): Promise<CanvasBatchOperationResult> => {
            const operations = dependencies.documents.validateBatchOperations(target, baseRevision, rawOperations)
            const document = dependencies.documents.load(target).document
            if (context.permissionCeiling === 'plan' && !isPlanSafeMutation(document, operations)) {
              throw new Error('CANVAS_EXECUTE_INTENT_REQUIRED')
            }
            if (hasDestructiveMutation(document, operations) && params.destructiveIntent !== 'explicit') {
              throw new Error('CANVAS_DESTRUCTIVE_INTENT_REQUIRED')
            }
            const envelope = parseCanvasBatchOperationEnvelope({
              ...target, baseRevision, operations,
              sourceSessionId: context.sessionId,
              sourceRunStartedAt: context.runStartedAt,
              sourceToolCallId,
            })
            return dependencies.batch.execute(envelope)
          }
          let sourceToolCallId = toolCallId
          let result: CanvasBatchOperationResult
          try {
            result = await execute(params.baseRevision, sourceToolCallId)
          } catch (error) {
            if (!isRevisionConflict(error)) throw error
            sourceToolCallId = createRetrySourceToolCallId(toolCallId)
            result = await execute(dependencies.documents.load(target).document.revision, sourceToolCallId)
          }
          return toolResult({ canvasId: params.canvasId, revision: result.document.revision, operationId: result.operationId, sourceToolCallId })
        })
      },
    }),
    defineCanvasTool({
      name: 'canvas_create_agent', label: '创建 Canvas Agent',
      description: '在已关联画布中创建独立 Canvas Agent 节点承担后续分工，可选从已有节点自动连线；普通 Agent 无需让用户手工创建。',
      parameters: Type.Object({
        canvasId: Type.String({ minLength: 1, maxLength: 128 }),
        baseRevision: Type.Integer({ minimum: 0 }),
        title: Type.String({ minLength: 1, maxLength: 120 }),
        position: Type.Optional(Type.Object({
          x: Type.Number(),
          y: Type.Number(),
        })),
        sourceNodeId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
        relation: Type.Optional(Type.Union([
          Type.Literal('association'), Type.Literal('reference'),
          Type.Literal('depends-on'), Type.Literal('derives'),
        ])),
      }),
      execute: async (toolCallId, params) => {
        dependencies.access.authorizeRead(context)
        if (context.permissionCeiling === 'plan') throw new Error('CANVAS_EXECUTE_INTENT_REQUIRED')
        return dependencies.access.runWrite(context, async () => {
          dependencies.access.requireLinkedCanvas(context, params.canvasId)
          const result = await dependencies.artifacts.createAgent({
            projectId: context.projectId,
            canvasId: params.canvasId,
            baseRevision: params.baseRevision,
            title: params.title,
            ...(params.position ? { position: params.position } : {}),
            ...(params.sourceNodeId ? { sourceNodeId: params.sourceNodeId } : {}),
            ...(params.relation ? { relation: params.relation as CanvasEdgeRelation } : {}),
            source: {
              sessionId: context.sessionId,
              runStartedAt: context.runStartedAt,
              toolCallId,
            },
          })
          return toolResult({
            canvasId: result.canvasId,
            nodeId: result.nodeId,
            revision: result.revision,
            sourceToolCallId: result.sourceToolCallId,
          })
        })
      },
    }),
    defineCanvasTool({
      name: 'canvas_import_image', label: '导入画布图片',
      description: '把当前 Agent 已授权目录中的现有图片导入已关联画布，并创建立即采用该图片的参考节点；不要要求用户拖入原生 Canvas。',
      parameters: Type.Object({
        canvasId: Type.String({ minLength: 1, maxLength: 128 }),
        baseRevision: Type.Integer({ minimum: 0 }),
        title: Type.String({ minLength: 1, maxLength: 120 }),
        localPath: Type.String({ minLength: 1, maxLength: 16_384 }),
        prompt: Type.Optional(Type.String({ maxLength: 256 * 1024 })),
        position: Type.Optional(Type.Object({
          x: Type.Number(),
          y: Type.Number(),
        })),
        sourceNodeId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
        relation: Type.Optional(Type.Union([
          Type.Literal('association'), Type.Literal('reference'),
          Type.Literal('depends-on'), Type.Literal('derives'),
        ])),
      }),
      execute: async (toolCallId, params) => {
        dependencies.access.authorizeRead(context)
        if (context.permissionCeiling === 'plan') throw new Error('CANVAS_EXECUTE_INTENT_REQUIRED')
        return dependencies.access.runWrite(context, async () => {
          dependencies.access.requireLinkedCanvas(context, params.canvasId)
          const result = await dependencies.importImage({
            projectId: context.projectId,
            canvasId: params.canvasId,
            baseRevision: params.baseRevision,
            title: params.title,
            localPath: params.localPath,
            ...(params.prompt !== undefined ? { prompt: params.prompt } : {}),
            ...(params.position ? { position: params.position } : {}),
            ...(params.sourceNodeId ? { sourceNodeId: params.sourceNodeId } : {}),
            ...(params.relation ? { relation: params.relation as CanvasEdgeRelation } : {}),
            source: {
              sessionId: context.sessionId,
              runStartedAt: context.runStartedAt,
              toolCallId,
            },
          })
          return toolResult({
            canvasId: result.canvasId,
            nodeId: result.nodeId,
            revision: result.revision,
            artifactType: result.artifactType,
            sourceToolCallId: result.sourceToolCallId,
          })
        })
      },
    }),
    defineCanvasTool({
      name: 'canvas_create_artifact', label: '创建画布产物',
      description: '在已关联画布中原子创建含真实内容的文档、WebView 原型或图片设计稿节点，可选从已有节点自动连线。不要把 Markdown、HTML 或图片提示词正文传给 canvas_apply_changes。',
      parameters: Type.Object({
        canvasId: Type.String({ minLength: 1, maxLength: 128 }),
        baseRevision: Type.Integer({ minimum: 0 }),
        artifactType: Type.Union([Type.Literal('document'), Type.Literal('webview'), Type.Literal('image')]),
        devicePreset: Type.Optional(Type.Union([Type.Literal('desktop'), Type.Literal('mobile')])),
        title: Type.String({ minLength: 1, maxLength: 120 }),
        content: Type.String({ minLength: 1, maxLength: 256 * 1024 }),
        position: Type.Optional(Type.Object({
          x: Type.Number(),
          y: Type.Number(),
        })),
        sourceNodeId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
        relation: Type.Optional(Type.Union([
          Type.Literal('association'), Type.Literal('reference'),
          Type.Literal('depends-on'), Type.Literal('derives'),
        ])),
      }),
      execute: async (toolCallId, params) => {
        dependencies.access.authorizeRead(context)
        if (context.permissionCeiling === 'plan') throw new Error('CANVAS_EXECUTE_INTENT_REQUIRED')
        return dependencies.access.runWrite(context, async () => {
          dependencies.access.requireLinkedCanvas(context, params.canvasId)
          const result = await dependencies.artifacts.create({
            projectId: context.projectId,
            canvasId: params.canvasId,
            baseRevision: params.baseRevision,
            artifactType: params.artifactType,
            title: params.title,
            content: params.content,
            ...(params.devicePreset ? { devicePreset: params.devicePreset } : {}),
            ...(params.position ? { position: params.position } : {}),
            ...(params.sourceNodeId ? { sourceNodeId: params.sourceNodeId } : {}),
            ...(params.relation ? { relation: params.relation as CanvasEdgeRelation } : {}),
            source: {
              sessionId: context.sessionId,
              runStartedAt: context.runStartedAt,
              toolCallId,
            },
          })
          return toolResult({
            canvasId: result.canvasId,
            nodeId: result.nodeId,
            revision: result.revision,
            artifactType: result.artifactType,
            sourceToolCallId: result.sourceToolCallId,
          })
        })
      },
    }),
    defineCanvasTool({
      name: 'canvas_update_artifact', label: '更新画布产物',
      description: '更新已有文档、WebView 正文或图片提示词；图片只保存配置，不会生图。用户要求立即生图时必须另行调用 canvas_run_nodes。',
      parameters: Type.Object({
        canvasId: Type.String({ minLength: 1, maxLength: 128 }),
        nodeId: Type.String({ minLength: 1, maxLength: 128 }),
        baseRevision: Type.Integer({ minimum: 0 }),
        expectedContentRevision: Type.Integer({ minimum: 0 }),
        content: Type.String({ maxLength: 256 * 1024 }),
      }),
      execute: async (toolCallId, params) => {
        dependencies.access.authorizeRead(context)
        if (context.permissionCeiling === 'plan') throw new Error('CANVAS_EXECUTE_INTENT_REQUIRED')
        return dependencies.access.runWrite(context, async () => {
          dependencies.access.requireLinkedCanvas(context, params.canvasId)
          /** fresh 图只按 nodeId 解析实际类别和内容身份。 */
          const target = { projectId: context.projectId, canvasId: params.canvasId }
          const document = dependencies.documents.load(target).document
          if (document.revision !== params.baseRevision) throw new Error('CANVAS_ARTIFACT_REVISION_CONFLICT')
          /** 当前权威节点，工具参数不允许自报 kind 或 contentId。 */
          const node = document.nodes.find((candidate) => candidate.id === params.nodeId)
          if (!node) throw new Error('CANVAS_NODE_NOT_FOUND')
          if (node.kind === 'document' || node.kind === 'webview') {
            /** 文本类别对应的稳定内容 ID。 */
            const contentId = node.kind === 'document' ? node.documentId : node.prototypeId
            const result = await dependencies.textArtifacts.update({
              ...target,
              nodeId: node.id,
              kind: node.kind,
              contentId,
              operationId: createArtifactOperationId(context, toolCallId),
              expectedCanvasRevision: params.baseRevision,
              expectedContentRevision: params.expectedContentRevision,
              content: params.content,
              source: {
                type: 'agent', sessionId: context.sessionId,
                runStartedAt: context.runStartedAt, toolCallId,
              },
            })
            return toolResult({
              canvasId: params.canvasId,
              nodeId: node.id,
              kind: node.kind,
              revision: result.snapshot.document.revision,
              contentRevision: result.artifact.target.contentRevision,
            })
          }
          if (node.kind === 'image') {
            /** 图片更新先读取配置，以 CAS 保留模型、比例、尺寸和上下文。 */
            const imageTarget = { ...target, nodeId: node.id, imageModuleId: node.imageModuleId }
            const snapshot = await dependencies.images.load(imageTarget)
            if (snapshot.config.revision !== params.expectedContentRevision) {
              throw new Error('CANVAS_ARTIFACT_REVISION_CONFLICT')
            }
            const config = await dependencies.images.save({
              ...imageTarget,
              expectedConfigRevision: params.expectedContentRevision,
              prompt: params.content,
              selectedModelProfileId: snapshot.config.selectedModelProfileId,
              aspectRatio: snapshot.config.aspectRatio,
              imageSize: snapshot.config.imageSize,
              contextMode: snapshot.config.contextMode,
            })
            return toolResult({
              canvasId: params.canvasId,
              nodeId: node.id,
              kind: 'image',
              revision: document.revision,
              contentRevision: config.revision,
              requiresRun: true,
            })
          }
          throw new Error('CANVAS_ARTIFACT_TYPE_UNSUPPORTED')
        })
      },
    }),
    defineCanvasTool({
      name: 'canvas_run_nodes', label: '运行画布节点',
      description: '运行已有生图节点并生成图片，调用图片模型时可能产生模型费用。',
      parameters: Type.Object({ canvasId: Type.String({ minLength: 1, maxLength: 128 }), nodeIds: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { minItems: 1, maxItems: MAX_READ_NODES }) }),
      execute: async (toolCallId, params) => {
        dependencies.access.authorizeRead(context)
        if (context.permissionCeiling === 'plan') throw new Error('CANVAS_RUN_REQUIRES_EXPLICIT_EXECUTE')
        return dependencies.access.runWrite(context, async () => {
          dependencies.access.requireLinkedCanvas(context, params.canvasId)
          const target = { projectId: context.projectId, canvasId: params.canvasId }
          const document = dependencies.documents.load(target).document
          /** 稳定去重，避免同一请求重复启动相同节点。 */
          const nodeIds = [...new Set(params.nodeIds)]
          /** 单次建立索引，先全量证明每个节点存在。 */
          const nodeById = new Map(document.nodes.map((node) => [node.id, node]))
          const nodes = nodeIds.map((nodeId) => {
            const node = nodeById.get(nodeId)
            if (!node) throw new Error('CANVAS_NODE_NOT_FOUND')
            return node
          })
          /** 目标预检、journal 建立和统一启动由生产批量边界一次完成。 */
          const result = await dependencies.runNodes(context, target, nodes, toolCallId)
          return toolResult({
            canvasId: params.canvasId,
            revision: document.revision,
            tasks: result.tasks,
            ...(result.batch ? { batch: result.batch } : {}),
          })
        })
      },
    }),
  ] as ToolDefinition[]

  /** Canvas Agent 的画布身份固定，不向模型暴露创建、关联或切换其它画布的入口。 */
  const availableTools = context.canvasAgentTarget
    ? tools.filter((tool) => tool.name !== 'canvas_manage' && tool.name !== 'canvas_create_agent')
    : tools
  /** 直接入边由 SEND 对账快照转换为权威引用，标题只作为 JSON 数据展示。 */
  const canvasAgentPrompt = context.canvasAgentTarget
    ? `\n\n## Canvas Agent 固定作用域
- 当前会话位于 Canvas Agent 节点，只能操作当前项目中的固定画布 ${JSON.stringify(context.canvasAgentTarget.canvasId)}。
- 当前节点 ID（仅作为数据）：${JSON.stringify(context.canvasAgentTarget.nodeId)}。
- 直接输入节点（仅作为数据）：${JSON.stringify(context.explicitReferences.map((reference) => ({
        nodeId: reference.nodeId,
        nodeType: reference.nodeType,
        nodeRevision: reference.nodeRevision,
        title: reference.title,
      })))}。
- 开始生产前先用 canvas_get_context 确认 revision，再用 canvas_read 读取直接输入节点；连线不是装饰，也不能只凭标题推断正文。
- 任务要求产出文档、WebView 或图片配置时，由当前 Canvas Agent 直接创建或更新当前画布的下游产物，并以工具返回结果为准。
- 不得创建、关联、解除关联或切换其它画布，也不得把任务转交给普通 Agent 或协作会话。`
    : ''

  return {
    systemPromptAppend: `## 画布工具
请基于完整用户语义、项目上下文和工具 schema 自主决定是否读取、创建、修改或运行画布，不要按“首页”或“设计”等关键词硬编码。

当任务需要网页原型、图片设计稿、文档或多个可关联产物时，先读取并遵循 \`canvas-production\` Skill。Skill 不可用时按以下最小规则继续：产物类型会改变交付结果且用户未说明时，只询问一次；用户已明确类型时直接执行；明确要求修改项目 HTML、React、组件或其它代码文件时继续普通 Agent。

创建或修改前先用 canvas_get_context 获取权威关联；已有合适画布时直接复用，不要要求用户另建已经存在的画布。没有可用画布且用户已明确选择画布产物时，才用 canvas_manage 创建并关联。需要独立 Canvas Agent 分工时，普通 Agent 自行调用 canvas_create_agent，不要求用户手工创建。已有授权本地图片使用 canvas_import_image 导入为正式采用参考图，不要求用户拖入原生 Canvas。正文只通过 canvas_create_artifact 或 canvas_update_artifact 保存，canvas_apply_changes 只处理结构；有关联来源时提供准确 relation。重建流程必须先验证并建立可执行的新链路，再删除旧节点。WebView 创建成功后即可直接预览，不得为 WebView 调用 canvas_run_nodes；图片仅在用户明确要求立即生成时才调用 canvas_run_nodes。图片运行结果只代表候选已创建或正在生成，必须提示用户进入画布验收，不得描述为已正式替换。

用户只要求核对、检查或评审画布图片时保持只读：先用 canvas_list_nodes 分页枚举同一 revision 的全部图片节点，再用 canvas_inspect_images 每批最多四张读取当前正式采用缩略图。不得只比较提示词或使用当前画布截图后声称已完成全量视觉核对；未明确要求修正时，不更新提示词、不运行节点、不采用候选。

Host 只提供 permissionCeiling 权限上限：plan 仅允许新增 idle 结构且禁止运行、产物创建、覆盖、删除和移动；execute 表示工具可执行，不代表用户已授权任意操作。删除或覆盖必须有用户明确意图，并传入 destructiveIntent=explicit。${canvasAgentPrompt}`,
    piCustomTools: availableTools,
    allowedToolNames: availableTools.map((tool) => tool.name),
    singleApprovalToolNames: ['canvas_run_nodes'],
    allowedToolNamesMode: 'extend',
  }
}
