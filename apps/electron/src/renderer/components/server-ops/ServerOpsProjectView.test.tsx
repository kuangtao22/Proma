import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ServerOpsProject } from '@proma/shared'
import { ServerOpsProjectView } from './ServerOpsProjectView'
import type { ServerOpsConnection } from './server-ops-connections'

/** 项目样本。 */
const project: ServerOpsProject = { id: 'project-1', name: '生产环境', createdAt: 1, updatedAt: 1 }

/** 连接样本：一台已连接服务器、一个数据库、一个 Redis。 */
const connections: ServerOpsConnection[] = [
  { id: 'ssh:host-1', kind: 'ssh', projectId: 'project-1', label: '应用服务器', detail: 'deploy@10.0.0.8:22', protocol: 'SSH', hostId: 'host-1', connected: true },
  { id: 'data:source-1', kind: 'database', projectId: 'project-1', label: '业务主库', detail: '127.0.0.1:13306 · 本机直连', protocol: 'MySQL', sourceId: 'source-1', plaintextDirect: true },
  { id: 'data:source-2', kind: 'redis', projectId: 'project-1', label: '会话缓存', detail: '127.0.0.1:16379 · 本机直连', protocol: 'Redis', sourceId: 'source-2' },
]

/** 渲染项目视图。 */
function renderView(overrides: Partial<React.ComponentProps<typeof ServerOpsProjectView>> = {}): string {
  return renderToStaticMarkup(
    <ServerOpsProjectView
      project={project}
      connections={connections}
      selectedConnectionId="ssh:host-1"
      onSelectConnection={() => undefined}
      onOpenDrawer={() => undefined}
      onAddConnection={() => undefined}
      {...overrides}
    />,
  )
}

/**
 * 在项目视图返回的元素树里找到某个连接行。
 *
 * 这里直接调用组件函数取回元素树（与工作区既有测试同一套手法），
 * 才能在不引入 DOM 的情况下验证"点哪一行回调收到哪条连接"。
 *
 * @param node 元素树
 * @param connectionId 目标连接 ID
 * @returns 连接行元素；未找到时为 null
 */
function findConnectionButton(node: React.ReactNode, connectionId: string): React.ReactElement<{ onClick: () => void }> | null {
  /** 尚未找到时的递归结果。 */
  let found: React.ReactElement<{ onClick: () => void }> | null = null
  React.Children.forEach(node, (child) => {
    if (found || !React.isValidElement<{ children?: React.ReactNode; 'data-server-ops-connection'?: string }>(child)) return
    if (child.props['data-server-ops-connection'] === connectionId) {
      found = child as React.ReactElement<{ onClick: () => void }>
      return
    }
    found = findConnectionButton(child.props.children, connectionId)
  })
  return found
}

/**
 * 在元素树里查找带指定 data 属性的节点。
 *
 * @param node 元素树
 * @param attribute data 属性名
 * @param value data 属性值
 * @returns 首个匹配节点；未找到时为 null
 */
function findDataElement(
  node: React.ReactNode,
  attribute: string,
  value: string,
): React.ReactElement<{ onSelect?: () => void }> | null {
  /** 当前递归分支命中的节点。 */
  let found: React.ReactElement<{ onSelect?: () => void }> | null = null
  React.Children.forEach(node, (child) => {
    if (found || !React.isValidElement<{ children?: React.ReactNode } & Record<string, unknown>>(child)) return
    if (child.props[attribute] === value) {
      found = child as React.ReactElement<{ onSelect?: () => void }>
      return
    }
    found = findDataElement(child.props.children, attribute, value)
  })
  return found
}

describe('项目视图', () => {
  test('Given 当前会话有 Agent 连接草稿 When 查看项目 Then 提示位于连接列表之前', () => {
    const html = renderView({ pendingDrafts: <section aria-label="Agent 连接草稿">待确认的 SSH 连接</section> })
    expect(html).toContain('Agent 连接草稿')
    expect(html.indexOf('待确认的 SSH 连接')).toBeLessThan(html.indexOf('搜索连接名称或地址'))
  })
  test('Given 三类连接 When 渲染 Then 按类型分组展示且各组可折叠、分类计数正确', () => {
    const html = renderView()
    expect(html).toContain('data-server-ops-project-view="project-1"')
    expect(html).toContain('data-server-ops-project-cards="true"')
    for (const kind of ['ssh', 'database', 'redis']) expect(html).toContain(`data-server-ops-project-group="${kind}"`)
    for (const label of ['服务器', '数据库', 'Redis']) expect(html).toContain(`aria-label="折叠或展开${label}连接"`)
    expect(html.match(/aria-expanded="true"/g)).toHaveLength(3)
    expect(html).toContain('data-server-ops-filter-count="all">3</span>')
    for (const kind of ['ssh', 'database', 'redis']) expect(html).toContain(`data-server-ops-filter-count="${kind}">1</span>`)
    expect(html).toContain('应用服务器')
    expect(html).toContain('业务主库')
    expect(html).toContain('会话缓存')
    /** 服务器组内展示连接状态，数据库/Redis 不需要。 */
    expect(html).toContain('已连接')
    expect(html).toContain('aria-current="true"')
    /** 明文直连必须有可见标记，避免和开启证书校验的连接看起来一样。 */
    expect(html).toContain('内网明文')
    expect(html).toContain('data-server-ops-plaintext-direct="data:source-1"')
    expect(html).not.toContain('data-server-ops-plaintext-direct="data:source-2"')
  })

  test('Given 零条数据连接 When 查看全部 Then 保留零计数但不插入空分组占位', () => {
    const html = renderView({ connections: [connections[0]!] })
    expect(html).not.toContain('该项目下还没有数据库连接')
    expect(html).not.toContain('暂无 Redis 连接')
    expect(html).not.toContain('data-server-ops-project-group="database"')
    expect(html).not.toContain('data-server-ops-project-group="redis"')
    expect(html).toContain('data-server-ops-filter-count="redis">0</span>')
  })

  test('Given 三类入口 When 选择统一添加菜单 Then 各自仍提交原连接类别', () => {
    const html = renderView()
    expect(html).toContain('aria-label="添加连接"')
    /** 项目列表在抽屉里，工具栏只提供打开抽屉的入口。 */
    expect(html).toContain('aria-label="打开项目列表"')
    /** 菜单尚未打开时 Portal 不在静态 DOM，直接验证真实菜单项回调。 */
    const added: string[] = []
    const tree = ServerOpsProjectView({ project, connections, selectedConnectionId: null,
      onSelectConnection: () => undefined, onOpenDrawer: () => undefined,
      onAddConnection: (kind) => { added.push(kind) } })
    for (const kind of ['ssh', 'database', 'redis']) {
      const item = findDataElement(tree, 'data-server-ops-add-connection', kind)
      expect(item).not.toBeNull()
      item?.props.onSelect?.()
    }
    expect(added).toEqual(['ssh', 'database', 'redis'])
  })

  test('Given 类型与查询同时生效 When 渲染 Then 只展示交集且保留项目全量分类计数', () => {
    const html = renderView({ filterKind: 'database', searchQuery: '127.0.0.1' })
    expect(html).toContain('业务主库')
    expect(html).not.toContain('data-server-ops-connection="ssh:host-1"')
    expect(html).not.toContain('data-server-ops-connection="data:source-2"')
    expect(html).not.toContain('data-server-ops-project-group="ssh"')
    expect(html).not.toContain('data-server-ops-project-group="redis"')
    expect(html).toContain('data-server-ops-filter-count="all">3</span>')
    expect(html).toContain('data-server-ops-filter-count="ssh">1</span>')
    expect(html).toContain('内网明文')
  })

  test('Given 搜索无匹配或类别为空 When 渲染 Then 区分清除搜索、按类别添加及整个项目为空', () => {
    const noMatch = renderView({ searchQuery: 'not-found' })
    expect(noMatch).toContain('没有找到匹配的连接')
    expect(noMatch).toContain('清除搜索')
    const emptyKind = renderView({ connections: [connections[0]!], filterKind: 'redis' })
    expect(emptyKind).toContain('暂无 Redis 连接')
    expect(emptyKind).toContain('添加 Redis')
    expect(emptyKind).not.toContain('data-server-ops-connection="ssh:host-1"')
    const emptyProject = renderView({ connections: [] })
    expect(emptyProject).toContain('这个项目还没有连接')
    expect(emptyProject).toContain('aria-label="添加连接"')
  })

  test('Given 同名连接与明文风险 When 读取卡片操作 Then 类型地址状态可辨认且悬停包含完整名称', () => {
    /** 同名但地址、类型不同的连接必须有可区分的无障碍名称。 */
    const html = renderView({ connections: connections.map((connection) => ({ ...connection, label: '生产连接' })) })
    expect(html).toContain('aria-label="打开连接：生产连接，服务器 · SSH，deploy@10.0.0.8:22"')
    expect(html).toContain('aria-label="打开连接：生产连接，数据库 · MySQL，127.0.0.1:13306 · 本机直连"')
    expect(html).toContain('aria-description="已连接"')
    expect(html).toContain('aria-description="内网明文"')
    expect(html).toContain('title="生产连接 · deploy@10.0.0.8:22"')
  })

  test('Given SQLite 文件连接 When 渲染项目卡片 Then 使用 SQLite 徽章与无障碍描述', () => {
    const sqliteConnection: ServerOpsConnection = {
      id: 'data:sqlite-1',
      kind: 'database',
      projectId: 'project-1',
      label: '审计文件',
      detail: '/srv/data/audit.sqlite3 · SQLite · 经跳板',
      endpoint: '/srv/data/audit.sqlite3',
      metadata: 'SQLite · 经跳板',
      protocol: 'SQLite',
      sourceId: 'sqlite-1',
    }
    const html = renderView({ connections: [sqliteConnection], selectedConnectionId: null })
    expect(html).toContain('aria-label="打开连接：审计文件，数据库 · SQLite，/srv/data/audit.sqlite3"')
    expect(html).toContain('>SQLite</span>')
    expect(html).not.toContain('>MySQL</span>')
  })

  test('Given 筛选得到零条连接 When 更新结果 Then 结果状态仍保留以播报零数量', () => {
    const html = renderView({ searchQuery: 'not-found' })
    expect(html).toContain('role="status">共 0 个连接')
  })

  test('Given 项目尚未就绪 When 渲染 Then 按读取中或失败原因说明且不渲染分组', () => {
    const loadingHtml = renderView({ project: null, connections: [], status: 'loading' })
    expect(loadingHtml).toContain('data-server-ops-project-view="empty"')
    expect(loadingHtml).toContain('正在读取项目...')
    expect(loadingHtml).not.toContain('data-server-ops-project-group=')

    const errorHtml = renderView({ project: null, connections: [], status: 'error', error: '项目文件损坏或不可读，请检查数据根' })
    expect(errorHtml).toContain('项目读取失败')
    expect(errorHtml).toContain('项目文件损坏或不可读，请检查数据根')

    const emptyHtml = renderView({ project: null, connections: [], status: 'ready' })
    expect(emptyHtml).toContain('还没有项目')
  })

  test('Given 三类连接 When 点击某一行 Then 回调收到该连接本身', () => {
    /** 收到的选择结果。 */
    const selected: ServerOpsConnection[] = []
    /** 直接调用组件函数取得元素树，便于验证行回调。 */
    const tree = ServerOpsProjectView({
      project,
      connections,
      selectedConnectionId: null,
      onSelectConnection: (connection) => { selected.push(connection) },
      onOpenDrawer: () => undefined,
      onAddConnection: () => undefined,
    })

    /** 数据库行与服务器行都必须把自身交给工作区，由工作区决定进入能力页签还是数据服务。 */
    for (const connectionId of ['ssh:host-1', 'data:source-1', 'data:source-2']) {
      /** 目标连接行。 */
      const button = findConnectionButton(tree, connectionId)
      expect(button).not.toBeNull()
      button?.props.onClick()
    }
    expect(selected.map((connection) => connection.id)).toEqual(['ssh:host-1', 'data:source-1', 'data:source-2'])
    expect(selected.map((connection) => connection.kind)).toEqual(['ssh', 'database', 'redis'])
  })

  test('Given SSH/数据库/Redis 连接 When 渲染 Then 每行都有独立管理菜单且没有嵌套按钮', () => {
    const html = renderView({ onMoveConnection: () => undefined })
    for (const connection of connections) {
      expect(html).toContain(`aria-label="管理连接：${connection.label}"`)
    }
    /** 整行选择按钮和菜单触发按钮必须是兄弟节点，避免无效的 button 嵌套。 */
    const connectionButtons = html.match(/<button[^>]*data-server-ops-connection=[^>]*>[\s\S]*?<\/button>/g) ?? []
    expect(connectionButtons).toHaveLength(3)
    for (const buttonHtml of connectionButtons) {
      expect(buttonHtml.slice(buttonHtml.indexOf('>') + 1)).not.toContain('<button')
    }
  })

  test('Given 三类连接 When 选择移动菜单项 Then 只回调目标连接而不选择连接', () => {
    /** 收到的移动目标。 */
    const moved: ServerOpsConnection[] = []
    /** 收到的连接选择。 */
    const selected: ServerOpsConnection[] = []
    const tree = ServerOpsProjectView({
      project,
      connections,
      selectedConnectionId: null,
      onSelectConnection: (connection) => { selected.push(connection) },
      onMoveConnection: (connection) => { moved.push(connection) },
      onOpenDrawer: () => undefined,
      onAddConnection: () => undefined,
    })

    for (const connection of connections) {
      /** 每一类连接都有各自对应的移动入口。 */
      const item = findDataElement(tree, 'data-server-ops-move-connection', connection.id)
      expect(item).not.toBeNull()
      item?.props.onSelect?.()
    }
    expect(moved.map((connection) => connection.id)).toEqual(connections.map((connection) => connection.id))
    expect(selected).toEqual([])
  })
})
