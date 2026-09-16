import type { createStore } from 'jotai'
import type { AgentCanvasBinding } from '@proma/shared'
import { agentDiffPanelTabAtom, agentSidePanelOpenAtomFamily, agentSidePanelSplitMapAtom, parseCanvasWorkspaceTab } from '@/atoms/agent-atoms'
import { getFocusedRightWorkspaceTab } from './right-workspace-split'

/** 按会话同步读取用户当前看到的焦点画布；关闭面板或非画布焦点返回null，不猜默认图。 */
export function readVisibleAgentCanvasId(store: Pick<ReturnType<typeof createStore>, 'get'>, sessionId: string): string | null {
  if (!store.get(agentSidePanelOpenAtomFamily(sessionId))) return null
  /** 分屏时沿用SidePanel的焦点规则，避免另一Pane覆盖当前操作目标。 */
  const split = store.get(agentSidePanelSplitMapAtom).get(sessionId)
  const tab = split ? getFocusedRightWorkspaceTab(split) : store.get(agentDiffPanelTabAtom).get(sessionId)
  return tab ? parseCanvasWorkspaceTab(tab) : null
}

/**
 * 等待可见画布被主进程接纳后再发送；等待期间切换则重新对齐，失败交由发送入口保留草稿。
 * @param readCanvasId 每次读取当前焦点，不捕获过期React闭包。
 * @param markActive 只更新已关联画布的最近身份，不改变默认或建立关联。
 */
export async function synchronizeVisibleAgentCanvas(
  readCanvasId: () => string | null,
  markActive: (canvasId: string) => Promise<Pick<AgentCanvasBinding, 'lastActiveCanvasId'>>,
): Promise<void> {
  // 最多核对三次焦点，防止连续切换导致发送无限等待。
  for (let attempt = 0; attempt < 3; attempt += 1) {
    /** 本次await对应的目标，用于校验等待期间的新选择。 */
    const canvasId = readCanvasId()
    if (!canvasId) return
    /** 主进程可回传更新被替代后的当前状态，只有身份相符才算接纳成功。 */
    const binding = await markActive(canvasId)
    if (binding.lastActiveCanvasId === canvasId && readCanvasId() === canvasId) return
  }
  throw new Error('画布仍在切换，请停留在目标画布后重新发送。')
}
