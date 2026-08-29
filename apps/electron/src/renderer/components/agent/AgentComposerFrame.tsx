import * as React from 'react'
import { InputToolbarOverflow, type ToolbarItem } from '@/components/ai-elements/InputToolbarOverflow'
import { cn } from '@/lib/utils'

/** Agent 输入框共享外壳属性。 */
export interface AgentComposerFrameProps extends React.HTMLAttributes<HTMLDivElement> {
  /** 输入框主体及其上方的附件、提示等内容。 */
  children: React.ReactNode
  /** 底部左侧工具项；Canvas 等轻量入口可以传空数组。 */
  toolbarItems?: ToolbarItem[]
  /** 底部右侧固定控件，例如模型选择、发送或停止。 */
  trailing?: React.ReactNode
}

const EMPTY_TOOLBAR_ITEMS: ToolbarItem[] = []

/**
 * 统一普通 Agent 与 Canvas Agent 的输入框表面和底部工具栏布局。
 * @param props 输入内容、工具项、尾部操作及容器原生属性。
 * @returns 使用同一主题、间距与响应式工具栏的输入框外壳。
 */
export function AgentComposerFrame({
  children,
  toolbarItems = EMPTY_TOOLBAR_ITEMS,
  trailing,
  className,
  ...props
}: AgentComposerFrameProps): React.ReactElement {
  return (
    <div
      {...props}
      data-agent-composer-frame="true"
      className={cn(
        'rounded-[17px] border-[0.5px] border-border bg-background/70 backdrop-blur-sm transition-all duration-200',
        className,
      )}
    >
      {children}
      <InputToolbarOverflow items={toolbarItems} trailing={trailing} />
    </div>
  )
}
