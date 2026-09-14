/** 图片卡片固定宽度，主进程避让与 Renderer 预览使用同一几何基准。 */
export const CANVAS_IMAGE_NODE_WIDTH = 288
/** 图片卡片标题栏的固定高度。 */
export const CANVAS_IMAGE_NODE_HEADER_HEIGHT = 48
/** 极宽预览也保留可读区域。 */
export const CANVAS_IMAGE_PREVIEW_MIN_HEIGHT = 96
/** 极长图片的预览高度上限。 */
export const CANVAS_IMAGE_PREVIEW_MAX_HEIGHT = 320
/** 创建时未知真实图片比例，预留所有合法预览都不会超出的高度。 */
export const CANVAS_IMAGE_NODE_MAX_HEIGHT = CANVAS_IMAGE_NODE_HEADER_HEIGHT + CANVAS_IMAGE_PREVIEW_MAX_HEIGHT

/**
 * 根据可信图片尺寸计算可见卡片高度。
 * @param preview 素材元数据中的宽高；缺失或非法时按空卡显示。
 * @returns 标题加有界预览的高度，不读取或解码图片。
 */
export function resolveCanvasImageNodeHeight(preview?: { width: number; height: number }): number {
  if (!preview || !Number.isFinite(preview.width) || !Number.isFinite(preview.height)
    || preview.width <= 0 || preview.height <= 0) {
    return CANVAS_IMAGE_NODE_HEADER_HEIGHT + CANVAS_IMAGE_PREVIEW_MIN_HEIGHT
  }
  return CANVAS_IMAGE_NODE_HEADER_HEIGHT + Math.min(CANVAS_IMAGE_PREVIEW_MAX_HEIGHT,
    Math.max(CANVAS_IMAGE_PREVIEW_MIN_HEIGHT, CANVAS_IMAGE_NODE_WIDTH * preview.height / preview.width))
}
