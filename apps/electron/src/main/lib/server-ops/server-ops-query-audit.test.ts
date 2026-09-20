import { describe, expect, test } from 'bun:test'
import { isServerOpsAuditRecord } from '@proma/shared'
import type { ServerOpsAuditAppendInput, ServerOpsAuditRecord, ServerOpsDataQueryResult } from '@proma/shared'
import { runAuditedServerOpsQuery } from './server-ops-query-audit'
import { ServerOpsRuntimeError } from './server-ops-runtime-client'

/** 审计测试不含 SQL 正文或真实连接，只提供受控摘要和结果。 */
const summary = { sourceId: 'db-1', database: 'app', tables: ['users'], queryHash: `sha256:${'a'.repeat(64)}` }
const result: ServerOpsDataQueryResult = { queryId: 'query-1', database: 'app', columns: ['id'], rows: [['1']], rowCount: 1, durationMs: 1, truncated: false, warnings: [] }

describe('SQL 查询先审计后执行', () => {
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
