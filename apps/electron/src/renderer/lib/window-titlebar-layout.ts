export const WINDOW_TITLEBAR_HEIGHT_PX = 32
export const MAC_WINDOW_TITLEBAR_HEIGHT_PX = 40
export const WINDOW_TITLEBAR_CONTROL_COUNT = 3
export const WINDOW_TITLEBAR_CONTROL_WIDTH_PX = 46
export const WINDOW_TITLEBAR_CONTROLS_WIDTH_PX = WINDOW_TITLEBAR_CONTROL_COUNT * WINDOW_TITLEBAR_CONTROL_WIDTH_PX

export function getWindowTitlebarContentInsetClass(isWindows: boolean): string {
  return isWindows ? 'pt-8' : ''
}

export function getWindowTitlebarDragInsetStyle(isWindows: boolean): { right: number } {
  return { right: isWindows ? WINDOW_TITLEBAR_CONTROLS_WIDTH_PX : 0 }
}

/** 返回 Canvas 展开态需要避让的系统标题栏高度。 */
export function getCanvasExpandedTitlebarHeight(
  expanded: boolean,
  isMac: boolean,
  isWindows: boolean,
): number {
  if (!expanded) return 0
  if (isWindows) return WINDOW_TITLEBAR_HEIGHT_PX
  if (isMac) return MAC_WINDOW_TITLEBAR_HEIGHT_PX
  return 0
}
