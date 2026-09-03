import * as React from 'react'
import { LEGACY_DESIGN_CANVAS_ID } from '@proma/shared'
import type { AgentCanvasBinding, CanvasSessionMeta } from '@proma/shared'
import { useAtomValue, useSetAtom } from 'jotai'
import { Maximize2, Minimize2, PanelLeft, Trash2, Workflow } from 'lucide-react'
import {
  canvasSessionsByProjectAtom,
  canvasSessionStatusByProjectAtom,
  replaceCanvasSessionsAtom,
} from '@/atoms/canvas-session-atoms'
import {
  createAgentCanvasViewKey,
  agentCanvasActivityStatesAtom,
  agentCanvasViewStatesAtom,
  initializeAgentCanvasViewStateAtom,
  removeAgentCanvasViewStateAtom,
  markAgentCanvasActivitySeenAtom,
  updateAgentCanvasViewStateAtom,
  type AgentCanvasActivityState,
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
import { CanvasWorkspaceSidebar } from './CanvasWorkspaceSidebar'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
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
  const activityStatesByViewKey = useAtomValue(agentCanvasActivityStatesAtom)
  const markActivitySeenByKey = useSetAtom(markAgentCanvasActivitySeenAtom)
  const [binding, setBinding] = React.useState<AgentCanvasBinding | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [bindingReady, setBindingReady] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
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
    markActivitySeenByKey(key)
  }, [isCurrent, markActivitySeenByKey, projectId, sessionId])

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
  /** 当前项目的完整画布索引。 */
  sessions?: readonly CanvasSessionMeta[]
  /** 当前 Agent 绑定的默认画布 ID。 */
  defaultCanvasId?: string
  /** 当前 Agent 按画布隔离的活动代次。 */
  activityStates?: ReadonlyMap<string, AgentCanvasActivityState>
  /** 新建并打开画布，返回是否成功。 */
  onCreateCanvas?: () => Promise<boolean>
  /** 打开未归档画布，或恢复并打开归档画布。 */
  onOpenCanvas?: (session: CanvasSessionMeta) => Promise<boolean>
  /** 修改画布标题，返回是否成功。 */
  onRenameCanvas?: (session: CanvasSessionMeta, title: string) => Promise<boolean>
  /** 把指定未归档画布设为默认。 */
  onSetDefaultCanvas?: (session: CanvasSessionMeta) => Promise<boolean>
  /** 归档或恢复指定画布。 */
  onToggleArchiveCanvas?: (session: CanvasSessionMeta) => Promise<boolean>
  /** 请求宿主打开共用的永久删除确认。 */
  onRequestDeleteCanvas?: (session: CanvasSessionMeta) => void
  /** 测试或宿主可替换旧 Design 内容；只有 legacy 分支才会调用。 */
  renderLegacyWorkspace?: () => React.ReactNode
  /** 测试或宿主可替换原生 Canvas；只有 native 分支才会调用。 */
  renderNativeWorkspace?: (props: {
    sessionId: string
    target: { projectId: string; canvasId: string }
    title: string
    presentation: 'side-panel'
    headerLeading?: React.ReactNode
    headerTitle?: React.ReactNode
    headerActions?: React.ReactNode
  }) => React.ReactNode
}

export interface CanvasWorkspaceTitleSubmitResult {
  status: 'reset' | 'unchanged' | 'saved' | 'failed'
  title: string
}

export interface SubmitCanvasWorkspaceTitleInput {
  originalTitle: string
  draftTitle: string
  rename: (title: string) => Promise<boolean>
}

/** 归一化标题并返回组件应采取的确定性编辑结果。 */
export async function submitCanvasWorkspaceTitle(
  input: SubmitCanvasWorkspaceTitleInput,
): Promise<CanvasWorkspaceTitleSubmitResult> {
  const title = input.draftTitle.trim()
  if (!title) return { status: 'reset', title: input.originalTitle }
  if (title === input.originalTitle) return { status: 'unchanged', title }
  return await input.rename(title)
    ? { status: 'saved', title }
    : { status: 'failed', title }
}

export type CanvasWorkspaceEscapeAction = 'cancel-title' | 'close-sidebar' | 'exit-expanded'

/** 只选择最内层的 Escape 动作，避免一次按键关闭多层状态。 */
export function resolveCanvasWorkspaceEscapeAction(input: {
  editingTitle: boolean
  sidebarOpen: boolean
  expanded: boolean
}): CanvasWorkspaceEscapeAction | null {
  if (input.editingTitle) return 'cancel-title'
  if (input.sidebarOpen) return 'close-sidebar'
  if (input.expanded) return 'exit-expanded'
  return null
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
  sessions = session ? [session] : [],
  defaultCanvasId,
  activityStates = new Map(),
  onCreateCanvas = async () => false,
  onOpenCanvas = async () => false,
  onRenameCanvas = async () => false,
  onSetDefaultCanvas = async () => false,
  onToggleArchiveCanvas = async () => false,
  onRequestDeleteCanvas = () => undefined,
  renderLegacyWorkspace,
  renderNativeWorkspace,
}: CanvasWorkspaceAdapterProps): React.ReactElement {
  const viewStateKey = createAgentCanvasViewKey(sessionId, projectId, canvasId)
  const viewState = useAtomValue(agentCanvasViewStatesAtom).get(viewStateKey)
  const updateViewState = useSetAtom(updateAgentCanvasViewStateAtom)
  useAgentCanvasLegacyViewInitialization(sessionId, projectId, canvasId)
  const isExpanded = viewState?.isExpanded ?? false
  const [sidebarOpen, setSidebarOpen] = React.useState(false)
  const [editingTitle, setEditingTitle] = React.useState(false)
  const [titleDraft, setTitleDraft] = React.useState(session?.title ?? '')
  const [renaming, setRenaming] = React.useState(false)
  const titleInputRef = React.useRef<HTMLInputElement>(null)

  const setExpanded = React.useCallback((expanded: boolean): void => {
    updateViewState({ key: viewStateKey, update: { isExpanded: expanded } })
  }, [updateViewState, viewStateKey])

  React.useEffect(() => {
    if (!editingTitle) setTitleDraft(session?.title ?? '')
  }, [editingTitle, session?.title])

  React.useEffect(() => {
    if (editingTitle) titleInputRef.current?.select()
  }, [editingTitle])

  /** 取消标题编辑并恢复权威标题。 */
  const cancelTitleEdit = React.useCallback((): void => {
    setTitleDraft(session?.title ?? '')
    setEditingTitle(false)
  }, [session?.title])

  React.useEffect(() => {
    if (!editingTitle && !sidebarOpen && !isExpanded) return
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      const action = resolveCanvasWorkspaceEscapeAction({ editingTitle, sidebarOpen, expanded: isExpanded })
      if (!action) return
      event.preventDefault()
      if (action === 'cancel-title') cancelTitleEdit()
      else if (action === 'close-sidebar') setSidebarOpen(false)
      else setExpanded(false)
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [cancelTitleEdit, editingTitle, isExpanded, setExpanded, sidebarOpen])

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

  /** 提交标题；失败时保留草稿和编辑态供用户直接重试。 */
  const submitTitle = async (): Promise<void> => {
    if (renaming) return
    setRenaming(true)
    try {
      const result = await submitCanvasWorkspaceTitle({
        originalTitle: session.title,
        draftTitle: titleDraft,
        rename: (title) => onRenameCanvas(session, title),
      })
      setTitleDraft(result.title)
      if (result.status !== 'failed') setEditingTitle(false)
    } catch {
      setEditingTitle(true)
    } finally {
      setRenaming(false)
    }
  }

  /** Pane 标题前的项目画布列表入口。 */
  const headerLeading = (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button type="button" variant="ghost" size="icon-sm" aria-label="打开画布列表" onClick={() => setSidebarOpen(true)}>
          <PanelLeft className="size-3.5" aria-hidden="true" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>画布列表</TooltipContent>
    </Tooltip>
  )
  /** 标题展示与原地编辑共享同一稳定宽度。 */
  const headerTitle = editingTitle ? (
    <Input
      ref={titleInputRef}
      value={titleDraft}
      aria-label="编辑画布标题"
      disabled={renaming}
      className="h-7 min-w-0 flex-1 border-0 px-2 text-sm font-medium shadow-none focus-visible:ring-1"
      onChange={(event) => setTitleDraft(event.target.value)}
      onBlur={() => { void submitTitle() }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          void submitTitle()
        } else if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          cancelTitleEdit()
        }
      }}
    />
  ) : (
    <button
      type="button"
      className="min-w-0 flex-1 truncate rounded-sm px-2 py-1 text-left text-sm font-medium text-foreground outline-none hover:bg-muted/70 focus-visible:ring-1 focus-visible:ring-ring"
      aria-label={`编辑画布标题：${session.title}`}
      onClick={() => setEditingTitle(true)}
    >
      {session.title}
    </button>
  )
  /** 当前画布低频操作与展开控制统一放入标题栏。 */
  const headerActions = (
    <>
      {!isLegacy ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="删除当前画布"
              onClick={() => onRequestDeleteCanvas(session)}
            >
              <Trash2 className="size-3.5" aria-hidden="true" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>删除当前画布</TooltipContent>
        </Tooltip>
      ) : null}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            disabled={!viewState}
            onClick={() => setExpanded(!isExpanded)}
            aria-label={isExpanded ? '还原画布' : '展开画布'}
          >
            {isExpanded
              ? <Minimize2 className="size-3.5" aria-hidden="true" />
              : <Maximize2 className="size-3.5" aria-hidden="true" />}
          </Button>
        </TooltipTrigger>
        <TooltipContent>{isExpanded ? '还原画布' : '展开画布'}</TooltipContent>
      </Tooltip>
    </>
  )
  const workspace = isLegacy
    ? (
        <section className="flex h-full min-h-0 flex-col bg-content-area">
          <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-2">
            {headerLeading}
            {headerTitle}
            <div className="ml-auto flex shrink-0 items-center gap-1">{headerActions}</div>
          </header>
          <div className="min-h-0 flex-1">{renderLegacyWorkspace?.() ?? <DesignWorkspaceView />}</div>
        </section>
      )
    : (renderNativeWorkspace?.({
        sessionId,
        target: { projectId, canvasId },
        title: session.title,
        presentation: 'side-panel',
        headerLeading,
        headerTitle,
        headerActions,
      }) ?? (
        <NativeCanvasWorkspace
          sessionId={sessionId}
          target={{ projectId, canvasId }}
          title={session.title}
          presentation="side-panel"
          headerLeading={headerLeading}
          headerTitle={headerTitle}
          headerActions={headerActions}
        />
      ))
  return (
    <TooltipProvider delayDuration={200} disableHoverableContent>
      <div className={cn(
        'relative h-full min-h-0 overflow-hidden bg-content-area',
        isExpanded && 'fixed inset-0 z-[200]',
      )}>
        {workspace}
        <CanvasWorkspaceSidebar
          open={sidebarOpen}
          currentCanvasId={canvasId}
          sessions={sessions}
          defaultCanvasId={defaultCanvasId}
          activityStates={activityStates}
          onOpenChange={setSidebarOpen}
          onCreateCanvas={onCreateCanvas}
          onOpenCanvas={onOpenCanvas}
          onSetDefaultCanvas={onSetDefaultCanvas}
          onToggleArchiveCanvas={onToggleArchiveCanvas}
          onRequestDeleteCanvas={onRequestDeleteCanvas}
        />
      </div>
    </TooltipProvider>
  )
}
