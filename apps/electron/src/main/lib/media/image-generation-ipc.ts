/**
 * 独立生图目录的 IPC 组合服务。
 *
 * 只做三件事：读取（独立目录 + 只读旧配置摘要）、整目录 CAS 替换、向供应商拉取模型。
 * 旧统一媒体目录始终只读，任何写入都必须走新的独立目录。
 */
import type {
  ImageGenerationDreaminaLoginPollResult,
  ImageGenerationDreaminaLoginStartResult,
  ImageGenerationDreaminaLogoutResult,
  ImageGenerationDreaminaStatus,
  ImageGenerationCatalogFetchInput,
  ImageGenerationCatalogFetchResult,
  ImageGenerationPublicCatalog,
  ImageGenerationSettingsResult,
  LegacyImageProfileSummary,
  MediaApiModelCatalogResult,
  ReplaceImageGenerationCatalogRequest,
} from '@proma/shared'
import {
  DREAMINA_LOGIN_MESSAGES,
  IMAGE_GENERATION_LEGACY_WARNING,
  parseImageGenerationCatalogFetchInput,
  parseImageGenerationCatalogFetchResult,
  parseImageGenerationSettingsResult,
  parseDreaminaLoginPollResult,
  parseDreaminaLoginRequestInput,
  parseDreaminaLoginStartResult,
  parseDreaminaLogoutResult,
  parseDreaminaStatus,
  parseReplaceImageGenerationCatalogRequest,
} from '@proma/shared'
import type { ImageGenerationDreaminaService } from './image-generation-dreamina-service'
import type { ImageGenerationConfigStore } from './image-generation-config-store'
import type { ImageGenerationCatalogService } from './image-generation-catalog-service'

/** 生图 IPC 使用的最小服务合同，主进程装配和测试均可注入。 */
export interface ImageGenerationIpcService {
  /** 返回独立目录与只读旧配置摘要。 */
  listSettings(): ImageGenerationSettingsResult
  /** 完整替换独立目录并返回最新组合设置。 */
  replace(input: ReplaceImageGenerationCatalogRequest): ImageGenerationSettingsResult
  /** 向供应商拉取可用模型，同时充当连接测试。 */
  fetchCatalog(input: ImageGenerationCatalogFetchInput): Promise<ImageGenerationCatalogFetchResult>
  /** 读取单条配置的明文 API Key，仅用于编辑表单回填。 */
  revealCredential(profileId: string): string
  /** 查询即梦登录态与剩余额度。 */
  dreaminaStatus(input: unknown): Promise<ImageGenerationDreaminaStatus>
  /** 发起即梦设备码登录，按窗口隔离。 */
  dreaminaLogin(ownerId: number, input: unknown): Promise<ImageGenerationDreaminaLoginStartResult>
  /** 轮询即梦设备码授权结果。 */
  dreaminaLoginPoll(ownerId: number, input: unknown): Promise<ImageGenerationDreaminaLoginPollResult>
  /** 幂等取消当前窗口指定的设备码登录。 */
  dreaminaLoginCancel(ownerId: number, input: unknown): void
  /** 清除本地即梦登录态。 */
  dreaminaLogout(input: unknown): Promise<ImageGenerationDreaminaLogoutResult>
  /** 窗口销毁时释放该窗口的设备码登录。 */
  releaseDreaminaOwner(ownerId: number): void
  /** IPC 整体卸载时释放资源；自定义服务可省略。 */
  disposeDreamina?(): void
}

/** 生图 IPC 服务工厂的显式依赖，不让 Renderer 接触凭据存储。 */
export interface ImageGenerationIpcServiceOptions {
  store: Pick<ImageGenerationConfigStore, 'readPublic' | 'replace' | 'resolveApiKey'>
  catalog: Pick<ImageGenerationCatalogService, 'fetch'>
  /**
   * 即梦 CLI 服务；未注入时所有即梦操作返回保守的不可用结果。
   * dispose 可省略，便于测试注入最小替身。
   */
  dreamina?: Pick<
    ImageGenerationDreaminaService,
    'status' | 'startLogin' | 'pollLogin' | 'cancelLogin' | 'logout' | 'releaseOwner'
  > & Partial<Pick<ImageGenerationDreaminaService, 'dispose'>>
  listLegacyCatalog(): MediaApiModelCatalogResult
}

/** 可原样跨 IPC 保留的生图稳定错误码。 */
const IMAGE_GENERATION_STABLE_ERROR_CODES = new Set([
  'IMAGE_GENERATION_CONFIG_CONFLICT',
  'IMAGE_GENERATION_CONFIG_INVALID',
  'IMAGE_GENERATION_CONFIG_OUTCOME_UNKNOWN',
  'IMAGE_GENERATION_CONFIG_SIZE_LIMIT',
  'IMAGE_GENERATION_CONFIG_WRITE_FAILED',
  'IMAGE_GENERATION_CREDENTIAL_DECRYPT_FAILED',
  'IMAGE_GENERATION_CREDENTIAL_ENCRYPT_FAILED',
  'IMAGE_GENERATION_CREDENTIAL_PRESERVE_INVALID',
  'IMAGE_GENERATION_CREDENTIAL_NOT_APPLICABLE',
  'IMAGE_GENERATION_PROFILE_NOT_FOUND',
  'IMAGE_GENERATION_SECURE_STORAGE_UNAVAILABLE',
  'IMAGE_GENERATION_LEGACY_REFERENCE_INVALID',
  'IMAGE_GENERATION_CATALOG_FAILED',
  'IMAGE_GENERATION_DREAMINA_STATUS_FAILED',
  'IMAGE_GENERATION_DREAMINA_LOGIN_FAILED',
])

/** 只把稳定错误码原样抛出，其它异常统一替换为给定兜底码。 */
export function throwStableImageError(error: unknown, fallback: string): never {
  if (error instanceof Error && IMAGE_GENERATION_STABLE_ERROR_CODES.has(error.message)) {
    throw new Error(error.message)
  }
  throw new Error(fallback)
}

/** 读取独立生图目录，失败时转换为稳定错误码。 */
function readImageCatalog(store: ImageGenerationIpcServiceOptions['store']): ImageGenerationPublicCatalog {
  try {
    return store.readPublic()
  } catch (error) {
    throwStableImageError(error, 'IMAGE_GENERATION_CONFIG_READ_FAILED')
  }
}

/** 从旧统一目录只读投影可迁移的生图条目，任何歧义都降级为固定警告。 */
function readLegacyImageProfiles(
  listLegacyCatalog: () => MediaApiModelCatalogResult,
): Pick<ImageGenerationSettingsResult, 'legacyImageProfiles' | 'legacyWarning'> {
  try {
    const catalog = listLegacyCatalog()
    /** 只投影引用渠道的 OpenAI Images 条目；其它协议留给各自设置页。 */
    const entries: LegacyImageProfileSummary[] = catalog.entries
      .filter((entry) => entry.profile.protocol === 'openai-images')
      .map((entry) => ({
        id: entry.profile.id,
        name: entry.profile.name,
        protocol: 'openai-images' as const,
        modelId: entry.profile.modelId,
        enabled: entry.profile.enabled,
      }))
    const ids = new Set(entries.map((entry) => entry.id))
    if (ids.size !== entries.length) throw new Error('IMAGE_GENERATION_LEGACY_REFERENCE_INVALID')
    return { legacyImageProfiles: entries }
  } catch {
    return { legacyImageProfiles: [], legacyWarning: IMAGE_GENERATION_LEGACY_WARNING }
  }
}

/** 组合独立目录与旧目录摘要，并交给 Shared 严格复验。 */
function createImageSettingsResult(
  catalog: ImageGenerationPublicCatalog,
  legacy: Pick<ImageGenerationSettingsResult, 'legacyImageProfiles' | 'legacyWarning'>,
): ImageGenerationSettingsResult {
  return parseImageGenerationSettingsResult({ catalog, ...legacy })
}

/** 创建独立生图目录、旧配置迁移校验与目录拉取的统一服务。 */
export function createImageGenerationIpcService(options: ImageGenerationIpcServiceOptions): ImageGenerationIpcService {
  return {
    listSettings: () => {
      /** 独立目录失败必须直接失败，不能被旧目录 warning 掩盖。 */
      const catalog = readImageCatalog(options.store)
      return createImageSettingsResult(catalog, readLegacyImageProfiles(options.listLegacyCatalog))
    },
    replace: (input) => {
      /** 在读取旧目录或写 Store 前执行 Shared 严格解析。 */
      const request = parseReplaceImageGenerationCatalogRequest(input)
      const current = readImageCatalog(options.store)
      const currentById = new Map(current.profiles.map((profile) => [profile.id, profile]))
      /** 只有新增或变化的旧目录引用必须重新取得旧目录事实。 */
      const introducedLegacyIds = new Set(request.profiles.flatMap(({ profile }) => {
        if (profile.legacyMediaProfileId === undefined
          || currentById.get(profile.id)?.legacyMediaProfileId === profile.legacyMediaProfileId) return []
        return [profile.legacyMediaProfileId]
      }))
      /** 引用的旧条目必须真实存在且协议匹配，否则拒绝写入。 */
      let legacy: Pick<ImageGenerationSettingsResult, 'legacyImageProfiles' | 'legacyWarning'> | undefined
      if (introducedLegacyIds.size > 0) {
        legacy = readLegacyImageProfiles(options.listLegacyCatalog)
        const known = new Set(legacy.legacyImageProfiles.map((entry) => entry.id))
        for (const id of introducedLegacyIds) {
          if (!known.has(id)) throw new Error('IMAGE_GENERATION_LEGACY_REFERENCE_INVALID')
        }
      }
      try {
        const catalog = options.store.replace(request)
        legacy ??= readLegacyImageProfiles(options.listLegacyCatalog)
        return createImageSettingsResult(catalog, legacy)
      } catch (error) {
        throwStableImageError(error, 'IMAGE_GENERATION_CONFIG_WRITE_FAILED')
      }
    },
    fetchCatalog: (input) => {
      /** 在触碰凭据与网络前先做严格解析。 */
      const request = parseImageGenerationCatalogFetchInput(input)
      return options.catalog.fetch(request).then(parseImageGenerationCatalogFetchResult)
    },
    revealCredential: (profileId) => {
      /** 只按稳定 ID 解密；目录读取路径不受影响，仍只返回脱敏摘要。 */
      if (typeof profileId !== 'string' || !profileId.trim()) throw new Error('IMAGE_GENERATION_CONFIG_INVALID')
      try {
        return options.store.resolveApiKey(profileId)
      } catch (error) {
        throwStableImageError(error, 'IMAGE_GENERATION_CREDENTIAL_DECRYPT_FAILED')
      }
    },
    dreaminaStatus: async (input) => {
      /** 未注入 CLI 服务时明确报「找不到 CLI」，不假装查过。 */
      if (!options.dreamina) {
        return parseDreaminaStatus({
          state: 'cliMissing',
          credit: null,
          message: DREAMINA_LOGIN_MESSAGES.statusCliMissing,
        })
      }
      return options.dreamina.status(input)
    },
    dreaminaLogin: async (ownerId, input) => {
      if (!options.dreamina) {
        return parseDreaminaLoginStartResult({ state: 'failed', message: DREAMINA_LOGIN_MESSAGES.cliMissing })
      }
      return options.dreamina.startLogin(ownerId, input)
    },
    dreaminaLoginPoll: async (ownerId, input) => {
      if (!options.dreamina) {
        return parseDreaminaLoginPollResult({
          requestId: parseDreaminaLoginRequestInput(input).requestId,
          state: 'failed',
          message: DREAMINA_LOGIN_MESSAGES.requestUnknown,
        })
      }
      return options.dreamina.pollLogin(ownerId, input)
    },
    dreaminaLoginCancel: (ownerId, input) => {
      /** 取消是幂等收尾，服务缺失时同样保持静默成功语义。 */
      options.dreamina?.cancelLogin(ownerId, input)
    },
    dreaminaLogout: async (input) => {
      if (!options.dreamina) {
        return parseDreaminaLogoutResult({ state: 'failed', message: DREAMINA_LOGIN_MESSAGES.logoutFailed })
      }
      return options.dreamina.logout(input)
    },
    releaseDreaminaOwner: (ownerId) => { options.dreamina?.releaseOwner(ownerId) },
    ...(options.dreamina?.dispose === undefined ? {} : { disposeDreamina: () => { options.dreamina?.dispose?.() } }),
  }
}
