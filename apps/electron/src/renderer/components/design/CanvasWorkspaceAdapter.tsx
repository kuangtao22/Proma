import * as React from 'react'
import type { AgentCanvasBinding, CanvasSessionMeta } from '@proma/shared'
import { useAtomValue, useSetAtom } from 'jotai'
import { Maximize2, Minimize2, Workflow } from 'lucide-react'
import {
  canvasSessionsByProjectAtom,
  canvasSessionStatusByProjectAtom,
  replaceCanvasSessionsAtom,
} from '@/atoms/canvas-session-atoms'
import {
  createAgentCanvasViewKey,
  agentCanvasViewStatesAtom,
  updateAgentCanvasViewStateAtom,
} from '@/atoms/agent-canvas-atoms'
import { designAdapter } from '@/lib/design-adapter'
import { getCanvasWorkspaceTab, type AgentSidePanelTab } from '@/atoms/agent-atoms'
import { NativeCanvasWorkspace } from './NativeCanvasWorkspace'
import { cn } from '@/lib/utils'

/** Agent 右侧工作区需要的 Canvas 动态标签描述。 */
export interface CanvasWorkspaceTabDescriptor {
  id: AgentSidePanelTab
  canvasId: string
  title: string
  isDefault: boolean
  isRecent: boolean
  activityRevision: number
}

/**
 * 按 binding 的 linked 顺序组装动态标签。
 * 缺失 metadata 仍保留占位标签，让已删除状态先可见、再由适配器异步清理关联。
 */
export function buildCanvasWorkspaceTabs(
  binding: AgentCanvasBinding | null,
  sessions: readonly CanvasSessionMeta[],
  activityRevisions: ReadonlyMap<string, number> = new Map(),
): CanvasWorkspaceTabDescriptor[] {
  if (!binding) return []
  const sessionsById = new Map(sessions.map((session) => [session.id, session]))
  return binding.linkedCanvasIds.map((canvasId) => {
    const session = sessionsById.get(canvasId)
    return {
      id: getCanvasWorkspaceTab(canvasId),
      canvasId,
      title: session?.title ?? '画布已删除',
      isDefault: binding.defaultCanvasId === canvasId,
      isRecent: binding.lastActiveCanvasId === canvasId,
      activityRevision: activityRevisions.get(canvasId) ?? 0,
    }
  })
}

/** SidePanel 与具体 Canvas pane 共享的轻量关联状态。 */
export interface AgentCanvasWorkspaceRegistry {
  binding: AgentCanvasBinding | null
  sessions: CanvasSessionMeta[]
  metadataReady: boolean
  bindingReady: boolean
  loading: boolean
  error: string | null
  canvasActivityRevision: ReadonlyMap<string, number>
  linkAndOpen: (canvasId: string, makeDefault?: boolean) => Promise<void>
  markActive: (canvasId: string) => Promise<void>
  createAndOpen: () => Promise<void>
  unlink: (canvasId: string) => Promise<void>
  setDefault: (canvasId: string) => Promise<void>
}

/** 加载并订阅当前普通 Agent 的 Canvas 关联；事件只更新本地状态，不切换右侧焦点。 */
export function useAgentCanvasWorkspaceRegistry(
  projectId: string | null,
  sessionId: string,
  onOpenTab: (tab: AgentSidePanelTab) => void,
): AgentCanvasWorkspaceRegistry {
  const sessionsByProject = useAtomValue(canvasSessionsByProjectAtom)
  const statusByProject = useAtomValue(canvasSessionStatusByProjectAtom)
  const replaceSessions = useSetAtom(replaceCanvasSessionsAtom)
  const updateViewState = useSetAtom(updateAgentCanvasViewStateAtom)
  const [binding, setBinding] = React.useState<AgentCanvasBinding | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [bindingReady, setBindingReady] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [activityRevisions, setActivityRevisions] = React.useState<Map<string, number>>(new Map())
  const sessions = projectId ? sessionsByProject.get(projectId) ?? [] : []
  const projectStatus = projectId ? statusByProject.get(projectId) : undefined
  const metadataReady = projectStatus?.phase === 'ready' || sessionsByProject.has(projectId ?? '')

  React.useEffect(() => {
    let disposed = false
    setBinding(null)
    setBindingReady(false)
    setError(null)
    if (!projectId) return
    setLoading(true)
    let bindingEventReceived = false
    void designAdapter.listAgentCanvasBindings({ projectId })
      .then((bindings) => {
        if (!disposed && !bindingEventReceived) {
          setBinding(bindings.find((item) => item.sessionId === sessionId) ?? null)
        }
      })
      .catch((cause: unknown) => {
        if (!disposed) setError(cause instanceof Error ? cause.message : '画布关联加载失败')
      })
      .finally(() => {
        if (!disposed) setLoading(false)
        if (!disposed) setBindingReady(true)
      })
    const release = designAdapter.onAgentCanvasBindingChanged({ projectId, sessionId }, (event) => {
      bindingEventReceived = true
      if (!disposed) {
        setBinding(event.binding)
        setBindingReady(true)
      }
    })
    return () => {
      disposed = true
      release()
    }
  }, [projectId, sessionId])

  React.useEffect(() => {
    if (!projectId || !binding) return
    const releases = binding.linkedCanvasIds.map((canvasId) => designAdapter.onCanvasChanged(
      { projectId, canvasId },
      () => {
        setActivityRevisions((previous) => {
          const next = new Map(previous)
          next.set(canvasId, (previous.get(canvasId) ?? 0) + 1)
          return next
        })
        const key = createAgentCanvasViewKey(sessionId, projectId, canvasId)
        updateViewState({
          key,
          update: (current) => ({ activityRevision: current.activityRevision + 1 }),
        })
      },
    ))
    return () => releases.forEach((release) => release())
  }, [binding, projectId, sessionId, updateViewState])

  const linkAndOpen = React.useCallback(async (canvasId: string, makeDefault = false): Promise<void> => {
    if (!projectId) return
    const next = await designAdapter.linkAgentCanvas({ projectId, sessionId, canvasId, makeDefault })
    setBinding(next)
    onOpenTab(getCanvasWorkspaceTab(canvasId))
  }, [onOpenTab, projectId, sessionId])

  /** 复用关联合同更新最近画布，不改变右侧工作区焦点。 */
  const markActive = React.useCallback(async (canvasId: string): Promise<void> => {
    if (!projectId) return
    setBinding(await designAdapter.linkAgentCanvas({ projectId, sessionId, canvasId, makeDefault: false }))
  }, [projectId, sessionId])

  const createAndOpen = React.useCallback(async (): Promise<void> => {
    if (!projectId) return
    const created = await designAdapter.createCanvasSession({ projectId })
    replaceSessions({ projectId, sessions: [created, ...sessions.filter((session) => session.id !== created.id)] })
    await linkAndOpen(created.id, binding?.defaultCanvasId === undefined)
  }, [binding?.defaultCanvasId, linkAndOpen, projectId, replaceSessions, sessions])

  const unlink = React.useCallback(async (canvasId: string): Promise<void> => {
    if (!projectId) return
    const next = await designAdapter.unlinkAgentCanvas({ projectId, sessionId, canvasId })
    setBinding(next)
  }, [projectId, sessionId])

  const setDefault = React.useCallback(async (canvasId: string): Promise<void> => {
    if (!projectId) return
    setBinding(await designAdapter.setDefaultAgentCanvas({ projectId, sessionId, canvasId }))
  }, [projectId, sessionId])

  return {
    binding,
    sessions,
    metadataReady,
    bindingReady,
    loading,
    error: error ?? projectStatus?.error ?? null,
    canvasActivityRevision: activityRevisions,
    linkAndOpen,
    markActive,
    createAndOpen,
    unlink,
    setDefault,
  }
}

export interface CanvasWorkspaceAdapterProps {
  sessionId: string
  projectId: string
  canvasId: string
  session: CanvasSessionMeta | null
  metadataReady: boolean
  loading?: boolean
  error?: string | null
  onUnlink: (canvasId: string) => Promise<void>
}

/** 只桥接 Agent binding/metadata 与原生 Canvas，不读取旧全局 active selection。 */
export function CanvasWorkspaceAdapter({
  sessionId,
  projectId,
  canvasId,
  session,
  metadataReady,
  loading = false,
  error = null,
  onUnlink,
}: CanvasWorkspaceAdapterProps): React.ReactElement {
  const viewStateKey = createAgentCanvasViewKey(sessionId, projectId, canvasId)
  const viewState = useAtomValue(agentCanvasViewStatesAtom).get(viewStateKey)
  const updateViewState = useSetAtom(updateAgentCanvasViewStateAtom)
  const isExpanded = viewState?.isExpanded ?? false

  const setExpanded = React.useCallback((expanded: boolean): void => {
    updateViewState({ key: viewStateKey, update: { isExpanded: expanded } })
  }, [updateViewState, viewStateKey])

  React.useEffect(() => {
    if (!isExpanded) return
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      setExpanded(false)
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isExpanded, setExpanded])

  React.useEffect(() => {
    if (!metadataReady || session) return
    void onUnlink(canvasId).catch((cause: unknown) => {
      console.error('[CanvasWorkspaceAdapter] 清理失效画布关联失败:', cause)
    })
  }, [canvasId, metadataReady, onUnlink, session])

  if (error) {
    return <div className="flex h-full items-center justify-center px-6 text-center text-sm text-destructive">{error}</div>
  }
  if (loading || !metadataReady) {
    return <div className="flex h-full items-center justify-center text-sm text-muted-foreground">正在加载画布...</div>
  }
  if (!session) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center">
        <div className="flex flex-col items-center gap-2 text-muted-foreground">
          <Workflow className="size-6" aria-hidden="true" />
          <p className="text-sm">画布已删除</p>
        </div>
      </div>
    )
  }
  if (session.archived) {
    return <div className="flex h-full items-center justify-center text-sm text-muted-foreground">画布已归档</div>
  }
  return (
    <div className={cn(
      'relative h-full min-h-0 overflow-hidden bg-content-area',
      isExpanded && 'fixed inset-0 z-[200]',
    )}>
      <NativeCanvasWorkspace
        sessionId={sessionId}
        target={{ projectId, canvasId }}
        title={session.title}
        presentation="side-panel"
      />
      <button
        type="button"
        disabled={!viewState}
        onClick={() => setExpanded(!isExpanded)}
        aria-label={isExpanded ? '还原画布' : '展开画布'}
        className="absolute right-12 top-2 z-20 inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
      >
        {isExpanded ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
      </button>
    </div>
  )
}
