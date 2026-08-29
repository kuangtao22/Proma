import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import {
  CANVAS_SESSION_TITLE_MAX_LENGTH,
  LEGACY_DESIGN_CANVAS_ID,
  type CanvasSessionMeta,
  type CreateCanvasSessionInput,
  type DeleteCanvasSessionInput,
  type ListCanvasSessionsInput,
  type UpdateCanvasSessionInput,
} from '@proma/shared'
import { rmSyncWithRetry } from '../fs-retry'
import { writeJsonFileAtomic } from '../safe-file'
import type { DesignPathResolver } from './design-paths'
import { isSafeDesignStableId } from './design-paths'

/** Canvas 会话索引当前 schema。 */
const CANVAS_SESSION_INDEX_VERSION = 1
/** 索引内部记录额外保存实际存储形态，不向 Renderer 暴露。 */
interface CanvasSessionRecord extends CanvasSessionMeta {
  storageKind: 'legacy' | 'native'
}

/** 单项目 Canvas 会话索引。 */
interface CanvasSessionIndex {
  schemaVersion: 1
  projectId: string
  sessions: CanvasSessionRecord[]
  updatedAt: number
}

/** Canvas 会话 store 的稳定依赖。 */
export interface CanvasSessionStoreDependencies {
  pathResolver: Pick<DesignPathResolver, 'resolve' | 'resolveCanvas'>
  now?: () => number
  createId?: () => string
}

/** 项目级 Canvas 会话索引，所有写入均使用 safe-file 原子提交。 */
export class CanvasSessionStore {
  constructor(private readonly dependencies: CanvasSessionStoreDependencies) {}

  /**
   * 列出项目 Canvas，会返回新数组并按更新时间倒序。
   * @param input 项目与可选归档筛选条件。
   * @returns 不包含内部存储形态的 Canvas 会话列表。
   */
  list(input: ListCanvasSessionsInput): CanvasSessionMeta[] {
    /** 项目当前权威索引。 */
    const index = this.readIndex(input.projectId)
    return index.sessions
      .filter((session) => input.archived === undefined || session.archived === input.archived)
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .map(toPublicSession)
  }

  /**
   * 幂等登记旧 Design 默认 Canvas；没有旧画布时不写索引。
   * @param projectId 已登记项目的稳定 ID。
   * @returns 旧 Design 对应的公开会话；不存在旧画布时返回 undefined。
   */
  ensureLegacySession(projectId: string): CanvasSessionMeta | undefined {
    /** 项目级路径同时决定旧画布与索引位置。 */
    const paths = this.dependencies.pathResolver.resolve(projectId)
    if (!existsSync(paths.canvasPath)) return undefined
    /** 只有确认旧画布存在后才读取或创建索引。 */
    const index = this.readIndex(projectId)
    /** 固定 ID 使重复调用和应用重启保持幂等。 */
    const existing = index.sessions.find((session) => session.id === LEGACY_DESIGN_CANVAS_ID)
    if (existing) return toPublicSession(existing)
    /** 创建和更新时间使用同一已校验时刻。 */
    const now = this.requireNow()
    /** 旧 Design 保留 legacy 存储形态，不提前移动任何素材或任务。 */
    const record: CanvasSessionRecord = {
      id: LEGACY_DESIGN_CANVAS_ID,
      projectId,
      title: '默认设计画布',
      archived: false,
      storageKind: 'legacy',
      createdAt: now,
      updatedAt: now,
    }
    index.sessions.push(record)
    index.updatedAt = now
    this.writeIndex(index)
    return toPublicSession(record)
  }

  /**
   * 创建原生 Canvas 会话元数据，不创建 Agent 会话或运行时。
   * @param input 项目 ID 与可选标题。
   * @returns 成功原子提交后的公开 Canvas 会话。
   */
  create(input: CreateCanvasSessionInput): CanvasSessionMeta {
    /** 当前项目索引用于拒绝 ID 冲突。 */
    const index = this.readIndex(input.projectId)
    /** 生产默认 UUID，测试可注入确定性 ID。 */
    const id = (this.dependencies.createId ?? randomUUID)()
    if (!isSafeDesignStableId(id) || index.sessions.some((session) => session.id === id)) {
      throw new Error(`Canvas ID 非法或重复: ${id}`)
    }
    /** 创建和更新时间使用同一已校验时刻。 */
    const now = this.requireNow()
    /** 标题在主进程统一规范化，Renderer 不能写入空白或超长索引值。 */
    const title = normalizeTitle(input.title ?? '新 Canvas')
    /** 原生记录只保存公开元数据和最小内部存储形态。 */
    const record: CanvasSessionRecord = {
      id,
      projectId: input.projectId,
      title,
      archived: false,
      storageKind: 'native',
      createdAt: now,
      updatedAt: now,
    }
    index.sessions.push(record)
    index.updatedAt = now
    this.writeIndex(index)
    return toPublicSession(record)
  }

  /**
   * 要求 Canvas 已登记在指定项目且使用原生文档存储。
   * @param projectId 当前授权项目的稳定 ID。
   * @param canvasId 需要访问的 Canvas 稳定 ID。
   * @returns 不包含内部存储形态的公开会话元数据。
   */
  requireNative(projectId: string, canvasId: string): CanvasSessionMeta {
    /** 只读取调用方指定项目自己的权威索引，禁止跨项目全局查找。 */
    const index = this.readIndex(projectId)
    /** 未知、跨项目和 legacy 会话统一表现为不存在，避免泄露迁移实现。 */
    const record = index.sessions.find((session) => session.id === canvasId)
    if (!record || record.storageKind !== 'native') throw new Error('Canvas 会话不存在')
    return toPublicSession(record)
  }

  /**
   * 更新 Canvas 标题或归档状态；至少一个字段必须存在。
   * @param input 项目、Canvas ID 与待更新字段。
   * @returns 成功原子提交后的公开 Canvas 会话。
   */
  update(input: UpdateCanvasSessionInput): CanvasSessionMeta {
    if (input.title === undefined && input.archived === undefined) {
      throw new Error('Canvas 会话更新至少需要一个字段')
    }
    /** 项目当前权威索引。 */
    const index = this.readIndex(input.projectId)
    /** 更新只能命中同一项目索引内的稳定 ID。 */
    const record = index.sessions.find((session) => session.id === input.canvasId)
    if (!record) throw new Error(`Canvas 会话不存在: ${input.canvasId}`)
    if (input.title !== undefined) record.title = normalizeTitle(input.title)
    if (input.archived !== undefined) record.archived = input.archived
    /** 任一更新统一推进记录和索引时间。 */
    const now = this.requireNow()
    record.updatedAt = now
    index.updatedAt = now
    this.writeIndex(index)
    return toPublicSession(record)
  }

  /**
   * 删除原生 Canvas 的索引记录、正式目录和可重建缓存。
   * @param input 项目与 Canvas 双重稳定身份。
   * @returns 删除前的公开会话，供 IPC 广播和 Renderer 收敛状态。
   */
  delete(input: DeleteCanvasSessionInput): CanvasSessionMeta {
    /** 删除只能命中调用方项目索引中的明确会话。 */
    const index = this.readIndex(input.projectId)
    const recordIndex = index.sessions.findIndex((session) => session.id === input.canvasId)
    if (recordIndex < 0) throw new Error(`Canvas 会话不存在: ${input.canvasId}`)
    const record = index.sessions[recordIndex]!
    if (record.storageKind !== 'native') throw new Error('旧版默认设计画布不能删除')

    /** 先提交权威索引，避免清理失败后 Renderer 继续打开已部分删除的画布。 */
    index.sessions.splice(recordIndex, 1)
    index.updatedAt = this.requireNow()
    this.writeIndex(index)

    /** 正式内容和缓存只使用受信任路径解析器产生的双身份目录。 */
    const paths = this.dependencies.pathResolver.resolveCanvas(input.projectId, input.canvasId)
    for (const directory of [paths.canvasRoot, paths.cacheRoot]) {
      try {
        rmSyncWithRetry(directory, { recursive: true, force: true })
      } catch (error) {
        /** 索引删除已经提交，残留目录不应把成功操作伪装成失败。 */
        console.warn(`[Canvas 会话] 清理删除目录失败 (${input.projectId}/${input.canvasId}):`, error)
      }
    }
    return toPublicSession(record)
  }

  /**
   * 读取不存在的索引时返回尚未落盘的空索引。
   * @param projectId 已登记项目的稳定 ID。
   * @returns 严格解析后的索引或内存空索引。
   */
  private readIndex(projectId: string): CanvasSessionIndex {
    /** 索引路径只能从受信任项目解析器产生。 */
    const paths = this.dependencies.pathResolver.resolve(projectId)
    if (!existsSync(paths.canvasSessionsIndexPath)) {
      return { schemaVersion: CANVAS_SESSION_INDEX_VERSION, projectId, sessions: [], updatedAt: 0 }
    }
    /** 已存在索引损坏时必须显式失败，禁止用空索引覆盖。 */
    const raw = readFileSync(paths.canvasSessionsIndexPath, 'utf8')
    /** JSON 解析后的未知值必须继续经过精确 schema 校验。 */
    let value: unknown
    try {
      value = JSON.parse(raw) as unknown
    } catch (error) {
      throw new Error('Canvas 会话索引 JSON 损坏', { cause: error })
    }
    return parseCanvasSessionIndex(value, projectId)
  }

  /**
   * 创建明确目录后原子提交完整索引。
   * @param index 已通过业务边界构造或严格解析的项目索引。
   */
  private writeIndex(index: CanvasSessionIndex): void {
    /** 写入位置继续由项目 ID 重新解析，禁止复用外部路径。 */
    const paths = this.dependencies.pathResolver.resolve(index.projectId)
    mkdirSync(paths.canvasesRoot, { recursive: true })
    writeJsonFileAtomic(paths.canvasSessionsIndexPath, index)
  }

  /**
   * 返回有限非负时间戳。
   * @returns 当前持久化操作使用的稳定时间戳。
   */
  private requireNow(): number {
    /** 生产默认系统时钟，测试可注入确定性时间。 */
    const now = (this.dependencies.now ?? Date.now)()
    if (!Number.isFinite(now) || now < 0) throw new Error('Canvas 会话时间戳无效')
    return now
  }
}

/**
 * 去除内部 storageKind，避免 Renderer 依赖迁移实现。
 * @param record 严格解析或本地构造的内部记录。
 * @returns 可跨 IPC 暴露的 Canvas 会话。
 */
function toPublicSession(record: CanvasSessionRecord): CanvasSessionMeta {
  return {
    id: record.id,
    projectId: record.projectId,
    title: record.title,
    archived: record.archived,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }
}

/**
 * 规范化会话标题并执行稳定长度上限。
 * @param value Renderer 输入或默认标题。
 * @returns 去除首尾空白后的有限标题。
 */
function normalizeTitle(value: string): string {
  /** 索引只保存规范化后的展示值。 */
  const title = value.trim()
  if (!title) throw new Error('Canvas 会话标题不能为空')
  if (title.length > CANVAS_SESSION_TITLE_MAX_LENGTH) {
    throw new Error(`Canvas 会话标题不能超过 ${CANVAS_SESSION_TITLE_MAX_LENGTH} 个字符`)
  }
  return title
}

/**
 * 判断未知值是否为可枚举普通对象。
 * @param value JSON 解析后的未知值。
 * @returns 仅标准对象或无原型对象返回 true。
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  /** 非标准原型对象不得进入索引业务层。 */
  const prototype = Object.getPrototypeOf(value) as unknown
  return prototype === Object.prototype || prototype === null
}

/**
 * 判断对象只包含允许字段且所有必填字段存在。
 * @param value 待校验普通对象。
 * @param required 当前 schema 的完整字段清单。
 * @returns 字段集合精确相等时返回 true。
 */
function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
): boolean {
  /** 允许字段与必填字段在本索引中完全相同。 */
  const allowed = new Set(required)
  return required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => allowed.has(key))
}

/**
 * 判断持久化时间戳为有限非负数字。
 * @param value 索引中的未知时间值。
 * @returns 满足持久化时间边界时返回 true。
 */
function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

/**
 * 严格解析单条 Canvas 会话内部记录。
 * @param value JSON 索引中的未知记录。
 * @param projectId 当前受信任项目 ID。
 * @param seenIds 当前索引已出现的 Canvas ID。
 * @returns 字段完整且归属一致的新内部记录。
 */
function parseCanvasSessionRecord(
  value: unknown,
  projectId: string,
  seenIds: Set<string>,
): CanvasSessionRecord {
  /** 单条索引记录允许的精确字段。 */
  const fields = ['id', 'projectId', 'title', 'archived', 'storageKind', 'createdAt', 'updatedAt'] as const
  if (!isRecord(value) || !hasExactKeys(value, fields)) {
    throw new Error('Canvas 会话索引记录字段无效')
  }
  if (!isSafeDesignStableId(value.id) || seenIds.has(value.id)) {
    throw new Error(`Canvas 会话索引包含非法或重复 ID: ${String(value.id)}`)
  }
  if (value.projectId !== projectId) throw new Error('Canvas 会话索引记录项目归属不匹配')
  if (typeof value.title !== 'string' || normalizeTitle(value.title) !== value.title) {
    throw new Error('Canvas 会话索引标题无效')
  }
  if (typeof value.archived !== 'boolean') throw new Error('Canvas 会话索引 archived 无效')
  if (value.storageKind !== 'legacy' && value.storageKind !== 'native') {
    throw new Error('Canvas 会话索引 storageKind 无效')
  }
  if (!isTimestamp(value.createdAt) || !isTimestamp(value.updatedAt) || value.updatedAt < value.createdAt) {
    throw new Error('Canvas 会话索引时间戳无效')
  }
  seenIds.add(value.id)
  return {
    id: value.id,
    projectId,
    title: value.title,
    archived: value.archived,
    storageKind: value.storageKind,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  }
}

/**
 * 严格解析单项目 Canvas 会话索引。
 * @param value JSON 解析后的未知根对象。
 * @param projectId 当前受信任项目 ID。
 * @returns 逐字段重建的项目 Canvas 索引。
 */
function parseCanvasSessionIndex(value: unknown, projectId: string): CanvasSessionIndex {
  /** 索引根对象允许的精确字段。 */
  const fields = ['schemaVersion', 'projectId', 'sessions', 'updatedAt'] as const
  if (!isRecord(value) || !hasExactKeys(value, fields)) {
    throw new Error('Canvas 会话索引根字段无效')
  }
  if (value.schemaVersion !== CANVAS_SESSION_INDEX_VERSION) {
    throw new Error(`不支持的 Canvas 会话索引版本: ${String(value.schemaVersion)}`)
  }
  if (value.projectId !== projectId) throw new Error('Canvas 会话索引项目归属不匹配')
  if (!Array.isArray(value.sessions)) throw new Error('Canvas 会话索引 sessions 无效')
  if (!isTimestamp(value.updatedAt)) throw new Error('Canvas 会话索引 updatedAt 无效')
  /** 已验证时间保存为局部值，避免数组回调重新读取未知对象属性。 */
  const indexUpdatedAt = value.updatedAt
  /** 同一项目内 Canvas ID 必须唯一。 */
  const seenIds = new Set<string>()
  /** 逐项创建新对象，禁止未知原型进入业务层。 */
  const sessions = value.sessions.map((session) => parseCanvasSessionRecord(session, projectId, seenIds))
  if (sessions.some((session) => session.updatedAt > indexUpdatedAt)) {
    throw new Error('Canvas 会话索引 updatedAt 早于记录更新时间')
  }
  return {
    schemaVersion: CANVAS_SESSION_INDEX_VERSION,
    projectId,
    sessions,
    updatedAt: indexUpdatedAt,
  }
}
