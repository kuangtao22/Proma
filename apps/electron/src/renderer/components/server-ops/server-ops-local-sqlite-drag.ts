/** 拖拽控制器只使用浏览器事件的必要字段，不读取文件内容。 */
export interface ServerOpsLocalSqliteDragEvent {
  dataTransfer: { types: readonly string[]; files: ArrayLike<File>; dropEffect: string }
  preventDefault(): void
  stopPropagation(): void
}

/** 读取实时可用性，防止拖动开始后切项目或进入导入中仍使用旧状态。 */
interface ServerOpsLocalSqliteDragOptions {
  isEnabled(): boolean
  isBusy(): boolean
  onDraggingChange(dragging: boolean): void
  onFiles(files: readonly File[]): void
}

/** 整面板拖拽动作；reset 用于项目切换、窗口失焦或外部取消。 */
export interface ServerOpsLocalSqliteDragController {
  enter(event: ServerOpsLocalSqliteDragEvent): void
  over(event: ServerOpsLocalSqliteDragEvent): void
  leave(): void
  drop(event: ServerOpsLocalSqliteDragEvent): void
  reset(): void
}

/** 创建文件拖拽控制器；嵌套 enter/leave 计数保证跨卡片移动不闪烁。 */
export function createServerOpsLocalSqliteDragController(options: ServerOpsLocalSqliteDragOptions): ServerOpsLocalSqliteDragController {
  /** 当前进入但尚未离开的 DOM 层数。 */
  let depth = 0
  /** 只在可见性真正变化时更新 React 状态，dragover 不重复渲染。 */
  const setDepth = (next: number): void => {
    const changed = (depth > 0) !== (next > 0)
    depth = next
    if (changed) options.onDraggingChange(depth > 0)
  }
  /** 只拦截文件拖放，文本选择与普通链接拖动保持原行为。 */
  const isFileDrag = (event: ServerOpsLocalSqliteDragEvent): boolean => event.dataTransfer.types.includes('Files') || event.dataTransfer.files.length > 0
  /** 进入或悬停时既给系统投放反馈，也阻止父级误把文件作为会话附件。 */
  const accept = (event: ServerOpsLocalSqliteDragEvent): boolean => {
    if (!isFileDrag(event)) return false
    event.preventDefault()
    event.stopPropagation()
    const enabled = options.isEnabled() && !options.isBusy()
    event.dataTransfer.dropEffect = enabled ? 'copy' : 'none'
    return enabled
  }
  return {
    enter(event): void { if (accept(event)) setDepth(depth + 1) },
    over(event): void { if (accept(event) && depth === 0) setDepth(1) },
    leave(): void { setDepth(Math.max(0, depth - 1)) },
    reset(): void { setDepth(0) },
    drop(event): void {
      const accepted = accept(event)
      setDepth(0)
      if (accepted && event.dataTransfer.files.length > 0) options.onFiles(Array.from(event.dataTransfer.files))
    },
  }
}
