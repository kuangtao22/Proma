import { parseCanvasNodeReferences } from '@proma/shared'
import type {
  AgentCanvasBinding,
  AgentSessionMeta,
  CanvasNodeReference,
  CanvasSessionMeta,
  CanvasTarget,
  CanvasWorkspaceSnapshot,
} from '@proma/shared'
import { isEligibleProjectAgent } from './agent-canvas-binding-ipc'

/** Canvas 引用发送前失效的稳定公开错误码。 */
export const CANVAS_REFERENCE_INVALID = 'CANVAS_REFERENCE_INVALID'

/** 发送前解析 Canvas 节点引用所需的可信主进程依赖。 */
export interface CanvasNodeReferenceResolverDependencies {
  /** 按稳定 ID 读取当前 Agent 会话。 */
  getSession: (sessionId: string) => AgentSessionMeta | undefined
  /** 读取普通 Agent 在指定项目内的实时 Canvas 绑定。 */
  getBinding: (projectId: string, sessionId: string) => AgentCanvasBinding | null
  /** 复核 Canvas 已在项目内登记并返回公开标题。 */
  requireCanvas: (projectId: string, canvasId: string) => CanvasSessionMeta
  /** 加载发送时的权威 Canvas 文档快照。 */
  loadCanvas: (target: CanvasTarget) => CanvasWorkspaceSnapshot
}

/** 单次发送使用的权威 Canvas 引用快照及轻量上下文。 */
export interface ResolvedCanvasNodeReferences {
  /** 持久化与运行时共同使用的发送时快照。 */
  references: CanvasNodeReference[]
  /** 相对 Renderer 输入发生变化的节点 ID。 */
  changedNodeIds: string[]
  /** 可安全追加到 system prompt 的画布工作区摘要。 */
  promptSummary: string
}

/** Canvas 引用发送前权威解析器。 */
export interface CanvasNodeReferenceResolver {
  /** 复核宿主、绑定、文档与节点身份并返回发送时快照。 */
  resolveForSend: (input: {
    sessionId: string
    /** latest 刷新新选择；exact 只允许仍可证明的历史 revision。 */
    mode: 'latest' | 'exact'
    references: CanvasNodeReference[]
  }) => ResolvedCanvasNodeReferences
}

/** 创建不暴露内部失败详情的公开失效错误。 */
function invalidReferenceError(): Error {
  return new Error(CANVAS_REFERENCE_INVALID)
}

/** 构建不含内部身份、路径或节点正文的轻量画布工作区摘要。 */
function buildPromptSummary(input: {
  binding: AgentCanvasBinding
  canvases: CanvasSessionMeta[]
  references: CanvasNodeReference[]
}): string {
  /** 按绑定顺序查询标题，避免内部 Canvas ID 进入 prompt。 */
  const titleById = new Map(input.canvases.map((canvas) => [canvas.id, canvas.title]))
  /** 默认与活动标题仅在仍属于有效关联集合时展示。 */
  const defaultTitle = input.binding.defaultCanvasId
    ? titleById.get(input.binding.defaultCanvasId)
    : undefined
  const activeTitle = input.binding.lastActiveCanvasId
    ? titleById.get(input.binding.lastActiveCanvasId)
    : undefined
  /** 引用摘要只保留节点类型与权威标题。 */
  const referenceLines = input.references.map((reference) => (
    `- ${reference.nodeType}「${reference.title}」`
  ))
  /** 固定标签结构让模型只消费轻量工作区事实。 */
  const lines = [
    `已关联画布：${input.canvases.map((canvas) => canvas.title).join('、')}`,
    ...(defaultTitle ? [`默认画布：${defaultTitle}`] : []),
    ...(activeTitle ? [`活动画布：${activeTitle}`] : []),
    '本轮引用：',
    ...referenceLines,
  ]
  return lines.join('\n')
}

/** 创建发送前 Canvas 节点引用解析器。 */
export function createCanvasNodeReferenceResolver(
  dependencies: CanvasNodeReferenceResolverDependencies,
): CanvasNodeReferenceResolver {
  return {
    resolveForSend(input): ResolvedCanvasNodeReferences {
      try {
        /** 共享解析器先拒绝畸形 Renderer 输入。 */
        const parsedReferences = parseCanvasNodeReferences(input.references)
        if (parsedReferences.length === 0) throw invalidReferenceError()
        /** 当前权威会话必须仍是同项目普通顶层用户 Agent。 */
        const session = dependencies.getSession(input.sessionId)
        if (!session
          || session.archived
          || !session.workspaceId
          || !isEligibleProjectAgent(session, session.workspaceId)) {
          throw invalidReferenceError()
        }
        /** 同一 Canvas 节点重复引用时权威去重，避免重复 I/O 和 prompt 噪声。 */
        const uniqueReferences = parsedReferences.filter((reference, index, all) => (
          all.findIndex((candidate) => (
            candidate.canvasId === reference.canvasId && candidate.nodeId === reference.nodeId
          )) === index
        ))
        if (uniqueReferences.some((reference) => reference.projectId !== session.workspaceId)) {
          throw invalidReferenceError()
        }
        /** 绑定必须实时存在，且每个引用 Canvas 都仍在 default/linked 权威集合内。 */
        const binding = dependencies.getBinding(session.workspaceId, session.id)
        if (!binding
          || binding.projectId !== session.workspaceId
          || binding.sessionId !== session.id
          || uniqueReferences.some((reference) => !binding.linkedCanvasIds.includes(reference.canvasId))) {
          throw invalidReferenceError()
        }
        /** 有效关联 Canvas 的标题仅用于最小 prompt 摘要。 */
        const canvases = binding.linkedCanvasIds.map((canvasId) => (
          dependencies.requireCanvas(session.workspaceId!, canvasId)
        ))
        /** 同一 Canvas 的多个节点共享一次权威文档读取。 */
        const documents = new Map<string, CanvasWorkspaceSnapshot>()
        for (const reference of uniqueReferences) {
          if (!documents.has(reference.canvasId)) {
            documents.set(reference.canvasId, dependencies.loadCanvas({
              projectId: session.workspaceId,
              canvasId: reference.canvasId,
            }))
          }
        }
        /** 用发送时文档 revision、节点类型与标题重建不可变快照。 */
        const references = uniqueReferences.map((reference): CanvasNodeReference => {
          const document = documents.get(reference.canvasId)?.document
          const node = document?.nodes.find((candidate) => candidate.id === reference.nodeId)
          if (!document || !node || node.kind !== reference.nodeType) throw invalidReferenceError()
          /** 历史重试只能使用当前生命周期仍可精确证明的原 revision。 */
          if (input.mode === 'exact') {
            if (document.revision !== reference.nodeRevision) throw invalidReferenceError()
            return reference
          }
          return {
            projectId: session.workspaceId!,
            canvasId: reference.canvasId,
            nodeId: node.id,
            nodeType: node.kind,
            nodeRevision: document.revision,
            title: node.title,
          }
        })
        /** 任一持久化字段变化都提示 Renderer 当前选择已被刷新。 */
        const changedNodeIds = references
          .filter((reference, index) => {
            const original = uniqueReferences[index]!
            return reference.nodeRevision !== original.nodeRevision
              || reference.nodeType !== original.nodeType
              || reference.title !== original.title
          })
          .map((reference) => reference.nodeId)
        return {
          references,
          changedNodeIds: [...new Set(changedNodeIds)],
          promptSummary: buildPromptSummary({ binding, canvases, references }),
        }
      } catch {
        /** 文件、索引和会话错误统一 fail closed，禁止向 Renderer 泄露内部详情。 */
        throw invalidReferenceError()
      }
    },
  }
}
