import * as React from 'react'
import {
  LEGACY_DESIGN_CANVAS_ID,
  type CanvasSessionMeta,
} from '@proma/shared'
import { useAtomValue } from 'jotai'
import { Workflow } from 'lucide-react'
import {
  activeCanvasSessionAtom,
} from '@/atoms/canvas-session-atoms'
import { DesignWorkspaceView } from './DesignWorkspaceView'

/** Canvas 主区当前应挂载的工作区类型。 */
export type CanvasWorkspaceMode = 'missing' | 'legacy' | 'native'

/** 根据会话身份决定工作区分派，不依据当前项目猜测存储形态。 */
export function getCanvasWorkspaceMode(session: CanvasSessionMeta | null): CanvasWorkspaceMode {
  if (!session || session.archived) return 'missing'
  return session.id === LEGACY_DESIGN_CANVAS_ID ? 'legacy' : 'native'
}

export interface CanvasWorkspaceEntryStateViewProps {
  /** 当前会话对应的稳定工作区类型。 */
  mode: CanvasWorkspaceMode
  /** 当前 Canvas 轻量元数据。 */
  session: CanvasSessionMeta | null
  /** 只有 legacy 模式才会挂载的现有 Design 工作区。 */
  legacyWorkspace: React.ReactNode
}

/** 纯渲染分派层，确保原生 Canvas 不挂载旧 Design controller。 */
export function CanvasWorkspaceEntryStateView({
  mode,
  session,
  legacyWorkspace,
}: CanvasWorkspaceEntryStateViewProps): React.ReactElement {
  if (mode === 'legacy') return <>{legacyWorkspace}</>

  if (mode === 'missing') {
    return (
      <div className="flex h-full items-center justify-center bg-content-area px-6 text-center">
        <div className="flex max-w-sm flex-col items-center gap-2 text-muted-foreground">
          <Workflow className="size-6" aria-hidden="true" />
          <p className="text-[13px]">请选择一个 Canvas</p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full items-center justify-center bg-content-area px-6 text-center">
      <div className="flex max-w-sm flex-col items-center gap-2">
        <Workflow className="size-6 text-primary" aria-hidden="true" />
        <h2 className="text-[15px] font-medium text-foreground">{session?.title}</h2>
        <p className="text-[13px] text-muted-foreground">尚无节点</p>
      </div>
    </div>
  )
}

/** 从 Canvas registry 解析当前选择并挂载对应工作区。 */
export function CanvasWorkspaceEntry(): React.ReactElement {
  /** 派生 atom 已统一验证双重身份、归档状态和 legacy 兼容规则。 */
  const session = useAtomValue(activeCanvasSessionAtom)

  return (
    <CanvasWorkspaceEntryStateView
      mode={getCanvasWorkspaceMode(session)}
      session={session}
      legacyWorkspace={<DesignWorkspaceView />}
    />
  )
}
