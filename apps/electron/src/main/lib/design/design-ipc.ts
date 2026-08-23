import { randomUUID } from 'node:crypto'
import { DESIGN_IPC_CHANNELS, createEmptyDesignDocument } from '@proma/shared'
import type {
  CreateDesignJobInput,
  DeleteDesignAssetInput,
  DesignAnnotation,
  DesignCanvasDocument,
  DesignCanvasNode,
  DesignChangeEvent,
  DesignGroup,
  DesignJobControlInput,
  DesignJobRecord,
  DesignMutation,
  DesignPoint,
  DesignWorkspaceSnapshot,
  ExportDesignAssetInput,
  ImportAgentImageInput,
  ImportDesignAssetsInput,
  PrepareDesignAssetForSessionInput,
  PreparedDesignAssetMention,
  RelinkDesignAssetInput,
  SaveDesignMutationsInput,
} from '@proma/shared'
import type { IpcMainInvokeEvent, WebContents } from 'electron'
import type { WorkspaceOperationGuard } from '../workspace-operation-guard'
import type { DesignAssetImportBatch, DesignAssetService } from './design-asset-service'
import type { DesignStore } from './design-store'
import type { DesignJobManager } from './design-job-manager'
import type { DesignSessionBridge } from './design-session-bridge'

/** Renderer 可提交的画布 mutation 白名单，素材元数据只能由主进程服务维护。 */
const RENDERER_MUTATION_TYPES = new Set<DesignMutation['type']>([
  'set-viewport',
  'move-nodes',
  'upsert-nodes',
  'remove-nodes',
  'patch-nodes',
  'upsert-groups',
  'remove-groups',
  'patch-groups',
  'upsert-annotations',
  'remove-annotations',
  'patch-annotations',
])

/** Design IPC handler 的最小签名。 */
type DesignIpcHandler = (event: IpcMainInvokeEvent, input?: unknown) => unknown

/** 可注入的 IPC 注册能力。 */
export interface DesignIpcRegistrar {
  handle: (channel: string, handler: DesignIpcHandler) => void
  removeHandler: (channel: string) => void
}

/** Design IPC 注册结果，允许应用退出或热重载时显式清理。 */
export interface DesignIpcRegistration {
  /** 本次注册的全部通道。 */
  channels: string[]
  /** 移除 handler、窗口监听器与媒体授权。 */
  dispose: () => void
}

/** 同一 IPC registrar 的上一次注册，避免热重载遗留媒体授权。 */
const activeRegistrations = new WeakMap<DesignIpcRegistrar, () => void>()

/** IPC 层实际使用的素材服务窄接口。 */
export interface DesignIpcAssetService extends Pick<
  DesignAssetService,
  | 'importAuthorizedFiles'
  | 'deleteAsset'
  | 'relinkAsset'
  | 'exportAsset'
  | 'createMediaAccess'
> {}

/** IPC 层实际使用的任务服务窄接口。 */
export interface DesignIpcJobManager extends Pick<
  DesignJobManager,
  'create' | 'run' | 'cancel' | 'retry' | 'list' | 'reconcilePendingTerminals' | 'onChanged'
> {}

/** IPC 层实际使用的 Design/Agent 会话桥窄接口。 */
export interface DesignIpcSessionBridge extends Pick<
  DesignSessionBridge,
  'prepareAssetForSession' | 'importAgentImage'
> {}

/** 注册 Design IPC 所需的可信主进程依赖。 */
export interface DesignIpcOptions {
  ipc: DesignIpcRegistrar
  listAuthorizedWebContents: () => WebContents[]
  guard: Pick<WorkspaceOperationGuard, 'runWorkspaceWrite'>
  store: DesignStore
  assets: DesignIpcAssetService
  jobs: DesignIpcJobManager
  sessionBridge: DesignIpcSessionBridge
  pickImageFiles: (sender: WebContents) => Promise<string[]>
  pickRelinkImageFile: (sender: WebContents) => Promise<string | null>
  pickExportPath: (sender: WebContents, filename: string) => Promise<string | null>
  /** 项目路径离线或迁移时返回稳定只读原因，正常可读时返回 undefined。 */
  getProjectReadOnlyReason: (projectId: string) => string | undefined
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

/** 局部 patch 的实体必须携带非负目标数组索引。 */
function isIndexedEntity(value: unknown, isEntity: (entity: unknown) => boolean): boolean {
  return isRecord(value)
    && hasOnlyKeys(value, ['entity', 'index'])
    && isEntity(value.entity)
    && isRevision(value.index)
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
    case 'patch-nodes':
      return hasOnlyKeys(value, ['type', 'removeIds', 'upserts'])
        && Array.isArray(value.removeIds) && value.removeIds.every(isNonEmptyString)
        && Array.isArray(value.upserts) && value.upserts.every((item) => isIndexedEntity(item, isCanvasNode))
    case 'upsert-groups':
      return hasOnlyKeys(value, ['type', 'groups'])
        && Array.isArray(value.groups) && value.groups.every(isGroup)
    case 'remove-groups':
      return hasOnlyKeys(value, ['type', 'groupIds'])
        && Array.isArray(value.groupIds) && value.groupIds.every(isNonEmptyString)
    case 'patch-groups':
      return hasOnlyKeys(value, ['type', 'removeIds', 'upserts'])
        && Array.isArray(value.removeIds) && value.removeIds.every(isNonEmptyString)
        && Array.isArray(value.upserts) && value.upserts.every((item) => isIndexedEntity(item, isGroup))
    case 'upsert-annotations':
      return hasOnlyKeys(value, ['type', 'annotations'])
        && Array.isArray(value.annotations) && value.annotations.every(isAnnotation)
    case 'remove-annotations':
      return hasOnlyKeys(value, ['type', 'annotationIds'])
        && Array.isArray(value.annotationIds) && value.annotationIds.every(isNonEmptyString)
    case 'patch-annotations':
      return hasOnlyKeys(value, ['type', 'removeIds', 'upserts'])
        && Array.isArray(value.removeIds) && value.removeIds.every(isNonEmptyString)
        && Array.isArray(value.upserts) && value.upserts.every((item) => isIndexedEntity(item, isAnnotation))
    default:
      return false
  }
}

/** 解析只含 projectId 的请求。 */
function parseProjectInput(value: unknown): { projectId: string } {
  if (!isRecord(value) || !hasOnlyKeys(value, ['projectId']) || !isNonEmptyString(value.projectId)) {
    throw new Error('Design 请求结构无效')
  }
  return { projectId: value.projectId }
}

/** 解析原子素材导入请求，只接受 revision 与受控布局中心。 */
function parseImportAssetsInput(value: unknown): ImportDesignAssetsInput {
  if (!isRecord(value)
    || !hasOnlyKeys(value, ['projectId', 'expectedRevision', 'viewportCenter'])
    || !isNonEmptyString(value.projectId)
    || !isRevision(value.expectedRevision)
    || !isPoint(value.viewportCenter)) throw new Error('Design 请求结构无效')
  return {
    projectId: value.projectId,
    expectedRevision: value.expectedRevision,
    viewportCenter: value.viewportCenter,
  }
}

/** 解析设计素材发送到项目会话的只读请求。 */
function parsePrepareAssetForSessionInput(value: unknown): PrepareDesignAssetForSessionInput {
  if (!isRecord(value)
    || !hasOnlyKeys(value, ['projectId', 'assetId', 'sessionId'])
    || !isNonEmptyString(value.projectId)
    || !isNonEmptyString(value.assetId)
    || !isNonEmptyString(value.sessionId)) throw new Error('Design 请求结构无效')
  return {
    projectId: value.projectId,
    assetId: value.assetId,
    sessionId: value.sessionId,
  }
}

/** 解析 Agent 图片加入画布的受控请求。 */
function parseImportAgentImageInput(value: unknown): ImportAgentImageInput {
  if (!isRecord(value)
    || !hasOnlyKeys(value, ['projectId', 'sessionId', 'localPath', 'position'])
    || !isNonEmptyString(value.projectId)
    || !isNonEmptyString(value.sessionId)
    || !isNonEmptyString(value.localPath)
    || !isPoint(value.position)) throw new Error('Design 请求结构无效')
  return {
    projectId: value.projectId,
    sessionId: value.sessionId,
    localPath: value.localPath,
    position: value.position,
  }
}

/**
 * 为主进程已验证的素材创建固定画布节点。
 * @param document 导入前的权威画布文档。
 * @param assets 本批次由素材服务生成的可信元数据。
 * @param viewportCenter Renderer 提供且经过形状校验的可见中心。
 * @returns 使用主进程随机 ID、按 24px 错位排列的素材节点。
 */
function createImportedAssetNodes(
  document: DesignCanvasDocument,
  assets: DesignAssetImportBatch,
  viewportCenter: DesignPoint,
): DesignCanvasNode[] {
  /** 新节点从权威文档当前最大层级之后依次排列。 */
  const firstZIndex = Math.max(-1, ...document.nodes.map((node) => node.zIndex)) + 1
  return assets.map((asset, index) => ({
    id: randomUUID(),
    kind: 'asset',
    assetId: asset.id,
    position: {
      x: viewportCenter.x + index * 24,
      y: viewportCenter.y + index * 24,
    },
    width: 320,
    height: 240,
    zIndex: firstZIndex + index,
  }))
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
    if (mutation.type === 'upsert-nodes' && mutation.nodes.some((node) => node.kind === 'job')) {
      throw new Error('不允许通过画布保存创建任务节点')
    }
    if (mutation.type === 'patch-nodes'
      && mutation.upserts.some((item) => item.entity.kind === 'job')) {
      throw new Error('不允许通过画布保存创建任务节点')
    }
  }
  return {
    projectId: value.projectId,
    expectedRevision: value.expectedRevision,
    mutations: value.mutations,
  }
}

/**
 * 基于写锁内权威文档保护 job 节点及其分组所有权。
 * @param document 当前磁盘权威画布文档。
 * @param mutations Renderer 已通过形状校验的 mutation。
 * @returns 校验通过时无返回值；越权时抛出稳定错误。
 */
function assertRendererPreservesJobOwnership(
  document: DesignCanvasDocument,
  mutations: DesignMutation[],
): void {
  /** 当前权威 job ID 是本次保存不可结构修改的受保护集合。 */
  const jobNodeIds = new Set(document.nodes
    .filter((node) => node.kind === 'job')
    .map((node) => node.id))
  /** 当前分组索引用于识别删除或替换含 job 的分组。 */
  const groupsById = new Map(document.groups.map((group) => [group.id, group]))
  /** 判断分组成员是否包含权威 job。 */
  const containsJob = (nodeIds: string[]): boolean => nodeIds.some((nodeId) => jobNodeIds.has(nodeId))
  /** 统一抛出任务节点所有权错误，避免暴露存储实现细节。 */
  const reject = (): never => {
    throw new Error('不允许通过画布保存修改任务节点结构')
  }

  for (const mutation of mutations) {
    switch (mutation.type) {
      case 'upsert-nodes':
        if (mutation.nodes.some((node) => jobNodeIds.has(node.id))) reject()
        break
      case 'remove-nodes':
        if (mutation.nodeIds.some((nodeId) => jobNodeIds.has(nodeId))) reject()
        break
      case 'patch-nodes':
        if (mutation.removeIds.some((nodeId) => jobNodeIds.has(nodeId))
          || mutation.upserts.some((item) => jobNodeIds.has(item.entity.id))) reject()
        break
      case 'upsert-groups':
        if (mutation.groups.some((group) => (
          containsJob(group.nodeIds) || containsJob(groupsById.get(group.id)?.nodeIds ?? [])
        ))) reject()
        break
      case 'remove-groups':
        if (mutation.groupIds.some((groupId) => containsJob(groupsById.get(groupId)?.nodeIds ?? []))) reject()
        break
      case 'patch-groups':
        if (mutation.removeIds.some((groupId) => containsJob(groupsById.get(groupId)?.nodeIds ?? []))
          || mutation.upserts.some((item) => (
            containsJob(item.entity.nodeIds)
            || containsJob(groupsById.get(item.entity.id)?.nodeIds ?? [])
          ))) reject()
        break
      default:
        break
    }
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

/** 校验 Renderer 创建任务输入，不接受绝对路径或额外字段。 */
function parseCreateJobInput(value: unknown): CreateDesignJobInput {
  if (!isRecord(value)
    || !hasOnlyKeys(value, [
      'projectId', 'action', 'prompt', 'sourceSessionId', 'sourceAssetId', 'maskAnnotationId', 'position',
    ])
    || !isNonEmptyString(value.projectId)
    || (value.action !== 'generate' && value.action !== 'edit')
    || !isNonEmptyString(value.prompt)
    || (value.sourceSessionId !== undefined && !isNonEmptyString(value.sourceSessionId))
    || (value.sourceAssetId !== undefined && !isNonEmptyString(value.sourceAssetId))
    || (value.maskAnnotationId !== undefined && !isNonEmptyString(value.maskAnnotationId))
    || !isPoint(value.position)) throw new Error('Design 请求结构无效')
  return {
    projectId: value.projectId,
    action: value.action,
    prompt: value.prompt,
    ...(value.sourceSessionId ? { sourceSessionId: value.sourceSessionId } : {}),
    ...(value.sourceAssetId ? { sourceAssetId: value.sourceAssetId } : {}),
    ...(value.maskAnnotationId ? { maskAnnotationId: value.maskAnnotationId } : {}),
    position: value.position,
  }
}

/** 校验取消和重试使用的项目任务 ID。 */
function parseJobControlInput(value: unknown): DesignJobControlInput {
  if (!isRecord(value)
    || !hasOnlyKeys(value, ['projectId', 'jobId'])
    || !isNonEmptyString(value.projectId)
    || !isNonEmptyString(value.jobId)) throw new Error('Design 请求结构无效')
  return { projectId: value.projectId, jobId: value.jobId }
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
export function registerDesignIpcHandlers(options: DesignIpcOptions): DesignIpcRegistration {
  activeRegistrations.get(options.ipc)?.()

  /** 每个窗口当前拥有的目录级媒体授权。 */
  const mediaAccessBySender = new Map<number, {
    sender: WebContents
    projectId: string
    assetBaseUrl: string
    thumbnailBaseUrl: string
    release: () => void
    onDestroyed: () => void
  }>()
  /** 进程内最后一次成功读取的快照，供项目临时离线时只读展示。 */
  const lastReadableSnapshots = new Map<string, DesignWorkspaceSnapshot>()
  /** 本任务实际注册的通道，供测试和未来增量注册使用。 */
  const channels = [
    DESIGN_IPC_CHANNELS.LOAD,
    DESIGN_IPC_CHANNELS.SAVE_MUTATIONS,
    DESIGN_IPC_CHANNELS.IMPORT_ASSETS,
    DESIGN_IPC_CHANNELS.DELETE_ASSET,
    DESIGN_IPC_CHANNELS.RELINK_ASSET,
    DESIGN_IPC_CHANNELS.EXPORT_ASSET,
    DESIGN_IPC_CHANNELS.CREATE_JOB,
    DESIGN_IPC_CHANNELS.CANCEL_JOB,
    DESIGN_IPC_CHANNELS.RETRY_JOB,
    DESIGN_IPC_CHANNELS.LIST_JOBS,
    DESIGN_IPC_CHANNELS.PREPARE_ASSET_FOR_SESSION,
    DESIGN_IPC_CHANNELS.IMPORT_AGENT_IMAGE,
    DESIGN_IPC_CHANNELS.RELEASE_MEDIA_ACCESS,
  ]
  for (const channel of channels) options.ipc.removeHandler(channel)

  /** 释放单个窗口的媒体授权与 destroyed 监听器。 */
  const releaseMediaAccess = (senderId: number): void => {
    const access = mediaAccessBySender.get(senderId)
    if (!access) return
    mediaAccessBySender.delete(senderId)
    access.sender.removeListener('destroyed', access.onDestroyed)
    access.release()
  }

  /** 为返回给指定窗口的快照补回当前项目媒体 URL。 */
  const attachMediaAccess = (
    sender: WebContents,
    projectId: string,
    snapshot: DesignWorkspaceSnapshot,
  ): DesignWorkspaceSnapshot => {
    const access = mediaAccessBySender.get(sender.id)
    if (!access || access.projectId !== projectId) return snapshot
    return {
      ...snapshot,
      assetBaseUrl: access.assetBaseUrl,
      thumbnailBaseUrl: access.thumbnailBaseUrl,
    }
  }

  /** 用最新 document 更新离线只读缓存，同时保留恢复来源等快照元数据。 */
  const rememberDocument = (projectId: string, document: DesignCanvasDocument): void => {
    const previous = lastReadableSnapshots.get(projectId)
    lastReadableSnapshots.set(projectId, {
      ...(previous ?? { writable: true }),
      document,
      writable: true,
    })
  }

  /** Manager 后台状态变化也通知 Renderer 刷新任务列表。 */
  const unsubscribeJobs = options.jobs.onChanged(({ job, revision }) => {
    broadcastChange(options, { projectId: job.projectId, revision, cause: 'job' })
  })

  options.ipc.handle(DESIGN_IPC_CHANNELS.LOAD, async (event, value): Promise<DesignWorkspaceSnapshot> => {
    const sender = assertAuthorizedSender(event, options.listAuthorizedWebContents())
    const input = parseProjectInput(value)
    releaseMediaAccess(sender.id)
    /** 离线或迁移状态必须在 store 解析路径、创建目录之前短路。 */
    const readOnlyReason = options.getProjectReadOnlyReason(input.projectId)
    if (readOnlyReason) {
      const cached = lastReadableSnapshots.get(input.projectId)
      return {
        document: cached?.document ?? createEmptyDesignDocument(input.projectId),
        writable: false,
        readOnlyReason,
      }
    }
    const snapshot = options.store.load(input.projectId)
    /** Store 已完成 tmp/backup 恢复后，同进程立即重试 terminal pending 对账。 */
    options.jobs.reconcilePendingTerminals(input.projectId)
    lastReadableSnapshots.set(input.projectId, snapshot)
    if (snapshot.recoveredFrom) {
      /** 恢复提升已经改变权威磁盘基线，通知其它已打开窗口同步接管该 revision。 */
      broadcastChange(options, {
        projectId: input.projectId,
        revision: snapshot.document.revision,
        cause: 'recovery',
      })
    }
    if (!snapshot.writable) return snapshot
    const access = options.assets.createMediaAccess(input.projectId)
    /** 窗口异常退出时沿用同一释放路径，避免 token 等待 TTL。 */
    const onDestroyed = (): void => releaseMediaAccess(sender.id)
    mediaAccessBySender.set(sender.id, {
      sender,
      projectId: input.projectId,
      assetBaseUrl: access.assetBaseUrl,
      thumbnailBaseUrl: access.thumbnailBaseUrl,
      release: access.release,
      onDestroyed,
    })
    sender.once('destroyed', onDestroyed)
    return { ...snapshot, assetBaseUrl: access.assetBaseUrl, thumbnailBaseUrl: access.thumbnailBaseUrl }
  })

  options.ipc.handle(DESIGN_IPC_CHANNELS.SAVE_MUTATIONS, async (event, value): Promise<DesignCanvasDocument> => {
    assertAuthorizedSender(event, options.listAuthorizedWebContents())
    const input = parseSaveInput(value)
    const document = await options.guard.runWorkspaceWrite(input.projectId, () => (
      options.store.mutate(
        input.projectId,
        input.expectedRevision,
        input.mutations,
        (currentDocument) => assertRendererPreservesJobOwnership(currentDocument, input.mutations),
      )
    ))
    rememberDocument(input.projectId, document)
    if (input.mutations.length > 0) {
      broadcastChange(options, { projectId: input.projectId, revision: document.revision, cause: 'canvas' })
    }
    return document
  })

  options.ipc.handle(DESIGN_IPC_CHANNELS.IMPORT_ASSETS, async (event, value): Promise<DesignWorkspaceSnapshot> => {
    const sender = assertAuthorizedSender(event, options.listAuthorizedWebContents())
    const input = parseImportAssetsInput(value)
    return options.guard.runWorkspaceWrite(input.projectId, async () => {
      /** 只有本次调用创建的批次允许在错误路径回滚。 */
      let importBatch: DesignAssetImportBatch | undefined
      try {
        /** 在打开选择器和创建 staging 前显式传播安全恢复，避免后续 load 消费标志。 */
        options.store.requireStableAuthoritativeDocument(input.projectId)
        const sourcePaths = await options.pickImageFiles(sender)
        if (sourcePaths.length === 0) {
          return attachMediaAccess(sender, input.projectId, options.store.load(input.projectId))
        }
        importBatch = await options.assets.importAuthorizedFiles(input.projectId, sourcePaths, { kind: 'picker' })
        const current = options.store.load(input.projectId)
        /** 素材与引用节点必须进入同一个 revision，避免进程退出留下孤立素材。 */
        const nodes = createImportedAssetNodes(current.document, importBatch, input.viewportCenter)
        const document = importBatch.length === 0
          ? current.document
          : options.store.mutate(input.projectId, input.expectedRevision, [
              { type: 'upsert-assets', assets: importBatch },
              { type: 'upsert-nodes', nodes },
            ])
        /** commit 内部仅清理本批次 journal，失败只告警，不把已提交 revision 反报失败。 */
        importBatch.commit()
        if (importBatch.length > 0) {
          broadcastChange(options, { projectId: input.projectId, revision: document.revision, cause: 'asset' })
        }
        const snapshot = { ...current, document }
        lastReadableSnapshots.set(input.projectId, snapshot)
        return attachMediaAccess(sender, input.projectId, snapshot)
      } catch (error) {
        /** rollback 会重新读取 canvas；若 JSON 实际已提交则保留文件并消费 journal。 */
        importBatch?.rollback()
        throw error
      }
    })
  })

  options.ipc.handle(DESIGN_IPC_CHANNELS.DELETE_ASSET, async (event, value): Promise<DesignCanvasDocument> => {
    assertAuthorizedSender(event, options.listAuthorizedWebContents())
    const input = parseAssetInput(value, true)
    const document = await options.guard.runWorkspaceWrite(input.projectId, () => (
      options.assets.deleteAsset(input.projectId, input.assetId, input.expectedRevision)
    ))
    rememberDocument(input.projectId, document)
    broadcastChange(options, { projectId: input.projectId, revision: document.revision, cause: 'asset' })
    return document
  })

  options.ipc.handle(DESIGN_IPC_CHANNELS.RELINK_ASSET, async (event, value): Promise<DesignCanvasDocument> => {
    const sender = assertAuthorizedSender(event, options.listAuthorizedWebContents())
    const input = parseAssetInput(value, true)
    return options.guard.runWorkspaceWrite(input.projectId, async () => {
      /** 恢复提升必须在打开重新定位选择器前交回 Renderer 确认。 */
      options.store.requireStableAuthoritativeDocument(input.projectId)
      const sourcePath = await options.pickRelinkImageFile(sender)
      if (!sourcePath) return options.store.load(input.projectId).document
      const document = await options.assets.relinkAsset(
        input.projectId,
        input.assetId,
        sourcePath,
        input.expectedRevision,
      )
      rememberDocument(input.projectId, document)
      broadcastChange(options, { projectId: input.projectId, revision: document.revision, cause: 'asset' })
      return document
    })
  })

  options.ipc.handle(DESIGN_IPC_CHANNELS.EXPORT_ASSET, async (event, value): Promise<void> => {
    const sender = assertAuthorizedSender(event, options.listAuthorizedWebContents())
    const input = parseAssetInput(value, false)
    /** 导出路径选择前先确认素材来自稳定权威文档。 */
    const document = options.store.requireStableAuthoritativeDocument(input.projectId)
    const asset = document.assets.find((item) => item.id === input.assetId)
    if (!asset) throw new Error(`素材不存在: ${input.assetId}`)
    const targetPath = await options.pickExportPath(sender, asset.filename)
    if (targetPath) await options.assets.exportAsset(input.projectId, input.assetId, targetPath)
  })

  options.ipc.handle(DESIGN_IPC_CHANNELS.CREATE_JOB, async (event, value): Promise<DesignJobRecord> => {
    assertAuthorizedSender(event, options.listAuthorizedWebContents())
    const input = parseCreateJobInput(value)
    const job = await options.guard.runWorkspaceWrite(input.projectId, () => options.jobs.create(input))
    /** invoke 只返回 queued；后台运行错误由 journal 终态承接。 */
    void options.jobs.run(job.id).catch((error) => console.error('[Design Job] 后台运行失败:', error))
    return job
  })

  options.ipc.handle(DESIGN_IPC_CHANNELS.CANCEL_JOB, async (event, value): Promise<DesignJobRecord> => {
    assertAuthorizedSender(event, options.listAuthorizedWebContents())
    const input = parseJobControlInput(value)
    return options.guard.runWorkspaceWrite(input.projectId, () => options.jobs.cancel(input.projectId, input.jobId))
  })

  options.ipc.handle(DESIGN_IPC_CHANNELS.RETRY_JOB, async (event, value): Promise<DesignJobRecord> => {
    assertAuthorizedSender(event, options.listAuthorizedWebContents())
    const input = parseJobControlInput(value)
    const job = await options.guard.runWorkspaceWrite(
      input.projectId,
      () => options.jobs.retry(input.projectId, input.jobId),
    )
    void options.jobs.run(job.id).catch((error) => console.error('[Design Job] 后台重试失败:', error))
    return job
  })

  options.ipc.handle(DESIGN_IPC_CHANNELS.LIST_JOBS, async (event, value): Promise<DesignJobRecord[]> => {
    assertAuthorizedSender(event, options.listAuthorizedWebContents())
    const input = parseProjectInput(value)
    return options.jobs.list(input.projectId)
  })

  options.ipc.handle(DESIGN_IPC_CHANNELS.PREPARE_ASSET_FOR_SESSION, async (event, value): Promise<PreparedDesignAssetMention> => {
    assertAuthorizedSender(event, options.listAuthorizedWebContents())
    const input = parsePrepareAssetForSessionInput(value)
    return options.sessionBridge.prepareAssetForSession(input)
  })

  options.ipc.handle(DESIGN_IPC_CHANNELS.IMPORT_AGENT_IMAGE, async (event, value): Promise<DesignWorkspaceSnapshot> => {
    const sender = assertAuthorizedSender(event, options.listAuthorizedWebContents())
    const input = parseImportAgentImageInput(value)
    const snapshot = await options.guard.runWorkspaceWrite(
      input.projectId,
      () => options.sessionBridge.importAgentImage(input),
    )
    rememberDocument(input.projectId, snapshot.document)
    broadcastChange(options, {
      projectId: input.projectId,
      revision: snapshot.document.revision,
      cause: 'asset',
    })
    return attachMediaAccess(sender, input.projectId, snapshot)
  })

  options.ipc.handle(DESIGN_IPC_CHANNELS.RELEASE_MEDIA_ACCESS, async (event, value): Promise<void> => {
    const sender = assertAuthorizedSender(event, options.listAuthorizedWebContents())
    if (value !== undefined) throw new Error('Design 请求结构无效')
    releaseMediaAccess(sender.id)
  })

  /** 幂等释放当前注册拥有的全部资源。 */
  let disposed = false
  const dispose = (): void => {
    if (disposed) return
    disposed = true
    unsubscribeJobs()
    for (const senderId of [...mediaAccessBySender.keys()]) releaseMediaAccess(senderId)
    for (const channel of channels) options.ipc.removeHandler(channel)
    if (activeRegistrations.get(options.ipc) === dispose) activeRegistrations.delete(options.ipc)
  }
  activeRegistrations.set(options.ipc, dispose)
  return { channels, dispose }
}
