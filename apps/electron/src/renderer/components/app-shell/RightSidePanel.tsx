/**
 * RightSidePanel — 右侧边栏容器
 *
 * 在 Agent 模式下显示文件面板，样式与 LeftSidebar 一致。
 * 从全局 atom 读取当前会话 ID 和路径。
 * 管理「文件 / 代码改动」视图；文件中包含会话文件与项目文件。
 */

import * as React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import {
  currentAgentSessionIdAtom,
  agentSessionPathMapAtom,
  agentDiffPanelTabAtom,
} from '@/atoms/agent-atoms'
import type { AgentSidePanelTab } from '@/atoms/agent-atoms'
import { SidePanel } from '@/components/agent/SidePanel'
import { DesignInspector } from '@/components/design/DesignInspector'
import type { RightPanelMode } from './design-layout'

export interface RightSidePanelProps {
  /** 右栏内容类型，由 AppShell 统一计算。 */
  mode: RightPanelMode
  /** 设计模式绑定的当前项目。 */
  projectId: string | null
  /** 用户可拖拽调整的右栏宽度。 */
  width?: number
}

/** 根据布局模式渲染会话文件面板或项目设计检查器。 */
export function RightSidePanel({ mode, projectId, width }: RightSidePanelProps): React.ReactElement | null {
  const currentSessionId = useAtomValue(currentAgentSessionIdAtom)
  const sessionPathMap = useAtomValue(agentSessionPathMapAtom)
  const diffPanelTabMap = useAtomValue(agentDiffPanelTabAtom)
  const setDiffPanelTabMap = useSetAtom(agentDiffPanelTabAtom)

  const setActiveTab = React.useCallback((tab: AgentSidePanelTab) => {
    if (!currentSessionId) return
    setDiffPanelTabMap((prev) => {
      const map = new Map(prev)
      map.set(currentSessionId, tab)
      return map
    })
  }, [currentSessionId, setDiffPanelTabMap])

  if (mode === 'design') {
    return projectId ? <DesignInspector projectId={projectId} width={width} /> : null
  }

  if (mode !== 'agent' || !currentSessionId) {
    return null
  }

  const sessionPath = sessionPathMap.get(currentSessionId) ?? null
  const activeTab = diffPanelTabMap.get(currentSessionId) ?? 'files'

  return (
    <SidePanel
      sessionId={currentSessionId}
      sessionPath={sessionPath}
      activeTab={activeTab}
      onTabChange={setActiveTab}
      width={width}
    />
  )
}
