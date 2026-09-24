import { describe, expect, test } from 'bun:test'
import { createStore, Provider } from 'jotai'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { PermissionBanner } from './PermissionBanner'

describe('权限横幅', () => {
  test('Given 没有待处理请求 When 渲染 Then 不占用聊天空间', () => {
    const html = renderToStaticMarkup(
      <Provider store={createStore()}>
        <PermissionBanner sessionId="session-1" onStop={() => undefined} />
      </Provider>,
    )

    expect(html).toBe('')
  })

  test('Given 接口变更审批 When 检查横幅源码 Then 走结构化视图并提示人工复核', async () => {
    const source = await Bun.file(new URL('./PermissionBanner.tsx', import.meta.url)).text()

    expect(source).toContain('describeApiWorkbenchApproval')
    expect(source).toContain('formatApiApprovalCaseDiff')
    expect(source).toContain('用例改动')
    expect(source).toContain('人工创建的用例不可被 Agent 修改或删除')
    /** 有结构化视图时不再重复渲染原始 JSON，避免用户要看两遍。 */
    expect(source).toContain('!apiApproval && !request.sdkTitle')
  })
})
