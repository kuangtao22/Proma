import { describe, expect, test } from 'bun:test'
import type { ServerOpsDataProbeResult, ServerOpsDataSource, ServerOpsDataSourceUpsertInput } from '@proma/shared'
import {
  createServerOpsLocalSqliteImportInput,
  importServerOpsLocalSqlite,
  resolveServerOpsLocalSqliteFileSelection,
} from './server-ops-local-sqlite-controller'

/** 创建本地 SQLite 数据源样本。 */
function createLocalSource(overrides: Partial<ServerOpsDataSource> = {}): ServerOpsDataSource {
  return {
    id: 'source-local', projectId: 'project-a', transport: 'direct', engine: 'sqlite', label: '本地业务库',
    filePath: '/Users/demo/data/app.sqlite3', database: 'main', tlsMode: 'disabled', hasPassword: false,
    localFileId: '1:2:3', createdAt: 1, updatedAt: 1, ...overrides,
  }
}

/** 成功的 SQLite 探测结果。 */
const availableProbe: ServerOpsDataProbeResult = {
  engine: 'sqlite', capability: 'available', serverVersion: '3.46.0', latencyMs: 4, warnings: [],
}

describe('本地 SQLite 导入控制器', () => {
  test('Given macOS 或 Windows 文件路径 When 创建导入输入 Then 使用文件名作为名称并保持原始绝对路径', () => {
    expect(createServerOpsLocalSqliteImportInput('/Users/demo/data/app.sqlite3')).toEqual({
      transport: 'direct', engine: 'sqlite', label: 'app.sqlite3', filePath: '/Users/demo/data/app.sqlite3', database: 'main', tlsMode: 'disabled',
    })
    expect(createServerOpsLocalSqliteImportInput('C:\\data\\audit.db')).toEqual({
      transport: 'direct', engine: 'sqlite', label: 'audit.db', filePath: 'C:\\data\\audit.db', database: 'main', tlsMode: 'disabled',
    })
    const longPath = `/tmp/${'数'.repeat(70)}.sqlite3`
    expect(createServerOpsLocalSqliteImportInput(longPath).label).toBe('数'.repeat(64))
  })

  test('Given 拖入零个或多个文件 When 解析选择 Then 返回明确错误且不猜测目标文件', () => {
    expect(resolveServerOpsLocalSqliteFileSelection([])).toEqual({ filePath: null, error: null })
    expect(resolveServerOpsLocalSqliteFileSelection(['/tmp/a.db', '/tmp/b.db'])).toEqual({ filePath: null, error: '一次只能打开一个 SQLite 文件' })
    expect(resolveServerOpsLocalSqliteFileSelection(['/tmp/a.db'])).toEqual({ filePath: '/tmp/a.db', error: null })
  })

  test('Given 当前项目已有相同本地文件连接 When 再次拖入 Then 直接打开现有连接且不探测或保存', async () => {
    const calls: string[] = []
    const existing = createLocalSource()
    const result = await importServerOpsLocalSqlite({
      projectId: 'project-a', filePath: existing.filePath!, sources: [existing],
      probe: async () => { calls.push('probe'); return availableProbe },
      upsert: async () => { calls.push('upsert'); return createLocalSource({ id: 'new' }) },
      isProjectCurrent: () => true,
    })
    expect(calls).toEqual([])
    expect(result).toEqual({ source: existing, created: false, shouldNavigate: true })
  })

  test('Given 文件探测失败 When 导入 Then 不写入连接配置', async () => {
    let submitted: ServerOpsDataSourceUpsertInput | null = null
    await expect(importServerOpsLocalSqlite({
      projectId: 'project-a', filePath: '/tmp/broken.db', sources: [],
      probe: async () => ({ ...availableProbe, capability: 'unsupported', warnings: ['不是 SQLite 数据库'] }),
      upsert: async (input) => { submitted = input; return createLocalSource() },
      isProjectCurrent: () => true,
    })).rejects.toThrow('不是 SQLite 数据库')
    expect(submitted).toBeNull()
  })

  test('Given 导入期间切换项目 When 保存迟到返回 Then 保留创建结果但不抢占当前导航', async () => {
    let currentProjectId = 'project-a'
    const result = await importServerOpsLocalSqlite({
      projectId: 'project-a', filePath: '/tmp/new.db', sources: [],
      probe: async () => { currentProjectId = 'project-b'; return availableProbe },
      upsert: async (input) => createLocalSource({ id: 'new', projectId: input.projectId }),
      isProjectCurrent: (projectId) => currentProjectId === projectId,
    })
    expect(result.created).toBe(true)
    expect(result.shouldNavigate).toBe(false)
  })
})
