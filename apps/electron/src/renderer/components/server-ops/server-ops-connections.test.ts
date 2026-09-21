import { describe, expect, test } from 'bun:test'
import type { ServerOpsDataSource, ServerOpsHost, ServerOpsProject } from '@proma/shared'
import {
  buildServerOpsConnections,
  createServerOpsDataConnectionId,
  createServerOpsSshConnectionId,
  filterServerOpsConnections,
  listServerOpsProjectConnections,
  resolveSelectedServerOpsConnection,
  resolveServerOpsWorkspaceTarget,
  summarizeServerOpsConnections,
} from './server-ops-connections'

/** 创建项目样本。 */
function createProject(id: string, name: string): ServerOpsProject {
  return { id, name, createdAt: 1, updatedAt: 1 }
}

/** 创建 SSH 主机样本。 */
function createHost(id: string, name: string, projectId?: string): ServerOpsHost {
  return {
    id, name, projectId, address: `${id}.internal`, port: 22, username: 'deploy',
    authMethod: 'ssh-agent', tags: [], createdAt: 1, updatedAt: 1,
  }
}

/** 创建数据源样本；默认是直连的 MySQL。 */
function createDataSource(id: string, label: string, overrides: Partial<ServerOpsDataSource> = {}): ServerOpsDataSource {
  return {
    id, label, transport: 'direct', engine: 'mysql', address: '127.0.0.1', port: 13306,
    tlsMode: 'disabled', hasPassword: false, createdAt: 1, updatedAt: 1,
    ...overrides,
  }
}

describe('项目连接模型', () => {
  test('Given 主机与数据源 When 构造连接 Then 统一为同级条目并按类别排序', () => {
    const projects = [createProject('project-1', '生产环境')]
    const connections = buildServerOpsConnections({
      projects,
      hosts: [createHost('host-1', '应用服务器', 'project-1')],
      dataSources: [
        createDataSource('source-1', '业务主库', { projectId: 'project-1' }),
        createDataSource('source-2', '会话缓存', { projectId: 'project-1', engine: 'redis', port: 16379, transport: 'ssh', hostId: 'host-1' }),
      ],
      connectionStates: { 'host-1': { hostId: 'host-1', phase: 'connected', connectionId: 'connection-1' } },
    })

    expect(connections.map((connection) => connection.kind)).toEqual(['ssh', 'database', 'redis'])
    expect(connections.map((connection) => connection.id)).toEqual(['ssh:host-1', 'data:source-1', 'data:source-2'])
    expect(connections[0]).toMatchObject({ kind: 'ssh', hostId: 'host-1', connected: true, detail: 'deploy@host-1.internal:22' })
    /** 数据源详情同时给出地址、库名与连接方式，界面上不必再进详情页确认。 */
    expect(connections[1]).toMatchObject({ kind: 'database', sourceId: 'source-1', detail: '127.0.0.1:13306 · 本机直连' })
    expect(connections[1]!.connected).toBeUndefined()
    expect(connections[2]!.detail).toContain('经跳板')
  })

  test('Given 三类真实连接 When 构造展示模型 Then 地址与说明直接来自源字段且保留分隔符库名', () => {
    const connections = buildServerOpsConnections({
      projects: [createProject('project-1', '生产环境')],
      hosts: [createHost('host-1', '应用服务器', 'project-1')],
      dataSources: [
        createDataSource('source-1', '业务主库', { projectId: 'project-1', database: 'app · archive' }),
        createDataSource('source-2', '会话缓存', {
          projectId: 'project-1', engine: 'redis', port: 16379, database: '3', transport: 'ssh', hostId: 'host-1',
        }),
      ],
      connectionStates: {},
    })

    expect(connections[0]).toMatchObject({
      endpoint: 'host-1.internal:22',
      metadata: 'deploy · SSH',
      detail: 'deploy@host-1.internal:22',
    })
    expect(connections[1]).toMatchObject({
      endpoint: '127.0.0.1:13306',
      metadata: '库 app · archive · 本机直连',
      detail: '127.0.0.1:13306 · 库 app · archive · 本机直连',
    })
    expect(connections[2]).toMatchObject({
      endpoint: '127.0.0.1:16379',
      metadata: 'DB 3 · 经跳板',
      detail: '127.0.0.1:16379 · 库 3 · 经跳板',
    })
  })

  test('Given SQLite 文件连接 When 构造展示模型 Then 卡片显示文件路径与 SQLite', () => {
    const connections = buildServerOpsConnections({
      projects: [createProject('project-1', '生产环境')],
      hosts: [createHost('host-1', '应用服务器', 'project-1')],
      dataSources: [createDataSource('source-sqlite', '审计文件', {
        projectId: 'project-1', transport: 'ssh', hostId: 'host-1', engine: 'sqlite',
        filePath: '/srv/data/audit.sqlite3', database: 'main',
      })],
      connectionStates: {},
    })
    expect(connections[1]).toMatchObject({
      kind: 'database',
      endpoint: '/srv/data/audit.sqlite3',
      metadata: 'SQLite · 经跳板',
      protocol: 'SQLite',
      detail: '/srv/data/audit.sqlite3 · SQLite · 经跳板',
      plaintextDirect: false,
    })
  })

  test('Given 三类连接 When 按类别过滤 Then 分别只返回服务器数据库与 Redis', () => {
    /** 三类连接保持固定顺序，便于同时验证 all 不重排。 */
    const connections = buildServerOpsConnections({
      projects: [createProject('project-1', '生产环境')],
      hosts: [createHost('host-1', '应用服务器', 'project-1')],
      dataSources: [
        createDataSource('source-1', '业务主库', { projectId: 'project-1' }),
        createDataSource('source-2', '会话缓存', { projectId: 'project-1', engine: 'redis' }),
      ],
      connectionStates: {},
    })

    expect(filterServerOpsConnections(connections, 'ssh', '').map((connection) => connection.id)).toEqual(['ssh:host-1'])
    expect(filterServerOpsConnections(connections, 'database', '').map((connection) => connection.id)).toEqual(['data:source-1'])
    expect(filterServerOpsConnections(connections, 'redis', '').map((connection) => connection.id)).toEqual(['data:source-2'])
    expect(filterServerOpsConnections(connections, 'all', '').map((connection) => connection.id)).toEqual([
      'ssh:host-1', 'data:source-1', 'data:source-2',
    ])
  })

  test('Given 搜索文本包含大小写与首尾空格 When 过滤 Then 查询命中名称详情地址或说明并与类别取交集', () => {
    /** 手工条目用于分别锁定四个可搜索展示字段，不依赖构造函数的文案重复。 */
    const connections = [
      {
        id: 'ssh:host-1', kind: 'ssh' as const, projectId: 'project-1', label: 'API Server',
        detail: 'legacy ssh detail', endpoint: 'HOST.EXAMPLE.COM:22', metadata: 'Deploy · SSH', hostId: 'host-1',
      },
      {
        id: 'data:source-1', kind: 'database' as const, projectId: 'project-1', label: 'Primary DB',
        detail: '兼容详情关键字', endpoint: '10.0.0.8:3306', metadata: '库 Orders · 本机直连', sourceId: 'source-1',
      },
      {
        id: 'data:source-2', kind: 'redis' as const, projectId: 'project-1', label: 'Session Cache',
        detail: 'legacy redis detail', endpoint: 'cache.internal:6379', metadata: 'DB 2 · 经跳板', sourceId: 'source-2',
      },
    ]

    expect(filterServerOpsConnections(connections, 'all', '  api SERVER  ').map((connection) => connection.id)).toEqual(['ssh:host-1'])
    expect(filterServerOpsConnections(connections, 'database', ' 兼容详情关键字 ').map((connection) => connection.id)).toEqual(['data:source-1'])
    expect(filterServerOpsConnections(connections, 'all', ' host.example.com:22 ').map((connection) => connection.id)).toEqual(['ssh:host-1'])
    expect(filterServerOpsConnections(connections, 'redis', ' DB 2 ').map((connection) => connection.id)).toEqual(['data:source-2'])
    expect(filterServerOpsConnections(connections, 'ssh', 'primary')).toEqual([])
  })

  test('Given 无匹配查询 When 过滤 Then 返回空数组且不修改输入数组或连接对象', () => {
    /** 冻结输入可直接证明过滤过程没有写入数组或条目。 */
    const connection = Object.freeze({
      id: 'ssh:host-1', kind: 'ssh' as const, projectId: 'project-1', label: '应用服务器',
      detail: 'deploy@host.internal:22', endpoint: 'host.internal:22', metadata: 'deploy · SSH', hostId: 'host-1',
    })
    const connections = Object.freeze([connection])

    expect(filterServerOpsConnections(connections, 'all', '不存在')).toEqual([])
    const result = filterServerOpsConnections(connections, 'all', '')
    expect(result).not.toBe(connections)
    expect(result[0]).toBe(connection)
    expect(connections).toEqual([connection])
  })

  test('Given 未迁移条目 When 构造连接 Then 归入第一个项目而不是消失', () => {
    const projects = [createProject('project-1', '默认项目'), createProject('project-2', '本地开发')]
    const connections = buildServerOpsConnections({
      projects,
      hosts: [createHost('legacy', '未迁移主机')],
      dataSources: [createDataSource('legacy-source', '未迁移数据源')],
      connectionStates: {},
    })
    expect(connections.every((connection) => connection.projectId === 'project-1')).toBe(true)
  })

  test('Given 多项目 When 列出项目连接 Then 只返回该项目条目', () => {
    const projects = [createProject('project-1', '生产环境'), createProject('project-2', '本地开发')]
    const source = {
      projects,
      hosts: [createHost('host-1', '生产应用', 'project-1'), createHost('host-2', '开发应用', 'project-2')],
      dataSources: [createDataSource('source-1', '生产库', { projectId: 'project-2' })],
      connectionStates: {},
    }
    expect(listServerOpsProjectConnections(source, 'project-1').map((connection) => connection.id)).toEqual(['ssh:host-1'])
    expect(listServerOpsProjectConnections(source, 'project-2').map((connection) => connection.id)).toEqual(['ssh:host-2', 'data:source-1'])
    expect(listServerOpsProjectConnections(source, null)).toEqual([])
  })

  test('Given 连接选择失效 When 解析选中连接 Then 回落第一项且空列表返回 null', () => {
    const projects = [createProject('project-1', '生产环境')]
    const connections = listServerOpsProjectConnections({
      projects,
      hosts: [createHost('host-1', '应用服务器', 'project-1')],
      dataSources: [createDataSource('source-1', '业务主库', { projectId: 'project-1' })],
      connectionStates: {},
    }, 'project-1')
    expect(resolveSelectedServerOpsConnection(connections, 'data:source-1')?.id).toBe('data:source-1')
    expect(resolveSelectedServerOpsConnection(connections, 'ssh:deleted')?.id).toBe('ssh:host-1')
    expect(resolveSelectedServerOpsConnection(connections, null)?.id).toBe('ssh:host-1')
    expect(resolveSelectedServerOpsConnection([], 'ssh:host-1')).toBeNull()
  })

  test('Given 多项目连接 When 统计 Then 按项目分别计数且与列表一致', () => {
    const projects = [createProject('project-1', '生产环境'), createProject('project-2', '本地开发')]
    const connections = buildServerOpsConnections({
      projects,
      hosts: [createHost('host-1', '生产应用', 'project-1'), createHost('host-2', '开发应用', 'project-2')],
      dataSources: [
        createDataSource('source-1', '生产库', { projectId: 'project-1' }),
        createDataSource('source-2', '生产缓存', { projectId: 'project-1', engine: 'redis', port: 16379, transport: 'ssh', hostId: 'host-1' }),
        createDataSource('source-3', '开发库', { projectId: 'project-2' }),
      ],
      connectionStates: {},
    })
    const summary = summarizeServerOpsConnections(connections)
    expect(summary['project-1']).toEqual({ ssh: 1, database: 1, redis: 1, total: 3 })
    expect(summary['project-2']).toEqual({ ssh: 1, database: 1, redis: 0, total: 2 })
    /** 统计必须与"进入项目后看到的条目数"一致，否则抽屉摘要会误导。 */
    expect(summary['project-1']!.total).toBe(listServerOpsProjectConnections({
      projects, hosts: [createHost('host-1', '生产应用', 'project-1')],
      dataSources: [createDataSource('source-1', '生产库', { projectId: 'project-1' })],
      connectionStates: {},
    }, 'project-1').length + 1)
    expect(summarizeServerOpsConnections([])).toEqual({})
  })

  test('Given 连接 ID When 构造 Then 与列表条目一致', () => {
    /** 一台主机与一个数据源构成的连接列表。 */
    const connections = buildServerOpsConnections({
      projects: [createProject('project-1', '生产环境')],
      hosts: [createHost('host-1', '应用服务器', 'project-1')],
      dataSources: [createDataSource('source-1', '业务主库', { projectId: 'project-1' })],
      connectionStates: {},
    })
    expect(connections.map((connection) => connection.id)).toEqual([
      createServerOpsSshConnectionId('host-1'),
      createServerOpsDataConnectionId('source-1'),
    ])
  })

  test('Given 内网直连与已校验证书的连接 When 构造 Then 只有明文那条带标记', () => {
    /** 三条数据连接：内网明文、内网证书校验、公网证书校验。 */
    const connections = buildServerOpsConnections({
      projects: [createProject('project-1', '生产环境')],
      hosts: [],
      dataSources: [
        createDataSource('source-plain', '内网明文库', { transport: 'direct', address: '172.16.10.198', tlsMode: 'disabled' }),
        createDataSource('source-internal-tls', '内网 TLS 库', { transport: 'direct', address: '10.0.0.9', tlsMode: 'verify', tlsServerName: 'db.internal' }),
        createDataSource('source-public-tls', '公网 TLS 库', { transport: 'direct', address: '8.8.8.8', tlsMode: 'verify', tlsServerName: 'db.example.com' }),
        createDataSource('source-preferred', '优先 TLS 库', { transport: 'direct', address: '10.0.0.8', tlsMode: 'preferred' }),
      ],
      connectionStates: {},
    })
    expect(connections.find((connection) => connection.id === 'data:source-plain')?.plaintextDirect).toBe(true)
    expect(connections.find((connection) => connection.id === 'data:source-internal-tls')?.plaintextDirect).toBe(false)
    expect(connections.find((connection) => connection.id === 'data:source-public-tls')?.plaintextDirect).toBe(false)
    expect(connections.find((connection) => connection.id === 'data:source-preferred')?.plaintextDirect).toBe(false)
  })

  test('Given 停留项目视图或选择某条连接 When 解析中间区域目标 Then 分别渲染项目分组与能力页签', () => {
    /** 当前项目下的连接：一台服务器、一个数据库。 */
    const connections = listServerOpsProjectConnections({
      projects: [createProject('project-1', '生产环境')],
      hosts: [createHost('host-1', '应用服务器', 'project-1')],
      dataSources: [createDataSource('source-1', '业务主库', { projectId: 'project-1' })],
      connectionStates: {},
    }, 'project-1')

    /** 项目视图优先于连接选择：抽屉里的项目行代表"进入项目"。 */
    expect(resolveServerOpsWorkspaceTarget({ projectViewActive: true, connections, selectedConnectionId: 'data:source-1' }))
      .toEqual({ kind: 'project' })
    expect(resolveServerOpsWorkspaceTarget({ projectViewActive: false, connections, selectedConnectionId: 'ssh:host-1' }))
      .toMatchObject({ kind: 'connection', connection: { kind: 'ssh', hostId: 'host-1' } })
    expect(resolveServerOpsWorkspaceTarget({ projectViewActive: false, connections, selectedConnectionId: 'data:source-1' }))
      .toMatchObject({ kind: 'connection', connection: { kind: 'database', sourceId: 'source-1' } })
  })

  test('Given 选择失效或该项目没有连接 When 解析中间区域目标 Then 回落项目视图而不是停在旧连接', () => {
    /** 只含一台服务器的项目连接。 */
    const connections = listServerOpsProjectConnections({
      projects: [createProject('project-1', '生产环境')],
      hosts: [createHost('host-1', '应用服务器', 'project-1')],
      dataSources: [],
      connectionStates: {},
    }, 'project-1')

    /** 已删除的连接：继续渲染它会让用户操作一条不存在的连接。 */
    expect(resolveServerOpsWorkspaceTarget({ projectViewActive: false, connections, selectedConnectionId: 'ssh:deleted' }))
      .toEqual({ kind: 'project' })
    /** 跨项目移动后，即使原项目还有其它连接，也不能悄悄切换操作目标。 */
    expect(resolveServerOpsWorkspaceTarget({ projectViewActive: false, connections, selectedConnectionId: 'data:moved' }))
      .toEqual({ kind: 'project' })
    /** 该项目没有任何连接时只能回到项目视图，而不是空白的连接视图。 */
    expect(resolveServerOpsWorkspaceTarget({ projectViewActive: false, connections: [], selectedConnectionId: 'ssh:host-1' }))
      .toEqual({ kind: 'project' })
  })
})
