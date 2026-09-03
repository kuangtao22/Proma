import type { AgentCanvasBinding, CanvasSessionMeta } from '@proma/shared'
import {
  placeRightWorkspaceSplitTab,
  selectRightWorkspaceSplitTab,
} from '@/lib/right-workspace-split'
import type { RightWorkspacePane, RightWorkspaceSplitState } from '@/lib/right-workspace-split'
import { getCanvasWorkspaceTab } from '@/atoms/agent-atoms'
import type { AgentSidePanelTab } from '@/atoms/agent-atoms'

/** Canvas 宿主动作的固定错误反馈合同。 */
export interface CanvasWorkspaceActionOptions<T> {
  /** 真实 IPC 或 registry 动作。 */
  action: () => Promise<T>
  /** 面向用户的固定中文错误，不拼接底层异常。 */
  failureMessage: string
  /** 仅工程日志使用的动作上下文。 */
  logContext: string
  /** 展示固定用户错误。 */
  onErrorMessage: (message: string) => void
  /** 记录底层异常，禁止直接进入用户界面。 */
  onLogError: (context: string, error: unknown) => void
}

/**
 * 执行 Canvas 宿主异步动作并在边界内收口 rejection。
 * @returns 成功结果；失败返回 null，调用方据此决定是否更新本地状态。
 */
export async function runCanvasWorkspaceAction<T>({
  action,
  failureMessage,
  logContext,
  onErrorMessage,
  onLogError,
}: CanvasWorkspaceActionOptions<T>): Promise<T | null> {
  try {
    return await action()
  } catch (error) {
    onLogError(logContext, error)
    onErrorMessage(failureMessage)
    return null
  }
}

export interface SetAgentDefaultCanvasInput {
  /** 当前 Agent 的权威 Canvas 关联；null 表示尚未建立关联。 */
  binding: AgentCanvasBinding | null
  /** 用户选择的新默认画布。 */
  canvasId: string
  /** 为未关联画布建立关联并可同时设为默认。 */
  link: (canvasId: string, makeDefault: boolean) => Promise<unknown>
  /** 更新已关联画布的默认标记。 */
  setDefault: (canvasId: string) => Promise<unknown>
}

/** 未关联画布先建立默认关联，已关联画布复用轻量默认更新。 */
export async function setAgentDefaultCanvas(input: SetAgentDefaultCanvasInput): Promise<void> {
  if (!input.binding?.linkedCanvasIds.includes(input.canvasId)) {
    await input.link(input.canvasId, true)
    return
  }
  await input.setDefault(input.canvasId)
}

/**
 * 把 Canvas 导航落到发起动作的明确 Pane；无分屏时交给普通 activeTab 状态。
 * @returns 下一份分屏状态；null 表示当前没有分屏。
 */
export function selectCanvasWorkspaceTabForPane(
  split: RightWorkspaceSplitState | null,
  tab: AgentSidePanelTab,
  pane: RightWorkspacePane | null,
): RightWorkspaceSplitState | null {
  if (!split) return null
  return pane
    ? placeRightWorkspaceSplitTab(split, tab, pane)
    : selectRightWorkspaceSplitTab(split, tab)
}

export interface IsCanvasWorkspaceTabStillCurrentInput {
  /** 当前已提交的分屏状态；null 表示单 Pane。 */
  split: RightWorkspaceSplitState | null
  /** 单 Pane 模式下最新的活动标签。 */
  activeTab: AgentSidePanelTab
  /** 发起异步动作的 Pane；单 Pane 使用 null。 */
  pane: RightWorkspacePane | null
  /** 异步动作针对的画布 ID。 */
  canvasId: string
}

/** 复核异步动作返回时，发起 Pane 是否仍显示原画布。 */
export function isCanvasWorkspaceTabStillCurrent(
  input: IsCanvasWorkspaceTabStillCurrentInput,
): boolean {
  const canvasTab = getCanvasWorkspaceTab(input.canvasId)
  if (!input.split) return input.pane === null && input.activeTab === canvasTab
  if (!input.pane) return false
  return (input.pane === 'left' ? input.split.leftTab : input.split.rightTab) === canvasTab
}

/** 删除运行阻断使用可操作提示，其余异常始终折叠为固定通用错误。 */
export function getCanvasDeleteFailureMessage(error: unknown): string {
  return error instanceof Error && error.message.includes('任务运行')
    ? CANVAS_WORKSPACE_FAILURE_MESSAGES.deleteRunning
    : CANVAS_WORKSPACE_FAILURE_MESSAGES.delete
}

export interface CanvasDeleteActionOptions {
  action: () => Promise<void>
  onErrorMessage: (message: string) => void
  onLogError: (context: string, error: unknown) => void
}

/** 删除失败返回 false，让确认框保持打开并允许用户停止任务后重试。 */
export async function runCanvasDeleteAction({
  action,
  onErrorMessage,
  onLogError,
}: CanvasDeleteActionOptions): Promise<boolean> {
  try {
    await action()
    return true
  } catch (error) {
    onLogError('删除画布', error)
    onErrorMessage(getCanvasDeleteFailureMessage(error))
    return false
  }
}

export interface SelectCanvasAfterArchiveInput {
  /** 本次刚被归档的画布 ID。 */
  archivedCanvasId: string
  /** 当前 Agent 的默认画布 ID。 */
  defaultCanvasId?: string
  /** 当前 Agent 的画布关联顺序。 */
  linkedCanvasIds: readonly string[]
  /** 已包含本次归档结果的项目画布索引。 */
  sessions: readonly CanvasSessionMeta[]
}

/** 当前画布归档后选择下一张未归档且仍存在的关联画布。 */
export function selectCanvasAfterArchive(input: SelectCanvasAfterArchiveInput): CanvasSessionMeta | null {
  /** 只保留仍存在、未归档且不是当前项的候选画布。 */
  const available = new Map(input.sessions
    .filter((session) => !session.archived && session.id !== input.archivedCanvasId)
    .map((session) => [session.id, session]))
  if (input.defaultCanvasId) {
    const defaultCanvas = available.get(input.defaultCanvasId)
    if (defaultCanvas) return defaultCanvas
  }
  for (const canvasId of input.linkedCanvasIds) {
    const canvas = available.get(canvasId)
    if (canvas) return canvas
  }
  return null
}

export interface PendingCanvasDelete {
  hostSessionId: string
  projectId: string
  canvas: CanvasSessionMeta
  generation: number
}

export interface CanvasDeleteOperation {
  hostSessionId: string
  projectId: string
  canvasId: string
  hostGeneration: number
  generation: number
}

export interface CanvasDeleteLifecycle {
  switchHost: (sessionId: string, projectId: string | null) => void
  open: (sessionId: string, projectId: string, canvas: CanvasSessionMeta) => PendingCanvasDelete
  cancel: () => void
  begin: (pending: PendingCanvasDelete) => CanvasDeleteOperation | null
  getPending: () => PendingCanvasDelete | null
  isCurrent: (pending: PendingCanvasDelete) => boolean
  isOperationCurrent: (operation: CanvasDeleteOperation) => boolean
}

/** 把删除确认和已开始操作绑定到宿主身份与独立代次，阻断切换后的迟到 UI 回写。 */
export function createCanvasDeleteLifecycle(): CanvasDeleteLifecycle {
  let hostSessionId: string | null = null
  let projectId: string | null = null
  let generation = 0
  let operationGeneration = 0
  let pending: PendingCanvasDelete | null = null
  return {
    switchHost: (nextSessionId, nextProjectId) => {
      if (hostSessionId === nextSessionId && projectId === nextProjectId) return
      hostSessionId = nextSessionId
      projectId = nextProjectId
      generation += 1
      operationGeneration += 1
      pending = null
    },
    open: (nextSessionId, nextProjectId, canvas) => {
      if (hostSessionId !== nextSessionId || projectId !== nextProjectId) {
        hostSessionId = nextSessionId
        projectId = nextProjectId
        generation += 1
      }
      pending = { hostSessionId: nextSessionId, projectId: nextProjectId, canvas, generation }
      return pending
    },
    cancel: () => { pending = null },
    begin: (candidate) => {
      if (candidate !== pending || hostSessionId !== candidate.hostSessionId
        || projectId !== candidate.projectId || generation !== candidate.generation) return null
      operationGeneration += 1
      return {
        hostSessionId: candidate.hostSessionId,
        projectId: candidate.projectId,
        canvasId: candidate.canvas.id,
        hostGeneration: generation,
        generation: operationGeneration,
      }
    },
    getPending: () => pending,
    isCurrent: (candidate) => candidate === pending && hostSessionId === candidate.hostSessionId
      && projectId === candidate.projectId && generation === candidate.generation,
    isOperationCurrent: (operation) => hostSessionId === operation.hostSessionId
      && projectId === operation.projectId && generation === operation.hostGeneration
      && operationGeneration === operation.generation,
  }
}
/** Agent 右侧 Canvas 用户动作只允许展示这些固定中文失败文案。 */
export const CANVAS_WORKSPACE_FAILURE_MESSAGES = {
  open: '打开画布失败',
  create: '新建画布失败',
  rename: '重命名画布失败',
  setDefault: '设置默认画布失败',
  archive: '归档画布失败',
  restore: '恢复画布失败',
  delete: '删除画布失败',
  deleteRunning: '画布仍有任务运行，请先停止后再删除',
  close: '关闭画布标签失败',
} as const
