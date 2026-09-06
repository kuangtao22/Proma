import { createHash } from 'node:crypto'
import type { CanvasTrustedDirectoryCapability } from './canvas-document-store'
import {
  runStableDirectoryNative,
  type StableDirectoryAuthorization,
  type StableDirectoryNativeHost,
} from '../stable-directory-native-host'

/** 单次旧事务整理的默认条数上限，避免一次 LOAD 长时间占用 Canvas 写锁。 */
const DEFAULT_MAX_RECORDS_PER_PASS = 64
/** 单次旧事务整理的默认正文上限，限制峰值内存和原生进程 I/O。 */
const DEFAULT_MAX_BYTES_PER_PASS = 4 * 1024 * 1024
/** 归档目录固定名称，不接受业务输入覆盖。 */
const TRANSACTION_ARCHIVE_CHILD = 'transaction-archive' as const
/** 可由现有事务所有者解析的固定文件名前缀。 */
const TRANSACTION_FILE = /^(?:agent-node(?:-rebuild)?|content-node|canvas-batch|image-candidate-(?:batch|adoption)|artifact-export)-[A-Za-z0-9_-]{1,128}\.json$/

/** 活动扫描返回的单条稳定事务正文。 */
export interface CanvasTransactionEntry {
  name: string
  content: string
  /** 必须先于 active 移除持久化的精确幂等别名。 */
  aliases?: readonly string[]
}

/** 归档推进依赖的最小持久化边界。 */
export interface CanvasTransactionArchiveStorage {
  writeArchived(fileName: string, content: string): Promise<void>
  readArchived(fileName: string): Promise<string | null>
  removeActive(fileName: string, expectedContent: string): Promise<void>
}

/** 单次整理的固定资源预算。 */
export interface CanvasTransactionArchiveLimits {
  maxRecordsPerPass?: number
  maxBytesPerPass?: number
}

/** 事务归档对业务 Store 暴露的窄接口。 */
export interface CanvasTransactionArchive {
  archiveEntries(entries: readonly CanvasTransactionEntry[]): Promise<{ archivedCount: number; archivedBytes: number }>
  load(fileName: string): Promise<string | null>
}

/** 从事务文件名派生均匀、可重复且不暴露业务 ID 的两位分片。 */
function archiveShard(fileName: string): string {
  return createHash('sha256').update(fileName).digest('hex').slice(0, 2)
}

/** 批量工具调用的完整幂等身份。 */
export interface CanvasBatchReplayIdentity {
  sessionId: string
  runStartedAt: number
  toolCallId: string
}

/** 从完整 source 身份派生符合既有 intent 白名单的确定性 replay 文件名。 */
export function createCanvasBatchReplayArchiveName(source: CanvasBatchReplayIdentity): string {
  const hash = createHash('sha256').update(JSON.stringify([
    source.sessionId,
    source.runStartedAt,
    source.toolCallId,
  ])).digest('hex')
  const uuid = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`
  return `canvas-batch-${uuid}.json`
}

/** 判断未知值是否为普通记录。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/** 判断批量回滚是否已清理所有由本操作创建的资源。 */
function isBatchRollbackFullyCleaned(value: Record<string, unknown>): boolean {
  if (!Array.isArray(value.preparedResources)) return false
  return value.preparedResources.every((resource) => (
    isRecord(resource)
      && (resource.createdByOperation !== true || resource.state === 'cleaned')
  ))
}

/**
 * 保守判断事务能否离开活动恢复区。
 * @param fileName helper 已验证的固定事务文件名。
 * @param content 活动区稳定读取的 JSON 正文。
 * @returns 仅在没有未决副作用时返回 true。
 */
export function isCanvasTransactionArchivable(fileName: string, content: string): boolean {
  if (!TRANSACTION_FILE.test(fileName) || Buffer.byteLength(content, 'utf8') > 64 * 1024) return false
  let value: unknown
  try {
    value = JSON.parse(content) as unknown
  } catch {
    return false
  }
  if (!isRecord(value)) return false
  if (fileName.startsWith('agent-node-rebuild-')) return value.state === 'committed'
  if (fileName.startsWith('agent-node-')) return value.state === 'committed' || value.state === 'detached'
  if (fileName.startsWith('content-node-')) return value.state === 'committed'
  if (fileName.startsWith('canvas-batch-')) {
    return value.state === 'committed'
      || (value.state === 'rolled-back' && isBatchRollbackFullyCleaned(value))
  }
  if (fileName.startsWith('image-candidate-adoption-')) return value.state === 'batch-committed'
  if (fileName.startsWith('artifact-export-')) return value.state === 'completed'
  return fileName.startsWith('image-candidate-batch-')
    && (value.status === 'adopted' || value.status === 'abandoned')
}

/** 创建带固定条数与字节预算的事务归档器。 */
export function createCanvasTransactionArchive(
  storage: CanvasTransactionArchiveStorage,
  limits: CanvasTransactionArchiveLimits = {},
): CanvasTransactionArchive {
  const maxRecordsPerPass = limits.maxRecordsPerPass ?? DEFAULT_MAX_RECORDS_PER_PASS
  const maxBytesPerPass = limits.maxBytesPerPass ?? DEFAULT_MAX_BYTES_PER_PASS
  if (!Number.isSafeInteger(maxRecordsPerPass) || maxRecordsPerPass < 1
    || !Number.isSafeInteger(maxBytesPerPass) || maxBytesPerPass < 1) {
    throw new Error('CANVAS_TRANSACTION_ARCHIVE_LIMIT_INVALID')
  }
  return {
    archiveEntries: async (entries) => {
      let archivedCount = 0
      let archivedBytes = 0
      for (const entry of entries) {
        if (!isCanvasTransactionArchivable(entry.name, entry.content)) continue
        const bytes = Buffer.byteLength(entry.content, 'utf8')
        if (archivedCount >= maxRecordsPerPass || archivedBytes + bytes > maxBytesPerPass) break
        const archiveNames = [...entry.aliases ?? [], entry.name]
        for (const archiveName of archiveNames) {
          await storage.writeArchived(archiveName, entry.content)
          const readback = await storage.readArchived(archiveName)
          if (readback !== entry.content) throw new Error('CANVAS_TRANSACTION_ARCHIVE_READBACK_MISMATCH')
        }
        await storage.removeActive(entry.name, entry.content)
        archivedCount += 1
        archivedBytes += bytes
      }
      return { archivedCount, archivedBytes }
    },
    load: (fileName) => storage.readArchived(fileName),
  }
}

/** 生产 helper 所需的 Canvas 根能力子集。 */
interface CanvasTransactionArchiveDirectory {
  rootPath: string
  authorizeOpenedRoots: StableDirectoryAuthorization
  assertValid(): void
}

/**
 * 为同一次 Canvas LOAD capability 创建原生归档器。
 * @param directory 已授权 transactions 能力；rootPath 指向 Canvas 根。
 * @param nativeHost 测试可替换的原生 host，生产使用进程级默认预算。
 * @returns 只通过固定 archive 分片和 active 目录操作的归档器。
 */
export function createNativeCanvasTransactionArchive(
  directory: CanvasTransactionArchiveDirectory | CanvasTrustedDirectoryCapability,
  nativeHost?: Pick<StableDirectoryNativeHost, 'run'>,
): CanvasTransactionArchive {
  const run = nativeHost?.run ?? runStableDirectoryNative
  /** 每次原生请求前后复核调用方持有的同一目录能力。 */
  const execute = async (request: Parameters<typeof runStableDirectoryNative>[0]) => {
    directory.assertValid()
    const result = await run(request, directory.authorizeOpenedRoots)
    directory.assertValid()
    return result
  }
  return createCanvasTransactionArchive({
    writeArchived: async (fileName, content) => {
      const result = await execute({
        mode: 'canvas-content-write',
        roots: [directory.rootPath],
        childName: TRANSACTION_ARCHIVE_CHILD,
        entryId: archiveShard(fileName),
        fileName,
        content,
        maxEntries: 512,
      })
      if (!result.writeOutcome?.commitVisible) throw new Error('CANVAS_TRANSACTION_ARCHIVE_WRITE_FAILED')
    },
    readArchived: async (fileName) => {
      const result = await execute({
        mode: 'canvas-content-read',
        roots: [directory.rootPath],
        childName: TRANSACTION_ARCHIVE_CHILD,
        entryId: archiveShard(fileName),
        fileName,
      })
      if (!result.readOutcome || result.readOutcome.status === 'corrupt') {
        throw new Error('CANVAS_TRANSACTION_ARCHIVE_READ_FAILED')
      }
      return result.readOutcome.status === 'missing' ? null : result.readOutcome.content
    },
    removeActive: async (fileName, expectedContent) => {
      const result = await execute({
        mode: 'canvas-intent-remove',
        roots: [directory.rootPath],
        childName: 'transactions',
        fileName,
        content: expectedContent,
        maxEntries: 512,
      })
      if (!result.writeOutcome?.commitVisible) throw new Error('CANVAS_TRANSACTION_ARCHIVE_REMOVE_FAILED')
    },
  })
}
