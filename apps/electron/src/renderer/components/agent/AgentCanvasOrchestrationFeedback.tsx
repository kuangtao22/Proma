import * as React from 'react'
import { atom, useAtom, useStore } from 'jotai'
import { getCanvasOrchestrationProgress } from '@proma/shared'
import type { CanvasOrchestrationRecord } from '@proma/shared'
import { designAdapter } from '@/lib/design-adapter'
import { Button } from '@/components/ui/button'
import { AgentCanvasOrchestrationCard } from './AgentCanvasOrchestrationCard'
import { createAgentCanvasDecisionSender } from './agent-canvas-decision'
import { createAgentCanvasOrchestrationController } from './agent-canvas-orchestration-controller'
import type { AgentCanvasOrchestrationController, AgentCanvasOrchestrationControllerDependencies,
  AgentCanvasOrchestrationControllerState } from './agent-canvas-orchestration-controller'

/** 反馈视图只依赖现有只读 IPC，允许隔离交互验证注入内存 adapter。 */
export interface AgentCanvasFeedbackAdapter {
  listAgentCanvasBindings: AgentCanvasOrchestrationControllerDependencies['listBindings']
  onAgentCanvasBindingChanged: AgentCanvasOrchestrationControllerDependencies['onBindingChanged']
  getCanvasOrchestration: AgentCanvasOrchestrationControllerDependencies['getRecord']
  onCanvasOrchestrationChanged: AgentCanvasOrchestrationControllerDependencies['onChanged']
}

/** 普通聊天提供提交入口和忙碌状态，反馈视图不直接运行任何 Agent。 */
export interface AgentCanvasOrchestrationFeedbackProps {
  projectId: string
  sessionId: string
  canvasTitles: ReadonlyArray<{ id: string; title: string }>
  disabled: boolean
  onSend: (text: string) => Promise<boolean>
  adapter?: AgentCanvasFeedbackAdapter
}

/** 发送过程与可恢复错误属于当前视图，随会话卸载释放。 */
interface DecisionPresentation {
  busy: boolean
  errors: Record<string, string>
}

/** 在聊天中显示当前会话各个画布的业务阶段、变更影响及需用户回答的问题。 */
export function AgentCanvasOrchestrationFeedback({ projectId, sessionId, canvasTitles, disabled, onSend,
  adapter = designAdapter,
}: AgentCanvasOrchestrationFeedbackProps): React.ReactElement | null {
  /** 每个会话创建局部 Jotai atom，避免全局缓存跨会话残留或相互清理。 */
  const stateAtom = React.useMemo(() => atom<AgentCanvasOrchestrationControllerState>({ phase: 'idle', error: null, canvases: [] }), [projectId, sessionId])
  const decisionAtom = React.useMemo(() => atom<DecisionPresentation>({ busy: false, errors: {} }), [projectId, sessionId])
  const [state, setState] = useAtom(stateAtom)
  const [decisionState, setDecisionState] = useAtom(decisionAtom)
  const store = useStore()
  /** 回调读取当下的发送能力，不捕获上一轮 streaming 或旧发送闭包。 */
  const latestProps = React.useRef({ disabled, onSend })
  latestProps.current = { disabled, onSend }
  /** 控制器引用也作为卸载和切换目标后的发送失效标记。 */
  const controllerRef = React.useRef<AgentCanvasOrchestrationController | null>(null)
  const sender = React.useMemo(() => createAgentCanvasDecisionSender({
    getRecord: record => adapter.getCanvasOrchestration({ projectId: record.projectId, canvasId: record.canvasId }),
    isDisabled: () => latestProps.current.disabled || Boolean(store.get(stateAtom).error) || store.get(stateAtom).phase !== 'ready',
    isCurrent: record => Boolean(controllerRef.current && store.get(stateAtom).canvases.some(item =>
      item.canvasId === record.canvasId && !item.state.error && item.state.record?.id === record.id && item.state.record.ownerSessionId === sessionId)),
    send: text => latestProps.current.onSend(text),
  }), [adapter, sessionId, stateAtom, store])

  React.useEffect(() => {
    /** 已有关联订阅与每画布 revision 控制器负责合并读取，不额外轮询。 */
    const controller = createAgentCanvasOrchestrationController({
      projectId, sessionId, listBindings: input => adapter.listAgentCanvasBindings(input),
      onBindingChanged: (target, listener) => adapter.onAgentCanvasBindingChanged(target, listener),
      getRecord: target => adapter.getCanvasOrchestration(target),
      onChanged: (target, listener) => adapter.onCanvasOrchestrationChanged(target, listener),
      onStateChange: setState,
    })
    controllerRef.current = controller
    void controller.load()
    return () => { controllerRef.current = null; controller.dispose() }
  }, [adapter, projectId, sessionId, setState])

  /** 重试始终读权威状态，成功之前不把缓存报告冒充最新结果。 */
  const retry = (): void => {
    setDecisionState(current => ({ ...current, errors: {} }))
    void controllerRef.current?.retry()
  }
  /** 同步发送锁由 sender 持有；Jotai 只负责按钮和错误的可见反馈。 */
  const choose = async (record: CanvasOrchestrationRecord, optionId: string, title: string): Promise<void> => {
    if (store.get(decisionAtom).busy) return
    setDecisionState(current => ({ ...current, busy: true, errors: { ...current.errors, [record.canvasId]: '' } }))
    try {
      const outcome = await sender.choose(record, optionId, title)
      if (!controllerRef.current) return
      if (outcome === 'stale') {
        setDecisionState(current => ({ ...current, errors: { ...current.errors, [record.canvasId]: '任务或问题已更新，请查看最新内容后再选择。' } }))
        void controllerRef.current.retry()
      } else if (outcome === 'unavailable' || outcome === 'busy') {
        setDecisionState(current => ({ ...current, errors: { ...current.errors, [record.canvasId]: '当前暂不能提交，请等待消息处理完成后重试。' } }))
      }
    } catch {
      if (controllerRef.current) setDecisionState(current => ({ ...current, errors: { ...current.errors, [record.canvasId]: '答复未能发送，请重试。' } }))
    } finally {
      if (controllerRef.current) setDecisionState(current => ({ ...current, busy: false }))
    }
  }
  /** 未委托的关联画布保持安静；读取失败仍保留可操作的恢复入口。 */
  const visible = state.canvases.filter(item => item.state.record || item.state.error)
  if (!visible.length && !state.error) return null
  return <section aria-label="画布协作反馈" className="mx-2.5 mb-2 max-h-[min(42vh,25rem)] shrink-0 space-y-2 overflow-y-auto">
    {state.error && <div className="flex items-center gap-2 rounded-lg border border-border p-2 text-xs" role="alert">
      <span className="flex-1 text-destructive">{state.error}</span><Button type="button" variant="ghost" size="sm" disabled={state.phase === 'loading'} onClick={retry}>重试读取</Button>
    </div>}
    {visible.map(({ canvasId, state: canvasState }) => {
      /** registry 标题只用于展示，不用 UUID 做缺失回退。 */
      const title = canvasTitles.find(canvas => canvas.id === canvasId)?.title ?? '画布'
      const record = canvasState.record
      if (!record) return <div key={canvasId} className="flex items-center gap-2 rounded-lg border border-border p-2 text-xs" role="alert">
        <span className="flex-1 text-destructive">{title}：{canvasState.error}</span>
        <Button type="button" variant="ghost" size="sm" disabled={canvasState.phase === 'loading'} onClick={retry}>重试读取</Button>
      </div>
      return <AgentCanvasOrchestrationCard key={`${canvasId}:${record.id}`} record={record}
        progress={getCanvasOrchestrationProgress(record)} canvasTitle={title}
        decisionBusy={disabled || decisionState.busy || Boolean(state.error) || Boolean(canvasState.error) || state.phase !== 'ready'}
        decisionSent={sender.hasSubmitted(record)} error={canvasState.error ?? decisionState.errors[canvasId]} onRetry={canvasState.error ? retry : undefined}
        onDecision={optionId => { void choose(record, optionId, title) }} />
    })}
  </section>
}
