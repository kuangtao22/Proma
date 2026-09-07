import { createHash, randomUUID } from 'node:crypto'
import { linkSync, readFileSync, unlinkSync } from 'node:fs'
import { writeJsonFileAtomic } from '../safe-file'

/** 不可变的进程锁身份，token 用于为已退出 owner 派生唯一后继。 */
interface MediaLockClaim { version: 1; pid: number; token: string }

/** 保守检测 PID；无权限检查或 PID 被复用时仍认为活跃。 */
function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

/** 严格解析已完整发布的 owner claim。 */
function readClaim(path: string): MediaLockClaim {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as Partial<MediaLockClaim>
    if (value.version !== 1 || !Number.isSafeInteger(value.pid) || Number(value.pid) <= 0
      || typeof value.token !== 'string' || !/^[A-Za-z0-9-]{1,128}$/.test(value.token)
      || Object.keys(value).length !== 3) throw new Error()
    return { version: 1, pid: Number(value.pid), token: value.token }
  } catch { throw new Error('MEDIA_FILE_BUSY') }
}

/**
 * 取得跨进程独占权，返回幂等释放函数。
 * 已退出 owner 的 claim 永不删除；所有恢复者沿相同前驱竞争唯一后继，
 * 从而避免检查陈旧锁后误删新 owner。原子 link 只发布已完整写入的记录。
 */
export function acquireMediaFileLock(lockPath: string): () => void {
  const claim: MediaLockClaim = { version: 1, pid: process.pid, token: randomUUID() }
  const temporary = `${lockPath}.owner-${claim.token}`
  writeJsonFileAtomic(temporary, claim)
  let path = lockPath
  try {
    for (let depth = 0; depth < 256; depth += 1) {
      try {
        linkSync(temporary, path)
        let released = false
        return () => {
          if (released) return
          if (readClaim(path).token !== claim.token) throw new Error('MEDIA_FILE_OWNERSHIP_LOST')
          unlinkSync(path)
          released = true
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        const owner = readClaim(path)
        if (isAlive(owner.pid)) throw new Error('MEDIA_FILE_BUSY')
        path = `${lockPath}.claim-${createHash('sha256').update(path).update('\0').update(owner.token).digest('hex')}`
      }
    }
    throw new Error('MEDIA_LOCK_RECOVERY_LIMIT')
  } finally { unlinkSync(temporary) }
}
