import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { AgentToolResult } from '@earendil-works/pi-agent-core'
import type {
  ComfyPrompt,
  MediaAssetRef,
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
import { COMFY_CORE_NODE_CONTRACTS } from './comfyui-workflow'
import type { MediaConfigStore } from './media-config-store'
import type { MediaAssetFile } from './media-source-service'
import type { MediaResourceService } from './media-resource-service'
import type { MediaRunOrigin, MediaRunService } from './media-run-service'
import type { MediaRunSupervisor } from './media-run-supervisor'
import { inspectMediaWorkflow, matchMediaWorkflowInputs } from './media-workflow-inspection'
import type { MediaInputCandidate } from './media-workflow-inspection'
import type { PrepareCanvasMediaHandoffInput } from '../design/canvas-media-handoff-service'

const MAX_TOOL_RESPONSE_BYTES = 32 * 1024
const MAX_RUNS_PER_TURN = 8
const MAX_ASSET_RESULTS = 100
const IDENTIFIER_PATTERN = '^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$'

/** 首版固定注册的媒体工具；来源导入工具仅在 Host 提供适配器时追加。 */
export const MEDIA_TOOL_NAMES = [
  'media_list_workflows',
  'media_list_resources',
  'media_read_remote_workflow',
  'media_import_remote_asset',
  'media_list_api_models',
  'media_get_node_schema',
  'media_inspect_workflow',
  'media_match_assets',
  'media_save_workflow_draft',
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
  configuration: Pick<MediaConfigStore, 'listProject' | 'read' | 'getWorkflow' | 'saveWorkflow' | 'saveProfile' | 'resolveProfile'>
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
  /** 父编排 child 准备只能登记到原工作流计划内的精确媒体目标。 */
  prepareParentRun?(context: CanvasToolRunContext, input: PrepareCanvasMediaHandoffInput, origin: MediaRunOrigin): Promise<MediaRunSnapshot>
}

interface WorkflowSelector {
  workflowId?: string
  workflowRevision?: number
  definition?: unknown
  prompt?: unknown
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

/** 为远端工作流目录提取可选择摘要；只有 API 图可能进入后续检查和保存。 */
function summarizeRemoteWorkflow(workflow: MediaRemoteWorkflow): Record<string, unknown> {
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
  const preparedOperations = new Set<string>()
  const executedRuns = new Set<string>()
  const isExecutionCapable = context.permissionCeiling === 'execute' && context.canvasAgentMode !== 'parent-orchestrated'

  const tools: ToolDefinition[] = [
    defineTool({
      name: 'media_list_workflows', label: '列出媒体工作流',
      description: '分页列出 Proma 当前项目可见的公共工作流和项目草稿全部不可变版本，包含字段输入与媒体输出摘要；不会默认选择第一项。',
      parameters: Type.Object({
        offset: Type.Optional(Type.Integer({ minimum: 0 })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
      }),
      execute: async (_toolCallId, params) => {
        authorize(dependencies, context, 'read')
        const catalog = dependencies.configuration.listProject(context.projectId)
        const latest = new Map<string, number>()
        for (const item of catalog.workflows) latest.set(item.id, Math.max(latest.get(item.id) ?? 0, item.revision))
        const workflows = catalog.workflows.map((summary) => {
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
          selectedConnection: null,
        })
      },
    }),
    defineTool({
      name: 'media_read_remote_workflow', label: '读取远端工作流',
      description: '读取已从同一连接代次和远端用户目录发现的工作流正文；只读取精确 descriptor，不执行或保存。',
      parameters: Type.Object({ descriptor: REMOTE_DESCRIPTOR_SCHEMA }),
      execute: async (_toolCallId, params) => {
        authorize(dependencies, context, 'read')
        const workflow = await dependencies.resources.readWorkflow(params.descriptor as MediaRemoteDescriptor, context.projectId)
        return toolResult({ descriptor: workflow.descriptor, format: workflow.format,
          workflow: summarizeRemoteWorkflow(workflow), definition: workflow.definition })
      },
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
        connectionId: Type.String({ pattern: IDENTIFIER_PATTERN }),
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
        const page = await dependencies.resources.list({ ...params, limit, projectId: context.projectId })
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
      parameters: Type.Object({ connectionId: Type.String({ pattern: IDENTIFIER_PATTERN }),
        classTypes: Type.Array(Type.String({ minLength: 1, maxLength: 256 }), { minItems: 1, maxItems: 8 }) }),
      execute: async (_toolCallId, params) => {
        authorize(dependencies, context, 'read')
        return toolResult(summarizeSchema(await dependencies.resources.getSchema(params.connectionId, context.projectId, params.classTypes)))
      },
    }),
    defineTool({
      name: 'media_inspect_workflow', label: '检查媒体工作流',
      description: '检查已保存工作流、完整定义或原始 ComfyUI API prompt，分页返回节点、绑定、输出和兼容问题。',
      parameters: Type.Object({
        connectionId: Type.String({ pattern: IDENTIFIER_PATTERN }),
        workflowId: Type.Optional(Type.String({ pattern: IDENTIFIER_PATTERN })), workflowRevision: Type.Optional(Type.Integer({ minimum: 1 })),
        definition: Type.Optional(Type.Unknown()), prompt: Type.Optional(Type.Unknown()),
        offset: Type.Optional(Type.Integer({ minimum: 0 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 32 })),
        includeSchema: Type.Optional(Type.Boolean()),
      }),
      execute: async (_toolCallId, params) => {
        authorize(dependencies, context, 'read')
        const definition = resolveWorkflow(dependencies, context, params)
        const classTypes = Object.values(definition.prompt).map((node) => node.class_type)
        const objectInfo = await dependencies.resources.getSchema(params.connectionId, context.projectId, classTypes)
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
      name: 'media_save_workflow_draft', label: '保存媒体工作流草稿',
      description: '把有界 ComfyUI API 图保存为当前项目的不可变草稿版本；不上传素材，也不执行生成。',
      parameters: Type.Object({
        id: Type.String({ pattern: IDENTIFIER_PATTERN }), name: Type.String({ minLength: 1, maxLength: 120 }),
        expectedConfigRevision: Type.Integer({ minimum: 0 }), expectedWorkflowRevision: Type.Integer({ minimum: 0 }),
        definition: Type.Unknown(),
      }),
      execute: async (_toolCallId, params) => {
        authorize(dependencies, context, 'draft')
        const catalog = dependencies.configuration.listProject(context.projectId)
        const branchPrefix = createHash('sha256').update(JSON.stringify([context.sessionId, context.runStartedAt])).digest('hex').slice(0, 24)
        const expectedPrefix = `branch-${branchPrefix}-`
        const id = context.canvasAgentMode === 'parent-orchestrated'
          ? params.id.startsWith(expectedPrefix)
            ? params.id
            : params.id.startsWith('branch-')
              ? (() => { throw new Error('MEDIA_WORKFLOW_DRAFT_SCOPE_INVALID') })()
              : `${expectedPrefix}${params.id.slice(0, 80)}`
          : params.id
        if (latestRevision(catalog.workflows, id) !== params.expectedWorkflowRevision) throw new Error('MEDIA_WORKFLOW_DRAFT_CONFLICT')
        const definition = parseMediaWorkflowDefinition(params.definition)
        authorize(dependencies, context, 'draft')
        const item = savedWorkflow(dependencies.configuration.saveWorkflow({ id, name: params.name, projectId: context.projectId, definition }, params.expectedConfigRevision), id)
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
      description: '固定已发布预设或项目私有 API workflow 草稿 revision、输入素材版本和发起主体，只做静态预检。两类来源严格互斥。父编排必须指定直接下游 targetNodeId，并先把节点输入固定为 literal 或稳定正式素材；不要引用自己本轮尚未提交的 agent.text。准备后由父调度器提交同一 run。',
      parameters: Type.Object({
        profileId: Type.Optional(Type.String({ pattern: IDENTIFIER_PATTERN })),
        profileRevision: Type.Optional(Type.Integer({ minimum: 1 })),
        workflowId: Type.Optional(Type.String({ pattern: IDENTIFIER_PATTERN })),
        workflowRevision: Type.Optional(Type.Integer({ minimum: 1 })),
        connectionId: Type.Optional(Type.String({ pattern: IDENTIFIER_PATTERN })),
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
            || params.connectionId === undefined || params.mediaKind === undefined))) {
          throw new Error('MEDIA_RUN_SOURCE_INVALID')
        }
        const operationId = createHash('sha256').update(JSON.stringify([context.projectId, context.sessionId, context.runStartedAt, toolCallId])).digest('hex')
        if (!preparedOperations.has(operationId) && preparedOperations.size >= MAX_RUNS_PER_TURN) throw new Error('MEDIA_RUN_BUDGET_EXCEEDED')
        authorize(dependencies, context, 'prepare')
        const parentMode = context.canvasAgentMode === 'parent-orchestrated'
        if (parentMode && (!dependencies.prepareParentRun || !params.targetNodeId || !context.parentWorkflow)) throw new Error('MEDIA_PARENT_HANDOFF_REQUIRED')
        if (!parentMode && params.targetNodeId) throw new Error('MEDIA_CANVAS_TARGET_USE_CANVAS_TOOLS')
        const inputs = params.inputs as Record<string, MediaInputValue>
        const selector = profileSelected
          ? { profileId: params.profileId!, profileRevision: params.profileRevision! }
          : { workflowId: params.workflowId!, workflowRevision: params.workflowRevision!,
              connectionId: params.connectionId!, mediaKind: params.mediaKind! }
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
                connectionId: params.connectionId!, mediaKind: params.mediaKind! }, originFor(context))
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
  const executionOnlyTools = ['media_execute_run', 'media_cancel_run', 'media_publish_workflow', 'media_save_profile', 'media_import_local_file']
  const visible = tools.filter((tool) => (
    (isExecutionCapable || !executionOnlyTools.includes(tool.name))
    && (context.canvasAgentMode !== 'parent-orchestrated' || tool.name !== 'media_get_asset_file')
  )).map((tool) => ({
    ...tool,
    execute: async (...args: Parameters<typeof tool.execute>) => {
      try {
        const result = await tool.execute(...args)
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
        const message = error instanceof Error ? error.message : ''
        const code = /^(?:MEDIA|COMFY|CANVAS)_[A-Z_]+(?::|$)/.exec(message)?.[0].replace(/:$/, '') ?? 'MEDIA_OPERATION_FAILED'
        throw new Error(code === 'COMFY_UI_WORKFLOW_UNSUPPORTED' ? `${code}: 请从 ComfyUI 导出 API Format 工作流` : code)
      }
    },
  }))
  return {
    systemPromptAppend: '媒体任务先列出公共工作流、API 模型和可用资源，再显式选择精确版本、连接与素材；不要默认选择第一项。远端资源可发现不代表可执行，读取、导入、保存和运行必须使用返回的精确身份。项目草稿保持项目隔离；公共发布必须明确声明 publishIntent。旧 profile 工具仅用于兼容历史流程。准备不会生成，执行和取消需要用户单次批准。只有 media_import_local_file 可接收 Shell 或 Skill 在当前会话授权根生成的明确本地文件路径；已有资产需要交给 ffmpeg 或分析 Skill 时使用 media_get_asset_file，并原样传入 MediaAssetRef。其它媒体工具不要传入项目 ID、Agent 身份、本地路径、远端素材名或凭据。',
    piCustomTools: visible,
    allowedToolNames: visible.map((tool) => tool.name),
    allowedToolNamesMode: 'extend',
    singleApprovalToolNames: isExecutionCapable ? ['media_execute_run', 'media_cancel_run'] : [],
  }
}
