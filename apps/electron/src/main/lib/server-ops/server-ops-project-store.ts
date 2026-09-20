import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { isServerOpsId, parseServerOpsProject } from '@proma/shared'
import type { ServerOpsProject } from '@proma/shared'
import { getConfigDir } from '../config-paths'
import { readAtomicFileState, readJsonFileSafe, writeJsonFileAtomicSecure } from '../safe-file'
import type { AtomicDestinationExpectation, ReadJsonFileSafeOptions } from '../safe-file'
import {
  createServerOpsConfigTransaction,
  resolveServerOpsConfigFilePath,
} from './server-ops-config-transaction'
import type { ServerOpsConfigTransaction } from './server-ops-config-transaction'

/** 项目文件所在目录。 */
const SERVER_OPS_DIRECTORY = 'server-ops'
/** 项目文件名。 */
const SERVER_OPS_PROJECTS_FILENAME = 'projects.json'
/** 当前项目文件 schema 版本。 */
const SERVER_OPS_PROJECTS_VERSION = 1
/** 迁移时自动创建的默认项目名称。 */
const SERVER_OPS_DEFAULT_PROJECT_NAME = '默认项目'
/** 公开项目列表合同允许的最大项目数。 */
const SERVER_OPS_PROJECT_LIMIT = 200

/** 项目 Store 可替换依赖。 */
export interface ServerOpsProjectStoreDependencies {
  readJson: <T>(filePath: string, options: ReadJsonFileSafeOptions<T>) => T | null
  writeJson: (filePath: string, data: object, expectedDestination: AtomicDestinationExpectation, priorBackup?: object) => void
  uuid: () => string
  now: () => number
  transaction?: ServerOpsConfigTransaction
  /** 在当前配置事务内判断项目是否仍被主机或数据源引用。 */
  hasProjectReferences?: (projectId: string) => boolean
}

/** 创建生产环境使用的项目 Store 依赖。 */
export function createServerOpsProjectStoreDependencies(): ServerOpsProjectStoreDependencies {
  return {
    readJson: readJsonFileSafe,
    writeJson: (filePath, data, expectedDestination, priorBackup) => {
      writeJsonFileAtomicSecure(filePath, data, {
        expectedDestination,
        ...(priorBackup ? { priorBackup: { filePath: `${filePath}.bak`, data: priorBackup } } : {}),
      })
    },
    uuid: randomUUID,
    now: Date.now,
  }
}

/** 项目文件的版本化根结构。 */
interface ServerOpsProjectFile {
  version: typeof SERVER_OPS_PROJECTS_VERSION
  projects: ServerOpsProject[]
}

/** 判断未知值是否为普通可枚举对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 严格解析项目文件根结构，拒绝未知字段与重复 ID。 */
function parseProjectFile(value: unknown): ServerOpsProjectFile {
  const errorCode = 'SERVER_OPS_PROJECT_FILE_INVALID'
  if (!isRecord(value) || value.version !== SERVER_OPS_PROJECTS_VERSION
    || !Array.isArray(value.projects) || Object.keys(value).some((key) => key !== 'version' && key !== 'projects')) {
    throw new Error(errorCode)
  }
  /** 解析后的项目列表；单条不合法的错误码统一收敛为文件损坏。 */
  const projects = value.projects.map((entry) => {
    try {
      return parseServerOpsProject(entry)
    } catch {
      throw new Error(errorCode)
    }
  })
  /** 重复 ID 的文件不可信，避免按 ID 定位到错误项目。 */
  const seen = new Set<string>()
  for (const project of projects) {
    if (seen.has(project.id)) throw new Error(errorCode)
    seen.add(project.id)
  }
  return { version: SERVER_OPS_PROJECTS_VERSION, projects }
}

/**
 * 管理 `~/.proma/server-ops/projects.json` 的运维项目。
 *
 * 项目只承载分组与归属边界，不持有任何连接信息；凭据、信任与审计仍各自维护。
 */
export class ServerOpsProjectStore {
  /** 项目文件路径。 */
  private readonly filePath: string
  /** 可替换的安全文件、时间与 ID 边界。 */
  private readonly dependencies: ServerOpsProjectStoreDependencies
  /** 覆盖同目录协作写入的同步短事务。 */
  private readonly transaction: ServerOpsConfigTransaction

  /**
   * 创建项目 Store。
   *
   * @param configDir Proma 业务配置根
   * @param dependencies 测试可替换依赖
   */
  constructor(configDir = getConfigDir(), dependencies: Partial<ServerOpsProjectStoreDependencies> = {}) {
    const directoryPath = join(configDir, SERVER_OPS_DIRECTORY)
    mkdirSync(directoryPath, { recursive: true })
    this.filePath = resolveServerOpsConfigFilePath(directoryPath, SERVER_OPS_PROJECTS_FILENAME)
    this.dependencies = { ...createServerOpsProjectStoreDependencies(), ...dependencies }
    this.transaction = dependencies.transaction ?? createServerOpsConfigTransaction(directoryPath)
  }

  /**
   * 列出全部项目，按创建时间升序。
   *
   * @returns 项目副本列表
   */
  list(): ServerOpsProject[] {
    return this.readStoredProjects().projects
      .sort((left, right) => left.createdAt - right.createdAt)
      .map((project) => ({ ...project }))
  }

  /**
   * 读取单个项目。
   *
   * @param projectId 项目 ID
   * @returns 项目副本；不存在时返回 undefined
   */
  get(projectId: string): ServerOpsProject | undefined {
    if (!isServerOpsId(projectId)) return undefined
    const found = this.readStoredProjects().projects.find((project) => project.id === projectId)
    return found ? { ...found } : undefined
  }

  /**
   * 新建项目。
   *
   * @param name 已通过共享合同解析的项目名称
   * @returns 新建的项目
   */
  create(name: string): ServerOpsProject {
    return this.transaction(() => {
      const loaded = this.readStoredProjects()
      if (loaded.projects.length >= SERVER_OPS_PROJECT_LIMIT) throw new Error('SERVER_OPS_PROJECT_LIMIT_REACHED')
      /** 同名项目直接拒绝，避免侧栏出现无法区分的两项。 */
      if (loaded.projects.some((project) => project.name === name)) throw new Error('SERVER_OPS_PROJECT_NAME_TAKEN')
      const now = this.dependencies.now()
      /** 待写入的新项目。 */
      const created: ServerOpsProject = { id: this.dependencies.uuid(), name, createdAt: now, updatedAt: now }
      if (!isServerOpsId(created.id)) throw new Error('SERVER_OPS_PROJECT_ID_INVALID')
      this.persist([...loaded.projects, created], loaded.expectedDestination, loaded.priorBackup)
      return { ...created }
    })
  }

  /**
   * 重命名项目。
   *
   * @param projectId 项目 ID
   * @param name 新名称
   * @returns 更新后的项目
   */
  rename(projectId: string, name: string): ServerOpsProject {
    return this.transaction(() => {
      const loaded = this.readStoredProjects()
      const index = loaded.projects.findIndex((project) => project.id === projectId)
      if (index < 0) throw new Error('SERVER_OPS_PROJECT_NOT_FOUND')
      if (loaded.projects.some((project) => project.id !== projectId && project.name === name)) {
        throw new Error('SERVER_OPS_PROJECT_NAME_TAKEN')
      }
      const existing = loaded.projects[index]!
      /** 名称未变化时保持原 updatedAt，避免无意义写入。 */
      const updated: ServerOpsProject = { ...existing, name, updatedAt: name === existing.name ? existing.updatedAt : this.dependencies.now() }
      this.persist(loaded.projects.map((project, at) => at === index ? updated : project), loaded.expectedDestination, loaded.priorBackup)
      return { ...updated }
    })
  }

  /**
   * 删除项目。
   *
   * @param projectId 项目 ID
   * @returns 是否实际删除
   */
  remove(projectId: string): boolean {
    return this.transaction(() => {
      const loaded = this.readStoredProjects()
      const remaining = loaded.projects.filter((project) => project.id !== projectId)
      if (remaining.length === loaded.projects.length) return false
      /** 只剩一个项目时拒绝删除，保证任何连接都有归属。 */
      if (loaded.projects.length <= 1) throw new Error('SERVER_OPS_PROJECT_LAST_REMAINING')
      /** 引用检查与删除共享当前配置事务，避免检查后新增连接形成孤儿。 */
      if (this.dependencies.hasProjectReferences?.(projectId) === true) {
        throw new Error('SERVER_OPS_PROJECT_NOT_EMPTY')
      }
      this.persist(remaining, loaded.expectedDestination, loaded.priorBackup)
      return true
    })
  }

  /**
   * 保证至少存在一个项目，返回默认项目 ID。
   *
   * 迁移语义：文件不存在时创建「默认项目」；已有项目时返回最早创建的那个，
   * 供尚无 `projectId` 的主机与数据源归入。
   *
   * @returns 可用于归属旧数据的主机项目 ID
   */
  ensureDefaultProject(): string {
    return this.transaction(() => {
      const loaded = this.readStoredProjects()
      const existing = [...loaded.projects].sort((left, right) => left.createdAt - right.createdAt)[0]
      if (existing) return existing.id
      const now = this.dependencies.now()
      /** 迁移期创建的默认项目。 */
      const created: ServerOpsProject = { id: this.dependencies.uuid(), name: SERVER_OPS_DEFAULT_PROJECT_NAME, createdAt: now, updatedAt: now }
      if (!isServerOpsId(created.id)) throw new Error('SERVER_OPS_PROJECT_ID_INVALID')
      this.persist([created], loaded.expectedDestination, loaded.priorBackup)
      return created.id
    })
  }

  /**
   * 在配置事务内解析连接创建所需的项目归属。
   *
   * @param projectId Renderer 显式指定的项目；省略时兼容旧调用并使用默认项目
   * @returns 当前权威项目文件中存在的项目 ID
   */
  resolveProjectId(projectId?: string): string {
    return this.transaction(() => {
      if (projectId === undefined) return this.ensureDefaultProject()
      if (!this.readStoredProjects().projects.some((project) => project.id === projectId)) {
        throw new Error('SERVER_OPS_PROJECT_NOT_FOUND')
      }
      return projectId
    })
  }

  /** fresh-read 当前项目文件；坏文件不得降级为空后被覆盖。 */
  private readStoredProjects(): {
    projects: ServerOpsProject[]
    expectedDestination: AtomicDestinationExpectation
    priorBackup?: object
  } {
    const existed = existsSync(this.filePath)
    const loaded = this.dependencies.readJson(this.filePath, { validate: isProjectFileShape })
    const expectedDestination = this.captureDestinationExpectation()
    if (loaded === null) {
      if (existed) throw new Error('SERVER_OPS_PROJECT_READ_FAILED')
      return { projects: [], expectedDestination }
    }
    const parsed = parseProjectFile(loaded)
    return {
      projects: parsed.projects.map((project) => ({ ...project })),
      expectedDestination,
      priorBackup: { version: SERVER_OPS_PROJECTS_VERSION, projects: parsed.projects.map((project) => ({ ...project })) },
    }
  }

  /** 原子提交完整项目快照。 */
  private persist(projects: readonly ServerOpsProject[], expectedDestination: AtomicDestinationExpectation, priorBackup?: object): void {
    this.dependencies.writeJson(
      this.filePath,
      { version: SERVER_OPS_PROJECTS_VERSION, projects: projects.map((project) => ({ ...project })) } satisfies ServerOpsProjectFile,
      expectedDestination,
      priorBackup,
    )
  }

  /** 捕获 fresh-read 对应的目标身份。 */
  private captureDestinationExpectation(): AtomicDestinationExpectation {
    const state = readAtomicFileState(this.filePath)
    return state === null ? { kind: 'missing' } : { kind: 'state', state }
  }
}

/** 仅在 safe-file 层做形状判定，完整校验交给 parseProjectFile。 */
function isProjectFileShape(value: unknown): value is ServerOpsProjectFile {
  return isRecord(value) && value.version === SERVER_OPS_PROJECTS_VERSION && Array.isArray(value.projects)
}
