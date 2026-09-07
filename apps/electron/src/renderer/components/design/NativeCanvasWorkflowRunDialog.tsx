import * as React from 'react'
import type {
  CanvasRunWorkflowResult,
  CanvasTarget,
  CanvasWorkflowRun,
  CanvasWorkflowRunChangedEvent,
  CanvasWorkflowRunListInput,
  CanvasWorkflowRunPage,
  CanvasWorkflowRunTarget,
} from '@proma/shared'
import { LoaderCircle, Play, Square } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

/** 工作流历史弹窗每次读取的固定页大小。 */
export const CANVAS_WORKFLOW_RUN_PAGE_SIZE = 20

/** 工作流历史列表和单项操作共享的轻量 UI 状态。 */
export interface NativeCanvasWorkflowRunState {
  runs: CanvasWorkflowRun[]
  nextCursor: string | null
  loading: boolean
  loadingMore: boolean
  operationRunId: string | null
  error: string | null
}

/** 工作流历史控制器依赖，所有 UI 请求均绑定当前普通 Agent 会话。 */
export interface NativeCanvasWorkflowRunControllerDependencies {
  sessionId: string
  target: CanvasTarget
  listRuns: (input: CanvasWorkflowRunListInput) => Promise<CanvasWorkflowRunPage>
  getRun: (input: CanvasWorkflowRunTarget) => Promise<CanvasWorkflowRun>
  resumeRun: (input: CanvasWorkflowRunTarget) => Promise<CanvasRunWorkflowResult>
  cancelRun: (input: CanvasWorkflowRunTarget) => Promise<CanvasWorkflowRun>
  onChanged: (
    target: CanvasTarget,
    listener: (event: CanvasWorkflowRunChangedEvent) => void,
  ) => () => void
  onStateChange: (state: NativeCanvasWorkflowRunState) => void
}

/** 工作流历史弹窗使用的命令控制器。 */
export interface NativeCanvasWorkflowRunController {
  load: () => Promise<void>
  loadMore: () => Promise<void>
  resume: (run: CanvasWorkflowRun) => Promise<void>
  cancel: (run: CanvasWorkflowRun) => Promise<void>
  dispose: () => void
}

/** 创建只在弹窗打开期间存活的工作流历史控制器。 */
export function createNativeCanvasWorkflowRunController(
  dependencies: NativeCanvasWorkflowRunControllerDependencies,
): NativeCanvasWorkflowRunController {
  /** 控制器内部保留完整状态，避免异步回调读取 React 闭包旧值。 */
  let state: NativeCanvasWorkflowRunState = {
    runs: [], nextCursor: null, loading: false, loadingMore: false,
    operationRunId: null, error: null,
  }
  /** 每次关闭递增代次，让旧 Canvas 的迟到结果失效。 */
  let generation = 0
  let disposed = false
  /** 发布合并后的完整状态。 */
  const updateState = (update: Partial<NativeCanvasWorkflowRunState>): void => {
    state = { ...state, ...update }
    dependencies.onStateChange(state)
  }
  /** 为每次 UI 操作构造显式 session 绑定目标。 */
  const runTarget = (runId: string): CanvasWorkflowRunTarget => ({
    ...dependencies.target, sessionId: dependencies.sessionId, runId,
  })
  /** 读取首页或后续页，并用请求代次阻断关闭后的回写。 */
  const loadPage = async (cursor?: string): Promise<void> => {
    const requestGeneration = generation
    const loadingMore = cursor !== undefined
    updateState(loadingMore
      ? { loadingMore: true, error: null }
      : { loading: true, error: null })
    try {
      const page = await dependencies.listRuns({
        ...dependencies.target, sessionId: dependencies.sessionId,
        ...(cursor !== undefined ? { cursor } : {}),
        limit: CANVAS_WORKFLOW_RUN_PAGE_SIZE,
      })
      if (disposed || requestGeneration !== generation) return
      const runs = loadingMore
        ? [...state.runs, ...page.runs.filter((run) => !state.runs.some((current) => current.id === run.id))]
        : page.runs
      updateState({ runs, nextCursor: page.nextCursor, loading: false, loadingMore: false, error: null })
    } catch {
      if (disposed || requestGeneration !== generation) return
      updateState({
        loading: false, loadingMore: false,
        error: '工作流运行记录暂时无法加载。',
      })
    }
  }
  /** 使用最新持久事实替换列表中的单条运行。 */
  const replaceRun = (run: CanvasWorkflowRun): void => {
    updateState({
      runs: state.runs.map((current) => current.id === run.id ? run : current),
      error: null,
    })
  }
  /** 事件只读取变化的已知运行；未知运行重新读取首页以保持排序。 */
  const release = dependencies.onChanged(dependencies.target, (event) => {
    const current = state.runs.find((run) => run.id === event.runId)
    if (!current) {
      void loadPage()
      return
    }
    if (event.revision <= current.revision) return
    const requestGeneration = generation
    void dependencies.getRun(runTarget(event.runId)).then((run) => {
      if (!disposed && requestGeneration === generation) replaceRun(run)
    }).catch(() => {
      if (!disposed && requestGeneration === generation) updateState({ error: '工作流状态刷新失败，请重试。' })
    })
  })
  /** 统一执行继续或取消，并保证同一时间只有一个运行操作。 */
  const runOperation = async (
    run: CanvasWorkflowRun,
    operation: (target: CanvasWorkflowRunTarget) => Promise<CanvasWorkflowRun | CanvasRunWorkflowResult>,
    reloadAfter: boolean,
  ): Promise<void> => {
    if (state.operationRunId) return
    const requestGeneration = generation
    updateState({ operationRunId: run.id, error: null })
    try {
      const result = await operation(runTarget(run.id))
      if (disposed || requestGeneration !== generation) return
      const latest = reloadAfter ? await dependencies.getRun(runTarget(run.id)) : result as CanvasWorkflowRun
      if (disposed || requestGeneration !== generation) return
      replaceRun(latest)
      updateState({ operationRunId: null })
    } catch {
      if (disposed || requestGeneration !== generation) return
      updateState({ operationRunId: null, error: '工作流操作失败，请重试。' })
    }
  }
  return {
    load: () => loadPage(),
    loadMore: () => state.nextCursor ? loadPage(state.nextCursor) : Promise.resolve(),
    resume: (run) => runOperation(run, dependencies.resumeRun, true),
    cancel: (run) => runOperation(run, dependencies.cancelRun, false),
    dispose: () => {
      disposed = true
      generation += 1
      release()
    },
  }
}

/** 工作流状态使用的稳定中文标签。 */
const WORKFLOW_STATUS_LABELS: Record<CanvasWorkflowRun['status'], string> = {
  running: '运行中',
  'waiting-review': '待验收',
  'waiting-budget': '预算已用尽',
  completed: '已完成',
  partial: '部分完成',
  failed: '失败',
  cancelled: '已取消',
}

/** 判断运行是否仍允许用户显式继续。 */
function canResumeWorkflowRun(run: CanvasWorkflowRun): boolean {
  return run.status === 'running' || run.status === 'waiting-review'
    || run.status === 'partial' || run.status === 'failed'
}

/** 判断运行是否仍有可停止的未终结工作。 */
function canCancelWorkflowRun(run: CanvasWorkflowRun): boolean {
  return run.status === 'running' || run.status === 'waiting-review' || run.status === 'partial'
}

/** 以本地中文格式显示运行更新时间。 */
function formatWorkflowRunUpdatedAt(updatedAt: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(updatedAt)
}

/** 渲染工作流历史的加载、空、错误、分页和单项操作状态。 */
export function NativeCanvasWorkflowRunEntries({
  state,
  onLoadMore,
  onResume,
  onCancel,
}: {
  state: NativeCanvasWorkflowRunState
  onLoadMore: () => void
  onResume: (run: CanvasWorkflowRun) => void
  onCancel: (run: CanvasWorkflowRun) => void
}): React.ReactElement {
  if (state.loading && state.runs.length === 0) {
    return (
      <div className="flex min-h-36 items-center justify-center gap-2 text-sm text-muted-foreground" role="status">
        <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />正在加载
      </div>
    )
  }
  if (state.error && state.runs.length === 0) {
    return <p className="py-10 text-center text-sm text-destructive" role="alert">{state.error}</p>
  }
  if (state.runs.length === 0) {
    return <p className="py-10 text-center text-sm text-muted-foreground">暂无工作流运行记录</p>
  }
  return (
    <>
      {state.error ? <p className="pb-2 text-sm text-destructive" role="alert">{state.error}</p> : null}
      <ul className="max-h-[min(60vh,32rem)] divide-y divide-border overflow-y-auto pr-1">
        {state.runs.map((run) => {
          const operating = state.operationRunId === run.id
          const completedCount = run.nodes.filter((node) => (
            node.status === 'completed' || node.status === 'satisfied'
          )).length
          return (
            <li key={run.id} className="flex min-w-0 items-center gap-3 py-3">
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="shrink-0 text-xs font-medium text-primary">{WORKFLOW_STATUS_LABELS[run.status]}</span>
                  <span className="truncate text-sm font-medium text-foreground">{run.goal}</span>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {completedCount}/{run.nodes.length} 个节点 · 更新于 {formatWorkflowRunUpdatedAt(run.updatedAt)}
                </p>
                {run.status === 'waiting-budget' ? (
                  <p className="mt-1 text-xs text-muted-foreground">请在 Agent 对话中补充预算后恢复工作流</p>
                ) : null}
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {canResumeWorkflowRun(run) ? (
                  <Button type="button" size="sm" variant="outline" disabled={state.operationRunId !== null} onClick={() => onResume(run)}>
                    {operating ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : <Play aria-hidden="true" />}
                    继续
                  </Button>
                ) : null}
                {canCancelWorkflowRun(run) ? (
                  <Button type="button" size="icon-sm" variant="ghost" disabled={state.operationRunId !== null} aria-label={`停止 ${run.goal}`} onClick={() => onCancel(run)}>
                    <Square aria-hidden="true" />
                  </Button>
                ) : null}
              </div>
            </li>
          )
        })}
      </ul>
      {state.nextCursor ? (
        <div className="flex justify-center pt-3">
          <Button type="button" size="sm" variant="ghost" disabled={state.loadingMore || state.operationRunId !== null} onClick={onLoadMore}>
            {state.loadingMore ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : null}
            加载更多
          </Button>
        </div>
      ) : null}
    </>
  )
}

/** 工作流历史弹窗输入；数据加载由 Workspace 在打开边界创建控制器。 */
export interface NativeCanvasWorkflowRunDialogProps {
  open: boolean
  state: NativeCanvasWorkflowRunState
  onOpenChange: (open: boolean) => void
  onLoadMore: () => void
  onResume: (run: CanvasWorkflowRun) => void
  onCancel: (run: CanvasWorkflowRun) => void
}

/** 展示当前普通 Agent 在当前 Canvas 的持久工作流历史。 */
export function NativeCanvasWorkflowRunDialog({
  open,
  state,
  onOpenChange,
  onLoadMore,
  onResume,
  onCancel,
}: NativeCanvasWorkflowRunDialogProps): React.ReactElement {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>工作流运行记录</DialogTitle>
          <DialogDescription className="sr-only">当前 Agent 的 Canvas 工作流运行记录</DialogDescription>
        </DialogHeader>
        <NativeCanvasWorkflowRunEntries
          state={state}
          onLoadMore={onLoadMore}
          onResume={onResume}
          onCancel={onCancel}
        />
      </DialogContent>
    </Dialog>
  )
}
