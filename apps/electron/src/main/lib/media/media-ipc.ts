import type { IpcMainInvokeEvent, WebContents } from 'electron'
import { MEDIA_IPC_CHANNELS } from '@proma/shared'
import type { ComfyObjectInfo, MediaAssetRecord, MediaAssetRef, MediaKind, MediaConfiguration, MediaRemoteDescriptor, MediaRemoteWorkflow, MediaResourceQuery, MediaRunEvent, MediaRunSnapshot, MediaSettingsSnapshot } from '@proma/shared'
import type { MediaConfigStore } from './media-config-store'
import type { MediaResourceService } from './media-resource-service'
import { detectMediaFileSignature } from './media-file-probe'
import { analyzeRemoteWorkflow, getRemoteWorkflowClassTypes } from './media-remote-workflow-analysis'

/** 媒体管理 IPC 的可注入授权与服务边界。 */
export interface MediaIpcOptions {
  ipc: { handle(channel: string, handler: (event: IpcMainInvokeEvent, input?: unknown) => unknown): void; removeHandler(channel: string): void }
  isAuthorizedSender(event: IpcMainInvokeEvent): boolean
  assertProject(projectId: string): void
  configuration: Pick<MediaConfigStore, 'read' | 'saveConnection' | 'saveWorkflow' | 'saveProfile'> & Partial<Pick<MediaConfigStore, 'archive' | 'saveAuthorizationMode'>>
  resources: Pick<MediaResourceService, 'probe' | 'list'>
    & { readWorkflow?: (descriptor: MediaRemoteDescriptor) => Promise<MediaRemoteWorkflow> }
    & { getSchema?: (connectionId: string, projectId: string, classTypes: string[]) => Promise<ComfyObjectInfo> }
    & Partial<Pick<MediaResourceService, 'readRemoteAsset'>>
  /** 主进程保留原始异常用于排障，调用方不得把认证对象放入 message。 */
  onBackgroundError?(message: string, error: unknown): void
  importLocalAsset?(event: IpcMainInvokeEvent, projectId: string, kind: MediaKind): Promise<MediaAssetRecord | null>
  listAssets?(projectId: string): Promise<MediaAssetRecord[]>
  readAssetThumbnail?(projectId: string, asset: MediaAssetRef): Promise<{ bytes: Uint8Array; contentType: string }>
  getRun(projectId: string, runId: string): MediaRunSnapshot
  getJobRun?(projectId: string, jobId: string): MediaRunSnapshot | null
}

/** 只接受声明字段的普通调用参数。 */
function inputRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.keys(value).every((key) => keys.includes(key))) throw new Error('MEDIA_IPC_INPUT_INVALID')
  return value as Record<string, unknown>
}

/** IPC ID 在调用项目解析器之前校验，拒绝路径穿越。 */
function inputId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value)) throw new Error('MEDIA_IPC_INPUT_INVALID')
  return value
}

/** 严格解析 Renderer 提供的四字段图片引用，拒绝额外路径或媒体类型。 */
function inputImageAssetRef(value: unknown): MediaAssetRef {
  const asset = inputRecord(value, ['assetId', 'revision', 'hash', 'mediaKind'])
  if (asset.mediaKind !== 'image'
    || !Number.isSafeInteger(asset.revision) || Number(asset.revision) <= 0
    || typeof asset.hash !== 'string' || !/^[a-f0-9]{64}$/.test(asset.hash)) throw new Error('MEDIA_IPC_INPUT_INVALID')
  return { assetId: inputId(asset.assetId), revision: Number(asset.revision), hash: asset.hash, mediaKind: 'image' }
}

/** 管理页可以编辑授权范围，但永远不取得密文引用。 */
export function mediaSettingsSnapshot(configuration: MediaConfiguration): MediaSettingsSnapshot {
  const { connectionHistory: _history, ...publicConfiguration } = configuration
  return { ...publicConfiguration, authorizationMode: configuration.authorizationMode ?? 'ask',
    workflows: configuration.workflows.filter((workflow) => !configuration.archivedWorkflowIds?.includes(workflow.id)),
    connections: configuration.connections.filter((connection) => connection.archivedAt === undefined).map((connection) => {
    const { credentialRef, projectIds: _legacyScope, ...publicConnection } = connection
    return { ...publicConnection, credentialConfigured: !!credentialRef }
  }) }
}

/** 注册管理与查询通道；Canvas 生成继续通过现有授权任务入口接入。 */
export function registerMediaIpcHandlers(options: MediaIpcOptions): { dispose(): void; publishRun(event: MediaRunEvent): void } {
  const channels: string[] = []
  /** 订阅引用计数按窗口及项目隔离，同窗口多画布不会互相退订。 */
  const subscriptions = new Map<WebContents, Map<string, number>>()
  const cleanupListeners = new Map<WebContents, () => void>()
  const subscriptionEvents = new Map<WebContents, IpcMainInvokeEvent>()
  /** 释放指定窗口的全部引用与监听，不依赖项目仍然存在。 */
  const releaseSender = (sender: WebContents): void => {
    subscriptions.delete(sender)
    const cleanup = cleanupListeners.get(sender)
    if (cleanup) sender.removeListener('destroyed', cleanup)
    cleanupListeners.delete(sender)
    subscriptionEvents.delete(sender)
  }
  const handle = (channel: string, operation: (value: unknown, event: IpcMainInvokeEvent) => unknown): void => {
    options.ipc.handle(channel, (event, value) => {
      if (!options.isAuthorizedSender(event)) throw new Error('MEDIA_ACCESS_DENIED')
      return operation(value, event)
    })
    channels.push(channel)
  }
  handle(MEDIA_IPC_CHANNELS.GET_SETTINGS, () => mediaSettingsSnapshot(options.configuration.read()))
  handle(MEDIA_IPC_CHANNELS.SAVE_AUTHORIZATION, (value) => {
    const envelope = inputRecord(value, ['mode', 'expectedRevision'])
    if ((envelope.mode !== 'ask' && envelope.mode !== 'automatic')
      || !Number.isSafeInteger(envelope.expectedRevision) || Number(envelope.expectedRevision) < 0) throw new Error('MEDIA_IPC_INPUT_INVALID')
    if (!options.configuration.saveAuthorizationMode) throw new Error('MEDIA_CONFIGURATION_UNAVAILABLE')
    return mediaSettingsSnapshot(options.configuration.saveAuthorizationMode(envelope.mode, Number(envelope.expectedRevision)))
  })
  for (const [channel, method] of [
    [MEDIA_IPC_CHANNELS.SAVE_CONNECTION, 'saveConnection'], [MEDIA_IPC_CHANNELS.SAVE_WORKFLOW, 'saveWorkflow'], [MEDIA_IPC_CHANNELS.SAVE_PROFILE, 'saveProfile'],
  ] as const) {
    handle(channel, (value) => {
      const envelope = inputRecord(value, ['input', 'expectedRevision'])
      if (!Number.isSafeInteger(envelope.expectedRevision) || Number(envelope.expectedRevision) < 0) throw new Error('MEDIA_IPC_INPUT_INVALID')
      const input = inputRecord(envelope.input, method === 'saveConnection'
        ? ['id', 'name', 'driver', 'baseUrl', 'enabled', 'projectIds', 'comfyUser', 'auth', 'credential']
        : method === 'saveWorkflow' ? ['id', 'name', 'projectId', 'definition'] : ['id', 'name', 'connectionId', 'workflowId', 'workflowRevision', 'mediaKind', 'projectId', 'enabled'])
      if (method === 'saveProfile' || (method === 'saveWorkflow' && input.projectId !== null && input.projectId !== undefined)) options.assertProject(inputId(input.projectId))
      return mediaSettingsSnapshot(options.configuration[method](input, Number(envelope.expectedRevision)))
    })
  }
  handle(MEDIA_IPC_CHANNELS.ARCHIVE_CONFIGURATION, (value) => {
    const envelope = inputRecord(value, ['input', 'expectedRevision'])
    const input = inputRecord(envelope.input, ['kind', 'id'])
    if (!Number.isSafeInteger(envelope.expectedRevision) || Number(envelope.expectedRevision) < 0
      || (input.kind !== 'workflow' && input.kind !== 'connection')) throw new Error('MEDIA_IPC_INPUT_INVALID')
    if (!options.configuration.archive) throw new Error('MEDIA_CONFIGURATION_UNAVAILABLE')
    return mediaSettingsSnapshot(options.configuration.archive({ kind: input.kind, id: inputId(input.id) }, Number(envelope.expectedRevision)))
  })
  handle(MEDIA_IPC_CHANNELS.READ_REMOTE_WORKFLOW, async (value) => {
    if (!options.resources.readWorkflow || !options.resources.getSchema) throw new Error('MEDIA_RESOURCE_UNSUPPORTED')
    const descriptor = inputRecord(value, ['connectionId', 'instanceGeneration', 'remoteUser', 'source', 'id', 'workflowPath', 'assetId', 'filename', 'subfolder', 'type', 'loaderPath', 'contentHash'])
    /** 只记录稳定资源身份，不把 descriptor 中潜在的用户字段或认证上下文写入日志。 */
    const safeDescriptor = descriptor as unknown as MediaRemoteDescriptor
    try {
      const workflow = await options.resources.readWorkflow(safeDescriptor)
      const classTypes = getRemoteWorkflowClassTypes(workflow)
      try {
        const schema = classTypes.length > 0
          ? await options.resources.getSchema(safeDescriptor.connectionId, '', classTypes)
          : {}
        return { ...workflow, analysis: analyzeRemoteWorkflow(workflow, schema) }
      } catch (schemaError) {
        // 正文已读取成功，节点接口故障不能同时阻止用户查看和复制原始工作流。
        options.onBackgroundError?.('[媒体工作流] 节点接口暂不可用', schemaError)
        return { ...workflow, analysis: {
          format: workflow.format, convertible: false, definition: null, nodes: [], inputs: [], outputs: [],
          issues: [{ code: 'REMOTE_WORKFLOW_SCHEMA_UNAVAILABLE', message: '无法读取服务器节点信息，暂不能完成兼容性分析；请同步工作节点后重新打开详情。' }],
        } }
      }
    } catch (caughtError) {
      options.onBackgroundError?.(`[媒体工作流] 详情分析失败 id=${safeDescriptor.id} source=${safeDescriptor.source}`, caughtError)
      throw new Error('MEDIA_REMOTE_WORKFLOW_READ_FAILED')
    }
  })
  handle(MEDIA_IPC_CHANNELS.READ_REMOTE_ASSET, async (value, event) => {
    if (!options.resources.readRemoteAsset) throw new Error('MEDIA_RESOURCE_UNSUPPORTED')
    const descriptor = inputRecord(value, ['connectionId', 'instanceGeneration', 'remoteUser', 'source', 'id', 'workflowPath', 'assetId', 'filename', 'subfolder', 'type', 'loaderPath', 'contentHash'])
    const result = await options.resources.readRemoteAsset(descriptor as unknown as MediaRemoteDescriptor, '', 16 * 1024 * 1024)
    if (!options.isAuthorizedSender(event)) throw new Error('MEDIA_ACCESS_DENIED')
    const signature = detectMediaFileSignature(result.bytes)
    return { bytes: result.bytes, contentType: signature.mediaType }
  })
  handle(MEDIA_IPC_CHANNELS.IMPORT_LOCAL_ASSET, async (value, event) => {
    const input = inputRecord(value, ['projectId', 'mediaKind'])
    const projectId = inputId(input.projectId)
    if (input.mediaKind !== 'image' && input.mediaKind !== 'audio' && input.mediaKind !== 'video') throw new Error('MEDIA_IPC_INPUT_INVALID')
    options.assertProject(projectId)
    if (!options.importLocalAsset) throw new Error('MEDIA_IMPORT_UNAVAILABLE')
    return options.importLocalAsset(event, projectId, input.mediaKind)
  })
  handle(MEDIA_IPC_CHANNELS.LIST_ASSETS, async (value, event) => {
    const input = inputRecord(value, ['projectId'])
    const projectId = inputId(input.projectId)
    options.assertProject(projectId)
    if (!options.listAssets) throw new Error('MEDIA_ASSETS_UNAVAILABLE')
    const assets = await options.listAssets(projectId)
    if (!options.isAuthorizedSender(event)) throw new Error('MEDIA_ACCESS_DENIED')
    options.assertProject(projectId)
    return assets
  })
  handle(MEDIA_IPC_CHANNELS.READ_ASSET_THUMBNAIL, async (value, event) => {
    const input = inputRecord(value, ['projectId', 'asset'])
    const projectId = inputId(input.projectId)
    const asset = inputImageAssetRef(input.asset)
    options.assertProject(projectId)
    if (!options.readAssetThumbnail) throw new Error('MEDIA_ASSETS_UNAVAILABLE')
    const thumbnail = await options.readAssetThumbnail(projectId, asset)
    /** 异步磁盘读取结束后 fresh-check，撤权窗口不能收到已读入内存的内容。 */
    if (!options.isAuthorizedSender(event)) throw new Error('MEDIA_ACCESS_DENIED')
    options.assertProject(projectId)
    return thumbnail
  })
  handle(MEDIA_IPC_CHANNELS.PROBE_CONNECTION, (value) => {
    const input = inputRecord(value, ['connectionId', 'projectId'])
    const projectId = input.projectId === undefined ? '' : inputId(input.projectId)
    return options.resources.probe(inputId(input.connectionId), projectId)
  })
  handle(MEDIA_IPC_CHANNELS.LIST_RESOURCES, (value) => {
    const input = inputRecord(value, ['connectionId', 'projectId', 'kind', 'query', 'folder', 'offset', 'limit', 'refresh'])
    const projectId = input.projectId === undefined ? '' : inputId(input.projectId)
    if (!['nodes', 'models', 'workflows', 'assets'].includes(String(input.kind)) || (input.folder !== undefined && (typeof input.folder !== 'string' || input.folder.length > 256))
      || (input.refresh !== undefined && typeof input.refresh !== 'boolean')) throw new Error('MEDIA_IPC_INPUT_INVALID')
    return options.resources.list({ ...input, connectionId: inputId(input.connectionId), projectId } as unknown as MediaResourceQuery)
  })
  handle(MEDIA_IPC_CHANNELS.GET_RUN, (value) => {
    const input = inputRecord(value, ['projectId', 'runId'])
    const projectId = inputId(input.projectId)
    options.assertProject(projectId)
    return options.getRun(projectId, inputId(input.runId))
  })
  handle(MEDIA_IPC_CHANNELS.GET_JOB_RUN, (value) => {
    const input = inputRecord(value, ['projectId', 'jobId'])
    const projectId = inputId(input.projectId)
    options.assertProject(projectId)
    return options.getJobRun?.(projectId, inputId(input.jobId)) ?? null
  })
  for (const channel of [MEDIA_IPC_CHANNELS.WATCH_PROJECT, MEDIA_IPC_CHANNELS.UNWATCH_PROJECT]) {
    handle(channel, (value, event) => {
      const input = inputRecord(value, ['projectId'])
      const projectId = inputId(input.projectId)
      if (channel === MEDIA_IPC_CHANNELS.WATCH_PROJECT) options.assertProject(projectId)
      const counts = subscriptions.get(event.sender) ?? new Map<string, number>()
      const count = (counts.get(projectId) ?? 0) + (channel === MEDIA_IPC_CHANNELS.WATCH_PROJECT ? 1 : -1)
      if (count > 64 || (channel === MEDIA_IPC_CHANNELS.WATCH_PROJECT && !counts.has(projectId) && counts.size >= 32)) throw new Error('MEDIA_SUBSCRIPTION_LIMIT')
      if (count > 0) counts.set(projectId, count)
      else counts.delete(projectId)
      if (counts.size > 0) {
        subscriptions.set(event.sender, counts)
        subscriptionEvents.set(event.sender, event)
        if (!cleanupListeners.has(event.sender)) {
          const cleanup = (): void => { releaseSender(event.sender) }
          cleanupListeners.set(event.sender, cleanup)
          event.sender.once('destroyed', cleanup)
        }
      } else {
        releaseSender(event.sender)
      }
    })
  }
  return {
    publishRun: (event) => {
      for (const [sender, projects] of subscriptions) {
        try {
          const authorization = subscriptionEvents.get(sender)
          if (sender.isDestroyed() || !authorization || !options.isAuthorizedSender(authorization)) {
            releaseSender(sender)
            continue
          }
        } catch {
          releaseSender(sender)
          continue
        }
        if (!projects.has(event.run.projectId)) continue
        try {
          options.assertProject(event.run.projectId)
        } catch {
          // 失效项目一次清除全部引用，其它仍获授权的项目继续接收进度。
          projects.delete(event.run.projectId)
          if (projects.size === 0) releaseSender(sender)
          continue
        }
        try {
          sender.send(MEDIA_IPC_CHANNELS.RUN_CHANGED, event)
        } catch { releaseSender(sender) }
      }
    },
    dispose: () => {
      for (const channel of channels) options.ipc.removeHandler(channel)
      for (const [sender, cleanup] of cleanupListeners) sender.removeListener('destroyed', cleanup)
      subscriptions.clear()
      cleanupListeners.clear()
      subscriptionEvents.clear()
    },
  }
}
