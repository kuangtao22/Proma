import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, FolderOpen, RefreshCw, RotateCcw, X } from 'lucide-react'
import type {
  DataRootMigrationProgress,
  DataRootRecoveryAction,
  DataRootStartupMode,
  PathManagementState,
} from '@proma/shared'
import type {
  DataRootMigrationPreloadApi,
  DataRootRecoveryPreloadApi,
  PathManagementPreloadApi,
} from '../../../preload/path-management-preload'
import { Button } from '@/components/ui/button'

/** 普通 recovery 状态允许的完整动作集合。 */
const DATA_ROOT_RECOVERY_ACTIONS: ReadonlyArray<DataRootRecoveryAction> = [
  'recheck',
  'relocate',
  'restore-previous',
]

/** cleanup 未解决时只能重新检测，避免先弹出必然失败的选择器。 */
const CLEANUP_RECOVERY_ACTIONS: ReadonlyArray<DataRootRecoveryAction> = ['recheck']

/** 迁移页经过归一化后用于渲染的稳定视图状态。 */
export interface DataRootMigrationViewState {
  /** 当前页面展示迁移、恢复、提交后清理或等待状态。 */
  kind: 'migration' | 'recovery' | 'cleanup' | 'idle'
  /** 当前阶段的用户可见中文标题。 */
  stageLabel: string
  /** 归一化到 0-100 的进度百分比。 */
  percent: number
  /** 当前错误摘要。 */
  error?: string
  /** 是否存在经过 locator 保存的旧根候选。 */
  canRestorePrevious: boolean
  /** 当前状态实际允许渲染和执行的 recovery 动作。 */
  recoveryActions: ReadonlyArray<DataRootRecoveryAction>
}

/** 将路径状态转换为无副作用、可单元测试的恢复页视图。 */
export function createDataRootMigrationViewState(
  state: PathManagementState,
  mode: DataRootStartupMode,
): DataRootMigrationViewState {
  if (state.migration !== null) {
    /** 迁移总量可能为零，零文件迁移按未完成展示而不是产生 NaN。 */
    const percent = state.migration.totalBytes === 0
      ? 0
      : Math.min(100, Math.max(0, Math.round(
          state.migration.completedBytes / state.migration.totalBytes * 100,
        )))
    return {
      kind: 'migration',
      stageLabel: getStageLabel(state.migration.stage),
      percent,
      ...(state.migration.error === undefined ? {} : { error: state.migration.error }),
      canRestorePrevious: state.previousRoot !== undefined,
      recoveryActions: [],
    }
  }
  if (mode === 'data-root-recovery' || state.availability !== 'available') {
    return {
      kind: 'recovery',
      stageLabel: '数据根当前不可用',
      percent: 0,
      ...(state.postCommitCleanup?.error === undefined ? {} : { error: state.postCommitCleanup.error }),
      canRestorePrevious: state.previousRoot !== undefined,
      recoveryActions: state.postCommitCleanup === undefined
        ? DATA_ROOT_RECOVERY_ACTIONS
        : CLEANUP_RECOVERY_ACTIONS,
    }
  }
  if (state.postCommitCleanup !== undefined) {
    return {
      kind: 'cleanup',
      stageLabel: state.postCommitCleanup.status === 'pending' ? '正在清理迁移断点' : '迁移完成，清理需要重试',
      percent: 100,
      ...(state.postCommitCleanup.error === undefined ? {} : { error: state.postCommitCleanup.error }),
      canRestorePrevious: state.previousRoot !== undefined,
      recoveryActions: [],
    }
  }
  return {
    kind: 'idle',
    stageLabel: '等待迁移',
    percent: 0,
    canRestorePrevious: state.previousRoot !== undefined,
    recoveryActions: [],
  }
}

/** 用户确认后才执行切回旧数据根，取消时保持 locator 不变。 */
export async function confirmRestorePreviousDataRoot(
  confirm: () => boolean,
  restore: () => Promise<void>,
): Promise<void> {
  if (!confirm()) return
  await restore()
}

/** 仅 migration API 注册进度 listener；recovery API 返回稳定 no-op。 */
export function subscribeToDataRootMigrationProgress(
  api: PathManagementPreloadApi,
  callback: (progress: DataRootMigrationProgress) => void,
): () => void {
  if (!('onDataRootMigrationProgress' in api)) return () => undefined
  return api.onDataRootMigrationProgress(callback)
}

/** 数据根迁移进度条属性。 */
export interface DataRootMigrationProgressBarProps {
  /** 已归一化到 0-100 的迁移百分比。 */
  percent: number
}

/** 渲染同时具备视觉宽度与辅助技术数值语义的迁移进度。 */
export function DataRootMigrationProgressBar({
  percent,
}: DataRootMigrationProgressBarProps): React.JSX.Element {
  return (
    <div
      role="progressbar"
      aria-label={`迁移进度 ${percent}%`}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      className="mb-8 h-2 w-full overflow-hidden rounded-sm bg-muted"
    >
      <div
        className="h-full bg-primary transition-[width] duration-200"
        style={{ width: `${percent}%` }}
      />
    </div>
  )
}

/** recovery 按钮区只接收已派生的允许动作与无状态回调。 */
export interface DataRootRecoveryControlsProps {
  /** 当前 recovery 视图及允许动作。 */
  view: DataRootMigrationViewState
  /** 是否正在执行上一条路径操作。 */
  isBusy: boolean
  /** 重新检测当前数据根。 */
  onRecheck: () => void
  /** 打开选择器重新定位数据根。 */
  onRelocate: () => void
  /** 确认后切回旧备份。 */
  onRestorePrevious: () => void
  /** 退出路径管理窗口。 */
  onExit: () => void
}

/** 按当前状态允许集合渲染 recovery 操作，避免展示后端必然阻断的入口。 */
export function DataRootRecoveryControls({
  view,
  isBusy,
  onRecheck,
  onRelocate,
  onRestorePrevious,
  onExit,
}: DataRootRecoveryControlsProps): React.JSX.Element {
  return (
    <div className="flex flex-wrap gap-3">
      {view.recoveryActions.includes('recheck') ? (
        <Button disabled={isBusy} onClick={onRecheck}>
          <RefreshCw aria-hidden="true" />重新检测
        </Button>
      ) : null}
      {view.recoveryActions.includes('relocate') ? (
        <Button variant="outline" disabled={isBusy} onClick={onRelocate}>
          <FolderOpen aria-hidden="true" />重新定位
        </Button>
      ) : null}
      {view.recoveryActions.includes('restore-previous') ? (
        <Button variant="outline" disabled={isBusy || !view.canRestorePrevious} onClick={onRestorePrevious}>
          <RotateCcw aria-hidden="true" />切回旧备份
        </Button>
      ) : null}
      <Button variant="ghost" disabled={isBusy} onClick={onExit}>
        <X aria-hidden="true" />退出
      </Button>
    </div>
  )
}

/** 数据根迁移与离线恢复使用的轻量 renderer。 */
export function DataRootMigrationApp(): React.JSX.Element {
  /** URL 中由主进程写入的隔离启动模式。 */
  const mode = useMemo<DataRootStartupMode>(() => {
    /** renderer 查询参数中的原始模式。 */
    const value = new URLSearchParams(window.location.search).get('mode')
    return value === 'data-root-recovery' ? value : 'data-root-migration'
  }, [])
  /** 主进程保证 URL mode 与 preload additionalArgument 同源，分支内据此收窄真实 API。 */
  const migrationApi = window.pathManagementAPI as DataRootMigrationPreloadApi
  /** recovery 分支只调用恢复对象实际拥有的方法。 */
  const recoveryApi = window.pathManagementAPI as DataRootRecoveryPreloadApi
  /** 主进程返回的当前路径管理状态。 */
  const [state, setState] = useState<PathManagementState | null>(null)
  /** 当前动作产生的用户可处理错误。 */
  const [actionError, setActionError] = useState<string | null>(null)
  /** 防止用户重复提交路径操作。 */
  const [isBusy, setIsBusy] = useState(false)

  /** 从唯一的路径 IPC 刷新公开状态。 */
  const refreshState = useCallback(async (): Promise<void> => {
    const nextState = await window.pathManagementAPI.getPathManagementState()
    setState(nextState)
  }, [])

  useEffect(() => {
    /** 组件卸载后拒绝写入异步错误状态。 */
    let mounted = true
    refreshState().catch((error: unknown) => {
      if (mounted) setActionError(toErrorMessage(error))
    })
    /** 迁移进度直接合并到当前状态，避免高频全量查询。 */
    const unsubscribe = subscribeToDataRootMigrationProgress(window.pathManagementAPI, (migration) => {
      if (mounted) setState((current) => current === null ? current : { ...current, migration })
    })
    /** recovery renderer 直接跟随系统明暗，不读取业务 settings。 */
    const colorScheme = window.matchMedia('(prefers-color-scheme: dark)')
    /** 将系统明暗同步到根节点主题 class。 */
    const applySystemTheme = (): void => {
      document.documentElement.classList.toggle('dark', colorScheme.matches)
    }
    applySystemTheme()
    colorScheme.addEventListener('change', applySystemTheme)
    return () => {
      mounted = false
      unsubscribe()
      colorScheme.removeEventListener('change', applySystemTheme)
    }
  }, [refreshState])

  /** 串行执行路径动作并刷新未触发重启的状态。 */
  const runAction = useCallback(async (action: () => Promise<void>): Promise<void> => {
    setIsBusy(true)
    setActionError(null)
    try {
      await action()
      await refreshState()
    } catch (error) {
      setActionError(toErrorMessage(error))
    } finally {
      setIsBusy(false)
    }
  }, [refreshState])

  if (state === null) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background text-foreground">
        <div role="status" className="text-sm text-muted-foreground">正在读取数据根状态...</div>
      </main>
    )
  }

  /** 当前状态对应的稳定视图模型。 */
  const view = createDataRootMigrationViewState(state, mode)
  /** 操作错误优先，随后展示持久化迁移或 cleanup 错误。 */
  const visibleError = actionError ?? view.error

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-6 py-10 text-foreground">
      <section aria-labelledby="data-root-title" className="w-full max-w-xl">
        <div className="mb-8 flex items-start gap-4">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-md border border-border bg-muted">
            {view.kind === 'recovery'
              ? <AlertTriangle aria-hidden="true" className="size-5 text-destructive" />
              : <RefreshCw aria-hidden="true" className={`size-5 text-primary ${view.kind === 'migration' ? 'animate-spin' : ''}`} />}
          </div>
          <div className="min-w-0">
            <h1 id="data-root-title" className="text-xl font-semibold">{view.stageLabel}</h1>
            <p className="mt-2 break-all text-sm text-muted-foreground">
              {state.activeRoot ?? '定位文件无效，请重新选择数据目录'}
            </p>
          </div>
        </div>

        {view.kind === 'migration' || view.kind === 'cleanup' ? (
          <DataRootMigrationProgressBar percent={view.percent} />
        ) : null}

        {visibleError ? (
          <p role="alert" className="mb-6 rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {visibleError}
          </p>
        ) : null}

        {view.kind === 'recovery' ? (
          <DataRootRecoveryControls
            view={view}
            isBusy={isBusy}
            onRecheck={() => void runAction(async () => {
              await recoveryApi.recoverDataRoot({ action: 'recheck' })
            })}
            onRelocate={() => void runAction(async () => {
              /** 系统选择器返回的已授权候选目录。 */
              const selectedRoot = await recoveryApi.pickDataRoot()
              if (selectedRoot === null) return
              await recoveryApi.recoverDataRoot({ action: 'relocate', selectedRoot })
            })}
            onRestorePrevious={() => void runAction(async () => {
              await confirmRestorePreviousDataRoot(
                () => window.confirm('切回旧备份后，当前离线数据根将保留为可恢复位置。是否继续？'),
                () => recoveryApi.recoverDataRoot({ action: 'restore-previous' }),
              )
            })}
            onExit={() => void recoveryApi.exitDataRootManagement()}
          />
        ) : (
          <div className="flex flex-wrap gap-3">
            {view.kind === 'migration' ? (
              <Button disabled={isBusy} onClick={() => void runAction(() => migrationApi.resumeDataRootMigration())}>
                <RefreshCw aria-hidden="true" />继续迁移
              </Button>
            ) : null}
            {state.migration !== null && ['pending', 'copying', 'failed'].includes(state.migration.stage) ? (
              <Button variant="outline" disabled={isBusy} onClick={() => void runAction(() => migrationApi.cancelDataRootMigration())}>
                取消迁移
              </Button>
            ) : null}
            <Button variant="ghost" disabled={isBusy} onClick={() => void migrationApi.exitDataRootManagement()}>
              <X aria-hidden="true" />退出
            </Button>
          </div>
        )}
      </section>
    </main>
  )
}

/** 将 unknown 异常转换为界面安全摘要。 */
function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '路径操作失败，请重试'
}

/** 将迁移内部阶段映射为稳定中文文案。 */
function getStageLabel(stage: NonNullable<PathManagementState['migration']>['stage']): string {
  switch (stage) {
    case 'pending': return '准备迁移数据'
    case 'copying': return '正在复制数据'
    case 'verifying': return '正在校验数据'
    case 'rebasing': return '正在重写内部路径'
    case 'switching': return '正在切换数据根'
    case 'failed': return '迁移已暂停'
  }
}
