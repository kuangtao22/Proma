import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ServerOpsDataDiagnosticsResult } from '@proma/shared'
import { ServerOpsDatabaseDiagnostics } from './ServerOpsDatabaseDiagnostics'
import type { ServerOpsDiagnosticPage, ServerOpsDiagnosticsProjection } from './server-ops-diagnostics-controller'

/** 诊断正文允许展示的页面，不包含未接入的日志占位。 */
type DiagnosticContentPage = Exclude<ServerOpsDiagnosticPage, 'logs'>

/** 创建包含可识别正文的只读诊断结果。 */
function createResult(overrides: Partial<ServerOpsDataDiagnosticsResult> = {}): ServerOpsDataDiagnosticsResult {
  return {
    sourceId: 'source-1',
    engine: 'mysql',
    capability: 'available',
    collectedAt: 1_700_000_000_000,
    metrics: [],
    tables: [],
    warnings: [],
    ...overrides,
  }
}

/** 渲染单一诊断正文，页面切换由外层工作台负责。 */
function renderPage(options: {
  page: DiagnosticContentPage
  scope: 'instance' | 'database'
  database?: string | null
  result?: ServerOpsDataDiagnosticsResult
  onSelectDatabase?: (database: string) => void
}): string {
  /** 当前页真实投影，用于覆盖等待、快照和空结果边界。 */
  const projection: ServerOpsDiagnosticsProjection = {
    page: options.page,
    database: options.database ?? null,
    pages: options.result === undefined ? {} : {
      [options.page]: {
        status: 'ready',
        error: null,
        result: options.result,
        collectedAt: options.result.collectedAt,
      },
    },
  }
  return renderToStaticMarkup(
    <ServerOpsDatabaseDiagnostics
      projection={projection}
      page={options.page}
      scope={options.scope}
      onRefresh={() => undefined}
      onSelectDatabase={options.onSelectDatabase}
    />,
  )
}

describe('数据库诊断正文范围', () => {
  test('Given 实例级会话未限定数据库 When 渲染正文 Then 展示全部可见会话且允许刷新', () => {
    const html = renderPage({
      page: 'sessions',
      scope: 'instance',
      result: createResult({
        tables: [{
          id: 'processes',
          title: '会话',
          columns: [{ id: 'db', label: '库' }],
          rows: [['instance-session']],
          truncated: false,
        }],
      }),
    })
    expect(html).toContain('实例范围')
    expect(html).toContain('全部数据库（含未归属）')
    expect(html).not.toContain('按会话当前库筛选')
    expect(html).toContain('instance-session')
    expect(html).toMatch(/aria-label="刷新当前实例页面"(?![^>]*disabled)/)
  })

  test('Given 库级会话尚未选库且残留旧快照 When 渲染正文 Then 只提示选库并禁止刷新', () => {
    const html = renderPage({
      page: 'sessions',
      scope: 'database',
      result: createResult({
        metrics: [{ id: 'old-metric', label: '旧库指标', value: '99' }],
        tables: [{
          id: 'processes',
          title: '会话',
          columns: [{ id: 'db', label: '库' }],
          rows: [['旧库会话']],
          truncated: false,
        }],
        warnings: ['旧库警告'],
      }),
    })
    expect(html).toContain('先选择数据库')
    expect(html).toMatch(/aria-label="刷新当前数据库页面"[^>]*disabled=""/)
    expect(html).not.toContain('旧库指标')
    expect(html).not.toContain('旧库会话')
    expect(html).not.toContain('旧库警告')
    expect(html).not.toContain('采样时间')
  })

  test('Given 外层已经选择页面 When 渲染正文 Then 不重复提供运行诊断导航或日志占位', () => {
    const html = renderPage({ page: 'overview', scope: 'instance' })
    expect(html).not.toContain('运行诊断页面')
    expect(html).not.toContain('尚未接入 MySQL 原始日志')
    expect(html).not.toContain('role="tablist"')
  })

  test('Given 实例总览返回容量表 When 提供选库回调 Then 显示容量语义和原生库导航按钮', () => {
    const html = renderPage({
      page: 'overview',
      scope: 'instance',
      onSelectDatabase: () => undefined,
      result: createResult({
        tables: [{
          id: 'databases',
          title: '数据库',
          columns: [
            { id: 'name', label: '名称' },
            { id: 'tables', label: '表', align: 'right' },
            { id: 'size', label: '容量', align: 'right' },
          ],
          rows: [['app', '12', '1.0 GiB']],
          truncated: false,
        }],
      }),
    })
    expect(html).toContain('数据库容量')
    expect(html).toContain('可见库容量汇总')
    expect(html).toContain('非完整目录')
    expect(html).toContain('<button')
    expect(html).toContain('aria-label="浏览数据库 app"')
    expect(html).toContain('data-server-ops-database-link="app"')
  })

  test('Given 实例总览没有选库回调 When 渲染容量表 Then 库名保持纯文本', () => {
    const html = renderPage({
      page: 'overview',
      scope: 'instance',
      result: createResult({
        tables: [{
          id: 'databases',
          title: '数据库',
          columns: [{ id: 'name', label: '名称' }],
          rows: [['app']],
          truncated: false,
        }],
      }),
    })
    expect(html).toContain('>app</td>')
    expect(html).not.toContain('data-server-ops-database-link')
  })

  test('Given 查看语句分析 When 渲染范围说明 Then 明确累计摘要与默认库归属边界', () => {
    const html = renderPage({ page: 'statements', scope: 'database', database: 'app' })
    expect(html).toContain('累计 SQL 模板摘要')
    expect(html).toContain('默认库归属')
    expect(html).toContain('非原始慢日志')
  })

  test('Given 实例级语句摘要 When 渲染正文 Then 覆写运行时旧标题且不声称按库筛选', () => {
    const html = renderPage({
      page: 'statements',
      scope: 'instance',
      result: createResult({
        tables: [{
          id: 'statements',
          title: '慢语句',
          columns: [{ id: 'database', label: '数据库' }],
          rows: [['未归属']],
          truncated: false,
        }],
      }),
    })
    expect(html).toContain('全部数据库（含未归属）')
    expect(html).toContain('语句分析')
    expect(html).not.toContain('按默认库归属筛选')
    expect(html).not.toContain('>慢语句<')
  })

  test('Given 参数页 When 渲染工具栏 Then 只提供一个刷新入口并保留参数搜索', () => {
    const html = renderPage({ page: 'parameters', scope: 'instance', result: createResult({ parameters: [] }) })
    expect(html.match(/aria-label="刷新当前实例页面"/g)).toHaveLength(1)
    expect(html).toContain('aria-label="搜索参数名称"')
  })
})
