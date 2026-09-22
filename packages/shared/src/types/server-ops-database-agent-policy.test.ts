import { describe, expect, test } from 'bun:test'
import {
  parseServerOpsDatabaseAgentPolicy,
  parseServerOpsDatabaseAgentPolicyUpdate,
} from './server-ops-database-agent-policy'

describe('数据库 Agent 禁用表合同', () => {
  test('Given 有效禁用名单 When 解析更新 Then 复制并保留连接与库的精确身份', () => {
    const input = { expectedRevision: 2, exclusions: [{ sourceId: 'source-1', database: 'App', excludedTables: ['Orders'] }] }
    const parsed = parseServerOpsDatabaseAgentPolicyUpdate(input)
    input.exclusions[0]!.excludedTables[0] = 'changed'
    expect(parsed).toEqual({ expectedRevision: 2, exclusions: [{ sourceId: 'source-1', database: 'App', excludedTables: ['Orders'] }] })
    expect(parseServerOpsDatabaseAgentPolicy({ revision: 3, exclusions: parsed.exclusions }).revision).toBe(3)
  })

  test('Given 非法或混淆范围 When 解析 Then 拒绝未知字段、重复表、重复库和过大输入', () => {
    const valid = { expectedRevision: 0, exclusions: [{ sourceId: 'source-1', database: 'main', excludedTables: ['Secret'] }] }
    expect(() => parseServerOpsDatabaseAgentPolicyUpdate({ ...valid, granted: true })).toThrow()
    expect(() => parseServerOpsDatabaseAgentPolicyUpdate({ ...valid, exclusions: [{ sourceId: '../source', database: 'main', excludedTables: ['Secret'] }] })).toThrow()
    expect(() => parseServerOpsDatabaseAgentPolicyUpdate({ ...valid, exclusions: [{ sourceId: 'source-1', database: 'main', excludedTables: ['Secret', 'secret'] }] })).toThrow()
    expect(() => parseServerOpsDatabaseAgentPolicyUpdate({ ...valid, exclusions: [valid.exclusions[0], valid.exclusions[0]] })).toThrow()
    expect(() => parseServerOpsDatabaseAgentPolicyUpdate({ ...valid, exclusions: [{ ...valid.exclusions[0], excludedTables: ['\n'] }] })).toThrow()
    expect(() => parseServerOpsDatabaseAgentPolicyUpdate({ ...valid, exclusions: [{ ...valid.exclusions[0], excludedTables: Array.from({ length: 101 }, (_, index) => `t${index}`) }] })).toThrow()
    expect(() => parseServerOpsDatabaseAgentPolicy({ revision: -1, exclusions: [] })).toThrow()
    expect(() => parseServerOpsDatabaseAgentPolicyUpdate({ ...valid, exclusions: Array.from({ length: 1025 }, (_, index) => ({ sourceId: `s${index}`, database: 'main', excludedTables: ['t'] })) })).toThrow()
  })
})
