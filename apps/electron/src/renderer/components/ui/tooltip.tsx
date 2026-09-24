/**
 * Tooltip 工具提示组件
 *
 * 基于 Radix UI Tooltip 原语，
 * 用于鼠标悬停时显示额外信息。
 */

import * as React from "react"
import * as TooltipPrimitive from "@radix-ui/react-tooltip"

import { cn } from "@/lib/utils"

const TooltipProvider = TooltipPrimitive.Provider

/** 当前聊天区域的真实 DOM 边界，供 Portal 内容计算碰撞位置。 */
const TooltipBoundaryContext = React.createContext<HTMLElement | null>(null)

/** 边界为 null 时使用默认视口；children 为该区域内的提示框触发内容。 */
interface TooltipBoundaryProviderProps {
  boundary: HTMLElement | null
  children: React.ReactNode
}

/** 为 children 提供 boundary 碰撞边界并返回 Provider，不改变原生网页可见性。 */
function TooltipBoundaryProvider({
  boundary,
  children,
}: TooltipBoundaryProviderProps): React.ReactElement {
  return <TooltipBoundaryContext.Provider value={boundary}>{children}</TooltipBoundaryContext.Provider>
}

const Tooltip = TooltipPrimitive.Root

const TooltipTrigger = TooltipPrimitive.Trigger

const TooltipContent = React.forwardRef<
  React.ElementRef<typeof TooltipPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(({ className, sideOffset = 4, collisionBoundary, collisionPadding = 8, ...props }, ref) => {
  /** 读取外层 Pane，为传送到 body 的提示保留区域约束。 */
  const boundary = React.useContext(TooltipBoundaryContext)
  /** 调用方显式指定的边界优先，否则继承当前 Pane。 */
  const resolvedBoundary = collisionBoundary ?? boundary ?? undefined
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        ref={ref}
        sideOffset={sideOffset}
        collisionBoundary={resolvedBoundary}
        collisionPadding={collisionPadding}
        className={cn(
          "z-[10050] max-w-[min(20rem,var(--radix-tooltip-content-available-width),calc(100vw-1rem))] overflow-hidden rounded-lg px-3 py-2 text-xs",
          "bg-tooltip text-tooltip-foreground",
          "shadow-lg shadow-black/25",
          "animate-in fade-in-0 zoom-in-95",
          "data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95",
          "data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2",
          // 内部次要文字使用 tooltip-muted 颜色
          "[&_.text-muted-foreground]:text-tooltip-muted",
          className
        )}
        {...props}
      />
    </TooltipPrimitive.Portal>
  )
})
TooltipContent.displayName = TooltipPrimitive.Content.displayName

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider, TooltipBoundaryProvider }
