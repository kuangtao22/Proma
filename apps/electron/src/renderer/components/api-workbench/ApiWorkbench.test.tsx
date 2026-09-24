import { describe, expect, test } from 'bun:test'
import { createStore } from 'jotai/vanilla'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createApiRequestDraft } from '@proma/shared'
import type { ApiMethod, ApiRequestDefinition, ApiRun } from '@proma/shared'
import {
  apiWorkbenchOpenRunTargetAtom,
  apiWorkbenchSessionStateAtomFamily,
  createApiWorkbenchSessionState,
  createApiWorkbenchUiScope,
  sanitizeApiEnvironmentId,
} from '@/atoms/api-workbench-atoms'
import { ApiWorkbench, dispatchResendApiRun, filterApiCatalogRequests, RESEND_API_RUN_EVENT } from './ApiWorkbench'
import { createRequestTab } from './api-workbench-model'

/** 构造目录搜索所需的最小完整请求定义。 */
function createRequest(name: string, method: ApiMethod, url: string, folder: string): ApiRequestDefinition {
  return { ...createApiRequestDraft(), id: `request_${name}`, revision: 1, updatedAt: 1, name, method, url, folder }
}

describe('接口工作台 UI 集成', () => {
  test('Given Agent 结果卡先触发定位 When 工作台稍后挂载 Then 运行目标仍保留在 Jotai', () => {
    const store = createStore()
    const target = { sessionId: 'session-1', runId: 'run-1' }

    store.set(apiWorkbenchOpenRunTargetAtom, target)

    expect(store.get(apiWorkbenchOpenRunTargetAtom)).toEqual(target)
  })

  test('Given 已选择环境被删除 When 新目录到达 Then 清理失效环境而不猜测默认值', () => {
    expect(sanitizeApiEnvironmentId('missing', [{ id: 'test', name: '测试', kind: 'test', variables: [] }])).toBeNull()
    expect(sanitizeApiEnvironmentId('test', [{ id: 'test', name: '测试', kind: 'test', variables: [] }])).toBe('test')
  })

  test('Given 同一 sessionId 迁移 workspace When 读取 UI 状态 Then 旧目录草稿不会进入新工作区', () => {
    const store = createStore()
    const firstScope = createApiWorkbenchUiScope('session-1', 'workspace-a')
    const secondScope = createApiWorkbenchUiScope('session-1', 'workspace-b')
    store.set(apiWorkbenchSessionStateAtomFamily(firstScope), {
      ...createApiWorkbenchSessionState(),
      tabs: [createRequestTab('tab-old', createApiRequestDraft())],
      activeTabId: 'tab-old',
    })

    expect(firstScope).not.toBe(secondScope)
    expect(store.get(apiWorkbenchSessionStateAtomFamily(secondScope))).toEqual(createApiWorkbenchSessionState())
  })

  test('Given 工作台已交付导入导出 When 检查组件源码 Then 暴露入口且仍不展示后续阶段能力', async () => {
    const source = await Bun.file(new URL('./ApiWorkbench.tsx', import.meta.url)).text()

    expect(source).toContain('export function ApiWorkbench')
    expect(source).toContain("event.key === 'Enter'")
    expect(source).toContain("event.key.toLowerCase() === 's'")
    expect(source).toContain('api.readBody')
    expect(source).toContain('reveal: true')
    expect(source).toContain('api.onChanged')
    expect(source).toContain('目录')
    expect(source).toContain('响应')
    expect(source).toContain('历史')
    expect(source).toContain('搜索请求')
    expect(source).not.toContain('window.prompt')
    expect(source).not.toContain('SSE')
    expect(source).not.toContain('文件上传')
    /** 自动 Cookie 已交付（B8），因此这里只保留仍未交付的能力断言。 */
    expect(source).not.toContain('Cookie Jar 同步')
    expect(source).toContain('导入接口')
    expect(source).toContain('复制为 cURL')
    expect(source).toContain('复制集合快照')
    expect(source).toContain('<ApiImportDialog')
  })

  test('Given 工作台已交付运行时变量提取 When 检查组件源码 Then 提供声明编辑器与结果分区', async () => {
    /** 重发只允许当前会话里来自已保存请求的运行。 */
    const received: unknown[] = []
    const target = { dispatchEvent: (event: Event) => { received.push((event as CustomEvent).detail); return true } } as unknown as EventTarget
    /** 只关心身份字段的最小运行记录。 */
    const saved: ApiRun = {
      id: 'run_1', workspaceId: 'workspace', sessionId: 'session-1', source: 'manual', requestName: '重发',
      catalogRevision: 0, createdAt: 1, state: 'completed',
      request: {
        method: 'GET', url: 'https://example.test', headers: [], body: '', timeoutMs: 1_000,
        followRedirects: false, maxRedirects: 0, sensitiveHeaderNames: [], sensitiveQueryNames: [],
      },
      hops: [],
      body: { rawBytes: 0, decodedBytes: 0, contentType: '', encoding: '', preview: '', previewTruncated: false, complete: true, decoded: false },
      assertions: [], recording: 'saved', pinned: false, requestId: 'request-1',
    }

    expect(dispatchResendApiRun(saved, 'session-1', target)).toBe(true)
    expect(received).toEqual([{ sessionId: 'session-1', requestId: 'request-1' }])
    expect(dispatchResendApiRun(saved, 'session-2', target)).toBe(false)
    expect(dispatchResendApiRun({ ...saved, requestId: undefined } as ApiRun, 'session-1', target)).toBe(false)
    expect(RESEND_API_RUN_EVENT).toBe('proma:resend-api-run')

    const source = await Bun.file(new URL('./ApiWorkbench.tsx', import.meta.url)).text()

    expect(source).toContain('function ExtractionEditor')
    expect(source).toContain("['extract', '提取']")
    expect(source).toContain('提取值只存在本次应用会话的内存里')
    expect(source).toContain("section === 'extract'")
    expect(source).toContain('已写入运行时变量')
    expect(source).toContain('function RuntimeVariablesDialog')
    expect(source).toContain('api.getRuntimeVariables')
    expect(source).toContain('api.clearRuntimeVariables')
  })

  test('Given 已交付具名用例 When 检查组件源码 Then 用例分区、跑全部用例与复制报告都接线', async () => {
    const source = await Bun.file(new URL('./ApiWorkbench.tsx', import.meta.url)).text()

    expect(source).toContain("['cases', '用例']")
    expect(source).toContain('function CaseEditor')
    expect(source).toContain('aria-label={`设为当前用例 ${item.name}`}')
    expect(source).toContain('label="跑全部用例"')
    expect(source).toContain('runAllApiCases')
    expect(source).toContain('onRunAllCases={() => void runAllCases()}')
    expect(source).toContain('activeTab.activeCaseId')
    expect(source).toContain('function CaseReportDialog')
    expect(source).toContain('formatApiCaseReportMarkdown')
    expect(source).toContain('复制报告')
    expect(source).toContain('打开运行')
    expect(source).toContain('resolveCaseName')
    expect(source).toContain('withDraftAssertions')
    /** 用例来源要在界面可见，报告与复制文本同样带来源列。 */
    expect(source).toContain('isAgentApiCase')
    expect(source).toContain('>Agent</Badge>')
    expect(source).toContain('<span>来源</span>')
    /** 恢复运行头部必须标注用例，否则用户无法确认跑的是哪一组断言。 */
    expect(source).toContain('用例 ${caseName} · ')
  })

  test('Given 导入对话框 When 检查组件源码 Then 明确不执行 shell 且只在预览可用时允许确认', async () => {
    const source = await Bun.file(new URL('./ApiImportDialog.tsx', import.meta.url)).text()

    expect(source).toContain('不会执行 shell 命令，也不会读取本机文件')
    expect(source).toContain('aria-label="粘贴 cURL 或集合快照"')
    expect(source).toContain('确认导入')
    expect(source).toContain('previewApiWorkbenchImport')
    expect(source).toContain('disabled={!canImport || importing}')
    expect(source).toContain('全部作为新增内容导入，不覆盖现有资产')
  })

  test('Given 请求分布在根目录和文件夹 When 搜索名称、方法、URL 或文件夹 Then 只返回匹配项且不改原顺序', () => {
    const requests = [
      { ...createRequest('获取用户', 'GET', 'https://api.example.com/users', ''), id: 'one' },
      { ...createRequest('创建订单', 'POST', 'https://api.example.com/orders', '交易'), id: 'two' },
    ]

    expect(filterApiCatalogRequests(requests, 'post').map((request) => request.id)).toEqual(['two'])
    expect(filterApiCatalogRequests(requests, 'users').map((request) => request.id)).toEqual(['one'])
    expect(filterApiCatalogRequests(requests, '交易').map((request) => request.id)).toEqual(['two'])
    expect(filterApiCatalogRequests(requests, '  ')).toBe(requests)
  })

  test('Given 结果卡事件到达 SidePanel When 检查接线 Then 先记录运行目标并打开接口标签', async () => {
    const source = await Bun.file(new URL('../agent/SidePanel.tsx', import.meta.url)).text()

    expect(source).toContain("'proma:open-api-run'")
    expect(source).toContain('setApiWorkbenchOpenRunTarget')
    expect(source).toContain("handleWorkspaceTabChange('api-workbench')")
    expect(source).toContain('<ApiWorkbench')
    expect(source).toContain('workspaceLabel={workspaces.find((workspace) => workspace.id === currentWorkspaceId)?.name}')
  })

  test('Given 用户打开加号菜单 When 检查入口 Then 接口工作台与其它工作区能力同级', async () => {
    const source = await Bun.file(new URL('../diff/DiffPanelTabBar.tsx', import.meta.url)).text()

    expect(source).toContain("onOpenWorkspaceComponent('api-workbench')")
    expect(source).toContain('打开接口工作台')
  })

  test('Given 旧 preload 不含接口能力 When 渲染工作台 Then 显示可恢复提示且不抛异常', () => {
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { electronAPI: {} } })
    try {
      const html = renderToStaticMarkup(<ApiWorkbench sessionId="session-1" />)
      expect(html).toContain('接口工作台尚未就绪，请重启应用后重试')
    } finally {
      if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
      else Reflect.deleteProperty(globalThis, 'window')
    }
  })

  test('Given 已交付自动 Cookie When 检查组件源码 Then 开关与面板都接线且不展示取值', async () => {
    const source = await Bun.file(new URL('./ApiWorkbench.tsx', import.meta.url)).text()

    expect(source).toContain('自动 Cookie（仅本机内存）')
    expect(source).toContain('function CookieJarDialog')
    expect(source).toContain('api.getCookieJar')
    expect(source).toContain('api.clearCookieJar')
    expect(source).toContain('label="Cookie"')
    expect(source).toContain('取值不展示也无法导出')
    expect(source).toContain('formatCookieExpiry')
    /** cookie 值不在界面状态里：面板只用元数据字段。 */
    expect(source).not.toContain('cookie.value')
  })
})
