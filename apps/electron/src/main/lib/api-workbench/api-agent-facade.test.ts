import { describe, expect, test } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import type { AgentSessionMeta } from '@proma/shared'
import type { ApiResolvedRequest } from '@proma/shared'
import { createApiRequestDraft } from '@proma/shared'
import { ApiFileStore } from './api-file-store'
import { ApiWorkbenchStore } from './api-workbench-store'
import { ApiWorkbenchService } from './api-workbench-service'
import { createApiAgentFacade } from './api-agent-facade'

/** 建立不访问真实网络、不读用户配置的 Agent 场景；可注入窄上限的文件仓库以验证回滚。 */
function fixture(files?: ApiFileStore) {
  /** macOS 的 `/var` 指向 `/private/var`，先固定 realpath 让审批路径断言稳定。 */
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'api-agent-')))
  let session = { id: 'session', workspaceId: 'workspace' } as AgentSessionMeta
  let sends = 0
  /** 记录真实派发出去的请求，用于逐字节核对附件。 */
  const sent: ApiResolvedRequest[] = []
  const abort = new AbortController()
  const service = new ApiWorkbenchService({ store: new ApiWorkbenchStore(root), transport: async (request) => {
    sends += 1
    sent.push(request)
    return { state: 'completed', hops: [], body: { rawBytes: 2, decodedBytes: 2, contentType: 'text/plain', encoding: '', preview: 'ok', previewTruncated: false, complete: true, decoded: true } }
  }, ...(files ? { files } : {}) })
  const options = { sessionId: 'session', toolMode: 'standard', getSession: () => session, service, runSignal: abort.signal, assertRunActive: () => { if (abort.signal.aborted) throw new Error('stopped') } }
  const facade = createApiAgentFacade(options)!
  return { facade, options, service, abort, root, sent, sends: () => sends, change: (next: Partial<AgentSessionMeta>) => { session = { ...session, ...next } }, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

describe('Agent 接口工作台授权边界', () => {
  test('Given 后台、委派或无项目会话 When 构建工具 Then 不授予接口能力', () => {
    const f = fixture()
    try {
      expect(createApiAgentFacade({ ...f.options, triggeredBy: 'automation' })).toBeUndefined()
      expect(createApiAgentFacade({ ...f.options, toolMode: 'server-ops-read' })).toBeUndefined()
      f.change({ parentSessionId: 'parent' })
      expect(createApiAgentFacade(f.options)).toBeUndefined()
    } finally { f.cleanup() }
  })
  test('Given 已准备请求 When 未授权直接发送 Then 无网络调用；批准后重复调用仍只发送一次', async () => {
    const f = fixture()
    try {
      const prepared = await f.facade.prepare({ request: { url: 'https://example.test', method: 'POST' } })
      const args = { preparedId: prepared.preparedId }
      await expect(f.facade.send(args)).rejects.toThrow('APPROVAL_REQUIRED')
      const snapshot = await f.facade.approval('api_send_request', args)
      expect(snapshot.preview.request.url).toBe('https://example.test/')
      await f.facade.authorize('api_send_request', args, snapshot)
      const first = await f.facade.send(args)
      const second = await f.facade.send(args)
      expect(first.runId).toBe(second.runId)
      expect(f.sends()).toBe(1)
      await expect(f.facade.save({ ...args, expectedRevision: 0 })).rejects.toThrow('APPROVAL_REQUIRED')
    } finally { f.cleanup() }
  })
  test('Given 审批等待中目录变化 When 批准旧快照 Then 拒绝并且不出网', async () => {
    const f = fixture()
    try {
      const prepared = await f.facade.prepare({ request: { url: 'https://example.test' } })
      const args = { preparedId: prepared.preparedId }
      const snapshot = await f.facade.approval('api_send_request', args)
      const catalog = await f.service.getCatalog('workspace')
      await f.service.saveCatalog('workspace', catalog.revision, catalog)
      await expect(f.facade.authorize('api_send_request', args, snapshot)).rejects.toThrow('STALE')
      expect(f.sends()).toBe(0)
    } finally { f.cleanup() }
  })
  test('Given 会话移到另一项目或运行停止 When 再次调用 Then 旧 facade 失效', async () => {
    const f = fixture()
    try {
      f.change({ workspaceId: 'other' })
      await expect(f.facade.list({})).rejects.toThrow('SCOPE')
      f.change({ workspaceId: 'workspace' })
      f.abort.abort()
      await expect(f.facade.list({})).rejects.toThrow()
    } finally { f.cleanup() }
  })
})

test('Given 请求测试完成 When 另行批准保存 Then 仍可保存原草稿且不重发', async () => {
  const f = fixture()
  try {
    const prepared = await f.facade.prepare({ request: { name: '已测请求', url: 'https://example.test' } })
    const args = { preparedId: prepared.preparedId }
    await f.facade.authorize('api_send_request', args, await f.facade.approval('api_send_request', args))
    await f.facade.send(args)
    const saving = { ...args, expectedRevision: prepared.catalogRevision }
    await f.facade.authorize('api_save_request', saving, await f.facade.approval('api_save_request', saving))
    const saved = await f.facade.save(saving)
    expect(saved.saved).toBe(true)
    expect((await f.service.getCatalog('workspace')).requests[0]?.name).toBe('已测请求')
    expect(f.sends()).toBe(1)
  } finally { f.cleanup() }
})

/** 直接经 IPC 保存路径写入一条人工创建的用例，模拟人在界面上的操作。 */
async function saveHumanCaseRequest(f: ReturnType<typeof fixture>): Promise<string> {
  const catalog = await f.service.getCatalog('workspace')
  const draft = {
    ...createApiRequestDraft(catalog.collections[0]?.id ?? 'default'),
    name: '人工维护的登录',
    url: 'https://example.test/login',
    assertions: [{ id: 'default_status', kind: 'status' as const, path: '', expected: '200' }],
    cases: [{
      id: 'case_human',
      name: '人工写的越权',
      assertions: [{ id: 'case_a', kind: 'status' as const, path: '', expected: '403' }],
    }],
  }
  const saved = await f.service.saveCatalog('workspace', catalog.revision, { ...catalog, requests: [{ ...draft, id: 'request_human', revision: 1, updatedAt: 1 }] })
  return saved.requests[0]!.id
}

describe('Agent 出题边界', () => {
  test('Given Agent 自己声明用例 When 批准并保存 Then 用例入库且来源盖章为 agent', async () => {
    const f = fixture()
    try {
      const prepared = await f.facade.prepare({ request: {
        name: 'Agent 建的接口', url: 'https://example.test/orders', method: 'POST',
        cases: [{ id: 'case_agent_ok', name: '下单成功', assertions: [{ id: 'case_a', kind: 'status', path: '', expected: '201' }] }],
      } })
      const saving = { preparedId: prepared.preparedId, expectedRevision: prepared.catalogRevision }
      const snapshot = await f.facade.approval('api_save_request', saving)

      expect(snapshot.save?.caseDiff).toEqual([{ caseId: 'case_agent_ok', caseName: '下单成功', source: 'agent', change: 'added', assertionCount: 1 }])
      expect(snapshot.save?.definition.cases?.[0]?.source).toBe('agent')

      await f.facade.authorize('api_save_request', saving, snapshot)
      await f.facade.save(saving)
      /** 落库的用例带来源，报告与界面据此区分谁出的题。 */
      const stored = (await f.service.getCatalog('workspace')).requests[0]
      expect(stored?.cases?.[0]?.source).toBe('agent')
      expect(stored?.cases?.[0]?.name).toBe('下单成功')
    } finally { f.cleanup() }
  })

  test('Given 人工写的用例 When Agent 改断言或删除 Then 审批前就拒绝且目录不变', async () => {
    const f = fixture()
    try {
      const requestId = await saveHumanCaseRequest(f)
      const before = (await f.service.getCatalog('workspace')).requests[0]!
      const modified = await f.facade.prepare({ requestId, request: { cases: [{ id: 'case_human', name: '人工写的越权', assertions: [{ id: 'case_a', kind: 'status', path: '', expected: '200' }] }] } })
      const removed = await f.facade.prepare({ requestId, request: { cases: [] } })

      await expect(f.facade.approval('api_save_request', { preparedId: modified.preparedId, expectedRevision: before.revision }))
        .rejects.toThrow('API_WORKBENCH_USER_CASE_PROTECTED')
      await expect(f.facade.approval('api_save_request', { preparedId: removed.preparedId, expectedRevision: before.revision }))
        .rejects.toThrow('API_WORKBENCH_USER_CASE_PROTECTED')
      expect((await f.service.getCatalog('workspace')).requests[0]?.cases).toEqual(before.cases)
    } finally { f.cleanup() }
  })

  test('Given 人工用例原样保留 When Agent 追加自己的用例 Then 保存成功且两个来源各自不变', async () => {
    const f = fixture()
    try {
      const requestId = await saveHumanCaseRequest(f)
      const before = (await f.service.getCatalog('workspace')).requests[0]!
      const humanCase = before.cases![0]!
      const prepared = await f.facade.prepare({ requestId, request: { cases: [
        humanCase,
        { id: 'case_agent_extra', name: 'Agent 补的缺参数', assertions: [{ id: 'case_b', kind: 'status', path: '', expected: '400' }] },
      ] } })
      const saving = { preparedId: prepared.preparedId, expectedRevision: before.revision }
      const snapshot = await f.facade.approval('api_save_request', saving)

      expect(snapshot.save?.caseDiff).toEqual([{ caseId: 'case_agent_extra', caseName: 'Agent 补的缺参数', source: 'agent', change: 'added', assertionCount: 1 }])

      await f.facade.authorize('api_save_request', saving, snapshot)
      await f.facade.save(saving)
      const stored = (await f.service.getCatalog('workspace')).requests[0]!
      expect(stored.cases?.map((item) => `${item.id}:${item.source}`)).toEqual(['case_human:user', 'case_agent_extra:agent'])
      expect(stored.cases?.[0]?.assertions[0]?.expected).toBe('403')
    } finally { f.cleanup() }
  })

  test('Given 按用例准备 When 读取发送审批快照 Then 带上用例身份与断言条数', async () => {
    const f = fixture()
    try {
      const requestId = await saveHumanCaseRequest(f)
      const prepared = await f.facade.prepare({ requestId, caseId: 'case_human' })

      const snapshot = await f.facade.approval('api_send_request', { preparedId: prepared.preparedId })

      expect(snapshot.send).toEqual({ caseId: 'case_human', caseName: '人工写的越权', assertionCount: 1 })
      await f.facade.authorize('api_send_request', { preparedId: prepared.preparedId }, snapshot)
      expect((await f.facade.send({ preparedId: prepared.preparedId })).caseId).toBe('case_human')
    } finally { f.cleanup() }
  })
})

/** 在临时工作区里造一个待上传文件，返回路径与字节。 */
function uploadFixture(f: ReturnType<typeof fixture>, name: string, bytes: Buffer): string {
  const path = join(f.root, name)
  writeFileSync(path, bytes)
  return path
}

/** 组装一条由 Agent 声明文件的 multipart 草稿。 */
function uploadRequest(url: string, files: unknown, fields: unknown[] = [{ id: 'field_note', name: 'note', value: 'agent 中文', enabled: true }]): Record<string, unknown> {
  return { name: 'Agent 上传附件', url, method: 'POST', body: { kind: 'multipart', text: '', fields, files } }
}

describe('Agent 指定文件与确认授权', () => {
  test('Given Agent 声明路径 When 未批准发送 Then 拒绝且不出网；批准后按真实字节上传', async () => {
    const f = fixture()
    try {
      const bytes = Buffer.from([0x2d, 0x2d, 0x00, 0xff, 0xfe, 0x80, 0x0a, 0x0d])
      const path = uploadFixture(f, 'report.bin', bytes)
      const prepared = await f.facade.prepare({ request: uploadRequest('https://example.test/upload', [{ id: 'part_1', name: 'file', path }]) })

      /** 模型可见的准备回执里只有引用与文件名，没有真实路径。 */
      expect(JSON.stringify(prepared)).not.toContain(f.root)
      expect(prepared.request.body).toContain('filename="report.bin"')
      expect(prepared.request.body).toContain('<文件内容未留存')

      const args = { preparedId: prepared.preparedId }
      await expect(f.facade.send(args)).rejects.toThrow('APPROVAL_REQUIRED')
      expect(f.sends()).toBe(0)

      /** 审批快照逐行给出「目标字段 + realpath + 大小」。 */
      const snapshot = await f.facade.approval('api_send_request', args)
      expect(snapshot.files).toEqual([{ field: 'file', path, sizeBytes: bytes.length }])

      await f.facade.authorize('api_send_request', args, snapshot)
      const run = await f.facade.send(args)

      expect(run.state).toBe('completed')
      expect(f.sends()).toBe(1)
      /** 附件字节在批准后才被读入：派发正文里能逐字节找到原文件内容。 */
      const outgoing = Buffer.from(f.sent[0]!.bodyBase64 ?? '', 'base64')
      expect(outgoing.includes(bytes)).toBe(true)
      expect(outgoing.toString('utf8')).toContain('agent 中文')
      /** 运行记录只留摘要：没有路径、没有字节，sha256 与大小都能核对。 */
      const stored = await f.service.getRun({ workspaceId: 'workspace', sessionId: 'session', source: 'agent' }, run.runId, false)
      expect(stored.request.attachments).toEqual([{ field: 'file', fileName: 'report.bin', sizeBytes: bytes.length, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) }])
      expect(JSON.stringify(stored)).not.toContain(f.root)
      /** 模型回执同样不含路径：只有文件名与结构摘要。 */
      expect(JSON.stringify(run)).not.toContain(f.root)
    } finally { f.cleanup() }
  })

  test('Given 符号链接 When 准备 Then 审批行按 realpath 展开、文件名取自真实文件', async () => {
    const f = fixture()
    try {
      const target = uploadFixture(f, 'id_rsa', Buffer.from('secret-key'))
      const link = join(f.root, 'looks-innocent.txt')
      symlinkSync(target, link)

      const prepared = await f.facade.prepare({ request: uploadRequest('https://example.test/upload', [{ id: 'part_1', name: 'file', path: link }]) })
      const snapshot = await f.facade.approval('api_send_request', { preparedId: prepared.preparedId })

      expect(snapshot.files).toEqual([{ field: 'file', path: target, sizeBytes: 'secret-key'.length }])
      /** 文件名同样不能被链接名伪装：摘要正文里出现的是真实文件名。 */
      expect(prepared.request.body).toContain(`filename="${basename(target)}"`)
      expect(prepared.request.body).not.toContain('looks-innocent')
    } finally { f.cleanup() }
  })

  test('Given 目录、设备或悬空链接 When 准备 Then 拒绝并且不签发 preparedId', async () => {
    const f = fixture()
    try {
      const dangling = join(f.root, 'dangling.txt')
      symlinkSync(join(f.root, 'missing-target'), dangling)

      await expect(f.facade.prepare({ request: uploadRequest('https://example.test/upload', [{ id: 'part_1', name: 'file', path: f.root }]) }))
        .rejects.toThrow('API_WORKBENCH_FILE_INVALID_TYPE')
      await expect(f.facade.prepare({ request: uploadRequest('https://example.test/upload', [{ id: 'part_1', name: 'file', path: dangling }]) }))
        .rejects.toThrow('API_WORKBENCH_FILE_MISSING')
      /** 设备文件同样不是常规文件；Windows 上没有 /dev/null，跳过该断言。 */
      if (process.platform !== 'win32') {
        await expect(f.facade.prepare({ request: uploadRequest('https://example.test/upload', [{ id: 'part_1', name: 'file', path: '/dev/null' }]) }))
          .rejects.toThrow('API_WORKBENCH_FILE_INVALID_TYPE')
      }
    } finally { f.cleanup() }
  })

  test('Given 声明了文件但正文不是 multipart When 准备 Then 拒绝而不是静默丢弃', async () => {
    const f = fixture()
    try {
      const path = uploadFixture(f, 'note.txt', Buffer.from('note'))

      await expect(f.facade.prepare({ request: { url: 'https://example.test', method: 'POST', body: { kind: 'urlencoded', text: '', fields: [], files: [{ id: 'part_1', name: 'file', path }] } } }))
        .rejects.toThrow('API_WORKBENCH_INVALID: body.files.multipartOnly')
      expect(f.sends()).toBe(0)
    } finally { f.cleanup() }
  })

  test('Given 准备在登记之后失败 When 再准备 Then 文件槽位已被回滚', async () => {
    const f = fixture(new ApiFileStore({ maxFiles: 1 }))
    try {
      const path = uploadFixture(f, 'note.txt', Buffer.from('note'))
      const files = [{ id: 'part_1', name: 'file', path }]

      /** URL 非法会在服务层准备阶段抛错，此时引用已经登记，必须被回滚。 */
      await expect(f.facade.prepare({ request: uploadRequest('ftp://example.test/upload', files) })).rejects.toThrow('API_WORKBENCH_INVALID: request.url')
      /** 槽位只有 1 个：没回滚的话这次准备会以文件数量上限失败。 */
      const prepared = await f.facade.prepare({ request: uploadRequest('https://example.test/upload', files) })
      expect(prepared.request.body).toContain('filename="note.txt"')
    } finally { f.cleanup() }
  })

  test('Given 批准前文件被换掉 When 发送 Then 拒绝且不出网', async () => {
    const f = fixture()
    try {
      const path = uploadFixture(f, 'doc.bin', Buffer.from('v1'))
      const prepared = await f.facade.prepare({ request: uploadRequest('https://example.test/upload', [{ id: 'part_1', name: 'file', path }]) })
      const args = { preparedId: prepared.preparedId }
      const snapshot = await f.facade.approval('api_send_request', args)
      await f.facade.authorize('api_send_request', args, snapshot)

      /** 批准之后、派发之前换文件：inode/时间戳复核必须拒绝，避免「批准的是 A、发出的是 B」。 */
      writeFileSync(path, Buffer.from('v2-longer'))

      await expect(f.facade.send(args)).rejects.toThrow('API_WORKBENCH_FILE_CHANGED')
      expect(f.sends()).toBe(0)
    } finally { f.cleanup() }
  })
})
