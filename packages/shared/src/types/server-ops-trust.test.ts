import { describe, expect, test } from 'bun:test'
import { parseServerOpsTrustInput, parseServerOpsTrustPrepareInput, parseServerOpsTrustCommitInput, parseServerOpsTrustSnapshot, parseServerOpsTrustCandidate } from './server-ops-trust'

/** 公开信任视图不能包含凭据、连接代次或调用者自报的 owner。 */
const snapshot = {
  hostId: 'host-1', name: '测试主机', address: 'localhost', port: 22,
  trustedKey: { algorithm: 'ssh-ed25519', fingerprint: 'SHA256:first' },
  observedKey: { algorithm: 'ssh-ed25519', fingerprint: 'SHA256:second' },
  affectedHosts: [{ id: 'host-1', name: '测试主机' }],
}

describe('服务器信任管理公开合同', () => {
  test('Given 主窗口信任请求 When 严格解析 Then 只接受公开意图', () => {
    expect(parseServerOpsTrustInput({ hostId: 'host-1' })).toEqual({ hostId: 'host-1' })
    expect(parseServerOpsTrustPrepareInput({ hostId: 'host-1', action: 'replace' })).toEqual({ hostId: 'host-1', action: 'replace' })
    expect(parseServerOpsTrustCommitInput({ hostId: 'host-1', candidateId: 'candidate-1', confirmationName: '测试主机' })).toEqual({ hostId: 'host-1', candidateId: 'candidate-1', confirmationName: '测试主机' })
    for (const extra of [{ ownerId: 1 }, { fingerprint: 'SHA256:forged' }, { action: 'revoke' }]) {
      expect(() => parseServerOpsTrustCommitInput({ hostId: 'host-1', candidateId: 'candidate-1', confirmationName: '测试主机', ...extra })).toThrow()
    }
    expect(() => parseServerOpsTrustPrepareInput({ hostId: '../bad', action: 'replace' })).toThrow()
    expect(() => parseServerOpsTrustPrepareInput({ hostId: 'host-1', action: 'trust' })).toThrow()
  })

  test('Given 候选视图 When 解析 Then 深复制并拒绝内部字段和无期限身份', () => {
    const parsed = parseServerOpsTrustSnapshot(snapshot)
    parsed.affectedHosts[0]!.name = '不能污染原记录'
    expect(snapshot.affectedHosts[0]!.name).toBe('测试主机')
    expect(() => parseServerOpsTrustSnapshot({ ...snapshot, connectionId: 'private' })).toThrow()
    expect(() => parseServerOpsTrustSnapshot({ ...snapshot, trustedKey: { ...snapshot.trustedKey, password: 'secret' } })).toThrow()
    expect(parseServerOpsTrustCandidate({ ...snapshot, candidateId: 'candidate-1', action: 'replace', expiresAt: 300_000 })).toMatchObject({ candidateId: 'candidate-1' })
    expect(() => parseServerOpsTrustCandidate({ ...snapshot, candidateId: 'candidate-1', action: 'replace', expiresAt: Infinity })).toThrow()
    expect(() => parseServerOpsTrustCandidate({ ...snapshot, candidateId: 'candidate-1', action: 'replace', expiresAt: 1, observedKey: null })).toThrow()
  })
})
