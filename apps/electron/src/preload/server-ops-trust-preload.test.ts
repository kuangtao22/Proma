import { describe, expect, test } from 'bun:test'
import { createServerOpsTrustPreload } from './server-ops-trust-preload'

describe('服务器信任 preload 双向校验', () => {
  test('Given 合法输入但主进程输出夹带秘密 When preload 返回 Then 拒绝污染 DTO', async () => {
    const bridge = createServerOpsTrustPreload(async () => ({ hostId: 'host-1', name: '测试', address: 'localhost', port: 22,
      trustedKey: null, observedKey: null, affectedHosts: [{ id: 'host-1', name: '测试' }], secret: 'blocked' }))
    await expect(bridge.getServerOpsTrust({ hostId: 'host-1' })).rejects.toThrow()
  })
  test('Given 合法提交 When IPC 完成 Then 返回严格公开结果且取消返回值必须为空', async () => {
    const bridge = createServerOpsTrustPreload(async () => ({ hostId: 'host-1', action: 'replace', affectedHostIds: ['host-1'] }))
    await expect(bridge.commitServerOpsTrust({ hostId: 'host-1', candidateId: 'candidate-1', confirmationName: '测试' })).resolves.toMatchObject({ action: 'replace' })
    await expect(bridge.cancelServerOpsTrust({ hostId: 'host-1', candidateId: 'candidate-1' })).rejects.toThrow()
  })
})
