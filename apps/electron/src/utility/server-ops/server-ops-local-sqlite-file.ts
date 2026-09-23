import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { isServerOpsLocalSqliteFilePath } from '@proma/shared'

/** SQLite 标准文件头，仅需读取 16 字节即可排除普通文件。 */
const SQLITE_HEADER = Buffer.from('SQLite format 3\0', 'ascii')

/** 验证后的真实文件路径和稳定身份，不包含数据库内容。 */
export interface ServerOpsLocalSqliteFile {
  /** 解析符号链接后的本机绝对路径。 */
  filePath: string
  /** 设备、inode 和创建时间；正常内容更新不改变该身份。 */
  localFileId: string
}

/**
 * 校验本地 SQLite 文件并返回可持久化的稳定身份。
 * @param filePath 用户选择的绝对文件路径
 * @param expectedId 已保存的文件身份；提供时文件替换必须报错
 * @returns 规范路径与文件身份；不创建文件、不读取业务数据
 */
export function inspectServerOpsLocalSqliteFile(filePath: string, expectedId?: string): ServerOpsLocalSqliteFile {
  if (!isServerOpsLocalSqliteFilePath(filePath) || !isAbsolute(filePath)) throw new Error('SERVER_OPS_SQLITE_PATH_INVALID')
  /** 文件描述符只保留到头部和身份校验完成。 */
  let descriptor: number | undefined
  try {
    /** 将用户选择固定为实际目标，后续读取不再跟随同名替换。 */
    const canonicalPath = realpathSync(filePath)
    const pathState = lstatSync(canonicalPath, { bigint: true })
    if (!pathState.isFile()) throw new Error('SERVER_OPS_SQLITE_FILE_NOT_REGULAR')
    descriptor = openSync(canonicalPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
    /** 打开的真实文件状态，防止路径检查和打开之间发生替换。 */
    const opened = fstatSync(descriptor, { bigint: true })
    if (!opened.isFile()) throw new Error('SERVER_OPS_SQLITE_FILE_NOT_REGULAR')
    const localFileId = `${opened.dev}:${opened.ino}:${opened.birthtimeNs}`
    if (opened.dev !== pathState.dev || opened.ino !== pathState.ino || opened.birthtimeNs !== pathState.birthtimeNs
      || (expectedId !== undefined && expectedId !== localFileId)) throw new Error('SERVER_OPS_SQLITE_FILE_CHANGED')
    /** 固定大小缓冲区，绝不把整个数据库载入内存。 */
    const header = Buffer.alloc(SQLITE_HEADER.length)
    if (readSync(descriptor, header, 0, header.length, 0) !== header.length || !header.equals(SQLITE_HEADER)) {
      throw new Error('SERVER_OPS_SQLITE_DATABASE_INVALID')
    }
    /** 校验过程中发生的路径重定向同样不能沿用先前身份。 */
    const after = lstatSync(canonicalPath, { bigint: true })
    if (!after.isFile() || after.dev !== opened.dev || after.ino !== opened.ino || after.birthtimeNs !== opened.birthtimeNs
      || realpathSync(filePath) !== canonicalPath) throw new Error('SERVER_OPS_SQLITE_FILE_CHANGED')
    return { filePath: canonicalPath, localFileId }
  } catch (error) {
    /** 操作系统异常只输出固定机器码，避免公开原始路径与内容。 */
    const code = error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined
    if (code === 'ENOENT' || code === 'ENOTDIR') throw new Error('SERVER_OPS_SQLITE_FILE_NOT_FOUND')
    if (code === 'EACCES' || code === 'EPERM') throw new Error('SERVER_OPS_SQLITE_LOCAL_FILE_PERMISSION_DENIED')
    if (code === 'ELOOP') throw new Error('SERVER_OPS_SQLITE_FILE_CHANGED')
    if (error instanceof Error && error.message.startsWith('SERVER_OPS_SQLITE_')) throw error
    throw new Error('SERVER_OPS_SQLITE_FILE_UNAVAILABLE')
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
  }
}
