import { lstatSync } from 'node:fs'
import type { Stats } from 'node:fs'
import { join } from 'node:path'
import { ensureDirectoryDurable, writeJsonFileAtomicSecure } from '../safe-file'
import { acquireMediaFileLock } from '../media/media-file-lock'
import { readMediaJsonFile } from '../media/media-json-file'
import type { DesignPathResolver } from './design-paths'
import { isSafeDesignStableId } from './design-paths'
import { parseCanvasTaskState, type CanvasTaskState } from './canvas-task-contract'

/** 任务文件按项目、Canvas 与会话三重作用域隔离。 */
export interface CanvasTaskStoreTarget {
  projectId: string
  canvasId: string
  sessionId: string
}

/** 活动或归档任务的 CAS revision 记录。 */
export interface CanvasTaskStoreRecord {
  revision: number
  state: CanvasTaskState
}

/** 会话作用域任务文件的公开快照。 */
export interface CanvasTaskStoreSnapshot {
  revision: number
  active: CanvasTaskState | null
  archived: CanvasTaskState[]
}

/** 存储只依赖可信 Design 路径和工作区写守卫。 */
export interface CanvasTaskStoreDependencies {
  pathResolver: Pick<DesignPathResolver, 'resolveCanvas'>
  runWorkspaceWrite: <T>(projectId: string, effect: () => T) => T
}

/** 落盘格式包含作用域，防止合法文件被移动到另一会话后继续使用。 */
interface CanvasTaskStoreDocument {
  schemaVersion: 1
  revision: number
  projectId: string
  canvasId: string
  sessionId: string
  active: CanvasTaskState | null
  archived: CanvasTaskState[]
}

const maximumFileBytes = 2 * 1024 * 1024
const maximumArchivedTasks = 32

/** 使用与安全原子写完全相同的 pretty JSON 计算真实落盘字节。 */
function serializedBytes(document: CanvasTaskStoreDocument): number {
  return Buffer.byteLength(JSON.stringify(document, null, 2), 'utf8')
}

/** 超过文件预算时只从最旧归档开始淘汰，活动任务始终保持完整。 */
function fitWithinFileBudget(document: CanvasTaskStoreDocument): CanvasTaskStoreDocument {
  if (serializedBytes(document) <= maximumFileBytes) return document
  /** 二分查找最少淘汰数量，32 条历史最多额外序列化约 5 次。 */
  let lower = 1
  let upper = document.archived.length
  let fitted: CanvasTaskStoreDocument | undefined
  while (lower <= upper) {
    const removed = Math.floor((lower + upper) / 2)
    const candidate = { ...document, archived: document.archived.slice(removed) }
    if (serializedBytes(candidate) <= maximumFileBytes) {
      fitted = candidate
      upper = removed - 1
    } else {
      lower = removed + 1
    }
  }
  if (!fitted) throw new Error('CANVAS_TASK_STORE_SIZE_LIMIT')
  return fitted
}

/** 校验任务存储作用域使用的稳定 ID。 */
function assertTarget(target: CanvasTaskStoreTarget): void {
  if (!isSafeDesignStableId(target.projectId) || !isSafeDesignStableId(target.canvasId)
    || !isSafeDesignStableId(target.sessionId)) throw new Error('CANVAS_TASK_STORE_TARGET_INVALID')
}

/** 严格解析任务存储文件，不信任磁盘上的类型断言。 */
function parseDocument(value: unknown, target: CanvasTaskStoreTarget): CanvasTaskStoreDocument {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('CANVAS_TASK_STORE_INVALID')
  const input = value as Record<string, unknown>
  if (!Object.keys(input).every((key) => [
    'schemaVersion', 'revision', 'projectId', 'canvasId', 'sessionId', 'active', 'archived',
  ].includes(key)) || input.schemaVersion !== 1 || !Number.isSafeInteger(input.revision) || Number(input.revision) < 1
    || input.projectId !== target.projectId || input.canvasId !== target.canvasId || input.sessionId !== target.sessionId
    || !Array.isArray(input.archived) || input.archived.length > maximumArchivedTasks) {
    throw new Error('CANVAS_TASK_STORE_INVALID')
  }
  const active = input.active === null ? null : parseCanvasTaskState(input.active)
  const archived = input.archived.map(parseCanvasTaskState)
  if ((active && active.canvasId !== target.canvasId)
    || archived.some((state) => state.canvasId !== target.canvasId)
    || new Set([...(active ? [active.taskId] : []), ...archived.map((state) => state.taskId)]).size
      !== archived.length + (active ? 1 : 0)) throw new Error('CANVAS_TASK_STORE_INVALID')
  return {
    schemaVersion: 1,
    revision: Number(input.revision),
    projectId: target.projectId,
    canvasId: target.canvasId,
    sessionId: target.sessionId,
    active,
    archived,
  }
}

/** 确保路径是实际目录，拒绝符号链接和普通文件。 */
function assertDirectory(path: string): void {
  const state = lstatSync(path)
  if (!state.isDirectory() || state.isSymbolicLink()) throw new Error('CANVAS_TASK_STORE_PATH_INVALID')
}

/** 区分路径缺失与悬空链接、权限错误等不可信状态。 */
function lstatOrNull(path: string): Stats | null {
  try { return lstatSync(path) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

/** 创建 Canvas 任务持久存储。 */
export function createCanvasTaskStore(dependencies: CanvasTaskStoreDependencies) {
  /** 解析会话文件与锁路径，写入时只创建 Canvas 下的固定任务目录。 */
  const paths = (target: CanvasTaskStoreTarget, create: boolean) => {
    assertTarget(target)
    const canvas = dependencies.pathResolver.resolveCanvas(target.projectId, target.canvasId)
    const canvasRootState = lstatOrNull(canvas.canvasRoot)
    if (!canvasRootState) {
      if (!create) return {
        directory: join(canvas.canvasRoot, 'task-state'),
        file: join(canvas.canvasRoot, 'task-state', `task-${target.sessionId}.json`),
        lock: join(canvas.canvasRoot, 'task-state', `task-${target.sessionId}.lock`),
      }
      throw new Error('CANVAS_TASK_STORE_PATH_INVALID')
    }
    if (!canvasRootState.isDirectory() || canvasRootState.isSymbolicLink()) throw new Error('CANVAS_TASK_STORE_PATH_INVALID')
    const directory = join(canvas.canvasRoot, 'task-state')
    const directoryState = lstatOrNull(directory)
    if (!directoryState) {
      if (create) ensureDirectoryDurable(directory)
    } else {
      if (!directoryState.isDirectory() || directoryState.isSymbolicLink()) throw new Error('CANVAS_TASK_STORE_PATH_INVALID')
    }
    return {
      directory,
      file: join(directory, `task-${target.sessionId}.json`),
      lock: join(directory, `task-${target.sessionId}.lock`),
    }
  }

  /** 无文件时返回 revision 0 空状态；已有文件必须 no-follow 严格读取。 */
  const read = (target: CanvasTaskStoreTarget): CanvasTaskStoreDocument => {
    const resolved = paths(target, false)
    const fileState = lstatOrNull(resolved.file)
    if (!fileState) {
      return {
        schemaVersion: 1, revision: 0, projectId: target.projectId, canvasId: target.canvasId,
        sessionId: target.sessionId, active: null, archived: [],
      }
    }
    try {
      if (!fileState.isFile() || fileState.isSymbolicLink()) throw new Error()
      return parseDocument(readMediaJsonFile(resolved.file, maximumFileBytes), target)
    } catch (error) {
      if (error instanceof Error && error.message === 'CANVAS_TASK_STORE_INVALID') throw error
      throw new Error('CANVAS_TASK_STORE_PATH_INVALID')
    }
  }

  /** 在会话独占锁内执行 CAS 写入。 */
  const mutate = (
    target: CanvasTaskStoreTarget,
    expectedRevision: number,
    update: (current: CanvasTaskStoreDocument) => CanvasTaskStoreDocument,
  ): CanvasTaskStoreDocument => dependencies.runWorkspaceWrite(target.projectId, () => {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new Error('CANVAS_TASK_STORE_CONFLICT')
    const resolved = paths(target, true)
    let release: () => void
    try { release = acquireMediaFileLock(resolved.lock) } catch (error) {
      if (error instanceof Error && error.message === 'MEDIA_FILE_BUSY') throw new Error('CANVAS_TASK_STORE_BUSY')
      throw error
    }
    try {
      const current = read(target)
      if (current.revision !== expectedRevision) throw new Error('CANVAS_TASK_STORE_CONFLICT')
      const candidate = parseDocument(update(current), target)
      if (candidate.revision !== expectedRevision + 1) throw new Error('CANVAS_TASK_STORE_INVALID')
      const next = fitWithinFileBudget(candidate)
      writeJsonFileAtomicSecure(resolved.file, next, {
        beforeRename: () => {
          try {
            assertDirectory(dependencies.pathResolver.resolveCanvas(target.projectId, target.canvasId).canvasRoot)
            assertDirectory(resolved.directory)
          } catch { throw new Error('CANVAS_TASK_STORE_PATH_INVALID') }
        },
      })
      return next
    } finally { release() }
  })

  return {
    /** 读取当前会话的活动与归档任务。 */
    get(target: CanvasTaskStoreTarget): CanvasTaskStoreSnapshot {
      const value = read(target)
      return { revision: value.revision, active: structuredClone(value.active), archived: structuredClone(value.archived) }
    },
    /** 只读取活动任务，并携带后续 CAS 所需 revision。 */
    getActive(target: CanvasTaskStoreTarget): CanvasTaskStoreRecord | null {
      const value = read(target)
      return value.active ? { revision: value.revision, state: structuredClone(value.active) } : null
    },
    /** 保存同一活动任务的下一状态；另一任务必须先显式归档当前任务。 */
    save(target: CanvasTaskStoreTarget, expectedRevision: number, candidate: CanvasTaskState): CanvasTaskStoreRecord {
      const state = parseCanvasTaskState(candidate)
      if (state.canvasId !== target.canvasId) throw new Error('CANVAS_TASK_STORE_SCOPE_MISMATCH')
      const saved = mutate(target, expectedRevision, (current) => {
        if (current.active && current.active.taskId !== state.taskId) throw new Error('CANVAS_TASK_ACTIVE_EXISTS')
        if (current.active && (JSON.stringify(current.active.requirements) !== JSON.stringify(state.requirements)
          || JSON.stringify(current.active.baseline) !== JSON.stringify(state.baseline))) {
          throw new Error('CANVAS_TASK_IMMUTABLE_FACTS_CHANGED')
        }
        return { ...current, revision: current.revision + 1, active: state }
      })
      return { revision: saved.revision, state: structuredClone(saved.active!) }
    },
    /** 显式归档指定活动任务并清空活动槽，保留有界历史。 */
    archive(target: CanvasTaskStoreTarget, expectedRevision: number, taskId: string): CanvasTaskStoreRecord {
      if (!isSafeDesignStableId(taskId)) throw new Error('CANVAS_TASK_STORE_TARGET_INVALID')
      let archivedState: CanvasTaskState | undefined
      const saved = mutate(target, expectedRevision, (current) => {
        if (!current.active || current.active.taskId !== taskId) throw new Error('CANVAS_TASK_ACTIVE_NOT_FOUND')
        archivedState = current.active
        const archived = [...current.archived, current.active]
        if (archived.length > maximumArchivedTasks) archived.shift()
        return { ...current, revision: current.revision + 1, active: null, archived }
      })
      return { revision: saved.revision, state: structuredClone(archivedState!) }
    },
  }
}
