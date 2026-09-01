import type { DesignPoint } from '../types/design'

/** Canvas 自动布局使用的有限正尺寸。 */
export interface CanvasLayoutSize {
  width: number
  height: number
}

/** 空间索引中的持久节点矩形。 */
export interface CanvasLayoutRect extends DesignPoint, CanvasLayoutSize {
  id: string
}

/** 紧凑槽位搜索的稳定输入。 */
export interface FindCompactCanvasSlotInput {
  anchor: DesignPoint
  size: CanvasLayoutSize
  order: number
  direction: 'ring' | 'right'
}

/** Canvas 矩形空间索引的最小公开合同。 */
export interface CanvasLayoutSpatialIndex {
  readonly size: number
  readonly gap: number
  insert: (rect: CanvasLayoutRect) => void
  overlaps: (rect: Omit<CanvasLayoutRect, 'id'>) => boolean
}

/** 空间哈希固定桶边长，兼顾常规卡片和手机 WebView 的查询数量。 */
const CANVAS_LAYOUT_BUCKET_SIZE = 320

/** 判断坐标和尺寸是否能安全进入布局计算。 */
function isValidCanvasLayoutRect(rect: Omit<CanvasLayoutRect, 'id'>): boolean {
  return Number.isFinite(rect.x)
    && Number.isFinite(rect.y)
    && Number.isFinite(rect.width)
    && Number.isFinite(rect.height)
    && rect.width > 0
    && rect.height > 0
}

/** 把二维桶坐标编码为稳定字符串键。 */
function createCanvasLayoutBucketKey(column: number, row: number): string {
  return `${column}:${row}`
}

/** 枚举矩形覆盖的全部空间桶键。 */
function listCanvasLayoutBucketKeys(rect: Omit<CanvasLayoutRect, 'id'>): string[] {
  /** 右下边界减去极小值，避免恰好落在桶边界时多占一桶。 */
  const right = rect.x + rect.width - Number.EPSILON
  /** 底部边界减去极小值，避免恰好落在桶边界时多占一桶。 */
  const bottom = rect.y + rect.height - Number.EPSILON
  /** 当前矩形覆盖的首列桶。 */
  const startColumn = Math.floor(rect.x / CANVAS_LAYOUT_BUCKET_SIZE)
  /** 当前矩形覆盖的末列桶。 */
  const endColumn = Math.floor(right / CANVAS_LAYOUT_BUCKET_SIZE)
  /** 当前矩形覆盖的首行桶。 */
  const startRow = Math.floor(rect.y / CANVAS_LAYOUT_BUCKET_SIZE)
  /** 当前矩形覆盖的末行桶。 */
  const endRow = Math.floor(bottom / CANVAS_LAYOUT_BUCKET_SIZE)
  /** 返回值只包含当前矩形真正覆盖的桶。 */
  const keys: string[] = []
  for (let column = startColumn; column <= endColumn; column += 1) {
    for (let row = startRow; row <= endRow; row += 1) {
      keys.push(createCanvasLayoutBucketKey(column, row))
    }
  }
  return keys
}

/** 判断候选矩形与已有矩形是否违反指定净间距。 */
function canvasLayoutRectsOverlap(
  candidate: Omit<CanvasLayoutRect, 'id'>,
  existing: CanvasLayoutRect,
  gap: number,
): boolean {
  return candidate.x < existing.x + existing.width + gap
    && candidate.x + candidate.width + gap > existing.x
    && candidate.y < existing.y + existing.height + gap
    && candidate.y + candidate.height + gap > existing.y
}

/**
 * 创建支持动态矩形和净间距查询的有界空间索引。
 * @param rects 当前画布已有节点矩形。
 * @param gap 节点间必须保留的最小净间距。
 * @returns 可增量插入并进行局部碰撞查询的空间索引。
 */
export function createCanvasLayoutSpatialIndex(
  rects: readonly CanvasLayoutRect[],
  gap: number,
): CanvasLayoutSpatialIndex {
  if (!Number.isFinite(gap) || gap < 0) throw new Error('CANVAS_LAYOUT_GAP_INVALID')
  /** 以桶键索引可能相交的矩形，避免每次候选都扫描全部节点。 */
  const buckets = new Map<string, CanvasLayoutRect[]>()
  /** 已插入矩形数量用于限制槽位搜索。 */
  let size = 0

  /** 插入单个已校验矩形。 */
  const insert = (rect: CanvasLayoutRect): void => {
    if (typeof rect.id !== 'string' || rect.id.length === 0 || !isValidCanvasLayoutRect(rect)) {
      throw new Error('CANVAS_LAYOUT_RECT_INVALID')
    }
    for (const key of listCanvasLayoutBucketKeys(rect)) {
      /** 当前桶中的矩形列表按插入顺序保持稳定。 */
      const entries = buckets.get(key) ?? []
      entries.push({ ...rect })
      buckets.set(key, entries)
    }
    size += 1
  }

  /** 查询候选矩形是否与任一已有矩形违反净间距。 */
  const overlaps = (rect: Omit<CanvasLayoutRect, 'id'>): boolean => {
    if (!isValidCanvasLayoutRect(rect)) throw new Error('CANVAS_LAYOUT_RECT_INVALID')
    /** 扩张候选查询范围，确保跨桶的净间距碰撞不会漏检。 */
    const queryRect = {
      x: rect.x - gap,
      y: rect.y - gap,
      width: rect.width + gap * 2,
      height: rect.height + gap * 2,
    }
    /** 同一大矩形可能进入多个桶，使用 ID 去重后再精确判断。 */
    const visitedIds = new Set<string>()
    for (const key of listCanvasLayoutBucketKeys(queryRect)) {
      for (const existing of buckets.get(key) ?? []) {
        if (visitedIds.has(existing.id)) continue
        visitedIds.add(existing.id)
        if (canvasLayoutRectsOverlap(rect, existing, gap)) return true
      }
    }
    return false
  }

  for (const rect of rects) insert(rect)
  return {
    get size() { return size },
    gap,
    insert,
    overlaps,
  }
}

/** 按方形环顺序生成相对槽位，序号 0 固定为锚点。 */
function resolveRingCanvasLayoutOffset(index: number): DesignPoint {
  if (index === 0) return { x: 0, y: 0 }
  /** 当前序号所在的方形环半径。 */
  const radius = Math.ceil((Math.sqrt(index + 1) - 1) / 2)
  /** 当前环之前累计的槽位数量。 */
  const previousCount = (radius * 2 - 1) ** 2
  /** 当前序号在本环上的零基偏移。 */
  const offset = index - previousCount
  /** 当前环单边除角外的步数。 */
  const sideLength = radius * 2
  if (offset < sideLength) return { x: radius, y: -radius + offset }
  if (offset < sideLength * 2) return { x: radius - (offset - sideLength), y: radius }
  if (offset < sideLength * 3) return { x: -radius, y: radius - (offset - sideLength * 2) }
  return { x: -radius + (offset - sideLength * 3), y: -radius }
}

/** 按只向右扩展的紧凑列顺序生成相对槽位。 */
function resolveRightCanvasLayoutOffset(index: number): DesignPoint {
  if (index === 0) return { x: 0, y: 0 }
  /** 每列按中心、下方、上方顺序填充五个常见兄弟槽位。 */
  const slotsPerColumn = 5
  /** 当前序号所在的非负列。 */
  const column = Math.floor(index / slotsPerColumn)
  /** 当前列中的稳定纵向槽位。 */
  const rowIndex = index % slotsPerColumn
  /** 纵向顺序使兄弟节点围绕来源 Y 轴附近换行。 */
  const rows = [0, 1, -1, 2, -2] as const
  return { x: column, y: rows[rowIndex] ?? 0 }
}

/**
 * 从可信锚点附近寻找第一个不碰撞的稳定紧凑槽位。
 * @param index 当前画布的增量空间索引。
 * @param input 候选尺寸、稳定顺序和布局方向。
 * @returns 可安全放置候选节点的世界坐标。
 */
export function findCompactCanvasSlot(
  index: CanvasLayoutSpatialIndex,
  input: FindCompactCanvasSlotInput,
): DesignPoint {
  if (!isValidCanvasLayoutRect({ ...input.anchor, ...input.size })
    || !Number.isSafeInteger(input.order)
    || input.order < 0
    || (input.direction !== 'ring' && input.direction !== 'right')) {
    throw new Error('CANVAS_LAYOUT_INPUT_INVALID')
  }
  /** 水平槽位步长包含候选真实宽度和固定净间距。 */
  const horizontalStep = input.size.width + index.gap
  /** 垂直槽位步长包含候选真实高度和固定净间距。 */
  const verticalStep = input.size.height + index.gap
  /** 搜索上限随已有节点和稳定顺序增长，但始终保持有限。 */
  const searchLimit = Math.max(16, index.size + input.order + 16)
  for (let attempt = 0; attempt < searchLimit; attempt += 1) {
    /** 稳定顺序决定首选槽位，碰撞时只向后寻找。 */
    const candidateIndex = input.order + attempt
    /** 当前候选的离散网格偏移。 */
    const offset = input.direction === 'ring'
      ? resolveRingCanvasLayoutOffset(candidateIndex)
      : resolveRightCanvasLayoutOffset(candidateIndex)
    /** 由锚点、网格偏移和真实尺寸得到的候选矩形。 */
    const candidate = {
      x: input.anchor.x + offset.x * horizontalStep,
      y: input.anchor.y + offset.y * verticalStep,
      width: input.size.width,
      height: input.size.height,
    }
    if (!index.overlaps(candidate)) return { x: candidate.x, y: candidate.y }
  }
  throw new Error('CANVAS_LAYOUT_SLOT_UNAVAILABLE')
}
