import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isServerOpsAuditRecord } from '@proma/shared'
import type { ServerOpsAuditAppendInput, ServerOpsAuditRecord, ServerOpsDataQueryResult } from '@proma/shared'
import { runAuditedServerOpsQuery } from './server-ops-query-audit'
import { ServerOpsRuntimeError } from './server-ops-runtime-client'
import { ServerOpsConfigTransactionError } from './server-ops-config-transaction'
import { ServerOpsAuditStore } from './server-ops-audit-store'

/** 审计测试不含 SQL 正文或真实连接，只提供受控摘要和结果。 */
const summary = { sourceId: 'db-1', database: 'app', tables: ['users'], queryHash: `sha256:${'a'.repeat(64)}` }
const result: ServerOpsDataQueryResult = { queryId: 'query-1', database: 'app', columns: ['id'], rows: [['1']], rowCount: 1, durationMs: 1, truncated: false, warnings: [] }

describe('SQL 查询先审计后执行', () => {
  test('Given 首次审计初始化被其他实例阻挡 When 退出其他实例后重试 Then 保留保护且恢复审计后执行', async () => {
    /** 真实 Store 只写隔离临时目录，原生锁已有专门测试，此处关注查询与初始化衔接。 */
    const configDir = mkdtempSync(join(tmpdir(), 'proma-query-audit-recovery-'))
    const auditPath = join(configDir, 'server-ops', 'audit.json')
    const store = new ServerOpsAuditStore(configDir, { requirePreparedSchema: true, transaction: (callback) => callback() })
    /** 模拟另一实例的生命周期，不读取或改写真实用户 lease。 */
    let otherInstanceActive = true
    let executions = 0
    const options = { summary, actor: { actor: 'user' as const, windowId: 7 }, check: () => {},
      audit: {
        prepareForWrites: () => store.prepareForWrites(async () => {
          if (otherInstanceActive) throw new Error('SERVER_OPS_OTHER_INSTANCE_ACTIVE')
          return () => {}
        }),
        append: store.append.bind(store),
      },
      execute: async () => { executions += 1; return result },
    }
    try {
      await expect(runAuditedServerOpsQuery(options)).rejects.toThrow(/^SERVER_OPS_OTHER_INSTANCE_ACTIVE$/)
      expect(executions).toBe(0)
      expect(existsSync(auditPath)).toBe(false)
      otherInstanceActive = false
      expect(await runAuditedServerOpsQuery(options)).toEqual(result)
      expect(executions).toBe(1)
      /** 审计是完整开始/结果配对，重试成功不会静默绕过记录。 */
      const persisted = JSON.parse(readFileSync(auditPath, 'utf8')) as { version: number; records: ServerOpsAuditRecord[] }
      expect(persisted.version).toBe(5)
      expect(persisted.records.map((record) => record.phase)).toEqual(['start', 'result'])
    } finally {
      /** 只清理本用例刚创建的隔离目录，不触碰用户配置。 */
      rmSync(configDir, { recursive: true, force: true })
    }
  })
  test('Given 审计准备或开始写入被拒绝 When 查询 Then 保留安全原因且绝不执行数据库读取', async () => {
    /** 只暴露可操作的领域分类，不将系统异常或凭据拼进返回值。 */
    const failures = [
      'SERVER_OPS_OTHER_INSTANCE_ACTIVE', 'SERVER_OPS_TRUST_BUSY', 'SERVER_OPS_CONFIG_BUSY',
      'SERVER_OPS_CONFIG_LOCK_UNAVAILABLE', 'SERVER_OPS_CONFIG_OUTCOME_UNKNOWN',
      'SERVER_OPS_AUDIT_READ_FAILED', 'SERVER_OPS_AUDIT_SCHEMA_NOT_PREPARED', 'SERVER_OPS_AUDIT_WRITE_FAILED',
    ]
    for (const phase of ['prepare', 'append'] as const) {
      for (const code of failures) {
        /** 同时检查执行次数和结果审计，防止失败后错误进入运行阶段。 */
        let executions = 0
        const records: ServerOpsAuditAppendInput[] = []
        await expect(runAuditedServerOpsQuery({ summary, actor: { actor: 'user', windowId: 7 }, check: () => {},
          audit: {
            prepareForWrites: async () => { if (phase === 'prepare') throw new Error(code) },
            append: (input) => { records.push(input); throw new Error(code) },
          },
          execute: async () => { executions += 1; return result },
        })).rejects.toThrow(new RegExp(`^${code}$`))
        expect(executions).toBe(0)
        expect(records.map((record) => record.phase)).toEqual(phase === 'prepare' ? [] : ['start'])
      }
    }
  })
  test('Given 配置锁稳定 code 和私有 message When 准备失败 Then 仅透传白名单 code', async () => {
    await expect(runAuditedServerOpsQuery({ summary, actor: { actor: 'user', windowId: 7 }, check: () => {},
      audit: {
        prepareForWrites: async () => { throw new ServerOpsConfigTransactionError('SERVER_OPS_CONFIG_BUSY', 'private path and credentials') },
        append: () => { throw new Error('不应写入审计') },
      },
      execute: async () => { throw new Error('不应执行数据库读取') },
    })).rejects.toThrow(/^SERVER_OPS_CONFIG_BUSY$/)
  })
  test('Given 未知或夹带私有正文的审计异常 When 准备失败 Then 收口为固定错误且不执行', async () => {
    for (const failure of [new Error('private path and credentials'), new Error('SERVER_OPS_OTHER_INSTANCE_ACTIVE private secret'), new Error('SERVER_OPS_UNKNOWN_SECRET'), { code: 'SERVER_OPS_UNKNOWN_SECRET', message: 'SERVER_OPS_OTHER_INSTANCE_ACTIVE' }]) {
      /** 未知错误同样必须在数据库执行前失败关闭。 */
      let executions = 0
      await expect(runAuditedServerOpsQuery({ summary, actor: { actor: 'user', windowId: 7 }, check: () => {},
        audit: { prepareForWrites: async () => { throw failure }, append: () => { throw new Error('不应写入审计') } },
        execute: async () => { executions += 1; return result },
      })).rejects.toThrow(/^SERVER_OPS_AUDIT_START_WRITE_FAILED$/)
      expect(executions).toBe(0)
    }
  })
  test('Given runtime 稳定 code 与私有 message When 查询失败 Then 保留可翻译错误码且不泄露正文', async () => {
    /** 使用真实跨进程错误类型，防止仅测 Error(code) 漏掉生产错误封装。 */
    const records: ServerOpsAuditRecord[] = []
    const operation = runAuditedServerOpsQuery({ summary, actor: { actor: 'user', windowId: 7 }, check: () => {},
      audit: { append: (input) => { const record = { ...input, id: `a-${records.length}`, timestamp: Date.now() }; records.push(record); return record } },
      execute: async (): Promise<ServerOpsDataQueryResult> => { throw new ServerOpsRuntimeError('SERVER_OPS_DATA_QUERY_COLUMN_TOO_LARGE', 'private SQL payload') },
    })
    await expect(operation).rejects.toThrow('SERVER_OPS_DATA_QUERY_COLUMN_TOO_LARGE')
    expect(records.at(-1)?.errorCode).toBe('SERVER_OPS_DATA_QUERY_COLUMN_TOO_LARGE')
    expect(JSON.stringify(records)).not.toContain('private SQL payload')
  })
  test('Given 授权检查与审计正常 When 查询 Then 按开始/执行/结果顺序记录且不含业务值', async () => {
    const records: ServerOpsAuditRecord[] = []
    const output = await runAuditedServerOpsQuery({ summary, actor: { actor: 'agent', sessionId: 's-1' }, check: () => {},
      audit: { append: (input) => { const record = { ...input, id: `a-${records.length}`, timestamp: Date.now() }; expect(isServerOpsAuditRecord(record)).toBe(true); records.push(record); return record } },
      execute: async () => { expect(records).toHaveLength(1); return result },
    })
    expect(output).toEqual(result)
    expect(records.map((record) => record.phase)).toEqual(['start', 'result'])
    expect(records[0]!.operationId).toBe(records[1]!.operationId)
    expect(records[1]!.tables).toEqual(['users'])
    expect(JSON.stringify(records)).not.toMatch(/rows|columns|SELECT/)
  })
  test('Given 开始审计失败 When 请求 Then 不执行；结果审计失败则带稳定警告', async () => {
    let calls = 0
    const execute = async () => { calls += 1; return result }
    const base = { summary, actor: { actor: 'user' as const, windowId: 7 }, check: () => {}, execute }
    await expect(runAuditedServerOpsQuery({ ...base, audit: { append: () => { throw new Error('disk secret') } } })).rejects.toThrow('SERVER_OPS_AUDIT_START_WRITE_FAILED')
    expect(calls).toBe(0)
    const output = await runAuditedServerOpsQuery({ ...base, audit: { append: (input: ServerOpsAuditAppendInput) => {
      if (input.phase === 'result') throw new Error('disk secret')
      return { ...input, id: 'a-1', timestamp: Date.now() }
    } } })
    expect(output.warnings).toContain('SERVER_OPS_AUDIT_RESULT_WRITE_FAILED')
    expect(JSON.stringify(output)).not.toContain('disk secret')
  })
})
