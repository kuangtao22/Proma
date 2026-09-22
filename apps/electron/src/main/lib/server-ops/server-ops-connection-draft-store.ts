import { randomUUID } from 'node:crypto'
import { parseServerOpsConnectionDraft, parseServerOpsConnectionDraftInput, parseServerOpsConnectionDraftSession } from '@proma/shared'
import type { ServerOpsConnectionDraft, ServerOpsConnectionDraftChanged } from '@proma/shared'

/** 草稿仅在当前进程短暂保留，重启即失效；不会接触连接或凭据 Store。 */
const DRAFT_TTL_MS = 30 * 60 * 1000
const MAX_DRAFTS_PER_SESSION = 8
const MAX_DRAFTS_TOTAL = 64

/** 供 IPC 及 Agent 复用的内存草稿队列。 */
export class ServerOpsConnectionDraftStore {
  /** 会话及其待审查草稿，容量固定。 */
  private readonly drafts = new Map<string, ServerOpsConnectionDraft[]>()
  /** 仅发送身份提示，让窗口按自身会话读取。 */
  private readonly listeners = new Set<(event: ServerOpsConnectionDraftChanged) => void>()

  constructor(private readonly now: () => number = Date.now) {}

  /** 清理到期草稿，避免长期运行累积。 */
  private prune(): void {
    const now = this.now()
    for (const [sessionId, drafts] of this.drafts) {
      const remaining = drafts.filter((draft) => draft.expiresAt > now)
      if (remaining.length) this.drafts.set(sessionId, remaining)
      else this.drafts.delete(sessionId)
    }
  }

  /** 创建公开连接草稿；run/session 权限由工具调用者在进入此边界前验证。 */
  prepare(sessionId: string, input: unknown): ServerOpsConnectionDraft {
    const validSessionId = parseServerOpsConnectionDraftSession(sessionId)
    const validated = parseServerOpsConnectionDraftInput(input)
    this.prune()
    const queue = this.drafts.get(validSessionId) ?? []
    const total = [...this.drafts.values()].reduce((count, entries) => count + entries.length, 0)
    if (queue.length >= MAX_DRAFTS_PER_SESSION || total >= MAX_DRAFTS_TOTAL) throw new Error('SERVER_OPS_CONNECTION_DRAFT_LIMIT')
    const createdAt = this.now()
    const draft: ServerOpsConnectionDraft = { id: randomUUID(), sessionId: validSessionId, createdAt, expiresAt: createdAt + DRAFT_TTL_MS, input: validated }
    this.drafts.set(validSessionId, [...queue, draft])
    for (const listener of this.listeners) {
      try { listener({ sessionId: validSessionId, id: draft.id }) } catch { /* UI 通知失败不能让已入队的草稿被 Agent 再次创建。 */ }
    }
    return parseServerOpsConnectionDraft(draft)
  }

  /** 返回当前会话仍可领取的草稿快照，不消费内容。 */
  list(sessionId: string): ServerOpsConnectionDraft[] {
    this.prune()
    return (this.drafts.get(parseServerOpsConnectionDraftSession(sessionId)) ?? []).map(parseServerOpsConnectionDraft)
  }

  /** 用户保存或显式忽略后才删除；其他会话不能按 ID 删除。 */
  dismiss(sessionId: string, id: string): boolean {
    const session = parseServerOpsConnectionDraftSession(sessionId)
    const draftId = parseServerOpsConnectionDraftSession(id)
    this.prune()
    const entries = this.drafts.get(session)
    if (!entries?.some((draft) => draft.id === draftId)) return false
    const remaining = entries.filter((draft) => draft.id !== draftId)
    if (remaining.length) this.drafts.set(session, remaining)
    else this.drafts.delete(session)
    for (const listener of this.listeners) {
      try { listener({ sessionId: session, id: draftId }) } catch { /* 删除已完成；失活窗口不能反向制造消费失败。 */ }
    }
    return true
  }

  /** 监听草稿队列变更事件，注册器退出时释放。 */
  subscribe(listener: (event: ServerOpsConnectionDraftChanged) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}

/** Electron 单进程共享实例：Agent 创建与 UI 领取指向同一内存状态。 */
export const serverOpsConnectionDraftStore = new ServerOpsConnectionDraftStore()
