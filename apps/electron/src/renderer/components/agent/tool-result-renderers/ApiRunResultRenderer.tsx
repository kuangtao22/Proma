import * as React from 'react'
import { AlertTriangle, ArrowUpRight, CheckCircle2, Clock3, XCircle } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { DefaultResultRenderer } from './default-result'

/** Agent 工具返回的只读接口运行摘要。 */
export interface ParsedApiRunResult {
  kind: 'api-workbench-run'
  runId: string
  sessionId: string
  method: string
  url: string
  state: string
  status: number | null
  durationMs: number | null
  assertions: { passed: number; total: number }
  recording: string
  error?: string
}

/** 打开运行事件需要的最小 EventTarget 能力，便于无 DOM 测试。 */
interface ApiRunEventTarget {
  dispatchEvent(event: Event): boolean
}

/** 判断未知值是否为普通记录。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 读取非空且有界的字符串。 */
function boundedString(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : null
}

/** 读取非负整数或 null。 */
function nullableNonNegativeInteger(value: unknown): number | null | undefined {
  if (value === null) return null
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

/** 将错误字段压缩为用户可见消息。 */
function parseError(value: unknown): string | undefined {
  if (typeof value === 'string' && value) return value
  if (isRecord(value) && typeof value.message === 'string' && value.message) return value.message
  return undefined
}

/** 解析 api_send_request 的 details 或直接 JSON 结果。 */
export function parseApiRunResult(result: string): ParsedApiRunResult | null {
  try {
    /** 工具结果 JSON。 */
    const parsed: unknown = JSON.parse(result)
    /** Agent runtime 可能把结构化结果放在 details 下。 */
    const record = isRecord(parsed) && isRecord(parsed.details) ? parsed.details : parsed
    if (!isRecord(record) || record.kind !== 'api-workbench-run') return null
    /** 断言统计。 */
    const assertions = record.assertions
    if (!isRecord(assertions)) return null
    /** 成功和总断言数。 */
    const passed = nullableNonNegativeInteger(assertions.passed)
    const total = nullableNonNegativeInteger(assertions.total)
    /** HTTP 状态和耗时允许不可用。 */
    const status = nullableNonNegativeInteger(record.status)
    const durationMs = nullableNonNegativeInteger(record.durationMs)
    /** 核心文本字段。 */
    const runId = boundedString(record.runId, 128)
    const sessionId = boundedString(record.sessionId, 128)
    const method = boundedString(record.method, 16)
    const url = boundedString(record.url, 8192)
    const state = boundedString(record.state, 32)
    const recording = boundedString(record.recording, 32)
    if (!runId || !sessionId || !method || !url || !state || !recording || passed === undefined || total === undefined || passed === null || total === null || passed > total || status === undefined || durationMs === undefined) return null
    /** 可选错误只解析一次。 */
    const error = parseError(record.error)
    return {
      kind: 'api-workbench-run', runId, sessionId, method, url, state, status, durationMs,
      assertions: { passed, total }, recording, ...(error ? { error } : {}),
    }
  } catch {
    return null
  }
}

/** 仅在结果属于当前内容块会话时分派打开历史运行事件。 */
export function dispatchOpenApiRun(
  result: ParsedApiRunResult,
  currentSessionId: string | undefined,
  target: ApiRunEventTarget = window,
): boolean {
  if (!currentSessionId || result.sessionId !== currentSessionId) return false
  return target.dispatchEvent(new CustomEvent('proma:open-api-run', { detail: { sessionId: result.sessionId, runId: result.runId } }))
}

/** api_send_request 的只读结果卡。 */
export function ApiRunResultRenderer({ result, isError, sessionId }: { result: string; isError: boolean; sessionId?: string }): React.ReactElement {
  /** 严格解析后的摘要。 */
  const run = parseApiRunResult(result)
  if (!run) return <DefaultResultRenderer result={result} isError={isError} />
  /** 结果是否属于当前消息会话。 */
  const canOpen = sessionId === run.sessionId
  /** HTTP 与执行状态独立显示。 */
  const successfulHttp = run.status !== null && run.status >= 200 && run.status < 400
  /** 断言是否全部通过。 */
  const assertionsPassed = run.assertions.passed === run.assertions.total
  /** 运行终态图标。 */
  const StateIcon = run.state === 'completed' ? CheckCircle2 : run.state === 'failed' ? XCircle : AlertTriangle
  return (
    <div className="max-w-2xl rounded-md border border-border/50 bg-muted/[0.16] p-3 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <StateIcon className={cn('size-4', run.state === 'completed' ? 'text-emerald-600 dark:text-emerald-400' : 'text-destructive')} />
        <Badge variant="outline" className="font-mono text-[10px]">{run.method}</Badge>
        <span className="min-w-0 flex-1 truncate font-medium">{run.url}</span>
        <Badge variant={successfulHttp ? 'secondary' : 'destructive'}>{run.status ?? run.state}</Badge>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
        <span className="inline-flex items-center gap-1"><Clock3 className="size-3" />{run.durationMs === null ? '耗时不适用' : `${run.durationMs} ms`}</span>
        <span className={assertionsPassed ? 'text-emerald-600 dark:text-emerald-400' : 'text-destructive'}>断言 {run.assertions.passed}/{run.assertions.total}</span>
        <span>记录：{run.recording}</span>
      </div>
      {run.error && <div className="mt-2 rounded bg-destructive/10 px-2 py-1.5 text-destructive">{run.error}</div>}
      <div className="mt-3 flex items-center justify-between gap-2">
        {!canOpen && <span className="text-[10px] text-muted-foreground">该运行属于其它会话</span>}
        <Button type="button" variant="outline" size="sm" className="ml-auto h-7 gap-1.5 text-xs" disabled={!canOpen} onClick={() => dispatchOpenApiRun(run, sessionId)}>
          打开接口工作台 <ArrowUpRight className="size-3.5" />
        </Button>
      </div>
    </div>
  )
}
