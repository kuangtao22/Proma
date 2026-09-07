import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { removeFileAtomic, writeJsonFileAtomicSecure } from '../safe-file'
import { readMediaJsonFile } from './media-json-file'

/** 单个快照文件的上限，避免远端目录异常膨胀占满本地磁盘或内存。 */
const maximumSnapshotBytes = 16 * 1024 * 1024
/** 连接、来源与工作流变体只保留最近一批，防止历史身份无限累积。 */
const maximumSnapshotFiles = 256
const snapshotFilePattern = /^[a-f0-9]{64}\.json$/

interface SnapshotEnvelope {
  schemaVersion: 1
  keyHash: string
  payload: unknown
  checksum: string
}

interface SnapshotFile {
  name: string
  modifiedAt: number
  device: number
  inode: number
}

interface JsonValidationFrame {
  value: unknown
  leave: boolean
}

/** 计算快照身份与内容摘要；磁盘只保存摘要，不保存可能包含凭据的原始身份。 */
function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/** 仅接受不含 getter、特殊原型、循环引用或非有限数字的普通 JSON 值。 */
function assertPlainJson(value: unknown): void {
  const pending: JsonValidationFrame[] = [{ value, leave: false }]
  const ancestors = new WeakSet<object>()
  while (pending.length > 0) {
    const frame = pending.pop()!
    const current = frame.value
    if (frame.leave) {
      ancestors.delete(current as object)
      continue
    }
    if (current === null || typeof current === 'string' || typeof current === 'boolean') continue
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) throw new Error('MEDIA_RESOURCE_SNAPSHOT_JSON_INVALID')
      continue
    }
    if (typeof current !== 'object') throw new Error('MEDIA_RESOURCE_SNAPSHOT_JSON_INVALID')
    if (ancestors.has(current)) throw new Error('MEDIA_RESOURCE_SNAPSHOT_JSON_INVALID')
    ancestors.add(current)
    pending.push({ value: current, leave: true })
    if (Array.isArray(current)) {
      if (Reflect.ownKeys(current).length !== current.length + 1) {
        throw new Error('MEDIA_RESOURCE_SNAPSHOT_JSON_INVALID')
      }
      for (let index = 0; index < current.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(current, String(index))
        if (!descriptor?.enumerable || !('value' in descriptor)) {
          throw new Error('MEDIA_RESOURCE_SNAPSHOT_JSON_INVALID')
        }
        pending.push({ value: descriptor.value, leave: false })
      }
      continue
    }
    const prototype = Object.getPrototypeOf(current)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error('MEDIA_RESOURCE_SNAPSHOT_JSON_INVALID')
    }
    const descriptors = Object.getOwnPropertyDescriptors(current)
    if (Reflect.ownKeys(descriptors).some((key) => typeof key !== 'string')) {
      throw new Error('MEDIA_RESOURCE_SNAPSHOT_JSON_INVALID')
    }
    for (const descriptor of Object.values(descriptors)) {
      if (!descriptor.enumerable || !('value' in descriptor)) {
        throw new Error('MEDIA_RESOURCE_SNAPSHOT_JSON_INVALID')
      }
      pending.push({ value: descriptor.value, leave: false })
    }
  }
}

/** 把未知 JSON 收窄为校验过的快照信封。 */
function parseEnvelope(value: unknown, expectedKeyHash: string): SnapshotEnvelope | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (Object.keys(record).length !== 4
    || record.schemaVersion !== 1
    || record.keyHash !== expectedKeyHash
    || typeof record.checksum !== 'string'
    || !snapshotFilePattern.test(`${record.checksum}.json`)) return null
  let serializedPayload: string
  try {
    assertPlainJson(record.payload)
    serializedPayload = JSON.stringify(record.payload)
  } catch {
    return null
  }
  if (sha256(serializedPayload) !== record.checksum) return null
  return {
    schemaVersion: 1,
    keyHash: expectedKeyHash,
    payload: record.payload,
    checksum: record.checksum,
  }
}

/** 为 ComfyUI 模型、节点和工作流目录提供跨进程可复用的本地快照。 */
export class MediaResourceSnapshotStore {
  private readonly resolveDirectory: () => string

  /**
   * @param directory 固定目录或按当前数据根动态解析目录的函数。
   */
  constructor(directory: string | (() => string)) {
    this.resolveDirectory = typeof directory === 'string' ? () => directory : directory
  }

  /** 读取并验证指定身份的快照；缺失、损坏或 schema 不兼容时返回 null。 */
  read<T>(key: string, parse: (value: unknown) => T): T | null {
    const keyHash = sha256(key)
    try {
      const envelope = parseEnvelope(
        readMediaJsonFile(join(this.resolveDirectory(), `${keyHash}.json`), maximumSnapshotBytes),
        keyHash,
      )
      if (!envelope) return null
      return parse(envelope.payload)
    } catch {
      return null
    }
  }

  /** 原子写入新快照；写前完成 JSON 与体积校验，失败时不会覆盖旧快照。 */
  write(key: string, value: unknown): void {
    assertPlainJson(value)
    const serializedPayload = JSON.stringify(value)
    const keyHash = sha256(key)
    const envelope: SnapshotEnvelope = {
      schemaVersion: 1,
      keyHash,
      payload: value,
      checksum: sha256(serializedPayload),
    }
    if (Buffer.byteLength(JSON.stringify(envelope, null, 2), 'utf8') > maximumSnapshotBytes) {
      throw new Error('MEDIA_RESOURCE_SNAPSHOT_SIZE_LIMIT')
    }
    const directory = this.resolveDirectory()
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    if (!lstatSync(directory).isDirectory()) throw new Error('MEDIA_RESOURCE_SNAPSHOT_DIRECTORY_INVALID')
    writeJsonFileAtomicSecure(join(directory, `${keyHash}.json`), envelope)
    this.prune(directory, `${keyHash}.json`)
  }

  /** 只回收本存储命名且读取时确认仍为同一普通文件的最旧快照。 */
  private prune(directory: string, currentName: string): void {
    const snapshots: SnapshotFile[] = []
    for (const name of readdirSync(directory)) {
      if (!snapshotFilePattern.test(name)) continue
      try {
        const state = lstatSync(join(directory, name))
        if (!state.isFile()) continue
        snapshots.push({ name, modifiedAt: state.mtimeMs, device: state.dev, inode: state.ino })
      } catch {
        // 并发删除或置换只跳过当前条目，不影响刚写入快照。
      }
    }
    if (snapshots.length <= maximumSnapshotFiles) return
    const removable = snapshots
      .filter((snapshot) => snapshot.name !== currentName)
      .sort((left, right) => left.modifiedAt - right.modifiedAt || left.name.localeCompare(right.name))
    for (const snapshot of removable.slice(0, snapshots.length - maximumSnapshotFiles)) {
      try {
        removeFileAtomic(join(directory, snapshot.name), {
          expectedIdentity: { dev: snapshot.device, ino: snapshot.inode },
        })
      } catch {
        // 淘汰是容量治理，不得反向把已经持久化成功的本次同步报告为失败。
      }
    }
  }
}
