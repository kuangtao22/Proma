import type { DesignAsset } from '@proma/shared'

/** 右栏展示的单个素材版本节点。 */
export interface DesignVersionTreeNode {
  id: string
  asset: DesignAsset
  current: boolean
  children: DesignVersionTreeNode[]
}

/**
 * 判断素材是否属于 parentAssetId 循环。
 * @param assetId 待检查素材 ID。
 * @param assetsById 全部素材索引。
 * @returns 素材位于自环或多节点环中时返回 true。
 */
function isAssetInParentCycle(assetId: string, assetsById: ReadonlyMap<string, DesignAsset>): boolean {
  /** 当前追踪路径上的素材 ID。 */
  const visited = new Set<string>()
  /** 从目标素材开始沿父链向上移动的游标。 */
  let cursor: string | undefined = assetId
  while (cursor) {
    if (visited.has(cursor)) return cursor === assetId
    visited.add(cursor)
    cursor = assetsById.get(cursor)?.parentAssetId
    if (cursor && !assetsById.has(cursor)) return false
  }
  return false
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
    if (!parent || isAssetInParentCycle(asset.id, assetsById)) roots.push(node)
    else parent.children.push(node)
  }
  return roots
}
