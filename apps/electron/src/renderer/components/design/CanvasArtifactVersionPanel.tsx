import * as React from 'react'
import type { CanvasArtifactRevisionSummary } from '@proma/shared'
import { Check, History, LoaderCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'

/** Canvas 文本产物共用版本面板的受控输入。 */
export interface CanvasArtifactVersionPanelProps {
  revisions: CanvasArtifactRevisionSummary[]
  currentRevision: number
  selectedRevision: number | null
  loading: boolean
  writable: boolean
  adopting?: boolean
  error?: string | null
  currentContent?: string
  selectedContent?: string
  selectedContentLoading?: boolean
  onSelect: (revision: number) => void
  onAdopt: (revision: number) => void
}

/** 将不可变修订按 revision 与创建时间稳定倒序，不改写 Adapter 返回数组。 */
function sortArtifactRevisions(
  revisions: CanvasArtifactRevisionSummary[],
): CanvasArtifactRevisionSummary[] {
  return [...revisions].sort((left, right) => (
    right.revision - left.revision || right.createdAt - left.createdAt
  ))
}

/** 文档和 WebView 共用的紧凑版本列表与只读文本比较面板。 */
export function CanvasArtifactVersionPanel(
  props: CanvasArtifactVersionPanelProps,
): React.ReactElement {
  /** 版本始终使用稳定倒序，键盘 Tab 顺序与视觉顺序一致。 */
  const revisions = React.useMemo(() => sortArtifactRevisions(props.revisions), [props.revisions])
  /** 当前选择用于采用动作和双栏比较。 */
  const selectedRevision = props.selectedRevision
  /** 当前版本不可重复采用，只读项目也不能改变节点引用。 */
  const adoptDisabled = !props.writable
    || props.adopting === true
    || selectedRevision === null
    || selectedRevision === props.currentRevision

  if (props.loading) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-xs text-muted-foreground" role="status">
        <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
        <span>正在加载版本</span>
      </div>
    )
  }

  return (
    <div className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)]" aria-label="产物版本面板">
      <div className="flex min-w-0 items-center gap-2 border-b border-border px-3 py-2">
        <History className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate text-xs font-medium">版本历史</span>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="max-w-44 shrink-0"
          disabled={adoptDisabled}
          onClick={() => { if (selectedRevision !== null) props.onAdopt(selectedRevision) }}
        >
          {props.adopting ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : <Check aria-hidden="true" />}
          <span className="truncate">
            {selectedRevision === props.currentRevision
              ? '采用当前版本'
              : selectedRevision === null ? '选择版本' : `采用版本 ${selectedRevision}`}
          </span>
        </Button>
      </div>

      <div className="grid min-h-0 grid-cols-[9.5rem_minmax(0,1fr)]">
        <ScrollArea className="min-h-0 border-r border-border" aria-label="版本列表">
          {revisions.length === 0 ? (
            <p className="px-3 py-6 text-center text-xs text-muted-foreground">暂无历史版本</p>
          ) : (
            <div className="space-y-1 p-2">
              {revisions.map((revision) => {
                /** 当前采用和当前选择分别使用文字与边框表达，避免只依赖颜色。 */
                const current = revision.revision === props.currentRevision
                const selected = revision.revision === selectedRevision
                return (
                  <button
                    key={revision.revision}
                    type="button"
                    className={cn(
                      'flex w-full items-center justify-between gap-2 rounded-sm border px-2 py-1.5 text-left text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      selected ? 'border-primary bg-accent text-accent-foreground' : 'border-transparent hover:bg-accent/70',
                    )}
                    aria-label={`版本 ${revision.revision}${current ? '（当前）' : ''}`}
                    aria-pressed={selected}
                    onClick={() => props.onSelect(revision.revision)}
                  >
                    <span className="font-medium">v{revision.revision}</span>
                    {current && <span className="text-[10px] text-muted-foreground">当前</span>}
                  </button>
                )
              })}
            </div>
          )}
        </ScrollArea>

        <div className="min-h-0 overflow-auto p-3">
          {props.error ? (
            <p className="text-xs text-destructive" role="alert">{props.error}</p>
          ) : selectedRevision === null || selectedRevision === props.currentRevision ? (
            <p className="flex h-full items-center justify-center text-xs text-muted-foreground">
              选择历史版本后可与当前版本比较
            </p>
          ) : props.selectedContentLoading ? (
            <div className="flex h-full items-center justify-center gap-2 text-xs text-muted-foreground" role="status">
              <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
              <span>正在加载版本内容</span>
            </div>
          ) : (
            <div className="grid min-h-full grid-cols-1 gap-3 xl:grid-cols-2" aria-label="版本文本比较">
              <section className="min-w-0" aria-label="当前版本内容">
                <h4 className="mb-2 text-[11px] font-medium text-muted-foreground">当前版本</h4>
                <pre className="min-h-40 whitespace-pre-wrap break-words rounded-sm border border-border bg-muted/25 p-3 text-xs leading-5">{props.currentContent ?? ''}</pre>
              </section>
              <section className="min-w-0" aria-label="历史版本内容">
                <h4 className="mb-2 text-[11px] font-medium text-muted-foreground">版本 {selectedRevision}</h4>
                <pre className="min-h-40 whitespace-pre-wrap break-words rounded-sm border border-border bg-muted/25 p-3 text-xs leading-5">{props.selectedContent ?? ''}</pre>
              </section>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
