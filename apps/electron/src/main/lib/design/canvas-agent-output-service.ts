import { createHash } from 'node:crypto'
import type {
  AgentSessionMeta,
  CanvasAgentOutputPointer,
  CanvasAgentTarget,
  CanvasDocument,
  CanvasMutation,
  CanvasTarget,
  CanvasWorkspaceSnapshot,
  SDKAssistantMessage,
  SDKMessage,
} from '@proma/shared'
import { requireCanvasAgentRunOwner } from './canvas-agent-run-policy'
import type { CanvasDependencyStateService } from './canvas-dependency-state-service'

const CANVAS_AGENT_MESSAGE_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const MAX_CANVAS_AGENT_RUN_ANCHOR_LENGTH = 120

/** Agent 单轮终态；只有 completed 允许固化正式正文。 */
export type CanvasAgentCompletionStatus = 'completed' | 'partial' | 'errored'

/** 由执行边界提供、可证明当前 run 范围的严格输入。 */
export interface CanvasAgentCompletionInput {
  target: CanvasAgentTarget
  userMessageUuid: string
  startedAt: number
  runGeneration: number
  completedAt: number
  terminalStatus: CanvasAgentCompletionStatus
}

/** 已从权威 SDK 消息重建的内部正式输出候选。 */
export interface CanvasResolvedAgentOutput {
  content: string
  pointer: CanvasAgentOutputPointer
  runGeneration: number
}

/** 正式输出提交复用与解析相同的 current-run 证明输入。 */
export interface CanvasAgentOutputCommitInput extends CanvasAgentCompletionInput {}

/** 提交结果只公开节点目标、图 revision、指针和受影响下游。 */
export interface CanvasAgentOutputCommitResult {
  target: CanvasAgentTarget
  revision: number
  pointer: CanvasAgentOutputPointer
  downstreamNodeIds: string[]
}

/** Canvas Agent 正式输出的解析、原子提交与内容寻址读取服务。 */
export interface CanvasAgentOutputService {
  resolveCompletedOutput: (input: CanvasAgentCompletionInput) => CanvasResolvedAgentOutput
  commit: (input: CanvasAgentOutputCommitInput) => Promise<CanvasAgentOutputCommitResult>
  read: (target: CanvasAgentTarget) => Promise<string>
}

/** 服务只依赖唯一文档 Store、共享锁、会话索引和 SDK 消息日志。 */
export interface CanvasAgentOutputServiceDependencies {
  documents: {
    load: (target: CanvasTarget) => CanvasWorkspaceSnapshot
    mutate: (
      target: CanvasTarget,
      expectedRevision: number,
      operations: CanvasMutation[],
    ) => CanvasDocument | Promise<CanvasDocument>
  }
  /** 生产注入共享 serializer + workspace write lease。 */
  runExclusive: <T>(target: CanvasTarget, effect: () => Promise<T>) => Promise<T>
  dependencyState: Pick<CanvasDependencyStateService, 'consumeAndPropagate'>
  getSession: (sessionId: string) => AgentSessionMeta | undefined
  getMessages: (sessionId: string) => SDKMessage[]
  /** 图事实可见且锁与 lease 释放后才调用。 */
  publish: (target: CanvasTarget, document: CanvasDocument) => void | Promise<void>
}

/** 判断数值可安全作为单调运行或时间事实。 */
function isNonNegativeSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0
}

/** 对精确 UTF-8 正文字节计算小写十六进制 SHA-256。 */
function contentSha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

/** 只按块顺序提取 text；thinking、tool 和未知块均不进入正式正文。 */
function extractAssistantText(message: SDKAssistantMessage): string {
  return message.message.content
    .filter((block): block is Extract<typeof block, { type: 'text' }> => (
      block.type === 'text' && typeof block.text === 'string'
    ))
    .map((block) => block.text)
    .join('')
}

/** 判断消息是当前 run 的完整、无错误、非 replay assistant 候选。 */
function isCompletedAssistant(message: SDKMessage): message is SDKAssistantMessage {
  if (message.type !== 'assistant') return false
  const record = message as SDKAssistantMessage & Record<string, unknown>
  return record._partial !== true
    && record.isReplay !== true
    && record.error === undefined
    && typeof record.uuid === 'string'
    && CANVAS_AGENT_MESSAGE_UUID_PATTERN.test(record.uuid)
}

/** 用户文本消息是 run 边界；tool_result user 消息仍属于锚点后的同一运行。 */
function isUserRunAnchor(message: SDKMessage): boolean {
  const record = message as {
    type: string
    isSynthetic?: boolean
    uuid?: string
    message?: { content?: Array<{ type?: unknown }> }
  }
  if (record.type !== 'user' || record.isSynthetic === true || typeof record.uuid !== 'string') {
    return false
  }
  return record.message?.content?.some((block) => block.type === 'text') === true
}

/** 在有界日志中定位唯一用户锚点，重复或缺失均不能证明 run 归属。 */
function findUniqueRunAnchor(messages: SDKMessage[], userMessageUuid: string): number {
  let anchorIndex = -1
  for (const [index, message] of messages.entries()) {
    const uuid = (message as { uuid?: unknown }).uuid
    if (!isUserRunAnchor(message) || uuid !== userMessageUuid) continue
    if (anchorIndex !== -1) throw new Error('CANVAS_AGENT_OUTPUT_INVALID')
    anchorIndex = index
  }
  if (anchorIndex === -1) throw new Error('CANVAS_AGENT_OUTPUT_INVALID')
  return anchorIndex
}

/** 从 fresh 图与会话索引解析唯一内部 Agent owner，并统一隐藏内部错误。 */
function requireOwner(
  dependencies: CanvasAgentOutputServiceDependencies,
  target: CanvasAgentTarget,
): ReturnType<typeof requireCanvasAgentRunOwner> & { document: CanvasDocument } {
  try {
    const document = dependencies.documents.load(target).document
    const owner = requireCanvasAgentRunOwner({
      target,
      nodeId: target.nodeId,
      document,
      getSession: dependencies.getSession,
    })
    return { ...owner, document }
  } catch (error) {
    throw new Error('CANVAS_AGENT_OUTPUT_INVALID', { cause: error })
  }
}

/** 比较内容寻址指针是否完全相同。 */
function isSamePointer(left: CanvasAgentOutputPointer | undefined, right: CanvasAgentOutputPointer): boolean {
  return left?.messageUuid === right.messageUuid
    && left.contentSha256 === right.contentSha256
    && left.completedAt === right.completedAt
}

/** 构造 Canvas Agent 正式输出服务，不创建额外 Store、串行器或持久化。 */
export function createCanvasAgentOutputService(
  dependencies: CanvasAgentOutputServiceDependencies,
): CanvasAgentOutputService {
  /** 当前进程各节点已提交的最高运行代次，阻止旧回调覆盖新事实。 */
  const committedRunGenerations = new Map<string, number>()
  /** 目标键只用于进程内代次仲裁，不持久化或对外暴露 session。 */
  const targetKey = (target: CanvasAgentTarget): string => (
    `${target.projectId}\0${target.canvasId}\0${target.nodeId}`
  )

  /** 从权威 session 日志按精确用户锚点解析本轮最后一条有效正文。 */
  const resolveCompletedOutput = (input: CanvasAgentCompletionInput): CanvasResolvedAgentOutput => {
    if (input.terminalStatus !== 'completed'
      || !isNonNegativeSafeInteger(input.startedAt)
      || !Number.isSafeInteger(input.runGeneration) || input.runGeneration <= 0
      || !isNonNegativeSafeInteger(input.completedAt)
      || input.completedAt < input.startedAt
      || input.userMessageUuid.length < 1
      || input.userMessageUuid.length > MAX_CANVAS_AGENT_RUN_ANCHOR_LENGTH) {
      throw new Error('CANVAS_AGENT_OUTPUT_MISSING')
    }
    const owner = requireOwner(dependencies, input.target)
    /** SDK API 当前整份返回单会话消息；这里只做一次线性范围解析，不复制正文集合。 */
    const messages = dependencies.getMessages(owner.node.agentSessionId)
    const anchorIndex = findUniqueRunAnchor(messages, input.userMessageUuid)
    let selected: { messageUuid: string; content: string } | undefined
    for (let index = anchorIndex + 1; index < messages.length; index += 1) {
      const message = messages[index]!
      /** 下一条显式用户文本开始新 run，不能越界采纳后续回复。 */
      if (isUserRunAnchor(message)) break
      if (!isCompletedAssistant(message)) continue
      const content = extractAssistantText(message)
      if (content.trim().length === 0) continue
      selected = { messageUuid: message.uuid!, content }
    }
    if (!selected) throw new Error('CANVAS_AGENT_OUTPUT_MISSING')
    return {
      content: selected.content,
      pointer: {
        messageUuid: selected.messageUuid,
        contentSha256: contentSha256(selected.content),
        completedAt: input.completedAt,
      },
      runGeneration: input.runGeneration,
    }
  }

  const service: CanvasAgentOutputService = {
    resolveCompletedOutput,
    commit: async (input) => {
      const key = targetKey(input.target)
      /** 锁内结果延后到 lease 外发布。 */
      const locked = await dependencies.runExclusive(input.target, async () => {
        const latestGeneration = committedRunGenerations.get(key)
        if (latestGeneration !== undefined && input.runGeneration < latestGeneration) {
          throw new Error('CANVAS_AGENT_OUTPUT_STALE')
        }
        const resolved = resolveCompletedOutput(input)
        /** 第二次 fresh-read 与 mutation 共处同一临界区，抵御解析期间换绑。 */
        const owner = requireOwner(dependencies, input.target)
        if (latestGeneration === input.runGeneration) {
          if (!isSamePointer(owner.node.outputPointer, resolved.pointer)) {
            throw new Error('CANVAS_AGENT_OUTPUT_STALE')
          }
          return {
            document: owner.document,
            result: {
              target: { ...input.target }, revision: owner.document.revision,
              pointer: resolved.pointer, downstreamNodeIds: [],
            },
            publish: false,
          }
        }
        /** pointer 先进入投影基线，依赖服务再同批消费 producer 提示并标记下游。 */
        const documentWithPointer: CanvasDocument = {
          ...owner.document,
          nodes: owner.document.nodes.map((node) => (
            node.id === owner.node.id ? { ...owner.node, outputPointer: resolved.pointer } : node
          )),
        }
        const dependencyProjection = dependencies.dependencyState.consumeAndPropagate({
          document: documentWithPointer,
          producerNodeIds: [owner.node.id],
          changedAt: input.completedAt,
        })
        const document = await dependencies.documents.mutate(
          input.target,
          owner.document.revision,
          [{ type: 'upsert-nodes', nodes: dependencyProjection.nodes }],
        )
        committedRunGenerations.set(key, input.runGeneration)
        return {
          document,
          result: {
            target: { ...input.target }, revision: document.revision,
            pointer: resolved.pointer,
            downstreamNodeIds: dependencyProjection.downstreamNodeIds,
          },
          publish: true,
        }
      })
      if (locked.publish) {
        try {
          await dependencies.publish(input.target, locked.document)
        } catch (error) {
          console.error('[Canvas Agent 输出] 图事实广播失败:', error)
        }
      }
      return locked.result
    },
    read: async (target) => {
      try {
        const owner = requireOwner(dependencies, target)
        const pointer = owner.node.outputPointer
        if (!pointer) throw new Error('pointer missing')
        /** 从尾部扫描 exact UUID，同时拒绝损坏日志中的重复标识。 */
        const messages = dependencies.getMessages(owner.node.agentSessionId)
        let matchedContent: string | undefined
        for (let index = messages.length - 1; index >= 0; index -= 1) {
          const message = messages[index]!
          if (!isCompletedAssistant(message) || message.uuid !== pointer.messageUuid) continue
          if (matchedContent !== undefined) throw new Error('duplicate message UUID')
          matchedContent = extractAssistantText(message)
        }
        if (matchedContent === undefined
          || matchedContent.trim().length === 0
          || contentSha256(matchedContent) !== pointer.contentSha256) {
          throw new Error('content mismatch')
        }
        return matchedContent
      } catch (error) {
        throw new Error('CANVAS_AGENT_OUTPUT_INVALID', { cause: error })
      }
    },
  }
  return service
}
