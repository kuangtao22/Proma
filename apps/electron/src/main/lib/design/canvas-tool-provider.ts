import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { AgentToolResult } from '@earendil-works/pi-agent-core'
import type {
  AgentCanvasBinding,
  AgentSendInput,
  CanvasBatchOperationEnvelope,
  CanvasDocument,
  CanvasMutation,
  CanvasNode,
  CanvasNodeReference,
  CanvasSessionMeta,
  CanvasTarget,
  CanvasWorkspaceSnapshot,
} from '@proma/shared'
import { parseCanvasBatchOperationEnvelope } from '@proma/shared'
import { Type } from 'typebox'
import type { TSchema } from 'typebox'
import type { AgentRunExtensions } from '../agent-run-extensions'
import type { CanvasBatchOperationResult } from './canvas-agent-batch-operation'

const MAX_READ_NODES = 32
const MAX_READ_CHARS = 32_768

/** 普通项目 Agent 单轮可用的五个 Canvas 工具。 */
export const CANVAS_TOOL_NAMES = [
  'canvas_get_context',
  'canvas_manage',
  'canvas_read',
  'canvas_apply_changes',
  'canvas_run_nodes',
] as const

export type CanvasToolUserIntent = 'discuss' | 'plan' | 'execute'

/** Canvas 领域词只描述可操作对象，不依赖 Renderer 页面名称。 */
const CANVAS_DOMAIN_PATTERN = /(?:画布|节点|连线|图片|原型|canvas|nodes?|edges?|connections?|images?|prototypes?)/i
/** 问询和分析语义优先保持只读，避免“如何创建”被动作词误判为执行。 */
const DISCUSS_INTENT_PATTERN = /(?:如何|怎么|怎样|能否|是否|为什么|分析|解释|说明|评估|研究|查看|检查|了解|how|why|can\s+(?:you|i|we)|could\s+(?:you|i|we)|would\s+(?:you|i|we)|explain|analy[sz]e|review|inspect|understand)/i
/** 规划语义只允许搭建新的 idle 结构。 */
const PLAN_INTENT_PATTERN = /(?:规划|计划|方案|拆解|梳理|plan|outline|structure)/i
/** 明确动作词与 Canvas 对象同时出现时，才允许进入执行意图。 */
const EXECUTE_INTENT_PATTERN = /(?:创建|新增|添加|连接|修改|更新|删除|移除|移动|运行|执行|生成|重建|关联|取消关联|设为默认|create|add|connect|link|modify|update|delete|remove|move|run|execute|generate|rebuild|unlink|set\s+(?:as\s+)?default)/i

/**
 * 从主进程收到的真实用户消息解析单轮 Canvas 工具意图。
 * @param input 已经过发送边界准备的用户消息与可选权限模式。
 * @returns 保守的只读、规划或执行意图。
 */
export function resolveCanvasToolUserIntent(
  input: Pick<AgentSendInput, 'userMessage' | 'permissionModeOverride'>,
): CanvasToolUserIntent {
  if (input.permissionModeOverride === 'plan') return 'plan'
  /** 空白和不涉及 Canvas 的消息均保持只读。 */
  const message = input.userMessage.trim()
  if (!message || !CANVAS_DOMAIN_PATTERN.test(message)) return 'discuss'
  if (DISCUSS_INTENT_PATTERN.test(message)) return 'discuss'
  if (PLAN_INTENT_PATTERN.test(message)) return 'plan'
  return EXECUTE_INTENT_PATTERN.test(message) ? 'execute' : 'discuss'
}

/** 引用完成权威解析后构造的单轮可信上下文。 */
export interface CanvasToolRunContext {
  projectId: string
  sessionId: string
  runStartedAt: number
  explicitReferences: CanvasNodeReference[]
  userIntent: CanvasToolUserIntent
}

/** 已有节点执行器返回的稳定任务事实。 */
export interface CanvasToolNodeRunResult {
  status: 'started' | 'idle' | 'unsupported'
  taskId?: string
  message?: string
}

/** Provider 只依赖现有权威 Store、Task8 batch 与执行接缝。 */
export interface CanvasToolProviderDependencies {
  sessions: {
    list: (input: { projectId: string; archived?: boolean }) => CanvasSessionMeta[]
    create: (input: { projectId: string; title?: string }) => CanvasSessionMeta
    requireNative: (projectId: string, canvasId: string) => CanvasSessionMeta
  }
  bindings: {
    get: (projectId: string, sessionId: string) => AgentCanvasBinding | null
    link: (input: { projectId: string; sessionId: string; canvasId: string; makeDefault: boolean }) => AgentCanvasBinding
    unlink: (input: { projectId: string; sessionId: string; canvasId: string }) => AgentCanvasBinding | null
    setDefault: (input: { projectId: string; sessionId: string; canvasId: string }) => AgentCanvasBinding
  }
  documents: {
    load: (target: CanvasTarget) => CanvasWorkspaceSnapshot
    validateBatchOperations: (target: CanvasTarget, expectedRevision: number, operations: unknown[]) => CanvasMutation[]
  }
  readNodeContent?: (target: CanvasTarget, node: CanvasNode) => Promise<string>
  batch: { execute: (input: CanvasBatchOperationEnvelope) => Promise<CanvasBatchOperationResult> }
  inspectNode: (context: CanvasToolRunContext, node: CanvasNode, target: CanvasTarget) => Promise<void>
  runNode?: (context: CanvasToolRunContext, node: CanvasNode, target: CanvasTarget) => Promise<CanvasToolNodeRunResult>
}

/** Provider 产出的单轮扩展；extend 保留普通 Agent 原有工具。 */
export interface CanvasToolRun extends Required<Pick<AgentRunExtensions, 'systemPromptAppend' | 'piCustomTools' | 'allowedToolNames'>> {
  allowedToolNamesMode: 'extend'
}

/** 构造同时写入文本与结构化 details 的 Pi 工具结果。 */
function toolResult(details: Record<string, unknown>): AgentToolResult<unknown> {
  return { content: [{ type: 'text', text: JSON.stringify(details, null, 2) }], details }
}

/** 保留 TypeBox schema 对 execute 参数的静态推断。 */
function defineCanvasTool<TParams extends TSchema, TDetails = unknown>(
  tool: ToolDefinition<TParams, TDetails>,
): ToolDefinition<TParams, TDetails> {
  return tool
}

/** 只允许访问当前会话已关联的 Canvas；参数中不接受 projectId。 */
function requireLinkedCanvas(dependencies: CanvasToolProviderDependencies, context: CanvasToolRunContext, canvasId: string): AgentCanvasBinding {
  const binding = dependencies.bindings.get(context.projectId, context.sessionId)
  if (!binding?.linkedCanvasIds.includes(canvasId)) throw new Error('CANVAS_ACCESS_DENIED')
  dependencies.sessions.requireNative(context.projectId, canvasId)
  return binding
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

/** 为普通项目 Agent 创建不持久化的单轮 Canvas 工具。 */
export function createCanvasToolRun(
  dependencies: CanvasToolProviderDependencies,
  context: CanvasToolRunContext,
): CanvasToolRun {
  /** 本轮访问上下文始终 fresh-read binding，不缓存扩大后的权限。 */
  const getContext = (): AgentCanvasBinding | null => dependencies.bindings.get(context.projectId, context.sessionId)

  const tools: ToolDefinition[] = [
    defineCanvasTool({
      name: 'canvas_get_context', label: '获取画布上下文',
      description: '返回当前 Agent 已关联、默认、活动画布和本轮明确引用摘要；不会扫描项目全部画布。',
      parameters: Type.Object({}),
      execute: async () => {
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
          userIntent: context.userIntent,
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
      execute: async (_toolCallId, params) => {
        if (context.userIntent === 'discuss') throw new Error('CANVAS_WRITE_INTENT_REQUIRED')
        if (context.userIntent === 'plan' && params.action !== 'create' && params.action !== 'link') {
          throw new Error('CANVAS_EXECUTE_INTENT_REQUIRED')
        }
        if (params.action === 'create') {
          const session = dependencies.sessions.create({ projectId: context.projectId, ...(params.title ? { title: params.title } : {}) })
          const binding = dependencies.bindings.link({ projectId: context.projectId, sessionId: context.sessionId, canvasId: session.id, makeDefault: params.makeDefault ?? true })
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
          dependencies.sessions.requireNative(context.projectId, params.canvasId)
          const nextBinding = dependencies.bindings.link({ projectId: context.projectId, sessionId: context.sessionId, canvasId: params.canvasId, makeDefault: params.makeDefault ?? false })
          return toolResult({ action: params.action, canvasId: params.canvasId, binding: nextBinding })
        }
        requireLinkedCanvas(dependencies, context, params.canvasId)
        const binding = params.action === 'unlink'
          ? dependencies.bindings.unlink({ projectId: context.projectId, sessionId: context.sessionId, canvasId: params.canvasId })
          : dependencies.bindings.setDefault({ projectId: context.projectId, sessionId: context.sessionId, canvasId: params.canvasId })
        return toolResult({ action: params.action, canvasId: params.canvasId, binding })
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
        requireLinkedCanvas(dependencies, context, params.canvasId)
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
        let remaining = MAX_READ_CHARS
        let truncated = false
        const entries = []
        for (const node of nodes) {
          if (remaining === 0) {
            truncated = true
            entries.push({ node, content: '' })
            continue
          }
          const fullContent = dependencies.readNodeContent ? await dependencies.readNodeContent(target, node) : ''
          const content = fullContent.slice(0, remaining)
          remaining -= content.length
          if (content.length < fullContent.length) truncated = true
          entries.push({ node, content })
        }
        return toolResult({
          canvasId: params.canvasId,
          revision: document.revision,
          nodes: entries,
          edges: document.edges.filter((edge) => returnedNodeIds.has(edge.sourceNodeId) && returnedNodeIds.has(edge.targetNodeId)),
          truncated,
        })
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
        if (context.userIntent === 'discuss') throw new Error('CANVAS_WRITE_INTENT_REQUIRED')
        requireLinkedCanvas(dependencies, context, params.canvasId)
        const target = { projectId: context.projectId, canvasId: params.canvasId }
        const rawOperations = structuredClone(params.operations)
        const execute = (baseRevision: number, sourceToolCallId: string): Promise<CanvasBatchOperationResult> => {
          const operations = dependencies.documents.validateBatchOperations(target, baseRevision, rawOperations)
          const document = dependencies.documents.load(target).document
          if (context.userIntent === 'plan' && !isPlanSafeMutation(document, operations)) {
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
      },
    }),
    defineCanvasTool({
      name: 'canvas_run_nodes', label: '运行画布节点',
      description: '仅在用户明确执行时运行已有生图或 HTML 节点；其它节点保持 idle，未来 video 稳定返回 unsupported。',
      parameters: Type.Object({ canvasId: Type.String({ minLength: 1, maxLength: 128 }), nodeIds: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { minItems: 1, maxItems: MAX_READ_NODES }) }),
      execute: async (_toolCallId, params) => {
        if (context.userIntent !== 'execute') throw new Error('CANVAS_RUN_REQUIRES_EXPLICIT_EXECUTE')
        requireLinkedCanvas(dependencies, context, params.canvasId)
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
        /** 所有目标、配置和可运行性预检通过前，禁止创建任何任务。 */
        for (const node of nodes) await dependencies.inspectNode(context, node, target)
        const tasks = []
        for (const node of nodes) {
          if (node.kind !== 'image' && node.kind !== 'webview') {
            tasks.push({ nodeId: node.id, status: 'idle' })
            continue
          }
          const outcome = dependencies.runNode
            ? await dependencies.runNode(context, node, target)
            : { status: 'unsupported' as const, message: 'CANVAS_NODE_EXECUTOR_UNAVAILABLE' }
          tasks.push({ nodeId: node.id, ...outcome })
        }
        return toolResult({ canvasId: params.canvasId, revision: document.revision, tasks })
      },
    }),
  ] as ToolDefinition[]

  return {
    systemPromptAppend: `## 画布工具\n根据用户语义和本轮意图选择画布工具，不要按“首页”或“设计”等关键词硬编码。普通讨论先读取，不创建、不修改、不运行。不要要求用户另建已经存在的画布。删除或覆盖必须有用户明确意图。`,
    piCustomTools: tools,
    allowedToolNames: CANVAS_TOOL_NAMES,
    allowedToolNamesMode: 'extend',
  }
}
