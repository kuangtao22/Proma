import type { ReactElement, ReactNode } from 'react'
import { ArrowLeft } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { SettingsSection } from './primitives'

/** 媒体列表与独立编辑页共用的页面结构。 */
interface MediaSettingsPageProps {
  /** 当前列表、添加或编辑页面的标题。 */
  title: string
  /** 列表页右侧的添加操作，编辑态不显示。 */
  action?: ReactNode
  /** 提供此回调时进入编辑页，返回沿用该表单的取消逻辑。 */
  onBack?: () => void
  /** 写入或资源操作期间禁止离开表单。 */
  busy?: boolean
  /** 当前页面的列表或表单内容。 */
  children: ReactNode
}

/** 根据返回回调切换列表标题与编辑标题，复用模型配置表单的字号和按钮样式。 */
export function MediaSettingsPage({ title, action, onBack, busy, children }: MediaSettingsPageProps): ReactElement {
  if (!onBack) return <SettingsSection title={title} action={action}>{children}</SettingsSection>

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Button type="button" variant="ghost" size="icon" className="h-8 w-8 shrink-0" aria-label="返回列表" title="返回列表" disabled={busy} onClick={onBack}>
          <ArrowLeft size={18} />
        </Button>
        <h3 className="min-w-0 flex-1 break-words text-lg font-medium text-foreground">{title}</h3>
      </div>
      {children}
    </div>
  )
}
