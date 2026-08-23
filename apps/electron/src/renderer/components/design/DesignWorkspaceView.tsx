import * as React from 'react'
import { RefreshCw, Sparkles, Upload } from 'lucide-react'
import { useAtomValue, useSetAtom } from 'jotai'
import {
  consumeDesignRecoveryRequestAtom,
  createInitialDesignProjectState,
  designRecoveryRequestsAtom,
  executeDesignEditAtom,
  redoDesignEditAtom,
  undoDesignEditAtom,
  updateDesignProjectStateAtom,
} from '@/atoms/design-atoms'
import type { DesignProjectState } from '@/atoms/design-atoms'
import { currentAgentWorkspaceIdAtom } from '@/atoms/agent-atoms'
import { Button } from '@/components/ui/button'
import { designAdapter } from '@/lib/design-adapter'
import {
  areDesignMutationsJobSafe,
  selectionContainsDesignJobNode,
} from '@/lib/design-editor'
import { DesignCanvas } from './DesignCanvas'
import { DesignToolbar } from './DesignToolbar'
import { useDesignInspectorActions } from './use-design-inspector-actions'
import {
  isDesignStructuralConflictBlocked,
  useDesignWorkspace,
} from './use-design-workspace'

export interface DesignWorkspaceStateViewProps {
  /** 当前项目的完整设计状态。 */
  state: DesignProjectState
  /** 重新加载失败项目。 */
  onRetry: () => void
  /** 重试提交保留在内存中的失败 mutation。 */
  onRetrySave: () => void
  /** 放弃本地结构冲突修改并采用远端版本。 */
  onAcceptRemoteVersion?: () => void
  /** 打开主进程图片选择器。 */
  onImportAssets?: () => void
  /** 打开空画布生成表单。 */
  onCreateJob?: () => void
}

/** 纯页面状态组件，保持加载、错误、只读和未保存反馈稳定。 */
export function DesignWorkspaceStateView({
  state,
  onRetry,
  onRetrySave,
  onAcceptRemoteVersion,
  onImportAssets,
  onCreateJob,
}: DesignWorkspaceStateViewProps): React.ReactElement {
  const updateProjectState = useSetAtom(updateDesignProjectStateAtom)
  const executeEdit = useSetAtom(executeDesignEditAtom)
  const undoEdit = useSetAtom(undoDesignEditAtom)
  const redoEdit = useSetAtom(redoDesignEditAtom)

  if (state.phase === 'loading' || state.phase === 'idle') {
    return (
      <div className="flex h-full items-center justify-center bg-background" role="status">
        <span className="animate-pulse text-sm text-muted-foreground">正在加载设计工作区</span>
      </div>
    )
  }

  if (state.phase === 'error' || !state.snapshot) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 bg-background px-6 text-center">
        <p className="text-sm text-destructive">{state.error ?? '设计工作区加载失败'}</p>
        <Button type="button" variant="outline" size="sm" onClick={onRetry}>重试</Button>
      </div>
    )
  }

  /** 空画布直接显示两个主操作，不增加说明型落地页。 */
  const isEmpty = state.snapshot.document.nodes.length === 0
  /** 冲突恢复期间关闭全部写入口，避免旧 pending 未解决时继续积累修改。 */
  const writable = state.snapshot.writable
    && !state.conflictRecoveryPending
    && state.authoritativeRecoveryState === 'idle'
  /** 远端快照已接管后才允许用户明确放弃本地结构冲突队列。 */
  const structuralConflictBlocked = isDesignStructuralConflictBlocked(state)
  /** 当前画布文档包含稳定项目 ID，可作为 Jotai 局部更新键。 */
  const projectId = state.snapshot.document.projectId
  /** job 选区禁用所有结构编辑入口，仅保留选择和移动。 */
  const selectionContainsJob = selectionContainsDesignJobNode(
    state.snapshot.document,
    state.selectedNodeIds,
  )
  /** 仅允许不会结构性改写 job 的最近历史项进入撤销。 */
  const undoEntry = state.history.at(-1)
  const canUndo = Boolean(undoEntry && areDesignMutationsJobSafe(state.snapshot.document, undoEntry.inverse))
  /** 仅允许不会结构性改写 job 的最近 future 项进入重做。 */
  const redoEntry = state.future.at(-1)
  const canRedo = Boolean(redoEntry && areDesignMutationsJobSafe(state.snapshot.document, redoEntry.forward))

  /**
   * 将工具栏模式切换写入当前项目隔离状态。
   * @param activeTool 用户选择的画布工具。
   * @returns 无返回值。
   */
  const handleToolChange = (activeTool: DesignProjectState['activeTool']): void => {
    updateProjectState({ projectId, update: { activeTool } })
  }

  /** 将当前节点选区建立为新分组。 */
  const handleGroup = (): void => {
    executeEdit({
      projectId,
      command: {
        type: 'group-selection',
        nodeIds: state.selectedNodeIds,
        groupId: globalThis.crypto.randomUUID(),
        name: `组 ${state.snapshot!.document.groups.length + 1}`,
      },
    })
  }

  /** 清除当前选中节点的分组归属并清理空组。 */
  const handleUngroup = (): void => {
    executeEdit({
      projectId,
      command: { type: 'ungroup-selection', nodeIds: state.selectedNodeIds },
    })
  }

  return (
    <div className="relative flex h-full min-h-0 flex-col bg-background">
      <div className="absolute left-3 top-14 z-10 flex max-w-[min(520px,calc(100%-24px))] flex-col gap-1">
        {!state.snapshot.writable && (
          <p className="rounded border border-border bg-background/95 px-2 py-1 text-xs text-muted-foreground">
            {state.snapshot.readOnlyReason ?? '设计工作区当前为只读'}
          </p>
        )}
        {state.authoritativeRecoveryState !== 'idle' && (
          <div className="flex items-center gap-2 rounded border border-destructive/40 bg-background/95 px-2 py-1">
            <p className="text-xs text-destructive">{state.error ?? '设计工作区恢复失败'}</p>
            {state.authoritativeRecoveryState === 'failed' && (
              <Button type="button" variant="outline" size="sm" onClick={onRetry}>
                <RefreshCw className="size-3.5" aria-hidden="true" />
                重试恢复
              </Button>
            )}
          </div>
        )}
        {state.authoritativeRecoveryState === 'idle' && state.saveState === 'failed' && (
          <div className="flex items-center gap-2 rounded border border-destructive/40 bg-background/95 px-2 py-1">
            <p className="text-xs text-destructive">
              保存失败，内存修改已保留{state.error ? `：${state.error}` : ''}
            </p>
            {!state.conflictRecoveryPending && (
              <Button type="button" variant="outline" size="sm" onClick={onRetrySave}>
                <RefreshCw className="size-3.5" aria-hidden="true" />
                重试保存
              </Button>
            )}
            {structuralConflictBlocked && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!onAcceptRemoteVersion}
                onClick={onAcceptRemoteVersion}
              >
                采用远端版本
              </Button>
            )}
          </div>
        )}
      </div>

      <div className="pointer-events-none absolute left-1/2 top-3 z-20 max-w-[calc(100%-24px)] -translate-x-1/2 overflow-x-auto">
        <div className="pointer-events-auto w-max">
          <DesignToolbar
            activeTool={state.activeTool}
            writable={writable}
            canUndo={canUndo}
            canRedo={canRedo}
            onToolChange={handleToolChange}
            onUndo={() => { undoEdit({ projectId }) }}
            onRedo={() => { redoEdit({ projectId }) }}
            onGroup={state.selectedNodeIds.length >= 2 && !selectionContainsJob ? handleGroup : undefined}
            onUngroup={state.selectedNodeIds.length > 0 && !selectionContainsJob ? handleUngroup : undefined}
            onArrowTool={() => { handleToolChange('arrow') }}
            onMaskTool={() => { handleToolChange('mask') }}
            onImportAssets={onImportAssets}
          />
        </div>
      </div>

      <div className="relative min-h-0 flex-1" data-design-canvas-slot>
        <DesignCanvas
          key={projectId}
          document={state.snapshot.document}
          thumbnailBaseUrl={state.snapshot.thumbnailBaseUrl}
          jobs={state.jobs}
          writable={writable}
          activeTool={state.activeTool}
          selectedNodeIds={state.selectedNodeIds}
          annotationDraft={state.maskDraft}
        />
        {isEmpty && (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
            <div className="flex flex-wrap items-center justify-center gap-2 px-4">
              <Button
                type="button"
                variant="outline"
                className="pointer-events-auto"
                disabled={!writable || !onImportAssets}
                onClick={onImportAssets}
              >
                <Upload className="size-4" aria-hidden="true" />
                导入图片
              </Button>
              <Button
                type="button"
                className="pointer-events-auto"
                disabled={!writable || !onCreateJob}
                onClick={onCreateJob}
              >
                <Sparkles className="size-4" aria-hidden="true" />
                AI 生成
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

/** 从当前项目读取隔离状态并渲染设计工作区。 */
export function DesignWorkspaceView(): React.ReactElement {
  const projectId = useAtomValue(currentAgentWorkspaceIdAtom)
  const recoveryRequests = useAtomValue(designRecoveryRequestsAtom)
  const consumeRecoveryRequest = useSetAtom(consumeDesignRecoveryRequestAtom)
  const updateProjectState = useSetAtom(updateDesignProjectStateAtom)
  const {
    state,
    retry,
    reloadAuthoritativeSnapshot,
    retrySave,
    acceptRemoteVersion,
  } = useDesignWorkspace(projectId)
  const assetActions = useDesignInspectorActions(projectId, designAdapter, {
    onRecoveryRequired: reloadAuthoritativeSnapshot,
  })

  React.useEffect(() => {
    if (!projectId || !recoveryRequests.has(projectId)) return
    /** 先消费一次性请求，再交给当前项目唯一 controller 执行权威重载。 */
    consumeRecoveryRequest({ projectId })
    reloadAuthoritativeSnapshot()
  }, [consumeRecoveryRequest, projectId, recoveryRequests, reloadAuthoritativeSnapshot])

  if (!projectId) {
    return (
      <div className="flex h-full items-center justify-center bg-background text-sm text-muted-foreground">
        请选择一个项目
      </div>
    )
  }
  return (
    <DesignWorkspaceStateView
      state={state ?? createInitialDesignProjectState()}
      onRetry={retry}
      onRetrySave={retrySave}
      onAcceptRemoteVersion={acceptRemoteVersion}
      onImportAssets={assetActions.importAssets}
      onCreateJob={() => updateProjectState({ projectId, update: { inspectorTab: 'ai' } })}
    />
  )
}
