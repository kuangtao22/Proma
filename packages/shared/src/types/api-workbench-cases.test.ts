import { describe, expect, test } from 'bun:test'
import { createApiCaseReportRow, formatApiCaseReportCells, formatApiCaseReportMarkdown } from './api-workbench-cases'
import type { ApiCaseReportRow } from './api-workbench-cases'
import type { ApiAssertion, ApiRun, ApiTestCase } from './api-workbench'

/** 报告抬头固定值，便于逐字断言。 */
const meta = { requestName: '登录', method: 'POST', url: 'https://example.test/login', startedAt: 1_700_000_000_000 }

/** 最小断言声明，只用于构造用例。 */
function assertion(id: string): ApiAssertion {
  return { id, kind: 'status', path: '', expected: '200' }
}

/** 构造带断言数量的用例声明。 */
function testCase(id: string, name: string, assertionCount: number): ApiTestCase {
  return { id, name, assertions: Array.from({ length: assertionCount }, (_value, index) => assertion(`${id}_${index}`)) }
}

/** 构造只保留报告关心的字段的运行记录。 */
function run(options: { status?: number; passed: boolean[]; state?: ApiRun['state']; error?: ApiRun['error']; finishedAt?: number; assertionMessages?: string[] }): ApiRun {
  return {
    id: 'run_1', workspaceId: 'workspace', sessionId: 'session', source: 'manual', requestName: '登录', caseId: 'case_ok',
    catalogRevision: 0, createdAt: 1_000, finishedAt: options.finishedAt ?? 1_240, state: options.state ?? 'completed',
    request: { method: 'POST', url: 'https://example.test/login', headers: [], body: '', timeoutMs: 1_000, followRedirects: false, maxRedirects: 0, sensitiveHeaderNames: [], sensitiveQueryNames: [] },
    hops: options.status === undefined ? [] : [{
      url: 'https://example.test/login', method: 'POST', requestHeaders: [], requestHeadersSource: 'configured', status: options.status, statusText: 'OK', httpVersion: '1.1',
      responseHeaders: [], trailers: [], timings: { dnsMs: null, connectMs: null, tlsMs: null, sendMs: null, ttfbMs: null, downloadMs: null, totalMs: 240 },
      connection: { reused: false },
    }],
    body: { rawBytes: 0, decodedBytes: 0, contentType: '', encoding: '', preview: '', previewTruncated: false, complete: true, decoded: false },
    assertions: options.passed.map((passed, index) => ({
      id: `a${index}`,
      passed,
      expected: '200',
      actual: options.status === undefined ? '' : String(options.status),
      message: options.assertionMessages?.[index] ?? (passed ? '断言通过' : '断言失败'),
    })),
    recording: 'saved', pinned: false,
    ...(options.error ? { error: options.error } : {}),
  }
}

describe('接口用例报告', () => {
  test('Given 全部用例通过 When 生成报告 Then 汇总通过率且每行标注通过', () => {
    const rows: ApiCaseReportRow[] = [
      { caseId: 'case_ok', caseName: '正常登录', runId: 'run_1', state: 'completed', status: 200, assertionsPassed: 3, assertionsTotal: 3, durationMs: 240 },
      { caseId: 'case_param', caseName: '缺参数', runId: 'run_2', state: 'completed', status: 400, assertionsPassed: 2, assertionsTotal: 2, durationMs: 180 },
    ]

    const report = formatApiCaseReportMarkdown(rows, meta)

    expect(report).toContain('| 用例 | 来源 | 结果 | 状态码 | 断言 | 耗时 | 备注 |')
    expect(report).toContain('| 正常登录 | 人工 | 通过 | 200 | 3/3 | 240 ms |  |')
    expect(report).toContain('| 缺参数 | 人工 | 通过 | 400 | 2/2 | 180 ms |  |')
    expect(report).toContain('- 结果：2/2 通过')
    expect(report).toContain('- 请求：POST https://example.test/login')
  })

  test('Given 有用例失败 When 生成报告 Then 汇总失败数量并保留失败原因', () => {
    const rows: ApiCaseReportRow[] = [
      { caseId: 'case_ok', caseName: '正常登录', runId: 'run_1', state: 'completed', status: 200, assertionsPassed: 3, assertionsTotal: 3, durationMs: 240 },
      { caseId: 'case_deny', caseName: '越权', runId: 'run_3', state: 'completed', status: 200, assertionsPassed: 1, assertionsTotal: 2, durationMs: 210, error: '期望 401 实际 200' },
    ]

    const report = formatApiCaseReportMarkdown(rows, meta)

    expect(report).toContain('- 结果：1/2 通过')
    expect(report).toContain('| 越权 | 人工 | 失败 | 200 | 1/2 | 210 ms | 期望 401 实际 200 |')
  })

  test('Given 未执行或无断言的用例 When 生成报告 Then 不把它们算成通过', () => {
    const rows: ApiCaseReportRow[] = [
      { caseId: 'case_new', caseName: '未跑过的用例', status: null, assertionsPassed: 0, assertionsTotal: 2, durationMs: null },
      { caseId: 'case_empty', caseName: '只跑请求', runId: 'run_9', state: 'completed', status: 204, assertionsPassed: 0, assertionsTotal: 0, durationMs: 12 },
    ]

    const report = formatApiCaseReportMarkdown(rows, meta)

    expect(report).toContain('- 结果：尚未执行')
    expect(report).toContain('| 未跑过的用例 | 人工 | 未执行 | — | 0/2 | — |  |')
    expect(report).toContain('| 只跑请求 | 人工 | 未验证 | 204 | — | 12 ms |  |')
  })

  test('Given 用例名或原因含竖线与换行 When 生成报告 Then 表格结构不被破坏', () => {
    const rows: ApiCaseReportRow[] = [
      { caseId: 'case_pipe', caseName: '带|竖线\n和换行', runId: 'run_1', state: 'failed', status: null, assertionsPassed: 0, assertionsTotal: 1, durationMs: null, error: '第一行\n第二行|尾' },
    ]

    const report = formatApiCaseReportMarkdown(rows, meta)
    const dataLine = report.split('\n').find((line) => line.startsWith('| 带'))

    expect(dataLine).toBe('| 带\\|竖线 和换行 | 人工 | 失败 | — | 0/1 | — | 第一行 第二行\\|尾 |')
    expect(report.split('\n').filter((line) => line.startsWith('|')).length).toBe(3)
  })

  test('Given Agent 声明的用例 When 生成报告 Then 来源列标出 Agent 以便区分谁出的题', () => {
    const rows: ApiCaseReportRow[] = [
      { caseId: 'case_agent', caseName: 'Agent 猜的越权', source: 'agent', runId: 'run_1', state: 'completed', status: 403, assertionsPassed: 1, assertionsTotal: 1, durationMs: 90 },
      { caseId: 'case_human', caseName: '人工写的越权', source: 'user', runId: 'run_2', state: 'completed', status: 403, assertionsPassed: 1, assertionsTotal: 1, durationMs: 95 },
    ]

    const report = formatApiCaseReportMarkdown(rows, meta)

    expect(report).toContain('| Agent 猜的越权 | Agent | 通过 | 403 | 1/1 | 90 ms |  |')
    expect(report).toContain('| 人工写的越权 | 人工 | 通过 | 403 | 1/1 | 95 ms |  |')
    expect(formatApiCaseReportCells(rows[0]!).source).toBe('Agent')
    expect(formatApiCaseReportCells({ ...rows[1]!, source: undefined }).source).toBe('人工')
  })
})

describe('接口用例结果映射', () => {
  test('Given 用例执行完成 When 映射报告行 Then 用运行里的真实状态码、断言与耗时', () => {
    const row = createApiCaseReportRow(testCase('case_ok', '正常登录', 3), run({ status: 200, passed: [true, true, true] }))

    expect(row).toEqual({
      caseId: 'case_ok', caseName: '正常登录', source: 'user', runId: 'run_1', state: 'completed', status: 200,
      assertionsPassed: 3, assertionsTotal: 3, durationMs: 240,
    })
    expect(formatApiCaseReportCells(row)).toEqual({
      caseName: '正常登录', source: '人工', verdict: '通过', status: '200', assertions: '3/3', duration: '240 ms', remark: '',
    })
  })

  test('Given 用例没有运行记录 When 映射报告行 Then 标注未执行并保留声明的断言数量', () => {
    const row = createApiCaseReportRow(testCase('case_new', '越权', 2), null)

    expect(row.runId).toBeUndefined()
    expect(row.assertionsTotal).toBe(2)
    expect(row.assertionsPassed).toBe(0)
    expect(row.status).toBeNull()
    expect(row.durationMs).toBeNull()
    expect(formatApiCaseReportCells(row).verdict).toBe('未执行')
  })

  test('Given 用例被取消或派发失败 When 映射报告行 Then 备注写清原因且不伪装成通过', () => {
    const cancelled = createApiCaseReportRow(testCase('case_c', '取消用例', 1), null, '已取消，未执行')
    const failedDispatch = createApiCaseReportRow(testCase('case_d', '派发失败', 1), null, 'API_WORKBENCH_CASE_NOT_FOUND')
    const brokenRun = createApiCaseReportRow(testCase('case_e', '连接失败', 1), run({ passed: [], state: 'failed', error: { phase: 'connect', code: 'ECONNREFUSED', message: '连接被拒绝' } }), undefined)
    const cancelledRun = createApiCaseReportRow(testCase('case_f', '中断的运行', 2), run({ status: 200, passed: [true], state: 'cancelled' }))

    expect(cancelled.error).toBe('已取消，未执行')
    expect(formatApiCaseReportCells(cancelled).verdict).toBe('未执行')
    expect(failedDispatch.error).toBe('API_WORKBENCH_CASE_NOT_FOUND')
    expect(brokenRun.error).toBe('连接被拒绝')
    expect(formatApiCaseReportCells(brokenRun).verdict).toBe('失败')
    expect(cancelledRun.error).toBe('运行已取消')
    expect(formatApiCaseReportCells(cancelledRun).verdict).toBe('失败')
  })

  test('Given 断言不成立 When 映射报告行 Then 备注写出期望与实际而不是「断言失败」', () => {
    const single = createApiCaseReportRow(testCase('case_b', '越权', 1), run({ status: 401, passed: [false] }))
    const multiple = createApiCaseReportRow(testCase('case_m', '多断点', 3), run({ status: 401, passed: [true, false, false] }))
    const detailed = createApiCaseReportRow(testCase('case_s', '事件流', 1), run({
      status: 200,
      passed: [false],
      assertionMessages: ['响应不是事件流，无法验证该断言'],
    }))

    expect(single.error).toBe('期望 200，实际 401')
    expect(multiple.error).toBe('期望 200，实际 401（共 2 项未通过）')
    expect(detailed.error).toBe('响应不是事件流，无法验证该断言')
    expect(createApiCaseReportRow(testCase('case_ok', '正常', 1), run({ status: 200, passed: [true] })).error).toBeUndefined()
  })
})
