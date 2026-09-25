/**
 * 可拖动分隔条：拖鼠标或按方向键调整相邻两栏的尺寸。
 *
 * 工作台里有两条：左侧「目录 ↔ 编辑器」（左右拖）与上方「请求 ↔ 响应」（上下拖）。
 * 无障碍与键盘：`role="separator"` + aria-orientation + 方向键按固定步长调整，
 * 键盘用户不必用鼠标也能改变布局。
 */

import * as React from 'react'
import { cn } from '@/lib/utils'

export interface ApiSplitHandleProps {
  orientation: 'vertical' | 'horizontal'
  /** 可读名称，例如「调整目录宽度」。 */
  label: string
  /** 鼠标拖动回调：delta 是相对上一次移动的位移（像素）。 */
  onDrag: (delta: number) => void
  /** 键盘调整回调：按一次方向键调整一格。 */
  onStep: (direction: -1 | 1) => void
}

export function ApiSplitHandle({ orientation, label, onDrag, onStep }: ApiSplitHandleProps): React.ReactElement {
  const vertical = orientation === 'vertical'
  return (
    <div
      role="separator"
      aria-orientation={orientation}
      aria-label={label}
      tabIndex={0}
      className={cn(
        'group relative z-10 shrink-0 bg-border/40 transition-colors hover:bg-primary/40 focus-visible:bg-primary/60 focus-visible:outline-none',
        vertical ? 'w-1 cursor-col-resize' : 'h-1 cursor-row-resize',
      )}
      onPointerDown={(event) => {
        /**
         * 拖动期间监听 window：拖出元素范围也不丢事件，且不依赖指针捕获
         * （合成事件与部分环境里 setPointerCapture 会失败，那会让分隔条直接拖不动）。
         */
        event.preventDefault()
        let last = vertical ? event.clientX : event.clientY
        const move = (moveEvent: PointerEvent): void => {
          const current = vertical ? moveEvent.clientX : moveEvent.clientY
          onDrag(current - last)
          last = current
        }
        const finish = (): void => {
          window.removeEventListener('pointermove', move)
          window.removeEventListener('pointerup', finish)
          window.removeEventListener('pointercancel', finish)
        }
        window.addEventListener('pointermove', move)
        window.addEventListener('pointerup', finish)
        window.addEventListener('pointercancel', finish)
      }}
      onKeyDown={(event) => {
        /** 左/上缩小相邻主区、右/下放大；水平分隔条用上下键。 */
        const decrease = vertical ? event.key === 'ArrowLeft' : event.key === 'ArrowUp'
        const increase = vertical ? event.key === 'ArrowRight' : event.key === 'ArrowDown'
        if (!decrease && !increase) return
        event.preventDefault()
        onStep(increase ? 1 : -1)
      }}
    >
      {/* 更宽的命中区域：视觉上仍是 4px 细线，鼠标不用对准。 */}
      <span className={cn('absolute', vertical ? 'inset-y-0 -left-1 -right-1' : 'inset-x-0 -top-1 -bottom-1')} aria-hidden="true" />
    </div>
  )
}
