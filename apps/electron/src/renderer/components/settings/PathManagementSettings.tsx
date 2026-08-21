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
import type {
  DataRootMigrationPreview,
  DataRootMigrationSelectionInput,
  DataRootMigrationStatus,
  DataRootOccupiedStorage,
  DataRootSelection,
  OpenDataRootTarget,
  PathManagementState,
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
import { copyTextToClipboard } from '@/lib/clipboard'
import { SettingsCard, SettingsRow, SettingsSection } from './primitives'
import { WorkspacePathList } from './WorkspacePathList'

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
  pickDataRoot: () => Promise<DataRootSelection | null>
  /** 只读预检刚选择的目标目录。 */
  previewDataRootMigration: (input: DataRootMigrationSelectionInput) => Promise<DataRootMigrationPreview>
  /** 显示迁移确认对话框。 */
  confirmMigration: (preview: DataRootMigrationPreview) => Promise<boolean>
  /** 创建迁移计划并请求重启。 */
  startDataRootMigration: (input: DataRootMigrationSelectionInput) => Promise<void>
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
  const selection = await dependencies.pickDataRoot()
  if (selection === null) return 'cancelled'
  /** 预览不会创建计划；启动时主进程仍会完整复检。 */
  const preview = await dependencies.previewDataRootMigration(selection)
  /** 只有明确确认后才允许主进程创建计划。 */
  const confirmed = await dependencies.confirmMigration(preview)
  if (!confirmed || preview.blockers.length > 0) return 'cancelled'
  await dependencies.startDataRootMigration(selection)
  return 'started'
}

/** 设置页局部交互状态；加载错误与普通操作错误必须独立。 */
export interface PathManagementUiState {
  loadError?: string
  actionError?: string
  selectedTarget: string | null
  preview: DataRootMigrationPreview | null
  previewLoading: boolean
}

/** 设置页局部状态允许的稳定转换。 */
export type PathManagementUiAction =
  | { type: 'load-failed'; message: string }
  | { type: 'load-succeeded' }
  | { type: 'action-failed'; message: string }
  | { type: 'migration-failed'; message: string }
  | { type: 'action-succeeded' }
  | { type: 'pick-started' }
  | { type: 'preview-started'; targetRoot: string }
  | { type: 'preview-succeeded'; preview: DataRootMigrationPreview }
  | { type: 'preview-closed' }

/** 创建无错误、无目标的初始设置页局部状态。 */
export function createPathManagementUiState(): PathManagementUiState {
  return { selectedTarget: null, preview: null, previewLoading: false }
}

/** 对交互事件做纯状态转换，便于覆盖错误清除和预览边界。 */
export function reducePathManagementUiState(
  state: PathManagementUiState,
  action: PathManagementUiAction,
): PathManagementUiState {
  if (action.type === 'load-failed') return { ...state, loadError: action.message }
  if (action.type === 'load-succeeded') {
    const { loadError: _loadError, ...rest } = state
    return rest
  }
  if (action.type === 'action-failed') return { ...state, actionError: action.message }
  if (action.type === 'migration-failed') {
    return {
      ...state,
      actionError: action.message,
      selectedTarget: null,
      preview: null,
      previewLoading: false,
    }
  }
  if (action.type === 'action-succeeded' || action.type === 'pick-started') {
    const { actionError: _actionError, ...rest } = state
    return action.type === 'pick-started'
      ? { ...rest, selectedTarget: null, preview: null, previewLoading: false }
      : rest
  }
  if (action.type === 'preview-started') {
    return { ...state, selectedTarget: action.targetRoot, preview: null, previewLoading: true }
  }
  if (action.type === 'preview-succeeded') {
    const { actionError: _actionError, ...rest } = state
    return { ...rest, selectedTarget: action.preview.targetRoot, preview: action.preview, previewLoading: false }
  }
  return { ...state, selectedTarget: null, preview: null, previewLoading: false }
}

/** 确认按钮只由忙碌、预览未完成或真实 blocker 禁用。 */
export function isDataRootMigrationConfirmDisabled(input: {
  preview: DataRootMigrationPreview | null
  previewLoading: boolean
  isBusy: boolean
}): boolean {
  return input.isBusy || input.previewLoading || input.preview === null || input.preview.blockers.length > 0
}

/** 单个异步域只允许最新请求提交结果，并支持 StrictMode effect 重新挂载。 */
export interface PathManagementRequestGate {
  /** 激活新挂载周期并取消上一周期遗留请求。 */
  mount(): void
  /** 开始新请求并取消同域旧请求。 */
  begin(): { generation: number; signal: AbortSignal }
  /** 判断请求是否仍是已挂载页面的最新一代。 */
  isCurrent(request: { generation: number; signal: AbortSignal }): boolean
  /** 判断当前 effect 周期是否已挂载。 */
  isMounted(): boolean
  /** 卸载页面并取消当前请求。 */
  dispose(): void
}

/** 创建设置页异步请求代次门控。 */
export function createPathManagementRequestGate(): PathManagementRequestGate {
  let mounted = true
  let generation = 0
  let controller: AbortController | null = null
  return {
    mount: () => {
      controller?.abort()
      mounted = true
      generation += 1
      controller = null
    },
    begin: () => {
      controller?.abort()
      controller = new AbortController()
      generation += 1
      return { generation, signal: controller.signal }
    },
    isCurrent: (request) => mounted && request.generation === generation && !request.signal.aborted,
    isMounted: () => mounted,
    dispose: () => {
      mounted = false
      generation += 1
      controller?.abort()
      controller = null
    },
  }
}

/** 迁移进度状态刷新依赖，允许无 DOM 精确覆盖异步交错。 */
export interface PathManagementProgressRefreshDependencies {
  /** 只管理进度状态请求，不得与完整状态加载共用。 */
  gate: PathManagementRequestGate
  /** 读取轻量迁移状态。 */
  getStatus(): Promise<DataRootMigrationStatus>
  /** 读取最近一次已提交的完整路径状态。 */
  getCurrentState(): PathManagementState | null
  /** 把迁移状态合并到已有完整状态。 */
  commitStatus(status: DataRootMigrationStatus): void
  /** 完整状态尚未就绪时重新触发完整加载。 */
  loadState(): Promise<void>
  /** 报告当前代请求错误。 */
  reportError(error: unknown): void
  /** controller 在 pending 期间收到新进度时丢弃当前旧响应。 */
  shouldDiscard?: () => boolean
}

/** 独立刷新迁移状态；缺少完整状态时改为等待一次完整加载。 */
export async function refreshPathManagementProgressStatus(
  dependencies: PathManagementProgressRefreshDependencies,
): Promise<void> {
  /** 本次进度刷新代次。 */
  const request = dependencies.gate.begin()
  try {
    const status = await dependencies.getStatus()
    if (!dependencies.gate.isCurrent(request)) return
    if (dependencies.shouldDiscard?.() === true) return
    if (dependencies.getCurrentState() === null) {
      await dependencies.loadState()
      return
    }
    dependencies.commitStatus(status)
  } catch (error) {
    if (dependencies.gate.isCurrent(request) && dependencies.shouldDiscard?.() !== true) {
      dependencies.reportError(error)
    }
  }
}

/** 进度刷新控制器对外生命周期与串行刷新接口。 */
export interface PathManagementProgressRefreshController {
  /** 激活当前 effect 周期。 */
  mount(): void
  /** 终止当前 effect 周期。 */
  dispose(): void
  /** 请求刷新；已有请求时只标记 dirty 并复用同一 Promise。 */
  requestRefresh(): Promise<void>
}

/** 创建最多一个 in-flight、dirty 后自动追拉的进度刷新控制器。 */
export function createPathManagementProgressRefreshController(
  dependencies: Omit<PathManagementProgressRefreshDependencies, 'gate' | 'shouldDiscard'>,
): PathManagementProgressRefreshController {
  /** controller 独占的请求门控。 */
  const gate = createPathManagementRequestGate()
  /** pending 期间是否收到过更新的 progress。 */
  let dirty = false
  /** 当前串行刷新循环；所有并发调用复用。 */
  let pending: Promise<void> | null = null

  /** 执行一轮或多轮串行刷新，dirty 响应永不提交。 */
  const runRefreshLoop = async (): Promise<void> => {
    while (gate.isMounted()) {
      dirty = false
      await refreshPathManagementProgressStatus({
        ...dependencies,
        gate,
        shouldDiscard: () => dirty,
      })
      if (!dirty || !gate.isMounted()) return
    }
  }

  return {
    mount: () => {
      gate.mount()
      /** StrictMode 重挂载时让旧请求完成后追拉当前周期状态。 */
      if (pending !== null) dirty = true
    },
    dispose: () => {
      dirty = false
      gate.dispose()
    },
    requestRefresh: () => {
      if (pending !== null) {
        dirty = true
        return pending
      }
      /** 保存稳定引用，finally 只清理自己对应的循环。 */
      let refresh: Promise<void>
      refresh = runRefreshLoop().finally(() => {
        if (pending === refresh) pending = null
      })
      pending = refresh
      return refresh
    },
  }
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

/** 合并后台占用结果，不触碰独立的容量诊断。 */
export function mergePathManagementOccupiedStorage(
  state: PathManagementState,
  occupied: DataRootOccupiedStorage,
): PathManagementState {
  return { ...state, ...occupied }
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
  /** 占用扫描独立于卷信息，首屏和失败态使用明确文案。 */
  const occupiedLabel = state.occupiedStatus === 'loading'
    ? '正在计算...'
    : state.occupiedStatus === 'unavailable'
      ? (state.occupiedIssue?.message ?? '占用空间暂不可用')
      : formatBytes(state.occupiedBytes)
  /** 容量查询错误显示在可用空间字段，避免与独立占用扫描状态混淆。 */
  const availableLabel = state.capacityIssue?.message
    ? state.capacityIssue.message
    : formatBytes(state.availableBytes)
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
            <div className="mt-1 tabular-nums">已占用 {occupiedLabel} · 可用 {availableLabel}</div>
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
  /** 加载错误、操作错误与目标预览的独立局部状态。 */
  const [uiState, dispatchUi] = React.useReducer(reducePathManagementUiState, undefined, createPathManagementUiState)
  /** 防止重复选择、打开或启动迁移。 */
  const [isBusy, setIsBusy] = React.useState(false)
  /** 等待对话框确认结果的 resolver。 */
  const confirmationResolver = React.useRef<((confirmed: boolean) => void) | null>(null)
  /** 迁移选择流程代次，阻止已关闭预览的异步结果重新打开对话框。 */
  const migrationFlowId = React.useRef(0)
  /** 完整状态、占用与用户动作分域门控，互不取消但各自只允许最新请求提交。 */
  const stateRequestGate = React.useRef<PathManagementRequestGate | null>(null)
  const occupiedRequestGate = React.useRef<PathManagementRequestGate | null>(null)
  const actionRequestGate = React.useRef<PathManagementRequestGate | null>(null)
  if (stateRequestGate.current === null) stateRequestGate.current = createPathManagementRequestGate()
  if (occupiedRequestGate.current === null) occupiedRequestGate.current = createPathManagementRequestGate()
  if (actionRequestGate.current === null) actionRequestGate.current = createPathManagementRequestGate()
  /** 保存最近一次完整状态，供进度刷新判断是否可以安全合并。 */
  const stateRef = React.useRef<PathManagementState | null>(null)
  /** 进度事件读取最新活动根，避免闭包持有旧首屏状态。 */
  const activeRootRef = React.useRef<string | null>(null)

  /** 后台刷新占用空间；失败只更新 occupied 字段，不覆盖卷信息。 */
  const refreshOccupied = React.useCallback(async (activeRoot: string | null): Promise<void> => {
    if (activeRoot === null || occupiedRequestGate.current === null) return
    const request = occupiedRequestGate.current.begin()
    try {
      const occupied = await window.electronAPI.getDataRootOccupiedStorage()
      if (!occupiedRequestGate.current.isCurrent(request)) return
      setState((current) => current?.activeRoot === activeRoot
        ? mergePathManagementOccupiedStorage(current, occupied)
        : current)
    } catch {
      if (!occupiedRequestGate.current.isCurrent(request)) return
      setState((current) => current?.activeRoot === activeRoot ? {
        ...current,
        occupiedBytes: undefined,
        occupiedStatus: 'unavailable',
        occupiedIssue: { code: 'SCAN_FAILED', message: '占用空间暂不可用' },
      } : current)
    }
  }, [])

  /** 合并完整状态与独立迁移状态，确保 cleanup-only 不丢失。 */
  const loadState = React.useCallback(async (): Promise<void> => {
    if (stateRequestGate.current === null) return
    const request = stateRequestGate.current.begin()
    try {
      const [nextState, migrationStatus] = await Promise.all([
        window.electronAPI.getPathManagementState(),
        window.electronAPI.getDataRootMigrationStatus(),
      ])
      if (!stateRequestGate.current.isCurrent(request)) return
      const mergedState = mergePathManagementStatus(nextState, migrationStatus)
      stateRef.current = mergedState
      activeRootRef.current = mergedState.activeRoot
      setState(mergedState)
      dispatchUi({ type: 'load-succeeded' })
      void refreshOccupied(mergedState.activeRoot)
    } catch (loadError) {
      if (!stateRequestGate.current.isCurrent(request)) return
      dispatchUi({ type: 'load-failed', message: toErrorMessage(loadError, '无法读取路径状态') })
    }
  }, [refreshOccupied])

  /** 串行进度刷新控制器，pending 期间的新事件通过 dirty 触发追拉。 */
  const progressRefreshController = React.useRef<PathManagementProgressRefreshController | null>(null)
  if (progressRefreshController.current === null) {
    progressRefreshController.current = createPathManagementProgressRefreshController({
      getStatus: window.electronAPI.getDataRootMigrationStatus,
      getCurrentState: () => stateRef.current,
      commitStatus: (status) => {
        setState((current) => {
          const nextState = current === null ? current : mergePathManagementStatus(current, status)
          stateRef.current = nextState
          return nextState
        })
      },
      loadState,
      reportError: (statusError) => {
        dispatchUi({ type: 'load-failed', message: toErrorMessage(statusError, '无法刷新迁移状态') })
      },
    })
  }

  React.useEffect(() => {
    stateRequestGate.current?.mount()
    progressRefreshController.current?.mount()
    occupiedRequestGate.current?.mount()
    actionRequestGate.current?.mount()
    void loadState()
    /** 进度事件先更新轻量进度，再串行刷新完整状态。 */
    const unsubscribe = window.electronAPI.onDataRootMigrationProgress((migration) => {
      if (progressRefreshController.current === null) return
      setState((current) => {
        const nextState = current === null ? current : { ...current, migration }
        stateRef.current = nextState
        return nextState
      })
      void refreshOccupied(activeRootRef.current)
      void progressRefreshController.current.requestRefresh()
    })
    return () => {
      stateRequestGate.current?.dispose()
      progressRefreshController.current?.dispose()
      occupiedRequestGate.current?.dispose()
      actionRequestGate.current?.dispose()
      migrationFlowId.current += 1
      confirmationResolver.current?.(false)
      confirmationResolver.current = null
      unsubscribe()
    }
  }, [loadState, refreshOccupied])

  /** 打开 locator 中的当前或上次数据根。 */
  const handleOpenRoot = async (target: OpenDataRootTarget): Promise<void> => {
    if (actionRequestGate.current === null) return
    const request = actionRequestGate.current.begin()
    setIsBusy(true)
    dispatchUi({ type: 'action-succeeded' })
    try {
      await window.electronAPI.openDataRoot(target)
    } catch (openError) {
      if (!actionRequestGate.current.isCurrent(request)) return
      dispatchUi({
        type: 'action-failed',
        message: toErrorMessage(openError, target === 'previous' ? '无法打开上次路径' : '无法打开当前路径'),
      })
    } finally {
      if (actionRequestGate.current.isCurrent(request)) setIsBusy(false)
    }
  }

  /** 打开选择器并等待可取消的确认对话框，再由主进程创建迁移计划。 */
  const handleMigration = async (): Promise<void> => {
    if (state === null || actionRequestGate.current === null) return
    const request = actionRequestGate.current.begin()
    /** 本次选择流程的稳定代次。 */
    const flowId = migrationFlowId.current + 1
    migrationFlowId.current = flowId
    setIsBusy(true)
    dispatchUi({ type: 'pick-started' })
    /** 每个异步边界后统一检查组件、动作代次与迁移流程代次。 */
    const isCurrentFlow = (): boolean => actionRequestGate.current?.isCurrent(request) === true
      && migrationFlowId.current === flowId
    try {
      await requestDataRootMigration(state, {
        pickDataRoot: async () => {
          const selection = await window.electronAPI.pickDataRoot()
          return isCurrentFlow() ? selection : null
        },
        previewDataRootMigration: async (selection) => {
          if (!isCurrentFlow()) throw new Error('路径选择流程已取消')
          dispatchUi({ type: 'preview-started', targetRoot: selection.targetRoot })
          const preview = await window.electronAPI.previewDataRootMigration(selection)
          if (isCurrentFlow()) dispatchUi({ type: 'preview-succeeded', preview })
          return preview
        },
        confirmMigration: async () => {
          if (!isCurrentFlow()) return false
          setIsBusy(false)
          const confirmed = await new Promise<boolean>((resolve) => { confirmationResolver.current = resolve })
          if (!isCurrentFlow()) return false
          if (confirmed) setIsBusy(true)
          return confirmed
        },
        startDataRootMigration: async (selection) => {
          if (!isCurrentFlow()) throw new Error('路径选择流程已取消')
          await window.electronAPI.startDataRootMigration(selection)
        },
      })
    } catch (migrationError) {
      if (!isCurrentFlow()) return
      dispatchUi({ type: 'migration-failed', message: toErrorMessage(migrationError, '无法创建迁移计划') })
      await loadState()
    } finally {
      if (isCurrentFlow()) setIsBusy(false)
    }
  }

  /** 完成确认 Promise 并关闭对话框。 */
  const resolveConfirmation = (confirmed: boolean): void => {
    const resolver = confirmationResolver.current
    confirmationResolver.current = null
    if (!confirmed) migrationFlowId.current += 1
    dispatchUi({ type: 'preview-closed' })
    if (!confirmed && resolver === null) setIsBusy(false)
    resolver?.(confirmed)
  }

  /** 支持 Escape、遮罩和关闭按钮统一取消确认。 */
  const handleDialogOpenChange = (open: boolean): void => {
    if (!open && uiState.selectedTarget !== null) resolveConfirmation(false)
  }

  /** 当前页面视图。 */
  const view = createPathManagementSettingsView(state, uiState.loadError)
  /** 当前设备类型风险。 */
  const deviceRisk = uiState.preview === null ? null : getDataRootDeviceRisk(uiState.preview.deviceType)
  /** 当前预览是否阻断最终确认。 */
  const confirmDisabled = isDataRootMigrationConfirmDisabled({
    preview: uiState.preview,
    previewLoading: uiState.previewLoading,
    isBusy,
  })

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

      {uiState.actionError !== undefined && state !== null ? (
        <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {uiState.actionError}
        </p>
      ) : null}

      <WorkspacePathList
        workspaces={state?.workspaces ?? []}
        loading={state === null && uiState.loadError === undefined}
        error={state === null ? uiState.loadError : undefined}
        onChanged={loadState}
      />

      <CrossDeviceMigrationSection />

      <Dialog open={uiState.selectedTarget !== null} onOpenChange={handleDialogOpenChange}>
        <DialogContent className="max-w-xl rounded-lg" aria-describedby="data-root-migration-description">
          <DialogHeader>
            <DialogTitle>确认迁移 Proma 数据位置</DialogTitle>
            <DialogDescription id="data-root-migration-description">
              Proma 将创建迁移计划并重启。复制和校验成功后才会切换数据位置，源目录始终保留。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <PathSummary label="源位置" path={state?.activeRoot ?? '未知'} />
            <PathSummary label="目标位置" path={uiState.selectedTarget ?? '未选择'} />
            <div className="grid grid-cols-2 gap-3 rounded-md border border-border/50 bg-muted/20 p-3 text-xs text-muted-foreground">
              <span>待迁移数据：{formatBytes(uiState.preview?.requiredBytes)}</span>
              <span>目标可用空间：{formatBytes(uiState.preview?.availableBytes)}</span>
            </div>
            {uiState.previewLoading ? (
              <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />正在检查目标位置...
              </p>
            ) : null}
            {uiState.preview?.blockers.map((blocker) => (
              <p key={blocker.code} role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive">
                {blocker.message}
              </p>
            ))}
            {deviceRisk ? (
              <p className="flex gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-xs leading-5 text-amber-800 dark:text-amber-200">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />{deviceRisk}
              </p>
            ) : null}
          </div>
          <DialogFooter>
            {uiState.preview?.blockers.length ? (
              <Button variant="outline" onClick={() => {
                resolveConfirmation(false)
                queueMicrotask(() => { void handleMigration() })
              }}>换一个位置</Button>
            ) : <Button variant="outline" onClick={() => resolveConfirmation(false)}>取消</Button>}
            <Button disabled={confirmDisabled} onClick={() => resolveConfirmation(true)}>确认并重启迁移</Button>
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
