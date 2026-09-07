import { describe, expect, test } from 'bun:test'
import type { ServerOpsAuditAppendInput, ServerOpsConnectionState, ServerOpsHost, ServerOpsHostKey } from '@proma/shared'
import { ServerOpsTrustService } from './server-ops-trust-service'
import { AtomicWritePostCommitError } from '../safe-file'
import { ServerOpsConfigOutcomeUnknownError } from './server-ops-config-transaction'

/** 故障注入只替换本地依赖，不连接真实服务器。 */
interface FixtureOptions {
  fault?: 'result-audit' | 'post-commit' | 'post-commit-read' | 'release' | 'transaction-outcome-unknown' | 'outer-transaction-outcome-unknown'
  guard?: () => Promise<() => void>
  prepareAudit?: () => Promise<void>
}

/** 固定的两个公钥身份，测试不发起 SSH 或读取用户配置。 */
const oldKey = { algorithm: 'ssh-ed25519', fingerprint: 'SHA256:first' }
const newKey = { algorithm: 'ssh-ed25519', fingerprint: 'SHA256:second' }

/** 为候选、审批与连接撤权构造可观测的领域依赖。 */
function fixture(options: FixtureOptions = {}) {
  const hosts: ServerOpsHost[] = ['host-1', 'host-2'].map((id) => ({ id, name: id, address: 'localhost', port: 22, username: 'test', authMethod: 'ssh-agent', tags: [], createdAt: 1, updatedAt: 1 }))
  let trusted: ServerOpsHostKey | undefined = { ...oldKey }
  let now = 1000
  let generation = 1
  let busy = false
  let denyAudit = false
  let otherInstance = false
  let calls = 0
  /** 记录是否已经写入新身份，用于模拟 rename 后读取故障。 */
  let committed = false
  const disconnected: string[] = []
  const revoked: string[] = []
  const audit: ServerOpsAuditAppendInput[] = []
  const state: ServerOpsConnectionState = { hostId: 'host-1', phase: 'blocked', hostKey: newKey, previousHostKey: oldKey }
  const service = new ServerOpsTrustService({
    hosts: { list: () => hosts, get: (id) => hosts.find((host) => host.id === id) },
    trust: {
      get: () => {
        if (committed && options.fault === 'post-commit-read') throw new Error('read failed')
        return trusted
      },
      replace: (_host, expected, next) => {
        expect(trusted).toEqual(expected)
        trusted = { ...next }
        committed = true
        if (options.fault === 'transaction-outcome-unknown') {
          throw new ServerOpsConfigOutcomeUnknownError(new Error('post-verify failed'))
        }
        if (options.fault === 'post-commit' || options.fault === 'post-commit-read') {
          throw new AtomicWritePostCommitError('mainDurabilityUncertain', new Error('fsync failed'))
        }
      },
      revoke: (_host, expected) => { expect(trusted).toEqual(expected); trusted = undefined },
    },
    connections: {
      getState: (hostId) => ({ ...state, hostId }), getGeneration: () => generation,
      hasPendingOperations: () => busy,
      disconnect: (id) => { disconnected.push(id); return { hostId: id, phase: 'disconnected' } },
    },
    revokeHostAccess: (id) => { revoked.push(id) },
    audit: { prepareForWrites: options.prepareAudit, append: (entry) => {
      if (denyAudit || (entry.phase === 'result' && options.fault === 'result-audit')) throw new Error('SERVER_OPS_AUDIT_WRITE_FAILED')
      audit.push(entry)
    } },
    transaction: (callback) => {
      const result = callback()
      if (options.fault === 'outer-transaction-outcome-unknown') {
        throw new ServerOpsConfigOutcomeUnknownError(new Error('outer post-verify failed'))
      }
      return result
    },
    acquireMutationGuard: options.guard ?? (async () => {
      if (otherInstance) throw new Error('SERVER_OPS_OTHER_INSTANCE_ACTIVE')
      return () => { calls++; if (options.fault === 'release') throw new Error('release failed') }
    }),
    now: () => now, uuid: () => `candidate-${++calls}`,
  })
  return { service, hosts, disconnected, revoked, audit, state,
    trusted: () => trusted, advance: () => { now += 300_001 },
    reconnect: () => { generation++ }, setBusy: () => { busy = true },
    setAuditFailure: () => { denyAudit = true }, setOtherInstance: () => { otherInstance = true },
    changeTrust: () => { trusted = { algorithm: 'ssh-ed25519', fingerprint: 'SHA256:third' } },
  }
}

describe('服务器信任候选与显式提交', () => {
  test('Given 审计 schema 准备失败 When 提交信任 Then mutation guard 与信任副作用均不发生', async () => {
    let guardCalls = 0
    const f = fixture({
      prepareAudit: async () => { throw new Error('SERVER_OPS_AUDIT_SCHEMA_NOT_PREPARED') },
      guard: async () => { guardCalls += 1; return () => {} },
    })
    try {
      const candidate = f.service.prepare(7, { hostId: 'host-1', action: 'replace' })

      await expect(f.service.commit(7, {
        hostId: 'host-1', candidateId: candidate.candidateId, confirmationName: 'host-1',
      })).rejects.toThrow('SERVER_OPS_AUDIT_SCHEMA_NOT_PREPARED')
      expect(guardCalls).toBe(0)
      expect(f.trusted()).toEqual(oldKey)
      expect(f.audit).toHaveLength(0)
      expect(f.disconnected).toHaveLength(0)
    } finally { f.service.dispose() }
  })

  test('Given 同 endpoint 两台主机 When 提交有效候选 Then 全部撤权断线且不自动重连', async () => {
    const f = fixture()
    try {
      const candidate = f.service.prepare(7, { hostId: 'host-1', action: 'replace' })
      expect(candidate.affectedHosts).toHaveLength(2)
      expect(f.trusted()).toEqual(oldKey)
      expect(await f.service.commit(7, { hostId: 'host-1', candidateId: candidate.candidateId, confirmationName: 'host-1' }))
        .toEqual({ hostId: 'host-1', action: 'replace', affectedHostIds: ['host-1', 'host-2'] })
      expect(f.trusted()).toEqual(newKey)
      expect(f.disconnected).toEqual(['host-1', 'host-2'])
      expect(f.revoked).toEqual(['host-1', 'host-2'])
      expect(f.audit.map((entry) => entry.outcome)).toEqual(['pending', 'success'])
      expect(f.audit[0]?.operationId).toBe(f.audit[1]?.operationId)
      expect(f.audit[0]?.windowId).toBe(7)
      expect(f.audit[0]?.sessionId).toBeUndefined()
      expect(f.audit[0]?.resourceType).toBe('host-trust')
    } finally { f.service.dispose() }
  })

  test.each(['owner', 'name', 'expiry', 'generation', 'endpoint', 'trust', 'scope', 'cancel', 'closed'] as const)(
    'Given %s 不再匹配 When 提交 Then 信任和连接没有副作用', async (reason) => {
      const f = fixture()
      try {
        const candidate = f.service.prepare(7, { hostId: 'host-1', action: 'replace' })
        if (reason === 'expiry') f.advance()
        if (reason === 'generation') f.reconnect()
        if (reason === 'endpoint') f.hosts[0]!.port = 2222
        if (reason === 'trust') f.changeTrust()
        if (reason === 'scope') f.hosts.pop()
        if (reason === 'cancel') f.service.cancel(7, { hostId: 'host-1', candidateId: candidate.candidateId })
        if (reason === 'closed') f.service.disposeOwner(7)
        const before = f.trusted()
        await expect(f.service.commit(reason === 'owner' ? 8 : 7, {
          hostId: 'host-1', candidateId: candidate.candidateId, confirmationName: reason === 'name' ? 'wrong' : 'host-1',
        })).rejects.toThrow()
        expect(f.trusted()).toEqual(before)
        expect(f.audit).toHaveLength(0)
        expect(f.disconnected).toHaveLength(0)
      } finally { f.service.dispose() }
    },
  )

  test.each(['audit', 'busy', 'instance'] as const)('Given %s 拒绝 When 用户确认 Then 在身份写入和撤权前阻断', async (reason) => {
    const f = fixture()
    try {
      const candidate = f.service.prepare(7, { hostId: 'host-1', action: 'replace' })
      if (reason === 'audit') f.setAuditFailure()
      if (reason === 'busy') f.setBusy()
      if (reason === 'instance') f.setOtherInstance()
      await expect(f.service.commit(7, { hostId: 'host-1', candidateId: candidate.candidateId, confirmationName: 'host-1' })).rejects.toThrow()
      expect(f.trusted()).toEqual(oldKey)
      expect(f.disconnected).toHaveLength(0)
      expect(f.revoked).toHaveLength(0)
    } finally { f.service.dispose() }
  })

  test('Given 未观测到变化身份 When 准备替换 Then 拒绝；撤销仍可显式完成', async () => {
    const f = fixture()
    try {
      f.state.phase = 'disconnected'
      expect(() => f.service.prepare(7, { hostId: 'host-1', action: 'replace' })).toThrow()
      const candidate = f.service.prepare(7, { hostId: 'host-1', action: 'revoke' })
      await f.service.commit(7, { hostId: 'host-1', candidateId: candidate.candidateId, confirmationName: 'host-1' })
      expect(f.trusted()).toBeUndefined()
      expect(f.audit.at(-1)?.operation).toBe('trust-revoke')
    } finally { f.service.dispose() }
  })

  test.each(['result-audit', 'post-commit', 'release'] as const)('Given %s 故障 When 已提交信任 Then 保留事实并返回警告', async (fault) => {
    const f = fixture({ fault })
    try {
      const candidate = f.service.prepare(7, { hostId: 'host-1', action: 'replace' })
      const result = await f.service.commit(7, { hostId: 'host-1', candidateId: candidate.candidateId, confirmationName: 'host-1' })
      expect(result.warning).toBeDefined()
      expect(f.trusted()).toEqual(newKey)
      expect(f.disconnected).toHaveLength(2)
    } finally { f.service.dispose() }
  })

  test('Given 嵌套配置事务在写入后结果未知 When 提交信任 Then 记录 unknown 且返回稳定未知结果', async () => {
    const f = fixture({ fault: 'transaction-outcome-unknown' })
    try {
      const candidate = f.service.prepare(7, { hostId: 'host-1', action: 'replace' })
      await expect(f.service.commit(7, {
        hostId: 'host-1', candidateId: candidate.candidateId, confirmationName: 'host-1',
      })).rejects.toThrow('SERVER_OPS_TRUST_RESULT_UNKNOWN')
      expect(f.trusted()).toEqual(newKey)
      expect(f.audit.at(-1)).toMatchObject({ phase: 'result', outcome: 'unknown', errorCode: 'SERVER_OPS_TRUST_RESULT_UNKNOWN' })
      await expect(f.service.commit(7, {
        hostId: 'host-1', candidateId: candidate.candidateId, confirmationName: 'host-1',
      })).rejects.toThrow('SERVER_OPS_TRUST_CANDIDATE_EXPIRED')
    } finally { f.service.dispose() }
  })

  test('Given 外层配置事务在提交后结果未知 When 返回用户 Then 同一操作补记 unknown 且不返回通用配置错误', async () => {
    const f = fixture({ fault: 'outer-transaction-outcome-unknown' })
    try {
      const candidate = f.service.prepare(7, { hostId: 'host-1', action: 'replace' })
      await expect(f.service.commit(7, {
        hostId: 'host-1', candidateId: candidate.candidateId, confirmationName: 'host-1',
      })).rejects.toThrow('SERVER_OPS_TRUST_RESULT_UNKNOWN')
      expect(f.trusted()).toEqual(newKey)
      expect(f.audit.at(-1)).toMatchObject({ phase: 'result', outcome: 'unknown', errorCode: 'SERVER_OPS_TRUST_RESULT_UNKNOWN' })
      expect(f.audit.at(-1)?.operationId).toBe(f.audit[0]?.operationId)
    } finally { f.service.dispose() }
  })

  test('Given 提交后权威读取失败 When 对账 Then 记录 unknown 且不重试写入', async () => {
    const f = fixture({ fault: 'post-commit-read' })
    try {
      const candidate = f.service.prepare(7, { hostId: 'host-1', action: 'replace' })
      await expect(f.service.commit(7, { hostId: 'host-1', candidateId: candidate.candidateId, confirmationName: 'host-1' }))
        .rejects.toThrow('SERVER_OPS_TRUST_RESULT_UNKNOWN')
      expect(f.audit.at(-1)?.outcome).toBe('unknown')
      expect(f.disconnected).toHaveLength(2)
    } finally { f.service.dispose() }
  })

  test('Given 准入等待期间窗口已关闭 When guard 返回 Then 释放 guard 且无提交', async () => {
    /** 主动控制准入结束，复现窗口先于异步结果销毁的边界。 */
    const guard = Promise.withResolvers<() => void>()
    let released = 0
    const f = fixture({ guard: () => guard.promise })
    try {
      const candidate = f.service.prepare(7, { hostId: 'host-1', action: 'replace' })
      const pending = f.service.commit(7, { hostId: 'host-1', candidateId: candidate.candidateId, confirmationName: 'host-1' })
      f.service.disposeOwner(7)
      guard.resolve(() => { released++ })
      await expect(pending).rejects.toThrow('SERVER_OPS_TRUST_CANDIDATE_EXPIRED')
      expect(released).toBe(1)
      expect(f.audit).toHaveLength(0)
      expect(f.disconnected).toHaveLength(0)
    } finally { f.service.dispose() }
  })

  test('Given 相同候选重复提交 When 两次调用并行 Then 只有一次身份写入', async () => {
    const f = fixture()
    try {
      const candidate = f.service.prepare(7, { hostId: 'host-1', action: 'replace' })
      const input = { hostId: 'host-1', candidateId: candidate.candidateId, confirmationName: 'host-1' }
      const results = await Promise.allSettled([f.service.commit(7, input), f.service.commit(7, input)])
      expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected'])
      expect(f.audit).toHaveLength(2)
      expect(f.disconnected).toHaveLength(2)
    } finally { f.service.dispose() }
  })
})
