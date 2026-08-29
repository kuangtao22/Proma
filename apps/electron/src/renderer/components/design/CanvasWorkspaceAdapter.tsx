import * as React from 'react'
import { LEGACY_DESIGN_CANVAS_ID } from '@proma/shared'
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
  initializeAgentCanvasViewStateAtom,
  removeAgentCanvasViewStateAtom,
  updateAgentCanvasViewStateAtom,
  type AgentCanvasViewState,
} from '@/atoms/agent-canvas-atoms'
import { designAdapter } from '@/lib/design-adapter'
import type { DesignAdapter } from '@/lib/design-adapter'
import { getCanvasWorkspaceTab, type AgentSidePanelTab } from '@/atoms/agent-atoms'
import {
  mountNativeCanvasSessionView,
  NativeCanvasWorkspace,
  nativeCanvasSessionViewCleanupCoordinator,
} from './NativeCanvasWorkspace'
import { DesignWorkspaceView } from './DesignWorkspaceView'
import { cn } from '@/lib/utils'

/** Agent 右侧工作区需要的 Canvas 动态标签描述。 */
export interface CanvasWorkspaceTabDescriptor {
  id: AgentSidePanelTab
  canvasId: string
  title: string
  isDefault: boolean
  isRecent: boolean
  activityRevision: number
  seenActivityRevision: number
}

/** 按完整 view key 保存的轻量活动状态，不负责初始化 Canvas viewport。 */
export interface AgentCanvasActivityState {
  activityRevision: number
  seenActivityRevision: number
}

/**
 * 按 binding 的 linked 顺序组装动态标签。
 * 缺失 metadata 仍保留占位标签，让已删除状态先可见、再由适配器异步清理关联。
 */
export function buildCanvasWorkspaceTabs(
  binding: AgentCanvasBinding | null,
  sessions: readonly CanvasSessionMeta[],
  activityStates: ReadonlyMap<string, AgentCanvasActivityState> = new Map(),
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
      activityRevision: activityStates.get(canvasId)?.activityRevision ?? 0,
      seenActivityRevision: activityStates.get(canvasId)?.seenActivityRevision ?? 0,
    }
  })
}

export interface SubscribeAgentCanvasActivityInput {
  adapter: Pick<DesignAdapter, 'onCanvasChanges'>
  projectId: string
  sessionId: string
  binding: AgentCanvasBinding
  /** 只报告活动 Canvas 与隔离视图键，不接收标签切换能力。 */
  onActivity: (canvasId: string, viewStateKey: string) => void
}

/** 订阅 binding 中的 Canvas 活动；该边界没有修改工作区焦点的能力。 */
export function subscribeAgentCanvasActivity({
  adapter,
  projectId,
  sessionId,
  binding,
  onActivity,
}: SubscribeAgentCanvasActivityInput): () => void {
  const canvasIds = new Set(binding.linkedCanvasIds)
  return adapter.onCanvasChanges(projectId, canvasIds, (event) => {
    onActivity(event.canvasId, createAgentCanvasViewKey(sessionId, projectId, event.canvasId))
  })
}

/** 活动代次严格超过已读代次时才展示提示。 */
export function isAgentCanvasActivityUnread(
  state: Pick<AgentCanvasViewState, 'activityRevision' | 'seenActivityRevision'>,
): boolean {
  return state.activityRevision > state.seenActivityRevision
}

/** 解除当前 Agent 的单个 Canvas 关联，不触碰 Canvas 会话本身。 */
export async function unlinkAgentCanvasForSession(
  adapter: Pick<DesignAdapter, 'unlinkAgentCanvas'>,
  projectId: string,
  sessionId: string,
  canvasId: string,
): Promise<AgentCanvasBinding | null> {
  return adapter.unlinkAgentCanvas({ projectId, sessionId, canvasId })
}

/** 更新单个 Agent 的最近 Canvas，不改变默认项或右侧焦点。 */
export async function markAgentCanvasActive(
  adapter: Pick<DesignAdapter, 'linkAgentCanvas'>,
  projectId: string,
  sessionId: string,
  canvasId: string,
): Promise<AgentCanvasBinding> {
  return adapter.linkAgentCanvas({ projectId, sessionId, canvasId, makeDefault: false })
}

export interface ReconcileMissingCanvasInput {
  canvasId: string
  metadataReady: boolean
  session: CanvasSessionMeta | null
  onUnlink: (canvasId: string) => Promise<void>
  onError: (error: unknown) => void
}

/** 对账已删除 Canvas；失败在边界内收口，避免 effect 产生未处理拒绝。 */
export async function reconcileMissingCanvas({
  canvasId,
  metadataReady,
  session,
  onUnlink,
  onError,
}: ReconcileMissingCanvasInput): Promise<'noop' | 'unlinked' | 'failed'> {
  if (!metadataReady || session) return 'noop'
  try {
    await onUnlink(canvasId)
    return 'unlinked'
  } catch (error) {
    onError(error)
    return 'failed'
  }
}

/** SidePanel 与具体 Canvas pane 共享的轻量关联状态。 */
export interface AgentCanvasWorkspaceRegistry {
  binding: AgentCanvasBinding | null
  sessions: CanvasSessionMeta[]
  metadataReady: boolean
  bindingReady: boolean
  loading: boolean
  error: string | null
  canvasActivityStates: ReadonlyMap<string, AgentCanvasActivityState>
  linkAndOpen: (canvasId: string, makeDefault?: boolean) => Promise<void>
  markActive: (canvasId: string) => Promise<void>
  markActivitySeen: (canvasId: string) => void
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
  const [activityStatesByViewKey, setActivityStatesByViewKey] = React.useState<Map<string, AgentCanvasActivityState>>(new Map())
  const lifecycleRef = React.useRef({ projectId, sessionId, generation: 0 })
  if (lifecycleRef.current.projectId !== projectId || lifecycleRef.current.sessionId !== sessionId) {
    lifecycleRef.current = { projectId, sessionId, generation: lifecycleRef.current.generation + 1 }
  }
  const generation = lifecycleRef.current.generation
  const isCurrent = React.useCallback(() => {
    const current = lifecycleRef.current
    return current.projectId === projectId && current.sessionId === sessionId && current.generation === generation
  }, [generation, projectId, sessionId])
  const sessions = projectId ? sessionsByProject.get(projectId) ?? [] : []
  const projectStatus = projectId ? statusByProject.get(projectId) : undefined
  const metadataReady = projectStatus?.phase === 'ready' || sessionsByProject.has(projectId ?? '')

  React.useEffect(() => {
    let disposed = false
    setBinding(null)
    setBindingReady(false)
    setError(null)
    setLoading(false)
    setActivityStatesByViewKey(new Map())
    if (!projectId) return
    setLoading(true)
    let bindingEventReceived = false
    void designAdapter.listAgentCanvasBindings({ projectId })
      .then((bindings) => {
        if (!disposed && isCurrent() && !bindingEventReceived) {
          setBinding(bindings.find((item) => item.sessionId === sessionId) ?? null)
        }
      })
      .catch((cause: unknown) => {
        if (!disposed && isCurrent()) {
          console.error('[CanvasWorkspaceAdapter] 加载画布关联失败:', cause)
          setError('画布关联加载失败')
        }
      })
      .finally(() => {
        if (!disposed && isCurrent()) setLoading(false)
        if (!disposed && isCurrent()) setBindingReady(true)
      })
    const release = designAdapter.onAgentCanvasBindingChanged({ projectId, sessionId }, (event) => {
      bindingEventReceived = true
      if (!disposed && isCurrent()) {
        setBinding(event.binding)
        setBindingReady(true)
        setLoading(false)
      }
    })
    return () => {
      disposed = true
      release()
    }
  }, [isCurrent, projectId, sessionId])

  React.useEffect(() => {
    if (!projectId || !binding || binding.projectId !== projectId || binding.sessionId !== sessionId) return
    const linkedViewKeys = new Set(binding.linkedCanvasIds.map((canvasId) => (
      createAgentCanvasViewKey(sessionId, projectId, canvasId)
    )))
    setActivityStatesByViewKey((previous) => {
      const next = new Map([...previous].filter(([key]) => linkedViewKeys.has(key)))
      return next.size === previous.size ? previous : next
    })
    return subscribeAgentCanvasActivity({
      adapter: designAdapter,
      projectId,
      sessionId,
      binding,
      onActivity: (canvasId, key) => {
        if (!isCurrent()) return
        setActivityStatesByViewKey((previous) => {
          const current = previous.get(key) ?? { activityRevision: 0, seenActivityRevision: 0 }
          const next = new Map(previous)
          next.set(key, { ...current, activityRevision: current.activityRevision + 1 })
          return next
        })
        updateViewState({
          key,
          update: (current) => ({ activityRevision: current.activityRevision + 1 }),
        })
      },
    })
  }, [binding, isCurrent, projectId, sessionId, updateViewState])

  const linkAndOpen = React.useCallback(async (canvasId: string, makeDefault = false): Promise<void> => {
    if (!projectId) return
    try {
      const next = await designAdapter.linkAgentCanvas({ projectId, sessionId, canvasId, makeDefault })
      if (!isCurrent()) return
      setBinding(next)
      onOpenTab(getCanvasWorkspaceTab(canvasId))
    } catch (cause) {
      if (isCurrent()) throw cause
    }
  }, [isCurrent, onOpenTab, projectId, sessionId])

  /** 复用关联合同更新最近画布，不改变右侧工作区焦点。 */
  const markActive = React.useCallback(async (canvasId: string): Promise<void> => {
    if (!projectId) return
    try {
      const next = await markAgentCanvasActive(designAdapter, projectId, sessionId, canvasId)
      if (isCurrent()) setBinding(next)
    } catch (cause) {
      if (isCurrent()) throw cause
    }
  }, [isCurrent, projectId, sessionId])

  const markActivitySeen = React.useCallback((canvasId: string): void => {
    if (!projectId || !isCurrent()) return
    const key = createAgentCanvasViewKey(sessionId, projectId, canvasId)
    setActivityStatesByViewKey((previous) => {
      const current = previous.get(key)
      if (!current || current.seenActivityRevision === current.activityRevision) return previous
      const next = new Map(previous)
      next.set(key, { ...current, seenActivityRevision: current.activityRevision })
      return next
    })
    updateViewState({ key, update: (current) => ({ seenActivityRevision: current.activityRevision }) })
  }, [isCurrent, projectId, sessionId, updateViewState])

  const createAndOpen = React.useCallback(async (): Promise<void> => {
    if (!projectId) return
    try {
      const created = await designAdapter.createCanvasSession({ projectId })
      if (!isCurrent()) return
      replaceSessions({ projectId, sessions: [created, ...sessions.filter((session) => session.id !== created.id)] })
      await linkAndOpen(created.id, binding?.defaultCanvasId === undefined)
    } catch (cause) {
      if (isCurrent()) throw cause
    }
  }, [binding?.defaultCanvasId, isCurrent, linkAndOpen, projectId, replaceSessions, sessions])

  const unlink = React.useCallback(async (canvasId: string): Promise<void> => {
    if (!projectId) return
    try {
      const next = await unlinkAgentCanvasForSession(designAdapter, projectId, sessionId, canvasId)
      if (isCurrent()) setBinding(next)
    } catch (cause) {
      if (isCurrent()) throw cause
    }
  }, [isCurrent, projectId, sessionId])

  const setDefault = React.useCallback(async (canvasId: string): Promise<void> => {
    if (!projectId) return
    try {
      const next = await designAdapter.setDefaultAgentCanvas({ projectId, sessionId, canvasId })
      if (isCurrent()) setBinding(next)
    } catch (cause) {
      if (isCurrent()) throw cause
    }
  }, [isCurrent, projectId, sessionId])

  const canvasActivityStates = React.useMemo(() => {
    const states = new Map<string, AgentCanvasActivityState>()
    if (!projectId || !binding || binding.projectId !== projectId || binding.sessionId !== sessionId) return states
    for (const canvasId of binding.linkedCanvasIds) {
      const state = activityStatesByViewKey.get(createAgentCanvasViewKey(sessionId, projectId, canvasId))
      if (state) states.set(canvasId, state)
    }
    return states
  }, [activityStatesByViewKey, binding, projectId, sessionId])

  return {
    binding,
    sessions,
    metadataReady,
    bindingReady,
    loading,
    error: error ?? projectStatus?.error ?? null,
    canvasActivityStates,
    linkAndOpen,
    markActive,
    markActivitySeen,
    createAndOpen,
    unlink,
    setDefault,
  }
}

/** legacy Design 不触发 native LOAD，因此在宿主 effect 内显式建立轻量会话视图。 */
export function useAgentCanvasLegacyViewInitialization(
  sessionId: string,
  projectId: string,
  canvasId: string,
): void {
  const initializeViewState = useSetAtom(initializeAgentCanvasViewStateAtom)
  const removeViewState = useSetAtom(removeAgentCanvasViewStateAtom)
  const key = createAgentCanvasViewKey(sessionId, projectId, canvasId)
  React.useEffect(() => {
    if (canvasId !== LEGACY_DESIGN_CANVAS_ID) return
    initializeViewState({ key, viewport: { x: 0, y: 0, zoom: 1 } })
    return mountNativeCanvasSessionView(
      nativeCanvasSessionViewCleanupCoordinator,
      key,
      removeViewState,
    )
  }, [canvasId, initializeViewState, key, removeViewState])
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
  /** 测试或宿主可替换旧 Design 内容；只有 legacy 分支才会调用。 */
  renderLegacyWorkspace?: () => React.ReactNode
  /** 测试或宿主可替换原生 Canvas；只有 native 分支才会调用。 */
  renderNativeWorkspace?: (props: {
    sessionId: string
    target: { projectId: string; canvasId: string }
    title: string
    presentation: 'side-panel'
  }) => React.ReactNode
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
  renderLegacyWorkspace,
  renderNativeWorkspace,
}: CanvasWorkspaceAdapterProps): React.ReactElement {
  const viewStateKey = createAgentCanvasViewKey(sessionId, projectId, canvasId)
  const viewState = useAtomValue(agentCanvasViewStatesAtom).get(viewStateKey)
  const updateViewState = useSetAtom(updateAgentCanvasViewStateAtom)
  useAgentCanvasLegacyViewInitialization(sessionId, projectId, canvasId)
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
    void reconcileMissingCanvas({
      canvasId,
      metadataReady,
      session,
      onUnlink,
      onError: (cause) => {
        console.error('[CanvasWorkspaceAdapter] 清理失效画布关联失败:', cause)
      },
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
  const isLegacy = session.id === LEGACY_DESIGN_CANVAS_ID
  const workspace = isLegacy
    ? (renderLegacyWorkspace?.() ?? <DesignWorkspaceView />)
    : (renderNativeWorkspace?.({
        sessionId,
        target: { projectId, canvasId },
        title: session.title,
        presentation: 'side-panel',
      }) ?? (
        <NativeCanvasWorkspace
          sessionId={sessionId}
          target={{ projectId, canvasId }}
          title={session.title}
          presentation="side-panel"
        />
      ))
  return (
    <div className={cn(
      'relative h-full min-h-0 overflow-hidden bg-content-area',
      isExpanded && 'fixed inset-0 z-[200]',
    )}>
      {workspace}
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
