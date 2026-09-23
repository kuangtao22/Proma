import * as React from 'react'
import { createPortal } from 'react-dom'
import { atom, useAtom } from 'jotai'
import { Database } from 'lucide-react'
import { createServerOpsLocalSqliteDragController } from './server-ops-local-sqlite-drag'

/** 面板的可见矩形；展开工作台时使用展开宿主的实际范围。 */
interface DropBounds { left: number; top: number; width: number; height: number }

/** 只包含短期视觉状态，不保存文件或数据库正文。 */
interface DropState { dragging: boolean; contextKey: string | null; bounds: DropBounds | null }

/** 整个运维面板共用现有本地 SQLite 导入入口。 */
export interface ServerOpsLocalSqliteDropZoneProps {
  children: React.ReactNode
  contextKey: string | null
  projectLabel: string
  enabled: boolean
  busy: boolean
  onFiles(files: readonly File[]): void
}

/**
 * 文件进入时覆盖当前运维面板，松手后交给既有只读导入流程。
 * Portal 仅用于视觉覆盖，事件仍限定在实际面板 DOM 内，不影响聊天和其他 Pane。
 */
export function ServerOpsLocalSqliteDropZone(props: ServerOpsLocalSqliteDropZoneProps): React.ReactElement {
  /** 面板 DOM 与最新业务回调分开保存，拖拽控制器不捕获旧项目。 */
  const rootRef = React.useRef<HTMLDivElement>(null)
  const propsRef = React.useRef(props)
  propsRef.current = props
  /** 当前组件独享的 Jotai 视觉投影。 */
  const [stateAtom] = React.useState(() => atom<DropState>({ dragging: false, contextKey: null, bounds: null }))
  const [state, setState] = useAtom(stateAtom)
  /** 控制器只在挂载时创建一次；所有业务条件从最新 props 读取。 */
  const [controller] = React.useState(() => createServerOpsLocalSqliteDragController({
    isEnabled: () => propsRef.current.enabled,
    isBusy: () => propsRef.current.busy,
    onDraggingChange: (dragging) => setState({ dragging, contextKey: propsRef.current.contextKey, bounds: null }),
    onFiles: (files) => propsRef.current.onFiles(files),
  }))
  /** 切换项目或隐藏 Pane 的当帧就隐藏旧提示，避免提示指向新项目。 */
  const visible = props.enabled && !props.busy && state.dragging && state.contextKey === props.contextKey

  React.useEffect(() => { controller.reset() }, [controller, props.contextKey, props.enabled, props.busy])
  React.useEffect(() => {
    /** 外部松手、取消拖动或切到另一个应用时清理未配对的 enter 事件。 */
    const reset = (): void => controller.reset()
    const onKeyDown = (event: KeyboardEvent): void => { if (event.key === 'Escape') reset() }
    window.addEventListener('drop', reset)
    window.addEventListener('dragend', reset)
    window.addEventListener('blur', reset)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('drop', reset)
      window.removeEventListener('dragend', reset)
      window.removeEventListener('blur', reset)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [controller])
  React.useEffect(() => {
    if (!visible || !rootRef.current) return
    /** 展开工作台的 fixed 宿主可以超出 Pane，提示与该宿主同范围。 */
    const surface = rootRef.current.querySelector<HTMLElement>('[data-server-ops-workbench-expanded="true"]') ?? rootRef.current
    /** 只在拖入或布局变化时读取尺寸，不在每个 dragover 中强制布局。 */
    const measure = (): void => {
      const rect = surface.getBoundingClientRect()
      const bounds = { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
      setState((previous) => previous.bounds?.left === bounds.left && previous.bounds.top === bounds.top
        && previous.bounds.width === bounds.width && previous.bounds.height === bounds.height ? previous : { ...previous, bounds })
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(surface)
    window.addEventListener('resize', measure)
    window.addEventListener('scroll', measure, true)
    return () => { observer.disconnect(); window.removeEventListener('resize', measure); window.removeEventListener('scroll', measure, true) }
  }, [visible, props.contextKey, setState])

  /** React Portal 会沿组件树冒泡；连接设置等弹窗不属于底层面板投放范围。 */
  const insidePanel = (event: React.DragEvent<HTMLDivElement>): boolean => rootRef.current?.contains(event.target as Node) === true

  return <div ref={rootRef} tabIndex={-1} className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden outline-none" data-server-ops-local-sqlite-drop-surface
    onDragEnterCapture={(event) => {
      if (!insidePanel(event)) return
      // 文件进入可见但未聚焦的 Pane 时，复用父级焦点机制确定导入目标；普通文本不抢焦点。
      if (event.dataTransfer.types.includes('Files') || event.dataTransfer.files.length > 0) event.currentTarget.focus({ preventScroll: true })
      controller.enter(event)
    }}
    onDragOverCapture={(event) => { if (insidePanel(event)) controller.over(event) }}
    onDragLeaveCapture={(event) => { if (insidePanel(event)) controller.leave() }}
    onDropCapture={(event) => { if (insidePanel(event)) controller.drop(event) }}>
    {props.children}
    {visible && state.bounds ? createPortal(
      <div className="pointer-events-none fixed z-[300] p-3" style={state.bounds} data-server-ops-local-sqlite-drop-overlay>
        <div role="status" className="flex h-full min-h-0 flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed border-primary/60 bg-background/95 px-6 text-center text-foreground backdrop-blur-sm">
          <div className="flex size-14 shrink-0 items-center justify-center rounded-2xl bg-primary/10">
            <Database className="size-7" aria-hidden="true" />
          </div>
          <p className="text-base font-medium">松开以导入本地数据库</p>
          <p className="max-w-sm text-sm text-muted-foreground">添加到「{props.projectLabel}」，只读打开 SQLite 文件</p>
          <p className="text-xs text-muted-foreground">支持 .db、.sqlite、.sqlite3</p>
        </div>
      </div>, document.body,
    ) : null}
  </div>
}
