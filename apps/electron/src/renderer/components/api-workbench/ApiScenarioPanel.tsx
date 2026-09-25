/**
 * 「流程」分区：列出场景、一键运行（确认框列出步骤与目标环境）、逐步查看结果。
 *
 * 刻意只做「运行与看结果」：流程定义由 Agent 的 `api_save_scenario` 或导入维护，
 * 避免界面与 Agent 各维护一份定义。运行前先准备拿到步骤清单，人确认后才真发请求。
 */

import * as React from 'react'
import { Play, Loader2, XCircle, ExternalLink, Workflow } from 'lucide-react'
import type { ApiScenario, ApiScenarioPreparedPreview, ApiScenarioRun, ApiWorkbenchApi } from '@proma/shared'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'

/** 与工作台其它分区一样，热更新后旧 preload 可能还没有这套方法。 */
function getApiWorkbenchApi(): ApiWorkbenchApi | null {
  /** 组件要能在没有 window 的环境（SSR 测试）里渲染，只是拿不到 API。 */
  if (typeof window === 'undefined') return null
  const electronApi = window.electronAPI as typeof window.electronAPI & { apiWorkbench?: ApiWorkbenchApi }
  return electronApi.apiWorkbench ?? null
}

/** 打开某一步的运行记录；由 SidePanel 监听并切到该运行。 */
function openApiRun(sessionId: string, runId: string): void {
  window.dispatchEvent(new CustomEvent('proma:open-api-run', { detail: { sessionId, runId } }))
}

/** 步骤结论的中文与配色：通过 / 失败 / 跳过 / 出错。 */
const STEP_STATE: Record<ApiScenarioRun['steps'][number]['state'], { label: string; className: string }> = {
  passed: { label: '通过', className: 'text-emerald-600' },
  failed: { label: '失败', className: 'text-destructive' },
  skipped: { label: '跳过', className: 'text-muted-foreground' },
  error: { label: '出错', className: 'text-destructive' },
}

/** 步骤的补充事实：HTTP 状态与断言通过数。 */
function stepDetail(step: ApiScenarioRun['steps'][number]): string {
  const parts = [step.status === null ? '' : `HTTP ${step.status}`, `断言 ${step.assertionPassed}/${step.assertionTotal}`, step.durationMs === null ? '' : `${step.durationMs} ms`]
  return parts.filter(Boolean).join(' · ')
}

export interface ApiScenarioPanelProps {
  sessionId: string
  scenarios: readonly ApiScenario[]
  /** 步骤只存 requestId：展示时补上接口名，取不到就显示身份本身。 */
  requestNames: ReadonlyMap<string, string>
}

export function ApiScenarioPanel({ sessionId, scenarios, requestNames }: ApiScenarioPanelProps): React.ReactElement {
  const api = React.useMemo(() => getApiWorkbenchApi(), [])
  /** 已准备但还没确认运行的流程：确认框展示这份步骤清单。 */
  const [pending, setPending] = React.useState<ApiScenarioPreparedPreview | null>(null)
  /** 在途流程的 preparedId；用于禁用按钮与显示取消入口。 */
  const [running, setRunning] = React.useState<string | null>(null)
  /** 最近一次运行的结论；只保留这一次，历史运行在「流程历史」接口里。 */
  const [result, setResult] = React.useState<ApiScenarioRun | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  /** 准备流程：只解析步骤、不出网；失败时把可行动错误原样显示。 */
  const prepare = async (scenario: ApiScenario): Promise<void> => {
    if (!api) return
    setError(null)
    try {
      setPending(await api.prepareScenario({ sessionId, scenarioId: scenario.id }))
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '流程准备失败')
    }
  }

  /** 确认运行：界面里人点「确认运行」就是这次授权的来源。 */
  const run = async (preparedId: string): Promise<void> => {
    if (!api) return
    setPending(null)
    setRunning(preparedId)
    setError(null)
    try {
      setResult(await api.runScenario({ sessionId, preparedId }))
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '流程运行失败')
    } finally {
      setRunning(null)
    }
  }

  /** 取消：只中止当前在途步骤，已完成的步骤保留证据。 */
  const cancel = async (preparedId: string): Promise<void> => {
    if (!api) return
    try { await api.cancelScenario({ sessionId, preparedId }) } catch { /* 已经结束时忽略 */ }
  }

  return (
    <div className="mt-2 border-t border-border/40 pt-2">
      <div className="flex items-center justify-between px-1.5 pb-1">
        <span className="flex items-center gap-1 text-[11px] font-medium text-muted-foreground"><Workflow className="size-3" />流程</span>
        <span className="text-[10px] text-muted-foreground/70">定义由 Agent 维护</span>
      </div>
      {scenarios.length === 0 ? (
        <p className="px-1.5 pb-2 text-[11px] text-muted-foreground/70">还没有流程。让 Agent 用 api_save_scenario 建一条（步骤引用已保存的接口）。</p>
      ) : scenarios.map((scenario) => (
        <div key={scenario.id} className="group flex items-center gap-1 rounded-md px-1.5 py-1 hover:bg-muted/60">
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs">{scenario.name}</p>
            <p className="truncate text-[10px] text-muted-foreground">{scenario.folder ? `${scenario.folder} · ` : ''}{scenario.steps.length} 步 · 失败策略 {scenario.onFailure === 'continue' ? '继续' : '停止'}</p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label={`运行流程 ${scenario.name}`}
            className="h-6 gap-1 px-2 text-[11px]"
            disabled={running !== null}
            onClick={() => void prepare(scenario)}
          >
            {running !== null ? <Loader2 className="size-3 animate-spin" /> : <Play className="size-3" />}
            运行
          </Button>
        </div>
      ))}
      {running !== null && (
        <div className="mx-1.5 mt-1 flex items-center justify-between rounded bg-muted/50 px-2 py-1">
          <span className="flex items-center gap-1 text-[11px] text-muted-foreground"><Loader2 className="size-3 animate-spin" />正在按顺序执行…</span>
          <button type="button" className="text-[11px] text-destructive" onClick={() => void cancel(running)}>取消运行</button>
        </div>
      )}
      {error && <p className="mx-1.5 mt-1 rounded bg-destructive/10 px-2 py-1 text-[11px] text-destructive">{error}</p>}
      {result && (
        <div className="mx-1.5 mt-1 space-y-1 rounded bg-background/60 px-2 py-1.5">
          <div className="flex items-center justify-between">
            <p className="text-[11px] font-medium">{result.scenarioName}：{result.state === 'completed' ? '全部通过' : result.state === 'cancelled' ? '已取消' : '未通过'}</p>
            <button type="button" className="text-[10px] text-muted-foreground" onClick={() => setResult(null)}>收起</button>
          </div>
          {result.steps.map((step) => (
            <div key={step.stepId} className="flex items-center gap-1.5">
              <span className={`text-[11px] ${STEP_STATE[step.state].className}`}>{step.name}：{STEP_STATE[step.state].label}</span>
              <span className="min-w-0 flex-1 truncate text-[10px] text-muted-foreground">{stepDetail(step)}</span>
              {step.runId && (
                <button type="button" aria-label={`打开步骤运行 ${step.name}`} className="flex items-center gap-0.5 text-[10px] text-muted-foreground hover:text-foreground" onClick={() => openApiRun(sessionId, step.runId!)}>
                  <ExternalLink className="size-3" />运行
                </button>
              )}
            </div>
          ))}
          {result.error && <p className="text-[10px] text-destructive">{result.error.message}</p>}
        </div>
      )}
      <Dialog open={pending !== null} onOpenChange={(open) => { if (!open) setPending(null) }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>运行流程：{pending?.scenarioName}</DialogTitle>
            <DialogDescription>将按下面顺序真实发出请求；停止 Agent 或点取消都会中止当前步骤。</DialogDescription>
          </DialogHeader>
          <div className="my-3 space-y-1">
            {pending?.steps.map((step) => (
              <p key={step.stepId} className="font-mono text-xs break-all">
                {step.index + 1}. {step.name} · {step.method} {step.url}
                <span className="text-muted-foreground">（{requestNames.get(step.requestId) ?? step.requestId}{step.caseId ? ` · 用例 ${step.caseId}` : ''} · {step.assertionCount} 条断言）</span>
              </p>
            ))}
            <p className="pt-1 text-[11px] text-muted-foreground">环境：{pending?.environmentId ?? '未选择'}；失败策略：{pending?.onFailure === 'continue' ? '失败后继续执行后续步骤' : '失败后跳过后续步骤'}</p>
            {(pending?.warnings ?? []).map((warning) => <p key={warning} className="text-[11px] text-amber-600">{warning}</p>)}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setPending(null)}><XCircle className="size-3.5" />取消</Button>
            <Button type="button" onClick={() => { if (pending) void run(pending.preparedId) }}><Play className="size-3.5" />确认运行</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
