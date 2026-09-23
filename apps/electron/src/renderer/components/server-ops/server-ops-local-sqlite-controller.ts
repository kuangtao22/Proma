import type {
  ServerOpsDataProbeResult,
  ServerOpsDataSource,
  ServerOpsDataSourceProbeDraft,
  ServerOpsDataSourceUpsertInput,
} from '@proma/shared'

/** 本地 SQLite 文件选择结果；取消选择不算错误。 */
export interface ServerOpsLocalSqliteFileSelection {
  filePath: string | null
  error: string | null
}

/** 本地 SQLite 导入结果，调用方据此决定是否更新列表和导航。 */
export interface ServerOpsLocalSqliteImportResult {
  source: ServerOpsDataSource
  created: boolean
  shouldNavigate: boolean
}

/** 本地 SQLite 导入所需的现有数据与 IPC 能力。 */
export interface ServerOpsLocalSqliteImportOptions {
  projectId: string
  filePath: string
  sources: readonly ServerOpsDataSource[]
  probe: (draft: ServerOpsDataSourceProbeDraft) => Promise<ServerOpsDataProbeResult>
  upsert: (input: ServerOpsDataSourceUpsertInput) => Promise<ServerOpsDataSource>
  /** 异步完成时确认用户仍停留在发起导入的项目与 Pane。 */
  isProjectCurrent: (projectId: string) => boolean
}

/** 从 POSIX 或 Windows 路径提取文件名，不改写原始路径。 */
function getLocalSqliteFileName(filePath: string): string {
  const fileName = filePath.split(/[\\/]/u).at(-1) || '本地 SQLite'
  return fileName.slice(0, 64)
}

/** 创建本地 SQLite 只读探测草稿。 */
export function createServerOpsLocalSqliteProbeDraft(filePath: string): ServerOpsDataSourceProbeDraft {
  return { transport: 'direct', engine: 'sqlite', filePath, database: 'main', tlsMode: 'disabled' }
}

/** 创建本地 SQLite 写入输入；文件身份只允许主进程生成。 */
export function createServerOpsLocalSqliteImportInput(filePath: string): ServerOpsDataSourceUpsertInput {
  return {
    transport: 'direct',
    engine: 'sqlite',
    label: getLocalSqliteFileName(filePath),
    filePath,
    database: 'main',
    tlsMode: 'disabled',
  }
}

/** 把拖放或文件输入收敛为单文件路径。 */
export function resolveServerOpsLocalSqliteFileSelection(paths: readonly string[]): ServerOpsLocalSqliteFileSelection {
  if (paths.length === 0) return { filePath: null, error: null }
  if (paths.length !== 1) return { filePath: null, error: '一次只能打开一个 SQLite 文件' }
  return { filePath: paths[0] ?? null, error: null }
}

/**
 * 探测并保存本地 SQLite；同项目同路径优先复用已有连接。
 *
 * @param options 文件、项目、数据源快照与 IPC 能力
 * @returns 导入结果以及是否仍可导航
 */
export async function importServerOpsLocalSqlite(
  options: ServerOpsLocalSqliteImportOptions,
): Promise<ServerOpsLocalSqliteImportResult> {
  /** 相同项目与路径的数据源代表同一个用户入口，避免重复写入绕过文件身份校验。 */
  const existing = options.sources.find((source) => source.projectId === options.projectId
    && source.engine === 'sqlite' && source.transport === 'direct' && source.filePath === options.filePath)
  if (existing) {
    return { source: existing, created: false, shouldNavigate: options.isProjectCurrent(options.projectId) }
  }

  /** 保存前必须先通过真实 SQLite 探测，损坏文件不会落入连接配置。 */
  const probe = await options.probe(createServerOpsLocalSqliteProbeDraft(options.filePath))
  if (probe.capability !== 'available') {
    throw new Error(probe.warnings[0] ?? '无法打开 SQLite 文件')
  }
  /** 项目归属使用发起时捕获值，不能读取异步完成时的当前项目。 */
  const source = await options.upsert({ ...createServerOpsLocalSqliteImportInput(options.filePath), projectId: options.projectId })
  return { source, created: true, shouldNavigate: options.isProjectCurrent(options.projectId) }
}
