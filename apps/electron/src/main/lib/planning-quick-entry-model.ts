/** 用于 Windows Jump List 启动独立规划窗口的命令行参数。 */
export const OPEN_PLANNING_ARGUMENT = '--open-planning'

/** 判断启动参数是否要求直接打开规划窗口。 */
export function hasOpenPlanningArgument(argv: readonly string[]): boolean {
  return argv.includes(OPEN_PLANNING_ARGUMENT)
}

/**
 * 开发模式需把应用目录传给 Electron 可执行文件；打包版只需传功能参数。
 * @param defaultApp 当前是否由 Electron 开发壳启动。
 * @param appPath 当前应用目录。
 * @returns 可用于系统快捷入口的命令行参数。
 */
export function getPlanningTaskArguments(defaultApp: boolean, appPath: string): string {
  const appArgument = defaultApp ? `"${appPath}" ` : ''
  return `${appArgument}${OPEN_PLANNING_ARGUMENT}`
}
