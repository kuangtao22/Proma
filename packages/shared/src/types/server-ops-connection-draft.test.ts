import { describe, expect, test } from 'bun:test'
import { parseServerOpsConnectionDraftInput } from './server-ops-connection-draft'

describe('Agent 连接草稿输入', () => {
  test('Given 常规 SSH、数据库和 SQLite 建议 When 解析 Then 只保留公开连接字段', () => {
    expect(parseServerOpsConnectionDraftInput({ kind: 'ssh', name: '测试机', address: '10.0.0.8', port: 22, username: 'deploy' })).toEqual({ kind: 'ssh', name: '测试机', address: '10.0.0.8', port: 22, username: 'deploy' })
    expect(parseServerOpsConnectionDraftInput({ kind: 'mysql', label: '业务库', address: 'db.internal', port: 3306, transport: 'direct' })).toEqual({ kind: 'mysql', label: '业务库', address: 'db.internal', port: 3306, transport: 'direct' })
    expect(parseServerOpsConnectionDraftInput({ kind: 'sqlite', label: '审计文件', transport: 'ssh', filePath: '/srv/app/a.db' })).toEqual({ kind: 'sqlite', label: '审计文件', transport: 'ssh', filePath: '/srv/app/a.db' })
  })

  test('Given 秘密、URL 或未受支持写库字段 When 解析 Then 全部拒绝', () => {
    const baseline = { kind: 'mysql', label: '业务库', address: 'db.internal', port: 3306, transport: 'direct' }
    for (const input of [
      { ...baseline, password: 'secret' },
      { ...baseline, address: 'mysql://user:secret@host/db' },
      { ...baseline, address: 'user:secret@host' },
      { ...baseline, address: 'host/a' },
      { ...baseline, database: 'production' },
      { ...baseline, tlsMode: { toString: () => 'verify' } },
      { ...baseline, projectId: 'project-one' },
      { ...baseline, keyPath: '/home/user/.ssh/id_rsa' },
      { kind: 'sqlite', label: '库', transport: 'ssh', filePath: '/srv/a/..' },
      { kind: 'ssh', name: '服务器', address: 'host', port: 22, username: 'admin', privateKey: 'secret' },
    ]) expect(() => parseServerOpsConnectionDraftInput(input)).toThrow('SERVER_OPS_CONNECTION_DRAFT_INVALID')
    expect(() => parseServerOpsConnectionDraftInput({ kind: 'redis', label: '缓存', address: 'cache.internal', port: 6379, transport: 'direct', database: 1 })).toThrow('SERVER_OPS_CONNECTION_DRAFT_INVALID')
  })
})
