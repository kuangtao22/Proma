import { describe, expect, test } from 'bun:test'
import {
  parseServerOpsRuntimeMessage,
  parseServerOpsRuntimeRequest,
} from './server-ops-runtime-protocol'

/** 构造完整且可通过协议边界的连接请求。 */
function createConnectRequest(): unknown {
  return {
    type: 'server-ops.connect',
    input: {
      requestId: 'request-1',
      hostId: 'host-1',
      connectionId: 'connection-1',
      address: '10.0.0.8',
      port: 22,
      username: 'deploy',
      expectedHostKey: { algorithm: 'ssh-ed25519', fingerprint: 'SHA256:test' },
      authentication: { kind: 'private-key', privateKey: new Uint8Array([1, 2, 3]), passphrase: 'secret' },
      cols: 80,
      rows: 24,
    },
  }
}

describe('Server Ops utility runtime 请求协议', () => {
  test('严格重建所有合法请求分支', () => {
    const requests: unknown[] = [
      createConnectRequest(),
      { type: 'server-ops.exec', input: { requestId: 'request-2', hostId: 'host-1', connectionId: 'connection-1', command: 'uname -a', timeoutMs: 1_000 } },
      { type: 'server-ops.disconnect', hostId: 'host-1', connectionId: 'connection-1' },
      { type: 'server-ops.terminal-input', hostId: 'host-1', connectionId: 'connection-1', data: 'pwd\n' },
      { type: 'server-ops.terminal-resize', hostId: 'host-1', connectionId: 'connection-1', cols: 80, rows: 24 },
      { type: 'server-ops.terminal-ack', input: { hostId: 'host-1', connectionId: 'connection-1', sequence: 1 } },
      { type: 'server-ops.log-start', input: { streamId: 'stream-1', hostId: 'host-1', connectionId: 'connection-1', command: 'journalctl -f' } },
      { type: 'server-ops.log-stop', streamId: 'stream-1', hostId: 'host-1', connectionId: 'connection-1' },
      { type: 'server-ops.log-ack', streamId: 'stream-1', hostId: 'host-1', connectionId: 'connection-1', sequence: 0 },
      { type: 'server-ops.shutdown' },
    ]

    for (const request of requests) {
      expect(parseServerOpsRuntimeRequest(request)).toEqual(request as ReturnType<typeof parseServerOpsRuntimeRequest>)
    }
  })

  test('拒绝未知字段、非规范身份与越界请求数据', () => {
    const invalidRequests: unknown[] = [
      { type: 'server-ops.shutdown', extra: true },
      { type: 'server-ops.disconnect', hostId: '../host', connectionId: 'connection-1' },
      { type: 'server-ops.terminal-resize', hostId: 'host-1', connectionId: 'connection-1', cols: 0, rows: 24 },
      { type: 'server-ops.terminal-input', hostId: 'host-1', connectionId: 'connection-1', data: 'x'.repeat(65_537) },
      { type: 'server-ops.exec', input: { requestId: 'request-2', hostId: 'host-1', connectionId: 'connection-1', command: '', timeoutMs: 1_000 } },
      { type: 'server-ops.exec', input: { requestId: 'request-2', hostId: 'host-1', connectionId: 'connection-1', command: 'x'.repeat(8_193), timeoutMs: 1_000 } },
      { type: 'server-ops.log-start', input: { streamId: 'stream-1', hostId: 'host-1', connectionId: 'connection-1', command: '' } },
      { type: 'server-ops.log-start', input: { streamId: 'stream-1', hostId: 'host-1', connectionId: 'connection-1', command: 'x'.repeat(8_193) } },
      { type: 'server-ops.log-start', input: { streamId: 'stream-1', hostId: 'host-1', connectionId: 'connection-1', command: 'echo\0secret' } },
      { type: 'server-ops.log-start', input: { streamId: '../stream', hostId: 'host-1', connectionId: 'connection-1', command: 'journalctl -f' } },
      { type: 'server-ops.log-stop', streamId: 'stream-1', hostId: 'host-1', connectionId: 'connection-1', extra: true },
      { type: 'server-ops.log-ack', streamId: 'stream-1', hostId: 'host-1', connectionId: 'connection-1', sequence: -1 },
      { type: 'server-ops.log-ack', streamId: 'stream-1', hostId: 'host-1', connectionId: 'connection-1', sequence: Number.MAX_SAFE_INTEGER + 1 },
      { type: 'server-ops.exec', input: { requestId: 'request-2', hostId: 'host-1', connectionId: 'connection-1', command: 'pwd', timeoutMs: 999 } },
      { type: 'server-ops.exec', input: { requestId: 'request-2', hostId: 'host-1', connectionId: 'connection-1', command: 'pwd', timeoutMs: 120_001 } },
      { ...createConnectRequest() as object, extra: true },
      { type: 'server-ops.connect', input: { ...(createConnectRequest() as { input: object }).input, address: 'bad host' } },
      { type: 'server-ops.connect', input: { ...(createConnectRequest() as { input: object }).input, port: 65_536 } },
      { type: 'server-ops.connect', input: { ...(createConnectRequest() as { input: object }).input, username: '' } },
      { type: 'server-ops.connect', input: { ...(createConnectRequest() as { input: object }).input, authentication: { kind: 'private-key', privateKey: [1, 2, 3] } } },
    ]

    for (const request of invalidRequests) {
      expect(() => parseServerOpsRuntimeRequest(request)).toThrow('SERVER_OPS_RUNTIME_REQUEST_INVALID')
    }
  })
})

describe('Server Ops utility runtime 返回协议', () => {
  test('严格重建所有合法消息分支', () => {
    const messages: unknown[] = [
      { type: 'server-ops.ready', pid: 100 },
      { type: 'server-ops.connect-result', requestId: 'request-1', hostId: 'host-1', connectionId: 'connection-1', result: { status: 'connected', hostKey: { algorithm: 'ssh-ed25519', fingerprint: 'SHA256:test' } } },
      { type: 'server-ops.connect-result', requestId: 'request-1', hostId: 'host-1', connectionId: 'connection-1', result: { status: 'host-key-rejected', observedHostKey: { algorithm: 'ssh-ed25519', fingerprint: 'SHA256:test' } } },
      { type: 'server-ops.exec-result', requestId: 'request-2', hostId: 'host-1', connectionId: 'connection-1', result: { stdout: 'Linux\n', stderr: '', exitCode: 0, truncated: false } },
      { type: 'server-ops.error', requestId: 'request-2', hostId: 'host-1', connectionId: 'connection-1', code: 'SERVER_OPS_EXEC_FAILED', message: '远程命令执行失败' },
      { type: 'server-ops.error', hostId: 'host-1', connectionId: 'connection-1', code: 'SERVER_OPS_CONNECTION_CLOSED', message: 'SSH 连接已关闭' },
      { type: 'server-ops.terminal-output', event: { hostId: 'host-1', connectionId: 'connection-1', sequence: 1, data: 'hello' } },
      { type: 'server-ops.terminal-exit', event: { hostId: 'host-1', connectionId: 'connection-1', exitCode: 0, message: '远程终端已退出' } },
      { type: 'server-ops.log-started', streamId: 'stream-1', hostId: 'host-1', connectionId: 'connection-1' },
      { type: 'server-ops.log-chunk', streamId: 'stream-1', hostId: 'host-1', connectionId: 'connection-1', sequence: 0, data: '服务\n' },
      { type: 'server-ops.log-exit', streamId: 'stream-1', hostId: 'host-1', connectionId: 'connection-1', reason: 'stopped' },
      { type: 'server-ops.log-exit', streamId: 'stream-2', hostId: 'host-1', connectionId: 'connection-1', reason: 'error', errorCode: 'SERVER_OPS_LOG_STREAM_FAILED' },
      { type: 'server-ops.stopped' },
    ]

    for (const message of messages) {
      expect(parseServerOpsRuntimeMessage(message)).toEqual(message as ReturnType<typeof parseServerOpsRuntimeMessage>)
    }
  })

  test('拒绝未知字段、非法 union 与越界输出', () => {
    const invalidMessages: unknown[] = [
      { type: 'server-ops.ready', pid: 100, extra: true },
      { type: 'server-ops.connect-result', requestId: 'request-1', hostId: 'host-1', connectionId: 'connection-1', result: { status: 'connected', observedHostKey: { algorithm: 'ssh-ed25519', fingerprint: 'SHA256:test' } } },
      { type: 'server-ops.exec-result', requestId: 'request-2', hostId: 'host-1', connectionId: 'connection-1', result: { stdout: '', stderr: '', truncated: false, secret: 'leak' } },
      { type: 'server-ops.exec-result', requestId: 'request-2', hostId: 'host-1', connectionId: 'connection-1', result: { stdout: 'x'.repeat(1_048_577), stderr: '', truncated: true } },
      { type: 'server-ops.exec-result', requestId: 'request-2', hostId: 'host-1', connectionId: 'connection-1', result: { stdout: '界'.repeat(349_526), stderr: '', truncated: true } },
      { type: 'server-ops.error', requestId: '', hostId: 'host-1', connectionId: 'connection-1', code: 'SERVER_OPS_EXEC_FAILED', message: '失败' },
      { type: 'server-ops.terminal-output', event: { hostId: 'host-1', connectionId: 'connection-1', sequence: 0, data: 'hello' } },
      { type: 'server-ops.terminal-output', event: { hostId: 'host-1', connectionId: 'connection-1', sequence: 1, data: 'x'.repeat(1_048_833) } },
      { type: 'server-ops.terminal-exit', event: { hostId: 'host-1', connectionId: 'connection-1', signal: {}, message: '退出' } },
      { type: 'server-ops.log-started', streamId: 'stream-1', hostId: 'host-1', connectionId: 'connection-1', extra: true },
      { type: 'server-ops.log-chunk', streamId: 'stream-1', hostId: 'host-1', connectionId: 'connection-1', sequence: -1, data: '日志' },
      { type: 'server-ops.log-chunk', streamId: 'stream-1', hostId: 'host-1', connectionId: 'connection-1', sequence: Number.MAX_SAFE_INTEGER + 1, data: '日志' },
      { type: 'server-ops.log-chunk', streamId: 'stream-1', hostId: 'host-1', connectionId: 'connection-1', sequence: 0, data: '你'.repeat(10_923) },
      { type: 'server-ops.log-exit', streamId: 'stream-1', hostId: 'host-1', connectionId: 'connection-1', reason: 'stopped', errorCode: 'SERVER_OPS_LOG_STREAM_FAILED' },
      { type: 'server-ops.log-exit', streamId: 'stream-1', hostId: 'host-1', connectionId: 'connection-1', reason: 'unknown' },
    ]

    for (const message of invalidMessages) {
      expect(() => parseServerOpsRuntimeMessage(message)).toThrow('SERVER_OPS_RUNTIME_MESSAGE_INVALID')
    }
  })
})
