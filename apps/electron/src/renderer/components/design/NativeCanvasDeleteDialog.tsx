import * as React from 'react'
import type { CanvasNodeKind } from '@proma/shared'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { buttonVariants } from '@/components/ui/button'
import { cn } from '@/lib/utils'

/** 删除确认框的稳定公开文案。 */
export interface NativeCanvasDeleteDialogCopy {
  title: string
  edgeMessage: string
  retentionMessage: string
  confirmLabel: '删除节点' | '停止后删除'
}

/** 批量删除确认框需要的最小选区摘要。 */
export interface NativeCanvasDeleteSelectionSummary {
  count: number
  hasAgent: boolean
  hasContent: boolean
}

/** 可用于判断编辑器焦点的最小事件目标。 */
export interface NativeCanvasDeleteShortcutTarget {
  closest?: (selector: string) => unknown
}

/** 删除快捷键判断输入，保持可在无 DOM 测试中验证。 */
export interface NativeCanvasDeleteShortcutInput {
  key: string
  target: NativeCanvasDeleteShortcutTarget | null
}

/**
 * 生成删除确认框文案。
 * @param nodeTitle 待删除节点标题。
 * @param connectedEdgeCount 会随节点一起删除的关联边数量。
 * @param busy Agent 节点当前是否仍在运行。
 * @returns 不包含会话身份的稳定中文说明。
 */
export function getNativeCanvasDeleteDialogCopy(
  nodeTitle: string,
  connectedEdgeCount: number,
  busy: boolean,
  kind: CanvasNodeKind = 'agent',
  selection?: NativeCanvasDeleteSelectionSummary,
): NativeCanvasDeleteDialogCopy {
  /** 单节点调用沿用原有文案，批量调用只展示聚合事实。 */
  const count = selection?.count ?? 1
  const hasAgent = selection?.hasAgent ?? kind === 'agent'
  const hasContent = selection?.hasContent ?? kind !== 'agent'
  let retentionMessage = '内容将移入回收区，可稍后恢复。'
  if (hasAgent && hasContent) {
    retentionMessage = 'Agent 对话记录会保留；其他内容将移入回收区，可稍后恢复。'
  } else if (hasAgent) {
    retentionMessage = 'Agent 对话记录会保留。'
  }
  return {
    title: count > 1 ? `删除 ${count} 个节点？` : `删除“${nodeTitle}”？`,
    edgeMessage: connectedEdgeCount > 0
      ? `将同时删除 ${connectedEdgeCount} 条关联连线。`
      : '此节点没有关联连线。',
    retentionMessage,
    confirmLabel: busy && count === 1 ? '停止后删除' : '删除节点',
  }
}

/**
 * 判断键盘事件是否应打开画布删除确认。
 * @param input 当前按键与事件目标。
 * @returns Delete/Backspace 且焦点不在编辑控件内时返回 true。
 */
export function isNativeCanvasDeleteShortcut(input: NativeCanvasDeleteShortcutInput): boolean {
  if (input.key !== 'Delete' && input.key !== 'Backspace') return false
  /** 编辑控件内部按键只允许编辑内容，不能冒泡成画布节点删除。 */
  const editableTarget = input.target?.closest?.(
    'input, textarea, [contenteditable="true"], [role="textbox"]',
  )
  return !editableTarget
}

/** 原生 Canvas 删除确认框输入。 */
export interface NativeCanvasDeleteDialogProps {
  open: boolean
  nodeTitle: string
  connectedEdgeCount: number
  busy: boolean
  kind?: CanvasNodeKind
  selectedCount?: number
  hasAgent?: boolean
  hasContent?: boolean
  blockedMessage?: string | null
  submitting?: boolean
  error?: string | null
  onOpenChange: (open: boolean) => void
  onConfirm: (mode: 'delete' | 'stop-and-delete') => void
}

/** 删除节点前明确关联边影响和底层会话保留边界。 */
export function NativeCanvasDeleteDialog({
  open,
  nodeTitle,
  connectedEdgeCount,
  busy,
  kind = 'agent',
  selectedCount = 1,
  hasAgent = kind === 'agent',
  hasContent = kind !== 'agent',
  blockedMessage = null,
  submitting = false,
  error = null,
  onOpenChange,
  onConfirm,
}: NativeCanvasDeleteDialogProps): React.ReactElement {
  /** 文案只依赖公开节点标题、边数量和忙碌状态。 */
  const copy = getNativeCanvasDeleteDialogCopy(nodeTitle, connectedEdgeCount, busy, kind, {
    count: selectedCount,
    hasAgent,
    hasContent,
  })
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle>{copy.title}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2">
              <p>{copy.edgeMessage}</p>
              <p>{copy.retentionMessage}</p>
              {busy && selectedCount === 1
                ? <p>当前 Agent 正在运行，将在停止完成后删除节点。</p>
                : null}
              {blockedMessage ? <p className="text-destructive">{blockedMessage}</p> : null}
              {error ? <p className="text-destructive" role="alert">{error}</p> : null}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={submitting}>取消</AlertDialogCancel>
          <AlertDialogAction
            disabled={submitting || Boolean(blockedMessage)}
            className={cn(buttonVariants({ variant: 'destructive' }))}
            onClick={(event) => {
              event.preventDefault()
              onConfirm(busy && selectedCount === 1 ? 'stop-and-delete' : 'delete')
            }}
          >
            {submitting ? '正在处理' : copy.confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
