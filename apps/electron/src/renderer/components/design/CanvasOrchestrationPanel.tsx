import * as React from 'react'
import type {
  CanvasNode,
  CanvasOrchestrationChangedEvent,
  CanvasOrchestrationRecord,
  CanvasTarget,
} from '@proma/shared'
import { Check, ChevronDown, CircleDashed, CircleDot, LocateFixed, RotateCcw } from 'lucide-react'
import type { CanvasOrchestrationState } from '@/atoms/canvas-orchestration-atoms'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { bindCanvasWorkbenchWheel } from './canvas-workbench-wheel'

/** 面板公开复用 Jotai 中的轻量加载状态。 */
export type CanvasOrchestrationPanelState = CanvasOrchestrationState

/** 编排面板控制器依赖，读取不会触发普通 Canvas LOAD。 */
export interface CanvasOrchestrationControllerDependencies {
  target: CanvasTarget
  getRecord: (target: CanvasTarget) => Promise<CanvasOrchestrationRecord | null>
  onChanged: (
    target: CanvasTarget,
    listener: (event: CanvasOrchestrationChangedEvent) => void,
  ) => () => void
  onStateChange: (state: CanvasOrchestrationPanelState) => void
}

/** 编排面板控制器公开生命周期。 */
export interface CanvasOrchestrationController {
  load: () => Promise<void>
  whenIdle: () => Promise<void>
  dispose: () => void
}

/** 创建当前画布使用的轻量编排读取与事件订阅控制器。 */
export function createCanvasOrchestrationController(
  dependencies: CanvasOrchestrationControllerDependencies,
): CanvasOrchestrationController {
  /** 控制器持有最新状态，异步结果不读取 React 旧闭包。 */
  let state: CanvasOrchestrationPanelState = { phase: 'idle', record: null, error: null }
  /** 卸载后递增代次，阻止旧画布迟到结果回写。 */
  let generation = 0
  /** 同一画布同时只保留一个轻量 GET。 */
  let activeRequest: Promise<void> | null = null
  /** 读取期间到达的事件只合并为一次补读，禁止退化为轮询。 */
  let refreshQueued = false
  let disposed = false

  /** 发布完整状态，保持 Jotai 更新入口简单。 */
  const updateState = (update: Partial<CanvasOrchestrationPanelState>): void => {
    state = { ...state, ...update }
    dependencies.onStateChange(state)
  }

  /** 确认记录仍属于当前双身份，避免错误 handler 污染其它画布。 */
  const matchesTarget = (record: CanvasOrchestrationRecord): boolean => (
    record.projectId === dependencies.target.projectId
    && record.canvasId === dependencies.target.canvasId
  )

  /** 读取一次记录；若读取期间收到更高 revision，完成后再轻量补读。 */
  const refresh = (): Promise<void> => {
    if (activeRequest) return activeRequest
    const requestGeneration = generation
    updateState({ phase: 'loading' })
    activeRequest = dependencies.getRecord(dependencies.target).then((record) => {
      if (disposed || requestGeneration !== generation) return
      if (record && !matchesTarget(record)) throw new Error('CANVAS_ORCHESTRATION_TARGET_MISMATCH')
      updateState({ phase: 'ready', record, error: null })
    }).catch(() => {
      if (disposed || requestGeneration !== generation) return
      updateState({
        phase: state.record ? 'ready' : 'error',
        error: '制作流程暂时无法加载。',
      })
    }).finally(() => {
      if (requestGeneration !== generation) return
      activeRequest = null
      if (!disposed && refreshQueued) {
        refreshQueued = false
        void refresh()
      }
    })
    return activeRequest
  }

  /** 只响应 adapter 已按当前画布过滤后的更高编排 revision。 */
  const release = dependencies.onChanged(dependencies.target, (event) => {
    const currentRevision = state.record?.revision ?? -1
    if (event.revision <= currentRevision) return
    if (activeRequest) refreshQueued = true
    void refresh()
  })

  return {
    load: refresh,
    whenIdle: async () => {
      /** 补读可能在前一个请求 finally 中建立，因此循环直到真正空闲。 */
      while (activeRequest) await activeRequest
    },
    dispose: () => {
      if (disposed) return
      disposed = true
      generation += 1
      release()
    },
  }
}

/** 编排总状态使用稳定中文标签。 */
const RECORD_STATUS_LABELS: Record<CanvasOrchestrationRecord['status'], string> = {
  planning: '规划中',
  running: '进行中',
  waiting: '等待中',
  blocked: '已阻塞',
  completed: '已完成',
  cancelled: '已取消',
}

/** 阶段状态使用稳定中文标签。 */
const STEP_STATUS_LABELS: Record<CanvasOrchestrationRecord['steps'][number]['status'], string> = {
  planned: '待开始',
  running: '运行中',
  'needs-review': '待评审',
  completed: '已完成',
  blocked: '已阻塞',
}

/** 根据阶段状态选择图标，颜色只使用现有主题语义。 */
function CanvasOrchestrationStepIcon({
  status,
}: {
  status: CanvasOrchestrationRecord['steps'][number]['status']
}): React.ReactElement {
  if (status === 'completed') return <Check className="size-3.5 text-primary" aria-hidden="true" />
  if (status === 'running') return <CircleDot className="size-3.5 text-primary" aria-hidden="true" />
  return <CircleDashed className="size-3.5 text-muted-foreground" aria-hidden="true" />
}

/** 编排计划面板输入；节点仅用于把真实输出身份映射为可读导航。 */
export interface CanvasOrchestrationPanelProps {
  state: CanvasOrchestrationPanelState
  nodes: readonly CanvasNode[]
  onNavigate: (nodeId: string) => void
  onRetry: () => void
  defaultOpen?: boolean
}

/** 展示当前画布的目标、阶段角色、说明和真实输出节点。 */
export function CanvasOrchestrationPanel({
  state,
  nodes,
  onNavigate,
  onRetry,
  defaultOpen = false,
}: CanvasOrchestrationPanelProps): React.ReactElement | null {
  const [open, setOpen] = React.useState(defaultOpen)
  const panelRef = React.useRef<HTMLElement | null>(null)
  const record = state.record
  const recordId = record?.id
  /** 首读错误同样挂载面板，手势绑定应随外壳出现，而非只随成功记录出现。 */
  const panelVisible = Boolean(record || state.error)
  /** 节点与步骤索引只随权威输入变化，不跟随画布视口逐帧重建。 */
  const nodesById = React.useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes])
  const completedCount = React.useMemo(
    () => record?.steps.filter((step) => step.status === 'completed').length ?? 0,
    [record],
  )
  React.useEffect(() => {
    const panel = panelRef.current
    if (!panel) return
    return bindCanvasWorkbenchWheel(panel, () => false)
  }, [recordId, panelVisible])
  /** 首读错误没有记录时仍提供轻量恢复入口；真正未委托的 ready + null 保持隐藏。 */
  if (!record) {
    if (!state.error) return null
    return (
      <aside
        ref={panelRef}
        className="absolute left-3 top-14 z-10 flex w-[min(19rem,calc(100%-1.5rem))] items-center gap-2 rounded-[8px] border border-border/70 bg-background/95 p-2.5 shadow-md backdrop-blur"
        aria-label="画布制作流程加载失败"
        data-canvas-orchestration-panel
        onPointerDown={(event) => event.stopPropagation()}
      >
        <p className="min-w-0 flex-1 text-[11px] leading-4 text-destructive" role="alert">{state.error}</p>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-7 shrink-0 gap-1 px-2 text-[11px]"
          disabled={state.phase === 'loading'}
          onClick={onRetry}
        >
          <RotateCcw className={`size-3.5 ${state.phase === 'loading' ? 'animate-spin' : ''}`} aria-hidden="true" />
          重试
        </Button>
      </aside>
    )
  }

  return (
    <aside
      ref={panelRef}
      className="absolute left-3 top-14 z-10 w-[min(19rem,calc(100%-1.5rem))] overflow-hidden rounded-[8px] border border-border/70 bg-background/95 shadow-md backdrop-blur"
      aria-label="画布制作流程"
      data-canvas-orchestration-panel
      onPointerDown={(event) => event.stopPropagation()}
    >
      <Collapsible open={open} onOpenChange={setOpen}>
        <div className="flex min-w-0 items-start gap-2 p-2.5">
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2">
              <p className="truncate text-xs font-medium text-foreground" title={record.request.goal}>
                {record.request.goal}
              </p>
              <span className="shrink-0 text-[11px] text-primary">{RECORD_STATUS_LABELS[record.status]}</span>
            </div>
            <p className="mt-1 line-clamp-2 text-[11px] leading-4 text-muted-foreground">{record.summary}</p>
          </div>
          <CollapsibleTrigger asChild>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-7 shrink-0 gap-1 px-1.5 text-[11px]"
              aria-label={open ? '收起制作阶段' : '展开制作阶段'}
            >
              {completedCount}/{record.steps.length}
              <ChevronDown className={`size-3.5 transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden="true" />
            </Button>
          </CollapsibleTrigger>
        </div>
        <CollapsibleContent>
          <ol
            className="max-h-[min(52vh,24rem)] space-y-2 overflow-y-auto border-t border-border/70 p-2.5"
          >
            {record.steps.map((step) => (
              <li key={step.id} className="rounded-[6px] border border-border/60 bg-muted/30 p-2">
                <div className="flex min-w-0 items-center gap-1.5">
                  <CanvasOrchestrationStepIcon status={step.status} />
                  <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground" title={step.title}>{step.title}</span>
                  <span className="max-w-20 shrink-0 truncate text-[10px] text-muted-foreground" title={step.role}>{step.role}</span>
                  <span className="shrink-0 text-[10px] text-muted-foreground">{STEP_STATUS_LABELS[step.status]}</span>
                </div>
                {step.note ? <p className="mt-1.5 text-[11px] leading-4 text-muted-foreground">{step.note}</p> : null}
                {step.outputNodeIds.length > 0 ? (
                  <div className="mt-1.5 flex flex-wrap gap-1" aria-label={`${step.title}输出节点`}>
                    {step.outputNodeIds.map((nodeId) => {
                      const node = nodesById.get(nodeId)
                      const label = node?.title || `节点 ${nodeId.slice(-6)}`
                      return (
                        <Button
                          key={nodeId}
                          type="button"
                          size="sm"
                          variant="ghost"
                          className="h-6 max-w-full gap-1 px-1.5 text-[10px]"
                          aria-label={`定位输出节点：${label}`}
                          disabled={!node}
                          onClick={() => onNavigate(nodeId)}
                        >
                          <LocateFixed className="size-3" aria-hidden="true" />
                          <span className="truncate">{label}</span>
                        </Button>
                      )
                    })}
                  </div>
                ) : null}
              </li>
            ))}
          </ol>
        </CollapsibleContent>
      </Collapsible>
      {state.error ? (
        <div className="flex items-center gap-2 border-t border-border/70 px-2.5 py-2">
          <p className="min-w-0 flex-1 text-[11px] text-destructive" role="alert">{state.error}</p>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-7 shrink-0 gap-1 px-2 text-[11px]"
            disabled={state.phase === 'loading'}
            onClick={onRetry}
          >
            <RotateCcw className={`size-3.5 ${state.phase === 'loading' ? 'animate-spin' : ''}`} aria-hidden="true" />
            重试
          </Button>
        </div>
      ) : null}
    </aside>
  )
}
