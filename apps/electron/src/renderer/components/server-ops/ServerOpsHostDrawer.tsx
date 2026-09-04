import * as React from 'react'
import { MoreHorizontal, PanelLeftClose, Pencil, Plus, Server, Trash2 } from 'lucide-react'
import type { ServerOpsHost } from '@proma/shared'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

/** 服务器抽屉属性。 */
export interface ServerOpsHostDrawerProps {
  open: boolean
  hosts: readonly ServerOpsHost[]
  selectedHostId: string | null
  onOpenChange: (open: boolean) => void
  onSelect: (hostId: string) => void
  onCreate: () => void
  onEdit: (host: ServerOpsHost) => void
  onDelete: (host: ServerOpsHost) => void
}

/** 选择服务器并关闭当前 Pane 抽屉。 */
export function selectServerOpsHostFromDrawer(
  hostId: string,
  onSelect: (hostId: string) => void,
  onOpenChange: (open: boolean) => void,
): void {
  onSelect(hostId)
  onOpenChange(false)
}

/** Canvas 风格的服务器选择抽屉。 */
export function ServerOpsHostDrawer({
  open,
  hosts,
  selectedHostId,
  onOpenChange,
  onSelect,
  onCreate,
  onEdit,
  onDelete,
}: ServerOpsHostDrawerProps): React.ReactElement | null {
  /** 抽屉打开后接收键盘焦点的收起按钮。 */
  const closeButtonRef = React.useRef<HTMLButtonElement>(null)

  React.useEffect(() => {
    if (open) closeButtonRef.current?.focus()
  }, [open])

  React.useEffect(() => {
    if (!open) return
    /** 处理当前 Pane 抽屉的 Escape 关闭语义。 */
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onOpenChange(false)
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onOpenChange, open])

  if (!open) return null

  return (
    <TooltipProvider delayDuration={200} disableHoverableContent>
      <div className="absolute inset-0 z-30" data-server-ops-host-drawer>
        <button
          type="button"
          className="absolute inset-0 cursor-default bg-background/35"
          aria-label="关闭服务器列表"
          onClick={() => onOpenChange(false)}
        />
        <aside
          role="dialog"
          aria-modal="false"
          aria-label="服务器列表"
          className="absolute inset-y-0 left-0 flex w-60 max-w-[80%] flex-col border-r border-border bg-background text-foreground shadow-xl"
        >
          <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-2">
            <span className="min-w-0 flex-1 truncate px-2 text-sm font-medium">服务器</span>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  ref={closeButtonRef}
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="收起服务器列表"
                  onClick={() => onOpenChange(false)}
                >
                  <PanelLeftClose className="size-3.5" aria-hidden="true" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="right">收起服务器列表</TooltipContent>
            </Tooltip>
          </div>
          <div className="border-b border-border p-2">
            <Button type="button" variant="ghost" size="sm" className="w-full justify-start" onClick={onCreate}>
              <Plus className="size-3.5" aria-hidden="true" />
              添加服务器
            </Button>
          </div>
          <ScrollArea className="min-h-0 flex-1">
            <div className="space-y-0.5 p-2">
              {hosts.length === 0 ? (
                <p className="px-2 py-5 text-center text-xs text-muted-foreground">暂无服务器</p>
              ) : hosts.map((host) => {
                /** 当前列表行是否对应已选服务器。 */
                const current = host.id === selectedHostId
                return (
                  <div
                    key={host.id}
                    className={cn(
                      'group flex min-h-10 items-center gap-1 rounded-md pr-1 transition-colors',
                      current ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/60',
                    )}
                  >
                    <button
                      type="button"
                      className="flex min-w-0 flex-1 items-center gap-2 px-2 py-2 text-left"
                      aria-current={current ? 'page' : undefined}
                      onClick={() => selectServerOpsHostFromDrawer(host.id, onSelect, onOpenChange)}
                    >
                      <Server className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-xs font-medium">{host.name}</span>
                        <span className="block truncate text-[10px] text-muted-foreground">{host.username}@{host.address}:{host.port}</span>
                      </span>
                    </button>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button type="button" variant="ghost" size="icon-sm" aria-label={`管理服务器 ${host.name}`}>
                          <MoreHorizontal className="size-3.5" aria-hidden="true" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="start" side="right">
                        <DropdownMenuItem onSelect={() => onEdit(host)}>
                          <Pencil className="size-3.5" aria-hidden="true" />
                          编辑
                        </DropdownMenuItem>
                        <DropdownMenuItem className="text-destructive focus:text-destructive" onSelect={() => onDelete(host)}>
                          <Trash2 className="size-3.5" aria-hidden="true" />
                          删除
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                )
              })}
            </div>
          </ScrollArea>
        </aside>
      </div>
    </TooltipProvider>
  )
}
