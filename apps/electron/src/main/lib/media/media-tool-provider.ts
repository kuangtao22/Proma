import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { AgentToolResult } from '@earendil-works/pi-agent-core'
import type {
  ComfyPrompt,
  MediaAssetRef,
  MediaAuthorizationMode,
  MediaApiModelCapability,
  MediaApiModelExecutionSupport,
  MediaConfiguration,
  MediaInputValue,
  MediaKind,
  MediaProjectCatalog,
  MediaRemoteDescriptor,
  MediaRemoteWorkflow,
  MediaRunSnapshot,
  MediaWorkflowDefinition,
  MediaWorkflowVersion,
} from '@proma/shared'
import { listMediaWorkflowFields, parseComfyPrompt, parseMediaWorkflowDefinition } from '@proma/shared'
import { Type } from 'typebox'
import { createHash } from 'node:crypto'
import type { TSchema } from 'typebox'
import type { CanvasToolRun, CanvasToolRunContext } from '../design/canvas-tool-provider'
import { COMFY_CORE_NODE_CONTRACTS, validateComfyWorkflow } from './comfyui-workflow'
import type { MediaConfigStore } from './media-config-store'
import type { MediaAssetFile } from './media-source-service'
import type { MediaResourceService } from './media-resource-service'
import type { MediaRunOrigin, MediaRunService } from './media-run-service'
import type { MediaRunSupervisor } from './media-run-supervisor'
import { inspectMediaWorkflow, matchMediaWorkflowInputs } from './media-workflow-inspection'
import type { MediaInputCandidate } from './media-workflow-inspection'
import type { PrepareCanvasMediaHandoffInput } from '../design/canvas-media-handoff-service'
import { analyzeRemoteWorkflow, getRemoteWorkflowClassTypes } from './media-remote-workflow-analysis'
import type { RemoteWorkflowAnalysis } from './media-remote-workflow-analysis'
import { MediaRemoteWorkflowImportError, MediaWorkflowValidationError } from './media-workflow-error'

const MAX_TOOL_RESPONSE_BYTES = 32 * 1024
const MAX_RUNS_PER_TURN = 8
const MAX_ASSET_RESULTS = 100
const IDENTIFIER_PATTERN = '^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$'

/** 用户媒体自主策略只覆盖生成与工作流运行控制，不放宽其它工具的强制审批。 */
const MEDIA_AUTOMATION_TOOL_NAMES: ReadonlySet<string> = new Set([
  'media_execute_run', 'media_cancel_run', 'canvas_run_nodes', 'canvas_run_workflow',
  'canvas_retry_task', 'canvas_resume_workflow', 'canvas_cancel_workflow', 'canvas_cancel_media_run',
])

/** 新建意图区分当次对话确认与用户在设置中授予的自主权限。 */
const WORKFLOW_CREATION_INTENT_SCHEMA = Type.Union([Type.Literal('user-confirmed'), Type.Literal('automatic-policy')])

/** 首版固定注册的媒体工具；来源导入工具仅在 Host 提供适配器时追加。 */
export const MEDIA_TOOL_NAMES = [
  'media_list_workflows',
  'media_list_resources',
  'media_read_remote_workflow',
  'media_discover_workflows',
  'media_use_remote_workflow',
  'media_import_remote_workflow',
  'media_import_remote_asset',
  'media_list_api_models',
  'media_get_node_schema',
  'media_inspect_workflow',
  'media_match_assets',
  'media_save_workflow_draft',
  'media_save_local_workflow',
  'media_publish_workflow',
  'media_list_profiles',
  'media_save_profile',
  'media_prepare_run',
  'media_execute_run',
  'media_get_run',
  'media_wait_run',
  'media_cancel_run',
  'media_list_assets',
] as const

export type MediaToolOperation = 'read' | 'draft' | 'publish' | 'prepare' | 'execute' | 'cancel'

/** Host 已按项目和 Canvas scope 过滤的 API 媒体模型候选。 */
export interface MediaApiModelCandidate {
  profileId: string
  name: string
  modelId: string
  executor: string
  mediaKind: MediaKind
  channelId?: string
  available: boolean
  unavailableReason?: string
  /** 统一目录的任务能力与执行支持，供 Agent 区分配置和可运行候选。 */
  capabilities?: MediaApiModelCapability[]
  support?: MediaApiModelExecutionSupport
}

/** Agent 工具只依赖 Host 已授权的窄接口，不能自行解析项目路径或远端凭据。 */
export interface MediaToolProviderDependencies {
  configuration: Pick<MediaConfigStore, 'listProject' | 'read' | 'getWorkflow' | 'saveWorkflow' | 'cacheRemoteWorkflow' | 'saveProfile' | 'resolveProfile'>
    & Partial<Pick<MediaConfigStore, 'subscribeAuthorizationMode'>>
  resources: Pick<MediaResourceService, 'list' | 'getSchema' | 'readWorkflow' | 'readRemoteAsset'>
  runs: Pick<MediaRunService, 'prepare' | 'get' | 'getOrigin' | 'cancel'> & Partial<Pick<MediaRunService, 'prepareDraft'>>
  supervisor: Pick<MediaRunSupervisor, 'start' | 'watch' | 'wait'>
  authorize(context: CanvasToolRunContext, operation: MediaToolOperation, runId?: string): void
  listAssets(context: CanvasToolRunContext): Promise<MediaInputCandidate[]>
  /** Host 将可信资产引用解析为当前 Agent 已授权根内的已验证文件。 */
  getAssetFile?(context: CanvasToolRunContext, asset: MediaAssetRef): Promise<MediaAssetFile>
  listSources?(context: CanvasToolRunContext): Promise<Array<{ sourceRef: string; name: string; mediaKind: MediaKind }>>
  importAssets?(context: CanvasToolRunContext, sourceRefs: string[]): Promise<MediaAssetRef[]>
  /** Host 从当前 Agent cwd 或 fresh 授权附加根导入一个明确本地文件。 */
  importLocalFile?(context: CanvasToolRunContext, input: { path: string; mediaKind: MediaKind }): Promise<MediaAssetRef>
  /** Host 在受管项目根中登记远端读取结果，工具层不接触路径。 */
  registerRemoteAsset(context: CanvasToolRunContext, input: {
    descriptor: MediaRemoteDescriptor
    bytes: Uint8Array
    contentType: string | null
  }): Promise<MediaAssetRef>
  /** Host 按项目和可选 Canvas scope 返回已经过滤的 API 模型候选。 */
  listModels(context: CanvasToolRunContext, canvasId?: string): Promise<MediaApiModelCandidate[]>
  /** Host 验证画布归属后返回用户选择的默认连接，不由 Agent 修改。 */
  getCanvasConnection?(context: CanvasToolRunContext, canvasId: string): string | null
  /** 父编排 child 准备只能登记到原工作流计划内的精确媒体目标。 */
  prepareParentRun?(context: CanvasToolRunContext, input: PrepareCanvasMediaHandoffInput, origin: MediaRunOrigin): Promise<MediaRunSnapshot>
}

interface WorkflowSelector {
  workflowId?: string
  workflowRevision?: number
  definition?: unknown
  prompt?: unknown
}

/** 同时支持普通 Agent 指定画布与画布 Agent 的固定身份。 */
function resolveMediaCanvasId(context: CanvasToolRunContext, canvasId?: string): string | undefined {
  const fixedCanvasId = context.canvasAgentTarget?.canvasId
  if (fixedCanvasId && canvasId && canvasId !== fixedCanvasId) throw new Error('MEDIA_CANVAS_TARGET_MISMATCH')
  return fixedCanvasId ?? canvasId
}

/** 返回默认连接的可见状态；删除或停用时不隐藏用户的原选择。 */
function canvasConnectionSelection(dependencies: MediaToolProviderDependencies, context: CanvasToolRunContext, requestedCanvasId?: string) {
  const canvasId = resolveMediaCanvasId(context, requestedCanvasId)
  const connectionId = canvasId ? dependencies.getCanvasConnection?.(context, canvasId) ?? null : null
  const connection = connectionId ? dependencies.configuration.listProject(context.projectId).connections.find((item) => item.id === connectionId) : undefined
  return {
    canvasId: canvasId ?? null,
    selectedConnection: connectionId ? { id: connectionId, name: connection?.name ?? connectionId, enabled: connection?.enabled ?? false } : null,
    connectionStatus: connectionId ? connection?.enabled ? 'available' : 'unavailable' : 'unbound',
  }
}

/** 显式连接优先，否则继承画布选择；绝不隐式选目录第一项。 */
function resolveMediaConnection(dependencies: MediaToolProviderDependencies, context: CanvasToolRunContext, input: { connectionId?: string; canvasId?: string }): string {
  const selection = canvasConnectionSelection(dependencies, context, input.canvasId)
  const connectionId = input.connectionId ?? selection.selectedConnection?.id
  if (!connectionId) throw new Error(selection.canvasId ? 'MEDIA_CANVAS_CONNECTION_REQUIRED' : 'MEDIA_CONNECTION_REQUIRED')
  const connection = dependencies.configuration.listProject(context.projectId).connections.find((item) => item.id === connectionId)
  if (!connection?.enabled) throw new Error('MEDIA_CONNECTION_UNAVAILABLE')
  return connectionId
}

/** 远端 descriptor 的完整工具 schema，字段身份不能退化为显示名称。 */
const REMOTE_DESCRIPTOR_SCHEMA = Type.Object({
  connectionId: Type.String({ pattern: IDENTIFIER_PATTERN }),
  instanceGeneration: Type.String({ minLength: 1, maxLength: 256 }),
  remoteUser: Type.String({ maxLength: 256 }),
  source: Type.Union([Type.Literal('user-data'), Type.Literal('assets-api')]),
  id: Type.String({ minLength: 1, maxLength: 2048 }),
  workflowPath: Type.Optional(Type.String({ minLength: 1, maxLength: 2048 })),
  assetId: Type.Optional(Type.String({ minLength: 1, maxLength: 2048 })),
  filename: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
  subfolder: Type.Optional(Type.String({ maxLength: 1024 })),
  type: Type.Optional(Type.Union([Type.Literal('input'), Type.Literal('output'), Type.Literal('temp')])),
  loaderPath: Type.Optional(Type.String({ maxLength: 2048 })),
  contentHash: Type.Optional(Type.String({ maxLength: 256 })),
}, { additionalProperties: false })

/** TypeBox 泛型辅助保留 execute 参数类型。 */
function defineTool<TParams extends TSchema, TDetails = unknown>(tool: ToolDefinition<TParams, TDetails>): ToolDefinition<TParams, TDetails> {
  return tool
}

/** 返回紧凑 JSON，避免工具结果格式化空白吞噬上下文预算。 */
function toolResult(details: Record<string, unknown>): AgentToolResult<unknown> {
  const actions: Record<string, string[]> = {
    prepared: ['media_execute_run'], uploading: ['media_execute_run'], compiling: ['media_execute_run'],
    submitting: ['media_wait_run'], 'submission-unknown': ['media_wait_run', 'media_get_run'],
    queued: ['media_wait_run', 'media_cancel_run'], running: ['media_wait_run', 'media_cancel_run'],
    collecting: ['media_wait_run'], 'collection-failed': ['media_wait_run'],
    succeeded: ['media_list_assets'], failed: ['media_inspect_workflow', 'media_prepare_run'], cancelled: ['media_prepare_run'],
    'cancel-requested': ['media_wait_run'],
  }
  const bounded = boundDetails(typeof details.phase === 'string' && actions[details.phase]
    ? { ...details, availableActions: actions[details.phase] } : details)
  return { content: [{ type: 'text', text: JSON.stringify(bounded) }], details: bounded }
}

/** 非分页结果超限时明确要求缩小查询，不能丢弃数据后继续推进原游标。 */
function boundDetails(details: Record<string, unknown>): Record<string, unknown> {
  if (Buffer.byteLength(JSON.stringify(details), 'utf8') <= MAX_TOOL_RESPONSE_BYTES) return details
  return { code: 'MEDIA_RESPONSE_TOO_LARGE', truncated: true, availableActions: ['reduce_limit', 'query_specific_node'] }
}

/** 按实际返回条目推进游标，保证字节预算不会导致中间资源被跳过。 */
function pageResult(key: string, items: unknown[], offset: number, total: number, metadata: Record<string, unknown> = {}): AgentToolResult<unknown> {
  const selected = [...items]
  const details = (): Record<string, unknown> => ({ ...metadata, total, [key]: selected,
    nextOffset: offset + selected.length < total ? offset + selected.length : null,
    truncated: offset + selected.length < total })
  while (selected.length && Buffer.byteLength(JSON.stringify(details()), 'utf8') > MAX_TOOL_RESPONSE_BYTES) selected.pop()
  if (!selected.length && items.length) return toolResult({ code: 'MEDIA_RESPONSE_TOO_LARGE', truncated: true, availableActions: ['query_specific_node'] })
  return toolResult(details())
}

/** 每次实际调用前重验可信模式，防止工具发现后运行上下文被降权。 */
function requireOperation(context: CanvasToolRunContext, operation: MediaToolOperation): void {
  if ((operation === 'execute' || operation === 'cancel')
    && (context.permissionCeiling !== 'execute' || context.canvasAgentMode === 'parent-orchestrated')) {
    throw new Error('MEDIA_EXECUTE_INTENT_REQUIRED')
  }
  if (operation === 'publish' && (context.permissionCeiling !== 'execute' || context.canvasAgentMode === 'parent-orchestrated')) throw new Error('MEDIA_PUBLISH_NOT_AUTHORIZED')
}

/** 敏感写入在解析前和副作用前各检查一次 Host 授权。 */
function authorize(dependencies: MediaToolProviderDependencies, context: CanvasToolRunContext, operation: MediaToolOperation, runId?: string): void {
  requireOperation(context, operation)
  dependencies.authorize(context, operation, runId)
}

/** 从可信运行上下文构造持久化 actor，模型参数不能覆盖这些字段。 */
function originFor(context: CanvasToolRunContext): MediaRunOrigin {
  const target = context.canvasAgentTarget
  return {
    actor: {
      sessionId: context.sessionId,
      runStartedAt: context.runStartedAt,
      mode: context.canvasAgentMode ?? (target ? 'renderer-manual' : 'project-agent'),
      ...(target ? { canvasId: target.canvasId, nodeId: target.nodeId } : {}),
    },
  }
}

/** 运行读取与控制仅允许原始可信 actor，不能靠猜测 runId 访问同项目其它任务。 */
function requireOwnedRun(dependencies: MediaToolProviderDependencies, context: CanvasToolRunContext, runId: string): void {
  const expected = originFor(context).actor
  const actual = dependencies.runs.getOrigin(context.projectId, runId).actor
  if (!expected || !actual || actual.sessionId !== expected.sessionId
    || actual.mode !== expected.mode || actual.canvasId !== expected.canvasId || actual.nodeId !== expected.nodeId) {
    throw new Error('MEDIA_RUN_NOT_OWNED')
  }
}

/** 接受已保存工作流、完整定义或原始 API prompt 三种检查来源。 */
function resolveWorkflow(dependencies: MediaToolProviderDependencies, context: CanvasToolRunContext, selector: WorkflowSelector): MediaWorkflowDefinition {
  const modes = [selector.workflowId !== undefined, selector.definition !== undefined, selector.prompt !== undefined].filter(Boolean).length
  if (modes !== 1) throw new Error('MEDIA_WORKFLOW_SOURCE_INVALID')
  if (selector.workflowId !== undefined) {
    if (!Number.isSafeInteger(selector.workflowRevision) || (selector.workflowRevision ?? 0) < 1) throw new Error('MEDIA_WORKFLOW_SOURCE_INVALID')
    return dependencies.configuration.getWorkflow(selector.workflowId, selector.workflowRevision!, context.projectId).definition
  }
  if (selector.definition !== undefined) return parseMediaWorkflowDefinition(selector.definition)
  if (selector.prompt && typeof selector.prompt === 'object' && ('nodes' in selector.prompt || 'links' in selector.prompt)) throw new Error('COMFY_UI_WORKFLOW_UNSUPPORTED')
  return { schemaVersion: 1, prompt: parseComfyPrompt(selector.prompt), bindings: [], outputs: [] }
}

/** 将内部 schema 清洗为节点字段摘要；隐藏字段和非白名单枚举永不返回。 */
function summarizeSchema(schema: Awaited<ReturnType<MediaResourceService['getSchema']>>): Record<string, unknown> {
  return {
    nodes: Object.entries(schema).map(([classType, node]) => {
      const contract = COMFY_CORE_NODE_CONTRACTS[classType]
      const inputs = [...Object.entries(node.input.required).map(([name, value]) => ({ name, required: true, value })),
        ...Object.entries(node.input.optional ?? {}).map(([name, value]) => ({ name, required: false, value }))]
        .map(({ name, required, value }) => ({
          name,
          required,
          type: Array.isArray(value[0]) ? 'enum' : value[0],
          ...(Array.isArray(value[0]) && contract && name !== contract.resourceInput?.input
            ? { values: value[0].filter((item): item is string | number | boolean | null => item === null || ['string', 'number', 'boolean'].includes(typeof item)).slice(0, 100), totalValues: value[0].length }
            : {}),
          ...(contract && name !== contract.resourceInput?.input && value[1]
            ? { constraints: Object.fromEntries(Object.entries(value[1]).filter(([key, option]) => ['min', 'max', 'step', 'default', 'multiline'].includes(key)
              && (typeof option === 'boolean' || typeof option === 'number' || (typeof option === 'string' && option.length <= 512)))) }
            : {}),
          ...(contract && name !== contract.resourceInput?.input && value[0] === 'COMFY_DYNAMICCOMBO_V3'
            ? { dynamicSchema: value } : {}),
        }))
      return {
        classType,
        category: node.category ?? '',
        inputs,
        outputs: node.output,
        supported: node.unsupported !== true && Object.hasOwn(COMFY_CORE_NODE_CONTRACTS, classType),
        ...(node.unsupported === true ? { unsupported: true } : {}),
      }
    }),
  }
}

/** 返回项目目录中指定 ID 的最新修订。 */
function latestRevision(items: Array<{ id: string; revision: number }>, id: string): number {
  return Math.max(0, ...items.filter((item) => item.id === id).map((item) => item.revision))
}

/** 从配置保存结果取回刚创建的不可变版本。 */
function savedWorkflow(configuration: MediaConfiguration, id: string): MediaWorkflowVersion {
  const item = configuration.workflows.filter((workflow) => workflow.id === id).sort((left, right) => right.revision - left.revision)[0]
  if (!item) throw new Error('MEDIA_WORKFLOW_SAVE_FAILED')
  return item
}

/** 远端正文的内容身份，导入时复核，避免选型后静默采用另一版本。 */
function remoteWorkflowContentHash(workflow: MediaRemoteWorkflow): string {
  return createHash('sha256').update(JSON.stringify(workflow.definition)).digest('hex')
}

/** 仅加载候选实际使用的节点 schema，读取与转换均无保存或生成副作用。 */
async function inspectRemoteWorkflow(dependencies: MediaToolProviderDependencies, context: CanvasToolRunContext, descriptor: MediaRemoteDescriptor, loaded?: MediaRemoteWorkflow) {
  const remote = loaded ?? await dependencies.resources.readWorkflow(descriptor, context.projectId)
  const classTypes = getRemoteWorkflowClassTypes(remote)
  const schema = classTypes.length ? await dependencies.resources.getSchema(descriptor.connectionId, context.projectId, classTypes) : {}
  const analysis = analyzeRemoteWorkflow(remote, schema)
  return { remote, analysis, contentHash: remoteWorkflowContentHash(remote) }
}

/** 新旧接入工具共用远端复核、幂等执行快照与有界回执，不创建用户模板。 */
async function useRemoteWorkflowSnapshot(dependencies: MediaToolProviderDependencies, context: CanvasToolRunContext,
  descriptor: MediaRemoteDescriptor, expectedContentHash: string, hasCanvasTarget: boolean): Promise<AgentToolResult<unknown>> {
  authorize(dependencies, context, 'draft')
  /** 执行快照来源取自 Host 复核过的远端正文，而非 Agent 构造的图。 */
  const { remote, analysis, contentHash } = await inspectRemoteWorkflow(dependencies, context, descriptor)
  if (contentHash !== expectedContentHash) throw new Error('MEDIA_REMOTE_WORKFLOW_CHANGED')
  if (!analysis.definition) throw new MediaRemoteWorkflowImportError(analysis.issues)
  authorize(dependencies, context, 'draft')
  /** 稳定身份由存储层生成；同内容重试不会增添模板或新版本。 */
  const item = dependencies.configuration.cacheRemoteWorkflow({ projectId: context.projectId,
    name: (remote.descriptor.workflowPath ?? remote.descriptor.id).slice(-120), descriptor: remote.descriptor,
    contentHash, definition: analysis.definition })
  return toolResult({ id: item.id, name: item.name, revision: item.revision, hash: item.hash,
    connectionId: descriptor.connectionId, source: 'comfyui-server', contentHash,
    inputs: item.definition.bindings.slice(0, 24).map((binding) => ({ key: binding.key, kind: binding.kind })),
    outputs: item.definition.outputs.slice(0, 16).map((output) => ({ key: output.key, mediaType: output.mediaType })),
    truncated: item.definition.bindings.length > 24 || item.definition.outputs.length > 16,
    availableActions: ['media_inspect_workflow', 'media_match_assets',
      ...(hasCanvasTarget ? ['canvas_update_image_config', 'canvas_update_media_config'] : ['media_prepare_run'])] })
}

/** 比较真实媒体输入数量和输出类型；具体首尾帧等角色仍由 Agent 阅读节点语义判断。 */
function matchRemoteWorkflow(analysis: RemoteWorkflowAnalysis, mediaKind: MediaKind, inputKinds?: MediaKind[]) {
  const inputCounts = { image: 0, audio: 0, video: 0 }
  const requestedCounts = { image: 0, audio: 0, video: 0 }
  for (const binding of analysis.definition?.bindings ?? []) {
    if (binding.kind === 'image' || binding.kind === 'audio' || binding.kind === 'video') inputCounts[binding.kind] += 1
  }
  for (const kind of inputKinds ?? []) requestedCounts[kind] += 1
  const matchesOutput = analysis.outputs.some((output) => output.mediaType === mediaKind)
  const matchesInputs = !analysis.definition || !inputKinds ? null
    : (['image', 'audio', 'video'] as const).every((kind) => inputCounts[kind] === requestedCounts[kind])
  return { matchesOutput, matchesInputs, inputCounts: analysis.definition ? inputCounts : null,
    status: !analysis.definition ? 'blocked' : !matchesOutput || matchesInputs === false ? 'incompatible' : 'candidate' }
}

/** 每次读取用户保存的最新生成授权，旧配置保持逐次确认。 */
function mediaAuthorizationMode(dependencies: MediaToolProviderDependencies): MediaAuthorizationMode {
  return dependencies.configuration.read().authorizationMode === 'automatic' ? 'automatic' : 'ask'
}

/** 新建许可来自当次对话或当前自主策略，Agent 声明本身不能打开自主模式。 */
function assertWorkflowCreationIntent(dependencies: MediaToolProviderDependencies, intent: unknown): void {
  if (intent === 'user-confirmed') return
  if (intent === 'automatic-policy' && mediaAuthorizationMode(dependencies) === 'automatic') return
  throw new Error('MEDIA_WORKFLOW_CREATION_CONFIRMATION_REQUIRED')
}

/** 旧草稿入口保留项目隔离、父编排分支身份与配置 CAS。 */
function saveProjectWorkflow(dependencies: MediaToolProviderDependencies, context: CanvasToolRunContext, input: {
  id: string; name: string; definition: unknown; expectedConfigRevision: number; expectedWorkflowRevision: number
  creationIntent?: 'user-confirmed' | 'automatic-policy'
}): MediaWorkflowVersion {
  if (input.expectedWorkflowRevision === 0) assertWorkflowCreationIntent(dependencies, input.creationIntent)
  authorize(dependencies, context, 'draft')
  const catalog = dependencies.configuration.listProject(context.projectId)
  const branchPrefix = createHash('sha256').update(JSON.stringify([context.sessionId, context.runStartedAt])).digest('hex').slice(0, 24)
  const expectedPrefix = `branch-${branchPrefix}-`
  const id = context.canvasAgentMode === 'parent-orchestrated'
    ? input.id.startsWith(expectedPrefix) ? input.id
      : input.id.startsWith('branch-') ? (() => { throw new Error('MEDIA_WORKFLOW_DRAFT_SCOPE_INVALID') })()
        : `${expectedPrefix}${input.id.slice(0, 80)}`
    : input.id
  if (latestRevision(catalog.workflows, id) !== input.expectedWorkflowRevision) throw new Error('MEDIA_WORKFLOW_DRAFT_CONFLICT')
  const definition = parseMediaWorkflowDefinition(input.definition)
  authorize(dependencies, context, 'draft')
  return savedWorkflow(dependencies.configuration.saveWorkflow({ id, name: input.name, projectId: context.projectId, definition }, input.expectedConfigRevision), id)
}

/** 为旧目录入口提供摘要；UI 图引导进入实际转换分析，不再一律报告不支持。 */
function summarizeRemoteWorkflow(workflow: MediaRemoteWorkflow): Record<string, unknown> {
  if (workflow.format === 'ui') {
    const analysis = analyzeRemoteWorkflow(workflow, {})
    return { format: 'ui', executable: false, validationStatus: 'requires-analysis',
      nodes: analysis.nodes.slice(0, 16), inputs: analysis.inputs.slice(0, 24), outputs: analysis.outputs.slice(0, 16),
      availableActions: ['media_discover_workflows'] }
  }
  if (workflow.format !== 'api') return {
    format: workflow.format,
    executable: false,
    validationStatus: 'unsupported-format',
    inputs: [],
    outputs: [],
  }
  try {
    const prompt = parseComfyPrompt(workflow.definition)
    const inputs = listMediaWorkflowFields(prompt).filter((field) => field.valueKind !== 'complex').map((field) => ({
      nodeId: field.nodeId,
      input: field.input,
      classType: field.classType,
      valueKind: field.valueKind,
    }))
    const outputs = Object.entries(prompt).flatMap(([nodeId, node]) => {
      const output = COMFY_CORE_NODE_CONTRACTS[node.class_type]?.historyOutput
      return output ? [{ nodeId, mediaType: output.mediaType }] : []
    })
    return { format: workflow.format, executable: false, validationStatus: 'unverified', inputs, outputs }
  } catch {
    return { format: workflow.format, executable: false, validationStatus: 'invalid', inputs: [], outputs: [] }
  }
}

/** 为普通 Agent 或 Canvas Agent 创建同一套项目媒体能力。 */
export function createMediaToolRun(dependencies: MediaToolProviderDependencies, context: CanvasToolRunContext): CanvasToolRun {
  /** 本轮已成功读取的明确画布作用域，防止后续省略 canvasId 又退回独立生成。 */
  let hasCanvasTarget = Boolean(context.canvasAgentTarget || context.explicitReferences.length)
  const preparedOperations = new Set<string>()
  const executedRuns = new Set<string>()
  const isExecutionCapable = context.permissionCeiling === 'execute' && context.canvasAgentMode !== 'parent-orchestrated'
  /** 仅跟踪同轮连续读取的候选页；最多保留 16 组查询，不扫描或轮询远端目录。 */
  const discoveryScans = new Map<string, { nextOffset: number; candidates: number; blocked: number }>()

  const tools: ToolDefinition[] = [
    defineTool({
      name: 'media_list_workflows', label: '列出媒体工作流',
      description: '读取画布绑定的 ComfyUI 服务器及本地已保存模板摘要。新任务优先用 media_discover_workflows 查询服务器；内部执行快照不作为可复用模板推荐，不默认选择第一项。',
      parameters: Type.Object({
        canvasId: Type.Optional(Type.String({ pattern: IDENTIFIER_PATTERN })),
        offset: Type.Optional(Type.Integer({ minimum: 0 })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
      }),
      execute: async (_toolCallId, params) => {
        authorize(dependencies, context, 'read')
        const catalog = dependencies.configuration.listProject(context.projectId)
        const latest = new Map<string, number>()
        for (const item of catalog.workflows) latest.set(item.id, Math.max(latest.get(item.id) ?? 0, item.revision))
        const workflows = catalog.workflows.filter((summary) => !summary.remoteSource).map((summary) => {
          const workflow = dependencies.configuration.getWorkflow(summary.id, summary.revision, context.projectId)
          return {
            id: workflow.id,
            name: workflow.name,
            revision: workflow.revision,
            projectId: workflow.projectId,
            hash: workflow.hash,
            latest: workflow.revision === latest.get(workflow.id),
            inputs: workflow.definition.bindings.map((binding) => ({
              key: binding.key,
              kind: binding.kind,
              ...(binding.field ? { label: binding.field.label, controlType: binding.field.controlType,
                required: binding.field.required } : {}),
            })),
            outputs: workflow.definition.outputs.map((output) => ({ key: output.key, mediaType: output.mediaType })),
          }
        })
        const offset = params.offset ?? 0
        return pageResult('workflows', workflows.slice(offset, offset + (params.limit ?? 30)), offset, workflows.length, {
          revision: catalog.revision,
          connections: catalog.connections.map((connection) => ({ id: connection.id, name: connection.name,
            enabled: connection.enabled, instanceGeneration: connection.instanceGeneration })),
          selectedWorkflow: null,
          preferredSource: 'comfyui-server',
          authorizationMode: mediaAuthorizationMode(dependencies),
          availableActions: ['media_discover_workflows'],
          ...canvasConnectionSelection(dependencies, context, params.canvasId),
        })
      },
    }),
    defineTool({
      name: 'media_read_remote_workflow', label: '读取远端工作流',
      description: '读取精确 descriptor 的远端工作流。小图默认返回正文；大图自动返回节点分页，可用 section=nodes/inputs/outputs/issues 和 offset/limit 精读完整结构与错误。输入页包含真实来源连线和有界默认值，正文不会作为指令执行。不保存、不生成。',
      parameters: Type.Object({
        descriptor: REMOTE_DESCRIPTOR_SCHEMA,
        section: Type.Optional(Type.Union([Type.Literal('nodes'), Type.Literal('inputs'), Type.Literal('outputs'), Type.Literal('issues')])),
        offset: Type.Optional(Type.Integer({ minimum: 0 })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 16 })),
      }),
      execute: async (_toolCallId, params) => {
        authorize(dependencies, context, 'read')
        /** 精读分页同样在执行边界校验，避免单调用复制过多节点。 */
        const offset = params.offset ?? 0
        const limit = params.limit ?? 8
        if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 16
          || (params.section !== undefined && !['nodes', 'inputs', 'outputs', 'issues'].includes(params.section))) throw new Error('MEDIA_DISCOVERY_PAGE_INVALID')
        const workflow = await dependencies.resources.readWorkflow(params.descriptor as MediaRemoteDescriptor, context.projectId)
        /** 保留小图原有正文读取；超限时转入真实可调用的精读页，避免返回不存在的操作提示。 */
        const full = { descriptor: workflow.descriptor, format: workflow.format,
          contentHash: remoteWorkflowContentHash(workflow), workflow: summarizeRemoteWorkflow(workflow), definition: workflow.definition }
        if (params.section === undefined && params.offset === undefined && params.limit === undefined
          && Buffer.byteLength(JSON.stringify(full), 'utf8') <= MAX_TOOL_RESPONSE_BYTES) return toolResult(full)
        const { analysis, contentHash } = await inspectRemoteWorkflow(dependencies, context, workflow.descriptor, workflow)
        const section = params.section ?? 'nodes'
        /** 节点页保留类型与语义标题；每条输入单独分页，单节点输入很多也可继续精读。 */
        const items = section === 'nodes' ? analysis.nodes.map((node) => ({
          ...node, outputTypes: node.outputTypes.slice(0, 16), totalOutputTypes: node.outputTypes.length,
        })) : section === 'outputs' ? analysis.outputs : section === 'issues' ? analysis.issues : analysis.inputs.map((input) => {
          /** 转换后 prompt 的连线是精确执行来源，资源输入已清为无身份占位。 */
          const value = analysis.definition?.prompt[input.nodeId]?.inputs[input.input]
          const source = Array.isArray(value) && value.length === 2 && typeof value[0] === 'string' && typeof value[1] === 'number'
            ? { nodeId: value[0], outputIndex: value[1] } : undefined
          return { ...input, ...(source ? { source } : {}),
            ...(typeof value === 'string' ? { defaultValue: value.slice(0, 512), valueTruncated: value.length > 512 }
              : typeof value === 'number' || typeof value === 'boolean' ? { defaultValue: value } : {}) }
        })
        authorize(dependencies, context, 'read')
        return pageResult('items', items.slice(offset, offset + limit), offset, items.length, {
          descriptor: workflow.descriptor, contentHash, format: workflow.format, section,
          canImport: analysis.definition !== null, sections: ['nodes', 'inputs', 'outputs', 'issues'],
          ...(section === 'issues' ? {} : { issues: analysis.issues.slice(0, 4) }), totalIssues: analysis.issues.length,
          availableActions: ['media_read_remote_workflow', 'media_use_remote_workflow'],
        })
      },
    }),
    defineTool({
      name: 'media_discover_workflows', label: '匹配远端工作流',
      description: '未指定工作流时，从画布绑定或显式 ComfyUI 连接分页读取候选，检查真实节点、媒体输入数量、输出和当前服务器兼容性。复用资源快照；UI 图仅在确定映射时转换，返回阻塞原因。candidate 只表示结构候选，还需核对首尾帧等语义角色；不保存、不生成、不按名称默认选第一项。',
      parameters: Type.Object({
        canvasId: Type.Optional(Type.String({ pattern: IDENTIFIER_PATTERN })),
        connectionId: Type.Optional(Type.String({ pattern: IDENTIFIER_PATTERN })),
        mediaKind: Type.Union([Type.Literal('image'), Type.Literal('video'), Type.Literal('audio')]),
        inputKinds: Type.Optional(Type.Array(Type.Union([Type.Literal('image'), Type.Literal('video'), Type.Literal('audio')]), { maxItems: 128 })),
        query: Type.Optional(Type.String({ maxLength: 256 })),
        offset: Type.Optional(Type.Integer({ minimum: 0 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 6 })),
        refresh: Type.Optional(Type.Boolean()),
      }),
      execute: async (_toolCallId, params) => {
        authorize(dependencies, context, 'read')
        /** 在 Host 执行边界再次限制页宽，直接调用也不能扩大远端解析负载。 */
        const limit = params.limit ?? 6
        const offset = params.offset ?? 0
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 6
          || !Number.isSafeInteger(offset) || offset < 0) throw new Error('MEDIA_DISCOVERY_PAGE_INVALID')
        const connectionId = resolveMediaConnection(dependencies, context, params)
        const page = await dependencies.resources.list({ projectId: context.projectId, connectionId, kind: 'workflows',
          query: params.query, offset, limit, refresh: params.refresh })
        const items: Record<string, unknown>[] = []
        /** 本页结构候选与不能判断的工作流数量，不把读取/转换失败算成不匹配。 */
        let candidates = 0
        let blocked = 0
        // 串行读取有界候选页，避免并发解析多份大型图造成主进程峰值。
        for (const item of page.items) {
          const base = { id: item.id, name: item.name, descriptor: item.descriptor }
          try {
            if (!item.descriptor) throw new Error('MEDIA_REMOTE_DESCRIPTOR_REQUIRED')
            const { analysis, contentHash } = await inspectRemoteWorkflow(dependencies, context, item.descriptor)
            /** 候选仍需由 Agent 核对输入角色与用户目标。 */
            const match = matchRemoteWorkflow(analysis, params.mediaKind, params.inputKinds)
            if (match.status === 'candidate') candidates += 1
            if (match.status === 'blocked') blocked += 1
            items.push({ ...base, contentHash, format: analysis.format, canImport: analysis.definition !== null,
              match,
              nodes: analysis.nodes.slice(0, 16), inputs: analysis.inputs.slice(0, 24), outputs: analysis.outputs.slice(0, 16),
              issues: analysis.issues.slice(0, 16), totalNodes: analysis.nodes.length,
              summaryTruncated: analysis.nodes.length > 16 || analysis.inputs.length > 24 || analysis.outputs.length > 16 || analysis.issues.length > 16 })
          } catch {
            blocked += 1
            items.push({ ...base, canImport: false, issues: [{ code: 'REMOTE_WORKFLOW_READ_FAILED', message: '读取或检查失败，可重试此工作流；其它候选仍可查看。' }] })
          }
        }
        authorize(dependencies, context, 'read')
        /** 查询条件与服务器快照身份共同固定一次扫描，不能把不同筛选结果拼成完整目录。 */
        const scanKey = JSON.stringify([connectionId, page.instanceGeneration, page.remoteUser, page.snapshotId,
          params.mediaKind, params.inputKinds, params.query ?? ''])
        /** 只有从第一页连续读取的结果才证明整个目录已检查。 */
        const priorScan = offset === 0 ? { nextOffset: 0, candidates: 0, blocked: 0 } : discoveryScans.get(scanKey)
        const contiguous = priorScan?.nextOffset === offset
        const scan = { nextOffset: offset + items.length,
          candidates: candidates + (contiguous ? priorScan.candidates : 0),
          blocked: blocked + (contiguous ? priorScan.blocked : 0) }
        if (contiguous) {
          if (!discoveryScans.has(scanKey) && discoveryScans.size >= 16) discoveryScans.delete(discoveryScans.keys().next().value!)
          discoveryScans.set(scanKey, scan)
        }
        /** 不可用、部分页、筛选结果或转换问题均不能宣称服务器没有匹配工作流。 */
        const status = (page.capability !== undefined && page.capability !== 'available') || page.syncError ? 'unavailable'
          : scan.candidates > 0 ? 'candidates'
            : !contiguous || page.nextOffset !== null || scan.nextOffset < page.total || Boolean(params.query?.trim()) ? 'incomplete'
              : scan.blocked > 0 ? 'blocked' : 'no-match'
        /** 自主授权只改变无匹配后的确认流程，不把未完成检查当成新建依据。 */
        const authorizationMode = mediaAuthorizationMode(dependencies)
        const canCreateWorkflowAutomatically = status === 'no-match' && authorizationMode === 'automatic'
        const discovery = { status, requiresUserConfirmation: status === 'no-match' && !canCreateWorkflowAutomatically,
          canCreateWorkflowAutomatically,
          message: status === 'no-match' ? canCreateWorkflowAutomatically
            ? '未找到匹配的服务器工作流。用户已选择 Agent 自主执行，可根据当前服务器实际模型和节点生成工作流，校验后以 creationIntent=automatic-policy 保存本地并继续任务，无需再次询问。'
            : '未找到匹配的服务器工作流。是否根据当前服务器已有的模型和节点生成工作流，并保存到本地？等待用户确认后再创建。'
            : status === 'unavailable' ? '服务器目录不可用或同步失败，请先处理连接问题，不能据此判断没有匹配工作流。'
              : status === 'blocked' ? '存在无法读取或转换的工作流，请说明具体原因并继续检查，不能据此自动新建。'
                : status === 'incomplete' ? '尚未完成完整目录检查，请继续分页；有名称筛选时需清除筛选后再判断。'
                  : `请核对候选的真实输入角色与目标；确认适用后直接使用服务器工作流。完整检查后所有候选都不适用时说明原因，${authorizationMode === 'automatic' ? '按自主授权根据服务器实际资源新建。' : '先询问用户是否新建。'}` }
        /** 字节预算可能截短本页，实际交付游标同样参与完整扫描证明。 */
        const result = pageResult('items', items, offset, page.total, {
          connectionId, instanceGeneration: page.instanceGeneration, snapshotId: page.snapshotId, checkedAt: page.checkedAt,
          capability: page.capability, snapshotOrigin: page.snapshotOrigin,
          ...(page.syncError ? { syncError: page.syncError } : {}),
          discovery,
          authorizationMode,
          selectedWorkflow: null, availableActions: ['media_read_remote_workflow', 'media_use_remote_workflow'],
        })
        const delivered = result.details as { items?: Record<string, unknown>[] }
        if (!delivered.items) {
          discoveryScans.delete(scanKey)
          return result
        }
        if (delivered.items.length < items.length) {
          if (contiguous) {
            discoveryScans.set(scanKey, { nextOffset: offset + delivered.items.length,
              candidates: priorScan.candidates + delivered.items.filter((item) => (item.match as { status?: string } | undefined)?.status === 'candidate').length,
              blocked: priorScan.blocked + delivered.items.filter((item) => item.canImport === false).length })
          }
          return toolResult({ ...delivered, discovery: status === 'unavailable' ? discovery
            : { status: 'incomplete', requiresUserConfirmation: false, canCreateWorkflowAutomatically: false,
              message: '本页摘要受大小限制，请沿 nextOffset 继续检查，尚不能判断服务器没有匹配工作流。' } })
        }
        return result
      },
    }),
    defineTool({
      name: 'media_use_remote_workflow', label: '使用服务器工作流',
      description: '直接使用已发现的服务器工作流。Host 自动解析并复用不可变执行快照，返回卡片配置所需版本；无需创建、导入或发布本地模板，不提交生成。内容变化时重新发现并核对。',
      parameters: Type.Object({
        descriptor: REMOTE_DESCRIPTOR_SCHEMA,
        contentHash: Type.String({ pattern: '^[a-f0-9]{64}$' }),
      }),
      execute: async (_toolCallId, params) => useRemoteWorkflowSnapshot(dependencies, context,
        params.descriptor as MediaRemoteDescriptor, params.contentHash, hasCanvasTarget),
    }),
    defineTool({
      name: 'media_import_remote_workflow', label: '接入远端工作流',
      description: '兼容历史接入调用，当前等同于 media_use_remote_workflow：Host 自动复用远端执行快照，不创建项目草稿或本地模板。旧 id/name/revision 参数仅保留调用兼容，请始终使用回执返回的新身份。',
      parameters: Type.Object({
        descriptor: REMOTE_DESCRIPTOR_SCHEMA,
        expectedContentHash: Type.String({ pattern: '^[a-f0-9]{64}$' }),
        id: Type.String({ pattern: IDENTIFIER_PATTERN }), name: Type.String({ minLength: 1, maxLength: 120 }),
        expectedConfigRevision: Type.Integer({ minimum: 0 }), expectedWorkflowRevision: Type.Integer({ minimum: 0 }),
      }),
      execute: async (_toolCallId, params) => useRemoteWorkflowSnapshot(dependencies, context,
        params.descriptor as MediaRemoteDescriptor, params.expectedContentHash, hasCanvasTarget),
    }),
    defineTool({
      name: 'media_import_remote_asset', label: '导入远端素材',
      description: '读取已发现的精确远端 asset 并登记为当前项目不可变素材；发现资源本身不会触发导入。',
      parameters: Type.Object({
        descriptor: REMOTE_DESCRIPTOR_SCHEMA,
        maxBytes: Type.Optional(Type.Integer({ minimum: 1, maximum: 128 * 1024 * 1024 })),
      }),
      execute: async (_toolCallId, params) => {
        authorize(dependencies, context, 'prepare')
        const content = await dependencies.resources.readRemoteAsset(
          params.descriptor as MediaRemoteDescriptor,
          context.projectId,
          params.maxBytes,
        )
        authorize(dependencies, context, 'prepare')
        const asset = await dependencies.registerRemoteAsset(context, {
          descriptor: content.descriptor,
          bytes: content.bytes,
          contentType: content.contentType,
        })
        return toolResult({ asset, descriptor: content.descriptor, truncated: false })
      },
    }),
    defineTool({
      name: 'media_list_api_models', label: '列出 API 媒体模型',
      description: '列出 Host 按当前项目和 Canvas scope 过滤后的图片、音频或视频 API 模型；不自动选择第一项。',
      parameters: Type.Object({
        canvasId: Type.Optional(Type.String({ pattern: IDENTIFIER_PATTERN })),
        offset: Type.Optional(Type.Integer({ minimum: 0 })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
      }),
      execute: async (_toolCallId, params) => {
        authorize(dependencies, context, 'read')
        const contextCanvasId = context.canvasAgentTarget?.canvasId
        if (context.canvasAgentMode === 'parent-orchestrated' && params.canvasId !== undefined
          && params.canvasId !== contextCanvasId) throw new Error('MEDIA_MODEL_SCOPE_INVALID')
        const canvasId = context.canvasAgentMode === 'parent-orchestrated' ? contextCanvasId : params.canvasId ?? contextCanvasId
        const candidates = (await dependencies.listModels(context, canvasId))
          .filter((candidate) => candidate.executor !== 'comfyui')
          .map((candidate) => ({
            profileId: candidate.profileId,
            name: candidate.name,
            modelId: candidate.modelId,
            executor: candidate.executor,
            mediaKind: candidate.mediaKind,
            available: candidate.available,
            ...(candidate.capabilities ? { capabilities: candidate.capabilities } : {}),
            ...(candidate.support ? { support: candidate.support } : {}),
            ...('channelId' in candidate ? { channelId: candidate.channelId } : {}),
            ...(candidate.unavailableReason ? { unavailableReason: candidate.unavailableReason } : {}),
          }))
        const offset = params.offset ?? 0
        return pageResult('models', candidates.slice(offset, offset + (params.limit ?? 30)), offset, candidates.length,
          { selectedModelId: null })
      },
    }),
    defineTool({
      name: 'media_list_profiles', label: '列出旧媒体预设',
      description: '兼容读取当前项目的旧媒体预设；新任务优先使用公共工作流或项目草稿。',
      parameters: Type.Object({ offset: Type.Optional(Type.Integer({ minimum: 0 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })) }),
      execute: async (_toolCallId, params) => {
        authorize(dependencies, context, 'read')
        const catalog = dependencies.configuration.listProject(context.projectId)
        const connections = new Map(catalog.connections.map((item) => [item.id, item]))
        const profiles = catalog.profiles.map((profile) => {
          const workflow = dependencies.configuration.getWorkflow(profile.workflowId, profile.workflowRevision, context.projectId)
          return { id: profile.id, name: profile.name, revision: profile.revision, mediaKind: profile.mediaKind, enabled: profile.enabled,
            available: profile.enabled && connections.get(profile.connectionId)?.enabled === true,
            workflow: { id: workflow.id, revision: workflow.revision, hash: workflow.hash },
            inputs: workflow.definition.bindings.map(({ key, kind }) => ({ key, kind })),
            outputs: workflow.definition.outputs.map(({ key, mediaType }) => ({ key, mediaType })),
          }
        })
        const items = [
          ...catalog.connections.map((connection) => ({ recordType: 'connection', ...connection })),
          ...catalog.workflows.map((workflow) => ({ recordType: 'workflow', ...workflow })),
          ...profiles.map((profile) => ({ recordType: 'profile', ...profile })),
        ]
        const offset = params.offset ?? 0
        return pageResult('items', items.slice(offset, offset + (params.limit ?? 30)), offset, items.length,
          { revision: catalog.revision, validationStatus: 'unverified', costEstimate: 'unknown' })
      },
    }),
    defineTool({
      name: 'media_list_resources', label: '查询媒体资源',
      description: '分页查询已连接 ComfyUI 的节点、模型、工作流或 assets。节点、模型、工作流首次拉取后持久保存，默认搜索和分页读取本地快照；需要更新目录时显式设置 refresh=true。同一快照也供画布使用。保留来源能力与精确 descriptor，不把可发现误报为可执行。',
      parameters: Type.Object({
        connectionId: Type.Optional(Type.String({ pattern: IDENTIFIER_PATTERN })),
        canvasId: Type.Optional(Type.String({ pattern: IDENTIFIER_PATTERN })),
        kind: Type.Union([Type.Literal('nodes'), Type.Literal('models'), Type.Literal('workflows'), Type.Literal('assets')]),
        query: Type.Optional(Type.String({ maxLength: 256 })), folder: Type.Optional(Type.String({ maxLength: 256 })),
        offset: Type.Optional(Type.Integer({ minimum: 0 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
        refresh: Type.Optional(Type.Boolean()),
      }),
      execute: async (_toolCallId, params) => {
        authorize(dependencies, context, 'read')
        if (params.kind === 'workflows' && params.limit !== undefined && params.limit > 20) throw new Error('MEDIA_RESOURCE_LIMIT_INVALID')
        /** 工作流页需要逐项读取摘要，缺省收紧为 10；其它资源维持 30。 */
        const limit = params.limit ?? (params.kind === 'workflows' ? 10 : 30)
        const connectionId = resolveMediaConnection(dependencies, context, params)
        const { canvasId: _canvasId, ...query } = params
        const page = await dependencies.resources.list({ ...query, connectionId, limit, projectId: context.projectId })
        const items = await Promise.all(page.items.map(async (item) => {
          const base = {
            id: item.id,
            name: item.name,
            category: item.category,
            supported: item.supported,
            ...(item.support === undefined ? {} : { support: item.support }),
            ...(item.source === undefined ? {} : { source: item.source }),
            ...(item.descriptor === undefined ? {} : { descriptor: item.descriptor }),
            ...(item.metadata === undefined ? {} : { metadata: item.metadata }),
          }
          if (params.kind !== 'workflows' || !item.descriptor) return base
          try {
            const workflow = await dependencies.resources.readWorkflow(item.descriptor, context.projectId)
            return { ...base, workflow: summarizeRemoteWorkflow(workflow) }
          } catch {
            return { ...base, workflow: { format: 'unknown', executable: false, inputs: [], outputs: [] } }
          }
        }))
        return pageResult('items', items, params.offset ?? 0, page.total,
          { connectionId: page.connectionId, instanceGeneration: page.instanceGeneration,
            remoteUser: page.remoteUser, snapshotId: page.snapshotId, checkedAt: page.checkedAt,
            source: page.source, capability: page.capability,
            ...(page.snapshotOrigin ? { snapshotOrigin: page.snapshotOrigin } : {}),
            ...(page.syncError ? { syncError: page.syncError } : {}),
            ...(page.modelFolders ? { modelFolders: page.modelFolders } : {}) })
      },
    }),
    defineTool({
      name: 'media_get_node_schema', label: '读取节点输入输出',
      description: '按已发现的准确 classType 从本地快照读取 ComfyUI 节点端口、标量约束、模型及安全选项；首次没有快照才拉取。可在编写工作流之前调用，需要更新时先调用 media_list_resources(kind=nodes, refresh=true)；不返回已有远端素材文件名。',
      parameters: Type.Object({ connectionId: Type.Optional(Type.String({ pattern: IDENTIFIER_PATTERN })),
        canvasId: Type.Optional(Type.String({ pattern: IDENTIFIER_PATTERN })),
        classTypes: Type.Array(Type.String({ minLength: 1, maxLength: 256 }), { minItems: 1, maxItems: 8 }) }),
      execute: async (_toolCallId, params) => {
        authorize(dependencies, context, 'read')
        return toolResult(summarizeSchema(await dependencies.resources.getSchema(resolveMediaConnection(dependencies, context, params), context.projectId, params.classTypes)))
      },
    }),
    defineTool({
      name: 'media_inspect_workflow', label: '检查媒体工作流',
      description: '检查已保存工作流、完整定义或原始 ComfyUI API prompt，分页返回节点、绑定、输出和兼容问题。',
      parameters: Type.Object({
        connectionId: Type.Optional(Type.String({ pattern: IDENTIFIER_PATTERN })),
        canvasId: Type.Optional(Type.String({ pattern: IDENTIFIER_PATTERN })),
        workflowId: Type.Optional(Type.String({ pattern: IDENTIFIER_PATTERN })), workflowRevision: Type.Optional(Type.Integer({ minimum: 1 })),
        definition: Type.Optional(Type.Unknown()), prompt: Type.Optional(Type.Unknown()),
        offset: Type.Optional(Type.Integer({ minimum: 0 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 32 })),
        includeSchema: Type.Optional(Type.Boolean()),
      }),
      execute: async (_toolCallId, params) => {
        authorize(dependencies, context, 'read')
        const definition = resolveWorkflow(dependencies, context, params)
        const classTypes = Object.values(definition.prompt).map((node) => node.class_type)
        const objectInfo = await dependencies.resources.getSchema(resolveMediaConnection(dependencies, context, params), context.projectId, classTypes)
        const inspection = inspectMediaWorkflow(definition, objectInfo, { offset: params.offset, limit: params.limit })
        const selectedClasses = new Set(inspection.nodes.map((node) => node.classType))
        return toolResult({ ...inspection, ...(params.includeSchema ? { schema: summarizeSchema(Object.fromEntries(Object.entries(objectInfo).filter(([name]) => selectedClasses.has(name)))) } : {}) })
      },
    }),
    defineTool({
      name: 'media_match_assets', label: '匹配媒体素材',
      description: '按类型、显式素材 ID 与语义角色匹配工作流输入，歧义或缺失必须由调用方处理。',
      parameters: Type.Object({
        workflowId: Type.Optional(Type.String({ pattern: IDENTIFIER_PATTERN })), workflowRevision: Type.Optional(Type.Integer({ minimum: 1 })),
        definition: Type.Optional(Type.Unknown()), prompt: Type.Optional(Type.Unknown()),
        explicitBindings: Type.Optional(Type.Record(Type.String({ pattern: IDENTIFIER_PATTERN }), Type.String({ pattern: IDENTIFIER_PATTERN }))),
      }),
      execute: async (_toolCallId, params) => {
        authorize(dependencies, context, 'read')
        const definition = resolveWorkflow(dependencies, context, params)
        const match = matchMediaWorkflowInputs(definition, await dependencies.listAssets(context), params.explicitBindings)
        return toolResult({ bindings: match.bindings, ambiguous: match.ambiguous, missing: match.missing, incompatible: match.incompatible,
          availableActions: dependencies.listSources && dependencies.importAssets ? ['media_list_sources', 'media_import_assets', 'media_list_assets'] : ['media_list_assets'] })
      },
    }),
    defineTool({
      name: 'media_save_local_workflow', label: '保存本地工作流',
      description: '新任务先检查服务器工作流，无匹配时根据实际模型和节点新建。authorizationMode=ask 时先取得用户同意并传 creationIntent=user-confirmed；automatic 时可直接新建并传 automatic-policy，Host 会复核当前设置。保存前校验真实节点接口、模型枚举、连线与输出；保存为本机跨项目复用模板，不提交生成。',
      parameters: Type.Object({
        id: Type.String({ pattern: IDENTIFIER_PATTERN }), name: Type.String({ minLength: 1, maxLength: 120 }),
        connectionId: Type.String({ pattern: IDENTIFIER_PATTERN }),
        creationIntent: WORKFLOW_CREATION_INTENT_SCHEMA,
        expectedConfigRevision: Type.Integer({ minimum: 0 }), expectedWorkflowRevision: Type.Integer({ minimum: 0 }),
        definition: Type.Unknown(),
      }),
      execute: async (_toolCallId, params) => {
        assertWorkflowCreationIntent(dependencies, params.creationIntent)
        authorize(dependencies, context, 'publish')
        /** 只读取当前图实际引用的节点 schema，模型名称必须匹配服务器的枚举。 */
        const definition = parseMediaWorkflowDefinition(params.definition)
        const connectionId = resolveMediaConnection(dependencies, context, params)
        const classTypes = [...new Set(Object.values(definition.prompt).map((node) => node.class_type))]
        const objectInfo = await dependencies.resources.getSchema(connectionId, context.projectId, classTypes)
        /** 服务器读取期间可能撤回自主授权，落盘前不能继续使用旧策略。 */
        assertWorkflowCreationIntent(dependencies, params.creationIntent)
        const validation = validateComfyWorkflow(definition, objectInfo)
        if (!validation.valid) throw new MediaWorkflowValidationError(validation.issues)
        const configuration = dependencies.configuration.read()
        if (latestRevision(configuration.workflows, params.id) !== params.expectedWorkflowRevision) throw new Error('MEDIA_WORKFLOW_PUBLISH_CONFLICT')
        authorize(dependencies, context, 'publish')
        const item = savedWorkflow(dependencies.configuration.saveWorkflow({ id: params.id, name: params.name,
          projectId: null, definition }, params.expectedConfigRevision), params.id)
        return toolResult({ id: item.id, name: item.name, revision: item.revision, hash: item.hash,
          connectionId, source: 'local-template', saved: true })
      },
    }),
    defineTool({
      name: 'media_save_workflow_draft', label: '保存媒体工作流草稿',
      description: '仅兼容项目旧流程；新建旧草稿须传 creationIntent=user-confirmed 或在用户已开启自主模式时传 automatic-policy。新任务直接使用服务器工作流，无匹配时按当前生成授权策略处理，并改用 media_save_local_workflow 保存。此入口不上传素材或执行生成。',
      parameters: Type.Object({
        id: Type.String({ pattern: IDENTIFIER_PATTERN }), name: Type.String({ minLength: 1, maxLength: 120 }),
        expectedConfigRevision: Type.Integer({ minimum: 0 }), expectedWorkflowRevision: Type.Integer({ minimum: 0 }),
        creationIntent: Type.Optional(WORKFLOW_CREATION_INTENT_SCHEMA),
        definition: Type.Unknown(),
      }),
      execute: async (_toolCallId, params) => {
        const item = saveProjectWorkflow(dependencies, context, params)
        return toolResult({ id: item.id, name: item.name, revision: item.revision, hash: item.hash, projectId: item.projectId })
      },
    }),
    defineTool({
      name: 'media_publish_workflow', label: '发布公共媒体工作流',
      description: '在明确发布意图和执行权限下，把 API 工作流保存为所有项目可发现的不可变公共版本；不执行生成。',
      parameters: Type.Object({
        id: Type.String({ pattern: IDENTIFIER_PATTERN }),
        name: Type.String({ minLength: 1, maxLength: 120 }),
        expectedConfigRevision: Type.Integer({ minimum: 0 }),
        expectedWorkflowRevision: Type.Integer({ minimum: 0 }),
        publishIntent: Type.Literal('explicit'),
        definition: Type.Unknown(),
      }),
      execute: async (_toolCallId, params) => {
        if (params.publishIntent !== 'explicit') throw new Error('MEDIA_PUBLISH_INTENT_REQUIRED')
        authorize(dependencies, context, 'publish')
        const configuration = dependencies.configuration.read()
        if (latestRevision(configuration.workflows, params.id) !== params.expectedWorkflowRevision) {
          throw new Error('MEDIA_WORKFLOW_PUBLISH_CONFLICT')
        }
        const definition = parseMediaWorkflowDefinition(params.definition)
        authorize(dependencies, context, 'publish')
        const item = savedWorkflow(dependencies.configuration.saveWorkflow({
          id: params.id,
          name: params.name,
          projectId: null,
          definition,
        }, params.expectedConfigRevision), params.id)
        return toolResult({ id: item.id, name: item.name, revision: item.revision,
          hash: item.hash, projectId: item.projectId, published: true })
      },
    }),
    defineTool({
      name: 'media_save_profile', label: '保存媒体预设',
      description: '兼容旧流程，把连接与固定工作流版本保存为当前项目预设；新任务无需创建预设。',
      parameters: Type.Object({
        id: Type.String({ pattern: IDENTIFIER_PATTERN }), name: Type.String({ minLength: 1, maxLength: 120 }),
        connectionId: Type.String({ pattern: IDENTIFIER_PATTERN }), workflowId: Type.String({ pattern: IDENTIFIER_PATTERN }),
        workflowRevision: Type.Integer({ minimum: 1 }), mediaKind: Type.Union([Type.Literal('image'), Type.Literal('video'), Type.Literal('audio')]),
        enabled: Type.Boolean(), expectedConfigRevision: Type.Integer({ minimum: 0 }), expectedProfileRevision: Type.Optional(Type.Integer({ minimum: 0 })),
      }),
      execute: async (_toolCallId, params) => {
        authorize(dependencies, context, 'publish')
        const catalog = dependencies.configuration.listProject(context.projectId)
        if (latestRevision(catalog.profiles, params.id) !== (params.expectedProfileRevision ?? 0)) throw new Error('MEDIA_PROFILE_CONFLICT')
        dependencies.configuration.getWorkflow(params.workflowId, params.workflowRevision, context.projectId)
        authorize(dependencies, context, 'publish')
        const configuration = dependencies.configuration.saveProfile({
          id: params.id,
          name: params.name,
          connectionId: params.connectionId,
          workflowId: params.workflowId,
          workflowRevision: params.workflowRevision,
          mediaKind: params.mediaKind,
          projectId: context.projectId,
          enabled: params.enabled,
        }, params.expectedConfigRevision)
        const profile = configuration.profiles.filter((item) => item.id === params.id).sort((left, right) => right.revision - left.revision)[0]
        if (!profile) throw new Error('MEDIA_PROFILE_SAVE_FAILED')
        return toolResult({ id: profile.id, name: profile.name, revision: profile.revision, projectId: profile.projectId, mediaKind: profile.mediaKind })
      },
    }),
    defineTool({
      name: 'media_prepare_run', label: '准备媒体生成',
      description: '仅用于无 Canvas 目标的独立任务，或父工作流接管准备。面向画布生成时先创建/复用图片、音频、视频卡片，用 canvas_update_image_config/canvas_update_media_config 保存版本和参数，再 canvas_run_nodes。独立任务固定已发布预设或项目 API workflow 版本、素材版本和主体，只做静态预检。父编排必须指定直接下游 targetNodeId，由父调度器提交同一 run。',
      parameters: Type.Object({
        profileId: Type.Optional(Type.String({ pattern: IDENTIFIER_PATTERN })),
        profileRevision: Type.Optional(Type.Integer({ minimum: 1 })),
        workflowId: Type.Optional(Type.String({ pattern: IDENTIFIER_PATTERN })),
        workflowRevision: Type.Optional(Type.Integer({ minimum: 1 })),
        connectionId: Type.Optional(Type.String({ pattern: IDENTIFIER_PATTERN })),
        canvasId: Type.Optional(Type.String({ pattern: IDENTIFIER_PATTERN })),
        mediaKind: Type.Optional(Type.Union([Type.Literal('image'), Type.Literal('video'), Type.Literal('audio')])),
        inputs: Type.Record(Type.String({ pattern: '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$' }), Type.Unknown()),
        targetNodeId: Type.Optional(Type.String({ pattern: IDENTIFIER_PATTERN })),
      }),
      execute: async (toolCallId, params) => {
        authorize(dependencies, context, 'prepare')
        const profileSelected = params.profileId !== undefined || params.profileRevision !== undefined
        const draftSelected = params.workflowId !== undefined || params.workflowRevision !== undefined
          || params.connectionId !== undefined || params.mediaKind !== undefined
        if (profileSelected === draftSelected
          || (profileSelected && (params.profileId === undefined || params.profileRevision === undefined))
          || (draftSelected && (params.workflowId === undefined || params.workflowRevision === undefined
            || params.mediaKind === undefined))) {
          throw new Error('MEDIA_RUN_SOURCE_INVALID')
        }
        const operationId = createHash('sha256').update(JSON.stringify([context.projectId, context.sessionId, context.runStartedAt, toolCallId])).digest('hex')
        if (!preparedOperations.has(operationId) && preparedOperations.size >= MAX_RUNS_PER_TURN) throw new Error('MEDIA_RUN_BUDGET_EXCEEDED')
        authorize(dependencies, context, 'prepare')
        const parentMode = context.canvasAgentMode === 'parent-orchestrated'
        if (parentMode && (!dependencies.prepareParentRun || !params.targetNodeId || !context.parentWorkflow)) throw new Error('MEDIA_PARENT_HANDOFF_REQUIRED')
        /** 明确 Canvas 目标或本轮节点引用须先保存节点配置，防止错误与参数只留在独立任务里。 */
        if (!parentMode && (params.targetNodeId || resolveMediaCanvasId(context, params.canvasId)
          || hasCanvasTarget)) throw new Error('MEDIA_CANVAS_TARGET_USE_CANVAS_TOOLS')
        const inputs = params.inputs as Record<string, MediaInputValue>
        const selector = profileSelected
          ? { profileId: params.profileId!, profileRevision: params.profileRevision! }
          : { workflowId: params.workflowId!, workflowRevision: params.workflowRevision!,
              connectionId: resolveMediaConnection(dependencies, context, params), mediaKind: params.mediaKind! }
        const snapshot = parentMode
          ? await dependencies.prepareParentRun!(context, { targetNodeId: params.targetNodeId!, operationId, inputs,
              ...selector } as PrepareCanvasMediaHandoffInput, originFor(context))
          : profileSelected
            ? await dependencies.runs.prepare({ projectId: context.projectId, operationId, inputs,
                profileId: params.profileId!, profileRevision: params.profileRevision! }, originFor(context))
            : await (() => {
                if (!dependencies.runs.prepareDraft) throw new Error('MEDIA_DRAFT_RUN_UNAVAILABLE')
                return dependencies.runs.prepareDraft({ projectId: context.projectId, operationId, inputs,
                workflowId: params.workflowId!, workflowRevision: params.workflowRevision!,
                connectionId: selector.connectionId!, mediaKind: params.mediaKind! }, originFor(context))
              })()
        preparedOperations.add(operationId)
        return toolResult(snapshot as unknown as Record<string, unknown>)
      },
    }),
    defineTool({
      name: 'media_execute_run', label: '执行媒体生成',
      description: '启动已经准备且属于本次 Agent 的任务；上传、编译、提交与收集由统一监督器推进。',
      parameters: Type.Object({ runId: Type.String({ minLength: 1, maxLength: 128 }), expectedRevision: Type.Integer({ minimum: 0 }) }),
      execute: async (_toolCallId, params) => {
        authorize(dependencies, context, 'execute', params.runId)
        requireOwnedRun(dependencies, context, params.runId)
        authorize(dependencies, context, 'execute', params.runId)
        if (!executedRuns.has(params.runId) && executedRuns.size >= MAX_RUNS_PER_TURN) throw new Error('MEDIA_RUN_BUDGET_EXCEEDED')
        const result = dependencies.supervisor.start(context.projectId, params.runId, params.expectedRevision)
        executedRuns.add(params.runId)
        return toolResult(result as unknown as Record<string, unknown>)
      },
    }),
    defineTool({
      name: 'media_get_run', label: '查询媒体任务', description: '读取属于本次 Agent 的媒体任务进度和产物摘要，不触发远端生成。',
      parameters: Type.Object({ runId: Type.String({ minLength: 1, maxLength: 128 }) }),
      execute: async (_toolCallId, params) => {
        authorize(dependencies, context, 'read', params.runId); requireOwnedRun(dependencies, context, params.runId)
        return toolResult(dependencies.runs.get(context.projectId, params.runId) as unknown as Record<string, unknown>)
      },
    }),
    defineTool({
      name: 'media_wait_run', label: '等待媒体任务', description: '等待任务 revision 变化或终态，最长 30 秒；停止等待不会取消远端任务。',
      parameters: Type.Object({ runId: Type.String({ minLength: 1, maxLength: 128 }), afterRevision: Type.Optional(Type.Integer({ minimum: 0 })), timeoutMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 30000 })) }),
      execute: async (_toolCallId, params, signal) => {
        authorize(dependencies, context, 'read', params.runId); requireOwnedRun(dependencies, context, params.runId)
        dependencies.supervisor.watch(context.projectId, params.runId)
        return toolResult(await dependencies.supervisor.wait(context.projectId, params.runId, params.timeoutMs, params.afterRevision, signal) as unknown as Record<string, unknown>)
      },
    }),
    defineTool({
      name: 'media_cancel_run', label: '取消媒体任务', description: '取消属于本次 Agent 的指定任务；必须明确声明取消意图，远端运行中任务不会调用全局中断。',
      parameters: Type.Object({ runId: Type.String({ minLength: 1, maxLength: 128 }), cancelIntent: Type.Literal('explicit') }),
      execute: async (_toolCallId, params) => {
        if (params.cancelIntent !== 'explicit') throw new Error('MEDIA_CANCEL_INTENT_REQUIRED')
        authorize(dependencies, context, 'cancel', params.runId); requireOwnedRun(dependencies, context, params.runId)
        authorize(dependencies, context, 'cancel', params.runId)
        return toolResult(await dependencies.runs.cancel(context.projectId, params.runId) as unknown as Record<string, unknown>)
      },
    }),
    defineTool({
      name: 'media_list_assets', label: '列出媒体素材', description: '分页列出当前项目已授权素材的稳定引用、角色和技术元数据，不返回本地路径。',
      parameters: Type.Object({ offset: Type.Optional(Type.Integer({ minimum: 0 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_ASSET_RESULTS })) }),
      execute: async (_toolCallId, params) => {
        authorize(dependencies, context, 'read')
        const offset = params.offset ?? 0; const limit = params.limit ?? 30
        const candidates = await dependencies.listAssets(context)
        return pageResult('assets', candidates.slice(offset, offset + limit), offset, candidates.length)
      },
    }),
  ]

  if (dependencies.listSources && dependencies.importAssets) {
    tools.push(defineTool({
      name: 'media_list_sources', label: '列出可导入媒体来源', description: '列出当前会话已授权的附件来源；sourceRef 是不透明标识，不是本地路径。',
      parameters: Type.Object({}),
      execute: async () => {
        authorize(dependencies, context, 'read')
        return toolResult({ sources: await dependencies.listSources!(context), truncated: false })
      },
    }), defineTool({
      name: 'media_import_assets', label: '导入媒体素材', description: '把当前会话已授权的不透明来源登记为项目媒体资产，不接受绝对路径。',
      parameters: Type.Object({ sourceRefs: Type.Array(Type.String({ minLength: 1, maxLength: 2048 }), { minItems: 1, maxItems: 32 }) }),
      execute: async (_toolCallId, params) => {
        authorize(dependencies, context, 'prepare')
        if (new Set(params.sourceRefs).size !== params.sourceRefs.length) throw new Error('MEDIA_SOURCE_NOT_AUTHORIZED')
        authorize(dependencies, context, 'prepare')
        return toolResult({ assets: await dependencies.importAssets!(context, params.sourceRefs), truncated: false })
      },
    }))
  }

  if (dependencies.importLocalFile) {
    tools.push(defineTool({
      name: 'media_import_local_file', label: '导入本地媒体文件',
      description: '把 Shell 或 Skill 在当前 Agent cwd、项目目录或本会话已授权附加目录生成的一个明确图片、音频或视频文件登记为项目媒体资产；不扫描目录，也不返回本地路径。',
      parameters: Type.Object({
        path: Type.String({ minLength: 1, maxLength: 4_096 }),
        mediaKind: Type.Union([Type.Literal('image'), Type.Literal('audio'), Type.Literal('video')]),
      }, { additionalProperties: false }),
      execute: async (_toolCallId, params) => {
        if (context.permissionCeiling !== 'execute' || context.canvasAgentMode === 'parent-orchestrated') {
          throw new Error('MEDIA_LOCAL_IMPORT_NOT_AUTHORIZED')
        }
        authorize(dependencies, context, 'prepare')
        /** 文件路径解析和实际媒体探测都留在 Host 服务；工具层不持久化或回显路径。 */
        const asset = await dependencies.importLocalFile!(context, params)
        authorize(dependencies, context, 'prepare')
        return toolResult({ asset, truncated: false })
      },
    }))
  }

  if (dependencies.getAssetFile) {
    tools.push(defineTool({
      name: 'media_get_asset_file', label: '获取媒体资产文件',
      description: '把当前项目的可信媒体资产引用解析为已验证本地文件及技术元数据，供 ffmpeg 或分析 Skill 使用；不能传入任意路径或扩大授权目录。',
      parameters: Type.Object({
        asset: Type.Object({
          assetId: Type.String({ minLength: 1, maxLength: 256 }),
          revision: Type.Integer({ minimum: 1 }),
          hash: Type.String({ pattern: '^[a-f0-9]{64}$' }),
          mediaKind: Type.Union([Type.Literal('image'), Type.Literal('audio'), Type.Literal('video')]),
        }, { additionalProperties: false }),
      }, { additionalProperties: false }),
      execute: async (_toolCallId, params) => {
        if (context.canvasAgentMode === 'parent-orchestrated') throw new Error('MEDIA_ASSET_FILE_NOT_AUTHORIZED')
        authorize(dependencies, context, 'read')
        const file = await dependencies.getAssetFile!(context, params.asset)
        authorize(dependencies, context, 'read')
        return toolResult({ file, truncated: false })
      },
    }))
  }

  /** 稳定工具顺序把资源、公共工作流和 API 模型放在旧 profile 兼容入口之前。 */
  const toolOrder = new Map<string, number>(MEDIA_TOOL_NAMES.map((name, index) => [name, index]))
  tools.sort((left, right) => (toolOrder.get(left.name) ?? Number.MAX_SAFE_INTEGER)
    - (toolOrder.get(right.name) ?? Number.MAX_SAFE_INTEGER))

  /** schema 可见性和运行时守卫使用同一模式投影；未来新增工具默认不会进入列表。 */
  const executionOnlyTools = ['media_execute_run', 'media_cancel_run', 'media_publish_workflow', 'media_save_local_workflow', 'media_save_profile', 'media_import_local_file']
  const visible = tools.filter((tool) => (
    (isExecutionCapable || !executionOnlyTools.includes(tool.name))
    && (context.canvasAgentMode !== 'parent-orchestrated' || tool.name !== 'media_get_asset_file')
  )).map((tool) => ({
    ...tool,
    execute: async (...args: Parameters<typeof tool.execute>) => {
      try {
        const result = await tool.execute(...args)
        /** 目录、模型和字段检查共用画布作用域，后续省略参数也不能退回独立生成。 */
        if (['media_list_workflows', 'media_list_resources', 'media_discover_workflows',
          'media_inspect_workflow', 'media_get_node_schema', 'media_list_api_models'].includes(tool.name)
          && args[1] && typeof args[1] === 'object' && 'canvasId' in args[1]
          && typeof args[1].canvasId === 'string') hasCanvasTarget = true
        if (!isExecutionCapable && result.details && typeof result.details === 'object' && !Array.isArray(result.details)) {
          const details = result.details as Record<string, unknown>
          if (Array.isArray(details.availableActions)) {
            const actions = details.availableActions.filter((action) => !executionOnlyTools.includes(String(action)))
            const projected = { ...details, availableActions: actions,
              ...(context.canvasAgentMode === 'parent-orchestrated' && details.phase === 'prepared' ? { awaitingParentScheduler: true } : {}) }
            return { ...result, content: [{ type: 'text' as const, text: JSON.stringify(projected) }], details: projected }
          }
        }
        return result
      } catch (error) {
        /** 仅放行由本模块创建的脱敏结构错误，禁止回显任意异常正文。 */
        if (error instanceof MediaWorkflowValidationError || error instanceof MediaRemoteWorkflowImportError) throw error
        const message = error instanceof Error ? error.message : ''
        const code = /^(?:MEDIA|COMFY|CANVAS)_[A-Z_]+(?::|$)/.exec(message)?.[0].replace(/:$/, '') ?? 'MEDIA_OPERATION_FAILED'
        throw new Error(code === 'COMFY_UI_WORKFLOW_UNSUPPORTED' ? `${code}: 请从 ComfyUI 导出 API Format 工作流` : code)
      }
    },
  }))
  return {
    systemPromptAppend: `面向画布生成时，先用 canvas_get_context 和 canvas_read 复用目标卡片；尚无卡片时图片用 canvas_create_artifact，音视频用 canvas_create_media 创建，再发现与分析工作流。通过 media_list_workflows(canvasId) 读取画布绑定服务器、当前 authorizationMode，并查询 API 模型。
生成授权由用户设置决定：ask 为每次确认；automatic 为 Agent 自主执行，已授权你围绕当前任务连续选型、配置、生成、检查和采用合适候选后继续，不要对已授权的常规步骤反复询问。自主权限不代表无限重试或扩大任务范围，仍遵守当前预算、计划模式、项目边界及用户停止要求；提交结果未知时只恢复原任务，不重复提交。采用前完成实际可用的内容检查，不把 metadataOnly 当成看过视频或听过音频，也不跳过工具要求的版本与候选身份。
新任务优先查看 ComfyUI 服务器工作流：除用户明确指定本地模板或恢复原任务外，必须先调用 media_discover_workflows，传入目标媒体类型与真实媒体输入数量；普通 Agent 传 canvasId，画布 Agent 自动使用固定画布。未绑定时保留待配置卡片，请用户选择服务器，不默认选第一台。根据真实节点、标题、输入角色和输出核对语义适配性，不按文件名或数量相同认定首尾帧匹配。UI 格式先走转换分析。选定候选后，用精确 descriptor 和 contentHash 调用 media_use_remote_workflow 直接使用，Host 自动保留内部执行快照，无需用户创建、导入、发布模板，也不要另存项目草稿。再用 media_inspect_workflow 和 media_match_assets 读取真实字段、默认值和素材。
分页未完成须继续 nextOffset，名称筛选无结果须清除筛选；目录读取失败、同步失败和转换失败都不能当作没有匹配。完整检查仍无语义匹配时说明缺口：ask 模式先询问用户是否根据服务器已有模型和节点生成工作流并保存本地，明确同意后传 creationIntent=user-confirmed；automatic 模式可直接生成并传 creationIntent=automatic-policy，无需再次确认。两种模式都必须用 media_list_resources 查询实际 models/nodes，用 media_get_node_schema 和 media_inspect_workflow 验证接口、模型枚举、连线与输出，再调用 media_save_local_workflow 保存本地模板，禁止虚构模型或节点。权限以工具回执和 Host 最新设置为准，不能自行改变授权模式。
立即用 canvas_update_image_config 或 canvas_update_media_config 固定工作流版本、连接和已知 typed 输入，缺失字段省略并留给用户补齐；不能虚构素材或连线。分析失败时在原卡片 preparation 中保存错误码及节点、字段、中文原因，原始响应和凭据不得写入诊断。参数满足要求且用户已要求生成时，清除 preparation 并调用 canvas_run_nodes，原卡片展示进度、错误和产物。普通画布任务不走独立 media_prepare_run；无 Canvas 目标的独立媒体任务和父编排 handoff 保持原入口。
发现、使用和保存不会生成，执行和取消按当前生成授权处理；旧导入、项目草稿、公共发布和 profile 工具只兼容用户明确要求维护的历史流程，不作为新任务默认路径。只有 media_import_local_file 可接收 Shell 或 Skill 在当前授权根生成的明确本地文件路径；已有资产交给 ffmpeg 或分析 Skill 时使用 media_get_asset_file，并原样传入 MediaAssetRef。其它媒体工具不要传入项目 ID、Agent 身份、本地路径、远端素材名或凭据。`,
    piCustomTools: visible,
    allowedToolNames: visible.map((tool) => tool.name),
    allowedToolNamesMode: 'extend',
    singleApprovalToolNames: isExecutionCapable ? ['media_execute_run', 'media_cancel_run'] : [],
    toolApprovalPolicy: {
      /** 策略只对明确列出的工具及可执行上下文生效，实时读取用户设置。 */
      getMode: (toolName) => isExecutionCapable && MEDIA_AUTOMATION_TOOL_NAMES.has(toolName)
        ? mediaAuthorizationMode(dependencies) : 'ask',
      /** 仅等待审批时订阅设置事件，不轮询配置或远端服务器。 */
      subscribe: (listener) => dependencies.configuration.subscribeAuthorizationMode?.(listener) ?? (() => {}),
    },
  }
}
