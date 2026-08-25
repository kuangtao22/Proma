import type { ActiveView } from '@/atoms/active-view'
import { LEGACY_DESIGN_CANVAS_ID } from '@proma/shared'

export type RightPanelMode = 'hidden' | 'agent' | 'design'

export interface RightPanelModeInput {
  activeView: ActiveView
  appMode: 'chat' | 'agent' | 'scratch'
  projectId: string | null
  canvasId: string | null
  sessionId: string | null
  automationOpen: boolean
}

/** 判断当前 Canvas 选择是否具备顶部入口。 */
export function shouldShowCanvasTab(canvasId: string | null): boolean {
  return canvasId !== null
}

/** 根据主视图和上下文选择右侧面板，避免设计视图依赖会话状态。 */
export function getRightPanelMode(input: RightPanelModeInput): RightPanelMode {
  if (
    input.automationOpen
    || input.activeView === 'planning'
    || input.activeView === 'agent-skills'
  ) {
    return 'hidden'
  }
  if (input.activeView === 'design') {
    return input.projectId && input.canvasId === LEGACY_DESIGN_CANVAS_ID ? 'design' : 'hidden'
  }
  return input.appMode === 'agent' && input.sessionId ? 'agent' : 'hidden'
}
