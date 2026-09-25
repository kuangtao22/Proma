import { describe, expect, test } from 'bun:test'
import { createStore, Provider } from 'jotai'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { PermissionRequest } from '@proma/shared'
import { allPendingPermissionRequestsAtom } from '@/atoms/agent-atoms'
import { PermissionBanner } from './PermissionBanner'

/** 造一条已入队的接口发送审批；Host 侧会把附件行一起塞进 toolInput。 */
function apiSendApproval(toolInput: Record<string, unknown>): PermissionRequest {
  return {
    requestId: 'permission-api-send',
    sessionId: 'session-1',
    toolName: 'api_send_request',
    toolInput,
    description: '发送接口请求',
    dangerLevel: 'dangerous',
    allowAlways: false,
  }
}

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

  test('Given 接口发送审批带本机附件 When 渲染 Then 逐行显示字段、真实路径与大小', () => {
    const store = createStore()
    store.set(allPendingPermissionRequestsAtom, new Map([['session-1', [apiSendApproval({
      preparedId: 'prepared_1',
      preview: { requestName: '上传头像', environmentId: 'env_test', request: { method: 'POST', url: 'https://example.test/upload' } },
      send: { assertionCount: 0 },
      files: [{ field: 'avatar', path: '/Users/ada/secret/头像.png', sizeBytes: 20480 }],
    })]]]))

    const html = renderToStaticMarkup(
      <Provider store={store}>
        <PermissionBanner sessionId="session-1" onStop={() => undefined} />
      </Provider>,
    )

    expect(html).toContain('POST https://example.test/upload')
    expect(html).toContain('本次将读取并上传的文件（批准后才读取字节）')
    expect(html).toContain('字段 avatar：/Users/ada/secret/头像.png（20480 字节）')
    /** realpath 展示的语义要写在卡片上，用户才知道链接名不会骗人。 */
    expect(html).toContain('realpath')
  })

  test('Given 不带附件的发送审批 When 渲染 Then 不出现附件区块', () => {
    const store = createStore()
    store.set(allPendingPermissionRequestsAtom, new Map([['session-1', [apiSendApproval({
      preparedId: 'prepared_2',
      preview: { request: { method: 'GET', url: 'https://example.test/users' } },
      send: { assertionCount: 1 },
    })]]]))

    const html = renderToStaticMarkup(
      <Provider store={store}>
        <PermissionBanner sessionId="session-1" onStop={() => undefined} />
      </Provider>,
    )

    expect(html).toContain('GET https://example.test/users')
    expect(html).not.toContain('本次将读取并上传的文件')
  })
})
