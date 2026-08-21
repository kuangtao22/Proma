import * as React from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  FolderOpen,
  HardDrive,
  Loader2,
  RefreshCw,
} from 'lucide-react'
import { toast } from 'sonner'
import type { DataRootMigrationStatus, OpenDataRootTarget, PathManagementState } from '@proma/shared'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { copyTextToClipboard } from '@/lib/clipboard'
import { SettingsCard, SettingsRow, SettingsSection } from './primitives'

const ARCHIVE_MIGRATION_PROMPT = `请帮我创建一个可迁移的 Proma 数据压缩包。

Proma 的本地数据通常存放在 ~/.proma。请按以下步骤处理：

1. 先确认当前 Proma 数据文件夹的位置、计划生成的 ZIP 路径，以及压缩包是否可能包含会话记录、工作区配置和本地文件。
2. 在开始压缩前向我展示范围并征得确认；不要删除、移动或修改原始数据文件夹。
3. 将完整的 .proma 数据文件夹压缩为一个 ZIP 文件，并告诉我生成路径和文件大小。
4. 提醒我将 ZIP 通过可信方式传输到新设备，并在新设备的 Proma 对话中附上该 ZIP，执行恢复、项目路径分配和索引重建。
5. 不要尝试导出系统钥匙串、OAuth 登录或其他系统级凭据；这些内容需要在新设备上重新登录或配置。`

const RESTORE_MIGRATION_PROMPT = `我正在恢复来自另一台设备的 Proma 数据，并已附上旧设备 .proma 文件夹的 ZIP 压缩包。

请按以下步骤处理：

1. 先检查 ZIP 的内容，并说明将要写入的此设备 Proma 数据目录以及可能覆盖的文件；在任何覆盖前征得我的确认，并为现有数据创建可恢复备份。
2. 将压缩包解压到此设备的 Proma 数据目录，按当前版本的数据结构完成必要迁移。
3. 为每个恢复的工作区核对对应的本地项目目录；旧设备路径不可用时，询问我如何重新分配或跳过。
4. 重建会话、工作区和本地文件索引，检查恢复的数据是否能正常读取。
5. 完成后说明恢复的会话、工作区和需要重新绑定的本地项目；不要尝试恢复系统钥匙串、API Key 或 OAuth 登录，缺失的凭据请提示我重新配置。`

/** 设置页使用的稳定路径状态，避免 JSX 分散判断迁移阻断条件。 */
export interface PathManagementSettingsView {
  /** 当前内容状态。 */
  kind: 'loading' | 'ready' | 'blocked' | 'error'
  /** 是否禁止创建新的数据根迁移计划。 */
  migrationBlocked: boolean
  /** 用户可见的当前状态摘要。 */
  statusLabel: string
}

/** 把主进程路径状态转换为设置页可直接渲染的视图。 */
export function createPathManagementSettingsView(
  state: PathManagementState | null,
  error?: string,
): PathManagementSettingsView {
  if (error !== undefined) return { kind: 'error', migrationBlocked: true, statusLabel: error }
  if (state === null) return { kind: 'loading', migrationBlocked: true, statusLabel: '正在读取数据位置...' }
  if (state.migration !== null) {
    return {
      kind: 'blocked',
      migrationBlocked: true,
      statusLabel: getMigrationStatusLabel(state.migration.stage, state.migration.error),
    }
  }
  if (state.postCommitCleanup !== undefined) {
    /** cleanup 错误必须明确保留，不能把已切换误报为完整完成。 */
    const detail = state.postCommitCleanup.error ?? '正在清理迁移断点'
    return {
      kind: 'blocked',
      migrationBlocked: true,
      statusLabel: `迁移已切换，但清理尚未完成：${detail}`,
    }
  }
  if (state.availability !== 'available' || state.activeRoot === null) {
    return { kind: 'blocked', migrationBlocked: true, statusLabel: '当前数据位置不可用，请重启 Proma 进入恢复流程' }
  }
  return { kind: 'ready', migrationBlocked: false, statusLabel: '当前数据位置可用' }
}

/** 迁移按钮依赖，便于以真实调用顺序覆盖选择、确认与启动行为。 */
export interface DataRootMigrationRequestDependencies {
  /** 打开系统目录选择器。 */
  pickDataRoot: () => Promise<string | null>
  /** 显示迁移确认对话框。 */
  confirmMigration: (targetRoot: string) => Promise<boolean>
  /** 创建迁移计划并请求重启。 */
  startDataRootMigration: (targetRoot: string) => Promise<void>
}

/** 严格按选择、确认、启动顺序请求迁移，不直接修改 locator。 */
export async function requestDataRootMigration(
  state: PathManagementState,
  dependencies: DataRootMigrationRequestDependencies,
): Promise<'cancelled' | 'started'> {
  if (createPathManagementSettingsView(state).migrationBlocked) {
    throw new Error('当前路径状态不允许创建新的迁移计划')
  }
  /** 用户通过系统选择器授权的目标目录。 */
  const targetRoot = await dependencies.pickDataRoot()
  if (targetRoot === null) return 'cancelled'
  /** 只有明确确认后才允许主进程创建计划。 */
  const confirmed = await dependencies.confirmMigration(targetRoot)
  if (!confirmed) return 'cancelled'
  await dependencies.startDataRootMigration(targetRoot)
  return 'started'
}

/** 返回已知数据根设备类型对应的断连或性能提醒。 */
export function getDataRootDeviceRisk(deviceType: PathManagementState['deviceType']): string | null {
  if (deviceType === 'network') return '网络数据位置断连时 Proma 将无法启动，访问性能也取决于网络质量。'
  if (deviceType === 'removable') return '可移动设备拔出后 Proma 将无法启动，设备性能会影响会话与附件读写。'
  return null
}

/** 用最新迁移状态覆盖页面状态，并在 cleanup 消失时移除旧字段。 */
export function mergePathManagementStatus(
  state: PathManagementState,
  status: DataRootMigrationStatus,
): PathManagementState {
  /** 排除旧 cleanup，避免对象展开把已完成状态重新带回界面。 */
  const { postCommitCleanup: _staleCleanup, ...baseState } = state
  return {
    ...baseState,
    migration: status.migration,
    ...(status.postCommitCleanup === undefined ? {} : { postCommitCleanup: status.postCommitCleanup }),
  }
}

/** 数据位置区块属性。 */
export interface DataRootLocationSectionProps {
  /** 当前路径管理状态。 */
  state: PathManagementState
  /** 当前稳定视图状态。 */
  view?: PathManagementSettingsView
  /** 是否正在执行路径操作。 */
  isBusy?: boolean
  /** 打开可信 locator 中的数据根。 */
  onOpenRoot?: (target: OpenDataRootTarget) => void
  /** 启动迁移选择流程。 */
  onMigrate?: () => void
}

/** 展示当前与上次数据根；旧根始终只读，不提供删除入口。 */
export function DataRootLocationSection({
  state,
  view = createPathManagementSettingsView(state),
  isBusy = false,
  onOpenRoot,
  onMigrate,
}: DataRootLocationSectionProps): React.ReactElement {
  /** 当前状态对应的图标与颜色。 */
  const statusAvailable = state.availability === 'available'
  return (
    <SettingsSection
      title="Proma 数据位置"
      description="会话、附件、Skills、配置和运行数据统一存放在此位置。"
      action={onMigrate ? (
        <Button disabled={isBusy || view.migrationBlocked} onClick={onMigrate} className="gap-2">
          {isBusy ? <Loader2 className="animate-spin" aria-hidden="true" /> : <HardDrive aria-hidden="true" />}
          迁移位置
        </Button>
      ) : undefined}
    >
      <SettingsCard className="rounded-lg">
        <SettingsRow
          label="当前路径"
          icon={<HardDrive className="size-4 text-muted-foreground" aria-hidden="true" />}
          description={<PathValue path={state.activeRoot ?? '未定位'} />}
        >
          <PathActions
            path={state.activeRoot}
            openLabel="打开当前路径"
            disabled={isBusy || state.activeRoot === null}
            onOpen={() => onOpenRoot?.('current')}
          />
        </SettingsRow>
        <SettingsRow
          label="状态"
          icon={statusAvailable
            ? <CheckCircle2 className="size-4 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
            : <AlertTriangle className="size-4 text-destructive" aria-hidden="true" />}
          description={view.statusLabel}
        >
          <div className="text-right text-xs text-muted-foreground">
            <div>{getAvailabilityLabel(state.availability)} · {getDeviceTypeLabel(state.deviceType)}</div>
            <div className="mt-1 tabular-nums">已占用 {formatBytes(state.occupiedBytes)} · 可用 {formatBytes(state.availableBytes)}</div>
          </div>
        </SettingsRow>
        {state.previousRoot !== undefined ? (
          <SettingsRow
            label="上次路径（只读保留）"
            icon={<RefreshCw className="size-4 text-muted-foreground" aria-hidden="true" />}
            description={<PathValue path={state.previousRoot} />}
          >
            <PathActions
              path={state.previousRoot}
              openLabel="打开上次路径"
              disabled={isBusy}
              onOpen={() => onOpenRoot?.('previous')}
            />
          </SettingsRow>
        ) : null}
      </SettingsCard>
      {getDataRootDeviceRisk(state.deviceType) ? (
        <p className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs leading-5 text-amber-800 dark:text-amber-200">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          {getDataRootDeviceRisk(state.deviceType)}
        </p>
      ) : null}
    </SettingsSection>
  )
}

/** 跨设备 ZIP 迁移区块，保留原设置页的全部文案与动作。 */
export function CrossDeviceMigrationSection(): React.ReactElement {
  /** 打开当前可信数据根。 */
  const handleOpenDataFolder = async (): Promise<void> => {
    try {
      await window.electronAPI.openDataRoot('current')
    } catch (error) {
      toast.error(toErrorMessage(error, '无法打开数据文件夹'))
    }
  }
  /** 复制固定迁移提示词并展示结果。 */
  const handleCopyPrompt = (prompt: string, successMessage: string): void => {
    void copyTextToClipboard(prompt).then(
      () => toast.success(successMessage),
      () => toast.error('复制失败，请手动复制提示词'),
    )
  }

  return (
    <>
      <SettingsSection
        title="跨设备迁移"
        description="通过 ZIP 在设备之间搬移数据；原始数据文件夹不会被删除。"
      >
        <ol className="space-y-2 text-sm leading-6 text-muted-foreground">
          <li>1. 在当前设备将完整的 .proma 数据文件夹压缩为 ZIP。</li>
          <li>2. 通过可信方式将 ZIP 传输到新设备，并附到 Proma 对话。</li>
          <li>3. 在新设备恢复数据、重新分配项目目录并重建索引。</li>
        </ol>
      </SettingsSection>
      <SettingsSection
        title="当前设备：创建迁移压缩包"
        description="先打开数据文件夹，再由 Agent 按确认范围创建 ZIP。"
      >
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => void handleOpenDataFolder()}>
            <FolderOpen aria-hidden="true" />打开数据文件夹
          </Button>
          <Button
            variant="outline"
            onClick={() => handleCopyPrompt(ARCHIVE_MIGRATION_PROMPT, '创建压缩包提示词已复制到剪贴板')}
          >
            <Copy aria-hidden="true" />复制创建压缩包提示词
          </Button>
        </div>
      </SettingsSection>
      <SettingsSection
        title="新设备：恢复 Proma 数据"
        description="附上 ZIP 后，将提示词粘贴到 Proma 对话完成恢复。"
      >
        <div className="relative rounded-lg border border-border/60 bg-muted/30 p-4 pr-12">
          <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-6 text-muted-foreground">{RESTORE_MIGRATION_PROMPT}</pre>
          <Button
            variant="ghost"
            size="icon"
            aria-label="复制恢复数据提示词"
            title="复制恢复数据提示词"
            onClick={() => handleCopyPrompt(RESTORE_MIGRATION_PROMPT, '恢复数据提示词已复制到剪贴板')}
            className="absolute right-2 top-2"
          >
            <Copy aria-hidden="true" />
          </Button>
        </div>
      </SettingsSection>
      <p className="rounded-md border border-amber-500/25 bg-amber-500/10 px-4 py-3 text-sm leading-6 text-amber-800 dark:text-amber-200">
        数据压缩包可能包含会话、文件和配置。请仅通过可信渠道传输；系统钥匙串、API Key 和登录凭据不会随文件夹复制。
      </p>
    </>
  )
}

/** 路径与迁移设置页。 */
export function PathManagementSettings(): React.ReactElement {
  /** 主进程返回的当前路径状态。 */
  const [state, setState] = React.useState<PathManagementState | null>(null)
  /** 状态读取或操作错误。 */
  const [error, setError] = React.useState<string | undefined>()
  /** 防止重复选择、打开或启动迁移。 */
  const [isBusy, setIsBusy] = React.useState(false)
  /** 确认对话框当前目标路径。 */
  const [selectedTarget, setSelectedTarget] = React.useState<string | null>(null)
  /** 等待对话框确认结果的 resolver。 */
  const confirmationResolver = React.useRef<((confirmed: boolean) => void) | null>(null)
  /** 防止进度事件并发查询相同迁移状态。 */
  const statusRefreshPending = React.useRef(false)

  /** 合并完整状态与独立迁移状态，确保 cleanup-only 不丢失。 */
  const loadState = React.useCallback(async (): Promise<void> => {
    const [nextState, migrationStatus] = await Promise.all([
      window.electronAPI.getPathManagementState(),
      window.electronAPI.getDataRootMigrationStatus(),
    ])
    setState(mergePathManagementStatus(nextState, migrationStatus))
  }, [])

  React.useEffect(() => {
    /** 卸载后阻止异步回调写入页面。 */
    let mounted = true
    loadState().catch((loadError: unknown) => {
      if (mounted) setError(toErrorMessage(loadError, '无法读取路径状态'))
    })
    /** 进度事件先更新轻量进度，再串行刷新完整状态。 */
    const unsubscribe = window.electronAPI.onDataRootMigrationProgress((migration) => {
      if (!mounted) return
      setState((current) => current === null ? current : { ...current, migration })
      if (statusRefreshPending.current) return
      statusRefreshPending.current = true
      void window.electronAPI.getDataRootMigrationStatus().then((status) => {
        if (!mounted) return
        setState((current) => current === null ? current : mergePathManagementStatus(current, status))
      }).catch((statusError: unknown) => {
        if (mounted) setError(toErrorMessage(statusError, '无法刷新迁移状态'))
      }).finally(() => { statusRefreshPending.current = false })
    })
    return () => {
      mounted = false
      confirmationResolver.current?.(false)
      confirmationResolver.current = null
      unsubscribe()
    }
  }, [loadState])

  /** 打开 locator 中的当前或上次数据根。 */
  const handleOpenRoot = async (target: OpenDataRootTarget): Promise<void> => {
    setIsBusy(true)
    setError(undefined)
    try {
      await window.electronAPI.openDataRoot(target)
    } catch (openError) {
      setError(toErrorMessage(openError, target === 'previous' ? '无法打开上次路径' : '无法打开当前路径'))
    } finally {
      setIsBusy(false)
    }
  }

  /** 打开选择器并等待可取消的确认对话框，再由主进程创建迁移计划。 */
  const handleMigration = async (): Promise<void> => {
    if (state === null) return
    setIsBusy(true)
    setError(undefined)
    try {
      await requestDataRootMigration(state, {
        pickDataRoot: window.electronAPI.pickDataRoot,
        confirmMigration: async (targetRoot) => {
          setSelectedTarget(targetRoot)
          return await new Promise<boolean>((resolve) => { confirmationResolver.current = resolve })
        },
        startDataRootMigration: window.electronAPI.startDataRootMigration,
      })
    } catch (migrationError) {
      setError(toErrorMessage(migrationError, '无法创建迁移计划'))
      await loadState().catch(() => undefined)
    } finally {
      setIsBusy(false)
    }
  }

  /** 完成确认 Promise 并关闭对话框。 */
  const resolveConfirmation = (confirmed: boolean): void => {
    const resolver = confirmationResolver.current
    confirmationResolver.current = null
    setSelectedTarget(null)
    resolver?.(confirmed)
  }

  /** 支持 Escape、遮罩和关闭按钮统一取消确认。 */
  const handleDialogOpenChange = (open: boolean): void => {
    if (!open && selectedTarget !== null) resolveConfirmation(false)
  }

  /** 当前页面视图。 */
  const view = createPathManagementSettingsView(state, error)
  /** 当前设备类型风险。 */
  const deviceRisk = state === null ? null : getDataRootDeviceRisk(state.deviceType)

  return (
    <div className="space-y-6">
      {state === null ? (
        <div
          role={view.kind === 'error' ? 'alert' : 'status'}
          className="flex min-h-24 items-center justify-center rounded-lg border border-border/50 bg-muted/20 px-4 text-sm text-muted-foreground"
        >
          {view.kind === 'loading' ? <Loader2 className="mr-2 size-4 animate-spin" aria-hidden="true" /> : null}
          {view.statusLabel}
        </div>
      ) : (
        <DataRootLocationSection
          state={state}
          view={view}
          isBusy={isBusy}
          onOpenRoot={(target) => void handleOpenRoot(target)}
          onMigrate={() => void handleMigration()}
        />
      )}

      {error !== undefined && state !== null ? (
        <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      ) : null}

      <CrossDeviceMigrationSection />

      <Dialog open={selectedTarget !== null} onOpenChange={handleDialogOpenChange}>
        <DialogContent className="max-w-xl rounded-lg" aria-describedby="data-root-migration-description">
          <DialogHeader>
            <DialogTitle>确认迁移 Proma 数据位置</DialogTitle>
            <DialogDescription id="data-root-migration-description">
              Proma 将创建迁移计划并重启。复制和校验成功后才会切换数据位置，源目录始终保留。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <PathSummary label="源位置" path={state?.activeRoot ?? '未知'} />
            <PathSummary label="目标位置" path={selectedTarget ?? '未选择'} />
            <div className="grid grid-cols-2 gap-3 rounded-md border border-border/50 bg-muted/20 p-3 text-xs text-muted-foreground">
              <span>待迁移数据：{formatBytes(state?.occupiedBytes)}</span>
              <span>当前可用空间：{formatBytes(state?.availableBytes)}</span>
            </div>
            {deviceRisk ? (
              <p className="flex gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-xs leading-5 text-amber-800 dark:text-amber-200">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />{deviceRisk}
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => resolveConfirmation(false)}>取消</Button>
            <Button onClick={() => resolveConfirmation(true)}>确认并重启迁移</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

/** 路径行右侧的复制与打开工具按钮。 */
function PathActions({
  path,
  openLabel,
  disabled,
  onOpen,
}: {
  path: string | null | undefined
  openLabel: string
  disabled: boolean
  onOpen: () => void
}): React.ReactElement {
  /** 复制完整路径并给出轻量反馈。 */
  const handleCopy = (): void => {
    if (!path) return
    void copyTextToClipboard(path).then(
      () => toast.success('路径已复制'),
      () => toast.error('复制路径失败'),
    )
  }
  return (
    <div className="flex w-[4.5rem] shrink-0 justify-end gap-1">
      <Button variant="ghost" size="icon-sm" disabled={!path} aria-label="复制路径" title="复制路径" onClick={handleCopy}>
        <Copy aria-hidden="true" />
      </Button>
      <Button variant="ghost" size="icon-sm" disabled={disabled} aria-label={openLabel} title={openLabel} onClick={onOpen}>
        <FolderOpen aria-hidden="true" />
      </Button>
    </div>
  )
}

/** 在固定宽度内截断路径，同时通过 title 暴露完整内容。 */
function PathValue({ path }: { path: string }): React.ReactElement {
  return <span className="block max-w-[34rem] truncate font-mono text-xs" title={path}>{path}</span>
}

/** 确认对话框中的稳定路径摘要。 */
function PathSummary({ label, path }: { label: string; path: string }): React.ReactElement {
  return (
    <div className="rounded-md border border-border/50 px-3 py-2">
      <div className="mb-1 text-xs text-muted-foreground">{label}</div>
      <PathValue path={path} />
    </div>
  )
}

/** 将字节数转换为紧凑、稳定的用户可见文本。 */
function formatBytes(bytes?: number): string {
  if (bytes === undefined) return '未知'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`
}

/** 映射数据根可用性文案。 */
function getAvailabilityLabel(availability: PathManagementState['availability']): string {
  switch (availability) {
    case 'available': return '可用'
    case 'missing': return '不存在'
    case 'unavailable': return '不可访问'
    case 'invalid': return '配置无效'
  }
}

/** 映射数据根设备类型文案。 */
function getDeviceTypeLabel(deviceType: PathManagementState['deviceType']): string {
  switch (deviceType) {
    case 'local': return '本地磁盘'
    case 'removable': return '可移动设备'
    case 'network': return '网络位置'
    case 'unknown': return '未知设备'
  }
}

/** 映射可恢复迁移阶段文案。 */
function getMigrationStatusLabel(
  stage: NonNullable<PathManagementState['migration']>['stage'],
  error?: string,
): string {
  if (stage === 'pending') return '迁移计划已创建，等待应用重启'
  if (stage === 'failed') return `迁移已暂停${error ? `：${error}` : ''}`
  if (stage === 'copying') return '正在复制数据'
  if (stage === 'verifying') return '正在校验数据'
  if (stage === 'rebasing') return '正在更新内部路径'
  return '正在切换数据位置'
}

/** 将 unknown 异常转换为平静、可操作的界面摘要。 */
function toErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() !== '' ? error.message : fallback
}
