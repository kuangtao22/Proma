import { describe, expect, test } from 'bun:test'
import type { ApiAssertion, ApiTestCase } from '@proma/shared'
import { stampApiAgentCases } from './api-agent-case-ownership'

/** 最小断言，只用于构造用例。 */
function assertion(expected: string): ApiAssertion {
  return { id: 'a1', kind: 'status', path: '', expected }
}

/** 构造一条用例；来源默认按目录里的人工创建。 */
function testCase(id: string, name: string, source?: ApiTestCase['source'], expected = '200'): ApiTestCase {
  return { id, name, assertions: [assertion(expected)], ...(source ? { source } : {}) }
}

describe('Agent 用例来源与保护', () => {
  test('Given 新请求声明用例 When 盖章 Then 全部记为 Agent 且差异列出新增', () => {
    const result = stampApiAgentCases(undefined, [{ id: 'case_new', name: '登录成功', assertions: [assertion('200')] }])

    expect(result.cases.map((item) => item.source)).toEqual(['agent'])
    expect(result.diff).toEqual([{ caseId: 'case_new', caseName: '登录成功', source: 'agent', change: 'added', assertionCount: 1 }])
  })

  test('Given 模型自称来源为人写 When 新增用例 Then 仍按 Agent 盖章', () => {
    const result = stampApiAgentCases(undefined, [{ id: 'case_new', name: '伪装', assertions: [], source: 'user' }])

    expect(result.cases[0]?.source).toBe('agent')
  })

  test('Given 人写用例被改断言或改名 When 保存 Then 明确拒绝且不产生任何盖章结果', () => {
    const previous = [testCase('case_human', '人工写的越权', 'user', '403')]

    expect(() => stampApiAgentCases(previous, [{ id: 'case_human', name: '人工写的越权', assertions: [assertion('200')], source: 'user' }]))
      .toThrow('API_WORKBENCH_USER_CASE_PROTECTED')
    expect(() => stampApiAgentCases(previous, [{ id: 'case_human', name: '改个名', assertions: [assertion('403')], source: 'user' }]))
      .toThrow(/人工写的越权/)
  })

  test('Given 人写用例被删除或声明来源缺失 When 保存 Then 一律按人工保护拒绝', () => {
    expect(() => stampApiAgentCases([testCase('case_human', '人工用例', 'user')], [])).toThrow('API_WORKBENCH_USER_CASE_PROTECTED')
    /** 升级前保存的用例没有 source 字段，保护必须同样生效。 */
    expect(() => stampApiAgentCases([testCase('case_legacy', '旧用例')], [])).toThrow('API_WORKBENCH_USER_CASE_PROTECTED')
  })

  test('Given 人写用例原样保留 When 追加 Agent 用例 Then 来源各自不变且差异只列新增', () => {
    const previous = [testCase('case_human', '人工用例', 'user')]

    const result = stampApiAgentCases(previous, [previous[0]!, testCase('case_agent', 'Agent 用例')])

    expect(result.cases.map((item) => `${item.id}:${item.source}`)).toEqual(['case_human:user', 'case_agent:agent'])
    expect(result.diff).toEqual([{ caseId: 'case_agent', caseName: 'Agent 用例', source: 'agent', change: 'added', assertionCount: 1 }])
  })

  test('Given Agent 自己的用例 When 修改或删除 Then 允许并记录差异', () => {
    const previous = [testCase('case_agent', 'Agent 用例', 'agent', '200')]
    const updated = stampApiAgentCases(previous, [testCase('case_agent', 'Agent 用例', 'agent', '401')])
    const removed = stampApiAgentCases(previous, [])

    expect(updated.cases[0]?.assertions[0]?.expected).toBe('401')
    expect(updated.diff).toEqual([{ caseId: 'case_agent', caseName: 'Agent 用例', source: 'agent', change: 'updated', assertionCount: 1 }])
    expect(removed.cases).toEqual([])
    expect(removed.diff).toEqual([{ caseId: 'case_agent', caseName: 'Agent 用例', source: 'agent', change: 'removed', assertionCount: 1 }])
  })

  test('Given 顺序变化但内容相同 When 保存 Then 不算差异也不改来源', () => {
    const previous = [testCase('case_a', 'A', 'agent'), testCase('case_b', 'B', 'agent')]

    const result = stampApiAgentCases(previous, [previous[1]!, previous[0]!])

    expect(result.diff).toEqual([])
    expect(result.cases.map((item) => item.id)).toEqual(['case_b', 'case_a'])
  })
})
