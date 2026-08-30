import { createHash } from 'node:crypto'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { AgentToolResult } from '@earendil-works/pi-agent-core'
import type {
  AgentCanvasBinding,
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

/** Host 只执法会话权限上限，不从用户文本推断业务意图。 */
export type CanvasToolPermissionCeiling = 'plan' | 'execute'

/** 引用完成权威解析后构造的单轮可信上下文。 */
export interface CanvasToolRunContext {
  projectId: string
  sessionId: string
  runStartedAt: number
  explicitReferences: CanvasNodeReference[]
  permissionCeiling: CanvasToolPermissionCeiling
}

/** 已有节点执行器返回的稳定任务事实。 */
export interface CanvasToolNodeRunResult {
  nodeId: string
  status: 'started' | 'queued' | 'idle' | 'unsupported' | 'failed' | 'blocked' | 'rolled-back'
  taskId?: string
  message?: string
  error?: string
}

/** Provider 只依赖现有权威 Store、Task8 batch 与执行接缝。 */
export interface CanvasToolProviderDependencies {
  sessions: {
    list: (input: { projectId: string; archived?: boolean }) => CanvasSessionMeta[]
    create: (input: { projectId: string; title?: string }) => CanvasSessionMeta
    createWithId: (input: { projectId: string; canvasId: string; title?: string }) => CanvasSessionMeta
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
  runNodes: (
    context: CanvasToolRunContext,
    target: CanvasTarget,
    nodes: CanvasNode[],
    toolCallId: string,
  ) => Promise<CanvasToolNodeRunResult[]>
}

/** Provider 产出的单轮扩展；extend 保留普通 Agent 原有工具。 */
export interface CanvasToolRun extends Required<Pick<AgentRunExtensions, 'systemPromptAppend' | 'piCustomTools' | 'allowedToolNames' | 'singleApprovalToolNames'>> {
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

/** 从执行身份派生跨进程稳定 Canvas ID，不读取或扫描项目内其它 Canvas。 */
function createManagedCanvasId(context: CanvasToolRunContext, toolCallId: string): string {
  /** 长度前缀编码避免不同字段拼接产生边界碰撞。 */
  const identity = [context.projectId, context.sessionId, String(context.runStartedAt), toolCallId]
    .map((value) => `${value.length}:${value}`)
    .join('|')
  return `agent-canvas-${createHash('sha256').update(identity).digest('hex')}`
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
        if (context.permissionCeiling === 'plan' && params.action === 'create') {
          throw new Error('CANVAS_EXECUTE_INTENT_REQUIRED')
        }
        if (context.permissionCeiling === 'plan' && params.action !== 'create' && params.action !== 'link') {
          throw new Error('CANVAS_EXECUTE_INTENT_REQUIRED')
        }
        if (params.action === 'create') {
          /** 同一 tool call 始终命中同一索引记录，首次 link 失败后也可安全重放。 */
          const canvasId = createManagedCanvasId(context, toolCallId)
          const session = dependencies.sessions.createWithId({
            projectId: context.projectId,
            canvasId,
            ...(params.title ? { title: params.title } : {}),
          })
          const existingBinding = getContext()
          const makeDefault = params.makeDefault ?? true
          const alreadyLinked = existingBinding?.linkedCanvasIds.includes(session.id) ?? false
          const binding = alreadyLinked && (!makeDefault || existingBinding?.defaultCanvasId === session.id)
            ? existingBinding
            : dependencies.bindings.link({
                projectId: context.projectId,
                sessionId: context.sessionId,
                canvasId: session.id,
                makeDefault,
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
        requireLinkedCanvas(dependencies, context, params.canvasId)
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
      },
    }),
    defineCanvasTool({
      name: 'canvas_run_nodes', label: '运行画布节点',
      description: '仅在用户明确执行时运行已有生图或 HTML 节点；其它节点保持 idle，未来 video 稳定返回 unsupported。',
      parameters: Type.Object({ canvasId: Type.String({ minLength: 1, maxLength: 128 }), nodeIds: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { minItems: 1, maxItems: MAX_READ_NODES }) }),
      execute: async (toolCallId, params) => {
        if (context.permissionCeiling === 'plan') throw new Error('CANVAS_RUN_REQUIRES_EXPLICIT_EXECUTE')
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
        /** 目标预检、journal 建立和统一启动由生产批量边界一次完成。 */
        const tasks = await dependencies.runNodes(context, target, nodes, toolCallId)
        return toolResult({ canvasId: params.canvasId, revision: document.revision, tasks })
      },
    }),
  ] as ToolDefinition[]

  return {
    systemPromptAppend: `## 画布工具\n请基于完整用户语义和工具 schema 自主决定是否读取、创建、修改或运行画布，不要按“首页”或“设计”等关键词硬编码。Host 只提供 permissionCeiling 权限上限：plan 仅允许新增 idle 结构且禁止运行、覆盖、删除和移动；execute 表示工具可执行，不代表用户已授权任意操作。普通讨论优先读取，不要要求用户另建已经存在的画布。删除或覆盖必须有用户明确意图，并传入 destructiveIntent=explicit。`,
    piCustomTools: tools,
    allowedToolNames: CANVAS_TOOL_NAMES,
    singleApprovalToolNames: ['canvas_run_nodes'],
    allowedToolNamesMode: 'extend',
  }
}
