import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, join } from 'node:path'
import { MAX_ATTACHMENT_SIZE } from '@proma/shared'
import type {
  AgentMediaAttachment,
  AgentSessionMeta,
  AgentWorkspace,
} from '@proma/shared'

/** 单条用户消息允许固化的媒体附件数量上限。 */
const MAX_MEDIA_ATTACHMENTS = 32
/** 发送边界接受的图片、音频和视频 MIME 语法。 */
const MEDIA_TYPE_PATTERN = /^(image|audio|video)\/[A-Za-z0-9.+-]{1,127}$/

/** 稳定打开后的附件来源；调用方必须关闭句柄。 */
export interface PreparedAgentMediaSource {
  sourcePath: string
  byteSize: number
  readBytes(): Buffer
  close(): void
}

/** Agent 媒体附件固化所需的 Host 权威依赖。 */
export interface AgentMediaAttachmentPreparationDependencies {
  getSession(sessionId: string): AgentSessionMeta | undefined
  getWorkspace(workspaceId: string): AgentWorkspace | undefined
  getAllowedRoots(session: AgentSessionMeta, workspace: AgentWorkspace): string[]
  getSessionAttachmentsDirectory(session: AgentSessionMeta, workspace: AgentWorkspace): string
  openSource(input: {
    inputPath: string
    allowedRoots: string[]
    maxBytes: number
  }): PreparedAgentMediaSource
}

/** 允许通过发送边界进入 Host 的最小附件输入。 */
export interface AgentMediaAttachmentInput {
  sessionId: string
  workspaceId?: string
  mediaAttachments?: AgentMediaAttachment[]
}

/** 判断未知值是否为普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** 清理附件展示名，避免控制字符或路径片段进入会话目录。 */
function sanitizeFilename(filename: string): string {
  const safe = basename(filename.replace(/\\/g, '/'))
    .replace(/[\u0000-\u001F\u007F]/g, '_')
    .replace(/[^A-Za-z0-9._\-\u4E00-\u9FFF]/g, '_')
    .slice(0, 160)
  return safe && safe !== '.' && safe !== '..' ? safe : 'media'
}

/** 严格解析公开附件合同，拒绝从正文或展示快照补齐字段。 */
function parseMediaAttachment(value: unknown): AgentMediaAttachment {
  if (!isRecord(value)
    || typeof value.filename !== 'string'
    || value.filename.length < 1
    || value.filename.length > 1_024
    || typeof value.mediaType !== 'string'
    || !MEDIA_TYPE_PATTERN.test(value.mediaType)
    || typeof value.size !== 'number'
    || !Number.isSafeInteger(value.size)
    || value.size < 0
    || value.size > MAX_ATTACHMENT_SIZE
    || typeof value.targetPath !== 'string'
    || value.targetPath.length < 1
    || value.targetPath.length > 4_096
    || value.targetPath.includes('\0')) {
    throw new Error('AGENT_MEDIA_ATTACHMENT_INVALID')
  }
  return {
    filename: sanitizeFilename(value.filename),
    mediaType: value.mediaType,
    size: value.size,
    targetPath: value.targetPath,
  }
}

/** 将稳定读取的字节原子写入当前会话附件目录。 */
function persistStableMedia(
  attachmentsDirectory: string,
  attachment: AgentMediaAttachment,
  bytes: Buffer,
): AgentMediaAttachment {
  mkdirSync(attachmentsDirectory, { recursive: true })
  const canonicalDirectory = realpathSync(attachmentsDirectory)
  const hash = createHash('sha256').update(bytes).digest('hex')
  const targetPath = join(canonicalDirectory, `media-${hash.slice(0, 32)}-${attachment.filename}`)
  if (existsSync(targetPath)) {
    const existing = readFileSync(targetPath)
    if (existing.byteLength !== bytes.byteLength
      || createHash('sha256').update(existing).digest('hex') !== hash) {
      throw new Error('AGENT_MEDIA_ATTACHMENT_COLLISION')
    }
  } else {
    const temporaryPath = join(canonicalDirectory, `.media-${randomUUID()}.tmp`)
    try {
      writeFileSync(temporaryPath, bytes, { flag: 'wx', mode: 0o600 })
      renameSync(temporaryPath, targetPath)
      chmodSync(targetPath, 0o600)
    } finally {
      if (existsSync(temporaryPath)) unlinkSync(temporaryPath)
    }
  }
  return {
    filename: attachment.filename,
    mediaType: attachment.mediaType,
    size: bytes.byteLength,
    targetPath: realpathSync(targetPath),
  }
}

/**
 * 在消息运行或进入 deferred queue 前，将显式媒体附件固化到当前会话目录。
 * @param input Renderer 或历史重试提交的结构化消息。
 * @param dependencies 当前 Host 会话、项目、授权根与稳定文件读取能力。
 * @returns 仅替换 mediaAttachments 的新输入；缺少字段时保持原对象以兼容旧发送。
 */
export function prepareAgentMediaAttachmentsForSend<T extends AgentMediaAttachmentInput>(
  input: T,
  dependencies: AgentMediaAttachmentPreparationDependencies,
): T {
  if (!Object.prototype.hasOwnProperty.call(input, 'mediaAttachments')) return input
  const rawAttachments = (input as { mediaAttachments?: unknown }).mediaAttachments
  if (!Array.isArray(rawAttachments) || rawAttachments.length > MAX_MEDIA_ATTACHMENTS) {
    throw new Error('AGENT_MEDIA_ATTACHMENT_INVALID')
  }
  if (rawAttachments.length === 0) return { ...input, mediaAttachments: [] }

  const session = dependencies.getSession(input.sessionId)
  if (!session?.workspaceId) throw new Error('AGENT_MEDIA_SESSION_NOT_FOUND')
  if (input.workspaceId !== undefined && input.workspaceId !== session.workspaceId) {
    throw new Error('AGENT_MEDIA_PROJECT_MISMATCH')
  }
  const workspace = dependencies.getWorkspace(session.workspaceId)
  if (!workspace) throw new Error('AGENT_MEDIA_PROJECT_MISMATCH')
  const allowedRoots = dependencies.getAllowedRoots(session, workspace)
  const attachmentsDirectory = dependencies.getSessionAttachmentsDirectory(session, workspace)
  /** 每项先稳定读取并核对声明大小，再写入受控目录。 */
  const prepared = rawAttachments.map((value): AgentMediaAttachment => {
    const attachment = parseMediaAttachment(value)
    const source = dependencies.openSource({
      inputPath: attachment.targetPath,
      allowedRoots,
      maxBytes: MAX_ATTACHMENT_SIZE,
    })
    try {
      if (source.byteSize !== attachment.size) throw new Error('AGENT_MEDIA_ATTACHMENT_CHANGED')
      const bytes = source.readBytes()
      if (bytes.byteLength !== attachment.size) throw new Error('AGENT_MEDIA_ATTACHMENT_CHANGED')
      return persistStableMedia(attachmentsDirectory, attachment, bytes)
    } finally {
      source.close()
    }
  })
  return { ...input, workspaceId: session.workspaceId, mediaAttachments: prepared }
}
