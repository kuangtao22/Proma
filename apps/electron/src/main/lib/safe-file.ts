/**
 * 崩溃安全的 JSON 文件读写工具
 *
 * 解决系统强制关机/崩溃时 JSON 索引文件被截断导致数据丢失的问题。
 * - 写入：write-to-temp → rename（POSIX 原子操作）+ .bak 备份
 * - 读取：主文件 → .tmp 残留 → .bak 回退，多层容错
 */

import { writeFileSync, renameSync, existsSync, copyFileSync, readFileSync, unlinkSync } from 'node:fs'

/** 安全 JSON 读取的可选 schema 校验配置。 */
export interface ReadJsonFileSafeOptions<T> {
  /** 判断解析结果是否符合调用方要求的运行时 schema。 */
  validate?: (value: unknown) => value is T
}

/**
 * 原子写入 JSON 文件：write-to-temp → rename
 * 写入前自动保留 .bak 备份
 */
export function writeJsonFileAtomic(filePath: string, data: object, skipBackup = false): void {
  const tmpPath = filePath + '.tmp'
  const bakPath = filePath + '.bak'

  // 备份当前文件（如果存在且可读）
  if (!skipBackup && existsSync(filePath)) {
    try {
      copyFileSync(filePath, bakPath)
    } catch {
      // 备份失败不阻塞写入
    }
  }

  // 写入临时文件
  writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8')

  // 原子重命名（POSIX rename 是原子操作）
  renameSync(tmpPath, filePath)
}

/** 原子重写文本文件（用于 JSONL 会话等非单个 JSON 文档）。 */
export function writeTextFileAtomic(filePath: string, content: string): void {
  const tmpPath = filePath + '.tmp'
  writeFileSync(tmpPath, content, 'utf-8')
  renameSync(tmpPath, filePath)
}

/**
 * 安全读取 JSON 索引文件
 * 优先读主文件，语法或 schema 无效时尝试 .tmp / .bak，都失败返回 null。
 *
 * @param filePath 主 JSON 文件路径。
 * @param options 可选的运行时 schema validator；省略时保持原有 parse-only 行为。
 * @returns 第一个有效候选，全部无效时返回 null。
 */
export function readJsonFileSafe<T>(filePath: string, options: ReadJsonFileSafeOptions<T> = {}): T | null {
  /** 上次原子写可能遗留的临时文件路径。 */
  const tmpPath = filePath + '.tmp'
  /** 上次成功主文件的备份路径。 */
  const bakPath = filePath + '.bak'

  // 1. 尝试读取主文件
  if (existsSync(filePath)) {
    /** 主文件是否成功读取并解析为 JSON。 */
    let parsedPrimary = false
    /** 主文件解析后的未知值，仅在 parsedPrimary 为 true 时校验。 */
    let primaryValue: unknown
    try {
      const raw = readFileSync(filePath, 'utf-8')
      if (raw.trim().length > 0) {
        primaryValue = JSON.parse(raw)
        parsedPrimary = true
      }
    } catch {
      console.warn(`[数据恢复] 主索引文件损坏: ${filePath}`)
    }
    if (parsedPrimary && isAcceptedJsonValue(primaryValue, options.validate)) {
      return primaryValue
    }
  }

  // 2. 检查是否有未完成的 .tmp 文件（上次 rename 前崩溃）
  if (existsSync(tmpPath)) {
    /** 临时文件是否成功读取并解析为 JSON。 */
    let parsedTmp = false
    /** 临时文件解析后的未知值，仅在 parsedTmp 为 true 时校验。 */
    let tmpValue: unknown
    try {
      const raw = readFileSync(tmpPath, 'utf-8')
      if (raw.trim().length > 0) {
        tmpValue = JSON.parse(raw)
        parsedTmp = true
      }
    } catch {
      // .tmp 也损坏，继续 fallback
    }
    if (parsedTmp && isAcceptedJsonValue(tmpValue, options.validate)) {
      // .tmp 有效 → 提升为主文件；提升失败必须保留 tmp 并向上传播。
      renameSync(tmpPath, filePath)
      console.log(`[数据恢复] 从 .tmp 文件恢复: ${filePath}`)
      return tmpValue
    }
    // 清理无效的 .tmp
    try { unlinkSync(tmpPath) } catch { /* ignore */ }
  }

  // 3. Fallback 到 .bak
  if (existsSync(bakPath)) {
    /** 备份文件是否成功读取并解析为 JSON。 */
    let parsedBackup = false
    /** 备份文件解析后的未知值，仅在 parsedBackup 为 true 时校验。 */
    let backupValue: unknown
    try {
      const raw = readFileSync(bakPath, 'utf-8')
      if (raw.trim().length > 0) {
        backupValue = JSON.parse(raw)
        parsedBackup = true
      }
    } catch {
      console.error(`[数据恢复] .bak 文件也损坏: ${bakPath}`)
    }
    if (parsedBackup && isAcceptedJsonValue(backupValue, options.validate)) {
      // 用 .bak 恢复主文件；恢复失败必须原样向上传播。
      writeJsonFileAtomic(filePath, backupValue as object, true)
      console.log(`[数据恢复] 从 .bak 文件恢复: ${filePath}`)
      return backupValue
    }
  }

  return null // 全部失败，需要上层从 JSONL 重建
}

/**
 * 判断解析后的 JSON 是否满足可选 schema。
 *
 * @param value JSON.parse 返回的未知值。
 * @param validate 调用方可选的类型守卫。
 * @returns 未提供 validator 或校验通过时返回 true。
 */
function isAcceptedJsonValue<T>(
  value: unknown,
  validate: ReadJsonFileSafeOptions<T>['validate'],
): value is T {
  return validate === undefined || validate(value)
}
