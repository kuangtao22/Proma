import { readFileSync } from 'node:fs'
import type {
  AgentCanvasBinding,
  LinkAgentCanvasInput,
  SetDefaultAgentCanvasInput,
  UnlinkAgentCanvasInput,
} from '@proma/shared'
import {
  parseAgentCanvasBinding,
  parseClearAgentCanvasBindingsInput,
  parseLinkAgentCanvasInput,
  parseListAgentCanvasBindingsInput,
  parseSetDefaultAgentCanvasInput,
  parseUnlinkAgentCanvasInput,
} from '@proma/shared'
import { getAgentCanvasBindingsPath } from '../config-paths'
import {
  readAtomicFileState,
  readJsonFileSafe,
  writeJsonFileAtomicSecure,
} from '../safe-file'
import type {
  AtomicDestinationExpectation,
  AtomicFileState,
  ReadJsonFileSafeOptions,
  SecureAtomicJsonWriteOptions,
} from '../safe-file'

/** Agent-画布关联索引的当前磁盘版本。 */
const AGENT_CANVAS_BINDINGS_VERSION = 1

/** 单文件保存的完整 Agent-画布关联索引。 */
interface AgentCanvasBindingsFile {
  version: typeof AGENT_CANVAS_BINDINGS_VERSION
  bindings: AgentCanvasBinding[]
}

/** 单次 fresh load 绑定的规范化文件与 CAS 写入依据。 */
interface AgentCanvasBindingsSnapshot {
  file: AgentCanvasBindingsFile
  expectedDestination: AtomicDestinationExpectation
  priorFile: AgentCanvasBindingsFile | null
}

/** Store 可替换的文件系统、时间与日志依赖。 */
export interface AgentCanvasBindingStoreDependencies {
  /** 关联索引文件路径；默认位于当前业务配置根。 */
  configPath?: string
  /** 生成业务变更时间戳；默认使用系统时间。 */
  now?: () => number
  /** 读取主文件完整状态，用于区分缺失并建立 CAS 预期。 */
  readState?: (filePath: string) => AtomicFileState | null
  /** 读取主文件原始内容，避免损坏读取触发候选提升。 */
  readFile?: (filePath: string, encoding: 'utf8') => string
  /** 使用 safe-file 读取合法主文件或缺失主文件的恢复候选。 */
  readJson?: (filePath: string, options: ReadJsonFileSafeOptions<unknown>) => unknown | null
  /** 使用 safe-file 原子写入完整索引。 */
  writeJson?: (
    filePath: string,
    value: object,
    options: SecureAtomicJsonWriteOptions,
  ) => unknown
  /** 输出不含文件内容或原始错误的中文损坏提示。 */
  warn?: (message: string) => void
}

/** 管理普通 Agent 会话与项目画布的多对多关联。 */
export class AgentCanvasBindingStore {
  /** 关联索引的最终文件路径。 */
  private readonly configPath: string
  /** 业务时间来源。 */
  private readonly now: () => number
  /** 主文件完整状态读取边界。 */
  private readonly readState: (filePath: string) => AtomicFileState | null
  /** 主文件原始内容读取边界。 */
  private readonly readFile: (filePath: string, encoding: 'utf8') => string
  /** safe-file JSON 恢复读取边界。 */
  private readonly readJson: (
    filePath: string,
    options: ReadJsonFileSafeOptions<unknown>,
  ) => unknown | null
  /** safe-file 原子 JSON 写入边界。 */
  private readonly writeJson: (
    filePath: string,
    value: object,
    options: SecureAtomicJsonWriteOptions,
  ) => unknown
  /** 中文降级日志边界。 */
  private readonly warn: (message: string) => void
  /** 首次访问后缓存的规范化关联记录。 */
  private bindings: AgentCanvasBinding[] | null = null

  /**
   * 创建关联 Store。
   * @param dependencies 可替换的路径、时钟与文件边界。
   */
  constructor(dependencies: AgentCanvasBindingStoreDependencies = {}) {
    this.configPath = dependencies.configPath ?? getAgentCanvasBindingsPath()
    this.now = dependencies.now ?? Date.now
    this.readState = dependencies.readState ?? readAtomicFileState
    this.readFile = dependencies.readFile ?? ((filePath, encoding) => readFileSync(filePath, encoding))
    this.readJson = dependencies.readJson ?? ((filePath, options) => (
      readJsonFileSafe<unknown>(filePath, options)
    ))
    this.writeJson = dependencies.writeJson ?? ((filePath, value, options) => (
      writeJsonFileAtomicSecure(filePath, value, options)
    ))
    this.warn = dependencies.warn ?? ((message) => console.warn(message))
  }

  /**
   * 读取单个 Agent 会话的画布关联。
   * @param projectId 项目稳定 ID。
   * @param sessionId 普通 Agent 会话稳定 ID。
   * @returns 隔离副本；未关联时返回 null。
   */
  get(projectId: string, sessionId: string): AgentCanvasBinding | null {
    /** 借用共享清理输入解析器严格验证项目与会话身份。 */
    const input = parseClearAgentCanvasBindingsInput({ projectId, target: 'session', sessionId })
    /** 当前身份匹配的内部记录。 */
    const binding = this.load().find((candidate) => (
      candidate.projectId === input.projectId && candidate.sessionId === input.sessionId
    ))
    return binding ? copyBinding(binding) : null
  }

  /**
   * 列出项目内全部 Agent-画布关联。
   * @param projectId 项目稳定 ID。
   * @returns 按会话身份稳定排序的隔离副本。
   */
  listByProject(projectId: string): AgentCanvasBinding[] {
    /** 复用共享 LIST 输入解析器验证项目身份。 */
    const input = parseListAgentCanvasBindingsInput({ projectId })
    return this.load()
      .filter((binding) => binding.projectId === input.projectId)
      .sort(compareBindings)
      .map(copyBinding)
  }

  /**
   * 建立 Agent 与画布关联，首次关联自动产生可用默认画布。
   * @param rawInput 共享 Link 合同输入。
   * @returns 变更后的隔离关联副本。
   */
  link(rawInput: LinkAgentCanvasInput): AgentCanvasBinding {
    /** 共享边界严格解析后的关联命令。 */
    const input = parseLinkAgentCanvasInput(rawInput)
    /** fresh 磁盘快照与隔离候选，避免长期缓存参与写入。 */
    const { snapshot, bindings } = this.prepareMutation()
    /** 相同项目与会话的现有记录位置。 */
    const index = findBindingIndex(bindings, input.projectId, input.sessionId)
    /** 命中时用于判断重复操作或默认切换的现有记录。 */
    const existing = index < 0 ? null : bindings[index]!

    if (existing?.linkedCanvasIds.includes(input.canvasId)) {
      if (!input.makeDefault
        || (existing.defaultCanvasId === input.canvasId
          && existing.lastActiveCanvasId === input.canvasId)) {
        return copyBinding(existing)
      }
      /** makeDefault=true 必须同步默认与最近画布。 */
      const updated: AgentCanvasBinding = {
        ...copyBinding(existing),
        defaultCanvasId: input.canvasId,
        lastActiveCanvasId: input.canvasId,
        updatedAt: this.now(),
      }
      bindings[index] = updated
      this.persist(bindings, snapshot)
      return copyBinding(updated)
    }

    /** 首次或追加关联后的稳定画布顺序。 */
    const linkedCanvasIds = [...(existing?.linkedCanvasIds ?? []), input.canvasId]
    /** 无默认时即使 makeDefault=false 也选择首个可用画布。 */
    const defaultCanvasId = input.makeDefault
      ? input.canvasId
      : existing?.defaultCanvasId ?? linkedCanvasIds[0]!
    /** 最近画布只在显式默认切换或尚无可用值时变化。 */
    const lastActiveCanvasId = input.makeDefault
      ? input.canvasId
      : existing?.lastActiveCanvasId ?? existing?.defaultCanvasId ?? linkedCanvasIds[0]!
    /** 本次写入后的规范化记录。 */
    const updated: AgentCanvasBinding = {
      projectId: input.projectId,
      sessionId: input.sessionId,
      defaultCanvasId,
      linkedCanvasIds,
      lastActiveCanvasId,
      updatedAt: this.now(),
    }
    if (index < 0) bindings.push(updated)
    else bindings[index] = updated
    this.persist(bindings, snapshot)
    return copyBinding(updated)
  }

  /**
   * 解除单个画布关联，并稳定维护默认与最近画布。
   * @param rawInput 共享 Unlink 合同输入。
   * @returns 变更后副本；最后一个关联移除后返回 null。
   */
  unlink(rawInput: UnlinkAgentCanvasInput): AgentCanvasBinding | null {
    /** 共享边界严格解析后的解除命令。 */
    const input = parseUnlinkAgentCanvasInput(rawInput)
    /** fresh 磁盘快照与隔离候选，避免长期缓存参与写入。 */
    const { snapshot, bindings } = this.prepareMutation()
    /** 目标记录位置。 */
    const index = findBindingIndex(bindings, input.projectId, input.sessionId)
    if (index < 0) return null
    /** 当前目标记录。 */
    const existing = bindings[index]!
    if (!existing.linkedCanvasIds.includes(input.canvasId)) return copyBinding(existing)
    /** 删除目标后保留首现顺序的关联画布。 */
    const linkedCanvasIds = existing.linkedCanvasIds.filter((canvasId) => canvasId !== input.canvasId)
    if (linkedCanvasIds.length === 0) {
      bindings.splice(index, 1)
      this.persist(bindings, snapshot)
      return null
    }
    /** 若默认被删除则稳定回退到剩余首项。 */
    const defaultCanvasId = existing.defaultCanvasId === input.canvasId
      ? linkedCanvasIds[0]!
      : existing.defaultCanvasId ?? linkedCanvasIds[0]!
    /** 若最近画布被删除则跟随当前可用默认。 */
    const lastActiveCanvasId = existing.lastActiveCanvasId === input.canvasId
      ? defaultCanvasId
      : existing.lastActiveCanvasId ?? defaultCanvasId
    /** 解除后的规范化记录。 */
    const updated: AgentCanvasBinding = {
      ...copyBinding(existing),
      defaultCanvasId,
      linkedCanvasIds,
      lastActiveCanvasId,
      updatedAt: this.now(),
    }
    bindings[index] = updated
    this.persist(bindings, snapshot)
    return copyBinding(updated)
  }

  /**
   * 把已关联画布设为默认和最近使用画布。
   * @param rawInput 共享 SetDefault 合同输入。
   * @returns 更新后的隔离关联副本。
   */
  setDefault(rawInput: SetDefaultAgentCanvasInput): AgentCanvasBinding {
    /** 共享边界严格解析后的默认切换命令。 */
    const input = parseSetDefaultAgentCanvasInput(rawInput)
    /** fresh 磁盘快照与隔离候选，避免长期缓存参与写入。 */
    const { snapshot, bindings } = this.prepareMutation()
    /** 目标记录位置。 */
    const index = findBindingIndex(bindings, input.projectId, input.sessionId)
    /** 目标记录；未知会话或未知关联都明确拒绝。 */
    const existing = index < 0 ? null : bindings[index]!
    if (!existing?.linkedCanvasIds.includes(input.canvasId)) {
      throw new Error('AGENT_CANVAS_BINDING_NOT_FOUND')
    }
    if (existing.defaultCanvasId === input.canvasId
      && existing.lastActiveCanvasId === input.canvasId) {
      return copyBinding(existing)
    }
    /** 默认切换后的规范化记录。 */
    const updated: AgentCanvasBinding = {
      ...copyBinding(existing),
      defaultCanvasId: input.canvasId,
      lastActiveCanvasId: input.canvasId,
      updatedAt: this.now(),
    }
    bindings[index] = updated
    this.persist(bindings, snapshot)
    return copyBinding(updated)
  }

  /**
   * 删除一个普通 Agent 会话的全部画布关联。
   * @param projectId 项目稳定 ID。
   * @param sessionId 普通 Agent 会话稳定 ID。
   */
  clearSession(projectId: string, sessionId: string): void {
    /** 共享清理合同验证后的会话目标。 */
    const input = parseClearAgentCanvasBindingsInput({ projectId, target: 'session', sessionId })
    if (input.target !== 'session') throw new Error('CLEAR_AGENT_CANVAS_BINDINGS_INPUT_INVALID')
    /** fresh 磁盘快照与隔离候选，避免长期缓存参与写入。 */
    const { snapshot, bindings } = this.prepareMutation()
    /** 目标记录位置。 */
    const index = findBindingIndex(bindings, input.projectId, input.sessionId)
    if (index < 0) return
    bindings.splice(index, 1)
    this.persist(bindings, snapshot)
  }

  /**
   * 从项目内所有 Agent 记录移除指定画布，不影响其它项目。
   * @param projectId 项目稳定 ID。
   * @param canvasId 画布稳定 ID。
   */
  clearCanvas(projectId: string, canvasId: string): void {
    /** 共享清理合同验证后的画布目标。 */
    const input = parseClearAgentCanvasBindingsInput({ projectId, target: 'canvas', canvasId })
    if (input.target !== 'canvas') throw new Error('CLEAR_AGENT_CANVAS_BINDINGS_INPUT_INVALID')
    /** fresh 磁盘快照与隔离候选，避免长期缓存参与写入。 */
    const { snapshot, bindings } = this.prepareMutation()
    /** 本轮是否实际修改过至少一条记录。 */
    let changed = false
    /** 同一次清理对所有保留记录使用一致时间戳。 */
    let timestamp: number | null = null

    for (let index = bindings.length - 1; index >= 0; index -= 1) {
      /** 当前候选记录。 */
      const existing = bindings[index]!
      if (existing.projectId !== input.projectId
        || !existing.linkedCanvasIds.includes(input.canvasId)) continue
      changed = true
      /** 删除目标画布后的稳定关联顺序。 */
      const linkedCanvasIds = existing.linkedCanvasIds.filter(
        (candidate) => candidate !== input.canvasId,
      )
      if (linkedCanvasIds.length === 0) {
        bindings.splice(index, 1)
        continue
      }
      /** 被清理默认画布的稳定替代项。 */
      const defaultCanvasId = existing.defaultCanvasId === input.canvasId
        ? linkedCanvasIds[0]!
        : existing.defaultCanvasId ?? linkedCanvasIds[0]!
      /** 被清理最近画布跟随当前可用默认。 */
      const lastActiveCanvasId = existing.lastActiveCanvasId === input.canvasId
        ? defaultCanvasId
        : existing.lastActiveCanvasId ?? defaultCanvasId
      timestamp ??= this.now()
      bindings[index] = {
        ...copyBinding(existing),
        defaultCanvasId,
        linkedCanvasIds,
        lastActiveCanvasId,
        updatedAt: timestamp,
      }
    }
    if (changed) this.persist(bindings, snapshot)
  }

  /** 延迟读取磁盘，并缓存规范化公开读结果。 */
  private load(): AgentCanvasBinding[] {
    if (this.bindings) return this.bindings
    /** 本次公开读使用的 fresh 权威快照。 */
    const snapshot = this.loadFresh()
    this.bindings = snapshot.file.bindings.map(copyBinding)
    return this.bindings
  }

  /**
   * 为 mutation 强制读取 fresh 快照，并创建不污染缓存的候选数组。
   * @returns 同一次读取绑定的 CAS 快照与隔离候选。
   */
  private prepareMutation(): {
    snapshot: AgentCanvasBindingsSnapshot
    bindings: AgentCanvasBinding[]
  } {
    /** mutation 不允许基于长期读缓存，必须重新读取当前磁盘事实。 */
    const snapshot = this.loadFresh()
    /** fresh 事实可供 no-op 后的公开读取复用。 */
    this.bindings = snapshot.file.bindings.map(copyBinding)
    return {
      snapshot,
      bindings: snapshot.file.bindings.map(copyBinding),
    }
  }

  /** 读取一次主文件或执行缺失主文件恢复，并捕获后续 CAS 所需状态。 */
  private loadFresh(): AgentCanvasBindingsSnapshot {
    /** 读取前主文件状态决定直接读取或进入 safe-file 恢复链。 */
    const initialState = this.readState(this.configPath)
    if (initialState !== null) {
      /** 主文件只读取一次，避免校验后再次读取形成 TOCTOU。 */
      const raw = this.readFile(this.configPath, 'utf8')
      try {
        /** 合法主文件同时作为候选基线和 prior backup 数据。 */
        const file = parseBindingsFile(JSON.parse(raw) as unknown)
        return {
          file,
          expectedDestination: { kind: 'state', state: initialState },
          priorFile: file,
        }
      } catch {
        this.warn('[Agent-画布关联] 主配置 JSON 或 schema 损坏，已降级为空')
        return {
          file: createEmptyBindingsFile(),
          expectedDestination: { kind: 'state', state: initialState },
          priorFile: null,
        }
      }
    }

    /** 主文件缺失时才允许 safe-file 检查并提升 tmp/bak 候选。 */
    const recoveredValue = this.readJson(this.configPath, { validate: isAgentCanvasBindingsFile })
    if (recoveredValue === null) {
      return {
        file: createEmptyBindingsFile(),
        expectedDestination: { kind: 'missing' },
        priorFile: null,
      }
    }
    /** validator 已筛选 schema，仍重建规范化副本供业务使用。 */
    const file = parseBindingsFile(recoveredValue)
    /** 恢复成功必须已发布主文件，后续 mutation 才能建立 state CAS。 */
    const recoveredState = this.readState(this.configPath)
    if (recoveredState === null) throw new Error('Agent-画布关联恢复后主文件缺失')
    return {
      file,
      expectedDestination: { kind: 'state', state: recoveredState },
      priorFile: file,
    }
  }

  /**
   * 按稳定身份排序并原子提交候选索引。
   * @param candidateBindings 尚未影响当前缓存的完整候选记录。
   * @param snapshot fresh load 捕获的 CAS 与 prior backup 依据。
   */
  private persist(
    candidateBindings: readonly AgentCanvasBinding[],
    snapshot: AgentCanvasBindingsSnapshot,
  ): void {
    /** 确定性排序后的隔离持久化记录。 */
    const bindings = candidateBindings.map(copyBinding).sort(compareBindings)
    /** 固定 schema v1 的完整写入值。 */
    const file: AgentCanvasBindingsFile = {
      version: AGENT_CANVAS_BINDINGS_VERSION,
      bindings,
    }
    /** secure writer 使用 fresh 状态阻断并发覆盖，并保留合法旧文件备份。 */
    const options: SecureAtomicJsonWriteOptions = {
      expectedDestination: snapshot.expectedDestination,
      ...(snapshot.priorFile === null
        ? {}
        : {
            priorBackup: {
              filePath: `${this.configPath}.bak`,
              data: snapshot.priorFile,
            },
          }),
    }
    try {
      this.writeJson(this.configPath, file, options)
    } catch (error) {
      /** rename 是否已提交不可判定，下一次访问必须回到磁盘权威事实。 */
      this.bindings = null
      throw error
    }
    this.bindings = bindings
  }
}

/** safe-file 使用的非抛出 schema validator，非法候选返回 false 继续恢复链。 */
function isAgentCanvasBindingsFile(value: unknown): value is AgentCanvasBindingsFile {
  try {
    parseBindingsFile(value)
    return true
  } catch {
    return false
  }
}

/** 创建尚未持久化的空索引。 */
function createEmptyBindingsFile(): AgentCanvasBindingsFile {
  return { version: AGENT_CANVAS_BINDINGS_VERSION, bindings: [] }
}

/**
 * 严格解析完整磁盘 schema，并拒绝重复项目+会话身份。
 * @param value 未可信 JSON 值。
 * @returns 规范化且身份唯一的索引。
 */
function parseBindingsFile(value: unknown): AgentCanvasBindingsFile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('AGENT_CANVAS_BINDINGS_FILE_INVALID')
  }
  /** 供精确字段检查的普通记录。 */
  const record = value as Record<string, unknown>
  /** 文件只允许固定版本和 bindings 两个字段。 */
  const keys = Object.keys(record).sort()
  if (keys.length !== 2
    || keys[0] !== 'bindings'
    || keys[1] !== 'version'
    || record.version !== AGENT_CANVAS_BINDINGS_VERSION
    || !Array.isArray(record.bindings)) {
    throw new Error('AGENT_CANVAS_BINDINGS_FILE_INVALID')
  }
  /** 逐项复用共享解析器规范化画布数组。 */
  const bindings = record.bindings.map(parseAgentCanvasBinding)
  /** 已出现的项目与会话复合身份。 */
  const identities = new Set<string>()
  for (const binding of bindings) {
    /** 生命周期 ID 不允许 NUL，分隔后可无歧义比较复合身份。 */
    const identity = `${binding.projectId}\0${binding.sessionId}`
    if (identities.has(identity)) throw new Error('AGENT_CANVAS_BINDING_IDENTITY_DUPLICATE')
    identities.add(identity)
  }
  return { version: AGENT_CANVAS_BINDINGS_VERSION, bindings }
}

/** 返回深度隔离的公开关联副本。 */
function copyBinding(binding: AgentCanvasBinding): AgentCanvasBinding {
  return { ...binding, linkedCanvasIds: [...binding.linkedCanvasIds] }
}

/** 按项目、会话身份确定性排序，避免时间相同或时钟回拨造成 diff 抖动。 */
function compareBindings(left: AgentCanvasBinding, right: AgentCanvasBinding): number {
  return left.projectId.localeCompare(right.projectId)
    || left.sessionId.localeCompare(right.sessionId)
}

/** 查找项目与会话复合身份的记录位置。 */
function findBindingIndex(
  bindings: readonly AgentCanvasBinding[],
  projectId: string,
  sessionId: string,
): number {
  return bindings.findIndex((binding) => (
    binding.projectId === projectId && binding.sessionId === sessionId
  ))
}
