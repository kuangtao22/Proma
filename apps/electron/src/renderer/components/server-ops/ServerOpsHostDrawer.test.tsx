import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ServerOpsHost } from '@proma/shared'
import {
  ServerOpsHostDrawer,
  selectServerOpsHostFromDrawer,
} from './ServerOpsHostDrawer'

/** 创建抽屉测试使用的服务器资产。 */
function createHost(id: string, name: string): ServerOpsHost {
  return {
    id,
    name,
    address: `${id}.internal`,
    port: 22,
    username: 'deploy',
    authMethod: 'ssh-agent',
    tags: [],
    createdAt: 1,
    updatedAt: 1,
  }
}

describe('服务器运维主机抽屉', () => {
  test('关闭时不渲染，打开时使用 Pane 内遮罩并高亮当前服务器', () => {
    /** 当前生产和测试服务器列表。 */
    const hosts = [createHost('prod-api', '生产 API'), createHost('test-api', '测试 API')]
    /** 不触发事件的抽屉属性。 */
    const props = {
      hosts,
      selectedHostId: 'prod-api',
      onOpenChange: () => undefined,
      onSelect: () => undefined,
      onCreate: () => undefined,
      onEdit: () => undefined,
      onDelete: () => undefined,
    }

    expect(renderToStaticMarkup(<ServerOpsHostDrawer {...props} open={false} />)).toBe('')
    /** 打开后的服务器抽屉 HTML。 */
    const html = renderToStaticMarkup(<ServerOpsHostDrawer {...props} open />)
    expect(html).toContain('data-server-ops-host-drawer="true"')
    expect(html).toContain('aria-label="关闭服务器列表"')
    expect(html).toContain('aria-label="服务器列表"')
    expect(html).toContain('生产 API')
    expect(html).toContain('测试 API')
    expect(html).toContain('aria-current="page"')
    expect(html).toContain('添加服务器')
  })

  test('选择服务器后更新身份并自动关闭抽屉', () => {
    /** 记录选择结果。 */
    const selected: string[] = []
    /** 记录抽屉开关结果。 */
    const openStates: boolean[] = []

    selectServerOpsHostFromDrawer(
      'test-api',
      (hostId) => { selected.push(hostId) },
      (open) => { openStates.push(open) },
    )

    expect(selected).toEqual(['test-api'])
    expect(openStates).toEqual([false])
  })
})
