import * as React from 'react'
import type { CanvasDocument, CanvasEdgeRelation, CanvasNodeKind } from '@proma/shared'
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

/** 打开时才挂载列表与搜索索引，关闭后不承担图更新开销。 */
function NativeCanvasNodeNavigationMenu({ nodes, edges, selectedNodeIds, onNavigate }: NativeCanvasNodeNavigatorProps): React.ReactElement {
  /** 只依赖节点与连线数组，不随视口、选区或每帧进度重新构建关系。 */
  const items = React.useMemo(() => buildNativeCanvasNavigationItems(nodes, edges), [nodes, edges])
  const selected = React.useMemo(() => new Set(selectedNodeIds), [selectedNodeIds])
  return <Command label="画布节点" loop>
    <CommandInput placeholder="搜索节点名称、类型…" aria-label="搜索画布节点" />
    <div className="border-b px-3 py-2 text-xs text-muted-foreground">全部节点 · {items.length}</div>
    <CommandList className="max-h-[min(420px,55vh)] p-1">
      <CommandEmpty>{items.length === 0 ? '画布中暂无节点' : '没有匹配的节点'}</CommandEmpty>
      {items.map((item) => <CommandItem
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
