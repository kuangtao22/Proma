import type { CanvasDocument, CanvasMutation, CanvasTarget } from '@proma/shared'
import type { NativeCanvasNodeSize } from './native-canvas-model'

/** 整理命令每次启动时固定的布局输入。 */
export interface NativeCanvasArrangeCommandInput {
  scopeNodeIds: readonly string[]
  blockedNodeIds: ReadonlySet<string>
  nodeSizesById: ReadonlyMap<string, NativeCanvasNodeSize>
}

/** Workspace 在异步边界两侧提供的当前权威上下文。 */
export interface NativeCanvasArrangeCommandContext {
  workspaceKey: string
  document: CanvasDocument
  /** 实际项目/快照权限，不包含本命令持有的结构锁。 */
  permissionWritable: boolean
  blockedNodeIds: ReadonlySet<string>
}

/** 整理计算器只接收固定输入和用于中止底层 Worker 的信号。 */
export type NativeCanvasArrangeCalculator = (
  input: NativeCanvasArrangeCommandInput & { document: CanvasDocument },
  signal: AbortSignal,
) => Promise<Extract<CanvasMutation, { type: 'move-nodes' }>>

/** 异步整理命令的可注入依赖。 */
export interface NativeCanvasArrangeCommandDependencies {
  target: CanvasTarget
  createOperationId: () => string
  getCurrentContext: () => NativeCanvasArrangeCommandContext | null
  beginOperation: (operationId: string) => boolean
  endOperation: (operationId: string) => void
  calculate: NativeCanvasArrangeCalculator
  save: (input: CanvasTarget & {
    expectedRevision: number
    mutations: Extract<CanvasMutation, { type: 'move-nodes' }>[]
  }) => Promise<CanvasDocument>
  onSuccess: (document: CanvasDocument) => void
  onFailure: (error: unknown) => void
}

/** 命令结果用于让 React 层更新提示，不携带底层异常或路径。 */
export type NativeCanvasArrangeCommandResult =
  | 'committed'
  | 'noop'
  | 'stale'
  | 'busy'
  | 'failed'
  | 'aborted'
  | 'unavailable'

/** 异步整理命令公开生命周期。 */
export interface NativeCanvasArrangeCommand {
  execute: (input: NativeCanvasArrangeCommandInput) => Promise<NativeCanvasArrangeCommandResult>
  cancel: () => void
  dispose: () => void
}

/** 将布局边界错误转换为用户可执行的重试建议。 */
export function getNativeCanvasArrangeErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) return '整理布局失败，原位置已保留。'
  if (error.message === 'CANVAS_LAYOUT_TOO_LARGE') return '节点过多，请选择部分节点分批整理。'
  if (error.name === 'TimeoutError') return '智能整理超过 8 秒，请缩小选区后重试。'
  return '整理布局失败，原位置已保留。'
}

/** 判断布局结果涉及的节点是否在计算期间进入运行或待审批状态。 */
function hasBlockedPosition(
  mutation: Extract<CanvasMutation, { type: 'move-nodes' }>,
  blockedNodeIds: ReadonlySet<string>,
): boolean {
  return mutation.positions.some((entry) => blockedNodeIds.has(entry.nodeId))
}

/** 复核异步边界后的 Workspace 是否仍允许提交同一代文档。 */
function canCommitArrangeResult(
  initial: NativeCanvasArrangeCommandContext,
  current: NativeCanvasArrangeCommandContext | null,
  mutation: Extract<CanvasMutation, { type: 'move-nodes' }>,
): boolean {
  return Boolean(current
    && current.workspaceKey === initial.workspaceKey
    && current.document === initial.document
    && current.document.revision === initial.document.revision
    && current.permissionWritable
    && !hasBlockedPosition(mutation, current.blockedNodeIds))
}

/**
 * 创建单实例异步整理命令，结构锁覆盖计算、复核与保存全过程。
 * @param dependencies 当前 Workspace 的权限、结构锁、Worker 计算与保存边界。
 * @returns 可重复调用并可在卸载时中止的整理命令。
 */
export function createNativeCanvasArrangeCommand(
  dependencies: NativeCanvasArrangeCommandDependencies,
): NativeCanvasArrangeCommand {
  /** 活跃控制器同时作为重复启动门禁和底层 Worker 中止信号。 */
  let activeController: AbortController | null = null
  /** dispose 后该实例永久失效，避免旧 Workspace 再提交。 */
  let disposed = false

  return {
    async execute(input) {
      if (disposed) return 'aborted'
      if (activeController) return 'busy'
      const initial = dependencies.getCurrentContext()
      if (!initial || !initial.permissionWritable) return 'unavailable'
      const operationId = dependencies.createOperationId()
      if (!dependencies.beginOperation(operationId)) return 'busy'
      const controller = new AbortController()
      activeController = controller
      try {
        const mutation = await dependencies.calculate({
          document: initial.document,
          scopeNodeIds: input.scopeNodeIds,
          blockedNodeIds: input.blockedNodeIds,
          nodeSizesById: input.nodeSizesById,
        }, controller.signal)
        if (controller.signal.aborted || disposed) return 'aborted'
        const current = dependencies.getCurrentContext()
        /** 文档对象身份覆盖同 revision 重新 LOAD；权限判断明确排除自身结构锁。 */
        if (!canCommitArrangeResult(initial, current, mutation)) return 'stale'
        if (mutation.positions.length === 0) return 'noop'
        const saved = await dependencies.save({
          ...dependencies.target,
          expectedRevision: initial.document.revision,
          mutations: [mutation],
        })
        if (controller.signal.aborted || disposed) return 'aborted'
        const settledContext = dependencies.getCurrentContext()
        /** 保存已成功时不因正常 graph 通知误报 stale，但只允许初始文档代次接管 Renderer。 */
        if (!settledContext || settledContext.workspaceKey !== initial.workspaceKey) return 'stale'
        if (canCommitArrangeResult(initial, settledContext, mutation)) dependencies.onSuccess(saved)
        return 'committed'
      } catch (error) {
        if (controller.signal.aborted || disposed) return 'aborted'
        dependencies.onFailure(error)
        return 'failed'
      } finally {
        if (activeController === controller) activeController = null
        dependencies.endOperation(operationId)
      }
    },
    cancel() {
      activeController?.abort()
    },
    dispose() {
      disposed = true
      activeController?.abort()
    },
  }
}
