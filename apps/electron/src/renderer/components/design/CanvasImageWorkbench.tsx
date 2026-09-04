import * as React from 'react'
import type {
  CanvasImageAspectRatio,
  CanvasImageSize,
  DesignAsset,
  DesignContextMode,
  DesignJobRecord,
  ImageGenerationModelOption,
} from '@proma/shared'
import {
  Check,
  Download,
  History,
  ImageOff,
  LoaderCircle,
  Play,
  RefreshCw,
  Settings2,
  Square,
} from 'lucide-react'
import type {
  CanvasImageModuleDraft,
  CanvasImageModuleViewState,
  CanvasImageTaskDetailsState,
} from '@/atoms/native-canvas-atoms'
import type { DesignTaskDetailsState } from '@/atoms/design-atoms'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { DesignTaskDetailsView } from './DesignTaskDetails'

/** Canvas 图片工作台的模型加载状态。 */
export type CanvasImageModelLoadState = 'idle' | 'loading' | 'ready' | 'failed'

/** Canvas 图片工作台只接收状态与命令，不直接调用 IPC。 */
export interface CanvasImageWorkbenchProps {
  state: CanvasImageModuleViewState
  writable: boolean
  imageModelOptions: ImageGenerationModelOption[]
  imageModelLoadState: CanvasImageModelLoadState
  imageModelError?: string | null
  onDraftChange: (patch: Partial<Omit<CanvasImageModuleDraft, 'dirty'>>) => void
  onGenerate: () => void
  onCancel: (jobId: string) => void
  onRetry: (jobId: string) => void
  onPreviewAsset: (assetId: string) => void
  onAdoptAsset: (assetId: string) => void
  /** 当前正在设为默认的历史素材；null 表示采用通道空闲。 */
  adoptingAssetId: string | null
  onExportAsset: (assetId: string) => void
  exportState: 'idle' | 'exporting'
  exportError: string | null
  onLoadTaskDetails: (jobId: string, includeTrace: boolean) => void
  onConfigureModels: () => void
  onRetryLoad: () => void
  onCopyPrompt?: (prompt: string) => void
}

/** 项目上下文三态的稳定用户文案。 */
const CONTEXT_OPTIONS: ReadonlyArray<{
  value: DesignContextMode
  label: string
  description: string
}> = [
  { value: 'auto', label: '自动', description: 'Agent 按任务判断是否读取项目资料' },
  { value: 'project', label: '使用项目', description: '要求 Agent 读取项目代码或创作资料' },
  { value: 'none', label: '不使用项目', description: '只使用本次要求和连线输入' },
]

/** 首版允许用户选择的固定画面比例。 */
const ASPECT_RATIO_OPTIONS: CanvasImageAspectRatio[] = ['1:1', '16:9', '4:3', '9:16', '3:4']

/** 首版允许用户选择的固定输出尺寸。 */
const IMAGE_SIZE_OPTIONS: ReadonlyArray<{ value: CanvasImageSize, label: string }> = [
  { value: 'auto', label: '自动' },
  { value: '1K', label: '1K' },
  { value: '2K', label: '2K' },
  { value: '4K', label: '4K' },
]

/** 任务状态对应的紧凑中文标签。 */
const JOB_STATUS_LABELS: Record<DesignJobRecord['status'], string> = {
  queued: '等待执行',
  running: '正在生成',
  succeeded: '已完成',
  failed: '生成失败',
  cancelled: '已取消',
  interrupted: '已中断',
}

/** 任务状态对应的语义提示。 */
const JOB_STATUS_MESSAGES: Partial<Record<DesignJobRecord['status'], string>> = {
  queued: '任务已进入队列，开始前可以取消。',
  running: '正在整理生成上下文并生成图片。',
  cancelled: '本次生成已取消，当前图片保持不变。',
  interrupted: '应用中断了本次生成，可以使用原配置重试。',
}

/**
 * 将目录级授权根与受管文件名组合为 Renderer 可读取的媒体 URL。
 * @param baseUrl 已直接授权 assets 或 thumbnails 目录的 opaque 根地址。
 * @param relativePath 持久化的项目相对路径，仅使用末段文件名。
 * @returns 不重复目录层级且正确编码文件名的媒体 URL。
 */
function createMediaUrl(baseUrl: string, relativePath: string): string {
  /** 授权根已经指向目标目录，继续拼 assets/ 或 thumbnails/ 会形成不存在的双重目录。 */
  const filename = relativePath.split('/').at(-1) ?? relativePath
  return `${baseUrl.replace(/\/+$/, '')}/${encodeURIComponent(filename)}`
}

/** 按更新时间从新到旧复制任务列表，避免改写权威快照数组。 */
function sortJobsByRecency(jobs: DesignJobRecord[]): DesignJobRecord[] {
  return [...jobs].sort((left, right) => right.updatedAt - left.updatedAt || right.createdAt - left.createdAt)
}

/** 校验 Radix Select 返回值仍属于固定图片尺寸枚举。 */
function isCanvasImageSize(value: string): value is CanvasImageSize {
  return IMAGE_SIZE_OPTIONS.some((option) => option.value === value)
}

/** 把 Canvas 详情状态适配为共享任务详情视图合同。 */
function createTaskDetailsViewState(
  state: CanvasImageTaskDetailsState | undefined,
): DesignTaskDetailsState {
  if (!state) {
    return { phase: 'idle', traceLoaded: false, traceLoading: false }
  }
  /** trace 字段存在即表示完整详情已按需加载，包括空 trace。 */
  const traceLoaded = state.details?.trace !== undefined
  return {
    phase: state.phase,
    ...(state.details ? { details: state.details } : {}),
    traceLoaded,
    traceLoading: state.phase === 'loading',
    ...(state.error ? { error: state.error } : {}),
  }
}

/** 紧凑分组标题，保持工具型界面清晰且不制造嵌套卡片。 */
function FieldHeader({ children }: { children: React.ReactNode }): React.ReactElement {
  return <p className="text-[11px] font-medium text-muted-foreground">{children}</p>
}

/** 展示当前预览或明确的空、排队和运行状态。 */
function ImagePreview({
  asset,
  assetBaseUrl,
  aspectRatio,
  activeJob,
}: {
  asset: DesignAsset | undefined
  assetBaseUrl: string
  aspectRatio: CanvasImageAspectRatio
  activeJob: DesignJobRecord | undefined
}): React.ReactElement {
  /** 比例字符串可直接供 CSS aspect-ratio 使用。 */
  const cssAspectRatio = aspectRatio.replace(':', ' / ')
  return (
    <div
      className="relative flex min-h-56 w-full items-center justify-center overflow-hidden rounded-md border border-border bg-muted/35"
      style={{ aspectRatio: cssAspectRatio }}
    >
      {asset ? (
        <img
          src={createMediaUrl(assetBaseUrl, asset.relativePath)}
          alt="当前生成结果"
          className="absolute inset-0 h-full w-full object-contain"
        />
      ) : activeJob ? (
        <div className="flex flex-col items-center gap-2 px-6 text-center text-xs text-muted-foreground" role="status">
          <LoaderCircle className="size-5 animate-spin" aria-hidden="true" />
          <span>{JOB_STATUS_MESSAGES[activeJob.status] ?? JOB_STATUS_LABELS[activeJob.status]}</span>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-2 px-6 text-center text-xs text-muted-foreground">
          <ImageOff className="size-5" aria-hidden="true" />
          <span>还没有生成结果</span>
        </div>
      )}
    </div>
  )
}

/** Canvas 图片节点的完整、可复用纯视图工作台。 */
export function CanvasImageWorkbench({
  state,
  writable,
  imageModelOptions,
  imageModelLoadState,
  imageModelError,
  onDraftChange,
  onGenerate,
  onCancel,
  onRetry,
  onPreviewAsset,
  onAdoptAsset,
  adoptingAssetId,
  onExportAsset,
  exportState,
  exportError,
  onLoadTaskDetails,
  onConfigureModels,
  onRetryLoad,
  onCopyPrompt,
}: CanvasImageWorkbenchProps): React.ReactElement {
  /** 当前打开的任务详情仅属于本工作台实例。 */
  const [detailsJobId, setDetailsJobId] = React.useState<string | null>(null)

  if (state.phase === 'idle' || state.phase === 'loading') {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-xs text-muted-foreground" role="status">
        <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />加载图片配置
      </div>
    )
  }

  if (state.phase === 'error' || !state.snapshot || !state.draft) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <ImageOff className="size-5 text-muted-foreground" aria-hidden="true" />
        <p className="max-w-80 break-words text-xs text-destructive">
          {state.error ?? '图片配置暂时无法加载'}
        </p>
        <Button type="button" variant="outline" size="sm" onClick={onRetryLoad}>
          <RefreshCw aria-hidden="true" />重新加载
        </Button>
      </div>
    )
  }

  /** 已加载图片模块的权威快照。 */
  const snapshot = state.snapshot
  /** 当前本地草稿优先展示，尚未保存字段不回写权威快照。 */
  const draft = state.draft
  /** 任务按权威更新时间倒序展示。 */
  const jobs = sortJobsByRecency(snapshot.jobs)
  /** 同模块至多一个排队或运行任务。 */
  const activeJob = jobs.find((job) => job.status === 'queued' || job.status === 'running')
  /** 最近任务决定失败、取消和中断后的恢复主操作。 */
  const latestJob = jobs[0]
  /** 运行任务优先代表当前界面状态，避免较新的历史终态遮住正在执行的任务。 */
  const displayedJob = activeJob ?? latestJob
  /** 只有可恢复终态任务显示重试。 */
  const retryableJob = latestJob && ['failed', 'cancelled', 'interrupted'].includes(latestJob.status)
    ? latestJob
    : undefined
  /** 任务索引只用于补充版本按钮文案，不参与决定版本集合。 */
  const jobsById = new Map(jobs.map((job) => [job.id, job]))
  /** 素材索引只用于把主进程版本事实解析为安全媒体元数据。 */
  const assetsById = new Map(snapshot.assets.map((asset) => [asset.id, asset]))
  /** Renderer 只消费主进程版本顺序，缺失关联时局部跳过破损项。 */
  const versions = snapshot.imageVersions.flatMap((version) => {
    const job = jobsById.get(version.jobId)
    const asset = assetsById.get(version.assetId)
    return job && asset ? [{ job, asset }] : []
  })
  /** null 表示跟随权威 adopted 图片，不覆盖当前选择。 */
  const visibleAssetId = state.previewAssetId ?? snapshot.config.adoptedAssetId
  /** 当前大图只加载用户正在查看的单个原图。 */
  const visibleAsset = snapshot.assets.find((asset) => asset.id === visibleAssetId)
  /** 导出永远绑定权威 adopted 素材，不跟随临时历史预览。 */
  const adoptedAsset = snapshot.assets.find((asset) => asset.id === snapshot.config.adoptedAssetId)
  /** 当前选择是否只是历史预览。 */
  const previewingHistory = state.previewAssetId !== null
    && state.previewAssetId !== snapshot.config.adoptedAssetId
  /** 可用模型供选择，失效的当前模型仍显示但不可生成。 */
  const selectedModel = imageModelOptions.find((option) => option.profileId === draft.selectedModelProfileId)
  /** 生图需要可写、配置就绪、非运行、提示词和可用模型。 */
  const generationDisabled = !writable
    || Boolean(activeJob)
    || state.saveState === 'saving'
    || state.saveState === 'conflict'
    || imageModelLoadState !== 'ready'
    || !draft.prompt.trim()
    || !selectedModel?.available
  /** 当前展示任务固化的直接上游内容用于用户核对真实输入。 */
  const inputReferences = displayedJob?.canvasInputReferences ?? []
  /** 当前展开的详情任务必须仍存在于模块快照中。 */
  const detailsJob = detailsJobId ? jobs.find((job) => job.id === detailsJobId) : undefined
  /** 详情视图按 job 独立读取，不复用旧 Inspector Map。 */
  const detailsState = detailsJob ? createTaskDetailsViewState(state.taskDetails.get(detailsJob.id)) : null

  return (
    <ScrollArea className="h-full" aria-label="生图节点工作台内容">
      <div className="grid min-h-full grid-cols-1 lg:grid-cols-[minmax(0,1.15fr)_minmax(18rem,0.85fr)]">
        <section className="min-w-0 space-y-3 border-b border-border p-4 lg:border-b-0 lg:border-r" aria-label="图片预览与版本">
          <div className="flex min-w-0 items-center justify-between gap-2">
            <div className="min-w-0">
              <h3 className="text-sm font-semibold">当前图片</h3>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                {previewingHistory ? '正在预览历史版本' : '跟随已采用版本'}
              </p>
            </div>
            {displayedJob && <Badge variant="secondary" className="rounded-sm text-[10px]">{JOB_STATUS_LABELS[displayedJob.status]}</Badge>}
          </div>

          <ImagePreview
            asset={visibleAsset}
            assetBaseUrl={snapshot.assetBaseUrl}
            aspectRatio={draft.aspectRatio}
            activeJob={activeJob}
          />

          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-label="导出当前图片"
            disabled={!writable || !adoptedAsset || exportState === 'exporting'}
            onClick={() => {
              if (adoptedAsset) onExportAsset(adoptedAsset.id)
            }}
          >
            {exportState === 'exporting'
              ? <><LoaderCircle className="animate-spin" aria-hidden="true" />正在导出</>
              : <><Download aria-hidden="true" />导出当前图片</>}
          </Button>
          {exportError && (
            <p className="break-words text-xs text-destructive" role="alert">{exportError}</p>
          )}

          {displayedJob?.error && (
            <p className="break-words text-xs text-destructive" role="alert">{displayedJob.error}</p>
          )}
          {displayedJob && JOB_STATUS_MESSAGES[displayedJob.status] && !displayedJob.error && (
            <p className="text-xs text-muted-foreground">{JOB_STATUS_MESSAGES[displayedJob.status]}</p>
          )}

          <div className="space-y-2">
            <div className="flex items-center gap-1.5">
              <History className="size-3.5 text-muted-foreground" aria-hidden="true" />
              <FieldHeader>历史版本</FieldHeader>
            </div>
            {versions.length > 0 ? (
              <TooltipProvider delayDuration={200} disableHoverableContent>
                <ul className="flex gap-2 overflow-x-auto pb-1" aria-label="历史版本">
                  {versions.map(({ job, asset }) => {
                    /** 当前权威采用版本使用明确状态，不与预览选择混淆。 */
                    const adopted = asset.id === snapshot.config.adoptedAssetId
                    /** 当前可见版本支持键盘和鼠标选择。 */
                    const selected = asset.id === visibleAssetId
                    /** 采用期间所有版本共享单一写通道，目标项显示明确进度。 */
                    const adopting = asset.id === adoptingAssetId
                    return (
                      <li key={asset.id} className="relative size-16 shrink-0">
                        <button
                          type="button"
                          className={cn(
                            'size-16 overflow-hidden rounded-sm border bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                            selected ? 'border-primary' : 'border-border hover:border-foreground/40',
                          )}
                          aria-label={`预览第 ${job.attemptNumber} 次生成结果`}
                          aria-pressed={selected}
                          onClick={() => onPreviewAsset(asset.id)}
                        >
                          <img
                            src={createMediaUrl(snapshot.thumbnailBaseUrl, asset.thumbnailRelativePath)}
                            alt=""
                            className="h-full w-full object-cover"
                            loading="lazy"
                          />
                          {adopted && (
                            <span className="absolute bottom-0 left-0 right-0 bg-background/90 py-0.5 text-center text-[9px] text-foreground">默认</span>
                          )}
                        </button>
                        {!adopted && (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span className="absolute right-1 top-1 inline-flex" tabIndex={writable ? undefined : 0}>
                                <Button
                                  type="button"
                                  size="icon"
                                  variant="secondary"
                                  className="size-6 rounded-sm bg-background/90 shadow-sm"
                                  aria-label={adopting ? '正在设为默认' : '设为默认'}
                                  disabled={!writable || adoptingAssetId !== null}
                                  onClick={() => onAdoptAsset(asset.id)}
                                >
                                  {adopting
                                    ? <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />
                                    : <Check className="size-3.5" aria-hidden="true" />}
                                </Button>
                              </span>
                            </TooltipTrigger>
                            <TooltipContent side="top">
                              {writable ? '设为默认' : '当前画布为只读状态'}
                            </TooltipContent>
                          </Tooltip>
                        )}
                      </li>
                    )
                  })}
                </ul>
              </TooltipProvider>
            ) : (
              <p className="text-xs text-muted-foreground">生成成功后会在这里保留版本</p>
            )}
          </div>

          {displayedJob && (
            <Button type="button" variant="ghost" size="sm" className="px-1" onClick={() => setDetailsJobId(displayedJob.id)}>
              查看任务详情
            </Button>
          )}

          {detailsJob && detailsState && (
            <div className="border-t border-border pt-1">
              <DesignTaskDetailsView
                job={detailsJob}
                detailsState={detailsState}
                onLoadDetails={() => onLoadTaskDetails(detailsJob.id, false)}
                onLoadTrace={() => onLoadTaskDetails(detailsJob.id, true)}
                onCopyPrompt={onCopyPrompt}
                onRetry={detailsJob.status === 'failed' || detailsJob.status === 'cancelled' || detailsJob.status === 'interrupted'
                  ? onRetry
                  : undefined}
              />
            </div>
          )}
        </section>

        <section className="relative min-w-0 space-y-4 p-4" aria-label="图片生成配置">
          {!writable && (
            <p className="rounded-sm border border-border bg-muted/45 px-2.5 py-2 text-xs text-muted-foreground">
              当前画布为只读状态
            </p>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="canvas-image-prompt" className="text-xs">提示词</Label>
            <Textarea
              id="canvas-image-prompt"
              value={draft.prompt}
              rows={6}
              className="min-h-28 resize-y text-xs leading-5"
              placeholder="描述要生成的画面、用途与重点"
              disabled={!writable}
              onChange={(event) => onDraftChange({ prompt: event.currentTarget.value })}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="canvas-image-model" className="text-xs">生图模型</Label>
            {imageModelLoadState === 'loading' || imageModelLoadState === 'idle' ? (
              <div className="h-8 animate-pulse rounded-sm bg-muted" aria-label="正在加载生图模型" />
            ) : (
              <Select
                value={draft.selectedModelProfileId ?? ''}
                disabled={!writable || imageModelLoadState !== 'ready' || imageModelOptions.length === 0}
                onValueChange={(profileId) => onDraftChange({ selectedModelProfileId: profileId })}
              >
                <SelectTrigger id="canvas-image-model" className="h-8 rounded-sm px-2 text-xs">
                  <SelectValue placeholder="未配置生图模型">
                    {selectedModel ? `${selectedModel.name} · ${selectedModel.modelId}` : undefined}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {imageModelOptions.map((option) => (
                    <SelectItem key={option.profileId} value={option.profileId} disabled={!option.available}>
                      <span title={option.unavailableReason}>{option.name} · {option.modelId}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            {(imageModelLoadState === 'failed' || !selectedModel?.available) && (
              <div className="space-y-1.5">
                <p className="break-words text-xs text-destructive">
                  {imageModelError ?? selectedModel?.unavailableReason ?? '未配置可用的生图模型'}
                </p>
                <Button type="button" variant="outline" size="sm" className="w-full" onClick={onConfigureModels}>
                  <Settings2 aria-hidden="true" />配置生图模型
                </Button>
              </div>
            )}
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">项目上下文</Label>
            <div role="radiogroup" aria-label="项目上下文" className="grid grid-cols-3 gap-1 rounded-sm bg-muted/50 p-1">
              {CONTEXT_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  role="radio"
                  aria-checked={draft.contextMode === option.value}
                  title={option.description}
                  disabled={!writable}
                  className={cn(
                    'min-h-7 min-w-0 rounded-sm px-1.5 py-1 text-[11px] leading-4 text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    draft.contextMode === option.value && 'bg-background font-medium text-foreground shadow-sm',
                  )}
                  onClick={() => onDraftChange({ contextMode: option.value })}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">画面比例</Label>
            <div role="radiogroup" aria-label="画面比例" className="grid grid-cols-5 gap-1">
              {ASPECT_RATIO_OPTIONS.map((ratio) => (
                <button
                  key={ratio}
                  type="button"
                  role="radio"
                  aria-checked={draft.aspectRatio === ratio}
                  disabled={!writable}
                  className={cn(
                    'h-8 rounded-sm border border-border px-1 text-[11px] text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    draft.aspectRatio === ratio && 'border-primary bg-primary/10 font-medium text-foreground',
                  )}
                  onClick={() => onDraftChange({ aspectRatio: ratio })}
                >
                  {ratio}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="canvas-image-size" className="text-xs">图片尺寸</Label>
            <Select
              value={draft.imageSize}
              disabled={!writable}
              onValueChange={(imageSize) => {
                if (isCanvasImageSize(imageSize)) onDraftChange({ imageSize })
              }}
            >
              <SelectTrigger id="canvas-image-size" className="h-8 rounded-sm px-2 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {IMAGE_SIZE_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <FieldHeader>直接上游已提交内容</FieldHeader>
            {inputReferences.length > 0 ? (
              <ul className="space-y-1.5">
                {inputReferences.map((reference) => (
                  <li key={`${reference.nodeId}-${reference.revision}`} className="border-l border-border pl-2 text-xs leading-5 text-muted-foreground">
                    <span className="font-medium text-foreground">{reference.kind}</span>
                    <span className="break-words"> · {reference.summary}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-muted-foreground">暂无已提交的直接上游内容</p>
            )}
          </div>

          <footer
            aria-label="生图主操作"
            className="sticky bottom-0 z-10 -mx-4 -mb-4 space-y-2 border-t border-border bg-background/95 p-3 backdrop-blur-sm"
          >
            {state.saveState === 'saving' && <p className="text-xs text-muted-foreground">正在保存配置</p>}
            {state.saveState === 'dirty' && <p className="text-xs text-muted-foreground">配置尚未保存</p>}
            {(state.saveState === 'failed' || state.saveState === 'conflict') && (
              <p className="break-words text-xs text-destructive">{state.error ?? '生图配置保存失败，请重试'}</p>
            )}
            {state.saveState === 'conflict' && (
              <Button type="button" variant="outline" className="w-full" onClick={onRetryLoad}>
                <RefreshCw aria-hidden="true" />重新加载配置
              </Button>
            )}

            {activeJob ? (
              <Button type="button" variant="outline" className="w-full" disabled={!writable} onClick={() => onCancel(activeJob.id)}>
                <Square aria-hidden="true" />取消生成
              </Button>
            ) : retryableJob ? (
              <Button type="button" className="w-full" disabled={!writable} onClick={() => onRetry(retryableJob.id)}>
                <RefreshCw aria-hidden="true" />重试生成
              </Button>
            ) : (
              <Button type="button" className="w-full" disabled={generationDisabled} onClick={onGenerate}>
                <Play aria-hidden="true" />生成图片
              </Button>
            )}
          </footer>
        </section>
      </div>
    </ScrollArea>
  )
}
