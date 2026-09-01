import * as React from 'react'
import type {
  CanvasWebviewDevicePreset,
  CanvasWebviewPreviewSnapshot,
  CanvasWebviewPreviewTarget,
} from '@proma/shared'
import { LoaderCircle, Monitor, RotateCcw, Smartphone } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'

/** WebView 两种持久设备预设及其离屏截图视口。 */
export const CANVAS_WEBVIEW_DEVICE_OPTIONS: ReadonlyArray<{
  value: CanvasWebviewDevicePreset
  label: string
  viewportLabel: string
}> = [
  { value: 'desktop', label: '网页', viewportLabel: '1440 x 900' },
  { value: 'mobile', label: '手机', viewportLabel: '390 x 844' },
]

/** 卡片静态预览状态同时绑定目标身份和重试代次。 */
export type CanvasWebviewPreviewState =
  | { phase: 'loading'; target: CanvasWebviewPreviewTarget; retryGeneration: number }
  | { phase: 'ready'; target: CanvasWebviewPreviewTarget; retryGeneration: number; snapshot: CanvasWebviewPreviewSnapshot }
  | { phase: 'error'; target: CanvasWebviewPreviewTarget; retryGeneration: number }

/** 静态预览异步事件携带发起请求时的完整目标，迟到结果无法覆盖新目标。 */
export type CanvasWebviewPreviewEvent =
  | { type: 'target-changed'; target: CanvasWebviewPreviewTarget }
  | { type: 'loaded'; target: CanvasWebviewPreviewTarget; snapshot: CanvasWebviewPreviewSnapshot }
  | { type: 'failed'; target: CanvasWebviewPreviewTarget }
  | { type: 'retry' }

/** 比较 WebView 预览的完整内容与设备身份。 */
export function isCanvasWebviewPreviewTargetEqual(
  left: CanvasWebviewPreviewTarget,
  right: CanvasWebviewPreviewTarget,
): boolean {
  return left.projectId === right.projectId
    && left.canvasId === right.canvasId
    && left.nodeId === right.nodeId
    && left.prototypeId === right.prototypeId
    && left.contentRevision === right.contentRevision
    && left.devicePreset === right.devicePreset
}

/**
 * 创建可执行 WebView 页面身份，刻意忽略设备预设。
 * @param target 包含设备预设的完整静态预览目标。
 * @returns 仅由页面内容身份组成的稳定键。
 */
export function createCanvasWebviewFrameIdentity(
  target: CanvasWebviewPreviewTarget,
): string {
  return [
    target.projectId,
    target.canvasId,
    target.nodeId,
    target.prototypeId,
    target.contentRevision,
  ].join('\u0000')
}

/** 创建目标首次挂载时的加载状态。 */
export function createInitialCanvasWebviewPreviewState(
  target: CanvasWebviewPreviewTarget,
): CanvasWebviewPreviewState {
  return { phase: 'loading', target, retryGeneration: 0 }
}

/**
 * 收敛卡片预览异步结果。
 * @param state 当前目标绑定的预览状态。
 * @param event 加载、失败、重试或目标切换事件。
 * @returns 丢弃迟到结果后的下一状态。
 */
export function reduceCanvasWebviewPreviewState(
  state: CanvasWebviewPreviewState,
  event: CanvasWebviewPreviewEvent,
): CanvasWebviewPreviewState {
  if (event.type === 'target-changed') {
    if (isCanvasWebviewPreviewTargetEqual(state.target, event.target)) return state
    return createInitialCanvasWebviewPreviewState(event.target)
  }
  if (event.type === 'retry') {
    return {
      phase: 'loading',
      target: state.target,
      retryGeneration: state.retryGeneration + 1,
    }
  }
  if (!isCanvasWebviewPreviewTargetEqual(state.target, event.target)) return state
  if (event.type === 'failed') {
    return { phase: 'error', target: state.target, retryGeneration: state.retryGeneration }
  }
  if (!isCanvasWebviewPreviewTargetEqual(event.snapshot.target, event.target)) return state
  return {
    phase: 'ready',
    target: state.target,
    retryGeneration: state.retryGeneration,
    snapshot: event.snapshot,
  }
}

/**
 * 判断当前静态预览是否具备发起主进程请求的条件。
 * @param state 当前预览状态，只有 loading 会产生请求。
 * @param target Renderer 当前投影出的完整预览目标。
 * @param requestReady 对应设备预设 mutation 是否已完成权威提交。
 * @returns 目标一致、仍在加载且权威提交完成时返回 true。
 */
export function shouldStartCanvasWebviewPreviewLoad(
  state: CanvasWebviewPreviewState,
  target: CanvasWebviewPreviewTarget,
  requestReady: boolean,
): boolean {
  return requestReady
    && state.phase === 'loading'
    && isCanvasWebviewPreviewTargetEqual(state.target, target)
}

/** 纯展示层输入，便于独立验证加载、成功和错误状态。 */
export interface CanvasWebviewPreviewViewProps {
  state: CanvasWebviewPreviewState
  title: string
  statusLabel: string
  onRetry: () => void
  onImageError: () => void
}

/** 静态预览状态视图不包含 iframe，也不接管节点拖拽手势。 */
export function CanvasWebviewPreviewView({
  state,
  title,
  statusLabel,
  onRetry,
  onImageError,
}: CanvasWebviewPreviewViewProps): React.ReactElement {
  if (state.phase === 'loading') {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-xs text-muted-foreground" role="status">
        <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
        <span>正在生成预览</span>
      </div>
    )
  }
  if (state.phase === 'error') {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center">
        <p className="text-xs text-muted-foreground">页面预览暂时不可用</p>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="nodrag nopan"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation()
            onRetry()
          }}
        >
          <RotateCcw className="size-3.5" aria-hidden="true" />
          重试
        </Button>
      </div>
    )
  }
  return (
    <div className="relative h-full min-h-0 bg-muted">
      <img
        src={state.snapshot.previewUrl}
        alt={`${title}页面预览`}
        className="pointer-events-none h-full w-full select-none object-contain"
        draggable={false}
        onError={onImageError}
      />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex min-w-0 items-center gap-2 bg-background/90 px-3 py-1.5 text-xs backdrop-blur-sm">
        <p className="min-w-0 flex-1 truncate font-medium text-foreground">{title}</p>
        <span className="shrink-0 text-muted-foreground" role="status">{statusLabel}</span>
      </div>
    </div>
  )
}

/** 静态预览加载器只接收完整预览目标，不读取 HTML。 */
export interface CanvasWebviewPreviewProps {
  target: CanvasWebviewPreviewTarget
  title: string
  statusLabel: string
  requestReady: boolean
  loadPreview: (target: CanvasWebviewPreviewTarget) => Promise<CanvasWebviewPreviewSnapshot>
}

/** 折叠 WebView 卡片按完整目标加载主进程生成的静态 WebP。 */
export function CanvasWebviewPreview({
  target,
  title,
  statusLabel,
  requestReady,
  loadPreview,
}: CanvasWebviewPreviewProps): React.ReactElement {
  const [state, dispatch] = React.useReducer(
    reduceCanvasWebviewPreviewState,
    target,
    createInitialCanvasWebviewPreviewState,
  )
  /** 固定字段序列化只用于 effect 身份，不承载业务数据。 */
  const targetKey = `${target.projectId}\u0000${target.canvasId}\u0000${target.nodeId}\u0000${target.prototypeId}\u0000${target.contentRevision}\u0000${target.devicePreset}`
  /** 状态目标使用同一稳定字段序列，等价对象重建不会取消或重复静态预览请求。 */
  const stateTargetKey = `${state.target.projectId}\u0000${state.target.canvasId}\u0000${state.target.nodeId}\u0000${state.target.prototypeId}\u0000${state.target.contentRevision}\u0000${state.target.devicePreset}`
  /** 目标刚切换时按新目标的初始代次加载，避免旧目标重试次数触发重复请求。 */
  const currentRetryGeneration = isCanvasWebviewPreviewTargetEqual(state.target, target)
    ? state.retryGeneration
    : 0

  React.useEffect(() => {
    dispatch({ type: 'target-changed', target })
  }, [targetKey])

  React.useEffect(() => {
    if (!shouldStartCanvasWebviewPreviewLoad(state, target, requestReady)) return
    /** cleanup 与 reducer 双重阻止旧设备或旧 revision 的迟到结果。 */
    let active = true
    void loadPreview(target).then(
      (snapshot) => {
        if (active) dispatch({ type: 'loaded', target, snapshot })
      },
      () => {
        if (active) dispatch({ type: 'failed', target })
      },
    )
    return () => { active = false }
  }, [currentRetryGeneration, loadPreview, requestReady, state.phase, stateTargetKey, targetKey])

  /** props 已切换但 effect 尚未收敛时立即显示新目标加载态。 */
  const visibleState = isCanvasWebviewPreviewTargetEqual(state.target, target)
    ? state
    : createInitialCanvasWebviewPreviewState(target)
  return (
    <CanvasWebviewPreviewView
      state={visibleState}
      title={title}
      statusLabel={statusLabel}
      onRetry={() => dispatch({ type: 'retry' })}
      onImageError={() => dispatch({ type: 'failed', target })}
    />
  )
}

/** 卡片设备菜单输入；只读时仍显示当前预设但禁止修改。 */
export interface CanvasWebviewDeviceMenuProps {
  devicePreset: CanvasWebviewDevicePreset
  writable: boolean
  onDevicePresetChange: (devicePreset: CanvasWebviewDevicePreset) => void
}

/** 折叠卡片使用紧凑设备菜单，避免挤占页面缩略图区域。 */
export function CanvasWebviewDeviceMenu({
  devicePreset,
  writable,
  onDevicePresetChange,
}: CanvasWebviewDeviceMenuProps): React.ReactElement {
  /** 当前预设图标同时作为菜单触发器的可见反馈。 */
  const DeviceIcon = devicePreset === 'mobile' ? Smartphone : Monitor
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="nodrag nopan flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
          aria-label={`切换预览设备，当前${devicePreset === 'mobile' ? '手机' : '网页'}`}
          title="切换预览设备"
          disabled={!writable}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
        >
          <DeviceIcon className="size-4" aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="bottom"
        align="end"
        className="w-48"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
      >
        <DropdownMenuRadioGroup
          value={devicePreset}
          onValueChange={(value) => {
            if (value === 'desktop' || value === 'mobile') onDevicePresetChange(value)
          }}
        >
          {CANVAS_WEBVIEW_DEVICE_OPTIONS.map((option) => (
            <DropdownMenuRadioItem key={option.value} value={option.value}>
              <span>{option.label}</span>
              <span className="ml-auto text-xs text-muted-foreground">
                {option.viewportLabel.replace(' x ', ' × ')}
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** 详情页设备分段控制输入。 */
export interface CanvasWebviewDeviceSegmentedControlProps extends CanvasWebviewDeviceMenuProps {}

/** 详情工作台使用始终可见的网页/手机分段控制。 */
export function CanvasWebviewDeviceSegmentedControl({
  devicePreset,
  writable,
  onDevicePresetChange,
}: CanvasWebviewDeviceSegmentedControlProps): React.ReactElement {
  return (
    <div className="flex items-center rounded-md border border-border bg-muted/40 p-0.5" aria-label="原型预览设备">
      {CANVAS_WEBVIEW_DEVICE_OPTIONS.map((option) => {
        const Icon = option.value === 'mobile' ? Smartphone : Monitor
        return (
          <button
            key={option.value}
            type="button"
            className={cn(
              'flex h-7 items-center gap-1.5 rounded-[4px] px-2.5 text-xs text-muted-foreground transition-colors',
              option.value === devicePreset && 'bg-background text-foreground shadow-sm',
            )}
            aria-pressed={option.value === devicePreset}
            title={`${option.label} ${option.viewportLabel.replace(' x ', ' × ')}`}
            disabled={!writable}
            onClick={() => onDevicePresetChange(option.value)}
          >
            <Icon className="size-3.5" aria-hidden="true" />
            {option.label}
          </button>
        )
      })}
    </div>
  )
}
