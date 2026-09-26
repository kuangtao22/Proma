import { APP_NAME } from '@proma/shared'

/** Electron 运行实例的系统身份。 */
export interface AppIdentity {
  /** Dock、任务栏和系统菜单显示名称。 */
  displayName: string
  /** 系统用于区分应用的稳定标识。 */
  appId: string
  /**
   * 历史加密身份：Electron 用它解析 macOS Safe Storage 的密钥归属。
   * 品牌改名、显示名调整都不得影响该值，否则全部已保存凭据都无法解密。
   */
  safeStorageName?: string
  /** 开发实例使用的 Electron userData 目录名。 */
  userDataDirectoryName?: string
}

/**
 * 历史加密身份常量。
 * 全部已发布版本都用它加密渠道、机器人、运维等凭据，因此永久保持 `@proma/electron`。
 */
export const LEGACY_SAFE_STORAGE_NAME = '@proma/electron'

/**
 * 解析正式版或开发版应用身份。
 * @param isPackaged 当前是否为正式打包环境。
 * @param rawInstance 可选的开发工作树实例名。
 * @returns 当前运行实例应使用的名称、App ID 和 userData 目录。
 */
export function resolveAppIdentity(isPackaged: boolean, rawInstance?: string): AppIdentity {
  // 展示名统一取 APP_NAME（当前为 DutyDeck）；appId 保持 com.bone.proma.app 不变，
  // 改它会让 macOS 视为另一个应用，导致 userData、TCC 授权与自动更新链全部断裂。
  if (isPackaged) {
    return {
      displayName: APP_NAME,
      appId: 'com.bone.proma.app',
      safeStorageName: LEGACY_SAFE_STORAGE_NAME,
    }
  }
  /** 去除会污染进程名称或目录名的开发实例字符。 */
  const instance = rawInstance?.replace(/[^a-zA-Z0-9_-]/g, '') || undefined
  return {
    displayName: instance ? `${APP_NAME} Dev - ${instance}` : `${APP_NAME} Dev`,
    appId: 'com.bone.proma.dev',
    safeStorageName: LEGACY_SAFE_STORAGE_NAME,
    userDataDirectoryName: instance ? `@proma/electron-dev-${instance}` : '@proma/electron-dev',
  }
}
