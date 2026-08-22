import * as React from 'react'

export interface DesignInspectorProps {
  /** 当前设计工作区绑定的项目 ID。 */
  projectId: string
  /** 与现有右栏共享的可拖拽宽度。 */
  width?: number
}

/** Task 9 接入素材与版本状态前提供稳定的设计右栏挂载点。 */
export function DesignInspector({ projectId, width }: DesignInspectorProps): React.ReactElement {
  return (
    <aside
      className="h-full flex-shrink-0 bg-sidebar"
      style={{ width }}
      aria-label="设计检查器"
      data-project-id={projectId}
    />
  )
}
