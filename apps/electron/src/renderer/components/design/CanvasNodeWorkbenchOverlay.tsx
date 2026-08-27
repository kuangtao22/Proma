import * as React from 'react'
import type { CanvasNode, CanvasNodeKind } from '@proma/shared'
import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'

/** 节点工作台壳的最小受控输入。 */
export interface CanvasNodeWorkbenchOverlayProps {
  node: CanvasNode
  dirty: boolean
  onDirtyChange: (dirty: boolean) => void
  onClose: () => void
  children?: React.ReactNode
}

/** 返回四类节点的稳定中文名称。 */
export function getCanvasNodeKindLabel(kind: CanvasNodeKind): string {
  if (kind === 'agent') return 'Agent'
  if (kind === 'image') return '生图'
  if (kind === 'document') return '文档'
  return '原型'
}

/** 返回非 Agent 基础工作台的稳定下一步，不读取节点正文。 */
function getCanvasNodeNextAction(kind: Exclude<CanvasNodeKind, 'agent'>): string {
  if (kind === 'image') return '下一步：配置提示词并选择模型'
  if (kind === 'document') return '下一步：开始撰写内容'
  return '下一步：创建 HTML 原型'
}

/** 渲染随 XYFlow 节点移动的单一工作台壳。 */
export function CanvasNodeWorkbenchOverlay(
  props: CanvasNodeWorkbenchOverlayProps,
): React.ReactElement {
  /** 工作台标签只由稳定节点类型决定。 */
  const label = getCanvasNodeKindLabel(props.node.kind)
  return (
    <section
      className="nodrag nopan absolute left-0 top-[calc(100%+8px)] z-30 h-[min(620px,calc(100vh-9rem))] max-h-[620px] w-[min(720px,calc(100vw-2rem))] max-w-[720px] overflow-hidden rounded-[8px] border border-border bg-background text-foreground shadow-xl"
      aria-label={`${label}工作台`}
      data-workbench-dirty={props.dirty || undefined}
    >
      <header className="flex h-11 shrink-0 items-center justify-between gap-2 border-b border-border px-3">
        <span className="min-w-0 truncate text-sm font-medium">{props.node.title}</span>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          aria-label={`收起${label}工作台`}
          onClick={props.onClose}
        >
          <X className="size-4" aria-hidden="true" />
        </Button>
      </header>
      <div className="relative h-[calc(100%-2.75rem)] min-h-0 [&>aside]:static [&>aside]:h-full [&>aside]:max-w-none [&>aside]:border-l-0 [&>aside]:shadow-none [&>aside>header]:hidden">
        {props.children ?? (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center text-sm text-muted-foreground">
            <p>{label}节点已创建</p>
            {props.node.kind === 'agent'
              ? <p>Agent 对话暂不可用</p>
              : <p>{getCanvasNodeNextAction(props.node.kind)}</p>}
          </div>
        )}
      </div>
    </section>
  )
}
