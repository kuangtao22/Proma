import { describe, expect, test } from 'bun:test'
import { ServerOpsSftpRuntimeError, type ServerOpsSftpResult } from '../../../utility/server-ops/server-ops-sftp-runtime'
import { ServerOpsFileService } from './server-ops-file-service'

describe('服务器运维文件服务', () => {
  test('浏览和预览绑定 Main owner 与当前连接身份', async () => {
    const fixture = createFixture()
    const list = await fixture.service.list('owner-1', { hostId: 'host-1', path: '/etc' })
    expect(list.entries[0]?.path).toBe('/etc/hosts')
    expect(fixture.calls[0]).toMatchObject({ type: 'list', hostId: 'host-1', connectionId: 'connection-1', input: { ownerKey: 'owner-1' } })
    const preview = await fixture.service.preview('owner-1', { hostId: 'host-1', path: '/etc/hosts' })
    expect(preview.kind).toBe('text')
  })

  test('准备阶段不执行写入，提交需同 owner、主机名和连接代次', async () => {
    const fixture = createFixture()
    const candidate = await fixture.service.prepare(70, 'owner-1', { hostId: 'host-1', action: 'mkdir', path: '/srv/new' })
    expect(fixture.calls.some((call) => call.type === 'mkdir')).toBe(false)
    await expect(fixture.service.commit(71, 'owner-1', { hostId: 'host-1', candidateId: candidate.candidateId, confirmationName: '生产机' })).rejects.toThrow('SERVER_OPS_FILE_CANDIDATE_OWNER_MISMATCH')
    await expect(fixture.service.commit(70, 'owner-1', { hostId: 'host-1', candidateId: candidate.candidateId, confirmationName: '错误名称' })).rejects.toThrow('SERVER_OPS_FILE_CONFIRMATION_MISMATCH')
    fixture.identity.generation = 2
    await expect(fixture.service.commit(70, 'owner-1', { hostId: 'host-1', candidateId: candidate.candidateId, confirmationName: '生产机' })).rejects.toThrow('SERVER_OPS_CONNECTION_CHANGED')
  })

  test('开始审计失败阻断写入，成功提交写成配对审计且不记录路径', async () => {
    const fixture = createFixture()
    const candidate = await fixture.service.prepare(70, 'owner-1', { hostId: 'host-1', action: 'mkdir', path: '/srv/new' })
    fixture.auditFails = true
    await expect(fixture.service.commit(70, 'owner-1', { hostId: 'host-1', candidateId: candidate.candidateId, confirmationName: '生产机' })).rejects.toThrow('SERVER_OPS_AUDIT_WRITE_FAILED')
    expect(fixture.calls.some((call) => call.type === 'mkdir')).toBe(false)
    fixture.auditFails = false
    await fixture.service.commit(70, 'owner-1', { hostId: 'host-1', candidateId: candidate.candidateId, confirmationName: '生产机' })
    expect(fixture.audit).toHaveLength(2)
    expect(fixture.audit[0]).toMatchObject({ phase: 'start', outcome: 'pending', windowId: 70, operation: 'file-mkdir' })
    expect(fixture.audit[1]).toMatchObject({ phase: 'result', outcome: 'success', operationId: fixture.audit[0]?.operationId })
    expect(JSON.stringify(fixture.audit)).not.toContain('/srv/new')
  })

  test('已分派写入结果未知时记录 unknown 且候选不可重放', async () => {
    const fixture = createFixture()
    const candidate = await fixture.service.prepare(70, 'owner-1', { hostId: 'host-1', action: 'delete', path: '/etc/hosts', targetKind: 'file' })
    fixture.nextErrorType = 'unlink'
    fixture.nextError = new ServerOpsSftpRuntimeError('SERVER_OPS_SFTP_CONNECTION_LOST', 'unknown')
    await expect(fixture.service.commit(70, 'owner-1', { hostId: 'host-1', candidateId: candidate.candidateId, confirmationName: '生产机' })).rejects.toThrow('SERVER_OPS_FILE_RESULT_UNKNOWN')
    expect(fixture.audit.at(-1)).toMatchObject({ phase: 'result', outcome: 'unknown' })
    await expect(fixture.service.commit(70, 'owner-1', { hostId: 'host-1', candidateId: candidate.candidateId, confirmationName: '生产机' })).rejects.toThrow('SERVER_OPS_FILE_CANDIDATE_NOT_FOUND')
  })

  test('审计恢复等待后重新验证连接与授权，再允许远程写入', async () => {
    const fixture = createFixture()
    const candidate = await fixture.service.prepare(70, 'owner-1', { hostId: 'host-1', action: 'mkdir', path: '/srv/new' })
    fixture.prepareAudit = async () => { fixture.identity.generation = 2 }
    await expect(fixture.service.commit(70, 'owner-1', {
      hostId: 'host-1', candidateId: candidate.candidateId, confirmationName: '生产机',
    })).rejects.toThrow('SERVER_OPS_CONNECTION_CHANGED')
    expect(fixture.calls.some((call) => call.type === 'mkdir')).toBe(false)
  })

  test('Agent 变更记录真实 session 并在单次调用后释放 owner', async () => {
    const fixture = createFixture()
    let authorizationChecks = 0
    const result = await fixture.service.mutateForAgent(
      'session-1',
      { hostId: 'host-1', action: 'mkdir', path: '/srv/agent' },
      () => { authorizationChecks += 1 },
    )
    expect(result.outcome).toBe('success')
    expect(authorizationChecks).toBeGreaterThanOrEqual(4)
    expect(fixture.audit[0]).toMatchObject({ actor: 'agent', sessionId: 'session-1', operation: 'file-mkdir' })
    expect(fixture.audit[0]).not.toHaveProperty('windowId')
    expect(fixture.closedOwners).toHaveLength(1)
    expect(fixture.closedOwners[0]).toStartWith('agent-file:session-1:')
  })

  test('Agent 授权在准备后失效时不执行远程写入并释放 owner', async () => {
    const fixture = createFixture()
    let authorizationChecks = 0
    await expect(fixture.service.mutateForAgent(
      'session-1',
      { hostId: 'host-1', action: 'mkdir', path: '/srv/agent' },
      () => {
        authorizationChecks += 1
        if (authorizationChecks === 2) throw new Error('SERVER_OPS_AGENT_ACCESS_NOT_ALLOWED')
      },
    )).rejects.toThrow('SERVER_OPS_AGENT_ACCESS_NOT_ALLOWED')
    expect(fixture.calls.some((call) => call.type === 'mkdir')).toBe(false)
    expect(fixture.closedOwners).toHaveLength(1)
  })

  test('Agent 只读 owner 可独立释放', () => {
    const fixture = createFixture()
    fixture.service.releaseReader('agent-reader-1')
    expect(fixture.closedOwners).toEqual(['agent-reader-1'])
  })

  test('准备 stat 等待期间关闭 owner 后拒绝生成迟到候选', async () => {
    const fixture = createFixture()
    fixture.deferNextStat()
    const preparing = fixture.service.prepare(70, 'window:7:files', {
      hostId: 'host-1', action: 'delete', path: '/etc/hosts', targetKind: 'file',
    })
    await fixture.waitForDeferredStat()
    fixture.service.closeOwner(70, 'window:7:files')
    fixture.releaseDeferredStat()
    await expect(preparing).rejects.toThrow('SERVER_OPS_FILE_OWNER_CLOSED')
  })

  test('提交 stat 等待期间取消候选后不执行远程写入', async () => {
    const fixture = createFixture()
    const candidate = await fixture.service.prepare(70, 'window:7:files', {
      hostId: 'host-1', action: 'delete', path: '/etc/hosts', targetKind: 'file',
    })
    fixture.deferNextStat()
    const committing = fixture.service.commit(70, 'window:7:files', {
      hostId: 'host-1', candidateId: candidate.candidateId, confirmationName: '生产机',
    })
    await fixture.waitForDeferredStat()
    fixture.service.cancel(70, 'window:7:files', { hostId: 'host-1', candidateId: candidate.candidateId })
    fixture.releaseDeferredStat()
    await expect(committing).rejects.toThrow('SERVER_OPS_FILE_CANDIDATE_NOT_FOUND')
    expect(fixture.calls.some((call) => call.type === 'unlink')).toBe(false)
    expect(fixture.audit).toHaveLength(0)
  })
})

function createFixture() {
  const calls: Array<{ type: string; hostId: string; connectionId: string; input: Record<string, unknown> }> = []
  const audit: Array<Record<string, unknown>> = []
  const closedOwners: string[] = []
  const identity = { hostId: 'host-1', connectionId: 'connection-1', generation: 1 }
  let auditFails = false
  let nextError: Error | undefined
  let nextErrorType: string | undefined
  let prepareAudit: (() => Promise<void>) | undefined
  let deferredStat: { started: Promise<void>; markStarted(): void; promise: Promise<void>; release(): void } | undefined
  const service = new ServerOpsFileService({
    hosts: { get: () => ({ id: 'host-1', name: '生产机' }) },
    connections: {
      getActiveIdentity: () => ({ ...identity }),
      async sftp(call) {
        calls.push(call as unknown as typeof calls[number])
        if (call.type === 'stat' && deferredStat) {
          deferredStat.markStarted()
          await deferredStat.promise
          deferredStat = undefined
        }
        if (nextError && (!nextErrorType || nextErrorType === call.type)) { const error = nextError; nextError = undefined; nextErrorType = undefined; throw error }
        return createResult(call.type)
      },
      closeSftpOwner: (ownerKey) => { closedOwners.push(ownerKey) },
    },
    audit: {
      append(input) { if (auditFails) throw new Error('disk'); audit.push(input as unknown as Record<string, unknown>) },
      async prepareForWrites() { await prepareAudit?.() },
    },
    now: () => 1_000,
    uuid: (() => { let id = 0; return () => `id-${++id}` })(),
  })
  return {
    service, calls, audit, identity, closedOwners,
    get auditFails() { return auditFails }, set auditFails(value: boolean) { auditFails = value },
    get nextError() { return nextError }, set nextError(value: Error | undefined) { nextError = value },
    get nextErrorType() { return nextErrorType }, set nextErrorType(value: string | undefined) { nextErrorType = value },
    get prepareAudit() { return prepareAudit }, set prepareAudit(value: (() => Promise<void>) | undefined) { prepareAudit = value },
    deferNextStat() { deferredStat = createDeferredStat() },
    async waitForDeferredStat() { await deferredStat?.started },
    releaseDeferredStat() { deferredStat?.release() },
  }
}

/** 创建测试可控的 stat 等待点，确保关闭与取消发生在远程读取返回前。 */
function createDeferredStat(): { started: Promise<void>; markStarted(): void; promise: Promise<void>; release(): void } {
  let markStarted: () => void = () => undefined
  let release: () => void = () => undefined
  return {
    started: new Promise<void>((resolve) => { markStarted = resolve }),
    markStarted: () => markStarted(),
    promise: new Promise<void>((resolve) => { release = resolve }),
    release: () => release(),
  }
}

function createResult(type: string): ServerOpsSftpResult {
  if (type === 'list') return { type: 'list', requestId: 'runtime-1', result: { path: '/etc', entries: [{ name: 'hosts', path: '/etc/hosts', kind: 'file', size: 10, mtime: 20, mode: 0o100644 }] } }
  if (type === 'preview') return { type: 'preview', requestId: 'runtime-1', result: { kind: 'text', path: '/etc/hosts', content: 'localhost\n', bytesRead: 10, hash: `sha256:${'a'.repeat(64)}`, stat: { kind: 'file', size: 10, mtime: 20, mode: 0o100644 }, editFacts: { path: '/etc/hosts', size: 10, mtime: 20, mode: 0o100644, hash: `sha256:${'a'.repeat(64)}` } } }
  if (type === 'stat') return { type: 'stat', requestId: 'runtime-1', result: { kind: 'file', size: 10, mtime: 20, mode: 0o100644 } }
  if (type === 'save' || type === 'save-as') return { type, requestId: 'runtime-1', result: { path: '/etc/hosts', size: 10, mtime: 20, mode: 0o100644, hash: `sha256:${'a'.repeat(64)}` } }
  return { type: type as 'mkdir', requestId: 'runtime-1', result: { ok: true } }
}
