import * as React from 'react'
import { LoaderCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { ServerOpsProjectDialogState } from './server-ops-project-controller'

/** 项目表单依赖；连接计数仅用于提示，删除安全边界由主进程保证。 */
interface ServerOpsProjectFormProps {
  dialog: NonNullable<ServerOpsProjectDialogState>
  submitting: boolean
  error: string | null
  projectCount: number
  connectionCount: number
  onSubmit: (name?: string) => void
  onClose: () => void
}

/** 项目管理弹窗允许空目标，以便保留稳定的 Radix 生命周期。 */
export interface ServerOpsProjectDialogProps extends Omit<ServerOpsProjectFormProps, 'dialog'> {
  dialog: ServerOpsProjectDialogState
  /** 受控弹窗没有 DialogTrigger，关闭动画结束后由所属工作区恢复焦点。 */
  onRestoreFocus?: () => void
}

/**
 * 项目名称与删除确认表单；输入草稿只在本次弹窗内存活。
 * @param props 当前操作、提交状态、计数与回调
 * @returns 可直接渲染验证的表单内容
 */
export function ServerOpsProjectForm({ dialog, submitting, error, projectCount, connectionCount, onSubmit, onClose }: ServerOpsProjectFormProps): React.ReactElement {
  /** 名称草稿，重命名时保留原名称。 */
  const [name, setName] = React.useState(dialog.kind === 'rename' ? dialog.project.name : '')
  /** 多个 Pane 各自独立的字段标识。 */
  const nameId = React.useId()
  /** 删除阻止原因，避免用户提交明显不能成功的操作。 */
  const deleteReason = dialog.kind !== 'delete' ? null
    : connectionCount > 0 ? `项目内还有 ${connectionCount} 个连接，请先移除这些连接后再删除项目。`
      : projectCount <= 1 ? '至少保留一个项目，添加其他项目后才能删除。' : null
  /** Enter 与按钮共用提交入口，中文输入法确认候选时不触发保存。 */
  const composingRef = React.useRef(false)

  return (
    <form className="space-y-5" aria-busy={submitting} onSubmit={(event) => {
      event.preventDefault()
      if (!submitting && !deleteReason && !composingRef.current) onSubmit(dialog.kind === 'delete' ? undefined : name)
    }}>
      {dialog.kind === 'delete' ? (
        <div className="space-y-2 text-sm leading-6">
          <p className="break-words">确定删除项目「{dialog.project.name}」？</p>
          <p className="text-xs text-muted-foreground">{deleteReason ?? '此项目没有连接，删除后将从项目列表中移除。'}</p>
        </div>
      ) : (
        <div className="space-y-2">
          <Label htmlFor={nameId}>项目名称</Label>
          <Input id={nameId} name="projectName" autoFocus required maxLength={60} value={name}
            placeholder="例如：生产环境" disabled={submitting} aria-invalid={Boolean(error)}
            aria-describedby={error ? `${nameId}-error` : undefined}
            onChange={(event) => setName(event.target.value)}
            onCompositionStart={() => { composingRef.current = true }}
            onCompositionEnd={() => { composingRef.current = false }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.nativeEvent.isComposing || composingRef.current)) event.preventDefault()
            }} />
          <p className="text-xs text-muted-foreground">最多 60 个字符，项目名称不能重复。</p>
        </div>
      )}
      {error ? <p id={`${nameId}-error`} role="alert" className="text-xs leading-5 text-destructive">{error}</p> : null}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" size="sm" disabled={submitting} onClick={onClose} autoFocus={dialog.kind === 'delete'}>取消</Button>
        <Button type="submit" size="sm" variant={dialog.kind === 'delete' ? 'destructive' : 'default'}
          disabled={submitting || Boolean(deleteReason) || (dialog.kind !== 'delete' && name.trim().length === 0)}>
          {submitting ? <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" /> : null}
          {dialog.kind === 'delete' ? '确认删除' : dialog.kind === 'create' ? '添加项目' : '保存名称'}
        </Button>
      </div>
    </form>
  )
}

/** 使用 Proma 既有模态样式，Escape 只关闭当前表单，不穿透到项目抽屉。 */
export function ServerOpsProjectDialog({ dialog, onRestoreFocus, ...props }: ServerOpsProjectDialogProps): React.ReactElement {
  return (
    <Dialog open={dialog !== null} onOpenChange={(open) => { if (!open && !props.submitting) props.onClose() }}>
      <DialogContent className="z-[260] w-[calc(100%-2rem)] max-w-sm" overlayClassName="z-[250]" hideClose={props.submitting}
        onCloseAutoFocus={onRestoreFocus ? (event) => { event.preventDefault(); onRestoreFocus() } : undefined}
        onEscapeKeyDown={(event) => { event.stopPropagation(); if (props.submitting) event.preventDefault() }}
        onPointerDownOutside={(event) => event.preventDefault()}>
        <DialogHeader>
          <DialogTitle>{dialog?.kind === 'delete' ? '删除项目' : dialog?.kind === 'rename' ? '修改项目名称' : '添加项目'}</DialogTitle>
          <DialogDescription>{dialog?.kind === 'delete' ? '仅支持删除没有连接的项目。' : dialog?.kind === 'rename' ? '修改名称不会影响项目内的连接。' : '按环境或用途整理服务器、数据库与 Redis。'}</DialogDescription>
        </DialogHeader>
        {dialog ? <ServerOpsProjectForm key={dialog.kind === 'create' ? 'create' : `${dialog.kind}:${dialog.project.id}`} dialog={dialog} {...props} /> : null}
      </DialogContent>
    </Dialog>
  )
}
