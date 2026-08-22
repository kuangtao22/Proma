/** Electron 运行实例的系统身份。 */
export interface AppIdentity {
  /** Dock、任务栏和系统菜单显示名称。 */
  displayName: string
  /** 系统用于区分应用的稳定标识。 */
  appId: string
  /** 开发实例在 ready 前使用的稳定 Safe Storage 名称。 */
  safeStorageName?: string
  /** 开发实例使用的 Electron userData 目录名。 */
  userDataDirectoryName?: string
}

/**
 * 解析正式版或开发版应用身份。
 * @param isPackaged 当前是否为正式打包环境。
 * @param rawInstance 可选的开发工作树实例名。
 * @returns 当前运行实例应使用的名称、App ID 和 userData 目录。
 */
export function resolveAppIdentity(isPackaged: boolean, rawInstance?: string): AppIdentity {
  if (isPackaged) return { displayName: 'Proma', appId: 'com.bone.proma.app' }
  /** 去除会污染进程名称或目录名的开发实例字符。 */
  const instance = rawInstance?.replace(/[^a-zA-Z0-9_-]/g, '') || undefined
  return {
    displayName: instance ? `Proma Dev - ${instance}` : 'Proma Dev',
    appId: 'com.bone.proma.dev',
    safeStorageName: '@proma/electron',
    userDataDirectoryName: instance ? `@proma/electron-dev-${instance}` : '@proma/electron-dev',
  }
}
