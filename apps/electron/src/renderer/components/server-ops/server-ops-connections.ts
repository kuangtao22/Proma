import type { ServerOpsConnectionState, ServerOpsDataSource, ServerOpsHost, ServerOpsProject } from '@proma/shared'
import { isServerOpsPlaintextDirectAddress } from '@proma/shared'

/**
 * 项目下连接的类别。
 *
 * `ssh` 派生出终端/文件/Docker/服务/日志；`database` 与 `redis` 是数据服务连接，
 * 各自独立登录，不依赖任何 SSH 主机。
 */
export type ServerOpsConnectionKind = 'ssh' | 'database' | 'redis'

/** 项目下的统一连接条目；SSH 主机与数据源在 UI 上是同级的连接。 */
export interface ServerOpsConnection {
  /** 稳定标识：`ssh:<hostId>` 或 `data:<sourceId>`，供选择与页签路由使用。 */
  id: string
  kind: ServerOpsConnectionKind
  /** 归属项目；未迁移条目归入第一个项目。 */
  projectId: string
  label: string
  /** 次要说明，例如 `deploy@10.0.0.8:22` 或 `127.0.0.1:13306 · 库 app`。 */
  detail: string
  /** 卡片单独展示的连接地址；兼容旧调用方，因此保持可选。 */
  endpoint?: string
  /** 卡片单独展示的连接说明；兼容旧调用方，因此保持可选。 */
  metadata?: string
  /** 卡片展示的真实协议或引擎名称；旧调用方缺省时由类别回退。 */
  protocol?: 'SSH' | 'MySQL' | 'PostgreSQL' | 'SQLite' | 'Redis'
  /** SSH 连接对应的主机 ID。 */
  hostId?: string
  /** 数据库/Redis 连接对应的数据源 ID。 */
  sourceId?: string
  /** SSH 连接当前是否已建立；数据库连接在读取时才有结论，这里保持 undefined。 */
  connected?: boolean
  /**
   * 该数据连接是否以明文直连私有网段（关闭 TLS）。
   *
   * 这是被允许但有代价的形态：密码与查询结果明文经过内网。界面必须让它看得见，
   * 不能和开启校验的连接长得一模一样。
   */
  plaintextDirect?: boolean
}

/** 构造连接列表所需的输入。 */
export interface ServerOpsConnectionSource {
  projects: readonly ServerOpsProject[]
  hosts: readonly ServerOpsHost[]
  dataSources: readonly ServerOpsDataSource[]
  /** 各主机的公开 SSH 连接状态。 */
  connectionStates: Readonly<Record<string, ServerOpsConnectionState | undefined>>
}

/** SSH 连接在列表中的稳定前缀。 */
const SSH_CONNECTION_PREFIX = 'ssh:'
/** 数据服务连接在列表中的稳定前缀。 */
const DATA_CONNECTION_PREFIX = 'data:'

/**
 * 构造 SSH 连接的稳定 ID。
 *
 * 调用方（例如"刚保存了一台服务器"）需要在连接列表之外定位到同一条连接，
 * 因此前缀必须由这里统一产出，不能各自拼字符串。
 *
 * @param hostId 主机 ID
 * @returns `ssh:<hostId>`
 */
export function createServerOpsSshConnectionId(hostId: string): string {
  return `${SSH_CONNECTION_PREFIX}${hostId}`
}

/**
 * 构造数据连接的稳定 ID。
 *
 * @param sourceId 数据源 ID
 * @returns `data:<sourceId>`
 */
export function createServerOpsDataConnectionId(sourceId: string): string {
  return `${DATA_CONNECTION_PREFIX}${sourceId}`
}

/** 把数据源引擎映射为连接类别。 */
function toConnectionKind(engine: ServerOpsDataSource['engine']): ServerOpsConnectionKind {
  return engine === 'redis' ? 'redis' : 'database'
}

/**
 * 构造全部连接。
 *
 * 未迁移（没有 `projectId`）的主机与数据源归入第一个项目，保证升级后条目不会从界面上消失；
 * 排序按 SSH → 数据库 → Redis，组内保持输入顺序（主机与数据源各自已按创建时间排序）。
 *
 * @param source 项目、主机、数据源与连接状态
 * @returns 统一连接列表
 */
export function buildServerOpsConnections(source: ServerOpsConnectionSource): ServerOpsConnection[] {
  /** 未迁移条目的归属项目。 */
  const legacyProjectId = source.projects[0]?.id ?? ''
  /** SSH 连接条目。 */
  const sshConnections: ServerOpsConnection[] = source.hosts.map((host) => {
    /** 该主机当前的公开连接状态。 */
    const state = source.connectionStates[host.id]
    return {
      id: createServerOpsSshConnectionId(host.id),
      kind: 'ssh',
      projectId: host.projectId ?? legacyProjectId,
      label: host.name,
      detail: `${host.username}@${host.address}:${host.port}`,
      endpoint: `${host.address}:${host.port}`,
      metadata: `${host.username} · SSH`,
      protocol: 'SSH',
      hostId: host.id,
      connected: state?.phase === 'connected',
    }
  })
  /** 数据库与 Redis 连接条目。 */
  const dataConnections: ServerOpsConnection[] = source.dataSources.map((dataSource) => {
    /** SQLite 用远端文件路径作为可识别端点；网络引擎继续展示地址和端口。 */
    const endpoint = dataSource.engine === 'sqlite'
      ? dataSource.filePath
      : `${dataSource.address}:${dataSource.port}`
    /** SQLite 的 main 是固定内部库名，卡片只需说明引擎与 SSH 链路。 */
    const databaseLabel = dataSource.engine === 'sqlite'
      ? 'SQLite'
      : dataSource.database === undefined
        ? undefined
        : dataSource.engine === 'redis' ? `DB ${dataSource.database}` : `库 ${dataSource.database}`
    /** 兼容既有卡片详情：Redis 详情仍使用“库”，metadata 使用“DB”。 */
    const detailDatabaseLabel = dataSource.engine === 'redis' && dataSource.database !== undefined
      ? `库 ${dataSource.database}`
      : databaseLabel
    const transportLabel = dataSource.transport === 'direct' ? '本机直连' : '经跳板'
    return {
      id: createServerOpsDataConnectionId(dataSource.id),
      kind: toConnectionKind(dataSource.engine),
      projectId: dataSource.projectId ?? legacyProjectId,
      label: dataSource.label,
      detail: [endpoint, detailDatabaseLabel, transportLabel].filter((part): part is string => part !== undefined).join(' · '),
      endpoint,
      metadata: [databaseLabel, transportLabel].filter((part): part is string => part !== undefined).join(' · '),
      protocol: dataSource.engine === 'postgresql' ? 'PostgreSQL' : dataSource.engine === 'sqlite' ? 'SQLite' : dataSource.engine === 'redis' ? 'Redis' : 'MySQL',
      sourceId: dataSource.id,
      /** 只有明确关闭 TLS 的私网直连才可由配置判定为明文；优先 TLS 需看实测结果。 */
      plaintextDirect: dataSource.engine !== 'sqlite'
        && dataSource.transport === 'direct'
        && dataSource.tlsMode === 'disabled'
        && dataSource.address !== undefined
        && isServerOpsPlaintextDirectAddress(dataSource.address),
    }
  })
  /** 类别顺序固定，避免不同数据类型混排后难以扫描。 */
  const order: Record<ServerOpsConnectionKind, number> = { ssh: 0, database: 1, redis: 2 }
  return [...sshConnections, ...dataConnections].sort((left, right) => order[left.kind] - order[right.kind])
}

/**
 * 列出指定项目下的连接。
 *
 * @param source 项目、主机、数据源与连接状态
 * @param projectId 目标项目
 * @returns 该项目的连接列表
 */
export function listServerOpsProjectConnections(source: ServerOpsConnectionSource, projectId: string | null): ServerOpsConnection[] {
  if (projectId === null) return []
  return buildServerOpsConnections(source).filter((connection) => connection.projectId === projectId)
}

/**
 * 按连接类别与卡片展示文本过滤当前项目连接。
 *
 * 过滤只读取内存模型，不改写输入数组或连接对象，也不改变原有排序。
 *
 * @param connections 当前项目下的连接
 * @param kind 目标类别，`all` 表示全部类别
 * @param query 用户输入的搜索文本
 * @returns 同时满足类别和搜索条件的新数组
 */
export function filterServerOpsConnections(
  connections: readonly ServerOpsConnection[],
  kind: ServerOpsConnectionKind | 'all',
  query: string,
): ServerOpsConnection[] {
  /** 搜索统一忽略首尾空格与大小写。 */
  const normalizedQuery = query.trim().toLowerCase()
  return connections.filter((connection) => {
    if (kind !== 'all' && connection.kind !== kind) return false
    if (normalizedQuery === '') return true
    /** 搜索范围与卡片可见信息一致，同时保留旧详情的兼容命中。 */
    const searchableFields = [connection.label, connection.detail, connection.endpoint, connection.metadata]
    return searchableFields.some((field) => field?.toLowerCase().includes(normalizedQuery) === true)
  })
}

/**
 * 解析当前选中的连接；选择为空或指向已删除条目时回落到列表第一项。
 *
 * @param connections 当前项目下的连接
 * @param selectedConnectionId 用户上次选择
 * @returns 生效的连接；列表为空时为 null
 */
export function resolveSelectedServerOpsConnection(
  connections: readonly ServerOpsConnection[],
  selectedConnectionId: string | null,
): ServerOpsConnection | null {
  if (selectedConnectionId !== null) {
    /** 命中用户上次选择的连接。 */
    const selected = connections.find((connection) => connection.id === selectedConnectionId)
    if (selected) return selected
  }
  return connections[0] ?? null
}

/** 中间区域当前要渲染的目标。 */
export type ServerOpsWorkspaceTarget =
  /** 项目视图：展示该项目下的服务器 / 数据库 / Redis 三个分组。 */
  | { kind: 'project' }
  /** 连接视图：SSH 进入能力页签，数据库 / Redis 进入数据服务详情。 */
  | { kind: 'connection'; connection: ServerOpsConnection }

/**
 * 解析中间区域要渲染的目标。
 *
 * 项目视图是连接清单本身，只有用户显式进入某条连接后才切换到连接视图；
 * 连接视图下若选择失效（连接被删除、或残留了别的项目的选择），必须回落项目视图，
 * 否则中间区域会拿出一条已经不存在、甚至不属于当前项目的连接。
 *
 * @param options 视图模式、当前项目连接与用户选择
 * @returns 项目视图或某条连接视图
 */
export function resolveServerOpsWorkspaceTarget(options: {
  /** 用户当前是否停留在项目视图（由抽屉进入项目、或连接视图的"返回项目"驱动）。 */
  projectViewActive: boolean
  /** 当前项目下的连接，已由调用方按项目过滤。 */
  connections: readonly ServerOpsConnection[]
  selectedConnectionId: string | null
}): ServerOpsWorkspaceTarget {
  if (options.projectViewActive) return { kind: 'project' }
  /** 删除或移动后选择失效时返回项目清单，不能悄悄切到另一台服务器。 */
  const selected = options.connections.find((connection) => connection.id === options.selectedConnectionId)
  return selected === undefined ? { kind: 'project' } : { kind: 'connection', connection: selected }
}

/** 单个项目的连接统计；用于抽屉里"3 服务器 · 1 数据库 · 1 Redis"这类摘要。 */
export interface ServerOpsConnectionSummary {
  ssh: number
  database: number
  redis: number
  /** 连接总数，便于判断卡片是否为空。 */
  total: number
}

/**
 * 统计各项目的连接数量。
 *
 * 抽屉一级只展示项目与其统计，因此计数必须来自同一份连接模型，
 * 不能单独去数主机与数据源，否则统计和进入项目后看到的条目会对不上。
 *
 * @param connections 全部连接
 * @returns 项目 ID 到统计的映射；没有连接的项目不出现，调用方按需补零
 */
export function summarizeServerOpsConnections(
  connections: readonly ServerOpsConnection[],
): Record<string, ServerOpsConnectionSummary> {
  /** 按项目累计的统计结果。 */
  const summary: Record<string, ServerOpsConnectionSummary> = {}
  for (const connection of connections) {
    /** 当前项目的累计项，缺失时先建零值。 */
    const bucket = summary[connection.projectId] ?? { ssh: 0, database: 0, redis: 0, total: 0 }
    bucket[connection.kind] += 1
    bucket.total += 1
    summary[connection.projectId] = bucket
  }
  return summary
}
