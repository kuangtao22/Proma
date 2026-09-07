import type {
  ComfyObjectInfo,
  ComfyPrompt,
  JsonObject,
  JsonValue,
} from '../../../../../../packages/shared/src/types/media-workflow'
import { parseComfyObjectCatalog } from '../../../../../../packages/shared/src/types/media-workflow'

/** ComfyUI 客户端稳定错误类别。 */
export type ComfyUIErrorKind =
  | 'http'
  | 'authentication'
  | 'service-disabled'
  | 'validation'
  | 'validation-rejected'
  | 'timeout'
  | 'network'
  | 'unknown-submission'
  | 'redirect'
  | 'size-limit'

/** 带稳定类别和可选状态码的 ComfyUI 客户端错误。 */
export class ComfyUIError extends Error {
  /**
   * 创建稳定协议错误。
   * @param kind 错误类别。
   * @param message 可写入主进程日志的中文消息。
   * @param status 可选 HTTP 状态码。
   */
  constructor(
    readonly kind: ComfyUIErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'ComfyUIError'
  }
}

/** 可注入的标准 fetch 签名。 */
export type ComfyFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

/** 客户端级连接选项；认证信息只应由主进程构造。 */
export interface ComfyUIClientOptions {
  baseUrl: string
  headers?: Record<string, string>
  clientId?: string
  timeoutMs?: number
  maxJsonBytes?: number
  maxOutputBytes?: number
  fetch?: ComfyFetch
}

/** 每次请求独立的取消信号。 */
export interface ComfyRequestOptions {
  signal?: AbortSignal
}

/** 提交请求的关联参数。 */
export interface ComfySubmitOptions extends ComfyRequestOptions {
  clientId?: string
  promptId?: string
}

/** `/prompt` 成功入队回执。 */
export interface ComfySubmitResult {
  promptId: string
  number: number
  nodeErrors: JsonObject
}

/** `/upload/image` 返回的权威远端文件名。 */
export interface ComfyUploadResult {
  name: string
  subfolder: string
  type: 'input' | 'output' | 'temp'
}

/** 图片上传参数。 */
export interface ComfyUploadImageInput {
  image: Blob
  filename: string
  subfolder?: string
  type?: 'input' | 'temp'
  overwrite?: boolean
}

/** 图片、音频或视频的统一上传参数；服务端协议仍使用 image multipart 字段。 */
export interface ComfyUploadMediaInput {
  media: Blob
  filename: string
  subfolder?: string
  type?: 'input' | 'temp'
  overwrite?: boolean
}

/** 精确 prompt 的队列位置。 */
export interface ComfyQueuePrompt {
  promptId: string
  state: 'running' | 'pending'
  number: number
  raw: JsonValue
}

/** 精确 prompt 的历史记录。 */
export interface ComfyHistoryPrompt {
  promptId: string
  prompt: JsonValue
  outputs: JsonObject
  status?: JsonValue
}

/** `/view` 输出定位参数。 */
export interface ComfyOutputReference {
  filename: string
  subfolder: string
  type: 'input' | 'output' | 'temp'
}

/** 有界读取后的输出内容。 */
export interface ComfyOutputContent {
  bytes: Uint8Array
  contentType: string | null
}

/** UserData 工作流目录返回的文件事实。 */
export interface ComfyUserWorkflowFile {
  path: string
  size: number
  modified: number
  created: number
}

/** `/api/assets` 官方查询参数。 */
export interface ComfyAssetListOptions extends ComfyRequestOptions {
  offset: number
  limit: number
  nameContains?: string
}

/** assets 服务返回的远端引用，不把展示名当作 Loader 路径。 */
export interface ComfyRemoteAsset {
  id: string
  name: string
  displayName: string | null
  loaderPath: string | null
  assetHash: string | null
  size: number | null
  mimeType: string | null
  tags: string[]
  userMetadata: JsonObject
  metadata: JsonObject | null
  createdAt: string
  updatedAt: string
  lastAccessTime: string | null
}

/** assets 服务的一页权威结果。 */
export interface ComfyAssetPage {
  assets: ComfyRemoteAsset[]
  total: number
  hasMore: boolean
  nextCursor: string | null
}

const SAFE_FILE_COMPONENT = /^[^/\\\0]{1,255}$/
const MAX_SUBFOLDER_LENGTH = 1_024
const MAX_REMOTE_PATH_LENGTH = 4_096
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** 判断未知值是否为普通记录。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** 判断字符串是否可安全作为 ComfyUI 文件名。 */
function isSafeFilename(value: unknown): value is string {
  return typeof value === 'string' && SAFE_FILE_COMPONENT.test(value) && value !== '.' && value !== '..'
}

/** 判断远端子目录是否为有界相对路径。 */
function isSafeSubfolder(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_SUBFOLDER_LENGTH && !value.startsWith('/') && !value.startsWith('\\')
    && !value.split(/[\\/]/).some((segment) => segment === '..' || segment === '.')
}

/** 判断 UserData 或 Loader 路径是否为有界相对路径。 */
function isSafeRelativePath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_REMOTE_PATH_LENGTH
    && !value.startsWith('/') && !value.startsWith('\\') && !value.includes('\0')
    && !value.split(/[\\/]/).some((segment) => segment === '' || segment === '.' || segment === '..')
}

/** 把 JSON 文本解析为有界协议值。 */
function parseJsonText(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    throw new ComfyUIError('validation', 'ComfyUI 返回了无效 JSON')
  }
}

/** 将未知 JSON 转换为受支持的递归值并限制深度。 */
function toJsonValue(value: unknown, depth = 0): JsonValue {
  if (depth > 32) throw new ComfyUIError('validation', 'ComfyUI JSON 层级过深')
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (Array.isArray(value)) {
    if (value.length > 10_000) throw new ComfyUIError('validation', 'ComfyUI JSON 数组超出上限')
    return value.map((item) => toJsonValue(item, depth + 1))
  }
  if (isRecord(value) && Object.keys(value).length <= 10_000) {
    /** 复制后的协议对象。 */
    const result: JsonObject = Object.create(null) as JsonObject
    for (const [key, item] of Object.entries(value)) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype' || key.length > 256) {
        throw new ComfyUIError('validation', 'ComfyUI JSON 含不安全字段')
      }
      result[key] = toJsonValue(item, depth + 1)
    }
    return result
  }
  throw new ComfyUIError('validation', 'ComfyUI JSON 含不支持的值')
}

/** 解析模型列表响应。 */
function parseStringList(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 100_000 || value.some((item) => typeof item !== 'string' || item.length > 4_096)) {
    throw new ComfyUIError('validation', 'ComfyUI 模型列表响应无效')
  }
  return value as string[]
}

/** 严格重建单个远端 assets 引用，供列表与精确元数据接口共享同一验证边界。 */
function parseRemoteAsset(item: unknown): ComfyRemoteAsset {
  if (!isRecord(item) || typeof item.id !== 'string' || !UUID_PATTERN.test(item.id)
    || typeof item.name !== 'string' || item.name.length > 4_096
    || (item.display_name !== undefined && item.display_name !== null && (typeof item.display_name !== 'string' || item.display_name.length > MAX_REMOTE_PATH_LENGTH))
    || (item.loader_path !== undefined && item.loader_path !== null && !isSafeRelativePath(item.loader_path))
    || (item.asset_hash !== undefined && item.asset_hash !== null && (typeof item.asset_hash !== 'string' || item.asset_hash.length > 256))
    || (item.size !== undefined && item.size !== null && (typeof item.size !== 'number' || !Number.isSafeInteger(item.size) || item.size < 0))
    || (item.mime_type !== undefined && item.mime_type !== null && (typeof item.mime_type !== 'string' || item.mime_type.length > 256))
    || !Array.isArray(item.tags) || item.tags.length > 256 || item.tags.some((tag) => typeof tag !== 'string' || tag.length > 256)
    || typeof item.created_at !== 'string' || item.created_at.length > 128 || typeof item.updated_at !== 'string' || item.updated_at.length > 128
    || (item.last_access_time !== undefined && item.last_access_time !== null && (typeof item.last_access_time !== 'string' || item.last_access_time.length > 128))) {
    throw new ComfyUIError('validation', 'ComfyUI Assets 条目无效')
  }
  /** 公开用户元数据只能是经过递归约束的 JSON 对象。 */
  const userMetadata = toJsonValue(item.user_metadata ?? {})
  /** 可选系统元数据。 */
  const metadata = item.metadata === undefined || item.metadata === null ? null : toJsonValue(item.metadata)
  if (userMetadata === null || Array.isArray(userMetadata) || typeof userMetadata !== 'object'
    || (metadata !== null && (Array.isArray(metadata) || typeof metadata !== 'object'))) {
    throw new ComfyUIError('validation', 'ComfyUI Assets 元数据无效')
  }
  return {
    id: item.id, name: item.name, displayName: item.display_name ?? null, loaderPath: item.loader_path ?? null,
    assetHash: item.asset_hash ?? null, size: item.size ?? null, mimeType: item.mime_type ?? null,
    tags: item.tags as string[], userMetadata, metadata,
    createdAt: item.created_at, updatedAt: item.updated_at, lastAccessTime: item.last_access_time ?? null,
  }
}

/** ComfyUI Node/Electron 主进程 HTTP 协议客户端。 */
export class ComfyUIClient {
  private readonly baseUrl: URL
  private readonly headers: Headers
  private readonly webSocketHeaders: Record<string, string>
  private readonly clientId?: string
  private readonly timeoutMs: number
  private readonly maxJsonBytes: number
  private readonly maxOutputBytes: number
  private readonly fetchImpl: ComfyFetch

  /**
   * 创建客户端并保留基址中的反向代理前缀。
   * @param options 主进程解析后的连接配置。
   */
  constructor(options: ComfyUIClientOptions) {
    /** 规范化后的 HTTP 基址。 */
    const baseUrl = new URL(options.baseUrl)
    if (baseUrl.protocol !== 'http:' && baseUrl.protocol !== 'https:') throw new ComfyUIError('validation', 'ComfyUI 基址必须使用 HTTP 或 HTTPS')
    baseUrl.pathname = `${baseUrl.pathname.replace(/\/+$/, '')}/`
    baseUrl.search = ''
    baseUrl.hash = ''
    this.baseUrl = baseUrl
    this.headers = new Headers(options.headers)
    this.webSocketHeaders = { ...options.headers }
    this.clientId = options.clientId
    this.timeoutMs = Math.min(300_000, Math.max(1, options.timeoutMs ?? 30_000))
    this.maxJsonBytes = Math.min(64 * 1024 * 1024, Math.max(1_024, options.maxJsonBytes ?? 8 * 1024 * 1024))
    this.maxOutputBytes = Math.min(1024 * 1024 * 1024, Math.max(1, options.maxOutputBytes ?? 256 * 1024 * 1024))
    this.fetchImpl = options.fetch ?? fetch
  }

  /** 构建保留代理前缀的接口 URL。 */
  private buildUrl(path: string, query?: URLSearchParams): URL {
    /** 基于固定前缀拼接后的 URL。 */
    const url = new URL(this.baseUrl)
    /** 路径中由内部调用方提供的预编码查询串。 */
    const separatorIndex = path.indexOf('?')
    /** 不含查询串的接口路径。 */
    const pathname = separatorIndex < 0 ? path : path.slice(0, separatorIndex)
    url.pathname = `${this.baseUrl.pathname}${pathname.replace(/^\/+/, '')}`
    url.search = query?.toString() ?? (separatorIndex < 0 ? '' : path.slice(separatorIndex + 1))
    return url
  }

  /** 发起请求并在同一截止时间内消费响应体。 */
  private async request<T>(
    path: string,
    init: RequestInit,
    options: ComfyRequestOptions,
    consume: (response: Response, signal: AbortSignal) => Promise<T>,
    isSubmission = false,
  ): Promise<T> {
    /** 当前请求专属超时控制器。 */
    const timeoutController = new AbortController()
    /** 是否由本客户端超时触发取消。 */
    let timedOut = false
    /** 超时定时器。 */
    const timeout = setTimeout(() => {
      timedOut = true
      timeoutController.abort()
    }, this.timeoutMs)
    /** 合并调用方取消与客户端超时。 */
    const signal = options.signal ? AbortSignal.any([options.signal, timeoutController.signal]) : timeoutController.signal
    /** 是否已收到成功响应头；提交后续失败将属于未知状态。 */
    let submissionAccepted = false
    try {
      /** 服务端 HTTP 响应。 */
      const response = await this.fetchImpl(this.buildUrl(path), {
        ...init,
        headers: new Headers({ ...Object.fromEntries(this.headers.entries()), ...Object.fromEntries(new Headers(init.headers).entries()) }),
        redirect: 'manual',
        signal,
      })
      if (response.status >= 300 && response.status < 400) throw new ComfyUIError('redirect', 'ComfyUI 响应包含未允许的重定向', response.status)
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          throw new ComfyUIError('authentication', 'ComfyUI 请求缺少有效认证或远端用户无权访问', response.status)
        }
        if (response.status === 503) {
          try {
            /** assets 未启用时官方返回的稳定错误信封。 */
            const errorBody = await this.readJson(response, signal)
            if (isRecord(errorBody) && isRecord(errorBody.error) && errorBody.error.code === 'SERVICE_DISABLED') {
              throw new ComfyUIError('service-disabled', 'ComfyUI Assets 服务未启用', response.status)
            }
          } catch (error) {
            if (error instanceof ComfyUIError && error.kind === 'service-disabled') throw error
          }
        }
        /** 提交验证失败属于确定拒绝，可以安全修正后重提。 */
        const kind: ComfyUIErrorKind = isSubmission && response.status >= 400 && response.status < 500 ? 'validation-rejected' : 'http'
        throw new ComfyUIError(kind, `ComfyUI 请求失败：HTTP ${response.status}`, response.status)
      }
      submissionAccepted = isSubmission
      return await consume(response, signal)
    } catch (error) {
      if (error instanceof ComfyUIError && !submissionAccepted) throw error
      if (isSubmission && (submissionAccepted || !(error instanceof ComfyUIError))) {
        throw new ComfyUIError('unknown-submission', timedOut ? 'ComfyUI 提交超时，任务是否入队未知' : 'ComfyUI 提交结果未知')
      }
      if (error instanceof ComfyUIError) throw error
      if (timedOut) throw new ComfyUIError('timeout', 'ComfyUI 请求超时')
      if (options.signal?.aborted) throw options.signal.reason ?? new DOMException('Aborted', 'AbortError')
      throw new ComfyUIError('network', error instanceof Error ? error.message : 'ComfyUI 网络请求失败')
    } finally {
      clearTimeout(timeout)
    }
  }

  /** 有界读取响应字节流。 */
  private async readBytes(response: Response, limit: number, signal: AbortSignal): Promise<Uint8Array> {
    /** 声明的响应体长度。 */
    const declaredLength = Number(response.headers.get('content-length'))
    if (Number.isFinite(declaredLength) && declaredLength > limit) throw new ComfyUIError('size-limit', 'ComfyUI 响应体超出大小上限')
    if (!response.body) return new Uint8Array()
    /** 流式响应读取器。 */
    const reader = response.body.getReader()
    /** 已读取分块。 */
    const chunks: Uint8Array[] = []
    /** 已读取总字节数。 */
    let total = 0
    /** 在流读取期间传播超时和调用方取消。 */
    let rejectAbort: ((reason?: unknown) => void) | undefined
    /** 取消时拒绝当前 read 等待的 Promise。 */
    const abortPromise = new Promise<never>((_resolve, reject) => { rejectAbort = reject })
    /** 取消流并唤醒等待中的读取。 */
    const onAbort = (): void => {
      void reader.cancel(signal.reason).catch(() => undefined)
      rejectAbort?.(signal.reason ?? new DOMException('Aborted', 'AbortError'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      if (signal.aborted) onAbort()
      while (true) {
        /** 下一响应分块或取消结果。 */
        const chunk = await Promise.race([reader.read(), abortPromise])
        if (chunk.done) break
        total += chunk.value.byteLength
        if (total > limit) {
          await reader.cancel()
          throw new ComfyUIError('size-limit', 'ComfyUI 响应体超出大小上限')
        }
        chunks.push(chunk.value)
      }
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
    if (signal.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError')
    /** 连续输出缓冲区。 */
    const output = new Uint8Array(total)
    /** 当前写入偏移。 */
    let offset = 0
    for (const chunk of chunks) {
      output.set(chunk, offset)
      offset += chunk.byteLength
    }
    return output
  }

  /** 有界读取并解析 JSON 响应。 */
  private async readJson(response: Response, signal: AbortSignal): Promise<unknown> {
    /** JSON 响应 UTF-8 字节。 */
    const bytes = await this.readBytes(response, this.maxJsonBytes, signal)
    return parseJsonText(new TextDecoder().decode(bytes))
  }

  /** 获取全部或单个节点 class 的 object_info。 */
  async objectInfo(classType?: string, options: ComfyRequestOptions = {}): Promise<ComfyObjectInfo> {
    /** 可选 class 路径段。 */
    const suffix = classType === undefined ? '' : `/${encodeURIComponent(classType)}`
    return parseComfyObjectCatalog(await this.request(`object_info${suffix}`, { method: 'GET' }, options, (response, signal) => this.readJson(response, signal)))
  }

  /** 列出模型目录名；该列表不代表模型已加载或兼容。 */
  async listModelFolders(options: ComfyRequestOptions = {}): Promise<string[]> {
    return parseStringList(await this.request('models', { method: 'GET' }, options, (response, signal) => this.readJson(response, signal)))
  }

  /** 列出指定模型目录中的文件名。 */
  async listModels(folder: string, options: ComfyRequestOptions = {}): Promise<string[]> {
    if (!folder || folder.length > 256) throw new ComfyUIError('validation', 'ComfyUI 模型目录名无效')
    return parseStringList(await this.request(`models/${encodeURIComponent(folder)}`, { method: 'GET' }, options, (response, signal) => this.readJson(response, signal)))
  }

  /** 获取系统状态的有界 JSON。 */
  async systemStats(options: ComfyRequestOptions = {}): Promise<JsonObject> {
    /** 已解析系统状态。 */
    const value = toJsonValue(await this.request('system_stats', { method: 'GET' }, options, (response, signal) => this.readJson(response, signal)))
    if (value === null || Array.isArray(value) || typeof value !== 'object') throw new ComfyUIError('validation', 'ComfyUI 系统状态响应无效')
    return value
  }

  /** 列出当前远端用户保存的 JSON 工作流，不读取文件正文。 */
  async listUserWorkflows(options: ComfyRequestOptions = {}): Promise<ComfyUserWorkflowFile[]> {
    /** 官方 UserData 目录查询参数。 */
    const query = new URLSearchParams({ dir: 'workflows', recurse: 'true', full_info: 'true' })
    /** 当前远端用户的工作流文件列表。 */
    const value = await this.request(`userdata?${query.toString()}`, { method: 'GET' }, options, (response, signal) => this.readJson(response, signal))
    if (!Array.isArray(value) || value.length > 10_000) throw new ComfyUIError('validation', 'ComfyUI 工作流目录响应无效')
    return value.map((item) => {
      if (!isRecord(item) || !isSafeRelativePath(item.path)
        || typeof item.size !== 'number' || !Number.isSafeInteger(item.size) || item.size < 0
        || typeof item.modified !== 'number' || !Number.isSafeInteger(item.modified) || item.modified < 0
        || typeof item.created !== 'number' || !Number.isSafeInteger(item.created) || item.created < 0) {
        throw new ComfyUIError('validation', 'ComfyUI 工作流目录条目无效')
      }
      return { path: item.path, size: item.size, modified: item.modified, created: item.created }
    }).filter((item) => item.path.toLocaleLowerCase().endsWith('.json') && item.size <= this.maxJsonBytes)
  }

  /** 按 UserData 真实相对路径读取一个有界 JSON 工作流。 */
  async readUserWorkflow(relativePath: string, options: ComfyRequestOptions = {}): Promise<JsonObject> {
    if (!isSafeRelativePath(relativePath) || !relativePath.toLocaleLowerCase().endsWith('.json')) {
      throw new ComfyUIError('validation', 'ComfyUI 工作流路径无效')
    }
    /** UserData 处理器会整体解码该路径参数，斜杠必须作为相对路径内容编码。 */
    const value = toJsonValue(await this.request(`userdata/${encodeURIComponent(`workflows/${relativePath}`)}`, { method: 'GET' }, options, (response, signal) => this.readJson(response, signal)))
    if (value === null || Array.isArray(value) || typeof value !== 'object') throw new ComfyUIError('validation', 'ComfyUI 工作流 JSON 必须是对象')
    return value
  }

  /** 使用官方 offset/limit 查询一页 assets 引用。 */
  async listAssets(options: ComfyAssetListOptions): Promise<ComfyAssetPage> {
    if (!Number.isSafeInteger(options.offset) || options.offset < 0 || !Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 100
      || (options.nameContains !== undefined && (typeof options.nameContains !== 'string' || options.nameContains.length > 256))) {
      throw new ComfyUIError('validation', 'ComfyUI Assets 查询参数无效')
    }
    /** 官方 offset 分页参数，不构造未确认的筛选字段。 */
    const query = new URLSearchParams({ limit: String(options.limit), offset: String(options.offset) })
    if (options.nameContains) query.set('name_contains', options.nameContains)
    /** assets 服务响应。 */
    const value = await this.request(`api/assets?${query.toString()}`, { method: 'GET' }, options, (response, signal) => this.readJson(response, signal))
    if (!isRecord(value) || !Array.isArray(value.assets) || value.assets.length > 100
      || typeof value.total !== 'number' || !Number.isSafeInteger(value.total) || value.total < 0 || typeof value.has_more !== 'boolean'
      || (value.has_more && value.assets.length === 0)
      || (value.next_cursor !== undefined && value.next_cursor !== null && (typeof value.next_cursor !== 'string' || value.next_cursor.length > 4_096))) {
      throw new ComfyUIError('validation', 'ComfyUI Assets 列表响应无效')
    }
    /** 列表与单项读取使用同一个严格解析器。 */
    const assets = value.assets.map(parseRemoteAsset)
    return { assets, total: value.total, hasMore: value.has_more, nextCursor: value.next_cursor ?? null }
  }

  /** 按 assets UUID fresh 获取单项元数据，不下载正文。 */
  async getAssetMetadata(assetId: string, options: ComfyRequestOptions = {}): Promise<ComfyRemoteAsset> {
    if (!UUID_PATTERN.test(assetId)) throw new ComfyUIError('validation', 'ComfyUI Asset ID 无效')
    /** 服务端当前单项元数据响应。 */
    const value = await this.request(`api/assets/${assetId}`, { method: 'GET' }, options, (response, signal) => this.readJson(response, signal))
    return parseRemoteAsset(value)
  }

  /** 按 assets 引用 UUID 读取原始内容，沿用客户端输出字节上限。 */
  async getAssetContent(assetId: string, options: ComfyRequestOptions = {}): Promise<ComfyOutputContent> {
    if (!UUID_PATTERN.test(assetId)) throw new ComfyUIError('validation', 'ComfyUI Asset ID 无效')
    return await this.request(`api/assets/${assetId}/content?disposition=inline`, { method: 'GET' }, options, async (response, signal) => ({
      bytes: await this.readBytes(response, this.maxOutputBytes, signal), contentType: response.headers.get('content-type'),
    }))
  }

  /** 上传图片、音频或视频原始字节，并采用服务端返回的改名结果。 */
  async uploadMedia(input: ComfyUploadMediaInput, options: ComfyRequestOptions = {}): Promise<ComfyUploadResult> {
    if (!isSafeFilename(input.filename) || !isSafeSubfolder(input.subfolder ?? '')) throw new ComfyUIError('validation', 'ComfyUI 媒体上传参数无效')
    /** 官方接口沿用 image 字段，但服务端会直接保存其中的原始字节。 */
    const form = new FormData()
    form.set('image', input.media, input.filename)
    if (input.subfolder) form.set('subfolder', input.subfolder)
    if (input.type) form.set('type', input.type)
    if (input.overwrite !== undefined) form.set('overwrite', String(input.overwrite))
    /** 服务器文件描述回执。 */
    const value = await this.request('upload/image', { method: 'POST', body: form }, options, (response, signal) => this.readJson(response, signal))
    /** 请求期望的远端存储类别。 */
    const expectedType = input.type ?? 'input'
    if (!isRecord(value) || !isSafeFilename(value.name) || !isSafeSubfolder(value.subfolder)
      || value.type !== expectedType) {
      throw new ComfyUIError('validation', 'ComfyUI 媒体上传响应无效')
    }
    return { name: value.name, subfolder: value.subfolder, type: expectedType }
  }

  /** 保留既有图片调用接口，并复用统一媒体上传协议。 */
  async uploadImage(input: ComfyUploadImageInput, options: ComfyRequestOptions = {}): Promise<ComfyUploadResult> {
    return await this.uploadMedia({
      media: input.image,
      filename: input.filename,
      ...(input.subfolder === undefined ? {} : { subfolder: input.subfolder }),
      ...(input.type === undefined ? {} : { type: input.type }),
      ...(input.overwrite === undefined ? {} : { overwrite: input.overwrite }),
    }, options)
  }

  /** 提交一次 prompt；网络或超时失败不会自动重试。 */
  async submitPrompt(prompt: ComfyPrompt, options: ComfySubmitOptions = {}): Promise<ComfySubmitResult> {
    /** 每次提交可覆盖客户端级 client_id。 */
    const clientId = options.clientId ?? this.clientId
    /** 官方提交负载及可选关联 prompt_id。 */
    const body: Record<string, unknown> = { prompt }
    if (clientId) body.client_id = clientId
    if (options.promptId) body.prompt_id = options.promptId
    /** 入队回执。 */
    const value = await this.request('prompt', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }, options, (response, signal) => this.readJson(response, signal), true)
    if (!isRecord(value) || typeof value.prompt_id !== 'string' || !value.prompt_id
      || typeof value.number !== 'number' || !Number.isFinite(value.number) || !isRecord(value.node_errors)) {
      throw new ComfyUIError('unknown-submission', 'ComfyUI 提交成功响应无效，任务是否入队未知')
    }
    /** 服务端节点验证错误。 */
    const nodeErrors = toJsonValue(value.node_errors)
    if (nodeErrors === null || Array.isArray(nodeErrors) || typeof nodeErrors !== 'object') throw new ComfyUIError('validation', 'ComfyUI 节点错误响应无效')
    return { promptId: value.prompt_id, number: value.number, nodeErrors }
  }

  /** 查询队列，并可只返回指定 prompt 的精确状态。 */
  async getQueue(promptId?: string, options: ComfyRequestOptions = {}): Promise<ComfyQueuePrompt | { running: ComfyQueuePrompt[]; pending: ComfyQueuePrompt[] } | null> {
    /** 原始队列响应。 */
    const value = await this.request('queue', { method: 'GET' }, options, (response, signal) => this.readJson(response, signal))
    if (!isRecord(value) || !Array.isArray(value.queue_running) || !Array.isArray(value.queue_pending)) throw new ComfyUIError('validation', 'ComfyUI 队列响应无效')
    /** 解析单个队列元组。 */
    const parseEntries = (entries: unknown[], state: 'running' | 'pending'): ComfyQueuePrompt[] => entries.map((entry) => {
      if (!Array.isArray(entry) || typeof entry[0] !== 'number' || typeof entry[1] !== 'string') throw new ComfyUIError('validation', 'ComfyUI 队列条目无效')
      return { promptId: entry[1], state, number: entry[0], raw: toJsonValue(entry) }
    })
    /** 正在运行的队列条目。 */
    const running = parseEntries(value.queue_running, 'running')
    /** 尚未运行的队列条目。 */
    const pending = parseEntries(value.queue_pending, 'pending')
    return promptId === undefined ? { running, pending } : [...running, ...pending].find((item) => item.promptId === promptId) ?? null
  }

  /** 通过官方精确路径查询单个 prompt 历史。 */
  async getHistory(promptId: string, options: ComfyRequestOptions = {}): Promise<ComfyHistoryPrompt | null> {
    if (!promptId || promptId.length > 256) throw new ComfyUIError('validation', 'ComfyUI prompt_id 无效')
    /** 精确历史响应。 */
    const value = await this.request(`history/${encodeURIComponent(promptId)}`, { method: 'GET' }, options, (response, signal) => this.readJson(response, signal))
    if (!isRecord(value)) throw new ComfyUIError('validation', 'ComfyUI 历史响应无效')
    /** 指定 prompt 的历史条目。 */
    const item = value[promptId]
    if (item === undefined) return null
    if (!isRecord(item) || !Object.hasOwn(item, 'prompt') || !isRecord(item.outputs)) throw new ComfyUIError('validation', 'ComfyUI 历史条目无效')
    /** 历史输出映射。 */
    const outputs = toJsonValue(item.outputs)
    if (outputs === null || Array.isArray(outputs) || typeof outputs !== 'object') throw new ComfyUIError('validation', 'ComfyUI 历史输出无效')
    return {
      promptId,
      prompt: toJsonValue(item.prompt),
      outputs,
      ...(item.status === undefined ? {} : { status: toJsonValue(item.status) }),
    }
  }

  /** 按官方 filename/subfolder/type 精确读取一个输出文件。 */
  async getOutput(reference: ComfyOutputReference, options: ComfyRequestOptions = {}): Promise<ComfyOutputContent> {
    if (!isSafeFilename(reference.filename) || !isSafeSubfolder(reference.subfolder)) throw new ComfyUIError('validation', 'ComfyUI 输出引用无效')
    /** 官方 view 查询参数。 */
    const query = new URLSearchParams({ filename: reference.filename, subfolder: reference.subfolder, type: reference.type })
    /** 输出文件响应。 */
    return await this.request(`view?${query.toString()}`, { method: 'GET' }, options, async (response, signal) => ({
      bytes: await this.readBytes(response, this.maxOutputBytes, signal),
      contentType: response.headers.get('content-type'),
    }))
  }

  /** 仅取消明确指定的排队 prompt，不调用全局 interrupt。 */
  async cancelPrompt(promptId: string, options: ComfyRequestOptions = {}): Promise<void> {
    if (!promptId || promptId.length > 256) throw new ComfyUIError('validation', 'ComfyUI prompt_id 无效')
    await this.request('queue', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ delete: [promptId] }),
    }, options, async () => undefined)
  }

  /** 构建保留反向代理前缀且不携带认证信息的 WebSocket URL。 */
  buildWebSocketUrl(clientId: string): string {
    /** WebSocket 查询参数。 */
    const query = new URLSearchParams({ clientId })
    /** 从 HTTP 基址派生的 WebSocket URL。 */
    const url = this.buildUrl('ws', query)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    return url.toString()
  }

  /** 返回 Node WebSocket 构造器可用的认证选项。 */
  getWebSocketOptions(): { headers: Record<string, string> } {
    return { headers: { ...this.webSocketHeaders } }
  }
}
