import type { PreparedDesignAssetMention } from '@proma/shared'
import type { ActiveView } from '@/atoms/active-view'
import type { FilePanelDragItem } from '@/lib/file-panel-drag'

/** 发送设计素材到会话 composer 所需的最小 Renderer 能力。 */
export interface DesignSessionActionDependencies {
  openSession: (sessionId: string) => void | Promise<void>
  enqueueMention: (sessionId: string, items: FilePanelDragItem[]) => void
  setActiveView: (view: ActiveView) => void
}

/** composer 消费待插入引用所需的最小副作用。 */
export interface PendingMentionDeliveryDependencies {
  insertMentions: (items: FilePanelDragItem[]) => boolean
  acknowledge: () => boolean
  notifySuccess: () => void
}

/** 只有 editor 插入和队列确认都成功时才提示用户。 */
export function deliverPendingMentionsToComposer(
  items: FilePanelDragItem[],
  dependencies: PendingMentionDeliveryDependencies,
): boolean {
  if (!dependencies.insertMentions(items)) return false
  if (!dependencies.acknowledge()) return false
  dependencies.notifySuccess()
  return true
}

/**
 * 打开目标会话并只填入项目素材引用，不自动发送 Agent 消息。
 * @param prepared 主进程完成项目、会话和素材归属验证后的引用。
 * @param dependencies 会话引用入队、导航与当前视图切换能力。
 * @returns 所有 composer 投递动作完成后的 Promise。
 */
export async function sendPreparedDesignAssetToSession(
  prepared: PreparedDesignAssetMention,
  dependencies: DesignSessionActionDependencies,
): Promise<void> {
  dependencies.enqueueMention(prepared.sessionId, [prepared])
  await dependencies.openSession(prepared.sessionId)
  dependencies.setActiveView('conversations')
}
