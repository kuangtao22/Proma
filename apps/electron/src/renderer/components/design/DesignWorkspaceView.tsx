import * as React from 'react'
import { RefreshCw, Sparkles, Upload } from 'lucide-react'
import { useAtomValue } from 'jotai'
import { createInitialDesignProjectState } from '@/atoms/design-atoms'
import type { DesignProjectState } from '@/atoms/design-atoms'
import { currentAgentWorkspaceIdAtom } from '@/atoms/agent-atoms'
import { Button } from '@/components/ui/button'
import { useDesignWorkspace } from './use-design-workspace'

export interface DesignWorkspaceStateViewProps {
  /** 当前项目的完整设计状态。 */
  state: DesignProjectState
  /** 重新加载失败项目。 */
  onRetry: () => void
  /** 重试提交保留在内存中的失败 mutation。 */
  onRetrySave: () => void
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
  onImportAssets,
  onCreateJob,
}: DesignWorkspaceStateViewProps): React.ReactElement {
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
  /** 只读项目仍显示画布内容，仅关闭写入口。 */
  const writable = state.snapshot.writable

  return (
    <div className="relative flex h-full min-h-0 flex-col bg-background">
      <div className="absolute left-3 top-3 z-10 flex max-w-[min(520px,calc(100%-24px))] flex-col gap-1">
        {!writable && (
          <p className="rounded border border-border bg-background/95 px-2 py-1 text-xs text-muted-foreground">
            {state.snapshot.readOnlyReason ?? '设计工作区当前为只读'}
          </p>
        )}
        {state.saveState === 'failed' && (
          <div className="flex items-center gap-2 rounded border border-destructive/40 bg-background/95 px-2 py-1">
            <p className="text-xs text-destructive">
              保存失败，内存修改已保留{state.error ? `：${state.error}` : ''}
            </p>
            <Button type="button" variant="outline" size="sm" onClick={onRetrySave}>
              <RefreshCw className="size-3.5" aria-hidden="true" />
              重试保存
            </Button>
          </div>
        )}
      </div>

      <div className="relative min-h-0 flex-1" data-design-canvas-slot>
        {isEmpty && (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="flex flex-wrap items-center justify-center gap-2 px-4">
              <Button type="button" variant="outline" disabled={!writable || !onImportAssets} onClick={onImportAssets}>
                <Upload className="size-4" aria-hidden="true" />
                导入图片
              </Button>
              <Button type="button" disabled={!writable || !onCreateJob} onClick={onCreateJob}>
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
  const { state, retry, retrySave } = useDesignWorkspace(projectId)

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
    />
  )
}
