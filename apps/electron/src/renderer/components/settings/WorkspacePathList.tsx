import * as React from 'react'
import { AlertTriangle, FolderInput, Loader2 } from 'lucide-react'
import type {
  PickWorkspaceTargetInput,
  WorkspacePathState,
  WorkspaceRelocationPreview,
  WorkspaceRelocationProgress,
  WorkspaceTargetSelection,
} from '@proma/shared'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { SettingsCard, SettingsRow, SettingsSection } from './primitives'

/** 项目路径动作需要的 renderer API，测试可注入窄替身。 */
export interface WorkspacePathActionDependencies {
  pickWorkspaceTarget(input: PickWorkspaceTargetInput): Promise<WorkspaceTargetSelection | null>
  previewWorkspaceRelocation(input: WorkspaceTargetSelection): Promise<WorkspaceRelocationPreview>
  confirmRelocation(preview: WorkspaceRelocationPreview): Promise<boolean>
  startWorkspaceRelocation(input: WorkspaceTargetSelection): Promise<WorkspaceRelocationProgress>
  relinkWorkspace(input: WorkspaceTargetSelection): Promise<void>
}

/** 严格执行“原生选择 -> 预检/确认 -> 迁移”或离线 relink 分支。 */
export async function requestWorkspacePathAction(
  workspace: WorkspacePathState,
  dependencies: WorkspacePathActionDependencies,
): Promise<'cancelled' | 'completed'> {
  /** 离线项目只允许重新绑定，不进入复制器。 */
  const purpose = workspace.availability === 'available' ? 'relocation' as const : 'relink' as const
  const selection = await dependencies.pickWorkspaceTarget({ workspaceId: workspace.workspaceId, purpose })
  if (selection === null) return 'cancelled'
  if (purpose === 'relink') {
    await dependencies.relinkWorkspace(selection)
    return 'completed'
  }
  const preview = await dependencies.previewWorkspaceRelocation(selection)
  if (!await dependencies.confirmRelocation(preview)) return 'cancelled'
  await dependencies.startWorkspaceRelocation(selection)
  return 'completed'
}

/** 项目路径列表属性。 */
export interface WorkspacePathListProps {
  workspaces: WorkspacePathState[]
  loading?: boolean
  error?: string
  onChanged?: () => void
}

/** 桌面设置风格的项目路径列表与迁移确认对话框。 */
export function WorkspacePathList({
  workspaces,
  loading = false,
  error,
  onChanged,
}: WorkspacePathListProps): React.ReactElement {
  /** 当前等待确认的项目。 */
  const [selectedWorkspace, setSelectedWorkspace] = React.useState<WorkspacePathState | null>(null)
  /** 当前服务端一次性授权。 */
  const [selection, setSelection] = React.useState<WorkspaceTargetSelection | null>(null)
  /** 当前只读预检结果。 */
  const [preview, setPreview] = React.useState<WorkspaceRelocationPreview | null>(null)
  /** 当前选目录、预检、迁移或 relink 的项目 ID。 */
  const [busyWorkspaceId, setBusyWorkspaceId] = React.useState<string | null>(null)
  /** 对话框或行级用户可见错误。 */
  const [actionError, setActionError] = React.useState<string | null>(null)
  /** 事件流覆盖首屏状态，避免等待完整状态刷新。 */
  const [progressByWorkspace, setProgressByWorkspace] = React.useState<Record<string, WorkspaceRelocationProgress>>({})

  React.useEffect(() => window.electronAPI.onWorkspaceRelocationProgress((progress) => {
    setProgressByWorkspace((current) => ({ ...current, [progress.workspaceId]: progress }))
    if (progress.stage === 'completed') onChanged?.()
  }), [onChanged])

  /** 清理确认对话框状态，Radix 会恢复触发按钮焦点。 */
  const closeDialog = (): void => {
    setSelectedWorkspace(null)
    setSelection(null)
    setPreview(null)
    setActionError(null)
  }

  /** 选择并预检迁移目标；离线项目直接执行原生授权 relink。 */
  const handleAction = async (workspace: WorkspacePathState): Promise<void> => {
    const purpose = workspace.availability === 'available' ? 'relocation' as const : 'relink' as const
    setBusyWorkspaceId(workspace.workspaceId)
    setActionError(null)
    try {
      const nextSelection = await window.electronAPI.pickWorkspaceTarget({
        workspaceId: workspace.workspaceId,
        purpose,
      })
      if (nextSelection === null) return
      if (purpose === 'relink') {
        await window.electronAPI.relinkWorkspace(nextSelection)
        onChanged?.()
        return
      }
      const nextPreview = await window.electronAPI.previewWorkspaceRelocation(nextSelection)
      setSelectedWorkspace(workspace)
      setSelection(nextSelection)
      setPreview(nextPreview)
    } catch (actionFailure) {
      setActionError(toErrorMessage(actionFailure, purpose === 'relink' ? '无法重定位项目' : '无法预检项目迁移'))
    } finally {
      setBusyWorkspaceId(null)
    }
  }

  /** 用户确认后消费 selection 并启动迁移。 */
  const handleConfirm = async (): Promise<void> => {
    if (selection === null || selectedWorkspace === null) return
    setBusyWorkspaceId(selectedWorkspace.workspaceId)
    setActionError(null)
    try {
      const progress = await window.electronAPI.startWorkspaceRelocation(selection)
      setProgressByWorkspace((current) => ({ ...current, [progress.workspaceId]: progress }))
      closeDialog()
      onChanged?.()
    } catch (startError) {
      setActionError(toErrorMessage(startError, '项目迁移失败'))
    } finally {
      setBusyWorkspaceId(null)
    }
  }

  /** copying 阶段允许显式取消；committing 会由主进程返回 false。 */
  const handleCancel = async (progress: WorkspaceRelocationProgress): Promise<void> => {
    setBusyWorkspaceId(progress.workspaceId)
    try {
      await window.electronAPI.cancelWorkspaceRelocation(progress.operationId)
    } catch (cancelError) {
      setActionError(toErrorMessage(cancelError, '无法取消项目迁移'))
    } finally {
      setBusyWorkspaceId(null)
    }
  }

  /** 当前对话框对应的即时进度。 */
  const dialogProgress = selectedWorkspace === null
    ? null
    : progressByWorkspace[selectedWorkspace.workspaceId] ?? selectedWorkspace.relocation

  return (
    <SettingsSection title="项目文件位置" description="管理每个项目实际使用的文件目录。">
      {loading ? (
        <WorkspaceListState icon={<Loader2 className="size-4 animate-spin" aria-hidden="true" />} text="正在读取项目路径..." />
      ) : error ? (
        <WorkspaceListState icon={<AlertTriangle className="size-4 text-destructive" aria-hidden="true" />} text={error} role="alert" />
      ) : workspaces.length === 0 ? (
        <WorkspaceListState icon={<FolderInput className="size-4" aria-hidden="true" />} text="暂无项目" />
      ) : (
        <SettingsCard>
          {workspaces.map((workspace) => {
            /** 优先使用最新事件进度。 */
            const progress = progressByWorkspace[workspace.workspaceId] ?? workspace.relocation
            const migrating = progress !== null && progress.stage !== 'completed' && progress.stage !== 'failed'
            const busy = busyWorkspaceId === workspace.workspaceId || migrating
            return (
              <SettingsRow
                key={workspace.workspaceId}
                label={workspace.name}
                icon={<FolderInput className="size-4 text-muted-foreground" aria-hidden="true" />}
                description={<WorkspacePathDescription workspace={workspace} progress={progress} />}
              >
                <div className="flex w-24 justify-end">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => void handleAction(workspace)}
                  >
                    {busyWorkspaceId === workspace.workspaceId ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
                    {getWorkspaceActionLabel(workspace)}
                  </Button>
                </div>
              </SettingsRow>
            )
          })}
        </SettingsCard>
      )}

      {actionError && selectedWorkspace === null ? (
        <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {actionError}
        </p>
      ) : null}

      <Dialog open={selectedWorkspace !== null} onOpenChange={(open) => { if (!open && busyWorkspaceId === null) closeDialog() }}>
        <DialogContent className="max-w-xl rounded-lg" aria-describedby="workspace-relocation-description">
          <DialogHeader>
            <DialogTitle>确认迁移项目文件</DialogTitle>
            <DialogDescription id="workspace-relocation-description">
              复制和校验完成后才会切换项目位置，原目录保留。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <WorkspacePathSummary label="源位置" path={preview?.sourceRoot ?? selectedWorkspace?.sourceRoot ?? '未知'} />
            <WorkspacePathSummary label="目标位置" path={preview?.targetRoot ?? selection?.targetRoot ?? '未知'} />
            <div className="grid grid-cols-2 gap-3 rounded-md border border-border/50 bg-muted/20 p-3 text-xs text-muted-foreground">
              <span>待迁移：{formatBytes(preview?.remainingBytes)}</span>
              <span>可用空间：{formatBytes(preview?.availableBytes)}</span>
            </div>
            {dialogProgress ? <WorkspaceProgress progress={dialogProgress} /> : null}
            {actionError ? (
              <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive">
                {actionError}
              </p>
            ) : null}
          </div>
          <DialogFooter>
            {dialogProgress?.stage === 'copying' ? (
              <Button variant="outline" disabled={busyWorkspaceId !== null} onClick={() => void handleCancel(dialogProgress)}>取消迁移</Button>
            ) : (
              <Button variant="outline" disabled={busyWorkspaceId !== null} onClick={closeDialog}>取消</Button>
            )}
            <Button disabled={busyWorkspaceId !== null || preview === null || dialogProgress !== null} onClick={() => void handleConfirm()}>
              {busyWorkspaceId !== null ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
              确认迁移
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SettingsSection>
  )
}

/** loading/error/empty 共用固定高度状态。 */
function WorkspaceListState({
  icon,
  text,
  role = 'status',
}: {
  icon: React.ReactNode
  text: string
  role?: 'status' | 'alert'
}): React.ReactElement {
  return <div role={role} className="flex min-h-20 items-center justify-center gap-2 rounded-md border border-border/50 bg-muted/20 text-sm text-muted-foreground">{icon}{text}</div>
}

/** 工作区类型决定可用项目的动作；离线状态优先重定位。 */
function getWorkspaceActionLabel(workspace: WorkspacePathState): '迁移' | '迁出' | '重定位' {
  if (workspace.availability !== 'available') return '重定位'
  return workspace.kind === 'managed' ? '迁出' : '迁移'
}

/** 路径、类型与进度在单行内保持稳定布局。 */
function WorkspacePathDescription({
  workspace,
  progress,
}: {
  workspace: WorkspacePathState
  progress: WorkspaceRelocationProgress | null
}): React.ReactElement {
  return (
    <div className="max-w-[34rem] space-y-1">
      <div className="truncate font-mono text-xs" title={workspace.sourceRoot}>{workspace.sourceRoot}</div>
      <div className="text-xs">{workspace.availability === 'available' ? (workspace.kind === 'managed' ? 'Proma 托管' : '外部目录') : '离线'}</div>
      {progress ? <WorkspaceProgress progress={progress} /> : null}
    </div>
  )
}

/** 固定高度项目进度，动态内容不会推动行布局。 */
function WorkspaceProgress({ progress }: { progress: WorkspaceRelocationProgress }): React.ReactElement {
  const percent = progress.totalBytes <= 0 ? 0 : Math.min(100, Math.round(progress.completedBytes / progress.totalBytes * 100))
  return (
    <div className="space-y-1" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
      <div className="h-1.5 w-full overflow-hidden rounded-sm bg-muted">
        <div className="h-full bg-primary transition-[width]" style={{ width: `${percent}%` }} />
      </div>
      <div className="h-4 truncate text-[11px] text-muted-foreground">{getProgressLabel(progress)}</div>
    </div>
  )
}

/** 映射项目迁移阶段与可重试错误。 */
function getProgressLabel(progress: WorkspaceRelocationProgress): string {
  if (progress.error) return progress.error
  if (progress.stage === 'preflight') return '正在检查目标'
  if (progress.stage === 'copying') return '正在复制'
  if (progress.stage === 'verifying') return '正在校验'
  if (progress.stage === 'committing') return '正在切换项目位置'
  if (progress.stage === 'failed') return '迁移已暂停'
  return '迁移完成'
}

/** 确认对话框路径摘要，完整值保留在 title。 */
function WorkspacePathSummary({ label, path }: { label: string; path: string }): React.ReactElement {
  return (
    <div className="rounded-md border border-border/50 px-3 py-2">
      <div className="mb-1 text-xs text-muted-foreground">{label}</div>
      <div className="truncate font-mono text-xs" title={path}>{path}</div>
    </div>
  )
}

/** 将字节数转换为稳定的对话框文本。 */
function formatBytes(bytes?: number): string {
  if (bytes === undefined) return '未知'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`
}

/** unknown 错误转换为中文 fallback。 */
function toErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim().length > 0 ? error.message : fallback
}
