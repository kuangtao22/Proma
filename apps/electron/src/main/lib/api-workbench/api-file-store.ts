import { createHash, randomUUID } from 'node:crypto'
import { readFileSync, realpathSync, statSync } from 'node:fs'
import { basename, extname } from 'node:path'
import { API_LIMITS } from '@proma/shared'
import type { ApiAttachmentSummary, ApiFilePart } from '@proma/shared'

/** 主进程内存里的一条文件引用：**真实路径只存在于这里**，不落盘、不出主进程。 */
interface StoredFile {
  ref: string
  realPath: string
  fileName: string
  sizeBytes: number
  contentType: string
  /** 注册时的 inode 与时间戳，用于读取前复核文件没有被换掉。 */
  device: number
  inode: number
  mtimeMs: number
  registeredAt: number
}

/** 回传给界面或审批卡的文件元数据；不含路径。 */
export interface ApiPickedFileMeta {
  ref: string
  fileName: string
  sizeBytes: number
  contentType: string
}

/** 扩展名到 Content-Type 的最小映射；未命中按二进制流处理。 */
const CONTENT_TYPES: Record<string, string> = {
  '.txt': 'text/plain', '.json': 'application/json', '.csv': 'text/csv', '.xml': 'application/xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.pdf': 'application/pdf', '.zip': 'application/zip', '.gz': 'application/gzip', '.tar': 'application/x-tar',
  '.mp4': 'video/mp4', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
}

/** 稳定的文件错误码；界面与 Agent 据此给出可行动提示。 */
function fail(code: string, message: string): never {
  throw new Error(`${code}: ${message}`)
}

/** 文件名只保留可安全放进 Content-Disposition 与界面的字符。 */
function safeFileName(path: string): string {
  return basename(path).replace(/[\r\n\x00]/g, '').slice(0, 256) || 'file'
}

/**
 * 待上传文件的引用仓库。
 *
 * 设计约束（与 secret 同一套模型）：
 * - 路径只存在主进程内存，服务重启即失效；失效后必须 fail closed，不能发出没有附件的请求。
 * - 只接受常规文件；符号链接按 `realpath` 展开，目录/FIFO/设备/悬空链接一律拒绝。
 * - 读取前复核 inode 与时间戳，文件被换掉或改过即拒绝，避免「批准的是 A、发出的是 B」。
 */
export class ApiFileStore {
  private readonly options: { now?: () => number; uuid?: () => string; maxBytes?: number; maxFiles?: number }
  private readonly files = new Map<string, StoredFile>()

  constructor(options: { now?: () => number; uuid?: () => string; maxBytes?: number; maxFiles?: number } = {}) {
    this.options = options
  }

  /** 工作区隔离的存储键。 */
  private key(workspaceId: string, ref: string): string {
    return `${workspaceId}\u0000${ref}`
  }

  /** 当前 workspace 已登记的文件数量。 */
  private count(workspaceId: string): number {
    return [...this.files.keys()].filter((key) => key.startsWith(`${workspaceId}\u0000`)).length
  }

  /**
   * 登记一个**由用户显式选择**的文件。
   *
   * 只有主进程的原生对话框回调与（B12b 的）Agent 审批通过后的登记会调用它；渲染层与模型都不传路径。
   * @param workspaceId 归属工作区。
   * @param path 用户选择的路径（可为符号链接，按真实路径展开）。
   * @returns 可放进请求定义的文件元数据（不含路径）。
   */
  register(workspaceId: string, path: string): ApiPickedFileMeta {
    /** 悬空符号链接会在 realpath 阶段失败，这里必须直接拒绝。 */
    let realPath: string
    try {
      realPath = realpathSync(path)
    } catch {
      fail('API_WORKBENCH_FILE_MISSING', '文件不存在或无法解析真实路径')
    }
    let stat: ReturnType<typeof statSync>
    try {
      stat = statSync(realPath)
    } catch {
      fail('API_WORKBENCH_FILE_MISSING', '文件不可读')
    }
    /** 目录、FIFO、设备等一律不接受：只上传常规文件。 */
    if (!stat.isFile()) fail('API_WORKBENCH_FILE_INVALID_TYPE', '只支持常规文件，目录与特殊文件不可上传')
    const maxBytes = this.options.maxBytes ?? API_LIMITS.bodyBytes
    if (stat.size > maxBytes) fail('API_WORKBENCH_FILE_TOO_LARGE', `文件超过单次上传上限（${maxBytes} 字节）`)
    if (this.count(workspaceId) >= (this.options.maxFiles ?? API_LIMITS.maxFileParts)) fail('API_WORKBENCH_FILE_LIMIT', '本次请求可携带的文件数量已达上限')
    /** 引用身份必须满足共享 ID 白名单，便于它直接进入请求定义。 */
    const ref = `file_${(this.options.uuid?.() ?? randomUUID()).replaceAll('-', '')}`
    const fileName = safeFileName(realPath)
    const contentType = CONTENT_TYPES[extname(realPath).toLowerCase()] ?? 'application/octet-stream'
    this.files.set(this.key(workspaceId, ref), {
      ref, realPath, fileName, sizeBytes: stat.size, contentType,
      device: stat.dev, inode: stat.ino, mtimeMs: stat.mtimeMs,
      registeredAt: this.options.now?.() ?? Date.now(),
    })
    return { ref, fileName, sizeBytes: stat.size, contentType }
  }

  /** 查询引用元数据；失效引用返回 undefined（调用方据此 fail closed）。 */
  metadata(workspaceId: string, ref: string): ApiPickedFileMeta | undefined {
    const stored = this.files.get(this.key(workspaceId, ref))
    if (!stored) return undefined
    return { ref: stored.ref, fileName: stored.fileName, sizeBytes: stored.sizeBytes, contentType: stored.contentType }
  }

  /**
   * 读取一条引用的真实路径与大小，**只给（B12b 的）审批快照用**。
   *
   * 约束：路径因此只存在于「审批快照 + 本仓库」两处，既不进请求定义、也不进运行记录与模型上下文。
   * @param workspaceId 归属工作区。
   * @param ref 文件引用。
   * @returns 真实路径与大小；引用失效时返回 undefined。
   */
  locate(workspaceId: string, ref: string): { path: string; sizeBytes: number } | undefined {
    const stored = this.files.get(this.key(workspaceId, ref))
    if (!stored) return undefined
    return { path: stored.realPath, sizeBytes: stored.sizeBytes }
  }

  /**
   * 释放一批引用，供「登记后准备失败」回滚使用，避免失败的准备长期占满文件槽位。
   *
   * 只用于回滚尚未进入任何请求定义的引用；已经被保存的请求定义仍然按既有失效语义处理。
   * @param workspaceId 归属工作区。
   * @param refs 需要释放的引用。
   * @returns 实际释放的条数（未知引用与跨工作区引用都不计数）。
   */
  release(workspaceId: string, refs: readonly string[]): number {
    let removed = 0
    for (const ref of refs) {
      if (this.files.delete(this.key(workspaceId, ref))) removed += 1
    }
    return removed
  }

  /**
   * 读取一个已登记文件的字节与摘要。
   *
   * 只有**真正派发**（人点发送，或 Agent 拿到批准后调用 send）才会走到这里：
   * 准备阶段只做 realpath + stat，所以批准之前不会读到任何文件内容。
   * @param workspaceId 归属工作区。
   * @param ref 文件引用。
   * @returns 文件字节、sha256 与可供记录展示的摘要。
   */
  read(workspaceId: string, ref: string): { bytes: Buffer; sha256: string; summary: Omit<ApiAttachmentSummary, 'field'> } {
    const stored = this.files.get(this.key(workspaceId, ref))
    if (!stored) fail('API_WORKBENCH_FILE_REF_NOT_FOUND', '所选文件已失效（应用重启或引用被清理），请重新选择文件')
    let stat: ReturnType<typeof statSync>
    try {
      stat = statSync(stored.realPath)
    } catch {
      fail('API_WORKBENCH_FILE_UNREADABLE', '所选文件已不存在或不可读，请重新选择文件')
    }
    /** 文件被替换或改过就拒绝：批准/选择的是当时那个文件。 */
    if (!stat.isFile() || stat.dev !== stored.device || stat.ino !== stored.inode || stat.size !== stored.sizeBytes || stat.mtimeMs !== stored.mtimeMs) {
      fail('API_WORKBENCH_FILE_CHANGED', '所选文件在选择之后发生了变化，请重新选择文件')
    }
    let bytes: Buffer
    try {
      bytes = readFileSync(stored.realPath)
    } catch {
      fail('API_WORKBENCH_FILE_UNREADABLE', '读取文件失败，请检查权限后重新选择')
    }
    /** 摘要同时用于运行记录展示，因此这里一次算好。 */
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    return { bytes, sha256, summary: { fileName: stored.fileName, sizeBytes: stored.sizeBytes, sha256 } }
  }

  /** 组装请求定义里的文件部分；引用失效时返回 undefined。 */
  part(workspaceId: string, ref: string, id: string, field: string): ApiFilePart | undefined {
    const meta = this.metadata(workspaceId, ref)
    if (!meta) return undefined
    return { id, name: field, fileName: meta.fileName, sizeBytes: meta.sizeBytes, contentType: meta.contentType, ref: meta.ref }
  }

  /** 清空一个 workspace 或全部引用；服务关闭与工作区清理时调用。 */
  clear(workspaceId?: string): number {
    if (workspaceId === undefined) {
      const removed = this.files.size
      this.files.clear()
      return removed
    }
    let removed = 0
    for (const key of [...this.files.keys()]) {
      if (!key.startsWith(`${workspaceId}\u0000`)) continue
      this.files.delete(key)
      removed += 1
    }
    return removed
  }
}
