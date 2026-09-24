import { describe, expect, test } from 'bun:test'
import type { ApiCatalog, ApiRequestDraft, ApiRun, ApiWorkbenchApi } from '@proma/shared'
import { createApiCatalogSnapshotExport, createApiRequestDraft } from '@proma/shared'
import {
  appendBodySlice,
  clearApiValue,
  createImportedRequestTabs,
  createApiWorkbenchController,
  createRequestTab,
  editApiValue,
  formatApiResponseBody,
  previewApiWorkbenchImport,
  renameCatalogFolder,
  saveCatalogWithLatestRevision,
  upsertCatalogRequest,
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
})

// 保证模型只依赖工作台合同的窄接口，避免测试替身随 preload 其它能力膨胀。
void ({} as Pick<ApiWorkbenchApi, 'getCatalog' | 'saveCatalog' | 'prepare' | 'send' | 'cancel'>)
