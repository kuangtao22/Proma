import { SERVER_OPS_CONNECTION_DRAFT_CHANNELS, parseServerOpsConnectionDraft, parseServerOpsConnectionDraftChanged, parseServerOpsConnectionDraftDismiss, parseServerOpsConnectionDraftSession } from '@proma/shared'
import type { ServerOpsConnectionDraft, ServerOpsConnectionDraftChanged } from '@proma/shared'

/** Renderer 只能读取自己所选可见会话的公开草稿，不能提交 Agent 配置。 */
export interface ServerOpsConnectionDraftPreload {
  listServerOpsConnectionDrafts(sessionId: string): Promise<ServerOpsConnectionDraft[]>
  dismissServerOpsConnectionDraft(input: { sessionId: string; id: string }): Promise<boolean>
  onServerOpsConnectionDraftChanged(listener: (event: ServerOpsConnectionDraftChanged) => void): () => void
}

/** 请求及回执均做 exact-key 解析，避免主进程或事件错误时渲染未知字段。 */
export function createServerOpsConnectionDraftPreload(
  invoke: (channel: string, input: unknown) => Promise<unknown>,
  subscribe: (channel: string, listener: (value: unknown) => void) => () => void,
): ServerOpsConnectionDraftPreload {
  return {
    listServerOpsConnectionDrafts: async (sessionId) => {
      const response = await invoke(SERVER_OPS_CONNECTION_DRAFT_CHANNELS.LIST, parseServerOpsConnectionDraftSession(sessionId))
      if (!Array.isArray(response) || response.length > 8) throw new Error('SERVER_OPS_CONNECTION_DRAFT_INVALID')
      const drafts = response.map(parseServerOpsConnectionDraft)
      if (drafts.some((draft) => draft.sessionId !== sessionId) || new Set(drafts.map((draft) => draft.id)).size !== drafts.length) throw new Error('SERVER_OPS_CONNECTION_DRAFT_INVALID')
      return drafts
    },
    dismissServerOpsConnectionDraft: async (input) => {
      const response = await invoke(SERVER_OPS_CONNECTION_DRAFT_CHANNELS.DISMISS, parseServerOpsConnectionDraftDismiss(input))
      if (typeof response !== 'boolean') throw new Error('SERVER_OPS_CONNECTION_DRAFT_INVALID')
      return response
    },
    onServerOpsConnectionDraftChanged: (listener) => subscribe(SERVER_OPS_CONNECTION_DRAFT_CHANNELS.CHANGED, (value) => {
      try { listener(parseServerOpsConnectionDraftChanged(value)) } catch { /* 未知广播不传入 Renderer。 */ }
    }),
  }
}
