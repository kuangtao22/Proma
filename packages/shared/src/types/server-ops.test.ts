import { describe, expect, test } from 'bun:test'
import {
  SERVER_OPS_IPC_CHANNELS,
  isServerOpsHostList,
  parseServerOpsConnectInput,
  parseServerOpsHostInput,
} from './server-ops'

describe('服务器运维共享合同', () => {
  test('规范化合法 Linux SSH 主机输入', () => {
    expect(parseServerOpsHostInput({
      name: '  生产 API  ',
      address: '  10.0.0.8  ',
      port: 22,
      username: '  deploy  ',
      authMethod: 'ssh-agent',
      tags: [' 生产 ', 'api', '生产'],
    })).toEqual({
      name: '生产 API',
      address: '10.0.0.8',
      port: 22,
      username: 'deploy',
      authMethod: 'ssh-agent',
      tags: ['生产', 'api'],
    })
  })

  test('公开主机合同支持密码认证且不接收私钥路径', () => {
    expect(parseServerOpsHostInput({
      name: '数据库',
      address: 'db.internal',
      port: 2222,
      username: 'ops',
      authMethod: 'private-key',
      tags: [],
    })).toMatchObject({
      authMethod: 'private-key',
    })

    expect(() => parseServerOpsHostInput({
      name: '数据库',
      address: 'db.internal',
      port: 22,
      username: 'ops',
      authMethod: 'private-key',
      keyPath: '/Users/demo/.ssh/id_ed25519',
      tags: [],
    })).toThrow('SERVER_OPS_HOST_INPUT_INVALID')

    expect(parseServerOpsHostInput({
      name: '密码主机',
      address: '10.0.0.9',
      port: 22,
      username: 'root',
      authMethod: 'password',
      tags: [],
    }).authMethod).toBe('password')
  })

  test('连接请求严格解析一次性凭据和终端尺寸', () => {
    expect(parseServerOpsConnectInput({
      hostId: 'host-1',
      cols: 120,
      rows: 36,
      credential: {
        kind: 'password',
        password: 'secret-canary',
        remember: false,
      },
    })).toEqual({
      hostId: 'host-1',
      cols: 120,
      rows: 36,
      credential: {
        kind: 'password',
        password: 'secret-canary',
        remember: false,
      },
    })

    expect(() => parseServerOpsConnectInput({
      hostId: 'host-1',
      cols: 0,
      rows: 36,
    })).toThrow('SERVER_OPS_TERMINAL_SIZE_INVALID')
    expect(() => parseServerOpsConnectInput({
      hostId: 'host-1',
      cols: 80,
      rows: 24,
      credential: { kind: 'password', password: 'secret', remember: false, leak: true },
    })).toThrow('SERVER_OPS_CREDENTIAL_INPUT_INVALID')
  })

  test('拒绝越界端口、未知字段和密码字段', () => {
    const baseInput = {
      name: '生产 API',
      address: '10.0.0.8',
      username: 'deploy',
      authMethod: 'ssh-agent',
      tags: [],
    } as const

    expect(() => parseServerOpsHostInput({ ...baseInput, port: 0 })).toThrow('SERVER_OPS_HOST_PORT_INVALID')
    expect(() => parseServerOpsHostInput({ ...baseInput, port: 65_536 })).toThrow('SERVER_OPS_HOST_PORT_INVALID')
    expect(() => parseServerOpsHostInput({ ...baseInput, port: 22, password: 'secret' })).toThrow('SERVER_OPS_HOST_INPUT_INVALID')
  })

  test('主机列表校验要求完整持久化字段且不允许凭据', () => {
    const host = {
      id: 'host-1',
      name: '生产 API',
      address: '10.0.0.8',
      port: 22,
      username: 'deploy',
      authMethod: 'ssh-agent',
      tags: ['生产'],
      createdAt: 1_000,
      updatedAt: 2_000,
    }

    expect(isServerOpsHostList([host])).toBe(true)
    expect(isServerOpsHostList([{ ...host, password: 'secret' }])).toBe(false)
    expect(isServerOpsHostList([{ ...host, updatedAt: -1 }])).toBe(false)
  })

  test('IPC 通道保持在独立 server-ops 命名空间', () => {
    expect(SERVER_OPS_IPC_CHANNELS).toEqual({
      LIST_HOSTS: 'server-ops:list-hosts',
      UPSERT_HOST: 'server-ops:upsert-host',
      DELETE_HOST: 'server-ops:delete-host',
      CONNECT: 'server-ops:connect',
      CONFIRM_HOST_KEY: 'server-ops:confirm-host-key',
      DISCONNECT: 'server-ops:disconnect',
      WRITE_TERMINAL: 'server-ops:write-terminal',
      RESIZE_TERMINAL: 'server-ops:resize-terminal',
      ACK_TERMINAL_OUTPUT: 'server-ops:ack-terminal-output',
      TERMINAL_SNAPSHOT: 'server-ops:terminal-snapshot',
      CONNECTION_STATE: 'server-ops:connection-state',
      TERMINAL_OUTPUT: 'server-ops:terminal-output',
      TERMINAL_EXIT: 'server-ops:terminal-exit',
    })
  })
})
