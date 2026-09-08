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
  CanvasImageArtifactVersion,
  CanvasImageModuleConfig,
  CanvasMutation,
  CanvasMediaModuleSnapshot,
  CanvasMediaTarget,
  CanvasNode,
  CanvasNodeReference,
  CanvasRunWorkflowResult,
  SaveCanvasImageModuleInput,
  CanvasTarget,
  CanvasWorkspaceSnapshot,
  CanvasWorkflowRun,
  DesignJobRecord,
  DesignAsset,
  DesignPoint,
} from '@proma/shared'
import {
  CANVAS_WORKFLOW_MAX_DURATION_EXTENSION_MS,
  CANVAS_WORKFLOW_MAX_MEDIA_RUN_EXTENSION,
  CANVAS_WORKFLOW_RUN_NODE_LIMIT,
  parseCanvasBatchOperationEnvelope,
  parseAdoptCanvasMediaCandidateInput,
  parseAttachCanvasMediaImportedAssetsInput,
  parseCanvasRunWorkflowInput,
  parseCanvasRunWorkflowResult,
  parseSaveCanvasMediaModuleInput,
} from '@proma/shared'
import { Type } from 'typebox'
import type { TSchema } from 'typebox'
import type { AgentRunExtensions } from '../agent-run-extensions'
import { isValidImageBytes } from '../image-content-validation'
import type { CanvasBatchOperationResult } from './canvas-agent-batch-operation'
import type { CanvasAgentConfigStore } from './canvas-agent-config-store'
import type { CanvasAgentExecutionService } from './canvas-agent-execution-service'
import type { CanvasAgentOutputService } from './canvas-agent-output-service'
import type {
  CanvasArtifactCreationResult,
  CanvasArtifactCreationService,
} from './canvas-artifact-creation'
import type { CanvasTextArtifactService } from './canvas-text-artifact-service'
import type { CanvasImageRunService } from './canvas-image-run-service'
import type { CanvasImageCandidateBatchService } from './canvas-image-candidate-batch-service'
import { CANVAS_IMAGE_CANDIDATE_TOOL_NAMES, createCanvasImageCandidateTools } from './canvas-image-candidate-tools'
import type { CanvasWorkflowExecutionService } from './canvas-workflow-execution-service'
import type { CanvasMediaService } from './canvas-media-service'
import type { CanvasToolAccessFacade } from './canvas-tool-access-facade'
import { createCanvasOperationTools, type CanvasOperationToolHandlers } from './canvas-operation-tools'
import { MEDIA_TOOL_NAMES } from '../media/media-tool-provider'
import {
  canvasNodeCapabilityRegistry,
  type CanvasNodeCapability,
} from './canvas-node-capability-registry'

const MAX_READ_NODES = 32
const MAX_READ_RESPONSE_CHARS = 32_768
const MAX_READ_HISTORY_ENTRIES = 32
const DEFAULT_LIST_NODES_LIMIT = 50
const MAX_LIST_NODES_LIMIT = 100
const MAX_INSPECT_IMAGE_NODES = 4
const MAX_INSPECT_IMAGE_BYTES = 512 * 1024
const MAX_INSPECT_BATCH_BYTES = 2 * 1024 * 1024
const MAX_INSPECT_IMAGE_PIXELS = 64_000_000
/** 多图启动和运行跨进程调用使用相同的十五分钟有界窗口。 */
const MAX_IMAGE_RUN_START_MS = 15 * 60_000
/** 父 Agent 单次指令与正式输出摘要的上下文预算。 */
const MAX_AGENT_RUN_INSTRUCTION_LENGTH = 8_192
const MAX_AGENT_RUN_OUTPUT_SUMMARY_BYTES = 4_096
/** 临时 Skill 只接受稳定名称或 slug，禁止路径和空白。 */
const MAX_AGENT_RUN_SKILLS = 16
const STABLE_AGENT_SKILL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/
/** 节点可保存的有界配置诊断；只记录分析原因，不包含凭据或原始服务响应。 */
const MEDIA_PREPARATION_SCHEMA = Type.Union([
  Type.Null(),
  Type.Object({ code: Type.String({ pattern: '^[A-Z][A-Z0-9_]{0,95}$' }),
    message: Type.String({ minLength: 1, maxLength: 2048 }) }, { additionalProperties: false }),
])
const CANVAS_NODE_KINDS: CanvasNode['kind'][] = ['agent', 'image', 'audio', 'video', 'document', 'webview']

/** renderer 手动运行的 Canvas Agent 仅继承 Task 8 前已有的固定能力。 */
const RENDERER_MANUAL_CANVAS_AGENT_TOOL_NAMES = new Set([
  ...CANVAS_IMAGE_CANDIDATE_TOOL_NAMES,
  ...MEDIA_TOOL_NAMES,
  'media_list_sources',
  'media_import_assets',
  'media_import_local_file',
  'media_get_asset_file',
  'canvas_attach_media_assets',
  'canvas_get_context',
  'canvas_list_nodes',
  'canvas_inspect_images',
  'canvas_read',
  'canvas_apply_changes',
  'canvas_import_image',
  'canvas_create_artifact',
  'canvas_create_media',
  'canvas_update_artifact',
  'canvas_update_image_config',
  'canvas_update_media_config',
  'canvas_inspect_media',
  'canvas_adopt_media_candidate',
  'canvas_get_workflow_run',
  'canvas_list_workflow_runs',
  'canvas_resume_workflow',
  'canvas_cancel_workflow',
  'canvas_cancel_media_run',
  'canvas_run_nodes',
  'canvas_get_task', 'canvas_cancel_task', 'canvas_retry_task',
  'canvas_list_versions', 'canvas_read_version', 'canvas_adopt_version',
  'canvas_export_artifact', 'canvas_list_trash', 'canvas_restore_node',
])
/** 父 Agent 编排模式禁止 Canvas Agent 再启动任何付费图片任务。 */
const PARENT_ORCHESTRATED_CANVAS_AGENT_TOOL_NAMES = new Set([
  ...CANVAS_IMAGE_CANDIDATE_TOOL_NAMES,
  ...MEDIA_TOOL_NAMES.filter((name) => !['media_execute_run', 'media_cancel_run', 'media_save_profile'].includes(name)),
  'media_list_sources',
  'media_import_assets',
  'canvas_get_context',
  'canvas_list_nodes',
  'canvas_inspect_images',
  'canvas_read',
  'canvas_apply_changes',
  'canvas_import_image',
  'canvas_create_artifact',
  'canvas_create_media',
  'canvas_update_artifact',
  'canvas_update_image_config',
  'canvas_get_task', 'canvas_list_versions', 'canvas_read_version',
  'canvas_update_media_config',
  'canvas_inspect_media',
  'canvas_adopt_media_candidate',
  'canvas_get_workflow_run',
  'canvas_list_workflow_runs',
])

/** 按 UTF-8 原始字节预算截断文本，并保持完整 Unicode 字符。 */
function truncateUtf8(content: string, maxBytes: number): string {
  /** 已接受的 UTF-8 字节数。 */
  let acceptedBytes = 0
  /** 已接受正文对应的 UTF-16 结束下标。 */
  let acceptedEnd = 0
  for (const character of content) {
    /** 当前完整 Unicode 字符的 UTF-8 字节数。 */
    const characterBytes = Buffer.byteLength(character, 'utf8')
    if (acceptedBytes + characterBytes > maxBytes) break
    acceptedBytes += characterBytes
    acceptedEnd += character.length
  }
  return content.slice(0, acceptedEnd)
}

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
    | 'adopted-asset-mismatch' | 'image-unavailable' | 'image-too-large' | 'version-unavailable'
  /** 显式查看的成功任务版本；缺省时仍表示当前正式图片。 */
  jobId?: string
  /** 请求版本是否同时是当前正式采用版本，不改变采用状态。 */
  adopted?: boolean
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
  capabilities: CanvasNodeCapability[]
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
  /** 先移除可选历史、边和节点配置，最小节点与 revision 摘要始终保留。 */
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
    const imageConfig = entry.artifact?.kind === 'image'
      ? entry.artifact.config as CanvasImageModuleConfig | undefined
      : undefined
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

/** 普通项目 Agent 单轮可用的 Canvas 工具。 */
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
  'canvas_create_media',
  'canvas_update_artifact',
  'canvas_update_image_config',
  'canvas_update_media_config',
  'canvas_inspect_media',
  'canvas_attach_media_run',
  'canvas_cancel_media_run',
  'canvas_adopt_media_candidate',
  'canvas_update_agent_config',
  'canvas_run_agent',
  'canvas_run_workflow',
  'canvas_get_workflow_run',
  'canvas_list_workflow_runs',
  'canvas_resume_workflow',
  'canvas_cancel_workflow',
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
  /** 仅交互式 Renderer 运行绑定保存窗口；后台运行缺省后禁止隐式弹窗。 */
  dialogOwnerWebContentsId?: number
  /** Canvas 内部 Agent 只能访问自身所属画布，不能管理普通 Agent 的画布关联。 */
  canvasAgentTarget?: CanvasAgentTarget
  /** 由统一执行服务注入的可信 Canvas Agent 运行模式，用于第二层能力收缩。 */
  canvasAgentMode?: 'renderer-manual' | 'parent-orchestrated'
  /** 父编排工作流的 Host-only 身份，只在 parent-orchestrated 子运行中透传。 */
  parentWorkflow?: { runId: string; parentSessionId: string }
}

/** Canvas Agent 按固定正向清单选择工具，未来新增能力默认拒绝。 */
export function filterCanvasAgentToolsForMode(
  tools: readonly ToolDefinition[],
  mode: NonNullable<CanvasToolRunContext['canvasAgentMode']>,
): ToolDefinition[] {
  /** 当前可信运行模式允许的固定工具名集合。 */
  const allowedNames = mode === 'parent-orchestrated'
    ? PARENT_ORCHESTRATED_CANVAS_AGENT_TOOL_NAMES
    : RENDERER_MANUAL_CANVAS_AGENT_TOOL_NAMES
  return tools.filter((tool) => allowedNames.has(tool.name))
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
  /** UI 与 Agent 共用的任务、版本、恢复和持久工作流操作。 */
  operations?: CanvasOperationToolHandlers
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
  agentOutputs: Pick<CanvasAgentOutputService, 'read' | 'readAtPointer'>
  agentConfigs: Pick<CanvasAgentConfigStore, 'load' | 'update'>
  agentExecution: Pick<CanvasAgentExecutionService, 'execute'>
  workflowExecution: Pick<CanvasWorkflowExecutionService, 'execute' | 'resume' | 'cancel' | 'get' | 'list' | 'registerCreatedSuccessor'>
    & Partial<Pick<CanvasWorkflowExecutionService, 'recordCreatedSuccessorRegistrationFailure'>>
  readNodeContent?: (target: CanvasTarget, node: CanvasNode) => Promise<string>
  artifacts: Pick<CanvasArtifactCreationService, 'create' | 'createAgent'>
  /** 主进程在调用导入事务前负责解析并验证本地路径。 */
  importImage: (input: CanvasToolImageImportInput) => Promise<CanvasArtifactCreationResult>
  textArtifacts: Pick<CanvasTextArtifactService, 'read' | 'listVersions' | 'update'>
  images: {
    loadConfig: (target: CanvasImageTarget) => Promise<CanvasImageModuleConfig>
    /** 复用图片 Registry，只返回目标模块可由成功任务与现存素材证明的版本。 */
    listVersions: (target: CanvasImageTarget) => Promise<CanvasImageArtifactVersion[]>
    load: (target: CanvasImageTarget) => Promise<{
      config: CanvasImageModuleConfig
      jobs: DesignJobRecord[]
    }>
    save: (input: SaveCanvasImageModuleInput) => Promise<CanvasImageModuleConfig>
    readThumbnail: (projectId: string, assetId: string) => Promise<CanvasInspectionThumbnail>
  }
  batch: { execute: (input: CanvasBatchOperationEnvelope) => Promise<CanvasBatchOperationResult> }
  /** 低层工具直接调用主进程唯一图片运行服务。 */
  imageRuns: Pick<CanvasImageRunService, 'run'>
  /** 候选检查和采用复用既有图片批次事务。 */
  imageCandidates?: Pick<CanvasImageCandidateBatchService, 'load' | 'adopt'>
  /** 音视频节点配置、运行、进度与采用统一委托 CanvasMediaService。 */
  canvasMedia: Pick<CanvasMediaService, 'load' | 'save' | 'run' | 'attachCompletedRun' | 'cancel' | 'adopt'>
    & Partial<Pick<CanvasMediaService, 'attachImportedAssets'>>
  /** 普通与 Canvas Agent 复用同一 Host 媒体能力，缺省时不注册占位工具。 */
  mediaTools?: (context: CanvasToolRunContext) => CanvasToolRun
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

/** 从权威 Canvas 节点解析媒体模块目标，Agent 不能自行提供 mediaModuleId 或 mediaKind。 */
function requireCanvasMediaTarget(
  document: CanvasDocument,
  target: CanvasTarget,
  nodeId: string,
): CanvasMediaTarget {
  const node = document.nodes.find((candidate) => candidate.id === nodeId)
  if (!node) throw new Error('CANVAS_NODE_NOT_FOUND')
  if (node.kind !== 'audio' && node.kind !== 'video') throw new Error('CANVAS_MEDIA_NODE_REQUIRED')
  return { ...target, nodeId: node.id, mediaModuleId: node.mediaModuleId, mediaKind: node.kind }
}

/** 媒体运行 origin 只取可信父运行上下文和权威节点身份。 */
function createCanvasMediaOrigin(context: CanvasToolRunContext, target: CanvasMediaTarget) {
  return {
    canvasMedia: { ...target },
    actor: {
      sessionId: context.sessionId,
      runStartedAt: context.runStartedAt,
      mode: context.canvasAgentMode ?? (context.canvasAgentTarget ? 'renderer-manual' : 'project-agent'),
      ...(context.canvasAgentTarget
        ? { canvasId: context.canvasAgentTarget.canvasId, nodeId: context.canvasAgentTarget.nodeId }
        : {}),
    },
  } as const
}

/** 只返回 Agent 自动化需要的媒体元数据，不创建预览授权或声称已感知内容。 */
function projectCanvasMediaRun(run: CanvasMediaModuleSnapshot['runs'][number]): Record<string, unknown> {
  return {
    id: run.id,
    revision: run.revision,
    phase: run.phase,
    sourceRef: run.sourceRef,
    profileId: run.profileId,
    profileRevision: run.profileRevision,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    outputs: run.outputs,
    progress: run.progress,
    errorCode: typeof run.error === 'string' && /^[A-Z][A-Z0-9_]{0,119}$/.test(run.error)
      ? run.error
      : null,
  }
}

/** 只返回 Agent 自动化需要的模块元数据，不创建预览授权或声称已感知内容。 */
function projectCanvasMediaSnapshot(snapshot: CanvasMediaModuleSnapshot): Record<string, unknown> {
  return {
    target: snapshot.target,
    config: snapshot.config,
    candidates: snapshot.candidates,
    runs: snapshot.runs.map(projectCanvasMediaRun),
    metadataOnly: true,
  }
}

/** 直接依赖的上下游不能在同一手动批次中同时重生成，避免下游固化旧输入。 */
function assertNoSelectedUpstreamRegenerating(document: CanvasDocument, selectedNodeIds: Set<string>): void {
  if (document.edges.some((edge) => edge.relation !== 'association'
    && selectedNodeIds.has(edge.sourceNodeId)
    && selectedNodeIds.has(edge.targetNodeId))) {
    throw new Error('SELECTED_UPSTREAM_REGENERATING')
  }
}

/** 重建单节点临时指令并同时执行非空与 UTF-8 字节预算校验。 */
function requireAgentRunInstruction(value: string): string {
  if (value.trim().length === 0 || Buffer.byteLength(value, 'utf8') > MAX_AGENT_RUN_INSTRUCTION_LENGTH) {
    throw new Error('CANVAS_AGENT_RUN_INPUT_INVALID')
  }
  return value
}

/** 重建临时 Skill 名称，拒绝重复、路径、空白和超量输入。 */
function requireAgentRunSkillNames(value: string[] | undefined): string[] | undefined {
  if (value === undefined) return undefined
  if (value.length > MAX_AGENT_RUN_SKILLS) throw new Error('CANVAS_AGENT_RUN_INPUT_INVALID')
  const skillNames: string[] = []
  const seen = new Set<string>()
  for (const skillName of value) {
    if (!STABLE_AGENT_SKILL_NAME_PATTERN.test(skillName) || seen.has(skillName)) {
      throw new Error('CANVAS_AGENT_RUN_INPUT_INVALID')
    }
    seen.add(skillName)
    skillNames.push(skillName)
  }
  return skillNames
}

/** 为普通项目 Agent 创建不持久化的单轮 Canvas 工具。 */
export function createCanvasToolRun(
  dependencies: CanvasToolProviderDependencies,
  context: CanvasToolRunContext,
): CanvasToolRun {
  /** 本轮访问上下文始终 fresh-read binding，不缓存扩大后的权限。 */
  const getContext = (): AgentCanvasBinding | null => dependencies.access.getBinding(context)

  /** 只用创建事务返回的身份登记后继，后置失败仍向模型返回已创建节点。 */
  const registerCreatedSuccessor = async (
    created: Pick<CanvasArtifactCreationResult, 'canvasId' | 'nodeId' | 'sourceToolCallId'>,
  ): Promise<Record<string, unknown>> => {
    if (context.canvasAgentMode !== 'parent-orchestrated' || !context.parentWorkflow) return {}
    try {
      return { workflowRegistration: await dependencies.workflowExecution.registerCreatedSuccessor(context,
        { projectId: context.projectId, canvasId: created.canvasId, nodeId: created.nodeId,
          sourceToolCallId: created.sourceToolCallId }) }
    } catch {
      try {
        const blocked = await dependencies.workflowExecution.recordCreatedSuccessorRegistrationFailure?.(context, {
          projectId: context.projectId, canvasId: created.canvasId, nodeId: created.nodeId,
          sourceToolCallId: created.sourceToolCallId,
        })
        if (blocked) return { workflowRegistration: blocked }
      } catch { /* 持久化异常继续返回脱敏失败；节点创建事实不能被反转。 */ }
      return { workflowRegistration: { status: 'blocked', workflowRunId: context.parentWorkflow.runId,
        reasonCode: 'CANVAS_WORKFLOW_DYNAMIC_SUCCESSOR_REGISTRATION_FAILED' } }
    }
  }

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
          Type.Literal('agent'), Type.Literal('image'), Type.Literal('audio'), Type.Literal('video'),
          Type.Literal('document'), Type.Literal('webview'),
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
      description: '读取受限缩略图供视觉核对。默认检查正式采用图片；检查候选或历史图片时，先从 canvas_read 的 jobHistory 取得成功任务 id，再通过 versions 指定 nodeId 与 jobId。不会采用、修改或生成图片。',
      parameters: Type.Object({
        canvasId: Type.String({ minLength: 1, maxLength: 128 }),
        nodeIds: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), {
          minItems: 1,
          maxItems: MAX_INSPECT_IMAGE_NODES,
        }),
        expectedRevision: Type.Integer({ minimum: 0 }),
        versions: Type.Optional(Type.Array(Type.Object({
          nodeId: Type.String({ minLength: 1, maxLength: 128 }),
          jobId: Type.String({ minLength: 1, maxLength: 128 }),
        }), { maxItems: MAX_INSPECT_IMAGE_NODES })),
      }),
      execute: async (_toolCallId, params, signal) => {
        signal?.throwIfAborted()
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
        /** 一个节点最多指定一个版本，选择范围不得越过本次节点集合。 */
        const versionByNode = new Map<string, string>()
        if ((params.versions?.length ?? 0) > MAX_INSPECT_IMAGE_NODES) {
          throw new Error('CANVAS_IMAGE_VERSION_SELECTION_INVALID')
        }
        for (const version of params.versions ?? []) {
          if (!version.jobId || !nodeIds.includes(version.nodeId) || versionByNode.has(version.nodeId)) {
            throw new Error('CANVAS_IMAGE_VERSION_SELECTION_INVALID')
          }
          versionByNode.set(version.nodeId, version.jobId)
        }
        const content: Array<TextContent | ImageContent> = []
        const inspections: CanvasImageInspectionSummary[] = []
        let totalImageBytes = 0
        /** 公开失败只描述节点级状态，底层素材身份和磁盘错误不得进入工具结果。 */
        const appendStatus = (summary: CanvasImageInspectionSummary): void => {
          /** 即使配置或媒体读取失败，也保留调用方显式选择的任务版本。 */
          const jobId = versionByNode.get(summary.nodeId)
          const inspection = { ...summary, ...(jobId ? { jobId } : {}) }
          inspections.push(inspection)
          content.push({ type: 'text', text: JSON.stringify(inspection) })
        }
        for (const nodeId of nodeIds) {
          signal?.throwIfAborted()
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
          /** 显式版本由 Host 按完整节点身份解析，模型提供的任务 ID 不是媒体授权。 */
          const jobId = versionByNode.get(node.id)
          let assetId = node.adoptedAssetId
          if (jobId) {
            try {
              const versions = await dependencies.images.listVersions({
                ...target, nodeId: node.id, imageModuleId: node.imageModuleId,
              })
              assetId = versions.find((version) => version.jobId === jobId)?.assetId
            } catch {
              appendStatus({ nodeId, title: node.title, status: 'image-unavailable', jobId })
              continue
            }
            if (!assetId) {
              appendStatus({ nodeId, title: node.title, status: 'version-unavailable', jobId })
              continue
            }
          } else if (!node.adoptedAssetId && !config.adoptedAssetId) {
            appendStatus({ nodeId, title: node.title, status: 'missing-adopted-asset' })
            continue
          } else if (!node.adoptedAssetId || node.adoptedAssetId !== config.adoptedAssetId) {
            appendStatus({ nodeId, title: node.title, status: 'adopted-asset-mismatch' })
            continue
          }
          if (!assetId) throw new Error('CANVAS_IMAGE_VERSION_SELECTION_INVALID')
          signal?.throwIfAborted()
          dependencies.access.authorizeRead(context)
          dependencies.access.requireLinkedCanvas(context, params.canvasId)
          let thumbnail: CanvasInspectionThumbnail
          try {
            thumbnail = await dependencies.images.readThumbnail(context.projectId, assetId)
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
          const summary: CanvasImageInspectionSummary = {
            nodeId, title: node.title, status: 'ready',
            ...(jobId ? { jobId, adopted: assetId === node.adoptedAssetId && assetId === config.adoptedAssetId } : {}),
          }
          appendStatus(summary)
          content.push({
            type: 'image',
            data: prepared.thumbnail.bytes.toString('base64'),
            mimeType: prepared.thumbnail.mediaType,
          })
        }
        /** 异步媒体读取期间的取消、撤权和图变更不得返回旧图片事实。 */
        signal?.throwIfAborted()
        dependencies.access.authorizeRead(context)
        dependencies.access.requireLinkedCanvas(context, params.canvasId)
        if (dependencies.documents.load(target).document.revision !== params.expectedRevision) {
          throw new Error('CANVAS_REVISION_CONFLICT')
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
      description: '按 ID 权威读取当前会话已关联画布的有限节点、正文与必要邻接。Agent 节点另返回 artifact.configRevision 和长期 config；修改配置时使用顶层 revision 与 configRevision，configOmitted 表示需缩小读取范围。',
      parameters: Type.Object({
        canvasId: Type.String({ minLength: 1, maxLength: 128 }),
        nodeIds: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { minItems: 1, maxItems: MAX_READ_NODES }),
        includeNeighbors: Type.Optional(Type.Boolean()),
      }),
      execute: async (_toolCallId, params) => {
        dependencies.access.authorizeRead(context)
        dependencies.access.requireLinkedCanvas(context, params.canvasId)
        const target = { projectId: context.projectId, canvasId: params.canvasId }
        const snapshot = dependencies.documents.load(target)
        const document = snapshot.document
        /** 节点问题是本轮权威运行态，不进入 CanvasNode 或持久化文档。 */
        const unavailableNodeIds = new Set(snapshot.nodeIssues.map((issue) => issue.nodeId))
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
          if (node.kind === 'agent') {
            /** Agent 正文只从节点正式 outputPointer 经权威服务校验后读取。 */
            fullContent = await dependencies.agentOutputs.read({ ...target, nodeId: node.id })
            /** 配置读取复用受管 Store 的身份验证；只返回可编辑字段及独立 CAS 基线。 */
            const config = await dependencies.agentConfigs.load({ ...target, nodeId: node.id })
            artifact = {
              nodeId: node.id,
              kind: 'agent',
              configRevision: config.revision,
              config: {
                instruction: config.instruction,
                skillNames: [...config.skillNames],
                channelId: config.channelId,
                modelId: config.modelId,
              },
            }
          } else if (node.kind === 'document' || node.kind === 'webview') {
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
          } else if (node.kind === 'audio' || node.kind === 'video') {
            /** 音视频只返回结构化运行元数据；工具结果不包含可播放 URL 或本地路径。 */
            const media = await dependencies.canvasMedia.load({
              ...target, nodeId: node.id, mediaModuleId: node.mediaModuleId, mediaKind: node.kind,
            })
            artifact = projectCanvasMediaSnapshot(media)
          } else {
            fullContent = dependencies.readNodeContent ? await dependencies.readNodeContent(target, node) : ''
          }
          fullContents.push(fullContent)
          /** 能力只用于发现；各工具仍在执行时独立完成 Host 身份与 revision 校验。 */
          const capabilities = canvasNodeCapabilityRegistry.list(node, {
            availability: unavailableNodeIds.has(node.id) ? 'unavailable' : 'available',
            availableToolNames,
            permissionCeiling: context.permissionCeiling,
          })
          entries.push({ node, capabilities, content: '', contentLength: fullContent.length, ...(artifact ? { artifact } : {}) })
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
        operations: Type.Array(Type.Unknown(), { minItems: 1, maxItems: 128 }),
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
            /** 媒体候选范围由用户导航选择，普通生成工具不能扩大或改写该范围。 */
            if (operations.some((operation) => operation.type === 'set-media-model-scope')) throw new Error('CANVAS_MEDIA_MODEL_SCOPE_USER_MANAGED')
            if (operations.some((operation) => operation.type === 'set-comfyui-connection')) throw new Error('CANVAS_COMFYUI_CONNECTION_USER_MANAGED')
            const document = dependencies.documents.load(target).document
            if (context.canvasAgentMode === 'parent-orchestrated' && context.parentWorkflow
              && operations.some((operation) => operation.type === 'upsert-nodes'
                && operation.nodes.some((node) => !document.nodes.some((existing) => existing.id === node.id)))) {
              throw new Error('CANVAS_WORKFLOW_SUCCESSOR_USE_CREATE_TOOL')
            }
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
            ...await registerCreatedSuccessor(result),
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
            ...await registerCreatedSuccessor(result),
          })
        })
      },
    }),
    defineCanvasTool({
      name: 'canvas_create_media', label: '创建媒体节点',
      description: '在已关联画布中原子创建音频或视频节点的空媒体模块；创建后用 canvas_update_media_config 保存 typed 输入输出，可选择已有预设或保留 profile=null 供工作流草稿试运行。',
      parameters: Type.Object({
        canvasId: Type.String({ minLength: 1, maxLength: 128 }),
        baseRevision: Type.Integer({ minimum: 0 }),
        mediaKind: Type.Union([Type.Literal('audio'), Type.Literal('video')]),
        title: Type.String({ minLength: 1, maxLength: 120 }),
        position: Type.Optional(Type.Object({ x: Type.Number(), y: Type.Number() })),
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
            artifactType: params.mediaKind,
            title: params.title,
            content: '',
            ...(params.position ? { position: params.position } : {}),
            ...(params.sourceNodeId ? { sourceNodeId: params.sourceNodeId } : {}),
            ...(params.relation ? { relation: params.relation as CanvasEdgeRelation } : {}),
            source: { sessionId: context.sessionId, runStartedAt: context.runStartedAt, toolCallId },
          })
          return toolResult({
            canvasId: result.canvasId,
            nodeId: result.nodeId,
            revision: result.revision,
            mediaKind: result.artifactType,
            configRevision: 0,
            requiresConfiguration: true,
            ...await registerCreatedSuccessor(result),
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
              ...(snapshot.config.mediaWorkflow ? { mediaWorkflow: snapshot.config.mediaWorkflow } : {}),
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
      name: 'canvas_update_image_config', label: '更新生图节点配置',
      description: '局部更新已有生图节点的提示词、模型、工作流、画幅或上下文；工作流输入可先保存已知值，运行前必须补齐。分析失败用 preparation 保存错误码、节点/字段和中文原因，修复后传 null 清除。只保存配置，不会自动生图。',
      parameters: Type.Object({
        canvasId: Type.String({ minLength: 1, maxLength: 128 }),
        nodeId: Type.String({ minLength: 1, maxLength: 128 }),
        baseRevision: Type.Integer({ minimum: 0 }),
        expectedConfigRevision: Type.Integer({ minimum: 0 }),
        preparation: Type.Optional(MEDIA_PREPARATION_SCHEMA),
        prompt: Type.Optional(Type.String({ maxLength: 256 * 1024 })),
        selectedModelProfileId: Type.Optional(Type.Union([
          Type.String({ minLength: 1, maxLength: 128 }),
          Type.Null(),
        ])),
        mediaWorkflow: Type.Optional(Type.Union([
          Type.Object({
            workflowId: Type.String({ minLength: 1, maxLength: 128 }),
            workflowRevision: Type.Integer({ minimum: 1 }),
            connectionId: Type.String({ minLength: 1, maxLength: 128 }),
            inputs: Type.Record(
              Type.String({ pattern: '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$' }),
              Type.Union([
                Type.Object({ kind: Type.Literal('scalar'), value: Type.Union([
                  Type.String(), Type.Number(), Type.Boolean(),
                ]) }),
                Type.Object({ kind: Type.Literal('asset'), asset: Type.Object({
                  assetId: Type.String({ minLength: 1, maxLength: 128 }),
                  revision: Type.Integer({ minimum: 1 }),
                  hash: Type.String({ pattern: '^[a-f0-9]{64}$' }),
                  mediaKind: Type.Union([Type.Literal('image'), Type.Literal('audio'), Type.Literal('video')]),
                }) }),
              ]),
              { maxProperties: 128 },
            ),
          }),
          Type.Null(),
        ])),
        aspectRatio: Type.Optional(Type.Union([
          Type.Literal('1:1'), Type.Literal('16:9'), Type.Literal('4:3'),
          Type.Literal('9:16'), Type.Literal('3:4'),
        ])),
        imageSize: Type.Optional(Type.Union([
          Type.Literal('auto'), Type.Literal('1K'), Type.Literal('2K'), Type.Literal('4K'),
        ])),
        contextMode: Type.Optional(Type.Union([
          Type.Literal('auto'), Type.Literal('project'), Type.Literal('none'),
        ])),
      }),
      execute: async (_toolCallId, params) => {
        dependencies.access.authorizeRead(context)
        if (context.permissionCeiling === 'plan') throw new Error('CANVAS_EXECUTE_INTENT_REQUIRED')
        return dependencies.access.runWrite(context, async () => {
          dependencies.access.requireLinkedCanvas(context, params.canvasId)
          if (params.prompt === undefined
            && params.selectedModelProfileId === undefined
            && params.mediaWorkflow === undefined
            && params.aspectRatio === undefined
            && params.imageSize === undefined
            && params.contextMode === undefined
            && params.preparation === undefined) {
            throw new Error('CANVAS_IMAGE_CONFIG_PATCH_REQUIRED')
          }
          /** fresh 图用于验证节点类别并解析可信图片模块身份。 */
          const target = { projectId: context.projectId, canvasId: params.canvasId }
          const document = dependencies.documents.load(target).document
          if (document.revision !== params.baseRevision) throw new Error('CANVAS_ARTIFACT_REVISION_CONFLICT')
          /** 当前权威图片节点；Agent 不直接提供 imageModuleId。 */
          const node = document.nodes.find((candidate) => candidate.id === params.nodeId)
          if (!node) throw new Error('CANVAS_NODE_NOT_FOUND')
          if (node.kind !== 'image') throw new Error('CANVAS_IMAGE_NODE_REQUIRED')
          /** 当前配置为未提供字段提供基线，并由 config revision 防止并发覆盖。 */
          const imageTarget = { ...target, nodeId: node.id, imageModuleId: node.imageModuleId }
          const currentConfig = await dependencies.images.loadConfig(imageTarget)
          if (currentConfig.revision !== params.expectedConfigRevision) {
            throw new Error('CANVAS_ARTIFACT_REVISION_CONFLICT')
          }
          if (params.mediaWorkflow && params.selectedModelProfileId) {
            throw new Error('CANVAS_IMAGE_MODEL_SOURCE_CONFLICT')
          }
          /** 显式选择 workflow 或 profile 时清除另一执行来源；其它局部更新保留现状。 */
          const mediaWorkflow = params.mediaWorkflow === undefined
            ? params.selectedModelProfileId ? undefined : currentConfig.mediaWorkflow
            : params.mediaWorkflow ?? undefined
          /** workflow 选择不允许遗留旧 profile ID。 */
          const selectedModelProfileId = params.mediaWorkflow
            ? null
            : params.selectedModelProfileId === undefined
              ? currentConfig.selectedModelProfileId
              : params.selectedModelProfileId
          const config = await dependencies.images.save({
            ...imageTarget,
            expectedConfigRevision: params.expectedConfigRevision,
            prompt: params.prompt ?? currentConfig.prompt,
            selectedModelProfileId,
            ...(mediaWorkflow ? { mediaWorkflow } : {}),
            preparation: params.preparation === undefined ? currentConfig.preparation ?? null : params.preparation,
            aspectRatio: params.aspectRatio ?? currentConfig.aspectRatio,
            imageSize: params.imageSize ?? currentConfig.imageSize,
            contextMode: params.contextMode ?? currentConfig.contextMode,
          })
          return toolResult({
            canvasId: params.canvasId,
            nodeId: node.id,
            kind: 'image',
            revision: document.revision,
            configRevision: config.revision,
            requiresRun: true,
          })
        })
      },
    }),
    defineCanvasTool({
      name: 'canvas_update_media_config', label: '更新媒体节点配置',
      description: '以配置 revision 保存音视频卡片；workflow 固定公共或当前项目的工作流版本和连接，profile 仅兼容旧预设且两者互斥。先用 media_list_workflows/media_inspect_workflow 读取真实输入输出，inputs 可先只填已知值，缺失项留待配置，运行前必须补齐。省略字段保留现状；更换工作流时同时提供新的 inputs/outputs。分析失败用 preparation 保存错误码、节点/字段和中文原因，修复后传 null 清除。保存不提交生成。',
      parameters: Type.Object({
        canvasId: Type.String({ minLength: 1, maxLength: 128 }),
        nodeId: Type.String({ minLength: 1, maxLength: 128 }),
        baseRevision: Type.Integer({ minimum: 0 }),
        expectedConfigRevision: Type.Integer({ minimum: 0 }),
        preparation: Type.Optional(MEDIA_PREPARATION_SCHEMA),
        profile: Type.Optional(Type.Union([Type.Null(), Type.Object({
          profileId: Type.String({ minLength: 1, maxLength: 128 }),
          profileRevision: Type.Integer({ minimum: 1 }),
        })])),
        workflow: Type.Optional(Type.Union([Type.Null(), Type.Object({
          workflowId: Type.String({ minLength: 1, maxLength: 128 }), workflowRevision: Type.Integer({ minimum: 1 }),
          connectionId: Type.String({ minLength: 1, maxLength: 128 }),
        })])),
        inputs: Type.Optional(Type.Array(Type.Unknown(), { maxItems: 128 })),
        outputs: Type.Optional(Type.Array(Type.Unknown(), { maxItems: 128 })),
      }),
      execute: async (_toolCallId, params) => {
        dependencies.access.authorizeRead(context)
        if (context.permissionCeiling === 'plan') throw new Error('CANVAS_EXECUTE_INTENT_REQUIRED')
        return dependencies.access.runWrite(context, async () => {
          dependencies.access.requireLinkedCanvas(context, params.canvasId)
          const canvasTarget = { projectId: context.projectId, canvasId: params.canvasId }
          const document = dependencies.documents.load(canvasTarget).document
          if (document.revision !== params.baseRevision) throw new Error('CANVAS_REVISION_CONFLICT')
          const mediaTarget = requireCanvasMediaTarget(document, canvasTarget, params.nodeId)
          /** 在相同配置 revision 上合并局部诊断或草稿，避免覆盖已填输入与正式输出。 */
          const current = (await dependencies.canvasMedia.load(mediaTarget)).config
          if (current.revision !== params.expectedConfigRevision) throw new Error('CANVAS_MEDIA_CONFIG_CONFLICT')
          if (params.profile && params.workflow) throw new Error('CANVAS_MEDIA_SOURCE_CONFLICT')
          if (params.profile === undefined && params.workflow === undefined && params.inputs === undefined
            && params.outputs === undefined && params.preparation === undefined) throw new Error('CANVAS_MEDIA_CONFIG_PATCH_REQUIRED')
          const input = parseSaveCanvasMediaModuleInput({
            ...mediaTarget,
            expectedConfigRevision: params.expectedConfigRevision,
            profile: params.workflow ? null : params.profile === undefined ? current.profile : params.profile,
            workflow: params.profile ? null : params.workflow === undefined ? current.workflow ?? null : params.workflow,
            preparation: params.preparation === undefined ? current.preparation ?? null : params.preparation,
            inputs: params.inputs ?? current.inputs,
            outputs: params.outputs ?? current.outputs,
          })
          const config = await dependencies.canvasMedia.save(input)
          return toolResult({
            canvasId: params.canvasId,
            nodeId: params.nodeId,
            mediaKind: mediaTarget.mediaKind,
            revision: document.revision,
            configRevision: config.revision,
            requiresRun: true,
          })
        })
      },
    }),
    defineCanvasTool({
      name: 'canvas_inspect_media', label: '检查媒体节点',
      description: '读取音频或视频节点的配置、候选、运行阶段和节点进度元数据；不播放、不解码，也不表示 Agent 已看过或听过内容。',
      parameters: Type.Object({
        canvasId: Type.String({ minLength: 1, maxLength: 128 }),
        nodeId: Type.String({ minLength: 1, maxLength: 128 }),
      }),
      execute: async (_toolCallId, params) => {
        dependencies.access.authorizeRead(context)
        dependencies.access.requireLinkedCanvas(context, params.canvasId)
        const canvasTarget = { projectId: context.projectId, canvasId: params.canvasId }
        const document = dependencies.documents.load(canvasTarget).document
        const mediaTarget = requireCanvasMediaTarget(document, canvasTarget, params.nodeId)
        return toolResult({
          canvasId: params.canvasId,
          revision: document.revision,
          ...projectCanvasMediaSnapshot(await dependencies.canvasMedia.load(mediaTarget)),
        })
      },
    }),
    defineCanvasTool({
      name: 'canvas_attach_media_run', label: '挂接已有媒体运行',
      description: '把当前普通 Agent 已成功的独立媒体运行显式登记为既有音频或视频节点候选；不会执行、取消或自动采用该运行。',
      parameters: Type.Object({
        canvasId: Type.String({ minLength: 1, maxLength: 128 }),
        nodeId: Type.String({ minLength: 1, maxLength: 128 }),
        expectedConfigRevision: Type.Integer({ minimum: 0 }),
        runId: Type.String({ minLength: 1, maxLength: 128 }),
      }),
      execute: async (_toolCallId, params) => {
        dependencies.access.authorizeRead(context)
        if (context.permissionCeiling === 'plan') throw new Error('CANVAS_EXECUTE_INTENT_REQUIRED')
        if (context.canvasAgentMode) throw new Error('CANVAS_MEDIA_ATTACH_PROJECT_AGENT_REQUIRED')
        return dependencies.access.runWrite(context, async () => {
          dependencies.access.requireLinkedCanvas(context, params.canvasId)
          const canvasTarget = { projectId: context.projectId, canvasId: params.canvasId }
          const document = dependencies.documents.load(canvasTarget).document
          const mediaTarget = requireCanvasMediaTarget(document, canvasTarget, params.nodeId)
          const candidate = await dependencies.canvasMedia.attachCompletedRun({
            ...mediaTarget,
            expectedConfigRevision: params.expectedConfigRevision,
            runId: params.runId,
          }, {
            sessionId: context.sessionId,
            runStartedAt: context.runStartedAt,
            mode: 'project-agent',
          })
          return toolResult({
            canvasId: params.canvasId,
            nodeId: params.nodeId,
            mediaKind: mediaTarget.mediaKind,
            configRevision: candidate.sourceConfigRevision,
            candidateId: candidate.id,
            runId: candidate.runId,
            outputs: candidate.outputs.map((output) => ({
              key: output.key,
              mediaKind: output.mediaKind,
              role: output.role,
              order: output.order,
            })),
            adopted: false,
          })
        })
      },
    }),
    defineCanvasTool({
      name: 'canvas_cancel_media_run', label: '取消媒体节点运行',
      description: '取消确切音频或视频节点拥有的运行；必须显式声明取消意图。',
      parameters: Type.Object({
        canvasId: Type.String({ minLength: 1, maxLength: 128 }),
        nodeId: Type.String({ minLength: 1, maxLength: 128 }),
        runId: Type.String({ minLength: 1, maxLength: 128 }),
        cancelIntent: Type.Literal('explicit'),
      }),
      execute: async (_toolCallId, params) => {
        dependencies.access.authorizeRead(context)
        if (context.permissionCeiling === 'plan' || context.canvasAgentMode === 'parent-orchestrated') {
          throw new Error('CANVAS_RUN_REQUIRES_EXPLICIT_EXECUTE')
        }
        return dependencies.access.runWrite(context, async () => {
          dependencies.access.requireLinkedCanvas(context, params.canvasId)
          const canvasTarget = { projectId: context.projectId, canvasId: params.canvasId }
          const document = dependencies.documents.load(canvasTarget).document
          const mediaTarget = requireCanvasMediaTarget(document, canvasTarget, params.nodeId)
          const run = await dependencies.canvasMedia.cancel(mediaTarget, params.runId)
          return toolResult({ canvasId: params.canvasId, nodeId: params.nodeId, run: projectCanvasMediaRun(run) })
        })
      },
    }),
    defineCanvasTool({
      name: 'canvas_adopt_media_candidate', label: '采用媒体候选',
      description: '按输出 key 原子采用指定媒体候选；同 bundle 输出必须一次完整选择，采用后持久工作流可继续推进。',
      parameters: Type.Object({
        canvasId: Type.String({ minLength: 1, maxLength: 128 }),
        nodeId: Type.String({ minLength: 1, maxLength: 128 }),
        expectedConfigRevision: Type.Integer({ minimum: 0 }),
        candidateId: Type.String({ minLength: 1, maxLength: 128 }),
        selectedKeys: Type.Array(Type.String({ minLength: 1, maxLength: 256 }), { minItems: 1, maxItems: 128 }),
      }),
      execute: async (_toolCallId, params) => {
        dependencies.access.authorizeRead(context)
        if (context.permissionCeiling === 'plan') throw new Error('CANVAS_EXECUTE_INTENT_REQUIRED')
        return dependencies.access.runWrite(context, async () => {
          dependencies.access.requireLinkedCanvas(context, params.canvasId)
          const canvasTarget = { projectId: context.projectId, canvasId: params.canvasId }
          const document = dependencies.documents.load(canvasTarget).document
          const mediaTarget = requireCanvasMediaTarget(document, canvasTarget, params.nodeId)
          const input = parseAdoptCanvasMediaCandidateInput({
            ...mediaTarget,
            expectedConfigRevision: params.expectedConfigRevision,
            candidateId: params.candidateId,
            selectedKeys: params.selectedKeys,
          })
          const config = await dependencies.canvasMedia.adopt(input)
          return toolResult({
            canvasId: params.canvasId,
            nodeId: params.nodeId,
            mediaKind: mediaTarget.mediaKind,
            configRevision: config.revision,
            adoptedOutputKeys: config.adoptedOutputs.map((output) => output.key),
          })
        })
      },
    }),
    defineCanvasTool({
      name: 'canvas_update_agent_config', label: '更新 Canvas Agent 配置',
      description: '局部更新已有 Canvas Agent 的长期职责、Skills 或模型选择；不会运行模型、下游节点或图片任务。',
      parameters: Type.Object({
        canvasId: Type.String({ minLength: 1, maxLength: 128 }),
        nodeId: Type.String({ minLength: 1, maxLength: 128 }),
        expectedGraphRevision: Type.Integer({ minimum: 0 }),
        expectedConfigRevision: Type.Integer({ minimum: 0 }),
        patch: Type.Object({
          instruction: Type.Optional(Type.String({ maxLength: MAX_AGENT_RUN_INSTRUCTION_LENGTH })),
          skillNames: Type.Optional(Type.Array(Type.String({ pattern: STABLE_AGENT_SKILL_NAME_PATTERN.source }), {
            maxItems: MAX_AGENT_RUN_SKILLS,
          })),
          channelId: Type.Optional(Type.Union([Type.String({ minLength: 1, maxLength: 256 }), Type.Null()])),
          modelId: Type.Optional(Type.Union([Type.String({ minLength: 1, maxLength: 256 }), Type.Null()])),
        }, { additionalProperties: false }),
      }, { additionalProperties: false }),
      execute: async (_toolCallId, params) => {
        dependencies.access.authorizeRead(context)
        if (context.permissionCeiling === 'plan') throw new Error('CANVAS_EXECUTE_INTENT_REQUIRED')
        return dependencies.access.runWrite(context, async () => {
          /** 排队进入写临界区后再次读取关联，避免先完成的 unlink 撤权被旧快照绕过。 */
          dependencies.access.requireLinkedCanvas(context, params.canvasId)
          const config = await dependencies.agentConfigs.update({
            projectId: context.projectId,
            canvasId: params.canvasId,
            nodeId: params.nodeId,
            expectedGraphRevision: params.expectedGraphRevision,
            expectedConfigRevision: params.expectedConfigRevision,
            patch: {
              ...(params.patch.instruction !== undefined ? { instruction: params.patch.instruction } : {}),
              ...(params.patch.skillNames !== undefined ? { skillNames: [...params.patch.skillNames] } : {}),
              ...(params.patch.channelId !== undefined ? { channelId: params.patch.channelId } : {}),
              ...(params.patch.modelId !== undefined ? { modelId: params.patch.modelId } : {}),
            },
          }, () => {
            /** serializer 等待期间可能发生解绑，最终校验必须与配置写共享临界区。 */
            dependencies.access.requireLinkedCanvas(context, params.canvasId)
          })
          return toolResult({
            canvasId: config.canvasId,
            nodeId: config.nodeId,
            graphRevision: params.expectedGraphRevision,
            configRevision: config.revision,
            instruction: config.instruction,
            skillNames: config.skillNames,
            channelId: config.channelId,
            modelId: config.modelId,
          })
        })
      },
    }),
    defineCanvasTool({
      name: 'canvas_run_agent', label: '运行 Canvas Agent',
      description: '显式运行单个 Canvas Agent 并等待终态；不会自动运行下游节点或启动图片任务。',
      parameters: Type.Object({
        canvasId: Type.String({ minLength: 1, maxLength: 128 }),
        nodeId: Type.String({ minLength: 1, maxLength: 128 }),
        expectedRevision: Type.Integer({ minimum: 0 }),
        instruction: Type.String({ minLength: 1, maxLength: MAX_AGENT_RUN_INSTRUCTION_LENGTH }),
        skillNames: Type.Optional(Type.Array(Type.String({ pattern: STABLE_AGENT_SKILL_NAME_PATTERN.source }), {
          maxItems: MAX_AGENT_RUN_SKILLS,
        })),
      }, { additionalProperties: false }),
      execute: async (toolCallId, params, signal) => {
        dependencies.access.authorizeRead(context)
        if (context.permissionCeiling === 'plan') throw new Error('CANVAS_RUN_REQUIRES_EXPLICIT_EXECUTE')
        /** 当前关联和图 revision 均在显式执行时 fresh-read，避免启动已换绑节点。 */
        dependencies.access.requireLinkedCanvas(context, params.canvasId)
        const target = { projectId: context.projectId, canvasId: params.canvasId }
        const document = dependencies.documents.load(target).document
        if (document.revision !== params.expectedRevision) throw new Error('CANVAS_REVISION_CONFLICT')
        const node = document.nodes.find((candidate) => candidate.id === params.nodeId)
        if (!node) throw new Error('CANVAS_NODE_NOT_FOUND')
        if (node.kind !== 'agent') throw new Error('CANVAS_AGENT_NODE_REQUIRED')
        const agentTarget = { ...target, nodeId: node.id }
        const instruction = requireAgentRunInstruction(params.instruction)
        const skillNames = requireAgentRunSkillNames(params.skillNames)
        /** custom tool 的取消信号直接传给统一执行服务，不经过 Renderer IPC 或递归 Pi 工具。 */
        const result = await dependencies.agentExecution.execute({
          mode: 'parent-orchestrated',
          target: agentTarget,
          parentSessionId: context.sessionId,
          expectedGraphRevision: params.expectedRevision,
          instruction,
          ...(skillNames ? { skillNames } : {}),
          userMessageUuid: toolCallId,
          startedAt: context.runStartedAt,
          signal,
        })
        if (result.status !== 'completed') {
          return toolResult({
            nodeId: node.id,
            status: result.status,
            downstreamNodeIds: [],
            outputSummary: '',
          })
        }
        if (!result.output
          || result.output.target.projectId !== agentTarget.projectId
          || result.output.target.canvasId !== agentTarget.canvasId
          || result.output.target.nodeId !== agentTarget.nodeId) {
          throw new Error('CANVAS_AGENT_OUTPUT_INVALID')
        }
        /** 正式 pointer 对应的权威正文只用于生成有界摘要，不回查任意末条消息。 */
        const output = await dependencies.agentOutputs.readAtPointer(agentTarget, result.output.pointer)
        return toolResult({
          nodeId: node.id,
          status: result.status,
          outputPointer: result.output.pointer,
          downstreamNodeIds: result.output.downstreamNodeIds,
          outputSummary: truncateUtf8(output, MAX_AGENT_RUN_OUTPUT_SUMMARY_BYTES),
        })
      },
    }),
    defineCanvasTool({
      name: 'canvas_run_workflow', label: '运行 Canvas 工作流',
      description: '从指定 Agent 起点运行一次 bound 可达下游；图片严格受本次上限约束并停在候选验收状态。',
      parameters: Type.Object({
        canvasId: Type.String({ minLength: 1, maxLength: 128 }),
        expectedRevision: Type.Integer({ minimum: 0 }),
        startNodeIds: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { minItems: 1, maxItems: 8 }),
        goal: Type.String({ minLength: 1, maxLength: 4_000 }),
        maxImageRuns: Type.Integer({ minimum: 0, maximum: 16 }),
      }, { additionalProperties: false }),
      execute: async (toolCallId, params, signal) => {
        dependencies.access.authorizeRead(context)
        if (context.permissionCeiling === 'plan') throw new Error('CANVAS_RUN_REQUIRES_EXPLICIT_EXECUTE')
        const input = parseCanvasRunWorkflowInput(params)
        /** Provider 只做快速初检；调度服务在每个外部 await 后重新验证关联和图事实。 */
        dependencies.access.requireLinkedCanvas(context, input.canvasId)
        const document = dependencies.documents.load({ projectId: context.projectId, canvasId: input.canvasId }).document
        if (document.revision !== input.expectedRevision) throw new Error('CANVAS_REVISION_CONFLICT')
        const result: CanvasRunWorkflowResult = parseCanvasRunWorkflowResult(
          await dependencies.workflowExecution.execute(context, input, toolCallId, signal),
        )
        return toolResult({ ...result })
      },
    }),
    defineCanvasTool({
      name: 'canvas_get_workflow_run', label: '查询 Canvas 工作流',
      description: '读取当前已关联画布中的确切持久工作流状态、节点进度和剩余媒体预算。',
      parameters: Type.Object({
        canvasId: Type.String({ minLength: 1, maxLength: 128 }),
        runId: Type.String({ minLength: 1, maxLength: 160 }),
      }),
      execute: async (_toolCallId, params) => {
        dependencies.access.authorizeRead(context)
        dependencies.access.requireLinkedCanvas(context, params.canvasId)
        const run = await dependencies.workflowExecution.get(context, {
          projectId: context.projectId, canvasId: params.canvasId, runId: params.runId,
        })
        return toolResult(run as unknown as Record<string, unknown>)
      },
    }),
    defineCanvasTool({
      name: 'canvas_list_workflow_runs', label: '列出 Canvas 工作流',
      description: '列出当前已关联画布的持久工作流摘要，不触发恢复或远端生成。',
      parameters: Type.Object({ canvasId: Type.String({ minLength: 1, maxLength: 128 }) }),
      execute: async (_toolCallId, params) => {
        dependencies.access.authorizeRead(context)
        dependencies.access.requireLinkedCanvas(context, params.canvasId)
        const runs = await dependencies.workflowExecution.list(context, params.canvasId)
        return toolResult({
          canvasId: params.canvasId,
          runs: runs.map((run: CanvasWorkflowRun) => ({
            id: run.id,
            revision: run.revision,
            status: run.status,
            rootNodeIds: run.rootNodeIds,
            budget: run.budget,
            updatedAt: run.updatedAt,
          })),
        })
      },
    }),
    defineCanvasTool({
      name: 'canvas_resume_workflow', label: '恢复 Canvas 工作流',
      description: '对账并继续当前会话的持久工作流。扩充预算或定向重试须同时提供 expectedRunRevision 与稳定 resumeOperationId；同一次恢复重用该 ID。只重试 Host 已确认失败的节点，提交结果未知必须等待原任务；可能继续产生模型费用。',
      parameters: Type.Object({
        canvasId: Type.String({ minLength: 1, maxLength: 128 }),
        runId: Type.String({ minLength: 1, maxLength: 160 }),
        expectedRunRevision: Type.Optional(Type.Integer({ minimum: 0 })),
        resumeOperationId: Type.Optional(Type.String({ minLength: 1, maxLength: 160, pattern: '^[A-Za-z0-9_-]+$' })),
        addDurationMs: Type.Optional(Type.Integer({ minimum: 0, maximum: CANVAS_WORKFLOW_MAX_DURATION_EXTENSION_MS })),
        addMediaRuns: Type.Optional(Type.Integer({ minimum: 0, maximum: CANVAS_WORKFLOW_MAX_MEDIA_RUN_EXTENSION })),
        retryNodeIds: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 160 }), { maxItems: CANVAS_WORKFLOW_RUN_NODE_LIMIT, uniqueItems: true })),
      }),
      execute: async (_toolCallId, params, signal) => {
        dependencies.access.authorizeRead(context)
        if (context.permissionCeiling === 'plan' || context.canvasAgentMode === 'parent-orchestrated') {
          throw new Error('CANVAS_RUN_REQUIRES_EXPLICIT_EXECUTE')
        }
        dependencies.access.requireLinkedCanvas(context, params.canvasId)
        const result = await dependencies.workflowExecution.resume(context, {
          projectId: context.projectId, canvasId: params.canvasId, runId: params.runId,
          ...(params.expectedRunRevision === undefined ? {} : { expectedRunRevision: params.expectedRunRevision }),
          ...(params.resumeOperationId === undefined ? {} : { resumeOperationId: params.resumeOperationId }),
          ...(params.addDurationMs === undefined ? {} : { addDurationMs: params.addDurationMs }),
          ...(params.addMediaRuns === undefined ? {} : { addMediaRuns: params.addMediaRuns }),
          ...(params.retryNodeIds === undefined ? {} : { retryNodeIds: [...params.retryNodeIds] }),
        }, signal)
        return toolResult({ ...result })
      },
    }),
    defineCanvasTool({
      name: 'canvas_cancel_workflow', label: '取消 Canvas 工作流',
      description: '取消属于当前 Agent 的持久工作流和其拥有的活动子任务；必须显式声明取消意图。',
      parameters: Type.Object({
        canvasId: Type.String({ minLength: 1, maxLength: 128 }),
        runId: Type.String({ minLength: 1, maxLength: 160 }),
        cancelIntent: Type.Literal('explicit'),
      }),
      execute: async (_toolCallId, params) => {
        dependencies.access.authorizeRead(context)
        if (context.permissionCeiling === 'plan' || context.canvasAgentMode === 'parent-orchestrated') {
          throw new Error('CANVAS_RUN_REQUIRES_EXPLICIT_EXECUTE')
        }
        return dependencies.access.runWrite(context, async () => {
          dependencies.access.requireLinkedCanvas(context, params.canvasId)
          const run = await dependencies.workflowExecution.cancel(context, {
            projectId: context.projectId, canvasId: params.canvasId, runId: params.runId,
          })
          return toolResult(run as unknown as Record<string, unknown>)
        })
      },
    }),
    defineCanvasTool({
      name: 'canvas_run_nodes', label: '运行画布节点',
      description: '运行已有图片、音频或视频节点并创建待验收候选，调用远端模型时可能产生费用；同批不能同时选择有直接依赖关系的上下游。',
      parameters: Type.Object({ canvasId: Type.String({ minLength: 1, maxLength: 128 }), nodeIds: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { minItems: 1, maxItems: MAX_READ_NODES }) }),
      execute: async (toolCallId, params, signal) => {
        signal?.throwIfAborted()
        dependencies.access.authorizeRead(context)
        if (context.permissionCeiling === 'plan') throw new Error('CANVAS_RUN_REQUIRES_EXPLICIT_EXECUTE')
        return dependencies.access.runWrite(context, async () => {
          signal?.throwIfAborted()
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
          assertNoSelectedUpstreamRegenerating(document, new Set(nodeIds))
          /** 所有媒体配置先完成只读预检，避免明显未配置节点晚于图片启动才失败。 */
          const mediaSnapshots = new Map<string, CanvasMediaModuleSnapshot>()
          for (const node of nodes) {
            if (node.kind !== 'audio' && node.kind !== 'video') continue
            const mediaTarget: CanvasMediaTarget = {
              ...target, nodeId: node.id, mediaModuleId: node.mediaModuleId, mediaKind: node.kind,
            }
            const snapshot = await dependencies.canvasMedia.load(mediaTarget)
            if (!snapshot.config.profile && !snapshot.config.workflow) throw new Error('CANVAS_MEDIA_WORKFLOW_REQUIRED')
            mediaSnapshots.set(node.id, snapshot)
          }
          /** 图片及无需运行的内容节点继续复用既有批量服务。 */
          const nonMediaNodes = nodes.filter((node) => node.kind !== 'audio' && node.kind !== 'video')
          const imageResult = nonMediaNodes.length > 0
            ? await dependencies.imageRuns.run(context, target, nonMediaNodes, toolCallId, {
                signal: signal ?? new AbortController().signal,
                deadlineAt: Date.now() + MAX_IMAGE_RUN_START_MS,
              })
            : { tasks: [] }
          /** 音视频按节点权威模块身份直接委托统一 CanvasMediaService。 */
          const mediaTasks = [] as Array<{
            nodeId: string
            status: 'started' | 'failed'
            taskId: string
            error?: string
          }>
          for (const node of nodes) {
            if (node.kind !== 'audio' && node.kind !== 'video') continue
            const mediaTarget: CanvasMediaTarget = {
              ...target, nodeId: node.id, mediaModuleId: node.mediaModuleId, mediaKind: node.kind,
            }
            const snapshot = mediaSnapshots.get(node.id)
            if (!snapshot) throw new Error('CANVAS_MEDIA_CONFIG_UNAVAILABLE')
            /** 节点维度 operationId 让整次工具调用可重放且不会跨节点碰撞。 */
            const operationId = createHash('sha256').update(JSON.stringify([
              'canvas-media-run', context.projectId, context.sessionId, context.runStartedAt,
              toolCallId, params.canvasId, node.id,
            ])).digest('hex')
            try {
              const run = await dependencies.canvasMedia.run({
                ...mediaTarget,
                expectedConfigRevision: snapshot.config.revision,
                operationId,
              }, createCanvasMediaOrigin(context, mediaTarget))
              mediaTasks.push({
                nodeId: node.id,
                status: run.phase === 'failed' || run.phase === 'cancelled' ? 'failed' : 'started',
                taskId: run.id,
                ...(run.phase === 'failed' && run.error
                  ? { error: /^[A-Z][A-Z0-9_]{0,119}$/.test(run.error) ? run.error : 'CANVAS_MEDIA_RUN_FAILED' }
                  : {}),
              })
            } catch (error) {
              mediaTasks.push({
                nodeId: node.id,
                status: 'failed',
                taskId: operationId,
                error: error instanceof Error ? error.message.split(':', 1)[0] : 'CANVAS_MEDIA_RUN_FAILED',
              })
            }
          }
          /** 结果恢复用户选择顺序，便于 Agent 精确关联每个节点进度。 */
          const tasksByNodeId = new Map([...imageResult.tasks, ...mediaTasks].map((task) => [task.nodeId, task]))
          return toolResult({
            canvasId: params.canvasId,
            revision: document.revision,
            tasks: nodeIds.flatMap((nodeId) => {
              const task = tasksByNodeId.get(nodeId)
              return task ? [task] : []
            }),
            ...(imageResult.batch ? { batch: imageResult.batch } : {}),
          })
        })
      },
    }),
  ] as ToolDefinition[]

  /** 仅向模型开放已完成生产装配的新操作，保持旧嵌入调用方兼容。 */
  const operationTools = createCanvasOperationTools(
    dependencies.operations ?? {}, context, dependencies.access,
    (toolCallId) => createArtifactOperationId(context, toolCallId),
  )
  /** 新操作与兼容工作流入口同名时使用已装配的统一处理器，避免向模型注册重复工具。 */
  const operationToolNames = new Set(operationTools.map((tool) => tool.name))
  for (let index = tools.length - 1; index >= 0; index -= 1) {
    if (operationToolNames.has(tools[index]!.name)) tools.splice(index, 1)
  }
  tools.push(...operationTools)
  tools.push(...createCanvasImageCandidateTools(dependencies, context, prepareInspectionThumbnail))

  if (dependencies.canvasMedia.attachImportedAssets) tools.push(defineCanvasTool({
    name: 'canvas_attach_media_assets', label: '回填本地媒体产物',
    description: '把当前会话通过 media_import_local_file 登记的精确资产回填为音视频节点候选。须先配置输出 key 并完整覆盖所有输出；不提交生成，也不自动采用。',
    parameters: Type.Object({
      canvasId: Type.String({ minLength: 1, maxLength: 128 }),
      nodeId: Type.String({ minLength: 1, maxLength: 128 }),
      expectedConfigRevision: Type.Integer({ minimum: 0 }),
      outputs: Type.Array(Type.Object({
        key: Type.String({ minLength: 1, maxLength: 256 }),
        asset: Type.Object({
          assetId: Type.String({ minLength: 1, maxLength: 128 }),
          revision: Type.Integer({ minimum: 1 }),
          hash: Type.String({ pattern: '^[a-f0-9]{64}$' }),
          mediaKind: Type.Union([Type.Literal('image'), Type.Literal('audio'), Type.Literal('video')]),
        }, { additionalProperties: false }),
      }, { additionalProperties: false }), { minItems: 1, maxItems: 128 }),
    }, { additionalProperties: false }),
    execute: async (toolCallId, params) => {
      dependencies.access.authorizeRead(context)
      if (context.permissionCeiling === 'plan') throw new Error('CANVAS_EXECUTE_INTENT_REQUIRED')
      if (context.canvasAgentMode === 'parent-orchestrated') throw new Error('CANVAS_MEDIA_ATTACH_PROJECT_AGENT_REQUIRED')
      return dependencies.access.runWrite(context, async () => {
        dependencies.access.requireLinkedCanvas(context, params.canvasId)
        /** 只从 Host 当前画布解析模块和媒体类型，调用方不能覆盖所有权。 */
        const canvasTarget = { projectId: context.projectId, canvasId: params.canvasId }
        const document = dependencies.documents.load(canvasTarget).document
        const mediaTarget = requireCanvasMediaTarget(document, canvasTarget, params.nodeId)
        /** 同一工具调用重放复用导入回执，目标和 session 纳入操作身份。 */
        const operationId = createHash('sha256').update(JSON.stringify([
          'canvas-local-media', context.projectId, context.sessionId, context.runStartedAt,
          toolCallId, params.canvasId, params.nodeId,
        ])).digest('hex')
        const input = parseAttachCanvasMediaImportedAssetsInput({
          ...mediaTarget, expectedConfigRevision: params.expectedConfigRevision,
          operationId, outputs: params.outputs,
        })
        const candidate = await dependencies.canvasMedia.attachImportedAssets!(input, createCanvasMediaOrigin(context, mediaTarget).actor)
        return toolResult({
          canvasId: params.canvasId, nodeId: params.nodeId, mediaKind: mediaTarget.mediaKind,
          configRevision: candidate.sourceConfigRevision, candidateId: candidate.id, sourceKind: 'local-import',
          outputs: candidate.outputs.map((output) => ({
            key: output.key, mediaKind: output.mediaKind, role: output.role, order: output.order,
          })),
          adopted: false,
        })
      })
    },
  }))
  /** Canvas Agent 的可信模式只缩减能力；普通 Agent 继续保留既有工具与审批。 */
  const mediaRun = dependencies.mediaTools?.(context)
  if (mediaRun) tools.push(...mediaRun.piCustomTools)
  const isCanvasAgent = context.canvasAgentTarget !== undefined
  const availableTools = isCanvasAgent
    ? filterCanvasAgentToolsForMode(tools, context.canvasAgentMode ?? 'renderer-manual')
    : tools
  /** 能力发现和返回的实际工具名单共享同一运行模式结果。 */
  const availableToolNames = new Set(availableTools.map((tool) => tool.name))
  /** 新操作提示只列出本轮真实装配并经运行模式过滤后的工具，避免 fallback 声称不存在的能力。 */
  const availableOperationNames = availableTools
    .map((tool) => tool.name)
    .filter((name) => name === 'canvas_get_task'
      || name === 'canvas_cancel_task'
      || name === 'canvas_retry_task'
      || name === 'canvas_list_versions'
      || name === 'canvas_read_version'
      || name === 'canvas_adopt_version'
      || name === 'canvas_adopt_candidate_batch'
      || name === 'canvas_export_artifact'
      || name === 'canvas_list_trash'
      || name === 'canvas_restore_node'
      || name === 'canvas_rebuild_agent'
      || name === 'canvas_list_workflows'
      || name === 'canvas_get_workflow'
      || name === 'canvas_resume_workflow'
      || name === 'canvas_cancel_workflow')
  const operationPrompt = availableOperationNames.length > 0
    ? `

本轮实际可用的任务、版本、导出、恢复或工作流操作工具仅为：${availableOperationNames.map((name) => `\`${name}\``).join('、')}。canvas_read 返回的 capabilities 已按这份真实清单和 permissionCeiling 收缩；不要调用未列出的操作，也不要把只读查询当成采用、重试、恢复或继续授权。`
    : ''
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

创建或修改前先用 canvas_get_context 获取权威关联；已有合适画布时直接复用，不要要求用户另建已经存在的画布。没有可用画布且用户已明确选择画布产物时，才用 canvas_manage 创建并关联。需要独立 Canvas Agent 分工时，普通 Agent 自行调用 canvas_create_agent，不要求用户手工创建。已有授权本地图片使用 canvas_import_image 导入为正式采用参考图，不要求用户拖入原生 Canvas。正文只通过 canvas_create_artifact 或 canvas_update_artifact 保存，图片画幅、尺寸、模型或上下文通过 canvas_update_image_config 局部修改，canvas_apply_changes 只处理结构；有关联来源时提供准确 relation。重建流程必须先验证并建立可执行的新链路，再删除旧节点。WebView 创建成功后即可直接预览，不得为 WebView 调用 canvas_run_nodes；图片仅在用户明确要求立即生成时才调用 canvas_run_nodes。图片运行结果只代表候选已创建或正在生成；可用 canvas_get_image_candidates 读取真实候选缩略图，用户已授权采用时用 canvas_adopt_image_candidates 提交精确 candidateHash，否则等待验收，不得描述为已正式替换。

面向画布的媒体生成先创建或复用对应卡片，再分析工作流。图片用 canvas_create_artifact，音视频用 canvas_create_media；不要等待生成成功才建立节点。通过媒体资源工具检查连接、真实输入输出和素材，立即用 canvas_update_image_config 或 canvas_update_media_config 固定工作流版本、连接与已知值。缺少素材或参数时先保存部分 typed 输入，在原卡片补齐；分析失败保留卡片，用 preparation 记录错误码和具体节点/字段原因，不伪造可执行绑定。修复后传 preparation:null 清除。只有参数完整且用户明确要求生成时才调用 canvas_run_nodes；进度与错误通过原节点查询。运行成功只产生候选，必须用 canvas_adopt_media_candidate 明确采用输出。已授权本地后期产物可经 media_import_local_file 登记，再用 canvas_attach_media_assets 按完整输出 key 回填候选，最后明确采用。metadataOnly 结果不表示你已观看视频或听取音频，内容质量判断必须使用可用的分析工具并保留证据。

用户只要求核对、检查或评审画布图片时保持只读：先用 canvas_list_nodes 分页枚举同一 revision 的全部图片节点，再用 canvas_inspect_images 每批最多四张读取当前正式采用缩略图。检查未采用候选或历史版本时，先用 canvas_read 获取 jobHistory 中成功任务的 id，再用 canvas_inspect_images 的 versions=[{nodeId,jobId}] 精确看图，无需先采用或要求用户截图。不存在的版本不得用正式图替代。不得只比较提示词或使用当前画布截图后声称已完成全量视觉核对；未明确要求修正时，不更新提示词、不运行节点、不采用候选。

Host 只提供 permissionCeiling 权限上限：plan 仅允许新增 idle 结构和只读操作，禁止运行、产物创建、采用、重试、导出、恢复、覆盖、删除和移动；execute 表示工具可执行，不代表用户已授权任意操作。删除或覆盖必须有用户明确意图，并传入 destructiveIntent=explicit。${operationPrompt}${canvasAgentPrompt}${mediaRun ? `\n\n${mediaRun.systemPromptAppend}` : ''}`,
    piCustomTools: availableTools,
    allowedToolNames: availableTools.map((tool) => tool.name),
    singleApprovalToolNames: [
      'canvas_run_nodes',
      'canvas_run_workflow',
      'canvas_retry_task',
      'canvas_resume_workflow',
      'canvas_cancel_workflow',
      'canvas_cancel_media_run',
      ...(mediaRun?.singleApprovalToolNames ?? []),
    ]
      .filter((name) => availableTools.some((tool) => tool.name === name)),
    allowedToolNamesMode: 'extend',
  }
}
