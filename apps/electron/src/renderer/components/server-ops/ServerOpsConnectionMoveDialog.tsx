import * as React from 'react'
import { LoaderCircle } from 'lucide-react'
import type { ServerOpsProject } from '@proma/shared'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type { ServerOpsConnection } from './server-ops-connections'

/** 连接移动弹窗的受控属性。 */
export interface ServerOpsConnectionMoveDialogProps {
  connection: ServerOpsConnection | null
  projects: readonly ServerOpsProject[]
  targetProjectId: string
  submitting: boolean
  error: string | null
  onTargetChange: (projectId: string) => void
  onSubmit: () => void
  onClose: () => void
  /** 受控弹窗没有 DialogTrigger，关闭动画结束后由所属工作区恢复焦点。 */
  onRestoreFocus?: () => void
}

/** 可独立服务端渲染验证的移动表单属性。 */
export interface ServerOpsConnectionMoveFormProps extends Omit<ServerOpsConnectionMoveDialogProps, 'connection' | 'onRestoreFocus'> {
  connection: ServerOpsConnection
  /** 目标项目字段 ID；Dialog 使用 useId 注入，SSR 或直接函数测试可显式传入。 */
  targetId?: string
}

/**
 * 渲染连接移动表单；所有草稿由工作区控制，失败后可以保留目标重试。
 *
 * @param props 当前连接、项目、目标、提交状态和回调
 * @returns 可直接服务端渲染验证的表单
 */
export function ServerOpsConnectionMoveForm({
  connection,
  projects,
  targetProjectId,
  submitting,
  error,
  onTargetChange,
  onSubmit,
  onClose,
  targetId = 'server-ops-connection-move-target',
}: ServerOpsConnectionMoveFormProps): React.ReactElement {
  /** 当前归属项目，仅用于只读展示。 */
  const currentProject = projects.find((project) => project.id === connection.projectId)
  /** 可选目标排除当前项目，避免把无变化请求交给后端。 */
  const targetProjects = projects.filter((project) => project.id !== connection.projectId)
  /** 目标必须仍存在且不能等于当前项目，过期弹窗因此不能提交。 */
  const selectedTarget = targetProjects.find((project) => project.id === targetProjectId)
  /** 没有可选项目或目标无效时禁用确认。 */
  const submitDisabled = submitting || selectedTarget === undefined

  return (
    <form
      className="space-y-5"
      aria-busy={submitting}
      onSubmit={(event) => {
        event.preventDefault()
        if (!submitDisabled) onSubmit()
      }}
    >
      <dl className="grid grid-cols-[5rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm">
        <dt className="text-muted-foreground">连接</dt>
        <dd className="truncate font-medium" title={connection.label}>{connection.label}</dd>
        <dt className="text-muted-foreground">当前项目</dt>
        <dd className="truncate" title={currentProject?.name}>{currentProject?.name ?? '当前项目不可用'}</dd>
      </dl>

      <div className="space-y-2">
        <Label htmlFor={targetId}>目标项目</Label>
        {targetProjects.length === 0 ? (
          <p className="rounded-md border border-border/60 bg-muted/25 px-3 py-2 text-xs text-muted-foreground">
            请先添加其他项目，再移动此连接。
          </p>
        ) : (
          <Select
            value={selectedTarget?.id ?? ''}
            disabled={submitting}
            onValueChange={(projectId) => {
              if (!submitting) onTargetChange(projectId)
            }}
          >
            <SelectTrigger id={targetId} aria-invalid={targetProjectId.length > 0 && selectedTarget === undefined}>
              <SelectValue placeholder="选择目标项目" />
            </SelectTrigger>
            <SelectContent className="z-[9999]">
              {targetProjects.map((project) => (
                <SelectItem key={project.id} value={project.id} data-server-ops-move-target={project.id}>{project.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <p className="text-xs leading-5 text-muted-foreground">
          移动仅更改归属，原连接和跳板关系保持不变。
        </p>
      </div>

      {error ? <p role="alert" className="text-xs leading-5 text-destructive">{error}</p> : null}

      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" size="sm" disabled={submitting} onClick={onClose}>取消</Button>
        <Button type="submit" size="sm" disabled={submitDisabled}>
          {submitting ? <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" /> : null}
          {submitting ? '正在移动' : '确认移动'}
        </Button>
      </div>
    </form>
  )
}

/**
 * 使用与项目管理一致的高层级模态框，避免被项目抽屉或 Select Portal 遮挡。
 *
 * @param props 受控连接、项目、提交状态与回调
 * @returns 连接移动弹窗
 */
export function ServerOpsConnectionMoveDialog({
  connection,
  onRestoreFocus,
  ...props
}: ServerOpsConnectionMoveDialogProps): React.ReactElement {
  /** 每个 Pane 的目标字段使用独立 ID，避免 Label 关联到另一弹窗。 */
  const targetId = React.useId()
  return (
    <Dialog open={connection !== null} onOpenChange={(open) => { if (!open && !props.submitting) props.onClose() }}>
      <DialogContent
        className="z-[260] w-[calc(100%-2rem)] max-w-sm"
        overlayClassName="z-[250]"
        hideClose={props.submitting}
        onCloseAutoFocus={onRestoreFocus ? (event) => { event.preventDefault(); onRestoreFocus() } : undefined}
        onEscapeKeyDown={(event) => { event.stopPropagation(); if (props.submitting) event.preventDefault() }}
        onPointerDownOutside={(event) => { if (props.submitting) event.preventDefault() }}
      >
        <DialogHeader>
          <DialogTitle>移动到项目</DialogTitle>
          <DialogDescription>选择此连接的新归属项目。</DialogDescription>
        </DialogHeader>
        {connection ? (
          <ServerOpsConnectionMoveForm key={connection.id} connection={connection} targetId={targetId} {...props} />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
