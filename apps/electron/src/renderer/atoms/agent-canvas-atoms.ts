import type { AgentCanvasBinding, CanvasChangeEvent, CanvasDocument } from '@proma/shared'
import { atom } from 'jotai'

/** 独立 Canvas 入口在迁入普通 Agent 前使用的稳定宿主会话前缀。 */
export const LEGACY_AGENT_CANVAS_HOST_SESSION_PREFIX = 'legacy-native-canvas-host'

/** 为旧独立 Canvas 入口创建不会被普通 Agent 复用的宿主会话键。 */
export function createLegacyAgentCanvasHostSessionId(projectId: string): string {
  return JSON.stringify([LEGACY_AGENT_CANVAS_HOST_SESSION_PREFIX, projectId])
}

/** 单个节点工作台尚未提交的轻量草稿状态。 */
export interface AgentCanvasWorkbenchDraftState {
  /** 草稿所属节点 ID。 */
  nodeId: string
  /** 当前工作台是否存在未保存修改。 */
  dirty: boolean
}

/** Agent Canvas 工作台的会话级宽高。 */
export interface AgentCanvasWorkbenchSize {
  /** 工作台宽度，单位为画布布局像素。 */
  width: number
  /** 工作台高度，单位为画布布局像素。 */
  height: number
}

/** 单个 Agent 会话查看一张共享画布时的独立视图状态。 */
export interface AgentCanvasViewState {
  /** 当前会话自己的画布视口，不写回共享文档。 */
  viewport: CanvasDocument['viewport']
  /** 当前主选中节点，供详情和单节点命令使用。 */
  selectedNodeId: string | null
  /** 当前完整节点选区，供框选、批量拖动和删除使用。 */
  selectedNodeIds: string[]
  /** 当前唯一展开的节点工作台。 */
  expandedNodeId: string | null
  /** 当前工作台的用户调整尺寸。 */
  workbenchSize: AgentCanvasWorkbenchSize | null
  /** Agent 右侧画布区域是否处于展开态。 */
  isExpanded: boolean
  /** 会话级活动变化代次，供宿主按需刷新视图提示。 */
  activityRevision: number
  /** 当前宿主最后确认已读的活动代次。 */
  seenActivityRevision: number
  /** 当前鼠标在画布上的主交互工具。 */
  activeTool: 'select' | 'pan'
  /** dirty 草稿确认后准备切换的目标节点。 */
  pendingWorkbenchSwitchNodeId: string | null
  /** 工作台草稿只记录身份和 dirty，不复制正文或 Agent 运行态。 */
  workbenchDraft: AgentCanvasWorkbenchDraftState | null
}

/**
 * 创建单个 Agent Canvas 会话视图的初始状态。
 * @param viewport 首次从共享 CanvasDocument 读取的视口。
 * @returns 拥有独立选区数组的会话视图状态。
 */
export function createInitialAgentCanvasViewState(
  viewport: CanvasDocument['viewport'],
): AgentCanvasViewState {
  return {
    viewport: { ...viewport },
    selectedNodeId: null,
    selectedNodeIds: [],
    expandedNodeId: null,
    workbenchSize: null,
    isExpanded: false,
    activityRevision: 0,
    seenActivityRevision: 0,
    activeTool: 'select',
    pendingWorkbenchSwitchNodeId: null,
    workbenchDraft: null,
  }
}

/**
 * 创建 Agent 会话、项目与 Canvas 的完整视图键。
 * @param sessionId 普通 Agent 会话或显式 legacy 宿主会话 ID。
 * @param projectId Canvas 所属项目 ID。
 * @param canvasId 共享 Canvas ID。
 * @returns 无分隔符碰撞的结构化视图键。
 */
export function createAgentCanvasViewKey(
  sessionId: string,
  projectId: string,
  canvasId: string,
): string {
  return JSON.stringify([sessionId, projectId, canvasId])
}

/** 未依赖 Canvas LOAD 的普通 Agent 画布活动状态。 */
export interface AgentCanvasActivityState {
  activityRevision: number
  seenActivityRevision: number
}

/** 所有普通 Agent 的后台 Canvas activity 按完整 view key 持久驻留于 Renderer。 */
export const agentCanvasActivityStatesAtom = atom<Map<string, AgentCanvasActivityState>>(new Map())

/** 单次权威 Canvas 事件与完整 bindings 快照。 */
export interface RecordAgentCanvasActivityInput {
  event: CanvasChangeEvent
  bindings: readonly AgentCanvasBinding[]
}

/** 基于完整 binding 列表增量所有关联 Agent，不读取共享 Canvas 图。 */
export const recordAgentCanvasActivityAtom = atom(
  null,
  (get, set, input: RecordAgentCanvasActivityInput): void => {
    const previous = get(agentCanvasActivityStatesAtom)
    const next = new Map(previous)
    for (const binding of input.bindings) {
      if (binding.projectId !== input.event.projectId
        || !binding.linkedCanvasIds.includes(input.event.canvasId)) continue
      const key = createAgentCanvasViewKey(binding.sessionId, binding.projectId, input.event.canvasId)
      const current = next.get(key) ?? { activityRevision: 0, seenActivityRevision: 0 }
      next.set(key, { ...current, activityRevision: current.activityRevision + 1 })
    }
    set(agentCanvasActivityStatesAtom, next)
  },
)

/** 单个 binding 变化后清除该 Agent 已不再关联的后台 activity。 */
export const reconcileAgentCanvasActivityBindingAtom = atom(
  null,
  (get, set, binding: AgentCanvasBinding | null, projectId: string, sessionId: string): void => {
    const linkedCanvasIds = new Set(binding?.linkedCanvasIds ?? [])
    const previous = get(agentCanvasActivityStatesAtom)
    const next = new Map(previous)
    let changed = false
    for (const key of previous.keys()) {
      let identity: unknown
      try {
        identity = JSON.parse(key) as unknown
      } catch {
        continue
      }
      if (!Array.isArray(identity) || identity.length !== 3
        || identity[0] !== sessionId || identity[1] !== projectId
        || typeof identity[2] !== 'string' || linkedCanvasIds.has(identity[2])) continue
      next.delete(key)
      changed = true
    }
    if (changed) set(agentCanvasActivityStatesAtom, next)
  },
)

/** 将目标 view 当前活动代次标记为已读。 */
export const markAgentCanvasActivitySeenAtom = atom(
  null,
  (get, set, key: string): void => {
    const previous = get(agentCanvasActivityStatesAtom)
    const current = previous.get(key)
    if (!current || current.seenActivityRevision === current.activityRevision) return
    const next = new Map(previous)
    next.set(key, { ...current, seenActivityRevision: current.activityRevision })
    set(agentCanvasActivityStatesAtom, next)
  },
)

/**
 * 请求打开目标节点工作台，dirty 时只登记待确认目标。
 * @param current 当前会话视图状态。
 * @param nodeId 用户或通知请求打开的目标节点。
 * @returns 不接触共享图快照和 mutation 的视图更新。
 */
export function createAgentCanvasWorkbenchChangeUpdate(
  current: AgentCanvasViewState,
  nodeId: string,
): Partial<AgentCanvasViewState> {
  if (current.expandedNodeId === nodeId) return { pendingWorkbenchSwitchNodeId: null }
  if (current.expandedNodeId
    && current.workbenchDraft?.nodeId === current.expandedNodeId
    && current.workbenchDraft.dirty) {
    return { pendingWorkbenchSwitchNodeId: nodeId }
  }
  return {
    expandedNodeId: nodeId,
    pendingWorkbenchSwitchNodeId: null,
    workbenchDraft: null,
  }
}

/**
 * 根据最新共享文档收敛会话选区与工作台。
 * @param current 当前会话视图状态。
 * @param document 最新共享 Canvas 文档。
 * @returns 仅移除已不存在节点引用的视图更新。
 */
export function createConvergedAgentCanvasViewUpdate(
  current: AgentCanvasViewState,
  document: CanvasDocument,
): Partial<AgentCanvasViewState> {
  /** 节点集合只在共享文档变化时创建一次，收敛过程保持 O(n)。 */
  const nodeIds = new Set(document.nodes.map((node) => node.id))
  const selectedNodeIds = current.selectedNodeIds.filter((nodeId) => nodeIds.has(nodeId))
  const selectedNodeId = current.selectedNodeId && nodeIds.has(current.selectedNodeId)
    ? current.selectedNodeId
    : selectedNodeIds[0] ?? null
  const expandedNodeStillExists = current.expandedNodeId === null || nodeIds.has(current.expandedNodeId)
  return {
    selectedNodeId,
    selectedNodeIds,
    ...(!expandedNodeStillExists ? {
      expandedNodeId: null,
      pendingWorkbenchSwitchNodeId: null,
      workbenchDraft: null,
      workbenchSize: null,
    } : {}),
  }
}

/** 清理当前会话视图的工作台临时态，保留视口、工具和普通选区。 */
export function createClosedAgentCanvasWorkbenchUpdate(): Partial<AgentCanvasViewState> {
  return {
    expandedNodeId: null,
    pendingWorkbenchSwitchNodeId: null,
    workbenchDraft: null,
    workbenchSize: null,
  }
}

/** 所有 Agent Canvas 会话视图按完整三元身份隔离的状态。 */
export const agentCanvasViewStatesAtom = atom<Map<string, AgentCanvasViewState>>(new Map())

/** 权威文档尚未 LOAD 时暂存的最新节点导航意图。 */
const pendingAgentCanvasViewNavigationAtom = atom<Map<string, string>>(new Map())

/** 单个 Agent Canvas 视图初始化输入。 */
export interface InitializeAgentCanvasViewStateInput {
  /** 完整 Agent Canvas 视图键。 */
  key: string
  /** 仅首次初始化时采用的 CanvasDocument 视口。 */
  viewport: CanvasDocument['viewport']
}

/** 已存在的会话视图保持原值，只有首次挂载才从共享文档初始化。 */
export const initializeAgentCanvasViewStateAtom = atom(
  null,
  (get, set, input: InitializeAgentCanvasViewStateInput): void => {
    /** 同一 view key 重载共享图时不得覆盖用户视口与选区。 */
    const states = get(agentCanvasViewStatesAtom)
    if (states.has(input.key)) return
    const pendingNavigations = get(pendingAgentCanvasViewNavigationAtom)
    const pendingNodeId = pendingNavigations.get(input.key)
    const initial = createInitialAgentCanvasViewState(input.viewport)
    const nextStates = new Map(states)
    nextStates.set(input.key, pendingNodeId
      ? {
          ...initial,
          selectedNodeId: pendingNodeId,
          selectedNodeIds: [pendingNodeId],
          ...createAgentCanvasWorkbenchChangeUpdate(initial, pendingNodeId),
        }
      : initial)
    set(agentCanvasViewStatesAtom, nextStates)
    if (!pendingNodeId) return
    /** 导航意图只消费一次，后续文档刷新不得再次抢占用户视图。 */
    const nextPendingNavigations = new Map(pendingNavigations)
    nextPendingNavigations.delete(input.key)
    set(pendingAgentCanvasViewNavigationAtom, nextPendingNavigations)
  },
)

/** Agent Canvas 视图支持局部对象或基于当前值的函数更新。 */
export type AgentCanvasViewStateUpdate = Partial<AgentCanvasViewState>
  | ((current: AgentCanvasViewState) => Partial<AgentCanvasViewState>)

/** 单个 Agent Canvas 视图更新输入。 */
export interface UpdateAgentCanvasViewStateInput {
  /** 完整 Agent Canvas 视图键。 */
  key: string
  /** 会话视图的局部更新。 */
  update: AgentCanvasViewStateUpdate
}

/** 只复制 Map 与目标会话视图的原子更新入口。 */
export const updateAgentCanvasViewStateAtom = atom(
  null,
  (get, set, input: UpdateAgentCanvasViewStateInput): void => {
    /** 更新入口要求视图已经用 CanvasDocument 视口显式初始化。 */
    const states = get(agentCanvasViewStatesAtom)
    const current = states.get(input.key)
    if (!current) return
    const update = typeof input.update === 'function' ? input.update(current) : input.update
    const nextStates = new Map(states)
    nextStates.set(input.key, { ...current, ...update })
    set(agentCanvasViewStatesAtom, nextStates)
  },
)

/** Agent Canvas 节点导航输入。 */
export interface NavigateAgentCanvasViewInput {
  /** 完整 Agent Canvas 视图键。 */
  key: string
  /** 需要选中并打开工作台的节点 ID。 */
  nodeId: string
}

/**
 * 导航到 Agent Canvas 节点；权威文档未 LOAD 时只暂存意图。
 * @param input 目标 view key 与节点 ID。
 * @returns 无返回值；已有 view 立即更新，缺失 view 等待首次权威初始化。
 */
export const navigateAgentCanvasViewAtom = atom(
  null,
  (get, set, input: NavigateAgentCanvasViewInput): void => {
    const states = get(agentCanvasViewStatesAtom)
    const current = states.get(input.key)
    if (!current) {
      /** 同一 view key 的最新通知覆盖旧意图，避免 LOAD 后连续跳转。 */
      const nextPendingNavigations = new Map(get(pendingAgentCanvasViewNavigationAtom))
      nextPendingNavigations.set(input.key, input.nodeId)
      set(pendingAgentCanvasViewNavigationAtom, nextPendingNavigations)
      return
    }
    const nextStates = new Map(states)
    nextStates.set(input.key, {
      ...current,
      selectedNodeId: input.nodeId,
      selectedNodeIds: [input.nodeId],
      ...createAgentCanvasWorkbenchChangeUpdate(current, input.nodeId),
    })
    set(agentCanvasViewStatesAtom, nextStates)
  },
)

/** 删除单个已失效 Agent Canvas 会话视图的原子入口。 */
export const removeAgentCanvasViewStateAtom = atom(
  null,
  (get, set, key: string): void => {
    /** 两张 Map 分别判断，LOAD 前真实卸载也必须清除待导航意图。 */
    const states = get(agentCanvasViewStatesAtom)
    if (states.has(key)) {
      const nextStates = new Map(states)
      nextStates.delete(key)
      set(agentCanvasViewStatesAtom, nextStates)
    }
    const pendingNavigations = get(pendingAgentCanvasViewNavigationAtom)
    if (!pendingNavigations.has(key)) return
    const nextPendingNavigations = new Map(pendingNavigations)
    nextPendingNavigations.delete(key)
    set(pendingAgentCanvasViewNavigationAtom, nextPendingNavigations)
  },
)
