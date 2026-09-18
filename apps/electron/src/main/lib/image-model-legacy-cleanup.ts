/**
 * 旧渠道型生图条目的一次性清理迁移。
 *
 * 生图已改为独立供应商配置，统一媒体目录里 `mediaKind=image && protocol=openai-images`
 * 的旧条目不再被任何界面使用。升级后由主进程自动清理一次：
 * 先把待删条目写入备份文件（保证可恢复），再通过目录自身的 revision CAS 移除，
 * 最后写标记文件保证只跑一次；任何失败都只记录日志，绝不阻塞启动。
 */
import { existsSync } from 'node:fs'
import type { MediaApiModelCatalogEntry, MediaApiModelCatalogResult, MediaApiModelProfile } from '@proma/shared'
import { writeJsonFileAtomic } from './safe-file'

/** 需要清理的旧条目：统一媒体目录里借用渠道凭据的生图条目。 */
function isLegacyImageEntry(entry: MediaApiModelCatalogEntry): boolean {
  return entry.profile.mediaKind === 'image' && entry.profile.protocol === 'openai-images'
}

export interface ImageModelLegacyCleanupOptions {
  /** 一次性标记文件路径；存在即视为已执行过。 */
  markerPath: string
  /** 备份文件路径，保存被移除的旧条目。 */
  backupPath: string
  /** 读取统一媒体目录。 */
  listCatalog: () => MediaApiModelCatalogResult
  /** 以 revision CAS 写回剩余条目。 */
  replaceProfiles: (profiles: MediaApiModelProfile[], expectedRevision: number) => MediaApiModelCatalogResult
  /** 可替换时钟，便于测试断言迁移时间。 */
  now?: () => number
}

/** 清理结果，供启动日志与测试断言。 */
export type ImageModelLegacyCleanupOutcome =
  | { status: 'skipped' }
  | { status: 'clean' }
  | { status: 'cleaned'; count: number }
  | { status: 'failed'; message: string }

/** 执行一次性清理；同一进程内可重复调用，但只会真正清理一次。 */
export function runImageModelLegacyCleanup(options: ImageModelLegacyCleanupOptions): ImageModelLegacyCleanupOutcome {
  try {
    /** 已执行过就不再读取或改写目录。 */
    if (existsSync(options.markerPath)) return { status: 'skipped' }
    const catalog = options.listCatalog()
    const legacyEntries = catalog.entries.filter(isLegacyImageEntry)
    const migratedAt = (options.now ?? Date.now)()
    if (legacyEntries.length === 0) {
      writeJsonFileAtomic(options.markerPath, { migratedAt, cleaned: 0 })
      return { status: 'clean' }
    }
    /** 先备份：只有备份写入成功才继续删除。 */
    writeJsonFileAtomic(options.backupPath, {
      migratedAt,
      entries: legacyEntries.map((entry) => entry.profile),
    })
    /** 剩余条目按原顺序回写，revision 由上层 CAS 保证不覆盖并发修改。 */
    const remaining = catalog.entries.filter((entry) => !isLegacyImageEntry(entry)).map((entry) => entry.profile)
    options.replaceProfiles(remaining, catalog.revision)
    writeJsonFileAtomic(options.markerPath, {
      migratedAt,
      cleaned: legacyEntries.length,
      backupPath: options.backupPath,
    })
    return { status: 'cleaned', count: legacyEntries.length }
  } catch (error) {
    /** 失败不写标记，下次启动重试；错误只留在日志。 */
    return { status: 'failed', message: error instanceof Error ? error.message : 'unknown' }
  }
}
