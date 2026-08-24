import type { ActiveView } from '@/atoms/active-view'

export type RightPanelMode = 'hidden' | 'agent' | 'design'

export interface RightPanelModeInput {
  activeView: ActiveView
  appMode: 'chat' | 'agent' | 'scratch'
  projectId: string | null
  sessionId: string | null
  automationOpen: boolean
}

/** 判断当前项目是否具备项目级设计入口。 */
export function shouldShowDesignTab(projectId: string | null): boolean {
  return projectId !== null
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
    return input.projectId ? 'design' : 'hidden'
  }
  return input.appMode === 'agent' && input.sessionId ? 'agent' : 'hidden'
}
