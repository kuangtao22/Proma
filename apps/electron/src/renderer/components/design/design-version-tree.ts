import type { DesignAsset } from '@proma/shared'

/** 右栏展示的单个素材版本节点。 */
export interface DesignVersionTreeNode {
  id: string
  asset: DesignAsset
  current: boolean
  children: DesignVersionTreeNode[]
}

/** 版本树扁平行，供右栏迭代渲染深链。 */
export interface DesignVersionTreeRow {
  node: DesignVersionTreeNode
  depth: number
}

/**
 * 以父指针颜色遍历在线性时间内找出全部循环成员。
 * @param assets 输入顺序稳定的素材集合。
 * @param assetsById 素材 ID 索引。
 * @returns 仅包含自环或多节点环本身的素材 ID。
 */
function findParentCycleIds(
  assets: DesignAsset[],
  assetsById: ReadonlyMap<string, DesignAsset>,
): ReadonlySet<string> {
  /** 0 未访问、1 当前路径、2 已完成。 */
  const colors = new Map<string, 1 | 2>()
  /** 所有循环成员，全局只记录一次。 */
  const cycleIds = new Set<string>()

  for (const asset of assets) {
    if (colors.has(asset.id)) continue
    /** 当前父链及其常数时间位置索引。 */
    const path: string[] = []
    const pathIndexes = new Map<string, number>()
    /** 沿唯一父指针迭代，避免深版本链递归溢出。 */
    let cursor: string | undefined = asset.id
    while (cursor && assetsById.has(cursor) && !colors.has(cursor)) {
      colors.set(cursor, 1)
      pathIndexes.set(cursor, path.length)
      path.push(cursor)
      cursor = assetsById.get(cursor)?.parentAssetId
    }
    if (cursor && colors.get(cursor) === 1) {
      const cycleStart = pathIndexes.get(cursor)
      if (cycleStart !== undefined) {
        for (let index = cycleStart; index < path.length; index += 1) {
          cycleIds.add(path[index]!)
        }
      }
    }
    for (const pathId of path) colors.set(pathId, 2)
  }
  return cycleIds
}

/**
 * 按 parentAssetId 构建稳定版本树。
 * @param assets 项目素材，输入顺序同时作为根节点和同级节点顺序。
 * @param currentAssetId 当前画布选中的素材 ID。
 * @returns 缺失父项及循环项均提升为根的无环版本树。
 */
export function buildDesignVersionTree(
  assets: DesignAsset[],
  currentAssetId: string | null,
): DesignVersionTreeNode[] {
  /** 素材索引用于常数时间解析父项。 */
  const assetsById = new Map(assets.map((asset) => [asset.id, asset]))
  /** 一次颜色遍历识别循环，避免逐节点重复扫描父链。 */
  const cycleIds = findParentCycleIds(assets, assetsById)
  /** 每个素材预先对应唯一展示节点。 */
  const nodesById = new Map<string, DesignVersionTreeNode>(assets.map((asset) => [asset.id, {
    id: asset.id,
    asset,
    current: asset.id === currentAssetId,
    children: [],
  }]))
  /** 无法安全连接父项的素材按输入顺序进入根集合。 */
  const roots: DesignVersionTreeNode[] = []

  for (const asset of assets) {
    /** 当前素材对应的稳定展示节点。 */
    const node = nodesById.get(asset.id)!
    /** 缺失父项、自环和多节点循环均不得建立递归边。 */
    const parent = asset.parentAssetId ? nodesById.get(asset.parentAssetId) : undefined
    if (!parent || cycleIds.has(asset.id)) roots.push(node)
    else parent.children.push(node)
  }
  return roots
}

/**
 * 将版本树按先序迭代展开，避免深链递归渲染。
 * @param roots 已保证无环的版本树根集合。
 * @returns 保留同级顺序并携带缩进深度的扁平行。
 */
export function flattenDesignVersionTree(roots: DesignVersionTreeNode[]): DesignVersionTreeRow[] {
  /** 逆序入栈确保弹出顺序与输入一致。 */
  const stack = roots.slice().reverse().map((node) => ({ node, depth: 0 }))
  /** 最终按 UI 展示顺序排列的行。 */
  const rows: DesignVersionTreeRow[] = []
  while (stack.length > 0) {
    const row = stack.pop()!
    rows.push(row)
    for (let index = row.node.children.length - 1; index >= 0; index -= 1) {
      stack.push({ node: row.node.children[index]!, depth: row.depth + 1 })
    }
  }
  return rows
}
