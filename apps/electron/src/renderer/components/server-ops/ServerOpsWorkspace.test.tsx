import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ServerOpsHost } from '@proma/shared'
import { ServerOpsWorkspaceView } from './ServerOpsWorkspace'

/** 创建工作区测试使用的服务器资产。 */
function createHost(): ServerOpsHost {
  return {
    id: 'host-1',
    name: '生产 API',
    address: '10.0.0.8',
    port: 22,
    username: 'deploy',
    authMethod: 'ssh-agent',
    tags: ['生产'],
    createdAt: 1,
    updatedAt: 1,
  }
}

/** 创建静态工作区视图所需回调。 */
function createCallbacks() {
  return {
    onOpenDrawer: () => undefined,
    onCreateHost: () => undefined,
    onEditHost: () => undefined,
    onDeleteHost: () => undefined,
    onSectionChange: () => undefined,
  }
}

describe('服务器运维右侧工作区', () => {
  test('无服务器时呈现真实空状态和添加入口', () => {
    /** 空主机工作区 HTML。 */
    const html = renderToStaticMarkup(
      <ServerOpsWorkspaceView
        {...createCallbacks()}
        status="ready"
        hosts={[]}
        selectedHost={null}
        activeSection="overview"
      />,
    )

    expect(html).toContain('data-server-ops-workspace="true"')
    expect(html).toContain('还没有服务器')
    expect(html).toContain('添加服务器')
    expect(html).not.toContain('CPU 使用率')
  })

  test('选中服务器后展示完整控制台入口且不伪造在线指标', () => {
    /** 当前选中的测试服务器。 */
    const host = createHost()
    /** 概览工作区 HTML。 */
    const overviewHtml = renderToStaticMarkup(
      <ServerOpsWorkspaceView
        {...createCallbacks()}
        status="ready"
        hosts={[host]}
        selectedHost={host}
        activeSection="overview"
      />,
    )

    for (const label of ['概览', '终端', '服务', '日志', '文件', 'Docker', '数据服务', '审计']) {
      expect(overviewHtml).toContain(label)
    }
    expect(overviewHtml).toContain('生产 API')
    expect(overviewHtml).toContain('deploy@10.0.0.8:22')
    expect(overviewHtml).toContain('尚未连接')
    expect(overviewHtml).toContain('server-ops-workspace-container')
    expect(overviewHtml).toContain('data-server-ops-connection-action="true"')
    expect(overviewHtml).toContain('data-server-ops-connection-label="true"')
    expect(overviewHtml).not.toContain('68%')

    /** 数据服务页 HTML。 */
    const dataHtml = renderToStaticMarkup(
      <ServerOpsWorkspaceView
        {...createCallbacks()}
        status="ready"
        hosts={[host]}
        selectedHost={host}
        activeSection="data-services"
      />,
    )
    expect(dataHtml).toContain('PostgreSQL')
    expect(dataHtml).toContain('MySQL')
    expect(dataHtml).toContain('Redis')
    expect(dataHtml).toContain('默认只读')
  })
})
