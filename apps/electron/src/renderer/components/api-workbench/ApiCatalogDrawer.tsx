/**
 * 窄栏（compact）模式下的接口目录抽屉。
 *
 * 为什么不用通用 Sheet：`SheetContent` 是 `fixed inset-y-0 left-0`，锚的是**整个窗口**的左边缘，
 * 而工作台常常只占右侧一栏，展开时目录会“飞到”窗口最左边并盖住整窗。
 * 这里改成在**工作台自己的容器内**绝对定位滑出，位置始终跟着这一栏。
 */

import * as React from 'react'

export interface ApiCatalogDrawerProps {
  open: boolean
  onClose: () => void
  /** 目录内容（集合 / 文件夹 / 请求 / 流程）。 */
  children: React.ReactNode
}

export function ApiCatalogDrawer({ open, onClose, children }: ApiCatalogDrawerProps): React.ReactElement | null {
  const panelRef = React.useRef<HTMLDivElement>(null)
  React.useEffect(() => {
    if (!open) return
    /** Esc 关闭，并把焦点移入抽屉，避免键盘焦点留在背后的编辑器里。 */
    const handleKeyDown = (event: KeyboardEvent): void => { if (event.key === 'Escape') onClose() }
    document.addEventListener('keydown', handleKeyDown)
    panelRef.current?.focus()
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [open, onClose])
  if (!open) return null
  return (
    <div className="absolute inset-0 z-40">
      <button type="button" aria-label="关闭接口目录" className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-label="接口目录"
        className="absolute inset-y-0 left-0 flex h-full w-[min(86vw,320px)] flex-col overflow-hidden border-r border-border/50 bg-dialog text-dialog-foreground shadow-xl outline-none"
      >
        {children}
      </div>
    </div>
  )
}
