/** Electron 子 frame 导航判定所需的最小公开事实。 */
export interface SandboxedSrcdocNavigation {
  url: string
  isMainFrame: boolean
  frameUrl: string | null
  initiatorUrl: string | null
}

/** 判断 URL 是否属于受限 iframe 的初始离线文档。 */
function isSandboxedSrcdocUrl(url: string | null): boolean {
  return url === 'about:srcdoc'
}

/**
 * 阻止受限 srcdoc 通过脚本、meta refresh 或普通链接离开离线文档。
 * @param navigation Electron will-frame-navigate 提供的目标与来源 frame 身份。
 * @returns 仅在受限子 frame 尝试离开 about:srcdoc 时返回 true。
 */
export function shouldBlockSandboxedSrcdocNavigation(
  navigation: SandboxedSrcdocNavigation,
): boolean {
  if (navigation.isMainFrame || isSandboxedSrcdocUrl(navigation.url)) return false
  return isSandboxedSrcdocUrl(navigation.frameUrl)
    || isSandboxedSrcdocUrl(navigation.initiatorUrl)
}
