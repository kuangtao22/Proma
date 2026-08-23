import type { PreparedDesignAssetMention } from '@proma/shared'
import type { ActiveView } from '@/atoms/active-view'
import type { FilePanelDragItem } from '@/lib/file-panel-drag'

/** 发送设计素材到会话 composer 所需的最小 Renderer 能力。 */
export interface DesignSessionActionDependencies {
  openSession: (sessionId: string) => void | Promise<void>
  dispatchMention: (items: FilePanelDragItem[]) => void
  setActiveView: (view: ActiveView) => void
}

/**
 * 打开目标会话并只填入项目素材引用，不自动发送 Agent 消息。
 * @param prepared 主进程完成项目、会话和素材归属验证后的引用。
 * @param dependencies 会话导航、composer 事件与当前视图切换能力。
 * @returns 所有 composer 投递动作完成后的 Promise。
 */
export async function sendPreparedDesignAssetToSession(
  prepared: PreparedDesignAssetMention,
  dependencies: DesignSessionActionDependencies,
): Promise<void> {
  await dependencies.openSession(prepared.sessionId)
  dependencies.dispatchMention([prepared])
  dependencies.setActiveView('conversations')
}
