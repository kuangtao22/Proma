import { describe, expect, test } from 'bun:test'
import {
  acknowledgeRuntimeOutput,
  createHostKeyFingerprint,
  createRuntimeOutputState,
  enqueueRuntimeOutput,
  resolveSshAgent,
  takeRuntimeOutput,
} from './server-ops-runtime-core'

/** 构造 SSH wire-format 的 Host Key 测试数据。 */
function createHostKeyBuffer(algorithm: string, payload: string): Buffer {
  /** Host Key 算法名称的 UTF-8 字节。 */
  const algorithmBytes = Buffer.from(algorithm)
  /** SSH string 前置的四字节大端长度。 */
  const length = Buffer.alloc(4)
  length.writeUInt32BE(algorithmBytes.length)
  return Buffer.concat([length, algorithmBytes, Buffer.from(payload)])
}

describe('服务器运维 SSH runtime 核心', () => {
  test('生成带算法的 OpenSSH SHA-256 Host Key 指纹', () => {
    /** 固定的 wire-format Host Key。 */
    const key = createHostKeyBuffer('ssh-ed25519', 'public-key-canary')
    expect(createHostKeyFingerprint(key)).toEqual({
      algorithm: 'ssh-ed25519',
      fingerprint: 'SHA256:8ZplK++wLzHOhnBsLeWpPWbDySOJPMQA5qhgGPC50O4',
    })
  })

  test('SSH Agent 在 Unix 使用 socket，在 Windows 支持 pipe 与 Pageant', () => {
    expect(resolveSshAgent('darwin', { SSH_AUTH_SOCK: '/tmp/agent.sock' })).toBe('/tmp/agent.sock')
    expect(resolveSshAgent('win32', { SSH_AUTH_SOCK: '\\\\.\\pipe\\openssh-ssh-agent' })).toBe('\\\\.\\pipe\\openssh-ssh-agent')
    expect(resolveSshAgent('win32', {})).toBe('pageant')
    expect(() => resolveSshAgent('linux', {})).toThrow('SERVER_OPS_SSH_AGENT_UNAVAILABLE')
  })

  test('ACK 前只保留一个在途输出并对超限数据给出截断标记', () => {
    /** 使用 5 字符上限验证背压的输出状态。 */
    const state = createRuntimeOutputState(5)
    enqueueRuntimeOutput(state, 'abc')
    expect(takeRuntimeOutput(state, 'host-1', 'connection-1')).toMatchObject({ sequence: 1, data: 'abc' })

    enqueueRuntimeOutput(state, 'defghijk')
    expect(takeRuntimeOutput(state, 'host-1', 'connection-1')).toBeUndefined()
    expect(acknowledgeRuntimeOutput(state, 1)).toBe(true)
    expect(takeRuntimeOutput(state, 'host-1', 'connection-1')).toMatchObject({
      sequence: 2,
      data: expect.stringContaining('已丢弃 3 个字符'),
    })
  })
})
