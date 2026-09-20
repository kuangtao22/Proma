/** 运维工具栏：与 Proma 侧面板保持紧凑密度，窄面板允许控件换行。 */
export const SERVER_OPS_TOOLBAR_CLASS = 'flex min-h-11 shrink-0 flex-wrap items-center gap-2 border-b border-border/40 px-4 py-2'

/** 一级页签容器：沿用主题色与轻分隔，超宽导航只在自身横向滚动。 */
export const SERVER_OPS_TABS_LIST_CLASS = 'flex h-10 w-full shrink-0 items-center justify-start gap-1 overflow-x-auto rounded-none border-b border-border/40 bg-transparent px-3 py-1'

/** 页签按钮：兼容 Radix 的状态和原生导航的可访问选中属性。 */
export const SERVER_OPS_TAB_CLASS = 'inline-flex h-7 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-md px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:pointer-events-none disabled:opacity-50 data-[state=active]:bg-muted data-[state=active]:text-foreground data-[state=active]:shadow-none aria-selected:bg-muted aria-selected:text-foreground aria-[current=page]:bg-muted aria-[current=page]:text-foreground'

/** 二级筛选使用 Proma 设置页同款分段底色，避免再套一层线框。 */
export const SERVER_OPS_SEGMENTED_CLASS = 'inline-flex min-h-8 max-w-full items-center gap-0.5 overflow-x-auto rounded-lg bg-muted/60 p-0.5'

/** 运维内容卡：复用全局圆角与卡片主题，不引入独立色板或阴影。 */
export const SERVER_OPS_CARD_CLASS = 'min-w-0 overflow-hidden rounded-xl border border-border/40 bg-card/60'

/** 结果网格：弱化行分隔、突出表头，正文维持紧凑且可读的密度。 */
export const SERVER_OPS_TABLE_CLASS = 'w-full border-collapse text-xs [&_th]:bg-muted/40 [&_th]:px-3 [&_th]:py-2 [&_th]:text-left [&_th]:text-[11px] [&_th]:font-medium [&_th]:text-muted-foreground [&_td]:border-b [&_td]:border-border/30 [&_td]:px-3 [&_td]:py-2 [&_td]:align-top [&_tbody_tr]:transition-colors [&_tbody_tr:hover]:bg-muted/30'

/** 底部状态行：采样、数量和分页使用相同的轻量视觉层级。 */
export const SERVER_OPS_STATUSBAR_CLASS = 'flex min-h-8 shrink-0 flex-wrap items-center gap-2 border-t border-border/40 px-4 py-1.5 text-[11px] text-muted-foreground'
