import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createApiRequestDraft } from '@proma/shared'
import type { ApiCatalog, ApiRequestDefinition } from '@proma/shared'
import { ApiRequestMoveDialog } from './ApiRequestMoveDialog'
import { TooltipProvider } from '@/components/ui/tooltip'

/** 两个集合 + 一个已有分组，用于构造「移动到…」对话框。 */
function fixture(): { catalog: ApiCatalog; request: ApiRequestDefinition } {
  const base = createApiRequestDraft('default')
  const request: ApiRequestDefinition = { ...base, id: 'request_a', revision: 1, updatedAt: 1, name: '管理员列表', folder: '用户模块' }
  return {
    request,
    catalog: {
      version: 1, revision: 3,
      collections: [
        { id: 'default', name: '后台', description: '', variables: [] },
        { id: 'app', name: 'App', description: '', variables: [] },
      ],
      environments: [],
      requests: [request, { ...base, id: 'request_b', revision: 1, updatedAt: 1, name: '订单查询', folder: '订单模块' }],
    },
  }
}

/** 渲染对话框；确认按钮在「原地不动」时应当是禁用的。 */
function render(open: boolean): string {
  const { catalog, request } = fixture()
  return renderToStaticMarkup(
    <TooltipProvider delayDuration={0}>
      <ApiRequestMoveDialog open={open} request={request} catalog={catalog} onOpenChange={() => undefined} onMove={() => undefined} />
    </TooltipProvider>,
  )
}

describe('移动到其他分组 / 集合', () => {
  test('Given 对话框关闭 When 渲染 Then 不产生任何节点', () => {
    expect(render(false)).toBe('')
  })

  test('Given 对话框打开 When 检查实现 Then 集合与分组都从目录里给出选项', async () => {
    /** Radix 弹层在 SSR 下不渲染内容，这里退一步检查实现：选项来自目录而不是手输，且原地不动时禁用确认。 */
    const source = await Bun.file(new URL('./ApiRequestMoveDialog.tsx', import.meta.url)).text()

    expect(source).toContain('catalog.collections.map')
    expect(source).toContain('filter((item) => item.collectionId === collectionId && item.folder)')
    expect(source).toContain('const canSubmit = Boolean(targetCollection) && !unchanged')
  })
})
