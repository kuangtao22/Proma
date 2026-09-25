import { describe, expect, test } from 'bun:test'
import type { ApiCatalog, ApiHttpHop, ApiRequestDraft, ApiRun, ApiWorkbenchApi } from '@proma/shared'
import { createApiCatalogSnapshotExport, createApiRequestDraft } from '@proma/shared'
import {
  appendBodySlice,
  clearApiValue,
  createApiCase,
  diffApiRuns,
  createImportedRequestTabs,
  createApiWorkbenchController,
  createRequestTab,
  draftFromRun,
  draftAssertions,
  editApiValue,
  formatCookieExpiry,
  formatApiResponseBody,
  isAgentApiCase,
  previewApiWorkbenchImport,
  renameCatalogFolder,
  removeApiCase,
  renameApiCase,
  resolveApiCaseName,
  runAllApiCases,
  saveCatalogWithLatestRevision,
  upsertCatalogRequest,
  withDraftAssertions,
} from './api-workbench-model'
import type { ApiWorkbenchImportPreview } from './api-workbench-model'

/** 断言预览类型并收窄联合类型，避免每个用例重复写类型判断。 */
function expectPreviewKind<K extends ApiWorkbenchImportPreview['kind']>(
  preview: ApiWorkbenchImportPreview,
  kind: K,
): Extract<ApiWorkbenchImportPreview, { kind: K }> {
  expect(preview.kind).toBe(kind)
  return preview as Extract<ApiWorkbenchImportPreview, { kind: K }>
}

function createCatalog(revision = 3): ApiCatalog {
  return {
    version: 1,
    revision,
    collections: [{ id: 'default', name: '默认集合', description: '', variables: [] }],
    environments: [],
    requests: [],
  }
}

function createRun(id: string): ApiRun {
  return {
    id,
    workspaceId: 'workspace-1',
    sessionId: 'session-1',
    source: 'manual',
    requestName: '获取用户',
    catalogRevision: 3,
    createdAt: 1,
    finishedAt: 2,
    state: 'completed',
    request: { method: 'GET', url: 'https://example.com', headers: [], body: '', timeoutMs: 1000, followRedirects: false, maxRedirects: 0, sensitiveHeaderNames: [], sensitiveQueryNames: [] },
    hops: [],
    body: { rawBytes: 2, decodedBytes: 2, contentType: 'application/json', encoding: 'utf-8', preview: '{}', previewTruncated: false, complete: true, decoded: true },
    assertions: [],
    recording: 'saved',
    pinned: false,
  }
}

/** 对比测试用的固定计时事实。 */
function hopTimings(): ApiHttpHop['timings'] {
  return { dnsMs: 1, connectMs: 1, tlsMs: null, sendMs: 1, ttfbMs: 2, downloadMs: 1, totalMs: 7 }
}

/** 默认运行没有跳转；对比需要真实响应头与耗时，因此这里补一个可覆盖的跳转。 */
function withHop(run: ApiRun, overrides: Partial<ApiHttpHop> = {}): ApiRun {
  return {
    ...run,
    hops: [{
      url: 'https://example.test/users', method: 'GET', requestHeaders: [], requestHeadersSource: 'captured',
      status: 200, statusText: 'OK', httpVersion: '1.1',
      responseHeaders: [{ name: 'X-Trace', value: 'abc' }], trailers: [],
      timings: hopTimings(),
      connection: { reused: false },
      ...overrides,
    }],
  }
}

describe('接口工作台编辑模型', () => {
  test('Given 已保存秘密 When 输入框保持空白 Then 保留引用且只有显式清除才解除秘密', () => {
    const saved = { value: '', secret: true, secretRef: 'secret-1' }

    expect(editApiValue(saved, '', true)).toEqual(saved)
    expect(editApiValue(saved, 'rotated', true)).toEqual({ value: 'rotated', secret: true })
    expect(clearApiValue(saved)).toEqual({ value: '', secret: false })
  })

  test('Given 其它 Pane 已更新目录 When 当前 Pane 保存 Then 以最新 revision CAS 且保留并发内容', async () => {
    const calls: Array<{ expectedRevision: number; catalog: ApiCatalog }> = []
    const latest = { ...createCatalog(9), environments: [{ id: 'test', name: '测试', kind: 'test' as const, variables: [] }] }
    const api = {
      getCatalog: async () => latest,
      saveCatalog: async (input: { expectedRevision: number; catalog: ApiCatalog }) => {
        calls.push(input)
        return { ...input.catalog, revision: 10 }
      },
    }

    const result = await saveCatalogWithLatestRevision(api, 'session-1', (catalog) => ({
      ...catalog,
      collections: [...catalog.collections, { id: 'other', name: '其它', description: '', variables: [] }],
    }))

    expect(calls[0]?.expectedRevision).toBe(9)
    expect(calls[0]?.catalog.environments).toEqual(latest.environments)
    expect(result.revision).toBe(10)
  })

  test('Given 指定测试用例 When 发送 Then prepare 带上用例身份', async () => {
    /** 记录 prepare 参数，验证用例身份确实传到 Host。 */
    const calls: unknown[] = []
    const api = {
      getCatalog: async () => createCatalog(),
      saveCatalog: async (input: { catalog: ApiCatalog }) => input.catalog,
      prepare: async (input: { caseId?: string }) => {
        calls.push(input)
        return {
          preparedId: 'prepared_case', requestName: '用例', catalogRevision: 0, createdAt: 1, expiresAt: 2, warnings: [],
          request: {
            method: 'GET' as const, url: 'https://example.test', headers: [], body: '', timeoutMs: 1_000,
            followRedirects: false, maxRedirects: 0, sensitiveHeaderNames: [], sensitiveQueryNames: [],
          },
        }
      },
      send: async () => createRun('run-case'),
      cancel: async () => undefined,
    } as unknown as ApiWorkbenchApi
    const controller = createApiWorkbenchController(api, 'session-1', () => undefined)

    await controller.send('tab-1', createApiRequestDraft(), undefined, undefined, 'case_401')

    expect(calls[0]).toMatchObject({ sessionId: 'session-1', caseId: 'case_401' })
  })

  test('Given 请求 A 在途后切到请求 B When A 迟到完成 Then 结果只写回 A 标签', async () => {
    const prepared = { preparedId: 'prepared-a', request: createRun('run-a').request, requestName: 'A', catalogRevision: 3, createdAt: 1, expiresAt: 2, warnings: [] }
    const api = {
      prepare: async () => prepared,
      send: async () => createRun('run-a'),
      cancel: async () => undefined,
    }
    const updates: Array<{ tabId: string; runId?: string; preparedId?: string; sending?: boolean }> = []
    const controller = createApiWorkbenchController(api, 'session-1', (tabId, patch) => updates.push({ tabId, runId: patch.run?.id, preparedId: patch.preparedId, sending: patch.sending }))

    await controller.send('tab-a', createApiRequestDraft('default'))

    expect(updates).toEqual([
      { tabId: 'tab-a', preparedId: undefined, runId: undefined, sending: true },
      { tabId: 'tab-a', preparedId: 'prepared-a', runId: undefined, sending: true },
      { tabId: 'tab-a', preparedId: undefined, runId: 'run-a', sending: false },
    ])
  })

  test('Given prepare 已完成 When 用户取消 Then 仅使用 Host 签发的 preparedId', async () => {
    const cancelled: string[] = []
    const api = {
      prepare: async () => ({ preparedId: 'prepared-1', request: createRun('run').request, requestName: '请求', catalogRevision: 3, createdAt: 1, expiresAt: 2, warnings: [] }),
      send: async () => new Promise<ApiRun>(() => undefined),
      cancel: async (input: { preparedId: string }) => { cancelled.push(input.preparedId) },
    }
    const controller = createApiWorkbenchController(api, 'session-1', () => undefined)
    void controller.send('tab-1', createApiRequestDraft('default'))
    await Promise.resolve()

    await controller.cancel('tab-1')

    expect(cancelled).toEqual(['prepared-1'])
  })

  test('Given prepare 尚未完成 When 双击发送 Then 复用同一单飞任务且只出网一次', async () => {
    /** 手动释放 prepare，模拟用户连续触发。 */
    let releasePrepare!: () => void
    const gate = new Promise<void>((resolve) => { releasePrepare = resolve })
    let prepareCalls = 0
    let sendCalls = 0
    const api = {
      prepare: async () => { prepareCalls += 1; await gate; return { preparedId: 'prepared-one', request: createRun('run').request, requestName: '请求', catalogRevision: 3, createdAt: 1, expiresAt: 2, warnings: [] } },
      send: async () => { sendCalls += 1; return createRun('run-one') },
      cancel: async () => undefined,
    }
    const controller = createApiWorkbenchController(api, 'session-1', () => undefined)

    const first = controller.send('tab-1', createApiRequestDraft('default'))
    const second = controller.send('tab-1', createApiRequestDraft('default'))
    expect(second).toBe(first)
    releasePrepare()

    expect(await first).toEqual(await second)
    expect(prepareCalls).toBe(1)
    expect(sendCalls).toBe(1)
  })

  test('Given prepare 尚未完成 When 用户取消 Then prepare 迟到后不发送并清理准备身份', async () => {
    /** 手动释放 prepare，覆盖取消发生在 Host 返回 preparedId 之前的竞态。 */
    let releasePrepare!: () => void
    const gate = new Promise<void>((resolve) => { releasePrepare = resolve })
    let sendCalls = 0
    const cancelled: string[] = []
    const updates: Array<{ sending?: boolean }> = []
    const api = {
      prepare: async () => { await gate; return { preparedId: 'prepared-cancelled', request: createRun('run').request, requestName: '请求', catalogRevision: 3, createdAt: 1, expiresAt: 2, warnings: [] } },
      send: async () => { sendCalls += 1; return createRun('unexpected') },
      cancel: async (input: { preparedId: string }) => { cancelled.push(input.preparedId) },
    }
    const controller = createApiWorkbenchController(api, 'session-1', (_tabId, patch) => updates.push({ sending: patch.sending }))

    const pending = controller.send('tab-1', createApiRequestDraft('default'))
    await controller.cancel('tab-1')
    releasePrepare()

    expect(await pending).toBeNull()
    expect(sendCalls).toBe(0)
    expect(cancelled).toEqual(['prepared-cancelled'])
    expect(updates).toEqual([{ sending: true }, { sending: false }])
  })

  test('Given 大正文分两页 When 追加下一页 Then 保留范围与后续 offset', () => {
    const first = appendBodySlice(null, { text: 'abc', offset: 0, nextOffset: 3, totalChars: 6, truncated: true })
    const second = appendBodySlice(first, { text: 'def', offset: 3, nextOffset: null, totalChars: 6, truncated: false })

    expect(second).toEqual({ text: 'abcdef', startOffset: 0, nextOffset: null, totalChars: 6, truncated: false })
  })

  test('Given JSON 含大整数和重复键 When 格式化 Then 只调整空白不改写字面值', () => {
    const source = '{"id":900719925474099312345,"id":2}'
    const result = formatApiResponseBody(source, 'application/json')

    expect(result.formatted).toContain('900719925474099312345')
    expect(result.formatted.match(/"id"/g)).toHaveLength(2)
  })

  test('Given 新建和复制请求 When 建立编辑标签 Then 草稿互相隔离且标记未保存', () => {
    const draft: ApiRequestDraft = { ...createApiRequestDraft('default'), name: '原请求' }
    const first = createRequestTab('tab-a', draft)
    const copy = createRequestTab('tab-b', { ...draft, name: '原请求副本' })

    copy.draft.name = '已修改'
    expect(first.draft.name).toBe('原请求')
    expect(copy.dirty).toBe(true)
  })

  test('Given Host Store 负责递增请求 revision When 保存或重命名文件夹 Then 提交当前 revision 而非预加一', () => {
    const existing = { ...createApiRequestDraft('default'), id: 'request-1', name: '旧名称', folder: 'old', revision: 7, updatedAt: 100 }
    const catalog = { ...createCatalog(), requests: [existing] }

    const saved = upsertCatalogRequest(catalog, 'request-1', { ...createApiRequestDraft('default'), name: '新名称' }, 200)
    const renamed = renameCatalogFolder(catalog, 'default', 'old', 'new', 200)

    expect(saved.requests[0]).toMatchObject({ revision: 7, updatedAt: 100, name: '新名称' })
    expect(renamed.requests[0]).toMatchObject({ revision: 7, updatedAt: 100, folder: 'new' })
  })

  test('Given 同一请求已被其它 Pane 保存 When 当前标签继续保存 Then 拒绝覆盖并发版本', () => {
    const existing = { ...createApiRequestDraft('default'), id: 'request-1', revision: 8, updatedAt: 200 }
    const catalog = { ...createCatalog(), requests: [existing] }

    expect(() => upsertCatalogRequest(catalog, 'request-1', createApiRequestDraft('default'), 300, 7))
      .toThrow('API_WORKBENCH_REQUEST_REVISION_CONFLICT')
  })

  test('Given 粘贴 cURL 文本 When 预览导入 Then 返回草稿与未支持项', () => {
    const accepted = expectPreviewKind(previewApiWorkbenchImport("curl -X POST https://api.example.com/users -H 'X-A: 1'"), 'curl')
    const rejected = expectPreviewKind(previewApiWorkbenchImport("curl -F 'file=@a.png' https://api.example.com/u"), 'curl')

    expect(accepted.drafts).toHaveLength(1)
    expect(accepted.drafts[0]?.method).toBe('POST')
    expect(accepted.unsupported).toEqual([])
    expect(rejected.drafts).toEqual([])
    expect(rejected.unsupported.join(' ')).toContain('-F')
    expect(rejected.unsupported.join(' ')).toContain('阶段 B2')
  })

  test('Given 粘贴集合快照 When 预览导入 Then 返回增量计数与需要重填的秘密', () => {
    const source: ApiCatalog = {
      ...createCatalog(),
      requests: [{
        ...createApiRequestDraft('default'),
        id: 'req-1',
        revision: 1,
        updatedAt: 1,
        name: '创建用户',
        headers: [{ id: 'h1', name: 'Authorization', value: 'Bearer abc', enabled: true, secret: true }],
      }],
    }
    const text = createApiCatalogSnapshotExport(source, 1).text

    const preview = expectPreviewKind(previewApiWorkbenchImport(text), 'catalog')

    expect(preview.counts).toEqual({ collections: 1, environments: 0, requests: 1 })
    expect(preview.emptiedSecrets.join(' ')).toContain('Authorization')
    expect(text).not.toContain('Bearer abc')
  })

  test('Given 无法识别的输入 When 预览导入 Then 返回可读提示而不是抛异常', () => {
    const empty = expectPreviewKind(previewApiWorkbenchImport('   '), 'error')
    const nonsense = expectPreviewKind(previewApiWorkbenchImport('这里只有说明文字'), 'error')

    expect(empty.message).toContain('curl')
    expect(nonsense.message).toContain('curl')
  })

  test('Given 一次导入多条命令 When 建立标签 Then 每个草稿独立且都标记未保存', () => {
    const preview = expectPreviewKind(
      previewApiWorkbenchImport('curl https://a.example.com/1\ncurl -X DELETE https://b.example.com/2'),
      'curl',
    )
    let seed = 0

    const tabs = createImportedRequestTabs(preview.drafts, () => `import-${++seed}`)

    expect(tabs.map((tab) => tab.id)).toEqual(['import-1', 'import-2'])
    expect(tabs.map((tab) => tab.draft.method)).toEqual(['GET', 'DELETE'])
    expect(tabs.every((tab) => tab.dirty && tab.requestId === undefined && tab.savedDraft === null)).toBe(true)
    tabs[0]!.draft.name = '改名'
    expect(tabs[1]!.draft.name).not.toBe('改名')
  })

  test('Given 选中某条用例 When 编辑断言 Then 只改该用例且不动请求默认断言', () => {
    const draft = {
      ...createApiRequestDraft('default'),
      assertions: [{ id: 'default-a', kind: 'status' as const, path: '', expected: '200' }],
      cases: [createApiCase('case-1', '缺参数'), createApiCase('case-2', '越权')],
    }

    expect(draftAssertions(draft, 'case-1')).toEqual([])
    expect(draftAssertions(draft, undefined)).toEqual(draft.assertions)

    const updated = withDraftAssertions(draft, 'case-1', [{ id: 'a', kind: 'status', path: '', expected: '400' }])

    expect(updated.cases?.[0]?.assertions).toHaveLength(1)
    expect(updated.cases?.[1]?.assertions).toEqual([])
    expect(updated.assertions).toEqual(draft.assertions)
    expect(updated.cases?.[0]?.name).toBe('缺参数')
  })

  test('Given 用例已被删除 When 写回断言 Then 保留草稿不变而不是写错位置', () => {
    const draft = { ...createApiRequestDraft('default'), cases: [createApiCase('case-1')] }

    expect(withDraftAssertions(draft, 'case-gone', [])).toBe(draft)
    expect(withDraftAssertions(draft, undefined, []).assertions).toEqual([])
  })

  test('Given 用例增删改 When 变更草稿 Then 身份稳定且顺序保持', () => {
    const draft = {
      ...createApiRequestDraft('default'),
      cases: [createApiCase('case-1', '正常'), createApiCase('case-2', '缺参数')],
    }

    const renamed = renameApiCase(draft, 'case-2', '缺少必填参数')
    const removed = removeApiCase(renamed, 'case-1')

    expect(renamed.cases?.map((item) => `${item.id}:${item.name}`)).toEqual(['case-1:正常', 'case-2:缺少必填参数'])
    expect(removed.cases?.map((item) => item.id)).toEqual(['case-2'])
    expect(draft.cases?.map((item) => item.name)).toEqual(['正常', '缺参数'])
    /** 人新增的用例来源固定为人工，避免把界面操作也算成 Agent 出题。 */
    expect(createApiCase('case-3')).toEqual({ id: 'case-3', name: '新用例', assertions: [], source: 'user' })
    expect(isAgentApiCase(createApiCase('case-4'))).toBe(false)
    expect(isAgentApiCase({ source: 'agent' })).toBe(true)
    expect(isAgentApiCase({ source: undefined })).toBe(false)
  })

  test('Given 运行带用例身份 When 解析用例名 Then 草稿优先、其次目录，查不到说明已删除', () => {
    const draft = { ...createApiRequestDraft('default'), cases: [createApiCase('case-1', '草稿用例')] }
    const definition = {
      ...createApiRequestDraft('default'),
      id: 'request-1',
      revision: 1,
      updatedAt: 1,
      cases: [createApiCase('case-2', '目录用例')],
    }
    const catalog = { ...createCatalog(), requests: [definition] }

    expect(resolveApiCaseName({ ...createRun('run-1'), caseId: 'case-1' }, draft, catalog)).toBe('草稿用例')
    expect(resolveApiCaseName({ ...createRun('run-2'), caseId: 'case-2', requestId: 'request-1' }, null, catalog)).toBe('目录用例')
    expect(resolveApiCaseName({ ...createRun('run-3'), caseId: 'case-gone', requestId: 'request-1' }, null, catalog)).toBe('已删除的用例')
    expect(resolveApiCaseName({ ...createRun('run-4'), caseId: 'case-gone' }, draft, null)).toBe('已删除的用例')
    expect(resolveApiCaseName(createRun('run-5'), draft, catalog)).toBeNull()
  })

  test('Given 顺序跑全部用例 When 中途取消 Then 剩余用例标记已取消且不再发起请求', async () => {
    const cases = [createApiCase('case-1', '正常'), createApiCase('case-2', '缺参数'), createApiCase('case-3', '越权')]
    const visited: string[] = []
    let cancelled = false
    const progress: number[] = []

    const rows = await runAllApiCases(cases, async (caseId) => {
      visited.push(caseId)
      cancelled = true
      return null
    }, { isCancelled: () => cancelled, describeError: () => '派发失败', onProgress: (current) => progress.push(current.length) })

    expect(visited).toEqual(['case-1'])
    expect(progress).toEqual([1, 2, 3])
    expect(rows.map((row) => row.caseName)).toEqual(['正常', '缺参数', '越权'])
    expect(rows[0]?.error).toBe('已取消')
    expect(rows.slice(1).map((row) => row.error)).toEqual(['已取消，未执行', '已取消，未执行'])
    expect(rows.every((row) => row.runId === undefined)).toBe(true)
  })

  test('Given 用例派发失败 When 跑完全部用例 Then 失败行带原因且后续用例继续执行', async () => {
    const cases = [createApiCase('case-1', '正常'), createApiCase('case-2', '缺参数')]
    const errors: Record<string, string> = { 'case-2': 'API_WORKBENCH_CASE_NOT_FOUND' }

    const rows = await runAllApiCases(cases, async (caseId) => caseId === 'case-1' ? createRun('run-1') : null, {
      isCancelled: () => false,
      describeError: (caseId) => errors[caseId],
    })

    expect(rows[0]?.runId).toBe('run-1')
    expect(rows[0]?.caseId).toBe('case-1')
    expect(rows[1]?.error).toBe('API_WORKBENCH_CASE_NOT_FOUND')
    expect(rows[1]?.assertionsTotal).toBe(0)
  })

  test('Given Cookie 过期时间 When 展示 Then 区分会话 cookie、已过期与具体时间', () => {
    expect(formatCookieExpiry(null)).toBe('会话 cookie')
    expect(formatCookieExpiry(1_000, 2_000)).toBe('已过期')
    expect(formatCookieExpiry(2_000, 1_000)).toBe(new Date(2_000).toLocaleString())
  })

  test('Given 历史运行 When 载入编辑器 Then 还原真实请求且把遮罩位置留空待重填', () => {
    const run = {
      ...createRun('run-1'),
      requestName: '下单',
      requestId: 'request-1',
      request: {
        method: 'POST' as const,
        url: 'https://example.test/orders?page=2&token=%5BREDACTED%5D',
        headers: [
          { name: 'Authorization', value: '[REDACTED]', source: 'generated' as const },
          { name: 'Content-Type', value: 'application/json', source: 'generated' as const },
          { name: 'X-Trace', value: 'trace-1', source: 'user' as const },
        ],
        body: '{"name":"ada","token":"[REDACTED]"}',
        timeoutMs: 15_000,
        followRedirects: true,
        maxRedirects: 2,
        sensitiveHeaderNames: ['authorization'],
        sensitiveQueryNames: ['token'],
      },
    }
    const catalog: ApiCatalog = { ...createCatalog(), requests: [{ ...createApiRequestDraft('default'), id: 'request-1', revision: 2, updatedAt: 1, collectionId: 'default', cases: [createApiCase('case_1', '用例')] }] }

    let seed = 0
    const result = draftFromRun(run, catalog, () => `f${++seed}`)

    expect(result.draft.name).toBe('下单 · 历史还原')
    expect(result.draft.collectionId).toBe('default')
    expect(result.draft.method).toBe('POST')
    /** 查询串拆成行，URL 只留 origin + path。 */
    expect(result.draft.url).toBe('https://example.test/orders')
    expect(result.draft.query.map((field) => `${field.name}:${field.enabled ? 'on' : 'off'}:${field.value}`)).toEqual(['page:on:2', 'token:off:'])
    /** 被遮罩的 Header 留空并取消勾选，可见 Header 原样还原。 */
    expect(result.draft.headers.map((field) => `${field.name}:${field.enabled ? 'on' : 'off'}:${field.value}`)).toEqual([
      'Authorization:off:', 'Content-Type:on:application/json', 'X-Trace:on:trace-1',
    ])
    /** 正文用不可解析的占位符提示，绝不把 [REDACTED] 当真值。 */
    expect(result.draft.body).toEqual({ kind: 'json', text: '{"name":"ada","token":"{{REDACTED_SECRET}}"}', fields: [] })
    expect(JSON.stringify(result.draft)).not.toContain('[REDACTED]')
    expect(result.redacted).toEqual(['Header Authorization', 'Query token', '正文'])
    /** 用例属于原定义，不随快照复制；鉴权已体现在 Header 里。 */
    expect(result.draft.cases).toEqual([])
    expect(result.draft.auth).toEqual({ type: 'none', value: { value: '' } })
    expect(result.draft.timeoutMs).toBe(15_000)
    expect(result.draft.followRedirects).toBe(true)
    expect(result.draft.maxRedirects).toBe(2)
  })

  test('Given URL 里含百分号编码的遮罩 When 载入 Then 用占位符替换并列入待重填', () => {
    const run = {
      ...createRun('run-2'),
      request: {
        ...createRun('run-2').request,
        url: 'https://example.test/users/%5BREDACTED%5D',
        headers: [],
        body: '',
      },
    }

    const result = draftFromRun(run, null, () => 'f1')

    expect(result.draft.url).toBe('https://example.test/users/{{REDACTED_SECRET}}')
    expect(result.redacted).toEqual(['URL'])
    /** 目录为空时仍可载入，落到默认集合。 */
    expect(result.draft.collectionId).toBe('default')
  })

  test('Given 两次相同运行 When 对比 Then 判一致且不产出任何差异行', () => {
    const run = withHop(createRun('run-1'))

    const diff = diffApiRuns(run, { ...run, id: 'run-2' })

    expect(diff.identical).toBe(true)
    expect(diff.headers).toEqual([])
    expect(diff.assertions).toEqual([])
    expect(diff.body).toEqual({ compared: true, lines: [], truncated: false })
    expect(diff.rows.every((row) => !row.changed)).toBe(true)
  })

  test('Given 状态码、耗时、大小与用例不同 When 对比 Then 逐项标出变化', () => {
    const baseline = withHop(createRun('run-1'))
    const candidate: ApiRun = {
      ...withHop(baseline, { status: 401, timings: { ...hopTimings(), totalMs: 42 } }),
      id: 'run-2',
      caseId: 'case_401',
      body: { ...baseline.body, rawBytes: 99, decodedBytes: 99, contentType: 'text/plain' },
    }

    const diff = diffApiRuns(baseline, candidate)
    const changed = diff.rows.filter((row) => row.changed).map((row) => `${row.label}:${row.baseline}→${row.candidate}`)

    expect(changed).toEqual([
      '状态码:200→401',
      '内容类型:application/json→text/plain',
      '原始字节:2→99',
      '解码字节:2→99',
      '总耗时(ms):7→42',
      '用例:—→case_401',
    ])
    expect(diff.identical).toBe(false)
  })

  test('Given 响应头与断言结论变化 When 对比 Then 按名称与断言 id 给出差异', () => {
    const baseline = withHop(createRun('run-1'))
    const candidate: ApiRun = {
      ...withHop(baseline, { responseHeaders: [{ name: 'X-Trace', value: 'def' }, { name: 'X-New', value: '1' }] }),
      id: 'run-2',
      assertions: [{ id: 'status', passed: false, expected: '200', actual: '500', message: '断言失败' }, { id: 'typed', passed: true, expected: 'number', actual: 'number', message: '断言通过' }],
    }
    const changedHeaders = diffApiRuns(baseline, candidate).headers
    const sameAssertions = diffApiRuns(baseline, { ...baseline, assertions: candidate.assertions }).assertions
    const changed = diffApiRuns({ ...baseline, assertions: [{ id: 'status', passed: true, expected: '200', actual: '200', message: '断言通过' }] }, candidate).assertions

    /** 基线响应头是 X-Trace，候选多了 X-New 且少了 X-Trace。 */
    expect(changedHeaders).toEqual([
      { name: 'x-new', change: 'added', baseline: '—', candidate: '1' },
      { name: 'x-trace', change: 'changed', baseline: 'abc', candidate: 'def' },
    ])
    /** 基线没有这两条断言，因此都是「未执行 → 结论」。 */
    expect(sameAssertions).toEqual([
      { id: 'status', baseline: '未执行', candidate: '失败', changed: true },
      { id: 'typed', baseline: '未执行', candidate: '通过', changed: true },
    ])
    expect(changed).toEqual([
      { id: 'status', baseline: '通过', candidate: '失败', changed: true },
      { id: 'typed', baseline: '未执行', candidate: '通过', changed: true },
    ])
  })

  test('Given 正文有少量变化 When 对比 Then 只列变化行并跳过共同前后缀', () => {
    const baseline = createRun('run-1')
    const candidate: ApiRun = {
      ...baseline,
      id: 'run-2',
      body: { ...baseline.body, preview: '{"a":1,\n"b":2,\n"c":3}' },
    }
    const withBody: ApiRun = { ...baseline, body: { ...baseline.body, preview: '{"a":1,\n"b":9,\n"c":3}' } }

    const diff = diffApiRuns(withBody, candidate)

    expect(diff.body.compared).toBe(true)
    expect(diff.body.lines).toEqual([{ kind: 'removed', text: '"b":9,' }, { kind: 'added', text: '"b":2,' }])
    expect(diff.body.truncated).toBe(false)
    /** 正文一致时不给逐行差异。 */
    expect(diffApiRuns(withBody, { ...withBody, id: 'run-3' }).body.lines).toEqual([])
  })

  test('Given 正文超过逐行对比上限 When 对比 Then 明确报无法逐行对比而不是给出错误差异', () => {
    const baseline = createRun('run-1')
    const long = Array.from({ length: 401 }, (_value, index) => `line-${index}`).join('\n')

    const diff = diffApiRuns({ ...baseline, body: { ...baseline.body, preview: long } }, { ...baseline, id: 'run-2', body: { ...baseline.body, preview: `${long}-changed` } })

    expect(diff.body.compared).toBe(false)
    expect(diff.body.lines).toEqual([])
    expect(diff.body.reason).toContain('超过逐行对比上限')
    /** 无法逐行对比也不能说两次运行一致。 */
    expect(diff.identical).toBe(false)
  })
})

// 保证模型只依赖工作台合同的窄接口，避免测试替身随 preload 其它能力膨胀。
void ({} as Pick<ApiWorkbenchApi, 'getCatalog' | 'saveCatalog' | 'prepare' | 'send' | 'cancel'>)
