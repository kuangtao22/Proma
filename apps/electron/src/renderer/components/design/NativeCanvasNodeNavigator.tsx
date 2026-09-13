import * as React from 'react'
import type { CanvasDocument, CanvasEdgeRelation, CanvasNodeKind } from '@proma/shared'
import { atom, useAtom } from 'jotai'
import { useCommandState } from 'cmdk'
import { Bot, Check, FileImage, FileText, ListTree, Monitor, Music, Video } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { buildNativeCanvasNavigationItems } from './native-canvas-navigation'
import type { NativeCanvasNavigationItem } from './native-canvas-navigation'

/** 节点浏览器只接收轻量图字段与定位回调，只读画布也可使用。 */
export interface NativeCanvasNodeNavigatorProps {
  nodes: CanvasDocument['nodes']
  edges: CanvasDocument['edges']
  selectedNodeIds: readonly string[]
  onNavigate: (nodeId: string) => void
}

/** 类型图标与中文标签不依赖卡片内容或媒体加载。 */
const NODE_PRESENTATION = {
  agent: { label: 'Agent', icon: Bot },
  image: { label: '生图', icon: FileImage },
  document: { label: '文档', icon: FileText },
  webview: { label: '原型', icon: Monitor },
  audio: { label: '音频', icon: Music },
  video: { label: '视频', icon: Video },
} satisfies Record<CanvasNodeKind, { label: string; icon: typeof Bot }>

/** 类型入口复用现有展示定义；全部用于清除类型条件，顺序不随数量变化。 */
const NODE_FILTER_KINDS: readonly (CanvasNodeKind | 'all')[] = ['all', ...Object.keys(NODE_PRESENTATION) as CanvasNodeKind[]]

/** 与画布连线一致的关系名称。 */
const RELATION_LABELS: Record<CanvasEdgeRelation, string> = {
  association: '关联', reference: '引用', 'depends-on': '依赖', derives: '衍生',
}
/** 保留真实连线方向；无向关联单独展示。 */
const DIRECTION_LABELS = { upstream: '上游', downstream: '下游', association: '关联' } as const

/** 单个节点可见摘要；完整名称和关系可通过悬停查看。 */
function NativeCanvasNavigationRow({ item, selected }: {
  item: NativeCanvasNavigationItem
  selected: boolean
}): React.ReactElement {
  /** 图标按类型稳定选择，同名节点额外展示短 ID。 */
  const { label, icon: Icon } = NODE_PRESENTATION[item.kind]
  return <>
    <Icon aria-hidden="true" className="mt-0.5" />
    <div className="min-w-0 flex-1">
      <div className="flex min-w-0 items-center gap-2">
        <span className="truncate font-medium" title={item.title}>{item.title || '未命名节点'}</span>
        <span className="shrink-0 text-[10px] text-muted-foreground" title={item.id}>{label} · {item.id.slice(-6)}</span>
      </div>
      {item.relations.length === 0
        ? <p className="mt-1 text-xs text-muted-foreground">暂无关联</p>
        : (['upstream', 'downstream', 'association'] as const).map((direction) => {
          /** 每类直接关系按原边顺序输出，不递归展开循环图。 */
          const links = item.relations.filter((link) => link.direction === direction)
          if (!links.length) return null
          const summary = links.map((link) => `${link.title || '未命名节点'}${direction === 'association' ? '' : `（${RELATION_LABELS[link.relation]}）`}`).join('、')
          return <p key={direction} className="mt-1 truncate text-xs text-muted-foreground" title={`${DIRECTION_LABELS[direction]}：${summary}`}>
            {DIRECTION_LABELS[direction]}：{summary}
          </p>
        })}
    </div>
    {selected ? <Check aria-label="已选中" className="mt-0.5 text-primary" /> : null}
  </>
}

/** 读取 Command 的实际匹配数；入参为当前分类名称及画布总数，返回搜索结果提示。 */
function NativeCanvasNavigationCount({ label, total }: { label: string; total: number }): React.ReactElement {
  /** 只订阅匹配数量，避免键盘高亮变化重绘筛选控件与关系列表。 */
  const count = useCommandState((state) => state.filtered.count)
  return <div role="status" className="px-3 pb-2 text-xs text-muted-foreground">
    {label} · {count} / {total}
  </div>
}

/** 打开时才挂载列表与搜索索引，关闭后不承担图更新开销。 */
function NativeCanvasNodeNavigationMenu({ nodes, edges, selectedNodeIds, onNavigate }: NativeCanvasNodeNavigatorProps): React.ReactElement {
  /** 分类只属于当前菜单，关闭即释放，不写入共享图或跨会话状态。 */
  const kindAtom = React.useMemo(() => atom<CanvasNodeKind | 'all'>('all'), [])
  const [kind, setKind] = useAtom(kindAtom)
  /** 只依赖节点与连线数组，不随视口、选区或每帧进度重新构建关系。 */
  const items = React.useMemo(() => buildNativeCanvasNavigationItems(nodes, edges), [nodes, edges])
  const selected = React.useMemo(() => new Set(selectedNodeIds), [selectedNodeIds])
  /** 每代索引仅统计一次，按钮数量不受关键词影响，便于查看各类节点规模。 */
  const kindCounts = React.useMemo(() => {
    /** 只累计轻量类型计数，不复制节点正文或关系。 */
    const counts = new Map<CanvasNodeKind, number>()
    for (const item of items) counts.set(item.kind, (counts.get(item.kind) ?? 0) + 1)
    return counts
  }, [items])
  /** 先按真实类型限制候选，关键词仍交由 Command 搜索；关系保留完整上下游。 */
  const visibleItems = React.useMemo(() => kind === 'all' ? items : items.filter((item) => item.kind === kind), [items, kind])
  /** 当前类型名称用于计数和可恢复的空状态。 */
  const kindLabel = kind === 'all' ? '全部节点' : NODE_PRESENTATION[kind].label
  return <Command label="画布节点" loop>
    <CommandInput placeholder="搜索节点名称、类型…" aria-label="搜索画布节点" />
    <div className="border-b">
      <div role="group" aria-label="节点类型筛选" className="flex flex-wrap gap-1 px-2 py-2"
        onKeyDown={(event) => event.stopPropagation()}>
        {NODE_FILTER_KINDS.map((filterKind) => {
          /** 分类使用稳定类型身份，零数量也可选择以明确展示空状态。 */
          const label = filterKind === 'all' ? '全部' : NODE_PRESENTATION[filterKind].label
          const count = filterKind === 'all' ? items.length : kindCounts.get(filterKind) ?? 0
          return <Button key={filterKind} type="button" size="sm"
            variant={kind === filterKind ? 'secondary' : 'ghost'}
            className="h-7 gap-1.5 rounded-md px-2 text-xs"
            aria-pressed={kind === filterKind} data-canvas-navigation-kind={filterKind}
            onClick={() => setKind(filterKind)}>
            {label}<span className="text-[10px] tabular-nums text-muted-foreground">{count}</span>
          </Button>
        })}
      </div>
      <NativeCanvasNavigationCount label={kindLabel} total={items.length} />
    </div>
    <CommandList className="max-h-[min(420px,55vh)] p-1">
      <CommandEmpty>{items.length === 0 ? '画布中暂无节点'
        : visibleItems.length === 0 ? `画布中暂无${kindLabel}节点` : '没有匹配的节点'}</CommandEmpty>
      {visibleItems.map((item) => <CommandItem
        key={item.id}
        value={item.id}
        keywords={[item.title, NODE_PRESENTATION[item.kind].label]}
        onSelect={() => onNavigate(item.id)}
        className="items-start py-2.5"
        data-canvas-navigation-node={item.id}
      >
        <NativeCanvasNavigationRow item={item} selected={selected.has(item.id)} />
      </CommandItem>)}
    </CommandList>
  </Command>
}

/** 工具栏图标入口，支持搜索、方向键、Enter、Escape 与自动归还焦点。 */
export function NativeCanvasNodeNavigator(props: NativeCanvasNodeNavigatorProps): React.ReactElement {
  /** 菜单开关属于瞬时交互；节点选择与视口交由会话 atom 保存。 */
  const [open, setOpen] = React.useState(false)
  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger asChild>
      <Button type="button" variant={open ? 'secondary' : 'ghost'} size="icon-sm" className="size-8"
        aria-label="查看节点" title="查看节点">
        <ListTree aria-hidden="true" />
      </Button>
    </PopoverTrigger>
    <PopoverContent side="bottom" align="center" sideOffset={8}
      className="w-[400px] max-w-[calc(100vw-2rem)] p-0"
      onPointerDown={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
      {open ? <NativeCanvasNodeNavigationMenu {...props} onNavigate={(nodeId) => {
        props.onNavigate(nodeId)
        setOpen(false)
      }} /> : null}
    </PopoverContent>
  </Popover>
}
