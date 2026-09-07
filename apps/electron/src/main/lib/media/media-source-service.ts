import { createHash, randomUUID } from 'node:crypto'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { realpathSync } from 'node:fs'
import type { AgentMessage, AgentSessionMeta, MediaAssetRecord, MediaAssetRef, MediaKind, SDKMessage } from '@proma/shared'
import { openAuthorizedAgentMediaSource } from '../design/design-session-bridge'
import type { MediaAssetService } from './media-asset-service'

const MAX_SOURCE_MESSAGES = 10_000
const MAX_SESSION_SOURCES = 128
const MAX_RAW_SOURCE_ENTRIES = 512
const MAX_IMPORT_SOURCES = 32
const MAX_SOURCE_CONTEXTS = 64
const MAX_MEDIA_SOURCE_BYTES = 128 * 1024 * 1024

/** 普通 Agent 或 Canvas Agent 调用来源服务时由 Host 固化的项目会话身份。 */
export interface MediaSourceContext {
  projectId: string
  sessionId: string
}

/** 不暴露本地路径的会话媒体来源摘要。 */
export interface MediaSourceSummary {
  sourceRef: string
  name: string
  mediaKind: MediaKind
}

/** Agent 显式指定的单个本地媒体文件；项目与会话身份只能由 Host 上下文提供。 */
export interface LocalMediaFileImportInput {
  path: string
  mediaKind: MediaKind
}

/** Host 对当前会话 fresh 解析的 Agent cwd 与本地文件授权根。 */
export interface LocalMediaFileAccess {
  baseDir: string
  allowedRoots: string[]
}

/** 供 Agent 后续 ffmpeg 或分析工具消费的已验证资产文件。 */
export interface MediaAssetFile {
  path: string
  asset: MediaAssetRef
  record: MediaAssetRecord
}

/** 会话来源读取和项目资产登记依赖。 */
export interface MediaSourceServiceDependencies {
  getSession(sessionId: string): AgentSessionMeta | undefined
  getMessages(sessionId: string): Array<AgentMessage | SDKMessage>
  authorize(context: MediaSourceContext, action: 'list' | 'import'): void | Promise<void>
  resolveAttachmentPath(localPath: string): string
  getAllowedRoots(session: AgentSessionMeta, projectId: string): string[]
  getLocalFileAccess?(session: AgentSessionMeta, projectId: string): LocalMediaFileAccess
  assets: Pick<MediaAssetService, 'register'> & Partial<Pick<MediaAssetService, 'getRecord' | 'resolveAssetPath'>>
  createSourceRef?: () => string
}

/** 只保存在主进程内存中的来源事实。 */
interface MediaSourceCandidate {
  identity: string
  localPath: string
  filename: string
  mediaType: string
  mediaKind: MediaKind
}

/** 判断未知值是否为普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** 区分旧 AgentMessage 与带开放索引签名的 SDKMessage。 */
function isAgentMessage(message: AgentMessage | SDKMessage): message is AgentMessage {
  if (!isRecord(message)) return false
  return typeof message.id === 'string'
    && typeof message.role === 'string'
    && typeof message.content === 'string'
    && typeof message.createdAt === 'number'
}

/** 根据声明 MIME 仅筛选媒体候选；最终类型仍由资产服务实际探测。 */
function mediaKindFromType(mediaType: string): MediaKind | undefined {
  if (/^image\/[A-Za-z0-9.+-]{1,127}$/.test(mediaType)) return 'image'
  if (/^audio\/[A-Za-z0-9.+-]{1,127}$/.test(mediaType)) return 'audio'
  if (/^video\/[A-Za-z0-9.+-]{1,127}$/.test(mediaType)) return 'video'
  return undefined
}

/** 只取附件声明的基础文件名作为展示文本。 */
function displayFilename(filename: string): string {
  /** 同时兼容来自 Windows 与 POSIX 会话的分隔符。 */
  const name = filename.split(/[\\/]/).filter(Boolean).at(-1)?.replace(/[\u0000-\u001F\u007F]/g, '_')
  return name && name !== '.' && name !== '..' ? name.slice(0, 255) : 'media'
}

/** 从一个结构化附件对象解析受限媒体来源。 */
function parseAttachment(value: unknown): Omit<MediaSourceCandidate, 'identity'> | undefined {
  if (!isRecord(value)) return undefined
  /** 新工具结果使用 localPath，用户附件恢复快照可能使用 targetPath。 */
  const localPath = typeof value.localPath === 'string' ? value.localPath
    : typeof value.targetPath === 'string' ? value.targetPath : undefined
  if (!localPath || localPath.length > 4_096 || localPath.includes('\0') || typeof value.filename !== 'string' || value.filename.length > 1_024
    || typeof value.mediaType !== 'string' || value.mediaType.length > 256) return undefined
  /** 列表阶段使用 MIME 只识别媒体大类。 */
  const mediaKind = mediaKindFromType(value.mediaType)
  if (!mediaKind) return undefined
  return { localPath, filename: displayFilename(value.filename), mediaType: value.mediaType, mediaKind }
}

/** 从对象的已知结构化附件字段收集候选，不解析任何正文路径。 */
function appendAttachmentFields(value: unknown, candidates: Array<Omit<MediaSourceCandidate, 'identity'>>): void {
  if (!isRecord(value)) return
  for (const field of ['attachments', 'mediaAttachments', 'imageAttachments'] as const) {
    /** 当前字段可能由用户附件、通用媒体工具或旧图片工具持久化。 */
    const attachments = value[field]
    if (!Array.isArray(attachments)) continue
    if (attachments.length > MAX_SESSION_SOURCES) throw new Error('MEDIA_SOURCE_LIMIT_EXCEEDED')
    for (const attachment of attachments) {
      /** 单个通过字段与媒体类型校验的来源。 */
      const candidate = parseAttachment(attachment)
      if (candidate) candidates.push(candidate)
      if (candidates.length > MAX_RAW_SOURCE_ENTRIES) throw new Error('MEDIA_SOURCE_LIMIT_EXCEEDED')
    }
  }
}

/** 从当前会话的持久化消息提取唯一结构化媒体来源。 */
function collectSessionSources(messages: Array<AgentMessage | SDKMessage>): MediaSourceCandidate[] {
  if (messages.length > MAX_SOURCE_MESSAGES) throw new Error('MEDIA_SOURCE_LIMIT_EXCEEDED')
  /** 尚未去重的结构化附件。 */
  const candidates: Array<Omit<MediaSourceCandidate, 'identity'>> = []
  for (const message of messages) {
    if (isAgentMessage(message)) {
      appendAttachmentFields(message, candidates)
      for (const event of message.events ?? []) appendAttachmentFields(event, candidates)
      continue
    }
    if (message.type !== 'user') continue
    appendAttachmentFields(message, candidates)
    /** SDK user 消息的 message 可能携带用户附件及 tool_result 内容块。 */
    const payload = isRecord(message.message) ? message.message : undefined
    appendAttachmentFields(payload, candidates)
    /** SDK 内容块只读取结构化附件字段。 */
    const content = payload?.content
    if (Array.isArray(content)) {
      for (const block of content) {
        if (isRecord(block) && block.type === 'tool_result') appendAttachmentFields(block, candidates)
      }
    }
  }
  /** 以完整持久化附件事实去重，避免同一文件在兼容字段重复出现。 */
  const unique = new Map<string, MediaSourceCandidate>()
  for (const candidate of candidates) {
    const identity = createHash('sha256').update(JSON.stringify([
      candidate.localPath, candidate.filename, candidate.mediaType, candidate.mediaKind,
    ])).digest('hex')
    if (!unique.has(identity)) unique.set(identity, { ...candidate, identity })
    if (unique.size > MAX_SESSION_SOURCES) throw new Error('MEDIA_SOURCE_LIMIT_EXCEEDED')
  }
  return [...unique.values()]
}

/** 校验会话存在、仍属于项目，并执行 Host 的当前调用授权。 */
async function requireAuthorizedSession(
  dependencies: MediaSourceServiceDependencies,
  context: MediaSourceContext,
  action: 'list' | 'import',
): Promise<AgentSessionMeta> {
  await dependencies.authorize(context, action)
  /** 主进程会话索引中的实时会话。 */
  const session = dependencies.getSession(context.sessionId)
  if (!session) throw new Error('MEDIA_SOURCE_SESSION_NOT_FOUND')
  if (session.workspaceId !== context.projectId) throw new Error('MEDIA_SOURCE_PROJECT_MISMATCH')
  return session
}

/** 判断 sourceRef 是否为不含路径或控制字符的短 opaque token。 */
function isSafeSourceRef(sourceRef: unknown): sourceRef is string {
  return typeof sourceRef === 'string' && /^[A-Za-z0-9_.:-]{1,256}$/.test(sourceRef)
}

/** 判断 canonical 文件路径是否仍位于 Host 当前返回的任一授权根。 */
function isCurrentlyAuthorizedLocalPath(sourcePath: string, access: LocalMediaFileAccess): boolean {
  return access.allowedRoots.some((root) => {
    try {
      const canonicalRoot = realpathSync(resolve(root))
      const relativePath = relative(canonicalRoot, sourcePath)
      return relativePath === ''
        || (relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath))
    } catch {
      return false
    }
  })
}

/** 把底层路径错误收敛为 Agent 可稳定处理、且不包含本地路径的错误码。 */
function localSourceError(error: unknown): Error {
  const message = error instanceof Error ? error.message : ''
  if (/^MEDIA_[A-Z_]+/.test(message)) return error instanceof Error ? error : new Error(message)
  if (message.includes('不能超过')) return new Error('MEDIA_LOCAL_SOURCE_SIZE_LIMIT', { cause: error })
  if (message.includes('授权目录')) return new Error('MEDIA_LOCAL_SOURCE_NOT_AUTHORIZED', { cause: error })
  if (message.includes('符号链接') || message.includes('普通文件') || message.includes('身份') || message.includes('读取期间')) {
    return new Error('MEDIA_LOCAL_SOURCE_UNSAFE', { cause: error })
  }
  if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
    return new Error('MEDIA_LOCAL_SOURCE_NOT_FOUND', { cause: error })
  }
  return new Error('MEDIA_LOCAL_SOURCE_READ_FAILED', { cause: error })
}

/** 收敛正式资产文件解析错误，不把未授权本地路径带回 Agent。 */
function assetFileError(error: unknown): Error {
  const message = error instanceof Error ? error.message : ''
  if (message === 'MEDIA_ASSET_NOT_AUTHORIZED' || message === 'MEDIA_ASSET_CHANGED') {
    return error instanceof Error ? error : new Error(message)
  }
  if (message === 'MEDIA_ASSET_FILE_REVOKED') return error instanceof Error ? error : new Error(message)
  if (message.includes('授权目录') || message.includes('符号链接') || message.includes('普通文件')
    || message.includes('身份') || message.includes('读取期间') || message.includes('校验期间')) {
    return new Error('MEDIA_ASSET_FILE_NOT_AUTHORIZED', { cause: error })
  }
  return new Error('MEDIA_ASSET_FILE_UNAVAILABLE', { cause: error })
}

/** 从会话持久化附件安全导入统一项目资产。 */
export class MediaSourceService {
  private readonly createSourceRef: () => string
  private readonly grants = new Map<string, Map<string, MediaSourceCandidate>>()

  constructor(private readonly dependencies: MediaSourceServiceDependencies) {
    this.createSourceRef = dependencies.createSourceRef ?? randomUUID
  }

  /** 列出当前会话结构化媒体来源，并签发只存在于主进程内存的不透明引用。 */
  async listSources(context: MediaSourceContext): Promise<MediaSourceSummary[]> {
    await requireAuthorizedSession(this.dependencies, context, 'list')
    /** 当前会话持久化消息中的媒体事实。 */
    const candidates = collectSessionSources(this.dependencies.getMessages(context.sessionId))
    /** 本次列表替换同一上下文旧引用，避免来源撤销后旧 grant 长期存活。 */
    const contextGrants = new Map<string, MediaSourceCandidate>()
    /** 返回 Agent 的不透明摘要。 */
    const summaries = candidates.map((candidate): MediaSourceSummary => {
      let sourceRef: string | undefined
      for (let attempt = 0; attempt < 8; attempt += 1) {
        /** 候选引用只能是短、不含路径分隔符的非空字符串。 */
        const candidateRef = this.createSourceRef()
        if (isSafeSourceRef(candidateRef) && !contextGrants.has(candidateRef)) {
          sourceRef = candidateRef
          break
        }
      }
      if (!sourceRef) throw new Error('MEDIA_SOURCE_REF_GENERATION_FAILED')
      contextGrants.set(sourceRef, candidate)
      return { sourceRef, name: candidate.filename, mediaKind: candidate.mediaKind }
    })
    /** 刷新插入顺序，便于按上下文上限淘汰最旧 grant。 */
    const contextKey = `${context.projectId}\0${context.sessionId}`
    this.grants.delete(contextKey)
    this.grants.set(contextKey, contextGrants)
    while (this.grants.size > MAX_SOURCE_CONTEXTS) {
      /** Map 第一项为最久未重新列出的上下文。 */
      const oldest = this.grants.keys().next().value
      if (typeof oldest !== 'string') break
      this.grants.delete(oldest)
    }
    return summaries
  }

  /** 重新核对会话和来源后，从稳定 fd 逐个读取并登记项目资产。 */
  async importAssets(context: MediaSourceContext, sourceRefs: string[]): Promise<MediaAssetRef[]> {
    if (sourceRefs.length > MAX_IMPORT_SOURCES || new Set(sourceRefs).size !== sourceRefs.length
      || sourceRefs.some((sourceRef) => !isSafeSourceRef(sourceRef))) throw new Error('MEDIA_SOURCE_REF_INVALID')
    /** 即使空批次也必须经过 Host 的当前调用授权。 */
    await requireAuthorizedSession(this.dependencies, context, 'import')
    /** 只有最近由 listSources 为同一项目会话签发的引用有效。 */
    const contextKey = `${context.projectId}\0${context.sessionId}`
    const initialGrants = this.grants.get(contextKey)
    if (!initialGrants || sourceRefs.some((sourceRef) => !initialGrants.has(sourceRef))) throw new Error('MEDIA_SOURCE_REF_INVALID')
    /** 按请求顺序返回不可变项目资产引用。 */
    const assets: MediaAssetRef[] = []
    for (const sourceRef of sourceRefs) {
      /** 每个文件开始前重新授权并读取实时会话，避免批量等待期间沿用已撤销上下文。 */
      const session = await requireAuthorizedSession(this.dependencies, context, 'import')
      const contextGrants = this.grants.get(contextKey)
      if (!contextGrants) throw new Error('MEDIA_SOURCE_REF_INVALID')
      /** 引用对应的列表时来源事实。 */
      const granted = contextGrants.get(sourceRef)
      if (!granted) throw new Error('MEDIA_SOURCE_REF_INVALID')
      /** 每个文件使用 fresh 消息快照拒绝列表后已撤销或改写的附件。 */
      const freshSources = new Map(collectSessionSources(this.dependencies.getMessages(context.sessionId)).map((source) => [source.identity, source]))
      /** 导入时仍存在且字段完全一致的来源。 */
      const fresh = freshSources.get(granted.identity)
      if (!fresh) throw new Error('MEDIA_SOURCE_REVOKED')
      /** 统一附件解析器只决定路径语义，稳定 helper 再证明文件系统归属。 */
      const inputPath = this.dependencies.resolveAttachmentPath(fresh.localPath)
      const authorized = openAuthorizedAgentMediaSource({
        inputPath,
        baseDir: process.cwd(),
        allowedRoots: this.dependencies.getAllowedRoots(session, context.projectId),
        maxBytes: MAX_MEDIA_SOURCE_BYTES,
        label: '媒体',
      })
      try {
        /** 在同一稳定句柄上读取完整字节并复核 inode。 */
        const bytes = authorized.readBytes()
        /** 稳定内部身份用于资产层幂等，不向 Agent 暴露路径或 hash。 */
        const operationId = `source:${fresh.identity}`
        const mediaRunId = `source-${createHash('sha256').update(context.sessionId).digest('hex').slice(0, 40)}`
        const registeredAsset = await this.dependencies.assets.register(
          context.projectId,
          operationId,
          bytes,
          fresh.mediaType,
          { mediaRunId, sourceSessionId: context.sessionId },
        )
        /** register await 返回后再次复核权限、会话、grant 与消息事实。 */
        await requireAuthorizedSession(this.dependencies, context, 'import')
        const refreshedGrant = this.grants.get(contextKey)?.get(sourceRef)
        const refreshedSources = collectSessionSources(this.dependencies.getMessages(context.sessionId))
        if (refreshedGrant !== granted
          || !refreshedSources.some((candidate) => candidate.identity === granted.identity)) {
          throw new Error('MEDIA_SOURCE_REVOKED')
        }
        assets.push(registeredAsset)
      } finally {
        authorized.close()
      }
    }
    return assets
  }

  /** 从当前 Agent cwd 或已授权附加根导入一个明确本地文件，不扫描目录或持久化路径。 */
  async importLocalFile(context: MediaSourceContext, input: LocalMediaFileImportInput): Promise<MediaAssetRef> {
    if (typeof input.path !== 'string' || input.path.length === 0 || input.path.length > 4_096 || input.path.includes('\0')) {
      throw new Error('MEDIA_LOCAL_SOURCE_PATH_INVALID')
    }
    if (!['image', 'audio', 'video'].includes(input.mediaKind)) throw new Error('MEDIA_LOCAL_SOURCE_TYPE_INVALID')
    const session = await requireAuthorizedSession(this.dependencies, context, 'import')
    if (!this.dependencies.getLocalFileAccess) throw new Error('MEDIA_LOCAL_SOURCE_NOT_AVAILABLE')
    /** 首次 fresh access 决定相对路径解释与打开时根目录授权。 */
    const initialAccess = this.dependencies.getLocalFileAccess(session, context.projectId)
    let authorized: ReturnType<typeof openAuthorizedAgentMediaSource>
    try {
      authorized = openAuthorizedAgentMediaSource({
        inputPath: input.path,
        baseDir: initialAccess.baseDir,
        allowedRoots: initialAccess.allowedRoots,
        maxBytes: MAX_MEDIA_SOURCE_BYTES,
        label: '媒体',
      })
    } catch (error) {
      throw localSourceError(error)
    }
    try {
      let bytes: Uint8Array
      try { bytes = authorized.readBytes() } catch (error) { throw localSourceError(error) }
      /** 读取完成后 fresh-read Host 授权根，撤权必须发生在资产登记之前。 */
      const beforeRegisterSession = await requireAuthorizedSession(this.dependencies, context, 'import')
      const beforeRegisterAccess = this.dependencies.getLocalFileAccess(beforeRegisterSession, context.projectId)
      if (!isCurrentlyAuthorizedLocalPath(authorized.sourcePath, beforeRegisterAccess)) {
        throw new Error('MEDIA_LOCAL_SOURCE_REVOKED')
      }
      const contentHash = createHash('sha256').update(bytes).digest('hex')
      /** canonical path 只参与不可逆幂等键，不进入公共资产记录或工具结果。 */
      const operationHash = createHash('sha256').update(JSON.stringify([
        context.projectId, context.sessionId, authorized.sourcePath, contentHash, input.mediaKind,
      ])).digest('hex')
      const asset = await this.dependencies.assets.register(
        context.projectId,
        `local:${operationHash}`,
        bytes,
        null,
        {
          mediaRunId: `local-${createHash('sha256').update(context.sessionId).digest('hex').slice(0, 40)}`,
          sourceSessionId: context.sessionId,
        },
        input.mediaKind,
      )
      /** 资产层 await 返回后再次复核会话和本地根，避免撤权后向 Agent 返回可继续传播的引用。 */
      const afterRegisterSession = await requireAuthorizedSession(this.dependencies, context, 'import')
      const afterRegisterAccess = this.dependencies.getLocalFileAccess(afterRegisterSession, context.projectId)
      if (!isCurrentlyAuthorizedLocalPath(authorized.sourcePath, afterRegisterAccess)) {
        throw new Error('MEDIA_LOCAL_SOURCE_REVOKED')
      }
      return asset
    } finally {
      authorized.close()
    }
  }

  /** 将可信资产引用解析为当前 Agent 已有授权根内的单个文件，不新增目录授权。 */
  async getAssetFile(context: MediaSourceContext, asset: MediaAssetRef): Promise<MediaAssetFile> {
    const session = await requireAuthorizedSession(this.dependencies, context, 'list')
    const getRecord = this.dependencies.assets.getRecord
    const resolveAssetPath = this.dependencies.assets.resolveAssetPath
    if (!this.dependencies.getLocalFileAccess || !getRecord || !resolveAssetPath) {
      throw new Error('MEDIA_ASSET_FILE_UNAVAILABLE')
    }
    /** 资产层先验证项目、revision、hash 和媒体类型，再解析 Host 管理的正式路径。 */
    const record = getRecord.call(this.dependencies.assets, context.projectId, asset)
    const resolvedPath = resolveAssetPath.call(this.dependencies.assets, context.projectId, asset)
    const initialAccess = this.dependencies.getLocalFileAccess(session, context.projectId)
    let authorized: ReturnType<typeof openAuthorizedAgentMediaSource>
    try {
      authorized = openAuthorizedAgentMediaSource({
        inputPath: resolvedPath,
        baseDir: initialAccess.baseDir,
        allowedRoots: initialAccess.allowedRoots,
        maxBytes: MAX_MEDIA_SOURCE_BYTES,
        label: '媒体',
      })
    } catch (error) {
      throw assetFileError(error)
    }
    try {
      /** no-follow 稳定句柄完整读取并核对正式记录，防止路径解析后被置换。 */
      const pathBytes = authorized.readBytes()
      if (pathBytes.byteLength !== record.byteSize
        || createHash('sha256').update(pathBytes).digest('hex') !== record.hash) {
        throw new Error('MEDIA_ASSET_CHANGED')
      }
      /** 完整读取后 fresh 检查会话和授权根；撤权后不能返回可传播的本地路径。 */
      const refreshedSession = await requireAuthorizedSession(this.dependencies, context, 'list')
      const refreshedAccess = this.dependencies.getLocalFileAccess(refreshedSession, context.projectId)
      if (!isCurrentlyAuthorizedLocalPath(authorized.sourcePath, refreshedAccess)) {
        throw new Error('MEDIA_ASSET_FILE_REVOKED')
      }
      /** 再次解析权威记录，确保等待读取期间没有切换到另一正式文件。 */
      const refreshedPath = resolveAssetPath.call(this.dependencies.assets, context.projectId, asset)
      if (realpathSync(refreshedPath) !== authorized.sourcePath) throw new Error('MEDIA_ASSET_CHANGED')
      return { path: authorized.sourcePath, asset: structuredClone(asset), record: structuredClone(record) }
    } catch (error) {
      throw assetFileError(error)
    } finally {
      authorized.close()
    }
  }
}
