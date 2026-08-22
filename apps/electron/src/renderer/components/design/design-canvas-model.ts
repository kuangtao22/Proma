import type {
  DesignAsset,
  DesignCanvasDocument,
  DesignCanvasNode,
  DesignMutation,
  DesignPoint,
  DesignViewport,
} from '@proma/shared'
import type { DesignAssetFlowNode, DesignAssetNodeData } from './DesignAssetNode'

export interface ToFlowNodesOptions {
  /** 当前窗口持有的缩略图媒体授权根 URL。 */
  thumbnailBaseUrl?: string
}

export interface PositionedFlowNode {
  /** XYFlow 节点稳定 ID。 */
  id: string
  /** 本次交互结束时的最终画布坐标。 */
  position: DesignPoint
}

/**
 * 把一次节点拖动结束结果压缩成单个持久化 mutation。
 * @param nodes 本次共同移动节点的最终位置。
 * @returns 只包含稳定 ID 与坐标的 move-nodes mutation。
 */
export function createMoveNodesMutation(nodes: PositionedFlowNode[]): DesignMutation {
  return {
    type: 'move-nodes',
    positions: nodes.map((node) => ({ nodeId: node.id, position: node.position })),
  }
}

/**
 * 把 XYFlow 移动结束视口转换为受控持久化 mutation。
 * @param viewport 移动或缩放结束时的最终视口。
 * @returns 单个 set-viewport mutation。
 */
export function createViewportMutation(viewport: DesignViewport): DesignMutation {
  return { type: 'set-viewport', viewport }
}

/**
 * 合并最新 document 节点，同时保护仍在拖动的节点本地坐标。
 * @param currentNodes XYFlow 当前内存节点，包含尚未结束的拖动位置。
 * @param documentNodes 最新 document 映射出的权威展示节点。
 * @param activeDragNodeIds 当前仍处于拖动手势中的节点 ID。
 * @returns 展示字段跟随 document、活动节点位置保留本地值的新数组。
 */
export function mergeDocumentFlowNodes(
  currentNodes: DesignAssetFlowNode[],
  documentNodes: DesignAssetFlowNode[],
  activeDragNodeIds: ReadonlySet<string>,
): DesignAssetFlowNode[] {
  /** 当前节点索引用于常数时间读取活动拖动位置。 */
  const currentById = new Map(currentNodes.map((node) => [node.id, node]))
  return documentNodes.map((node) => {
    /** 非活动节点直接采用最新 document 状态。 */
    if (!activeDragNodeIds.has(node.id)) return node
    /** 活动节点可能刚被远端删除；无当前节点时仍以 document 为准。 */
    const current = currentById.get(node.id)
    return current ? { ...node, position: current.position } : node
  })
}

/**
 * 读取持久化相对路径的文件名。
 * @param relativePath 已校验为正斜杠分隔的项目相对路径。
 * @returns 不包含目录信息的文件名。
 */
function getRelativePathBasename(relativePath: string): string {
  /** 路径末段是允许传给媒体协议的唯一持久化路径信息。 */
  return relativePath.split('/').at(-1) ?? relativePath
}

/**
 * 使用媒体授权根与缩略图文件名构造预览 URL。
 * @param thumbnailBaseUrl 当前窗口持有的缩略图授权根。
 * @param thumbnailRelativePath 缩略图持久化相对路径。
 * @returns 不暴露项目目录层级的编码 URL；无授权时返回 undefined。
 */
function createPreviewUrl(
  thumbnailBaseUrl: string | undefined,
  thumbnailRelativePath: string,
): string | undefined {
  if (!thumbnailBaseUrl) return undefined
  /** 清除授权根末尾分隔符，确保最终 URL 只有一个连接斜杠。 */
  const normalizedBaseUrl = thumbnailBaseUrl.replace(/\/+$/, '')
  /** 编码后的缩略图文件名不会泄露原图相对路径。 */
  const encodedFilename = encodeURIComponent(getRelativePathBasename(thumbnailRelativePath))
  return `${normalizedBaseUrl}/${encodedFilename}`
}

/**
 * 创建已解析素材的最小展示数据。
 * @param node 画布中的素材节点。
 * @param asset 与节点引用匹配的素材元数据。
 * @param thumbnailBaseUrl 当前窗口持有的缩略图授权根。
 * @returns 不含原图路径、缩略图相对路径、哈希或二进制内容的节点数据。
 */
function createAssetNodeData(
  node: DesignCanvasNode,
  asset: DesignAsset | undefined,
  thumbnailBaseUrl: string | undefined,
): DesignAssetNodeData {
  if (!asset) {
    return {
      kind: 'asset',
      status: 'missing',
      assetId: node.assetId ?? '',
      title: '素材缺失',
    }
  }
  /** 授权存在时才向节点公开可消费的缩略图 URL。 */
  const previewUrl = createPreviewUrl(thumbnailBaseUrl, asset.thumbnailRelativePath)
  return {
    kind: 'asset',
    status: 'success',
    assetId: asset.id,
    title: asset.filename,
    pixelWidth: asset.width,
    pixelHeight: asset.height,
    ...(previewUrl ? { previewUrl } : {}),
  }
}

/**
 * 把持久化 Design 文档投影成 XYFlow 节点。
 * @param document 当前项目的乐观画布文档。
 * @param options 当前窗口缩略图授权信息。
 * @returns 仅包含画布布局和安全展示字段的 XYFlow 节点。
 */
export function toFlowNodes(
  document: DesignCanvasDocument,
  options: ToFlowNodesOptions,
): DesignAssetFlowNode[] {
  /** 素材索引避免每个素材节点重复线性扫描文档。 */
  const assetsById = new Map(document.assets.map((asset) => [asset.id, asset]))
  return document.nodes.map((node): DesignAssetFlowNode => {
    /** 任务详情由后续任务生命周期接入；当前画布仅安全展示稳定任务引用。 */
    const data: DesignAssetNodeData = node.kind === 'job'
      ? {
          kind: 'job',
          status: 'queued',
          jobId: node.jobId ?? '',
          title: '图片任务',
        }
      : createAssetNodeData(node, node.assetId ? assetsById.get(node.assetId) : undefined, options.thumbnailBaseUrl)
    return {
      id: node.id,
      type: 'designAsset',
      position: node.position,
      width: node.width,
      height: node.height,
      zIndex: node.zIndex,
      selectable: true,
      draggable: true,
      connectable: false,
      deletable: false,
      data,
    }
  })
}
