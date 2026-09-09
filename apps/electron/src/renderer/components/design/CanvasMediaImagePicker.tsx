import * as React from 'react'
import type { MediaAssetRecord } from '@proma/shared'
import { Check, ChevronDown, ImageIcon, ImageOff, LoaderCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

/** 图片选择器只接收项目目录中的素材记录，选择后仍返回原始素材身份。 */
interface CanvasMediaImagePickerProps {
  projectId?: string
  assets: readonly MediaAssetRecord[]
  value: string
  label: string
  disabled: boolean
  onSelect(asset: MediaAssetRecord): void
}

/** 每个可见缩略图持有自己的 Blob URL；离屏、换图和卸载后立即回收。 */
function AssetThumbnail({ projectId, asset }: {
  projectId?: string
  asset: MediaAssetRecord
}): React.ReactElement {
  /** 固定尺寸宿主供浏览器按真实滚动裁剪区域判断可见性。 */
  const element = React.useRef<HTMLSpanElement>(null)
  /** 仅可见行和当前已选图片才读取缩略图，长目录不批量读取文件。 */
  const [visible, setVisible] = React.useState(false)
  /** 当前生命周期内的预览地址与读取状态。 */
  const [preview, setPreview] = React.useState<{ url?: string; failed?: boolean }>({})

  React.useEffect(() => {
    if (!element.current) return
    /** 一小段预加载距离减少滚动时的空白，同时保持内存与可视行数相关。 */
    const observer = new IntersectionObserver(([entry]) => setVisible(entry?.isIntersecting ?? false), { rootMargin: '80px' })
    observer.observe(element.current)
    return () => observer.disconnect()
  }, [])

  React.useEffect(() => {
    setPreview({})
    if (!visible || !projectId || asset.mediaKind !== 'image') return
    /** 迟到响应不能恢复已关闭、离屏或切换项目的预览。 */
    let active = true
    /** 本轮唯一的临时 URL，清理后不保留图片字节。 */
    let url: string | undefined
    void Promise.resolve().then(() => window.electronAPI.mediaReadAssetThumbnail(projectId, {
      assetId: asset.id, revision: asset.revision, hash: asset.hash, mediaKind: 'image',
    })).then((result) => {
      if (!active) return
      url = URL.createObjectURL(new Blob([new Uint8Array(result.bytes)], { type: result.contentType }))
      setPreview({ url })
    }).catch(() => { if (active) setPreview({ failed: true }) })
    return () => {
      active = false
      if (url) URL.revokeObjectURL(url)
    }
  }, [visible, projectId, asset.id, asset.revision, asset.hash, asset.mediaKind])

  return (
    <span ref={element} className="flex h-16 w-20 shrink-0 items-center justify-center overflow-hidden rounded-sm bg-muted/60" title={preview.failed ? '预览不可用' : undefined}>
      {preview.url && !preview.failed ? <img src={preview.url} alt={asset.filename} className="h-full w-full object-contain" decoding="async" onError={() => setPreview((current) => ({ ...current, failed: true }))} />
        : preview.failed ? <ImageOff aria-label="预览不可用" className="size-5 text-muted-foreground" />
          : visible && projectId ? <LoaderCircle aria-label="加载图片" className="size-5 animate-spin text-muted-foreground motion-reduce:animate-none" />
            : <ImageIcon aria-hidden="true" className="size-5 text-muted-foreground" />}
    </span>
  )
}

/** 文件名和真实尺寸始终可见；重名素材仍以独立 assetId 选择。 */
function AssetLabel({ asset }: { asset: MediaAssetRecord }): React.ReactElement {
  return <span className="min-w-0 flex-1 text-left">
    <span className="line-clamp-2 break-all text-xs leading-5" title={asset.filename}>{asset.filename}</span>
    {asset.mediaKind === 'image' ? <span className="mt-1 block text-[11px] text-muted-foreground">{asset.metadata.width} x {asset.metadata.height}</span> : null}
  </span>
}

/** 复用 Radix 弹层与 Command 键盘导航，为全部项目图片提供可搜索的缩略图列表。 */
export function CanvasMediaImagePicker({ projectId, assets, value, label, disabled, onSelect }: CanvasMediaImagePickerProps): React.ReactElement {
  /** 弹层状态在选择完成时关闭；关闭即卸载列表中的预览资源。 */
  const [open, setOpen] = React.useState(false)
  /** 文件名采用连续文本匹配，避免 UUID 模糊命中大量无关图片。 */
  const [query, setQuery] = React.useState('')
  /** 只接受图片，保留目录顺序和每项稳定身份。 */
  const images = assets.filter((asset) => asset.mediaKind === 'image')
  /** 已选图片不依赖下拉框是否打开，在表单中持续展示。 */
  const selected = images.find((asset) => asset.id === value)
  /** 搜索只改变展示集合，不改变素材顺序或保存身份。 */
  const filteredImages = images.filter((asset) => asset.filename.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
  /** 项目切换和工作台进入忙碌状态时不能继续操作旧列表。 */
  React.useEffect(() => { setOpen(false) }, [projectId, disabled])
  return <Popover open={open && !disabled} onOpenChange={(nextOpen) => { setOpen(nextOpen); if (nextOpen) setQuery('') }}>
    <PopoverTrigger asChild>
      <Button type="button" variant="outline" disabled={disabled} aria-label={`选择${label}`} aria-haspopup="dialog"
        className="h-auto min-h-20 min-w-0 flex-1 justify-start gap-3 px-2 py-2 font-normal whitespace-normal">
        {selected ? <><AssetThumbnail key={`${projectId}:${selected.id}:${selected.revision}:${selected.hash}`} projectId={projectId} asset={selected} /><AssetLabel asset={selected} /></>
          : <><span className="flex h-16 w-20 shrink-0 items-center justify-center rounded-sm bg-muted/60"><ImageIcon className="size-5 text-muted-foreground" /></span><span className="min-w-0 flex-1 text-left text-xs text-muted-foreground">{value ? '素材不可用，请重新选择' : '选择图片'}</span></>}
        <ChevronDown aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
      </Button>
    </PopoverTrigger>
    <PopoverContent align="end" collisionPadding={16} aria-label={`${label}图片列表`} className="w-[440px] max-w-[calc(100vw-32px)] p-0">
      <Command shouldFilter={false}>
        <CommandInput aria-label="搜索图片" placeholder="搜索图片" value={query} onValueChange={setQuery} />
        <CommandList className="max-h-[min(360px,calc(var(--radix-popover-content-available-height)-52px))]" aria-label="图片素材">
          <CommandEmpty>{images.length === 0 ? '暂无图片' : '没有匹配的图片'}</CommandEmpty>
          {filteredImages.map((asset) => <CommandItem key={asset.id} value={asset.id} keywords={[asset.filename]} className="min-h-20 gap-3 px-3 py-2" onSelect={() => {
            onSelect(asset)
            setOpen(false)
          }}>
            <AssetThumbnail key={`${projectId}:${asset.id}:${asset.revision}:${asset.hash}`} projectId={projectId} asset={asset} />
            <AssetLabel asset={asset} />
            <span className="flex w-4 shrink-0 justify-center">{asset.id === value ? <Check aria-label="已选中" /> : null}</span>
          </CommandItem>)}
        </CommandList>
      </Command>
    </PopoverContent>
  </Popover>
}
