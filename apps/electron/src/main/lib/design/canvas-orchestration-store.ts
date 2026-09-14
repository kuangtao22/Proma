import { lstatSync } from 'node:fs'
import type { Stats } from 'node:fs'
import { join } from 'node:path'
import { isCanvasOrchestrationTerminal, parseCanvasOrchestrationRecord } from '@proma/shared'
import type { CanvasOrchestrationRecord } from '@proma/shared'
import { writeJsonFileAtomicSecure } from '../safe-file'
import { acquireMediaFileLock } from '../media/media-file-lock'
import { readMediaJsonFile } from '../media/media-json-file'
import type { DesignPathResolver } from './design-paths'
import { isSafeDesignStableId } from './design-paths'

/** 编排记录按项目与 Canvas 双重作用域隔离。 */
export interface CanvasOrchestrationStoreTarget {
  projectId: string
  canvasId: string
}

/** 编排存储只依赖可信 Design 路径和工作区写守卫。 */
export interface CanvasOrchestrationStoreDependencies {
  pathResolver: Pick<DesignPathResolver, 'resolveCanvas'>
  runWorkspaceWrite: <T>(projectId: string, effect: () => T) => T
}

/** 单文件保存当前委托与有界终态历史，公开读取仍只返回当前记录。 */
interface CanvasOrchestrationStoreDocument {
  schemaVersion: 1
  projectId: string
  canvasId: string
  current: CanvasOrchestrationRecord | null
  history: CanvasOrchestrationRecord[]
}

const maximumFileBytes = 512 * 1024
const maximumHistoryRecords = 16

/** 检查存储文档只包含固定字段。 */
function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && Object.keys(value).every((key) => keys.includes(key))
}

/** 校验编排存储的项目和 Canvas 作用域。 */
function assertTarget(target: CanvasOrchestrationStoreTarget): void {
  if (!isSafeDesignStableId(target.projectId) || !isSafeDesignStableId(target.canvasId)) {
    throw new Error('CANVAS_ORCHESTRATION_STORE_TARGET_INVALID')
  }
}

/** 区分路径缺失与悬空链接、权限错误等不可信状态。 */
function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

/** 确保 Canvas 根仍是实际目录，拒绝符号链接和普通文件。 */
function assertCanvasRoot(path: string): void {
  const state = lstatSync(path)
  if (!state.isDirectory() || state.isSymbolicLink()) {
    throw new Error('CANVAS_ORCHESTRATION_STORE_PATH_INVALID')
  }
}

/** 使用与安全原子写一致的 pretty JSON 计算真实文件字节。 */
function serializedBytes(document: CanvasOrchestrationStoreDocument): number {
  return Buffer.byteLength(JSON.stringify(document, null, 2), 'utf8')
}

/** 严格解析磁盘文档并复核作用域、终态历史和单调 revision。 */
function parseDocument(value: unknown, target: CanvasOrchestrationStoreTarget): CanvasOrchestrationStoreDocument {
  const fields = ['schemaVersion', 'projectId', 'canvasId', 'current', 'history'] as const
  if (!hasExactKeys(value, fields) || value.schemaVersion !== 1
    || value.projectId !== target.projectId || value.canvasId !== target.canvasId
    || !Array.isArray(value.history) || value.history.length > maximumHistoryRecords) {
    throw new Error('CANVAS_ORCHESTRATION_STORE_INVALID')
  }
  let current: CanvasOrchestrationRecord | null
  let history: CanvasOrchestrationRecord[]
  try {
    current = value.current === null ? null : parseCanvasOrchestrationRecord(value.current)
    history = value.history.map(parseCanvasOrchestrationRecord)
  } catch {
    throw new Error('CANVAS_ORCHESTRATION_STORE_INVALID')
  }
  const records = [...history, ...(current ? [current] : [])]
  if (records.some((record) => record.projectId !== target.projectId || record.canvasId !== target.canvasId)
    || history.some((record) => !isCanvasOrchestrationTerminal(record.status))
    || records.some((record, index) => index > 0 && record.revision <= records[index - 1]!.revision)
    || new Set(records.map((record) => record.id)).size !== records.length
    || new Set(records.map((record) => record.request.requestId)).size !== records.length) {
    throw new Error('CANVAS_ORCHESTRATION_STORE_INVALID')
  }
  return { schemaVersion: 1, projectId: target.projectId, canvasId: target.canvasId, current, history }
}

/** 超出文件预算时只淘汰最旧历史，当前委托始终完整保留。 */
function fitWithinFileBudget(document: CanvasOrchestrationStoreDocument): CanvasOrchestrationStoreDocument {
  if (serializedBytes(document) <= maximumFileBytes) return document
  let history = [...document.history]
  while (history.length > 0) {
    history = history.slice(1)
    const candidate = { ...document, history }
    if (serializedBytes(candidate) <= maximumFileBytes) return candidate
  }
  throw new Error('CANVAS_ORCHESTRATION_STORE_SIZE_LIMIT')
}

/** 比较决定幂等委托身份的 owner 与原始 request，不采信调用方提交的可变运行字段。 */
function isExactReplay(existing: CanvasOrchestrationRecord, candidate: CanvasOrchestrationRecord): boolean {
  return existing.ownerSessionId === candidate.ownerSessionId
    && JSON.stringify(existing.request) === JSON.stringify(candidate.request)
}

/** 比较保存过程中不得改变的委托事实。 */
function hasSameImmutableFacts(existing: CanvasOrchestrationRecord, candidate: CanvasOrchestrationRecord): boolean {
  return existing.id === candidate.id
    && existing.projectId === candidate.projectId
    && existing.canvasId === candidate.canvasId
    && existing.ownerSessionId === candidate.ownerSessionId
    && existing.createdAt === candidate.createdAt
    && JSON.stringify(existing.request) === JSON.stringify(candidate.request)
}

/** 保证 Host 预算上限、已消耗次数和幂等媒体回执都只能单调推进。 */
function hasValidBudgetProgression(
  existing: CanvasOrchestrationRecord['budget'],
  candidate: CanvasOrchestrationRecord['budget'],
): boolean {
  if (!existing) return true
  /** 旧回执必须保持原顺序和内容，新回执只能追加到列表末尾。 */
  const existingReservations = existing.mediaReservations ?? []
  const candidateReservations = candidate?.mediaReservations ?? []
  return !!candidate
    && candidate.maxAgentRuns === existing.maxAgentRuns
    && candidate.maxMediaRuns === existing.maxMediaRuns
    && candidate.agentRunsUsed >= existing.agentRunsUsed
    && candidate.mediaRunsUsed >= existing.mediaRunsUsed
    && existingReservations.every((reservation, index) => {
      const next = candidateReservations[index]
      return next?.operationId === reservation.operationId && next.count === reservation.count
    })
}

/** 校正历史只能追加；pending 可启动，started 可结算，abandoned 必须与继任 pending 原子成对。 */
function hasValidFollowUpProgression(
  existing: CanvasOrchestrationRecord['followUps'],
  candidate: CanvasOrchestrationRecord['followUps'],
): boolean {
  const before = existing ?? []
  const after = candidate ?? []
  const appended = after.slice(before.length)
  return after.length >= before.length
    && after.length - before.length <= 1
    && appended.every(item => item.status === 'pending'
      && item.createdAt >= (before.at(-1)?.createdAt ?? 0)
      && (item.supersedesId === undefined || before.some((previous, index) => previous.id === item.supersedesId
        && previous.status === 'started' && after[index]?.status === 'abandoned')))
    && before.every((item, index) => {
      const next = after[index]
      if (!next || next.id !== item.id || next.instruction !== item.instruction || next.supersedesId !== item.supersedesId
        || next.createdAt !== item.createdAt) return false
      if (item.status === 'pending') return next.status === 'pending'
        ? next.startedAt === undefined && next.userMessageUuid === undefined
        : next.status === 'started' && next.startedAt !== undefined && next.userMessageUuid !== undefined
      if (item.status === 'started') return ['started', 'delivered', 'failed', 'abandoned'].includes(next.status)
        && next.startedAt === item.startedAt && next.userMessageUuid === item.userMessageUuid
        && (next.status !== 'abandoned' || appended.some(candidate => candidate.supersedesId === item.id))
      return next.status === item.status && next.startedAt === item.startedAt && next.userMessageUuid === item.userMessageUuid
    })
}

/** 创建 Canvas 编排记录存储。 */
export function createCanvasOrchestrationStore(dependencies: CanvasOrchestrationStoreDependencies): {
  get(target: CanvasOrchestrationStoreTarget): CanvasOrchestrationRecord | null
  create(record: CanvasOrchestrationRecord): CanvasOrchestrationRecord
  save(target: CanvasOrchestrationStoreTarget, expectedRevision: number, record: CanvasOrchestrationRecord): CanvasOrchestrationRecord
} {
  /** 解析固定文件和锁路径；存储不会接受调用方提供的相对路径。 */
  const paths = (target: CanvasOrchestrationStoreTarget, requireRoot: boolean) => {
    assertTarget(target)
    const canvasRoot = dependencies.pathResolver.resolveCanvas(target.projectId, target.canvasId).canvasRoot
    const rootState = lstatOrNull(canvasRoot)
    if (!rootState) {
      if (requireRoot) throw new Error('CANVAS_ORCHESTRATION_STORE_PATH_INVALID')
    } else if (!rootState.isDirectory() || rootState.isSymbolicLink()) {
      throw new Error('CANVAS_ORCHESTRATION_STORE_PATH_INVALID')
    }
    return {
      canvasRoot,
      file: join(canvasRoot, 'orchestration.json'),
      lock: join(canvasRoot, 'orchestration.lock'),
    }
  }

  /** 无文件返回空文档；已有文件必须从 no-follow descriptor 有界读取。 */
  const read = (target: CanvasOrchestrationStoreTarget): CanvasOrchestrationStoreDocument => {
    const resolved = paths(target, false)
    const fileState = lstatOrNull(resolved.file)
    if (!fileState) {
      return { schemaVersion: 1, projectId: target.projectId, canvasId: target.canvasId, current: null, history: [] }
    }
    try {
      if (!fileState.isFile() || fileState.isSymbolicLink()) throw new Error()
      return parseDocument(readMediaJsonFile(resolved.file, maximumFileBytes), target)
    } catch (error) {
      if (error instanceof Error && error.message === 'CANVAS_ORCHESTRATION_STORE_INVALID') throw error
      throw new Error('CANVAS_ORCHESTRATION_STORE_PATH_INVALID')
    }
  }

  /** 在画布独占锁和工作区写守卫内完成一次安全原子更新。 */
  const mutate = (
    target: CanvasOrchestrationStoreTarget,
    update: (current: CanvasOrchestrationStoreDocument) => CanvasOrchestrationStoreDocument,
  ): CanvasOrchestrationStoreDocument => dependencies.runWorkspaceWrite(target.projectId, () => {
    const resolved = paths(target, true)
    let release: () => void
    try {
      release = acquireMediaFileLock(resolved.lock)
    } catch (error) {
      if (error instanceof Error && error.message === 'MEDIA_FILE_BUSY') {
        throw new Error('CANVAS_ORCHESTRATION_STORE_BUSY')
      }
      throw error
    }
    try {
      const current = read(target)
      const updated = parseDocument(update(current), target)
      if (JSON.stringify(updated) === JSON.stringify(current)) return current
      const candidate = fitWithinFileBudget(updated)
      writeJsonFileAtomicSecure(resolved.file, candidate, {
        beforeRename: () => {
          try {
            assertCanvasRoot(dependencies.pathResolver.resolveCanvas(target.projectId, target.canvasId).canvasRoot)
          } catch {
            throw new Error('CANVAS_ORCHESTRATION_STORE_PATH_INVALID')
          }
        },
      })
      return candidate
    } finally {
      release()
    }
  })

  return {
    /** 返回当前 Canvas 的编排记录；没有委托时返回 null。 */
    get(target): CanvasOrchestrationRecord | null {
      return structuredClone(read(target).current)
    },
    /** 创建新委托，或对当前及有界历史中的同一原始请求执行精确幂等重放。 */
    create(record): CanvasOrchestrationRecord {
      const parsed = parseCanvasOrchestrationRecord(record)
      const target = { projectId: parsed.projectId, canvasId: parsed.canvasId }
      if (parsed.revision !== 1) throw new Error('CANVAS_ORCHESTRATION_STORE_INVALID')
      let result: CanvasOrchestrationRecord | undefined
      mutate(target, (document) => {
        const sameRequestId = [document.current, ...document.history]
          .filter((entry): entry is CanvasOrchestrationRecord => entry !== null)
          .find((entry) => entry.request.requestId === parsed.request.requestId)
        if (sameRequestId) {
          if (!isExactReplay(sameRequestId, parsed)) throw new Error('CANVAS_ORCHESTRATION_REQUEST_CONFLICT')
          result = sameRequestId
          return document
        }
        if (document.current && !isCanvasOrchestrationTerminal(document.current.status)) {
          throw new Error('CANVAS_ORCHESTRATION_ACTIVE_EXISTS')
        }
        if (document.history.some((entry) => entry.id === parsed.id)
          || document.current?.id === parsed.id) throw new Error('CANVAS_ORCHESTRATION_REQUEST_CONFLICT')
        const nextRevision = document.current ? document.current.revision + 1
          : (document.history.at(-1)?.revision ?? 0) + 1
        result = { ...parsed, revision: nextRevision }
        const history = document.current ? [...document.history, document.current] : [...document.history]
        return {
          ...document,
          current: result,
          history: history.slice(-maximumHistoryRecords),
        }
      })
      return structuredClone(result!)
    },
    /** 用当前记录 revision 做 CAS，保存同一委托的下一状态。 */
    save(target, expectedRevision, record): CanvasOrchestrationRecord {
      assertTarget(target)
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
        throw new Error('CANVAS_ORCHESTRATION_STORE_CONFLICT')
      }
      const parsed = parseCanvasOrchestrationRecord(record)
      if (parsed.projectId !== target.projectId || parsed.canvasId !== target.canvasId) {
        throw new Error('CANVAS_ORCHESTRATION_STORE_SCOPE_MISMATCH')
      }
      const saved = mutate(target, (document) => {
        if (!document.current || document.current.revision !== expectedRevision
          || parsed.revision !== expectedRevision + 1) {
          throw new Error('CANVAS_ORCHESTRATION_STORE_CONFLICT')
        }
        if (!hasSameImmutableFacts(document.current, parsed)) {
          throw new Error('CANVAS_ORCHESTRATION_IMMUTABLE_FACTS_CHANGED')
        }
        if (!hasValidBudgetProgression(document.current.budget, parsed.budget)) {
          throw new Error('CANVAS_ORCHESTRATION_BUDGET_REGRESSION')
        }
        if (!hasValidFollowUpProgression(document.current.followUps, parsed.followUps)) {
          throw new Error('CANVAS_ORCHESTRATION_FOLLOW_UP_REGRESSION')
        }
        if (isCanvasOrchestrationTerminal(document.current.status)) {
          throw new Error('CANVAS_ORCHESTRATION_TERMINAL')
        }
        if (parsed.updatedAt < document.current.updatedAt) {
          throw new Error('CANVAS_ORCHESTRATION_STORE_INVALID')
        }
        return { ...document, current: parsed }
      })
      return structuredClone(saved.current!)
    },
  }
}
