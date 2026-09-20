import { describe, expect, test } from 'bun:test'
import {
  parseServerOpsConnectionMoveInput,
  parseServerOpsConnectionMoveResult,
} from './server-ops-connection-move'

describe('运维连接跨项目移动合同', () => {
  test('Given SSH 或数据连接 When 解析移动输入 Then 只保留严格字段', () => {
    expect(parseServerOpsConnectionMoveInput({
      kind: 'ssh', id: 'host-1', fromProjectId: 'project-1', targetProjectId: 'project-2',
    })).toEqual({ kind: 'ssh', id: 'host-1', fromProjectId: 'project-1', targetProjectId: 'project-2' })
    expect(parseServerOpsConnectionMoveInput({
      kind: 'data', id: 'source-1', fromProjectId: 'project-1', targetProjectId: 'project-2',
    }).kind).toBe('data')
  })

  test('Given 未知字段或非法身份 When 解析移动输入 Then fail closed', () => {
    expect(() => parseServerOpsConnectionMoveInput({
      kind: 'ssh', id: 'host-1', fromProjectId: 'project-1', targetProjectId: 'project-2', extra: true,
    })).toThrow('SERVER_OPS_CONNECTION_MOVE_INPUT_INVALID')
    expect(() => parseServerOpsConnectionMoveInput({
      kind: 'mysql', id: 'source-1', fromProjectId: 'project-1', targetProjectId: 'project-2',
    })).toThrow('SERVER_OPS_CONNECTION_MOVE_INPUT_INVALID')
    expect(() => parseServerOpsConnectionMoveInput({
      kind: 'data', id: 'bad id', fromProjectId: 'project-1', targetProjectId: 'project-2',
    })).toThrow('SERVER_OPS_CONNECTION_MOVE_INPUT_INVALID')
  })

  test('Given 主机移动回执 When 解析 Then 严格校验时间与字段', () => {
    const host = {
      id: 'host-1', projectId: 'project-2', name: '生产 API', address: '10.0.0.8', port: 22,
      username: 'deploy', authMethod: 'ssh-agent' as const, tags: ['生产'], createdAt: 1, updatedAt: 2,
    }
    expect(parseServerOpsConnectionMoveResult({ kind: 'ssh', host })).toEqual({ kind: 'ssh', host })
    expect(() => parseServerOpsConnectionMoveResult({ kind: 'ssh', host: { ...host, updatedAt: -1 } }))
      .toThrow('SERVER_OPS_CONNECTION_MOVE_RESULT_INVALID')
    expect(() => parseServerOpsConnectionMoveResult({ kind: 'ssh', host, extra: true }))
      .toThrow('SERVER_OPS_CONNECTION_MOVE_RESULT_INVALID')
  })

  test('Given 数据源移动回执 When 包含内部凭据引用 Then 严格拒绝', () => {
    const source = {
      id: 'source-1', projectId: 'project-2', transport: 'direct' as const, engine: 'redis' as const,
      label: '缓存', address: '127.0.0.1', port: 6379, database: '0', tlsMode: 'disabled' as const,
      hasPassword: true, createdAt: 1, updatedAt: 2,
    }
    expect(parseServerOpsConnectionMoveResult({ kind: 'data', source })).toEqual({ kind: 'data', source })
    expect(() => parseServerOpsConnectionMoveResult({
      kind: 'data', source: { ...source, credentialRef: 'credential-1' },
    })).toThrow('SERVER_OPS_CONNECTION_MOVE_RESULT_INVALID')
  })
})
