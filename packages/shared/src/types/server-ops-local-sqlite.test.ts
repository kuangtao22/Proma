import { describe, expect, test } from 'bun:test'
import { parseServerOpsDataSource, parseServerOpsDataSourceProbeInput, parseServerOpsDataSourceUpsertInput } from './server-ops-data'

/** 本地数据库写入草稿；文件身份只能由主进程补充。 */
const draft = { transport: 'direct', engine: 'sqlite', filePath: '/tmp/业务.db', tlsMode: 'disabled' } as const

describe('本地 SQLite 数据源合同', () => {
  test('Given 本地 SQLite When 新建或测试 Then 无需 SSH 且固定 main', () => {
    expect(parseServerOpsDataSourceUpsertInput({ ...draft, label: '业务库' })).toEqual({ ...draft, label: '业务库', database: 'main' })
    expect(parseServerOpsDataSourceProbeInput({ draft })).toEqual({ draft: { ...draft, database: 'main' } })
  })

  test('Given Windows 盘符路径 When 测试本地文件 Then 接受本地绝对路径而远端拒绝', () => {
    for (const filePath of ['C:\\资料\\业务.sqlite3', 'D:/data/app.db']) {
      expect(parseServerOpsDataSourceProbeInput({ draft: { ...draft, filePath } })).toHaveProperty('draft.filePath', filePath)
      expect(() => parseServerOpsDataSourceProbeInput({ draft: { ...draft, transport: 'ssh', hostId: 'host-1', filePath } })).toThrow()
    }
  })

  test('Given 本地主进程文件身份 When 解析公开配置 Then 保留身份且拒绝缺失或伪造输入', () => {
    /** 已验证文件的公开元数据。 */
    const source = { ...draft, localFileId: '1:42:1700000000000000000', id: 'local-sqlite', label: '业务库', hasPassword: false, createdAt: 1, updatedAt: 1 }
    expect(parseServerOpsDataSource(source)).toEqual({ ...source, database: 'main' })
    expect(() => parseServerOpsDataSource({ ...source, localFileId: undefined })).toThrow()
    expect(() => parseServerOpsDataSourceUpsertInput({ ...draft, label: '业务库', localFileId: source.localFileId })).toThrow()
    expect(() => parseServerOpsDataSource({ ...source, transport: 'ssh', hostId: 'host-1' })).toThrow()
  })

  test('Given 不安全路径或网络字段 When 测试本地文件 Then 拒绝', () => {
    for (const filePath of ['app.db', ':memory:', 'file:/tmp/a.db', 'C:app.db', '\\\\server\\share\\app.db', '//server/share/app.db', '/tmp/a\n.db']) {
      expect(() => parseServerOpsDataSourceProbeInput({ draft: { ...draft, filePath } })).toThrow()
    }
    for (const extra of [{ hostId: 'host-1' }, { address: 'localhost' }, { port: 3306 }, { password: 'x' }, { database: 'other' }]) {
      expect(() => parseServerOpsDataSourceProbeInput({ draft: { ...draft, ...extra } })).toThrow()
    }
  })
})
