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
