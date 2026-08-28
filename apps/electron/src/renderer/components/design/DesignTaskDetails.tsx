import * as React from 'react'
import type {
  DesignJobRecord,
  DesignTaskDetails as DesignTaskDetailsData,
  DesignTraceEntry,
} from '@proma/shared'
import { ChevronDown, Copy, LoaderCircle, RotateCcw } from 'lucide-react'
import type {
  DesignProjectState,
  DesignTaskDetailsState,
} from '@/atoms/design-atoms'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import type { DesignAdapter } from '@/lib/design-adapter'
import { cn } from '@/lib/utils'

/** 任务详情控制器只依赖两个延迟读取 API。 */
type DesignTaskDetailsAdapter = Pick<DesignAdapter, 'getTaskDetails' | 'getTaskTrace'>

/** 任务详情控制器的可测试状态边界。 */
export interface DesignTaskDetailsControllerDependencies {
  projectId: string
  adapter: DesignTaskDetailsAdapter
  getState: () => DesignProjectState
  updateState: (
    update: Partial<DesignProjectState> | ((current: DesignProjectState) => Partial<DesignProjectState>),
  ) => void
}

/** 任务详情控制器公开命令。 */
export interface DesignTaskDetailsController {
  loadDetails: (jobId: string) => Promise<void>
  loadTrace: (jobId: string) => Promise<void>
}

/** 创建尚未读取的任务详情状态。 */
function createIdleDetailsState(): DesignTaskDetailsState {
  return {
    phase: 'idle',
    traceLoaded: false,
    traceLoading: false,
  }
}

/** 复制任务详情 Map 并更新单个执行尝试。 */
function updateTaskDetailsEntry(
  current: DesignProjectState,
  jobId: string,
  update: (entry: DesignTaskDetailsState) => DesignTaskDetailsState,
): Map<string, DesignTaskDetailsState> {
  const next = new Map(current.taskDetailsByJobId)
  next.set(jobId, update(next.get(jobId) ?? createIdleDetailsState()))
  return next
}

/**
 * 创建按 job 隔离的详情加载器。
 * 轻量详情和 trace 使用独立命令，恢复或删除清空 Map 后迟到结果自动失效。
 */
export function createDesignTaskDetailsController(
  dependencies: DesignTaskDetailsControllerDependencies,
): DesignTaskDetailsController {
  /** 首次选择任务只读取轻量详情，不触碰 JSONL trace。 */
  const loadDetails = async (jobId: string): Promise<void> => {
    const existing = dependencies.getState().taskDetailsByJobId.get(jobId)
    if (existing?.phase === 'loading' || existing?.phase === 'ready') return
    dependencies.updateState((current) => ({
      taskDetailsByJobId: updateTaskDetailsEntry(current, jobId, (entry) => ({
        ...entry,
        phase: 'loading',
        error: undefined,
      })),
    }))
    try {
      const details = await dependencies.adapter.getTaskDetails({
        projectId: dependencies.projectId,
        jobId,
      })
      dependencies.updateState((current) => {
        /** recovery、dispose 或删除已移除入口时，迟到详情不得复活。 */
        if (!current.taskDetailsByJobId.has(jobId)) return {}
        return {
          taskDetailsByJobId: updateTaskDetailsEntry(current, jobId, (entry) => ({
            ...entry,
            phase: 'ready',
            /** 状态刷新只替换轻量字段，已按需读取的 trace 继续保留。 */
            details: entry.traceLoaded && entry.details?.trace
              ? { ...details, trace: entry.details.trace }
              : details,
            error: undefined,
          })),
        }
      })
    } catch (error) {
      dependencies.updateState((current) => {
        if (!current.taskDetailsByJobId.has(jobId)) return {}
        return {
          taskDetailsByJobId: updateTaskDetailsEntry(current, jobId, (entry) => ({
            ...entry,
            phase: 'failed',
            error: error instanceof Error ? error.message : '加载任务详情失败',
          })),
        }
      })
    }
  }

  /** 用户首次展开 Thinking 或日志后才读取完整 trace。 */
  const loadTrace = async (jobId: string): Promise<void> => {
    const existing = dependencies.getState().taskDetailsByJobId.get(jobId)
    if (existing?.traceLoaded || existing?.traceLoading) return
    dependencies.updateState((current) => ({
      taskDetailsByJobId: updateTaskDetailsEntry(current, jobId, (entry) => ({
        ...entry,
        traceLoading: true,
        error: undefined,
      })),
    }))
    try {
      const details = await dependencies.adapter.getTaskTrace({
        projectId: dependencies.projectId,
        jobId,
      })
      dependencies.updateState((current) => {
        if (!current.taskDetailsByJobId.has(jobId)) return {}
        return {
          taskDetailsByJobId: updateTaskDetailsEntry(current, jobId, (entry) => ({
            ...entry,
            phase: 'ready',
            details,
            traceLoaded: true,
            traceLoading: false,
            error: undefined,
          })),
        }
      })
    } catch (error) {
      dependencies.updateState((current) => {
        if (!current.taskDetailsByJobId.has(jobId)) return {}
        return {
          taskDetailsByJobId: updateTaskDetailsEntry(current, jobId, (entry) => ({
            ...entry,
            phase: entry.details ? 'ready' : 'failed',
            traceLoading: false,
            error: error instanceof Error ? error.message : '加载执行记录失败',
          })),
        }
      })
    }
  }

  return { loadDetails, loadTrace }
}

/** Thinking 与普通执行日志的稳定分组结果。 */
export interface PartitionedDesignTrace {
  thinking: DesignTraceEntry[]
  logs: DesignTraceEntry[]
}

/** 把原始 Thinking 与可操作执行事件分开，避免混在同一长列表。 */
export function partitionDesignTrace(trace: DesignTraceEntry[] | undefined): PartitionedDesignTrace {
  const entries = trace ?? []
  return {
    thinking: entries.filter((entry) => entry.type === 'thinking'),
    logs: entries.filter((entry) => entry.type !== 'thinking'),
  }
}

/** trace 已读取但没有 Thinking 时返回明确说明，绝不根据日志补写推理。 */
export function getDesignThinkingMessage(state: DesignTaskDetailsState): string | null {
  if (!state.traceLoaded) return null
  const currentAttempt = state.details?.attempts.find((attempt) => (
    attempt.jobId === state.details?.currentJobId
  ))
  const { thinking } = partitionDesignTrace(state.details?.trace)
  if (currentAttempt?.rawThinkingAvailable === false || thinking.length === 0) {
    return '模型未返回原始 Thinking'
  }
  return null
}

/** 任务状态对应的简短中文标签。 */
const JOB_STATUS_LABELS: Record<DesignJobRecord['status'], string> = {
  queued: '等待执行',
  running: '执行中',
  succeeded: '已完成',
  failed: '失败',
  cancelled: '已取消',
  interrupted: '已中断',
}

/** 上下文模式对应的用户可见说明。 */
const CONTEXT_MODE_LABELS: Record<DesignJobRecord['contextMode'], string> = {
  auto: '自动匹配上下文',
  project: '使用项目上下文',
  none: '未使用项目上下文',
}

/** 去除 Renderer 旧版生成约束尾段，只展示用户真正输入的原始要求。 */
function getVisibleOriginalRequest(request: string): string {
  return request.split('\n\n[PROMA_DESIGN_CONSTRAINTS]\n', 1)[0]?.trim() || request
}

/** 将毫秒时间戳转换为紧凑中文日期。 */
function formatTimestamp(timestamp: number | undefined): string {
  if (timestamp === undefined) return '历史任务未记录此信息'
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(timestamp)
}

/** 把任务耗时转换为适合窄栏扫读的文本。 */
function formatDuration(startedAt: number | undefined, completedAt: number | undefined): string {
  if (startedAt === undefined || completedAt === undefined) return '历史任务未记录此信息'
  const duration = Math.max(0, completedAt - startedAt)
  return duration < 1_000 ? `${duration} 毫秒` : `${(duration / 1_000).toFixed(1)} 秒`
}

/** 详情区统一的标签和值，长文本允许自然换行。 */
function DetailField({ label, children }: {
  label: string
  children: React.ReactNode
}): React.ReactElement {
  return (
    <div className="space-y-1">
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <div className="min-w-0 whitespace-pre-wrap break-words text-xs leading-5 text-foreground">
        {children}
      </div>
    </div>
  )
}

/** 单条 trace 的紧凑时间线内容。 */
function TraceEntry({ entry }: { entry: DesignTraceEntry }): React.ReactElement {
  return (
    <li className={cn('border-l border-border pl-2', entry.isError && 'border-destructive/70')}>
      <div className="flex min-w-0 items-start justify-between gap-2">
        <span className="min-w-0 break-words text-xs font-medium">{entry.title}</span>
        <time className="shrink-0 text-[10px] text-muted-foreground">{formatTimestamp(entry.timestamp)}</time>
      </div>
      {entry.toolName && <p className="mt-0.5 break-all text-[10px] text-muted-foreground">{entry.toolName}</p>}
      {entry.content && <p className="mt-1 whitespace-pre-wrap break-words text-xs leading-5 text-muted-foreground">{entry.content}</p>}
    </li>
  )
}

export interface DesignTaskDetailsViewProps {
  job: DesignJobRecord
  detailsState: DesignTaskDetailsState
  onLoadDetails: () => void
  onLoadTrace: () => void
  onCopyPrompt?: (prompt: string) => void
  onRetry?: (jobId: string) => void
  onContinueFromVersion?: (assetId: string) => void
}

/** 可由旧 Design Inspector 与 Canvas 工作台复用的纯任务详情视图。 */
export function DesignTaskDetailsView({
  job,
  detailsState,
  onLoadDetails,
  onLoadTrace,
  onCopyPrompt,
  onRetry,
  onContinueFromVersion,
}: DesignTaskDetailsViewProps): React.ReactElement {
  const [thinkingOpen, setThinkingOpen] = React.useState(false)
  const [logsOpen, setLogsOpen] = React.useState(false)
  const traceRequested = React.useRef(false)
  React.useEffect(() => {
    if (detailsState.phase === 'idle') onLoadDetails()
  }, [detailsState.phase, onLoadDetails])
  React.useEffect(() => {
    /** trace 失败后允许用户收起再展开重试。 */
    if (!detailsState.traceLoading && !detailsState.traceLoaded && detailsState.error) {
      traceRequested.current = false
    }
  }, [detailsState.error, detailsState.traceLoaded, detailsState.traceLoading])

  /** 任一延迟区块首次展开只发起一次 trace 请求。 */
  const handleTraceDisclosure = (open: boolean): void => {
    if (!open || detailsState.traceLoaded || detailsState.traceLoading || traceRequested.current) return
    traceRequested.current = true
    onLoadTrace()
  }
  const details = detailsState.details
  const currentAttempt = details?.attempts.find((attempt) => attempt.jobId === details.currentJobId)
  const designSummary = currentAttempt?.designSummary ?? job.designSummary
  const finalImagePrompt = currentAttempt?.finalImagePrompt ?? job.finalImagePrompt
  const trace = partitionDesignTrace(details?.trace)
  const thinkingMessage = getDesignThinkingMessage(detailsState)
  const retryable = job.status === 'failed' || job.status === 'cancelled' || job.status === 'interrupted'

  return (
    <section className="space-y-3 px-3 py-3" aria-label="创作任务详情">
      <div className="flex min-w-0 items-center justify-between gap-2">
        <h3 className="text-xs font-semibold">创作任务</h3>
        <Badge variant="secondary" className="max-w-full rounded-sm text-[10px]">
          {JOB_STATUS_LABELS[job.status]}
        </Badge>
      </div>

      <div className="grid grid-cols-2 gap-x-3 gap-y-2">
        <DetailField label="生图模型">
          {job.imageModelSnapshot
            ? `${job.imageModelSnapshot.name} · ${job.imageModelSnapshot.modelId}`
            : '历史任务未记录此信息'}
        </DetailField>
        <DetailField label="上下文">{CONTEXT_MODE_LABELS[job.contextMode]}</DetailField>
        <DetailField label="开始时间">{formatTimestamp(job.startedAt)}</DetailField>
        <DetailField label="耗时">{formatDuration(job.startedAt, job.completedAt)}</DetailField>
      </div>

      <DetailField label="用户原始要求">{getVisibleOriginalRequest(job.originalRequest)}</DetailField>
      <DetailField label="设计摘要">{designSummary ?? '历史任务未记录此信息'}</DetailField>
      <DetailField label="精确生图提示词">
        <div className="flex min-w-0 items-start gap-1">
          <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">
            {finalImagePrompt ?? '历史任务未记录此信息'}
          </span>
          {finalImagePrompt && onCopyPrompt && (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="shrink-0"
              aria-label="复制精确生图提示词"
              onClick={() => onCopyPrompt(finalImagePrompt)}
            >
              <Copy aria-hidden="true" />
            </Button>
          )}
        </div>
      </DetailField>

      {job.contextReferences && job.contextReferences.length > 0 && (
        <DetailField label="实际使用的上下文">
          <ul className="space-y-1">
            {job.contextReferences.map((reference) => (
              <li key={reference.id} className="break-words">
                {reference.label}<span className="text-muted-foreground"> · {reference.purpose}</span>
              </li>
            ))}
          </ul>
        </DetailField>
      )}
      {job.contextWarning && <p className="break-words text-xs text-amber-600 dark:text-amber-500">{job.contextWarning}</p>}
      {job.error && <p className="break-words text-xs text-destructive">{job.error}</p>}
      {detailsState.phase === 'loading' && (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground" role="status">
          <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />加载任务详情
        </p>
      )}
      {detailsState.error && <p className="break-words text-xs text-destructive">{detailsState.error}</p>}
      {detailsState.phase === 'failed' && (
        <Button type="button" variant="outline" size="sm" onClick={onLoadDetails}>
          <RotateCcw aria-hidden="true" />重试加载详情
        </Button>
      )}

      <Collapsible
        open={thinkingOpen}
        onOpenChange={(open) => {
          setThinkingOpen(open)
          handleTraceDisclosure(open)
        }}
      >
        <CollapsibleTrigger asChild>
          <Button type="button" variant="ghost" size="sm" className="w-full justify-between px-1">
            模型原始 Thinking
            <ChevronDown className={cn('size-3.5 transition-transform', thinkingOpen && 'rotate-180')} aria-hidden="true" />
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className="pt-1">
          {detailsState.traceLoading ? (
            <p className="text-xs text-muted-foreground">正在加载 Thinking</p>
          ) : thinkingMessage ? (
            <p className="text-xs text-muted-foreground">{thinkingMessage}</p>
          ) : trace.thinking.length > 0 ? (
            <ul className="space-y-2">{trace.thinking.map((entry, index) => <TraceEntry key={`${entry.timestamp}-${index}`} entry={entry} />)}</ul>
          ) : (
            <p className="text-xs text-muted-foreground">展开后加载原始 Thinking</p>
          )}
        </CollapsibleContent>
      </Collapsible>

      <Collapsible
        open={logsOpen}
        onOpenChange={(open) => {
          setLogsOpen(open)
          handleTraceDisclosure(open)
        }}
      >
        <CollapsibleTrigger asChild>
          <Button type="button" variant="ghost" size="sm" className="w-full justify-between px-1">
            执行日志
            <ChevronDown className={cn('size-3.5 transition-transform', logsOpen && 'rotate-180')} aria-hidden="true" />
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className="pt-1">
          {detailsState.traceLoading ? (
            <p className="text-xs text-muted-foreground">正在加载执行日志</p>
          ) : trace.logs.length > 0 ? (
            <ul className="space-y-2">{trace.logs.map((entry, index) => <TraceEntry key={`${entry.timestamp}-${index}`} entry={entry} />)}</ul>
          ) : detailsState.traceLoaded ? (
            <p className="text-xs text-muted-foreground">没有可显示的执行日志</p>
          ) : (
            <p className="text-xs text-muted-foreground">展开后加载执行日志</p>
          )}
        </CollapsibleContent>
      </Collapsible>

      <DetailField label="尝试历史">
        {details?.attempts.length ? (
          <ol className="space-y-1.5">
            {details.attempts.map((attempt) => (
              <li key={attempt.jobId} className="flex min-w-0 items-start justify-between gap-2 border-l border-border pl-2">
                <span className="min-w-0 break-words">第 {attempt.attemptNumber} 次 · {JOB_STATUS_LABELS[attempt.status]}</span>
                <span className="shrink-0 text-[10px] text-muted-foreground">
                  {formatDuration(attempt.startedAt, attempt.completedAt)}
                </span>
              </li>
            ))}
          </ol>
        ) : '正在加载尝试历史'}
      </DetailField>

      <div className="flex flex-wrap gap-1.5">
        {retryable && onRetry && (
          <Button type="button" variant="outline" size="sm" onClick={() => onRetry(job.id)}>
            <RotateCcw aria-hidden="true" />重试
          </Button>
        )}
        {job.status === 'succeeded' && job.outputAssetId && onContinueFromVersion && (
          <Button type="button" variant="outline" size="sm" onClick={() => onContinueFromVersion(job.outputAssetId!)}>
            基于此版本继续
          </Button>
        )}
      </div>
    </section>
  )
}

/** 保持旧 Design Inspector 的必填动作合同不因 Canvas 复用而放宽。 */
export interface DesignTaskDetailsProps extends Omit<
  DesignTaskDetailsViewProps,
  'onCopyPrompt' | 'onRetry' | 'onContinueFromVersion'
> {
  onCopyPrompt: (prompt: string) => void
  onRetry: (jobId: string) => void
  onContinueFromVersion: (assetId: string) => void
}

/** 旧 Design Inspector 使用的兼容入口。 */
export function DesignTaskDetails(props: DesignTaskDetailsProps): React.ReactElement {
  return <DesignTaskDetailsView {...props} />
}
