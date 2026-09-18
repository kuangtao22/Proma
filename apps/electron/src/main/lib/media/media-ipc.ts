import type { IpcMainInvokeEvent, WebContents } from 'electron'
import {
  AUDIO_GENERATION_CATALOG_SCHEMA_VERSION,
  AUDIO_GENERATION_LEGACY_WARNING,
  IMAGE_PROVIDER_IDENTIFIER_MAX_LENGTH,
  MEDIA_IPC_CHANNELS,
  parseImageGenerationCatalogFetchInput,
  parseImageGenerationCatalogFetchResult,
  parseImageGenerationSettingsResult,
  parseReplaceImageGenerationCatalogRequest,
  parseAudioGenerationCatalogFetchInput,
  parseAudioGenerationCatalogFetchResult,
  parseAudioGenerationSettingsResult,
  parseAudioGenerationTestCancelInput,
  parseAudioGenerationTestInput,
  parseAudioGenerationTestResult,
  parseReplaceAudioGenerationCatalogRequest,
} from '@proma/shared'
import type {
  AudioGenerationCatalogFetchInput,
  AudioGenerationCatalogFetchResult,
  AudioGenerationPublicCatalog,
  AudioGenerationSettingsResult,
  AudioGenerationTestInput,
  AudioGenerationTestResult,
  ComfyObjectInfo,
  MediaApiModelCatalogResult,
  MediaAssetRecord,
  MediaAssetRef,
  MediaKind,
  MediaConfiguration,
  MediaRemoteDescriptor,
  MediaRemoteWorkflow,
  MediaResourceQuery,
  MediaRunEvent,
  MediaRunSnapshot,
  MediaSettingsSnapshot,
  ReplaceAudioGenerationCatalogRequest,
} from '@proma/shared'
import type { AudioGenerationConfigStore } from './audio-generation-config-store'
import type { AudioGenerationTestService } from './audio-generation-test-service'
import type { AudioGenerationCatalogService } from './audio-generation-catalog-service'
import type { ImageGenerationIpcService } from './image-generation-ipc'
import { throwStableImageError } from './image-generation-ipc'
import type { MediaConfigStore } from './media-config-store'
import type { MediaResourceService } from './media-resource-service'
import { detectMediaFileSignature } from './media-file-probe'
import { analyzeRemoteWorkflow, getRemoteWorkflowClassTypes } from './media-remote-workflow-analysis'

/** 音频生成 IPC 使用的最小服务合同，主进程装配和测试均可注入。 */
export interface AudioGenerationIpcService {
  /** 返回独立目录与只读旧配置摘要。 */
  listSettings(): AudioGenerationSettingsResult
  /** 完整替换独立目录并返回最新组合设置。 */
  replace(input: ReplaceAudioGenerationCatalogRequest): AudioGenerationSettingsResult
  /** 按渲染窗口隔离运行连接测试。 */
  test(ownerId: number, input: AudioGenerationTestInput): Promise<AudioGenerationTestResult>
  /** 用已保存或本次草稿凭据从供应商拉取可用模型与音色。 */
  fetchCatalog(input: AudioGenerationCatalogFetchInput): Promise<AudioGenerationCatalogFetchResult>
  /** 幂等取消当前窗口的指定测试。 */
  cancel(ownerId: number, requestId: string): void
  /** 窗口销毁时释放其全部测试资源。 */
  releaseOwner(ownerId: number): void
  /** IPC 整体卸载时释放未完成 timer；自定义服务可省略。 */
  dispose?(): void
}

/** 音频 IPC 服务工厂的显式依赖，不让 Renderer 接触凭据存储。 */
export interface AudioGenerationIpcServiceOptions {
  store: Pick<AudioGenerationConfigStore, 'readPublic' | 'replace'>
  tests: Pick<AudioGenerationTestService, 'test' | 'cancel' | 'releaseOwner'>
    & Partial<Pick<AudioGenerationTestService, 'dispose'>>
  catalog: Pick<AudioGenerationCatalogService, 'fetch'>
  listLegacyCatalog(): MediaApiModelCatalogResult
}

/** 可原样跨 IPC 保留的音频配置稳定错误码。 */
const AUDIO_GENERATION_STABLE_ERROR_CODES = new Set([
  'AUDIO_GENERATION_CONFIG_CONFLICT',
  'AUDIO_GENERATION_CONFIG_INVALID',
  'AUDIO_GENERATION_CONFIG_OUTCOME_UNKNOWN',
  'AUDIO_GENERATION_CONFIG_READ_FAILED',
  'AUDIO_GENERATION_CONFIG_SIZE_LIMIT',
  'AUDIO_GENERATION_CONFIG_WRITE_FAILED',
  'AUDIO_GENERATION_CREDENTIAL_DECRYPT_FAILED',
  'AUDIO_GENERATION_CREDENTIAL_ENCRYPT_FAILED',
  'AUDIO_GENERATION_CREDENTIAL_PRESERVE_INVALID',
  'AUDIO_GENERATION_PROFILE_NOT_FOUND',
  'AUDIO_GENERATION_SECURE_STORAGE_UNAVAILABLE',
  'AUDIO_GENERATION_LEGACY_REFERENCE_INVALID',
  'AUDIO_GENERATION_TEST_CANCEL_FAILED',
  'AUDIO_GENERATION_TEST_FAILED',
  'AUDIO_GENERATION_CATALOG_FAILED',
])

/** 只保留已知稳定码，未知底层异常统一替换，避免路径、Key 或上游正文泄漏。 */
function throwStableAudioError(error: unknown, fallbackCode: string): never {
  if (error instanceof Error && AUDIO_GENERATION_STABLE_ERROR_CODES.has(error.message)) {
    throw new Error(error.message)
  }
  throw new Error(fallbackCode)
}

/** 严格读取独立目录；未知文件和系统异常只公开固定错误码。 */
function readAudioCatalog(store: AudioGenerationIpcServiceOptions['store']): AudioGenerationPublicCatalog {
  try {
    return store.readPublic()
  } catch (error) {
    throwStableAudioError(error, 'AUDIO_GENERATION_CONFIG_READ_FAILED')
  }
}

/** 从旧统一目录只读投影 MiniMax Speech，任何歧义均降级为固定迁移警告。 */
function readLegacyAudioProfiles(listLegacyCatalog: () => MediaApiModelCatalogResult): Pick<AudioGenerationSettingsResult, 'legacyAudioProfiles' | 'legacyWarning'> {
  try {
    /** 本次快照只用于投影，不修改、删除或回写旧目录条目。 */
    const catalog = listLegacyCatalog()
    /** Shared 结果 parser 复核字段、ID 与重复项。 */
    const parsed = parseAudioGenerationSettingsResult({
      catalog: { schemaVersion: AUDIO_GENERATION_CATALOG_SCHEMA_VERSION, revision: 0, profiles: [] },
      legacyAudioProfiles: catalog.entries
        .filter((entry) => entry.profile.protocol === 'minimax-speech')
        .map((entry) => ({
          id: entry.profile.id,
          name: entry.profile.name,
          protocol: 'minimax-speech' as const,
          modelId: entry.profile.modelId,
          enabled: entry.profile.enabled,
        })),
    })
    return { legacyAudioProfiles: parsed.legacyAudioProfiles }
  } catch {
    return { legacyAudioProfiles: [], legacyWarning: AUDIO_GENERATION_LEGACY_WARNING }
  }
}

/** 把独立目录与旧摘要组成严格公开结果。 */
function createAudioSettingsResult(
  catalog: AudioGenerationPublicCatalog,
  legacy: Pick<AudioGenerationSettingsResult, 'legacyAudioProfiles' | 'legacyWarning'>,
): AudioGenerationSettingsResult {
  return parseAudioGenerationSettingsResult({ ...legacy, catalog })
}

/** 创建独立音频目录、旧配置迁移校验和测试生命周期的统一服务。 */
export function createAudioGenerationIpcService(options: AudioGenerationIpcServiceOptions): AudioGenerationIpcService {
  return {
    listSettings: () => {
      /** 独立目录失败必须直接失败，不能被旧目录 warning 掩盖。 */
      const catalog = readAudioCatalog(options.store)
      return createAudioSettingsResult(catalog, readLegacyAudioProfiles(options.listLegacyCatalog))
    },
    replace: (input) => {
      /** 在读取旧目录或写 Store 前执行 Shared 严格解析。 */
      const request = parseReplaceAudioGenerationCatalogRequest(input)
      /** 当前独立目录用于识别本次新引入或改变的旧目录引用。 */
      const current = readAudioCatalog(options.store)
      const currentById = new Map(current.profiles.map((profile) => [profile.id, profile]))
      /** 只有新增或变化的引用必须重新取得旧目录事实。 */
      const introducedLegacyIds = new Set(request.profiles.flatMap(({ profile }) => {
        if (profile.legacyMediaProfileId === undefined
          || currentById.get(profile.id)?.legacyMediaProfileId === profile.legacyMediaProfileId) return []
        return [profile.legacyMediaProfileId]
      }))
      /** 新引用在写前 fail closed；旧目录失败不能绕过协议与存在性校验。 */
      let legacy = introducedLegacyIds.size > 0
        ? readLegacyAudioProfiles(options.listLegacyCatalog)
        : undefined
      if (introducedLegacyIds.size > 0) {
        if (legacy?.legacyWarning
          || [...introducedLegacyIds].some((id) => !legacy?.legacyAudioProfiles.some((profile) => profile.id === id))) {
          throw new Error('AUDIO_GENERATION_LEGACY_REFERENCE_INVALID')
        }
      }
      /** Store 再次 strict parse 并执行 CAS；结果未知错误必须保持原码。 */
      let catalog: AudioGenerationPublicCatalog
      try {
        catalog = options.store.replace(request)
      } catch (error) {
        throwStableAudioError(error, 'AUDIO_GENERATION_CONFIG_WRITE_FAILED')
      }
      legacy ??= readLegacyAudioProfiles(options.listLegacyCatalog)
      return createAudioSettingsResult(catalog, legacy)
    },
    fetchCatalog: (input) => options.catalog.fetch(input),
    test: (ownerId, input) => options.tests.test(ownerId, input),
    cancel: (ownerId, requestId) => { options.tests.cancel(ownerId, requestId) },
    releaseOwner: (ownerId) => { options.tests.releaseOwner(ownerId) },
    dispose: () => { options.tests.dispose?.() },
  }
}

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
  audioGeneration: AudioGenerationIpcService
  imageGeneration: ImageGenerationIpcService
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
  /** 音频测试按 sender 只登记一次销毁监听，独立于项目运行订阅。 */
  const audioCleanupListeners = new Map<WebContents, () => void>()
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
  /** GET 通道不接受业务参数，阻止 Renderer 私自扩展调用合同。 */
  const assertNoInput = (value: unknown): void => {
    if (value !== undefined) throw new Error('AUDIO_GENERATION_CONFIG_INVALID')
  }
  /**
   * 单条生图配置 ID 的调用合同：只接受 { profileId }。
   * 长度沿用 Shared 的上限，避免 Renderer 传入超长或非字符串标识。
   */
  const readImageProfileId = (value: unknown): string => {
    if (typeof value !== 'object' || value === null) throw new Error('IMAGE_GENERATION_CONFIG_INVALID')
    const profileId = (value as { profileId?: unknown }).profileId
    if (typeof profileId !== 'string' || !profileId.trim() || profileId.length > IMAGE_PROVIDER_IDENTIFIER_MAX_LENGTH) {
      throw new Error('IMAGE_GENERATION_CONFIG_INVALID')
    }
    return profileId.trim()
  }
  /** 首次测试为 sender 建立 owner 清理；后续测试复用同一监听。 */
  const registerAudioOwner = (event: IpcMainInvokeEvent): void => {
    if (audioCleanupListeners.has(event.sender)) return
    /** 窗口销毁只释放自身 owner，不影响其它设置窗口。 */
    const cleanup = (): void => {
      options.audioGeneration.releaseOwner(event.sender.id)
      event.sender.removeListener('destroyed', cleanup)
      audioCleanupListeners.delete(event.sender)
    }
    audioCleanupListeners.set(event.sender, cleanup)
    event.sender.once('destroyed', cleanup)
  }
  handle(MEDIA_IPC_CHANNELS.GET_SETTINGS, () => mediaSettingsSnapshot(options.configuration.read()))
  handle(MEDIA_IPC_CHANNELS.GET_AUDIO_GENERATION_SETTINGS, (value) => {
    assertNoInput(value)
    try {
      return parseAudioGenerationSettingsResult(options.audioGeneration.listSettings())
    } catch (error) {
      throwStableAudioError(error, 'AUDIO_GENERATION_CONFIG_READ_FAILED')
    }
  })
  handle(MEDIA_IPC_CHANNELS.REPLACE_AUDIO_GENERATION_CATALOG, (value) => {
    const input = parseReplaceAudioGenerationCatalogRequest(value)
    try {
      return parseAudioGenerationSettingsResult(options.audioGeneration.replace(input))
    } catch (error) {
      throwStableAudioError(error, 'AUDIO_GENERATION_CONFIG_WRITE_FAILED')
    }
  })
  handle(MEDIA_IPC_CHANNELS.GET_IMAGE_GENERATION_SETTINGS, (value) => {
    assertNoInput(value)
    try {
      return parseImageGenerationSettingsResult(options.imageGeneration.listSettings())
    } catch (error) {
      throwStableImageError(error, 'IMAGE_GENERATION_CONFIG_READ_FAILED')
    }
  })
  handle(MEDIA_IPC_CHANNELS.REPLACE_IMAGE_GENERATION_CATALOG, (value) => {
    const input = parseReplaceImageGenerationCatalogRequest(value)
    try {
      return parseImageGenerationSettingsResult(options.imageGeneration.replace(input))
    } catch (error) {
      throwStableImageError(error, 'IMAGE_GENERATION_CONFIG_WRITE_FAILED')
    }
  })
  handle(MEDIA_IPC_CHANNELS.FETCH_IMAGE_GENERATION_CATALOG, async (value, event) => {
    const input = parseImageGenerationCatalogFetchInput(value)
    try {
      const result = parseImageGenerationCatalogFetchResult(await options.imageGeneration.fetchCatalog(input))
      /** 拉取结束后再次核权，销毁或撤权窗口不能收到迟到结果。 */
      if (!options.isAuthorizedSender(event)) throw new Error('MEDIA_ACCESS_DENIED')
      return result
    } catch (error) {
      if (error instanceof Error && error.message === 'MEDIA_ACCESS_DENIED') throw error
      throwStableImageError(error, 'IMAGE_GENERATION_CATALOG_FAILED')
    }
  })
  handle(MEDIA_IPC_CHANNELS.REVEAL_IMAGE_GENERATION_CREDENTIAL, (value, event) => {
    const profileId = readImageProfileId(value)
    try {
      const apiKey = options.imageGeneration.revealCredential(profileId)
      /** 解密后再次核权，销毁或撤权窗口不能收到迟到明文。 */
      if (!options.isAuthorizedSender(event)) throw new Error('MEDIA_ACCESS_DENIED')
      return apiKey
    } catch (error) {
      if (error instanceof Error && error.message === 'MEDIA_ACCESS_DENIED') throw error
      throwStableImageError(error, 'IMAGE_GENERATION_CREDENTIAL_DECRYPT_FAILED')
    }
  })
  handle(MEDIA_IPC_CHANNELS.FETCH_AUDIO_GENERATION_CATALOG, async (value, event) => {
    const input = parseAudioGenerationCatalogFetchInput(value)
    try {
      const result = parseAudioGenerationCatalogFetchResult(await options.audioGeneration.fetchCatalog(input))
      /** 拉取结束后再次核权，销毁或撤权窗口不能收到迟到结果。 */
      if (!options.isAuthorizedSender(event)) throw new Error('MEDIA_ACCESS_DENIED')
      return result
    } catch (error) {
      if (error instanceof Error && error.message === 'MEDIA_ACCESS_DENIED') throw error
      throwStableAudioError(error, 'AUDIO_GENERATION_CATALOG_FAILED')
    }
  })
  handle(MEDIA_IPC_CHANNELS.TEST_AUDIO_GENERATION, async (value, event) => {
    const input = parseAudioGenerationTestInput(value)
    registerAudioOwner(event)
    try {
      const result = parseAudioGenerationTestResult(await options.audioGeneration.test(event.sender.id, input))
      /** 异步测试结束后再次核权，销毁或撤权窗口不能收到迟到结果。 */
      if (!options.isAuthorizedSender(event)) throw new Error('MEDIA_ACCESS_DENIED')
      return result
    } catch (error) {
      if (error instanceof Error && error.message === 'MEDIA_ACCESS_DENIED') throw error
      throwStableAudioError(error, 'AUDIO_GENERATION_TEST_FAILED')
    }
  })
  handle(MEDIA_IPC_CHANNELS.CANCEL_AUDIO_GENERATION_TEST, (value, event) => {
    const input = parseAudioGenerationTestCancelInput(value)
    try {
      options.audioGeneration.cancel(event.sender.id, input.requestId)
    } catch (error) {
      throwStableAudioError(error, 'AUDIO_GENERATION_TEST_CANCEL_FAILED')
    }
  })
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
      for (const [sender, cleanup] of audioCleanupListeners) {
        sender.removeListener('destroyed', cleanup)
        options.audioGeneration.releaseOwner(sender.id)
      }
      subscriptions.clear()
      cleanupListeners.clear()
      subscriptionEvents.clear()
      audioCleanupListeners.clear()
      options.audioGeneration.dispose?.()
    },
  }
}
