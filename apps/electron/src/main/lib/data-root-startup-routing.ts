import type { DataRootStartupMode } from '@proma/shared'

/** second-instance 启动门依赖的窗口动作。 */
export interface DataRootStartupRouterOptions {
  /** 判断命令行是否请求打开规划窗口。 */
  hasOpenPlanningArgument: (argv: string[]) => boolean
  /** 显示普通规划窗口。 */
  showPlanningWindow: () => void
  /** 显示普通主窗口。 */
  showMainWindow: () => void
  /** 创建或聚焦隔离的路径管理窗口。 */
  showPathManagementWindow: (mode: Exclude<DataRootStartupMode, 'normal'>) => void
}

/** 启动模式判定前后的 second-instance 路由器。 */
export interface DataRootStartupRouter {
  /** 设置最终启动模式，并处理门控期间最后一次 second-instance 请求。 */
  resolveMode: (mode: DataRootStartupMode) => void
  /** 根据已解析模式处理或暂存 second-instance 参数。 */
  handleSecondInstance: (argv: string[]) => void
}

/** 创建进程级启动路由器，阻止模式判定前或 non-normal 模式进入普通业务窗口。 */
export function createDataRootStartupRouter(
  options: DataRootStartupRouterOptions,
): DataRootStartupRouter {
  /** null 表示 bootstrap 尚未完成对应模式的安全初始化。 */
  let resolvedMode: DataRootStartupMode | null = null
  /** 门控期间只保留最后一次唤起，避免重复创建同类窗口。 */
  let pendingArgv: string[] | null = null

  /** 按最终模式执行唯一允许的窗口动作。 */
  const dispatch = (mode: DataRootStartupMode, argv: string[]): void => {
    if (mode !== 'normal') {
      options.showPathManagementWindow(mode)
      return
    }
    if (options.hasOpenPlanningArgument(argv)) {
      options.showPlanningWindow()
      return
    }
    options.showMainWindow()
  }

  return {
    resolveMode: (mode) => {
      resolvedMode = mode
      if (pendingArgv === null) return
      /** 清空后再执行，防止窗口动作同步重入时重复消费。 */
      const argv = pendingArgv
      pendingArgv = null
      dispatch(mode, argv)
    },
    handleSecondInstance: (argv) => {
      if (resolvedMode === null) {
        pendingArgv = [...argv]
        return
      }
      dispatch(resolvedMode, argv)
    },
  }
}
