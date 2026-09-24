import type { ApiRun } from './api-workbench'
import type { ApiTestCase } from './api-workbench'

/** 用例汇总的一行：界面表格、复制导出与将来的历史都共用同一形状。 */
export interface ApiCaseReportRow {
  /** 用例身份；请求自身的默认断言没有用例身份。 */
  caseId?: string
  caseName: string
  /** 已执行时才有运行身份；未执行表示只列出用例。 */
  runId?: string
  state?: ApiRun['state']
  status: number | null
  assertionsPassed: number
  assertionsTotal: number
  durationMs: number | null
  /** 失败原因或错误摘要；导出时放在备注列。 */
  error?: string
}

/** 报告抬头信息；全部来自已脱敏的公开事实。 */
export interface ApiCaseReportMeta {
  requestName: string
  method: string
  url: string
  startedAt: number
}

/** 单元格转义：竖线会破坏表格，换行会让一行变两行。 */
function cell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ').trim()
}

/**
 * 单行结论：未执行、未验证、通过、失败四态，不用状态码倒推业务结论。
 * 失败、取消与中断的多次运行绝不能显示通过，哪怕它已跑过的断言都成立。
 */
function verdict(row: ApiCaseReportRow): string {
  if (!row.runId) return '未执行'
  if (row.state === 'failed' || row.state === 'cancelled' || row.state === 'interrupted') return '失败'
  if (row.assertionsTotal === 0) return '未验证'
  return row.assertionsPassed === row.assertionsTotal ? '通过' : '失败'
}

/** 耗时展示；不可观测时用短横线而不是 0。 */
function duration(row: ApiCaseReportRow): string {
  return row.durationMs === null ? '—' : `${row.durationMs} ms`
}

/** 报告表格的六个单元格文本；界面表格与复制出的 Markdown 共用同一结论。 */
export interface ApiCaseReportCells {
  caseName: string
  verdict: string
  status: string
  assertions: string
  duration: string
  remark: string
}

/**
 * 把一行结果格式化成表格单元格。
 * @param row 单条用例结果。
 * @returns 未转义的单元格文本，调用方按各自渲染方式转义。
 */
export function formatApiCaseReportCells(row: ApiCaseReportRow): ApiCaseReportCells {
  return {
    caseName: row.caseName,
    verdict: verdict(row),
    status: row.status === null ? '—' : String(row.status),
    assertions: row.assertionsTotal === 0 ? '—' : `${row.assertionsPassed}/${row.assertionsTotal}`,
    duration: duration(row),
    remark: row.error ?? '',
  }
}

/**
 * 失败断言的说明：优先用求值器给出的具体原因，否则拼出期望与实际。
 * @param failed 已判定为失败的断言结果，至少一条。
 * @returns 可读原因；多条失败时补一句计数，避免只看到其中一条。
 */
function assertionRemark(failed: readonly ApiRun['assertions'][number][]): string {
  const first = failed[0]!
  /** 通用「断言失败」不足以定位，替换成期望与实际。 */
  const detail = first.message && first.message !== '断言失败'
    ? first.message
    : `期望 ${first.expected || '（空）'}，实际 ${first.actual || '（空）'}`
  return failed.length > 1 ? `${detail}（共 ${failed.length} 项未通过）` : detail
}

/** 运行终态的补充说明：失败保留真实原因，取消与中断不伪装成通过。 */
function runRemark(run: ApiRun): string | undefined {
  if (run.error) return run.error.message || run.error.code
  if (run.state === 'cancelled') return '运行已取消'
  if (run.state !== 'completed') return `运行状态：${run.state}`
  /** 传输成功但断言不成立时必须给出原因，否则表格只有「失败」两个字。 */
  const failed = run.assertions.filter((item) => !item.passed)
  return failed.length > 0 ? assertionRemark(failed) : undefined
}

/**
 * 把一次用例执行映射成报告行，供界面表格、复制导出和批量运行共用。
 * @param testCase 被执行的用例声明。
 * @param run 真实运行记录；为空表示这次用例没有产生运行记录。
 * @param error 没有运行记录时的可读原因（例如被取消或派发失败）。
 * @returns 单行报告；只包含公开事实，不含响应正文与秘密。
 */
export function createApiCaseReportRow(testCase: ApiTestCase, run: ApiRun | null, error?: string): ApiCaseReportRow {
  /** 未执行时回落到用例声明的断言数量，避免把「没跑」显示成 0/0。 */
  const assertions = run?.assertions ?? []
  /** 备注列：显式原因优先，其次取运行终态的真实说明。 */
  const remark = error ?? (run ? runRemark(run) : undefined)
  return {
    caseId: testCase.id,
    caseName: testCase.name,
    ...(run ? { runId: run.id, state: run.state } : {}),
    status: run?.hops.at(-1)?.status ?? null,
    assertionsPassed: assertions.filter((item) => item.passed).length,
    assertionsTotal: run ? assertions.length : testCase.assertions.length,
    durationMs: run?.finishedAt === undefined ? null : Math.max(0, run.finishedAt - run.createdAt),
    ...(remark ? { error: remark } : {}),
  }
}

/**
 * 生成可粘贴的 Markdown 用例报告。
 * @param rows 用例结果行，顺序即报告顺序。
 * @param meta 请求身份与开始时间。
 * @returns Markdown 文本；不包含任何响应正文或秘密。
 */
export function formatApiCaseReportMarkdown(rows: readonly ApiCaseReportRow[], meta: ApiCaseReportMeta): string {
  /** 只统计已执行且带断言的用例，未执行不参与通过率。 */
  const executed = rows.filter((row) => row.runId !== undefined && row.assertionsTotal > 0)
  /** 通过数必须与表格结论同源，取消或中断的运行不计为通过。 */
  const passed = executed.filter((row) => formatApiCaseReportCells(row).verdict === '通过').length
  const summary = executed.length === 0 ? '尚未执行' : `${passed}/${executed.length} 通过`
  const lines = [
    '# 接口测试用例报告',
    '',
    `- 请求：${meta.method} ${meta.url}`,
    `- 用例集：${meta.requestName}`,
    `- 开始时间：${new Date(meta.startedAt).toLocaleString()}`,
    `- 结果：${summary}`,
    '',
    '| 用例 | 结果 | 状态码 | 断言 | 耗时 | 备注 |',
    '| --- | --- | --- | --- | --- | --- |',
  ]
  for (const row of rows) {
    /** 与界面表格一致的单元格文本，避免两处结论漂移。 */
    const cells = formatApiCaseReportCells(row)
    lines.push([
      cell(cells.caseName),
      cells.verdict,
      cells.status,
      cells.assertions,
      cells.duration,
      cell(cells.remark),
    ].join(' | ').replace(/^/, '| ').replace(/$/, ' |'))
  }
  return lines.join('\n')
}
