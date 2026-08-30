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
  currentSessionSidePanelOpenAtom,
  agentSessionPathMapAtom,
  agentDiffPanelTabAtom,
  agentTerminalTabsAtom,
  getTerminalSidePanelTab,
  getBrowserSidePanelTab,
  getPreviewSidePanelTab,
} from '@/atoms/agent-atoms'
import type { AgentSidePanelTab } from '@/atoms/agent-atoms'
import { SidePanel } from '@/components/agent/SidePanel'
import { browserPanelOpenMapAtom, browserStateMapAtom } from '@/atoms/browser-atoms'
import { getPreviewFileId, previewFileMapAtom } from '@/atoms/preview-atoms'

export interface RightSidePanelProps {
  /** 用户可拖拽调整的右栏宽度。 */
  width?: number
}

/** 渲染当前普通 Agent 会话的右侧工作区。 */
export function RightSidePanel({ width }: RightSidePanelProps): React.ReactElement | null {
  const currentSessionId = useAtomValue(currentAgentSessionIdAtom)
  const sessionPathMap = useAtomValue(agentSessionPathMapAtom)
  const diffPanelTabMap = useAtomValue(agentDiffPanelTabAtom)
  const setDiffPanelTabMap = useSetAtom(agentDiffPanelTabAtom)
  const setTerminalTabsMap = useSetAtom(agentTerminalTabsAtom)
  const setSidePanelOpen = useSetAtom(currentSessionSidePanelOpenAtom)
  const browserOpenMap = useAtomValue(browserPanelOpenMapAtom)
  const browserStateMap = useAtomValue(browserStateMapAtom)
  const browserOpen = currentSessionId ? browserOpenMap.get(currentSessionId) === true : false
  const browserState = currentSessionId ? browserStateMap.get(currentSessionId) ?? null : null
  const previewFileMap = useAtomValue(previewFileMapAtom)
  const currentPreviewFile = currentSessionId ? previewFileMap.get(currentSessionId) ?? null : null
  const previousBrowserStateRef = React.useRef<{ sessionId: string | null; open: boolean }>({ sessionId: null, open: false })
  const pendingBrowserActivationRef = React.useRef<string | null>(null)

  const setActiveTab = React.useCallback((tab: AgentSidePanelTab) => {
    if (!currentSessionId) return
    setDiffPanelTabMap((prev) => {
      const map = new Map(prev)
      map.set(currentSessionId, tab)
      return map
    })
  }, [currentSessionId, setDiffPanelTabMap])

  // Agent 或回复链接在当前会话首次打开浏览器时，直接让右侧工作区承接它。
  // 切换到一个已有浏览器的会话时不抢占用户当前视图，保留该会话上次的外层 Tab。
  React.useEffect(() => {
    const unsubscribeOpen = window.electronAPI.onAgentTerminalOpen((event) => {
      setTerminalTabsMap((previous) => {
        const current = previous.get(event.sessionId) ?? []
        if (current.some((terminal) => terminal.terminalId === event.terminalId)) return previous
        const next = new Map(previous)
        next.set(event.sessionId, [...current, { terminalId: event.terminalId, title: event.title, cwd: event.cwd }])
        return next
      })
      if (event.sessionId !== currentSessionId) return
      setSidePanelOpen(true)
      setDiffPanelTabMap((previous) => {
        const next = new Map(previous)
        next.set(event.sessionId, getTerminalSidePanelTab(event.terminalId))
        return next
      })
    })
    const unsubscribeClose = window.electronAPI.onAgentTerminalClose((event) => {
      setTerminalTabsMap((previous) => {
        const current = previous.get(event.sessionId) ?? []
        const remaining = current.filter((terminal) => terminal.terminalId !== event.terminalId)
        if (remaining.length === current.length) return previous
        const next = new Map(previous)
        if (remaining.length > 0) next.set(event.sessionId, remaining)
        else next.delete(event.sessionId)
        return next
      })
      if (event.sessionId !== currentSessionId) return
      setDiffPanelTabMap((previous) => {
        if (previous.get(event.sessionId) !== getTerminalSidePanelTab(event.terminalId)) return previous
        const next = new Map(previous)
        next.set(event.sessionId, 'files')
        return next
      })
    })
    return () => {
      unsubscribeOpen()
      unsubscribeClose()
    }
  }, [currentSessionId, setDiffPanelTabMap, setSidePanelOpen, setTerminalTabsMap])

  React.useEffect(() => {
    const previous = previousBrowserStateRef.current
    const openedInCurrentSession = previous.sessionId === currentSessionId && !previous.open && browserOpen
    previousBrowserStateRef.current = { sessionId: currentSessionId, open: browserOpen }
    if (openedInCurrentSession && currentSessionId) pendingBrowserActivationRef.current = currentSessionId
    if (!currentSessionId || pendingBrowserActivationRef.current !== currentSessionId || !browserState?.activeTabId) return

    setSidePanelOpen(true)
    setDiffPanelTabMap((prev) => {
      const next = new Map(prev)
      next.set(currentSessionId, getBrowserSidePanelTab(browserState.activeTabId))
      return next
    })
    pendingBrowserActivationRef.current = null
  }, [browserOpen, browserState?.activeTabId, currentSessionId, setDiffPanelTabMap, setSidePanelOpen])

  if (!currentSessionId) {
    return null
  }

  const sessionPath = sessionPathMap.get(currentSessionId) ?? null
  const storedTab = diffPanelTabMap.get(currentSessionId) ?? 'files'
  // 兼容这次扁平化前内存中的旧“浏览器”工作区值。
  const activeTab: AgentSidePanelTab = storedTab === 'browser'
    ? browserState?.activeTabId ? getBrowserSidePanelTab(browserState.activeTabId) : 'files'
    : storedTab === 'preview'
      ? currentPreviewFile ? getPreviewSidePanelTab(getPreviewFileId(currentPreviewFile)) : 'files'
      : storedTab

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
