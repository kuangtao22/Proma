import { DESIGN_IPC_CHANNELS } from '@proma/shared'
import type {
  DeleteDesignAssetInput,
  DesignAnnotation,
  DesignCanvasDocument,
  DesignCanvasNode,
  DesignChangeEvent,
  DesignGroup,
  DesignMutation,
  DesignPoint,
  DesignWorkspaceSnapshot,
  ExportDesignAssetInput,
  ImportDesignAssetsInput,
  RelinkDesignAssetInput,
  SaveDesignMutationsInput,
} from '@proma/shared'
import type { IpcMainInvokeEvent, WebContents } from 'electron'
import type { WorkspaceOperationGuard } from '../workspace-operation-guard'
import type { DesignAssetService } from './design-asset-service'
import type { DesignStore } from './design-store'

/** Renderer 可提交的画布 mutation 白名单，素材元数据只能由主进程服务维护。 */
const RENDERER_MUTATION_TYPES = new Set<DesignMutation['type']>([
  'set-viewport',
  'move-nodes',
  'upsert-nodes',
  'remove-nodes',
  'upsert-groups',
  'remove-groups',
  'upsert-annotations',
  'remove-annotations',
])

/** Design IPC handler 的最小签名。 */
type DesignIpcHandler = (event: IpcMainInvokeEvent, input?: unknown) => unknown

/** 可注入的 IPC 注册能力。 */
export interface DesignIpcRegistrar {
  handle: (channel: string, handler: DesignIpcHandler) => void
  removeHandler: (channel: string) => void
}

/** IPC 层实际使用的素材服务窄接口。 */
export interface DesignIpcAssetService extends Pick<
  DesignAssetService,
  'importAuthorizedFiles' | 'deleteAsset' | 'relinkAsset' | 'exportAsset' | 'createMediaAccess'
> {}

/** 注册 Design IPC 所需的可信主进程依赖。 */
export interface DesignIpcOptions {
  ipc: DesignIpcRegistrar
  listAuthorizedWebContents: () => WebContents[]
  guard: Pick<WorkspaceOperationGuard, 'runWorkspaceWrite'>
  store: DesignStore
  assets: DesignIpcAssetService
  pickImageFiles: (sender: WebContents) => Promise<string[]>
  pickRelinkImageFile: (sender: WebContents) => Promise<string | null>
  pickExportPath: (sender: WebContents, filename: string) => Promise<string | null>
}

/** 普通对象运行时判定。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 确认请求没有夹带路径等未声明字段。 */
function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys)
  return Object.keys(value).every((key) => allowed.has(key))
}

/** 非空字符串判定。 */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

/** 有限数字判定。 */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** 非负整数 revision 判定。 */
function isRevision(value: unknown): value is number {
  return Number.isInteger(value) && isFiniteNumber(value) && value >= 0
}

/** 二维坐标结构判定。 */
function isPoint(value: unknown): value is DesignPoint {
  return isRecord(value)
    && hasOnlyKeys(value, ['x', 'y'])
    && isFiniteNumber(value.x)
    && isFiniteNumber(value.y)
}

/** 画布节点结构判定。 */
function isCanvasNode(value: unknown): value is DesignCanvasNode {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    'id', 'kind', 'position', 'width', 'height', 'zIndex', 'assetId', 'jobId', 'groupId',
  ])) return false
  if (!isNonEmptyString(value.id)
    || (value.kind !== 'asset' && value.kind !== 'job')
    || !isPoint(value.position)
    || !isFiniteNumber(value.width) || value.width <= 0
    || !isFiniteNumber(value.height) || value.height <= 0
    || !isFiniteNumber(value.zIndex)) return false
  return [value.assetId, value.jobId, value.groupId]
    .every((item) => item === undefined || isNonEmptyString(item))
}

/** 分组结构判定。 */
function isGroup(value: unknown): value is DesignGroup {
  return isRecord(value)
    && hasOnlyKeys(value, ['id', 'name', 'nodeIds'])
    && isNonEmptyString(value.id)
    && typeof value.name === 'string'
    && Array.isArray(value.nodeIds)
    && value.nodeIds.every(isNonEmptyString)
}

/** 箭头或蒙版批注结构判定。 */
function isAnnotation(value: unknown): value is DesignAnnotation {
  if (!isRecord(value)
    || !isNonEmptyString(value.id)
    || !isNonEmptyString(value.color)
    || !isFiniteNumber(value.width) || value.width <= 0
    || !isFiniteNumber(value.createdAt)) return false
  if (value.kind === 'arrow') {
    return hasOnlyKeys(value, ['id', 'kind', 'from', 'to', 'color', 'width', 'createdAt'])
      && isPoint(value.from) && isPoint(value.to)
  }
  return value.kind === 'mask'
    && hasOnlyKeys(value, ['id', 'kind', 'points', 'color', 'width', 'createdAt'])
    && Array.isArray(value.points)
    && value.points.length >= 2
    && value.points.every(isPoint)
}

/** 对单个 renderer mutation 做完整运行时结构校验。 */
function isRendererMutation(value: unknown): value is DesignMutation {
  if (!isRecord(value) || !isNonEmptyString(value.type)) return false
  if (!RENDERER_MUTATION_TYPES.has(value.type as DesignMutation['type'])) return false
  switch (value.type) {
    case 'set-viewport':
      return hasOnlyKeys(value, ['type', 'viewport'])
        && isRecord(value.viewport)
        && hasOnlyKeys(value.viewport, ['x', 'y', 'zoom'])
        && isFiniteNumber(value.viewport.x)
        && isFiniteNumber(value.viewport.y)
        && isFiniteNumber(value.viewport.zoom)
        && value.viewport.zoom >= 0.05
        && value.viewport.zoom <= 8
    case 'move-nodes':
      return hasOnlyKeys(value, ['type', 'positions'])
        && Array.isArray(value.positions)
        && value.positions.every((item) => isRecord(item)
          && hasOnlyKeys(item, ['nodeId', 'position'])
          && isNonEmptyString(item.nodeId)
          && isPoint(item.position))
    case 'upsert-nodes':
      return hasOnlyKeys(value, ['type', 'nodes'])
        && Array.isArray(value.nodes) && value.nodes.every(isCanvasNode)
    case 'remove-nodes':
      return hasOnlyKeys(value, ['type', 'nodeIds'])
        && Array.isArray(value.nodeIds) && value.nodeIds.every(isNonEmptyString)
    case 'upsert-groups':
      return hasOnlyKeys(value, ['type', 'groups'])
        && Array.isArray(value.groups) && value.groups.every(isGroup)
    case 'remove-groups':
      return hasOnlyKeys(value, ['type', 'groupIds'])
        && Array.isArray(value.groupIds) && value.groupIds.every(isNonEmptyString)
    case 'upsert-annotations':
      return hasOnlyKeys(value, ['type', 'annotations'])
        && Array.isArray(value.annotations) && value.annotations.every(isAnnotation)
    case 'remove-annotations':
      return hasOnlyKeys(value, ['type', 'annotationIds'])
        && Array.isArray(value.annotationIds) && value.annotationIds.every(isNonEmptyString)
    default:
      return false
  }
}

/** 解析只含 projectId 的请求。 */
function parseProjectInput(value: unknown): ImportDesignAssetsInput {
  if (!isRecord(value) || !hasOnlyKeys(value, ['projectId']) || !isNonEmptyString(value.projectId)) {
    throw new Error('Design 请求结构无效')
  }
  return { projectId: value.projectId }
}

/** 解析画布保存请求，并拒绝素材 mutation。 */
function parseSaveInput(value: unknown): SaveDesignMutationsInput {
  if (!isRecord(value)
    || !hasOnlyKeys(value, ['projectId', 'expectedRevision', 'mutations'])
    || !isNonEmptyString(value.projectId)
    || !isRevision(value.expectedRevision)
    || !Array.isArray(value.mutations)) throw new Error('Design 请求结构无效')
  for (const mutation of value.mutations) {
    if (isRecord(mutation) && (mutation.type === 'upsert-assets' || mutation.type === 'remove-assets')) {
      throw new Error('不允许通过画布保存修改素材')
    }
    if (!isRendererMutation(mutation)) throw new Error('Design 请求结构无效')
  }
  return {
    projectId: value.projectId,
    expectedRevision: value.expectedRevision,
    mutations: value.mutations,
  }
}

/** 解析素材 ID 请求，可按命令要求 revision。 */
function parseAssetInput(value: unknown, withRevision: true): DeleteDesignAssetInput | RelinkDesignAssetInput
function parseAssetInput(value: unknown, withRevision: false): ExportDesignAssetInput
function parseAssetInput(value: unknown, withRevision: boolean): DeleteDesignAssetInput | ExportDesignAssetInput {
  const keys = withRevision ? ['projectId', 'assetId', 'expectedRevision'] : ['projectId', 'assetId']
  if (!isRecord(value)
    || !hasOnlyKeys(value, keys)
    || !isNonEmptyString(value.projectId)
    || !isNonEmptyString(value.assetId)
    || (withRevision && !isRevision(value.expectedRevision))) throw new Error('Design 请求结构无效')
  return withRevision
    ? { projectId: value.projectId, assetId: value.assetId, expectedRevision: value.expectedRevision as number }
    : { projectId: value.projectId, assetId: value.assetId }
}

/** 确认调用者属于当前主应用授权窗口集合。 */
function assertAuthorizedSender(event: IpcMainInvokeEvent, authorized: WebContents[]): WebContents {
  if (!authorized.some((candidate) => candidate === event.sender || candidate.id === event.sender.id)) {
    throw new Error('未授权窗口不能访问 Design 工作区')
  }
  return event.sender
}

/** 向所有仍存活的授权窗口广播 revision 变化，包括发起窗口。 */
function broadcastChange(options: DesignIpcOptions, change: DesignChangeEvent): void {
  for (const contents of options.listAuthorizedWebContents()) {
    if (!contents.isDestroyed()) contents.send(DESIGN_IPC_CHANNELS.CHANGED, change)
  }
}

/** 注册 Task 4 已具备业务服务的七个 Design IPC handler。 */
export function registerDesignIpcHandlers(options: DesignIpcOptions): string[] {
  /** 每个窗口当前拥有的目录级媒体授权释放器。 */
  const mediaReleases = new Map<number, () => void>()
  /** 本任务实际注册的通道，供测试和未来增量注册使用。 */
  const channels = [
    DESIGN_IPC_CHANNELS.LOAD,
    DESIGN_IPC_CHANNELS.SAVE_MUTATIONS,
    DESIGN_IPC_CHANNELS.IMPORT_ASSETS,
    DESIGN_IPC_CHANNELS.DELETE_ASSET,
    DESIGN_IPC_CHANNELS.RELINK_ASSET,
    DESIGN_IPC_CHANNELS.EXPORT_ASSET,
    DESIGN_IPC_CHANNELS.RELEASE_MEDIA_ACCESS,
  ]
  for (const channel of channels) options.ipc.removeHandler(channel)

  options.ipc.handle(DESIGN_IPC_CHANNELS.LOAD, async (event, value): Promise<DesignWorkspaceSnapshot> => {
    const sender = assertAuthorizedSender(event, options.listAuthorizedWebContents())
    const input = parseProjectInput(value)
    mediaReleases.get(sender.id)?.()
    mediaReleases.delete(sender.id)
    const snapshot = options.store.load(input.projectId)
    if (!snapshot.writable) return snapshot
    const access = options.assets.createMediaAccess(input.projectId)
    mediaReleases.set(sender.id, access.release)
    return { ...snapshot, assetBaseUrl: access.assetBaseUrl, thumbnailBaseUrl: access.thumbnailBaseUrl }
  })

  options.ipc.handle(DESIGN_IPC_CHANNELS.SAVE_MUTATIONS, async (event, value): Promise<DesignCanvasDocument> => {
    assertAuthorizedSender(event, options.listAuthorizedWebContents())
    const input = parseSaveInput(value)
    const document = await options.guard.runWorkspaceWrite(input.projectId, () => (
      options.store.mutate(input.projectId, input.expectedRevision, input.mutations)
    ))
    if (input.mutations.length > 0) {
      broadcastChange(options, { projectId: input.projectId, revision: document.revision, cause: 'canvas' })
    }
    return document
  })

  options.ipc.handle(DESIGN_IPC_CHANNELS.IMPORT_ASSETS, async (event, value): Promise<DesignWorkspaceSnapshot> => {
    const sender = assertAuthorizedSender(event, options.listAuthorizedWebContents())
    const input = parseProjectInput(value)
    return options.guard.runWorkspaceWrite(input.projectId, async () => {
      const sourcePaths = await options.pickImageFiles(sender)
      if (sourcePaths.length === 0) return options.store.load(input.projectId)
      const assets = await options.assets.importAuthorizedFiles(input.projectId, sourcePaths, { kind: 'picker' })
      const current = options.store.load(input.projectId)
      const document = assets.length === 0
        ? current.document
        : options.store.mutate(input.projectId, current.document.revision, [{ type: 'upsert-assets', assets }])
      if (assets.length > 0) {
        broadcastChange(options, { projectId: input.projectId, revision: document.revision, cause: 'asset' })
      }
      return { ...current, document }
    })
  })

  options.ipc.handle(DESIGN_IPC_CHANNELS.DELETE_ASSET, async (event, value): Promise<DesignCanvasDocument> => {
    assertAuthorizedSender(event, options.listAuthorizedWebContents())
    const input = parseAssetInput(value, true)
    const document = await options.guard.runWorkspaceWrite(input.projectId, () => (
      options.assets.deleteAsset(input.projectId, input.assetId, input.expectedRevision)
    ))
    broadcastChange(options, { projectId: input.projectId, revision: document.revision, cause: 'asset' })
    return document
  })

  options.ipc.handle(DESIGN_IPC_CHANNELS.RELINK_ASSET, async (event, value): Promise<DesignCanvasDocument> => {
    const sender = assertAuthorizedSender(event, options.listAuthorizedWebContents())
    const input = parseAssetInput(value, true)
    return options.guard.runWorkspaceWrite(input.projectId, async () => {
      const sourcePath = await options.pickRelinkImageFile(sender)
      if (!sourcePath) return options.store.load(input.projectId).document
      const document = await options.assets.relinkAsset(
        input.projectId,
        input.assetId,
        sourcePath,
        input.expectedRevision,
      )
      broadcastChange(options, { projectId: input.projectId, revision: document.revision, cause: 'asset' })
      return document
    })
  })

  options.ipc.handle(DESIGN_IPC_CHANNELS.EXPORT_ASSET, async (event, value): Promise<void> => {
    const sender = assertAuthorizedSender(event, options.listAuthorizedWebContents())
    const input = parseAssetInput(value, false)
    const asset = options.store.load(input.projectId).document.assets.find((item) => item.id === input.assetId)
    if (!asset) throw new Error(`素材不存在: ${input.assetId}`)
    const targetPath = await options.pickExportPath(sender, asset.filename)
    if (targetPath) await options.assets.exportAsset(input.projectId, input.assetId, targetPath)
  })

  options.ipc.handle(DESIGN_IPC_CHANNELS.RELEASE_MEDIA_ACCESS, async (event, value): Promise<void> => {
    const sender = assertAuthorizedSender(event, options.listAuthorizedWebContents())
    if (value !== undefined) throw new Error('Design 请求结构无效')
    mediaReleases.get(sender.id)?.()
    mediaReleases.delete(sender.id)
  })

  return channels
}
