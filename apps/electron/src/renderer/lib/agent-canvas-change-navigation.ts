import type { AgentCanvasBinding, AgentCanvasBindingChangeEvent, AgentEvent, CanvasToolNavigationResult } from '@proma/shared'
import { atom } from 'jotai'
import type { Store } from 'jotai/vanilla/store'
import {
  agentCanvasWorkspaceStateMapAtom, agentDiffPanelTabAtom, agentSessionsAtom,
  agentSidePanelOpenAtomFamily, agentSidePanelOpenMapAtom, agentSidePanelSplitMapAtom, agentStreamingStatesAtom,
  currentAgentSessionIdAtom, getCanvasWorkspaceTab, rememberAgentCanvasWorkspaceTab,
} from '@/atoms/agent-atoms'
import { canvasAgentOwnersAtom } from '@/atoms/native-canvas-atoms'
import { appModeAtom } from '@/atoms/app-mode'
import { agentCanvasFocusRequestsAtom, clearAgentCanvasFocusAtom, agentCanvasNavigationInterruptedSessionsAtom, agentCanvasViewStatesAtom, createAgentCanvasViewKey, requestAgentCanvasFocusAtom } from '@/atoms/agent-canvas-atoms'
import { getFocusedRightWorkspaceTab, selectRightWorkspaceSplitTab } from './right-workspace-split'
import { designAdapter } from './design-adapter'
import { parseCanvasArtifactToolResult } from './agent-canvas-artifact-result'

/** 仅由成功写工具返回的轻量定位回执；revision 是图版本，不是正文版本。 */
export interface CanvasChangeNavigation extends Omit<CanvasToolNavigationResult, 'action' | 'deletedNodeIds'> {
  /** 兼容升级前的创建回执；新版 Host 总是返回动作和删除集合。 */
  deletedNodeIds?: string[]
  action?: CanvasToolNavigationResult['action']
  /** Host 根据真实编排记录签发的普通聊天身份，不能由模型参数指定。 */
  ownerSessionId?: string
}

/** 当前进程内的合并修改摘要，按发起聊天与画布隔离，不保存媒体或正文。 */
export interface AgentCanvasChangeNotice extends CanvasChangeNavigation {
  sessionId: string
  runKey: string
  changes: number
}

/** 最多保留 64 个画布摘要；旧摘要仅从界面缓存淘汰，业务历史仍在原记录。 */
export const agentCanvasChangeNoticesAtom = atom<Map<string, AgentCanvasChangeNotice>>(new Map())

/** 明确写工具白名单；只读查询与生成受理不能伪装成内容已修改。 */
const CHANGE_TOOLS = new Set([
  'canvas_manage', 'canvas_create_artifact', 'canvas_import_image', 'canvas_create_agent', 'canvas_apply_changes',
  'canvas_create_media', 'canvas_update_artifact', 'canvas_update_agent_config',
  'canvas_update_image_config', 'canvas_update_media_config', 'canvas_adopt_media_candidate',
  'canvas_attach_media_assets', 'canvas_attach_media_run', 'canvas_run_agent',
  'canvas_adopt_version', 'canvas_adopt_candidate_batch', 'canvas_restore_node', 'canvas_rebuild_agent',
  'canvas_delegate', 'canvas_resume_orchestration', 'canvas_cancel_orchestration',
  'canvas_update_plan', 'canvas_dispatch', 'canvas_review_step', 'canvas_report_orchestration', 'canvas_finish_orchestration',
])

/** 校验短身份，拒绝空字符串与非文本值。 */
function isIdentity(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 256
}

/** JSON 对象边界，不使用不受约束的对象类型。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** 只读取正式 navigation 字段，兼容 Pi 的纯文本块封装。 */
export function parseCanvasChangeNavigation(result: string): CanvasChangeNavigation | null {
  try {
    /** 工具输出属于非可信输入，解析后逐字段复核。 */
    let value: unknown = JSON.parse(result)
    if (Array.isArray(value)) {
      if (!value.length || !value.every(block => isRecord(block) && block.type === 'text' && typeof block.text === 'string')) return null
      value = JSON.parse(value.map(block => (block as { text: string }).text).join('')) as unknown
    }
    if (!isRecord(value) || !isRecord(value.navigation)) return null
    const navigation = value.navigation
    if (navigation.status !== 'changed' || !isIdentity(navigation.projectId) || !isIdentity(navigation.canvasId)) return null
    if (!Array.isArray(navigation.nodeIds) || navigation.nodeIds.length > 512 || !navigation.nodeIds.every(isIdentity)) return null
    if (navigation.deletedNodeIds !== undefined && (!Array.isArray(navigation.deletedNodeIds)
      || navigation.deletedNodeIds.length > 512 || !navigation.deletedNodeIds.every(isIdentity))) return null
    if (navigation.revision !== undefined && (typeof navigation.revision !== 'number'
      || !Number.isSafeInteger(navigation.revision) || navigation.revision < 0)) return null
    if (navigation.ownerSessionId !== undefined && !isIdentity(navigation.ownerSessionId)) return null
    if (navigation.action !== undefined && !['create', 'update', 'delete', 'batch', 'orchestration'].includes(String(navigation.action))) return null
    if (navigation.operationId !== undefined && !isIdentity(navigation.operationId)) return null
    if (navigation.sourceToolCallId !== undefined && !isIdentity(navigation.sourceToolCallId)) return null
    return {
      status: 'changed', projectId: navigation.projectId, canvasId: navigation.canvasId,
      nodeIds: [...new Set(navigation.nodeIds)],
      ...(navigation.ownerSessionId ? { ownerSessionId: navigation.ownerSessionId as string } : {}),
      ...(navigation.action ? { action: navigation.action as CanvasToolNavigationResult['action'] } : {}),
      ...(navigation.deletedNodeIds ? { deletedNodeIds: [...new Set(navigation.deletedNodeIds as string[])] } : {}),
      ...(navigation.revision !== undefined ? { revision: navigation.revision as number } : {}),
      ...(navigation.operationId ? { operationId: navigation.operationId as string } : {}),
      ...(navigation.sourceToolCallId ? { sourceToolCallId: navigation.sourceToolCallId as string } : {}),
    }
  } catch { return null }
}

/** 当前运行身份，异步关联校验晚回时不能影响下一轮。 */
function readRunKey(store: Store, sessionId: string): string {
  const state = store.get(agentStreamingStatesAtom).get(sessionId)
  return JSON.stringify([state?.startedAt ?? null, state?.runGeneration ?? null])
}

/** 读取交互快照；显式定位允许点击外部关闭详情，仍保护选区、视口和草稿变化。 */
function readFocusSignature(store: Store, sessionId: string, includeWorkbench = true): string {
  return JSON.stringify([
    store.get(appModeAtom), store.get(currentAgentSessionIdAtom),
    store.get(agentSidePanelOpenAtomFamily(sessionId)), store.get(agentDiffPanelTabAtom).get(sessionId),
    store.get(agentSidePanelSplitMapAtom).get(sessionId),
    [...store.get(agentCanvasViewStatesAtom)].filter(([key]) => key.startsWith(`[${JSON.stringify(sessionId)},`))
      .map(([key, view]) => [key, view.viewport, view.selectedNodeId, includeWorkbench ? view.expandedNodeId : null, view.workbenchDraft?.dirty]),
  ])
}

/** 当前聊天任一展开详情有草稿时保留其编辑位置。 */
export function hasAgentCanvasDraft(store: Store, sessionId: string): boolean {
  return [...store.get(agentCanvasViewStatesAtom)].some(([key, view]) => (
    key.startsWith(`[${JSON.stringify(sessionId)},`) && view.workbenchDraft?.dirty
  ))
}

/** 在当前聊天打开具体画布，并在权威 LOAD 到达后按真实节点几何定位。 */
export function revealAgentCanvasChange(store: Store, notice: AgentCanvasChangeNotice, nodeIds = notice.nodeIds): boolean {
  if (store.get(currentAgentSessionIdAtom) !== notice.sessionId || store.get(appModeAtom) !== 'agent'
    || hasAgentCanvasDraft(store, notice.sessionId)) return false
  /** 分屏只替换当前 Pane；已有目标 Pane 则聚焦它，保留另一侧内容。 */
  const tab = getCanvasWorkspaceTab(notice.canvasId)
  store.set(agentCanvasWorkspaceStateMapAtom, previous => ({
    ...previous, [notice.sessionId]: rememberAgentCanvasWorkspaceTab(previous[notice.sessionId], tab, true),
  }))
  store.set(agentSidePanelSplitMapAtom, previous => {
    const split = previous.get(notice.sessionId)
    if (!split) return previous
    return new Map(previous).set(notice.sessionId, selectRightWorkspaceSplitTab(split, tab))
  })
  store.set(agentDiffPanelTabAtom, previous => new Map(previous).set(notice.sessionId, tab))
  store.set(agentSidePanelOpenAtomFamily(notice.sessionId), true)
  store.set(requestAgentCanvasFocusAtom, {
    key: createAgentCanvasViewKey(notice.sessionId, notice.projectId, notice.canvasId),
    nodeIds, revision: notice.revision,
  })
  return true
}

/** 工具结果后的关联校验可在测试中替换，生产沿用已有受管 IPC。 */
export interface CanvasChangeConsumerDependencies {
  listBindings: (projectId: string) => Promise<AgentCanvasBinding[]>
  /** 授权变化用于废弃读取中的旧关联快照，避免撤销关联后仍导航。 */
  onBindingChanged?: (listener: (event: AgentCanvasBindingChangeEvent) => void) => () => void
}

/** 生产环境复用已有四层 IPC，不新增协议或轮询。 */
const navigationDependencies: CanvasChangeConsumerDependencies = {
  listBindings: projectId => designAdapter.listAgentCanvasBindings({ projectId }),
  onBindingChanged: listener => window.electronAPI.onAgentCanvasBindingChanged(listener),
}

/** 显式“查看位置”也复验会话关联，避免已撤销授权的旧摘要打开画布。 */
export async function openAgentCanvasChange(
  store: Store, notice: AgentCanvasChangeNotice, nodeIds = notice.nodeIds,
  dependencies: CanvasChangeConsumerDependencies = navigationDependencies,
): Promise<boolean> {
  const focus = readFocusSignature(store, notice.sessionId, false)
  let invalidated = false
  const release = dependencies.onBindingChanged?.(event => {
    if (event.cause !== 'active-changed' && event.cause !== 'default-changed'
      && event.projectId === notice.projectId && event.sessionId === notice.sessionId) invalidated = true
  })
  try {
    const bindings = await dependencies.listBindings(notice.projectId)
    if (invalidated || focus !== readFocusSignature(store, notice.sessionId, false) || !bindings.some(binding => binding.projectId === notice.projectId && binding.sessionId === notice.sessionId
      && binding.linkedCanvasIds.includes(notice.canvasId))) return false
    if (!store.get(agentSessionsAtom).some(session => session.id === notice.sessionId && session.workspaceId === notice.projectId)) return false
    return revealAgentCanvasChange(store, notice, nodeIds)
  } finally { release?.() }
}

/**
 * 普通聊天的成功修改回执消费者；本轮只自动展示一次，其余变化合并为可点击摘要。
 * @param store Renderer 会话状态。
 * @param dependencies 权威关联读取，失败时不猜测目标或跳页。
 * @returns 事件处理与卸载入口。
 */
export function createAgentCanvasChangeConsumer(
  store: Store,
  dependencies: CanvasChangeConsumerDependencies = navigationDependencies,
): { beginRun: (sessionId: string) => void; handle: (sessionId: string, event: AgentEvent) => void; dispose: () => void } {
  /** 待处理身份跨聊天隔离，消费后立即删除，重复结果不二次导航。 */
  const pending = new Map<string, { toolName: string; runKey: string; focus: string }>()
  /** 每会话当前轮次的首个回执占用自动展示机会，后续仅更新摘要。 */
  const revealedRuns = new Map<string, string>()
  /** 记录运行起点的用户视图，模型思考期间的主动切页也应受到保护。 */
  const runFocus = new Map<string, { runKey: string; focus: string; interrupted: boolean }>()
  /** 已确认操作身份有界去重，重放同一业务操作不再次计数。 */
  const processed = new Set<string>()
  /** 仅授权变化增加代次，进度、正文变化不触发此保护。 */
  const bindingGenerations = new Map<string, number>()
  const releaseBinding = dependencies.onBindingChanged?.(event => {
    if (event.cause === 'active-changed' || event.cause === 'default-changed') return
    const key = JSON.stringify([event.projectId, event.sessionId])
    bindingGenerations.set(key, (bindingGenerations.get(key) ?? 0) + 1)
    if (bindingGenerations.size > 256) bindingGenerations.delete(bindingGenerations.keys().next().value!)
    const previous = store.get(agentCanvasChangeNoticesAtom)
    const next = new Map(previous)
    for (const [viewKey, notice] of previous) {
      if (notice.projectId === event.projectId && notice.sessionId === event.sessionId
        && !event.binding?.linkedCanvasIds.includes(notice.canvasId)) {
        next.delete(viewKey)
        store.set(clearAgentCanvasFocusAtom, viewKey)
      }
    }
    if (next.size !== previous.size) store.set(agentCanvasChangeNoticesAtom, next)
  })
  /** 低频布局事件保护“切走再切回”以及 LOAD 尚未完成的导航，不监听每帧视口。 */
  const onFocusChanged = (): void => {
    for (const [sessionId, focus] of runFocus) {
      if (focus.focus !== readFocusSignature(store, sessionId)) focus.interrupted = true
    }
    for (const key of store.get(agentCanvasFocusRequestsAtom).keys()) {
      const [sessionId, , canvasId] = JSON.parse(key) as [string, string, string]
      const split = store.get(agentSidePanelSplitMapAtom).get(sessionId)
      const tab = split ? getFocusedRightWorkspaceTab(split) : store.get(agentDiffPanelTabAtom).get(sessionId)
      if (store.get(currentAgentSessionIdAtom) !== sessionId || store.get(appModeAtom) !== 'agent'
        || !store.get(agentSidePanelOpenAtomFamily(sessionId)) || tab !== getCanvasWorkspaceTab(canvasId)) {
        store.set(clearAgentCanvasFocusAtom, key)
      }
    }
  }
  const releaseFocusSubscriptions = [
    store.sub(currentAgentSessionIdAtom, onFocusChanged), store.sub(appModeAtom, onFocusChanged),
    store.sub(agentDiffPanelTabAtom, onFocusChanged), store.sub(agentSidePanelSplitMapAtom, onFocusChanged),
    store.sub(agentSidePanelOpenMapAtom, onFocusChanged),
  ]
  let disposed = false
  return {
    beginRun(sessionId) {
      const runKey = readRunKey(store, sessionId)
      if (runFocus.get(sessionId)?.runKey === runKey) return
      runFocus.set(sessionId, { runKey, focus: readFocusSignature(store, sessionId), interrupted: false })
      if (runFocus.size > 128) runFocus.delete(runFocus.keys().next().value!)
      const interrupted = new Set(store.get(agentCanvasNavigationInterruptedSessionsAtom))
      interrupted.delete(sessionId)
      store.set(agentCanvasNavigationInterruptedSessionsAtom, interrupted)
    },
    handle(sessionId, event) {
      if (disposed) return
      if (event.type === 'complete' || event.type === 'error') {
        for (const key of pending.keys()) if (key.startsWith(`[${JSON.stringify(sessionId)},`)) pending.delete(key)
        return
      }
      if (event.type !== 'tool_start' && event.type !== 'tool_result') return
      const key = JSON.stringify([sessionId, event.toolUseId])
      if (event.type === 'tool_start') {
        if (CHANGE_TOOLS.has(event.toolName)) pending.set(key, {
          toolName: event.toolName, runKey: readRunKey(store, sessionId),
          focus: runFocus.get(sessionId)?.runKey === readRunKey(store, sessionId)
            ? runFocus.get(sessionId)!.focus : readFocusSignature(store, sessionId),
        })
        return
      }
      const start = pending.get(key)
      pending.delete(key)
      if (!start || event.isError || start.runKey !== readRunKey(store, sessionId)) return
      /** 保留真实执行会话，委托结果不能伪装成普通聊天工具或改写审计来源。 */
      const sourceSessionId = sessionId
      const sourceOwner = store.get(canvasAgentOwnersAtom).get(sourceSessionId)
      const parsed = parseCanvasChangeNavigation(event.result)
      const delegated = sourceOwner !== undefined
      if (delegated) {
        if (!parsed?.ownerSessionId || sourceOwner.projectId !== parsed.projectId || sourceOwner.canvasId !== parsed.canvasId) return
        sessionId = parsed.ownerSessionId
      } else if (parsed?.ownerSessionId && parsed.ownerSessionId !== sessionId) return
      const session = store.get(agentSessionsAtom).find(item => item.id === sessionId)
      if (!session?.workspaceId) return
      /** 旧主进程仅对普通聊天的两类创建结果提供兼容；委托必须带 Host 签发的归属。 */
      const legacy = !delegated && (start.toolName === 'canvas_create_artifact' || start.toolName === 'canvas_import_image')
        ? parseCanvasArtifactToolResult(event.result) : null
      const navigation = parsed ?? (legacy ? {
        status: 'changed' as const, projectId: session.workspaceId, canvasId: legacy.canvasId,
        nodeIds: [legacy.nodeId], revision: legacy.revision,
      } : null)
      if (!navigation || navigation.projectId !== session.workspaceId
        || (navigation.sourceToolCallId && navigation.sourceToolCallId !== event.toolUseId)) return
      const noticeRunKey = delegated ? readRunKey(store, sessionId) : start.runKey
      const bindingKey = JSON.stringify([navigation.projectId, sessionId])
      const generation = bindingGenerations.get(bindingKey) ?? 0
      void dependencies.listBindings(navigation.projectId).then(bindings => {
        if (disposed || generation !== (bindingGenerations.get(bindingKey) ?? 0) || start.runKey !== readRunKey(store, sourceSessionId)
          || (delegated && store.get(canvasAgentOwnersAtom).get(sourceSessionId) !== sourceOwner)
          || !store.get(agentSessionsAtom).some(item => item.id === sessionId && item.workspaceId === navigation.projectId)
          || !bindings.some(binding => binding.projectId === navigation.projectId && binding.sessionId === sessionId
            && binding.linkedCanvasIds.includes(navigation.canvasId))) return
        const receiptKey = JSON.stringify([sourceSessionId, start.runKey, navigation.canvasId, navigation.operationId ?? event.toolUseId])
        if (processed.has(receiptKey)) return
        processed.add(receiptKey)
        if (processed.size > 512) processed.delete(processed.values().next().value!)
        const viewKey = createAgentCanvasViewKey(sessionId, navigation.projectId, navigation.canvasId)
        const previous = store.get(agentCanvasChangeNoticesAtom)
        const old = previous.get(viewKey)
        const sameRun = old?.runKey === noticeRunKey
        /** 迟到的旧图回执不能让已删除节点在摘要中复活。 */
        if (navigation.revision !== undefined && old?.revision !== undefined && navigation.revision < old.revision) return
        const deleted = new Set([...(sameRun ? old.deletedNodeIds ?? [] : []), ...navigation.deletedNodeIds ?? []])
        for (const nodeId of navigation.nodeIds) deleted.delete(nodeId)
        const nodeIds = [...new Set([...(sameRun ? old.nodeIds : []), ...navigation.nodeIds])].filter(nodeId => !deleted.has(nodeId)).slice(-512)
        const notice: AgentCanvasChangeNotice = {
          ...navigation, sessionId, runKey: noticeRunKey, nodeIds, deletedNodeIds: [...deleted].slice(-512),
          revision: Math.max(navigation.revision ?? 0, sameRun ? old.revision ?? 0 : 0),
          changes: (sameRun ? old.changes : 0) + 1,
        }
        const next = new Map(previous)
        next.delete(viewKey)
        next.set(viewKey, notice)
        while (next.size > 64) next.delete(next.keys().next().value!)
        store.set(agentCanvasChangeNoticesAtom, next)
        if (delegated) return
        if (revealedRuns.get(sessionId) === start.runKey) return
        revealedRuns.set(sessionId, start.runKey)
        if (revealedRuns.size > 128) revealedRuns.delete(revealedRuns.keys().next().value!)
        if (!runFocus.get(sessionId)?.interrupted && !store.get(agentCanvasNavigationInterruptedSessionsAtom).has(sessionId)
          && start.focus === readFocusSignature(store, sessionId)) revealAgentCanvasChange(store, notice)
      }).catch(() => console.error('[Agent Canvas] 修改位置关联校验失败'))
    },
    dispose() { disposed = true; pending.clear(); revealedRuns.clear(); runFocus.clear(); processed.clear(); releaseBinding?.(); bindingGenerations.clear(); releaseFocusSubscriptions.forEach(release => release()) },
  }
}
