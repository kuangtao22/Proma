import * as React from 'react'
import type {
  AgentSessionMeta,
  CreateDesignJobInput,
  DesignAsset,
} from '@proma/shared'
import { Download, ImageOff, RefreshCw, Send, Settings2, Trash2, Upload, X } from 'lucide-react'
import { useAtomValue, useSetAtom } from 'jotai'
import { toast } from 'sonner'
import {
  createInitialDesignProjectState,
  designProjectStatesAtom,
  executeDesignEditAtom,
  requestDesignRecoveryAtom,
  updateDesignProjectStateAtom,
} from '@/atoms/design-atoms'
import { agentEnqueuePendingMentionsAtom, agentSessionsAtom } from '@/atoms/agent-atoms'
import { activeSessionIdAtom } from '@/atoms/tab-atoms'
import { activeViewAtom } from '@/atoms/active-view'
import { settingsOpenAtom, settingsTabAtom, toolSettingsFocusAtom } from '@/atoms/settings-tab'
import type { DesignProjectState } from '@/atoms/design-atoms'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { designAdapter } from '@/lib/design-adapter'
import { sendPreparedDesignAssetToSession } from '@/lib/design-session-actions'
import { useOpenSession } from '@/hooks/useOpenSession'
import { cn } from '@/lib/utils'
import {
  buildDesignVersionTree,
  flattenDesignVersionTree,
  type DesignVersionTreeNode,
  type DesignVersionTreeRow,
} from './design-version-tree'
import { useDesignInspectorActions } from './use-design-inspector-actions'
import { useDesignImageModelSelection } from './use-design-image-model-selection'
import { isDesignRecoveryRequired } from './use-design-workspace'

/** 首版图片生成允许的画面比例。 */
export type DesignAspectRatio = '1:1' | '16:9' | '4:3' | '9:16' | '3:4'
/** 首版图片生成允许的输出尺寸。 */
export type DesignImageSize = 'auto' | '1K' | '2K' | '4K'

/**
 * 将生成选项编码进 prompt，避免扩大共享 Job 类型。
 * @param prompt 用户输入的生成描述。
 * @param aspectRatio 首版允许的画面比例。
 * @param imageSize 首版允许的图片尺寸。
 * @returns 同时包含自然语言和稳定 JSON 约束的 prompt。
 */
export function serializeDesignGenerationPrompt(
  prompt: string,
  aspectRatio: DesignAspectRatio,
  imageSize: DesignImageSize,
): string {
  /** 字段顺序固定，方便任务日志稳定比较。 */
  const constraints = { aspectRatio, imageSize }
  return `${prompt.trim()}\n\n[PROMA_DESIGN_CONSTRAINTS]\n${JSON.stringify(constraints)}`
}

/** 创建空选区图片生成任务输入。 */
export function createDesignGenerationJobInput(
  projectId: string,
  prompt: string,
  aspectRatio: DesignAspectRatio,
  imageSize: DesignImageSize,
  imageModelProfileId: string,
  position: { x: number; y: number },
): CreateDesignJobInput {
  return {
    projectId,
    action: 'generate',
    prompt: serializeDesignGenerationPrompt(prompt, aspectRatio, imageSize),
    imageModelProfileId,
    position,
  }
}

/** 创建单素材局部编辑任务输入。 */
export function createDesignEditJobInput(
  projectId: string,
  prompt: string,
  sourceAssetId: string,
  maskAnnotationId: string | undefined,
  imageModelProfileId: string,
  position: { x: number; y: number },
): CreateDesignJobInput {
  return {
    projectId,
    action: 'edit',
    prompt: prompt.trim(),
    imageModelProfileId,
    sourceAssetId,
    ...(maskAnnotationId ? { maskAnnotationId } : {}),
    position,
  }
}

/**
 * 判断 Renderer 任务输入是否仍匹配当前项目权威模型选择。
 * @param input 即将交给主进程的任务输入。
 * @param selectedProfileId 当前项目已验证的 profile；缺失时必须阻断。
 * @returns 只有稳定 ID 存在且与任务输入一致时返回 true。
 */
export function canCreateDesignJobWithSelectedModel(
  input: Pick<CreateDesignJobInput, 'imageModelProfileId'>,
  selectedProfileId: string | null,
): boolean {
  return selectedProfileId !== null && input.imageModelProfileId === selectedProfileId
}

/** 将素材来源字段转换为面向用户的简短来源。 */
function getAssetSourceLabel(asset: DesignAsset): string {
  if (asset.sourceJobId) return 'AI 任务'
  if (asset.sourceSessionId) return 'Agent 会话'
  return '本地导入'
}

/** 根据媒体授权根构建不暴露项目路径的缩略图 URL。 */
function createThumbnailUrl(baseUrl: string | undefined, asset: DesignAsset): string | undefined {
  if (!baseUrl) return undefined
  /** 仅使用相对路径末段，避免把项目目录结构带到 DOM。 */
  const filename = asset.thumbnailRelativePath.split('/').at(-1)
  return filename ? `${baseUrl.replace(/\/+$/, '')}/${encodeURIComponent(filename)}` : undefined
}

/** Inspector 纯状态视图的外部命令。 */
export interface DesignInspectorStateViewProps {
  state: DesignProjectState
  width?: number
  createJobEnabled?: boolean
  onTabChange: (tab: DesignProjectState['inspectorTab']) => void
  onGenerationPromptChange?: (prompt: string) => void
  onEditPromptChange?: (prompt: string) => void
  onImportAssets: () => void
  onDeleteAsset: (assetId: string) => void
  onRelinkAsset: (assetId: string) => void
  onExportAsset: (assetId: string) => void
  targetSessions?: AgentSessionMeta[]
  onSendAssetToSession?: (assetId: string, sessionId: string) => void
  onGroupSelection: () => void
  onSelectAsset: (assetId: string) => void
  onClearSelection?: () => void
  onCreateJob: (input: CreateDesignJobInput) => void
  onImageModelChange?: (profileId: string) => void
  onConfigureImageModels?: () => void
  onRetryImageModels?: () => void
}

/** 素材标签所需的选择上下文。 */
interface InspectorSelection {
  selectedNodeCount: number
  containsJobNode: boolean
  canvasAssetNodeSelected: boolean
  assetId?: string
  asset?: DesignAsset
  missing: boolean
}

/** 素材标签：选择详情、导入入口与 48px 项目素材列表。 */
function AssetsPanel({
  state,
  selection,
  writable,
  onImportAssets,
  onDeleteAsset,
  onRelinkAsset,
  onExportAsset,
  targetSessions,
  onSendAssetToSession,
  onGroupSelection,
  onSelectAsset,
  onPreviewError,
  onPreviewLoad,
}: {
  state: DesignProjectState
  selection: InspectorSelection
  writable: boolean
  onImportAssets: () => void
  onDeleteAsset: (assetId: string) => void
  onRelinkAsset: (assetId: string) => void
  onExportAsset: (assetId: string) => void
  targetSessions: AgentSessionMeta[]
  onSendAssetToSession?: (assetId: string, sessionId: string) => void
  onGroupSelection: () => void
  onSelectAsset: (assetId: string) => void
  onPreviewError: (assetId: string) => void
  onPreviewLoad: (assetId: string) => void
}): React.ReactElement {
  /** 父组件已保证 snapshot 存在。 */
  const snapshot = state.snapshot!
  /** 无可用目标时保留按钮 disabled 语义，由外层可聚焦元素承载原因提示。 */
  const sessionMenuDisabled = targetSessions.length === 0 || !onSendAssetToSession
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <section className="border-b border-border px-3 py-3">
        {selection.selectedNodeCount === 0 && <p className="text-xs text-muted-foreground">未选择画布节点</p>}
        {selection.selectedNodeCount > 1 && (
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs font-medium">已选择 {selection.selectedNodeCount} 项</p>
            <Button type="button" variant="outline" size="sm" disabled={!writable || selection.containsJobNode} onClick={onGroupSelection}>创建分组</Button>
          </div>
        )}
        {selection.assetId && selection.missing && (
          <div className="space-y-2">
            <p className="flex items-center gap-2 text-xs text-destructive"><ImageOff className="size-4" aria-hidden="true" />素材缺失</p>
            <Button type="button" variant="outline" size="sm" disabled={!writable} onClick={() => onRelinkAsset(selection.assetId!)}><RefreshCw aria-hidden="true" />重新定位</Button>
          </div>
        )}
        {selection.asset && !selection.missing && (
          <div className="space-y-3">
            <div className="space-y-1">
              <p className="min-w-0 break-words text-xs font-medium">{selection.asset.filename}</p>
              <p className="min-w-0 break-words text-[11px] text-muted-foreground">{selection.asset.width} × {selection.asset.height}</p>
              <p className="min-w-0 break-words text-[11px] text-muted-foreground">{getAssetSourceLabel(selection.asset)}</p>
            </div>
            <div className="flex gap-1">
              <Button type="button" variant="outline" size="icon-sm" aria-label="导出素材" onClick={() => onExportAsset(selection.asset!.id)}><Download aria-hidden="true" /></Button>
              <DropdownMenu>
                <TooltipProvider delayDuration={200} disableHoverableContent>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span
                        className="inline-flex"
                        tabIndex={sessionMenuDisabled ? 0 : undefined}
                        aria-description={sessionMenuDisabled ? '暂无项目会话' : undefined}
                        data-design-session-menu-tooltip-trigger="true"
                      >
                        <DropdownMenuTrigger asChild>
                          <Button type="button" variant="outline" size="icon-sm" aria-label="发送素材到项目会话" disabled={sessionMenuDisabled}><Send aria-hidden="true" /></Button>
                        </DropdownMenuTrigger>
                      </span>
                    </TooltipTrigger>
                    <TooltipContent side="top">{targetSessions.length > 0 ? '发送到项目会话' : '暂无项目会话'}</TooltipContent>
                  </Tooltip>
                </TooltipProvider>
                <DropdownMenuContent align="start" className="min-w-44">
                  {targetSessions.map((session) => (
                    <DropdownMenuItem key={session.id} onSelect={() => onSendAssetToSession?.(selection.asset!.id, session.id)}>
                      <span className="max-w-56 truncate">{session.title}</span>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
              <Button type="button" variant="ghost" size="icon-sm" aria-label="删除素材" disabled={!writable} onClick={() => onDeleteAsset(selection.asset!.id)}><Trash2 aria-hidden="true" /></Button>
            </div>
          </div>
        )}
      </section>
      <section className="px-3 py-3">
        <div className="mb-2 flex items-center justify-between gap-2">
          <h3 className="text-xs font-semibold">项目素材</h3>
          <Button type="button" variant="ghost" size="icon-sm" aria-label="导入图片" disabled={!writable} onClick={onImportAssets}><Upload aria-hidden="true" /></Button>
        </div>
        {snapshot.document.assets.length === 0 ? (
          <Button type="button" variant="outline" size="sm" className="w-full" disabled={!writable} onClick={onImportAssets}><Upload aria-hidden="true" />导入图片</Button>
        ) : (
          <ul className="space-y-1">
            {snapshot.document.assets.map((asset) => {
              /** 当前授权对应的安全缩略图 URL。 */
              const previewUrl = createThumbnailUrl(snapshot.thumbnailBaseUrl, asset)
              return (
                <li key={asset.id}>
                  <button type="button" className="flex min-h-12 w-full items-center gap-2 rounded-sm px-1 text-left hover:bg-accent" onClick={() => onSelectAsset(asset.id)}>
                    <span className="flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-sm border border-border bg-muted">
                      {previewUrl ? <img src={previewUrl} alt="" className="h-full w-full object-cover" onError={() => onPreviewError(asset.id)} onLoad={() => onPreviewLoad(asset.id)} /> : <ImageOff className="size-4 text-muted-foreground" aria-hidden="true" />}
                    </span>
                    <span className="min-w-0 flex-1 break-words text-xs">{asset.filename}</span>
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </section>
    </div>
  )
}

/** AI 标签：空选区生成或单素材编辑，真实任务 handler 由 Task 10 注入。 */
function AiPanel({
  state,
  selection,
  writable,
  createJobEnabled,
  onGenerationPromptChange,
  onEditPromptChange,
  onCreateJob,
  onImageModelChange,
  onConfigureImageModels,
  onRetryImageModels,
}: {
  state: DesignProjectState
  selection: InspectorSelection
  writable: boolean
  createJobEnabled: boolean
  onGenerationPromptChange?: (prompt: string) => void
  onEditPromptChange?: (prompt: string) => void
  onCreateJob: (input: CreateDesignJobInput) => void
  onImageModelChange?: (profileId: string) => void
  onConfigureImageModels?: () => void
  onRetryImageModels?: () => void
}): React.ReactElement {
  /** 生成表单的非持久化约束选项。 */
  const [aspectRatio, setAspectRatio] = React.useState<DesignAspectRatio>('1:1')
  const [imageSize, setImageSize] = React.useState<DesignImageSize>('auto')
  const [maskAnnotationId, setMaskAnnotationId] = React.useState('none')
  /** 父组件已保证 snapshot 存在。 */
  const snapshot = state.snapshot!
  /** 当前素材节点位置作为任务占位位置。 */
  const selectedNode = selection.assetId ? snapshot.document.nodes.find((node) => node.assetId === selection.assetId) : undefined
  const position = selectedNode?.position ?? { x: -snapshot.document.viewport.x / snapshot.document.viewport.zoom, y: -snapshot.document.viewport.y / snapshot.document.viewport.zoom }
  /** 仅可用选项进入 Radix 菜单，不可用项通过字段附近错误说明。 */
  const availableOptions = state.imageModelOptions.filter((option) => option.available)
  /** 当前选择的公开模型文本显式渲染，disabled 与服务端渲染时仍保持可见。 */
  const selectedModelOption = availableOptions.find((option) => (
    option.profileId === state.imageModelProfileId
  ))
  /** 当前选项的完整可访问文本，视觉上允许在窄 Inspector 内截断。 */
  const selectedModelLabel = selectedModelOption
    ? `${selectedModelOption.name} · ${selectedModelOption.modelId}`
    : undefined
  /** 任务只在权威选择已 ready 且仍属于可用目录时开放。 */
  const selectedModelAvailable = state.imageModelLoadState === 'ready'
    && state.imageModelProfileId !== null
    && availableOptions.some((option) => option.profileId === state.imageModelProfileId)
  /** 模型状态与原画布写守卫共同决定任务可提交性。 */
  const enabled = writable && createJobEnabled && selectedModelAvailable

  /** 提交空选区生成任务。 */
  const handleGenerate = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (!enabled || !state.imageModelProfileId || !state.generationPrompt.trim()) return
    onCreateJob(createDesignGenerationJobInput(
      snapshot.document.projectId,
      state.generationPrompt,
      aspectRatio,
      imageSize,
      state.imageModelProfileId,
      position,
    ))
  }
  /** 提交单素材编辑任务。 */
  const handleEdit = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (!enabled || !state.imageModelProfileId || !selection.canvasAssetNodeSelected || !selection.asset || !state.editPrompt.trim()) return
    onCreateJob(createDesignEditJobInput(
      snapshot.document.projectId,
      state.editPrompt,
      selection.asset.id,
      maskAnnotationId === 'none' ? undefined : maskAnnotationId,
      state.imageModelProfileId,
      position,
    ))
  }

  /** 无可用模型时优先展示目录返回的明确原因。 */
  const unavailableReason = state.invalidImageModelProfileId
    ? `当前生图模型不可用：${state.invalidImageModelProfileId}`
    : availableOptions.length === 0
      ? state.imageModelOptions.find((option) => option.unavailableReason)?.unavailableReason
        ?? '未配置可用的生图模型'
      : state.imageModelProfileId === null && state.imageModelLoadState === 'ready'
        ? '请选择生图模型'
        : null
  /** 初次进入且没有缓存选项时使用骨架；乐观切换继续显示新选择文本。 */
  const showInitialModelSkeleton = state.imageModelLoadState === 'idle'
    || (state.imageModelLoadState === 'loading' && state.imageModelOptions.length === 0)
  /** 模型字段固定在所有生成、编辑和选区提示之前。 */
  const imageModelField = (
    <div className="space-y-1.5">
      <Label htmlFor="design-image-model" className="text-xs">生图模型</Label>
      {showInitialModelSkeleton ? (
        <div className="h-8 rounded bg-muted animate-pulse" aria-label="正在加载生图模型" />
      ) : (
        <Select
          value={state.imageModelProfileId ?? ''}
          onValueChange={(profileId) => onImageModelChange?.(profileId)}
          disabled={state.imageModelLoadState !== 'ready' || availableOptions.length === 0}
        >
          <SelectTrigger
            id="design-image-model"
            title={selectedModelLabel}
            className="h-8 min-w-0 w-full rounded px-2 text-xs disabled:border-border/60 disabled:bg-muted/40 disabled:text-muted-foreground disabled:opacity-100"
          >
            <SelectValue placeholder="未配置生图模型">
              {selectedModelLabel}
            </SelectValue>
          </SelectTrigger>
          <SelectContent className="w-[var(--radix-select-trigger-width)] max-w-[var(--radix-select-content-available-width)]">
            {availableOptions.map((option) => {
              /** 菜单视觉文本截断，title 保留同名配置的完整真实模型 ID。 */
              const optionLabel = `${option.name} · ${option.modelId}`
              return (
                <SelectItem key={option.profileId} value={option.profileId} className="min-w-0">
                  <span className="block min-w-0 truncate" title={optionLabel}>{optionLabel}</span>
                </SelectItem>
              )
            })}
          </SelectContent>
        </Select>
      )}
      {state.imageModelLoadState === 'failed' && (
        <div className="space-y-1.5">
          <p className="break-words text-xs text-destructive">{state.imageModelError ?? '加载生图模型失败'}</p>
          <TooltipProvider delayDuration={200} disableHoverableContent>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button type="button" variant="outline" size="sm" className="w-full" onClick={onRetryImageModels}>
                  <RefreshCw aria-hidden="true" />重试加载
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top">重新读取模型目录和当前项目选择</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
      )}
      {state.imageModelLoadState === 'ready' && unavailableReason && (
        <div className="space-y-1.5">
          <p className="break-words text-xs text-destructive">{unavailableReason}</p>
          <TooltipProvider delayDuration={200} disableHoverableContent>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button type="button" variant="outline" size="sm" className="w-full" onClick={onConfigureImageModels}>
                  <Settings2 aria-hidden="true" />配置生图模型
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top">打开工具设置中的生图模型配置</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
      )}
    </div>
  )

  /** 根据选区生成模型字段之后的任务表单或限制说明。 */
  let taskContent: React.ReactElement
  if (selection.selectedNodeCount > 0 && !selection.canvasAssetNodeSelected) {
    taskContent = <p className="text-xs text-muted-foreground">AI 编辑仅支持单个素材节点</p>
  } else if (selection.asset && !selection.canvasAssetNodeSelected) {
    taskContent = <p className="text-xs text-muted-foreground">AI 编辑仅支持画布素材节点</p>
  } else if (selection.assetId && selection.missing) {
    taskContent = <p className="text-xs text-muted-foreground">请先重新定位缺失素材</p>
  } else if (selection.asset) {
    /** 只有 mask 批注允许作为编辑输入。 */
    const masks = snapshot.document.annotations.filter((annotation) => annotation.kind === 'mask')
    taskContent = (
      <form className="space-y-3" onSubmit={handleEdit}>
        <h3 className="break-words text-xs font-semibold">编辑 {selection.asset.filename}</h3>
        <Label htmlFor="design-edit-prompt" className="text-xs">编辑要求</Label>
        <Textarea id="design-edit-prompt" value={state.editPrompt} disabled={!enabled} onChange={(event) => onEditPromptChange?.(event.target.value)} />
        <Label htmlFor="design-mask-annotation" className="text-xs">蒙版批注（可选）</Label>
        <Select value={maskAnnotationId} onValueChange={setMaskAnnotationId} disabled={!enabled}>
          <SelectTrigger id="design-mask-annotation"><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value="none">不使用蒙版</SelectItem>{masks.map((mask, index) => <SelectItem key={mask.id} value={mask.id}>蒙版 {index + 1}</SelectItem>)}</SelectContent>
        </Select>
        <Button type="submit" size="sm" className="w-full" disabled={!enabled || !state.editPrompt.trim()}><Send aria-hidden="true" />开始编辑</Button>
      </form>
    )
  } else {
    taskContent = <form className="space-y-3" onSubmit={handleGenerate}>
      <h3 className="text-xs font-semibold">生成图片</h3>
      <Label htmlFor="design-generation-prompt" className="text-xs">描述</Label>
      <Textarea id="design-generation-prompt" value={state.generationPrompt} disabled={!enabled} onChange={(event) => onGenerationPromptChange?.(event.target.value)} />
      <Label htmlFor="design-aspect-ratio" className="text-xs">画面比例</Label>
      <Select value={aspectRatio} onValueChange={(value) => setAspectRatio(value as DesignAspectRatio)} disabled={!enabled}>
        <SelectTrigger id="design-aspect-ratio"><SelectValue /></SelectTrigger>
        <SelectContent>{(['1:1', '16:9', '4:3', '9:16', '3:4'] satisfies DesignAspectRatio[]).map((value) => <SelectItem key={value} value={value}>{value}</SelectItem>)}</SelectContent>
      </Select>
      <Label htmlFor="design-image-size" className="text-xs">图片尺寸</Label>
      <Select value={imageSize} onValueChange={(value) => setImageSize(value as DesignImageSize)} disabled={!enabled}>
        <SelectTrigger id="design-image-size"><SelectValue /></SelectTrigger>
        <SelectContent>{(['auto', '1K', '2K', '4K'] satisfies DesignImageSize[]).map((value) => <SelectItem key={value} value={value}>{value}</SelectItem>)}</SelectContent>
      </Select>
      <Button type="submit" size="sm" className="w-full" disabled={!enabled || !state.generationPrompt.trim()}><Send aria-hidden="true" />生成图片</Button>
    </form>
  }
  return <div className="space-y-3">{imageModelField}{taskContent}</div>
}

/** 迭代版本行避免深版本链递归渲染。 */
function VersionRow({ row, onSelectAsset }: { row: DesignVersionTreeRow; onSelectAsset: (assetId: string) => void }): React.ReactElement {
  /** 扁平行直接携带节点和缩进深度。 */
  const { node, depth } = row
  return (
    <li>
      <button type="button" className={cn('flex min-h-8 w-full items-center gap-2 rounded-sm px-2 py-1 text-left text-xs hover:bg-accent', node.current && 'bg-accent')} style={{ paddingLeft: 8 + depth * 16 }} aria-current={node.current ? 'true' : undefined} onClick={() => onSelectAsset(node.id)}>
        <span className="min-w-0 flex-1 break-words">{node.asset.filename}</span>{node.current && <span className="shrink-0 text-[11px] text-muted-foreground">当前</span>}
      </button>
    </li>
  )
}

/** 版本树构建器签名，测试可记录无关状态更新时的构建次数。 */
export type DesignVersionTreeBuilder = (
  assets: DesignAsset[],
  currentAssetId: string | null,
) => DesignVersionTreeNode[]

/** 将版本数据转换为可迭代渲染的扁平行。 */
export function useDesignVersionRows(
  assets: DesignAsset[],
  currentAssetId: string | null,
  buildTree: DesignVersionTreeBuilder = buildDesignVersionTree,
): DesignVersionTreeRow[] {
  return React.useMemo(
    () => flattenDesignVersionTree(buildTree(assets, currentAssetId)),
    [assets, buildTree, currentAssetId],
  )
}

/** 版本面板稳定输入，供 React.memo 跳过 forceMount 隐藏页的无关重渲染。 */
interface VersionsPanelProps {
  assets: DesignAsset[]
  currentAssetId: string | null
  onSelectAsset: (assetId: string) => void
}

/** 版本标签：按 parentAssetId 展示并同步画布选择。 */
const VersionsPanel = React.memo(function VersionsPanel({
  assets,
  currentAssetId,
  onSelectAsset,
}: VersionsPanelProps): React.ReactElement {
  /** 循环和缺失父项已在构建阶段提升为根，深链按扁平行渲染。 */
  const rows = useDesignVersionRows(assets, currentAssetId)
  return rows.length === 0 ? <p className="text-xs text-muted-foreground">暂无素材版本</p> : <ul>{rows.map((row) => <VersionRow key={row.node.id} row={row} onSelectAsset={onSelectAsset} />)}</ul>
})

/** 纯 Inspector，组合三个职责单一的标签面板。 */
export function DesignInspectorStateView(props: DesignInspectorStateViewProps): React.ReactElement {
  const { state, width } = props
  /** 浏览器图片加载失败时记录物理缺失素材，不修改持久化元数据。 */
  const [missingAssetIds, setMissingAssetIds] = React.useState<ReadonlySet<string>>(new Set())
  if (!state.snapshot) return <aside className="flex h-full max-[960px]:max-w-[300px] items-center justify-center border-l border-border text-xs text-muted-foreground" style={{ width }}>正在加载检查器</aside>
  /** 按选区顺序解析仍存在的画布节点。 */
  const selectedNodes = state.selectedNodeIds.map((id) => state.snapshot!.document.nodes.find((node) => node.id === id)).filter((node) => node !== undefined)
  /** 只有单个素材节点进入详情和编辑态。 */
  const assetId = selectedNodes.length === 1 && selectedNodes[0]?.kind === 'asset'
    ? selectedNodes[0].assetId
    : selectedNodes.length === 0
      ? state.inspectorAssetId ?? undefined
      : undefined
  /** 单选素材元数据与物理缺失状态分别解析。 */
  const selectedAsset = assetId ? state.snapshot.document.assets.find((asset) => asset.id === assetId) : undefined
  const selection: InspectorSelection = {
    selectedNodeCount: selectedNodes.length,
    containsJobNode: selectedNodes.some((node) => node.kind === 'job'),
    canvasAssetNodeSelected: selectedNodes.length === 1 && selectedNodes[0]?.kind === 'asset',
    assetId,
    asset: selectedAsset,
    missing: Boolean(assetId && (!selectedAsset || missingAssetIds.has(assetId))),
  }
  /** 素材写操作需等待当前 revision 保存稳定；导出由面板单独保持可用。 */
  const writable = state.snapshot.writable
    && !state.conflictRecoveryPending
    && state.authoritativeRecoveryState === 'idle'
    && state.saveState === 'saved'
  return (
    <aside className="flex h-full min-h-0 min-w-0 shrink-0 flex-col border-l border-border bg-background max-[960px]:max-w-[300px]" style={{ width }} aria-label="设计检查器">
      <header className="flex h-11 shrink-0 items-center justify-between border-b border-border px-3">
        <h2 className="text-sm font-semibold">设计</h2>
        <Button type="button" variant="ghost" size="icon-sm" aria-label="清除选择" disabled={(state.selectedNodeIds.length === 0 && !state.inspectorAssetId) || !props.onClearSelection} onClick={props.onClearSelection}><X aria-hidden="true" /></Button>
      </header>
      <Tabs value={state.inspectorTab} onValueChange={(value) => props.onTabChange(value as DesignProjectState['inspectorTab'])} className="flex min-h-0 flex-1 flex-col">
        <TabsList className="mx-3 mt-3 grid h-8 shrink-0 grid-cols-3 rounded-md p-0.5">
          <TabsTrigger value="assets" className="min-w-0 px-1 text-xs">素材</TabsTrigger>
          <TabsTrigger value="ai" className="min-w-0 px-1 text-xs">AI 编辑</TabsTrigger>
          <TabsTrigger value="versions" className="min-w-0 px-1 text-xs">版本</TabsTrigger>
        </TabsList>
        <TabsContent value="assets" forceMount className="mt-0 min-h-0 flex-1 data-[state=inactive]:hidden"><AssetsPanel state={state} selection={selection} writable={writable} onImportAssets={props.onImportAssets} onDeleteAsset={props.onDeleteAsset} onRelinkAsset={props.onRelinkAsset} onExportAsset={props.onExportAsset} targetSessions={props.targetSessions ?? []} onSendAssetToSession={props.onSendAssetToSession} onGroupSelection={props.onGroupSelection} onSelectAsset={props.onSelectAsset} onPreviewError={(failedAssetId) => setMissingAssetIds((current) => new Set(current).add(failedAssetId))} onPreviewLoad={(loadedAssetId) => setMissingAssetIds((current) => { if (!current.has(loadedAssetId)) return current; const next = new Set(current); next.delete(loadedAssetId); return next })} /></TabsContent>
        <TabsContent value="ai" forceMount className="mt-0 min-h-0 flex-1 overflow-y-auto px-3 py-3 data-[state=inactive]:hidden"><AiPanel state={state} selection={selection} writable={writable} createJobEnabled={props.createJobEnabled ?? true} onGenerationPromptChange={props.onGenerationPromptChange} onEditPromptChange={props.onEditPromptChange} onCreateJob={props.onCreateJob} onImageModelChange={props.onImageModelChange} onConfigureImageModels={props.onConfigureImageModels} onRetryImageModels={props.onRetryImageModels} /></TabsContent>
        <TabsContent value="versions" forceMount className="mt-0 min-h-0 flex-1 overflow-y-auto px-3 py-3 data-[state=inactive]:hidden"><h3 className="mb-2 text-xs font-semibold">素材版本</h3><VersionsPanel assets={state.snapshot.document.assets} currentAssetId={selection.asset?.id ?? null} onSelectAsset={props.onSelectAsset} /></TabsContent>
      </Tabs>
    </aside>
  )
}

export interface DesignInspectorProps {
  projectId: string
  width?: number
}

/** 只保留当前项目未归档会话，并把当前会话放在默认菜单首项。 */
export function getDesignTargetSessions(
  sessions: AgentSessionMeta[],
  projectId: string,
  activeSessionId: string | null,
): AgentSessionMeta[] {
  /** 筛选发生在菜单构建前，跨项目和归档会话不会进入可交互 DOM。 */
  const candidates = sessions.filter((session) => session.workspaceId === projectId && !session.archived)
  if (!activeSessionId) return candidates
  return [...candidates].sort((left, right) => (
    Number(right.id === activeSessionId) - Number(left.id === activeSessionId)
  ))
}

/** 从项目 Jotai 状态连接右栏素材操作与真实 Design Job。 */
export function DesignInspector({ projectId, width }: DesignInspectorProps): React.ReactElement {
  const states = useAtomValue(designProjectStatesAtom)
  const updateState = useSetAtom(updateDesignProjectStateAtom)
  const executeEdit = useSetAtom(executeDesignEditAtom)
  const requestRecovery = useSetAtom(requestDesignRecoveryAtom)
  const sessions = useAtomValue(agentSessionsAtom)
  const activeSessionId = useAtomValue(activeSessionIdAtom)
  const setActiveView = useSetAtom(activeViewAtom)
  const enqueuePendingMentions = useSetAtom(agentEnqueuePendingMentionsAtom)
  const setSettingsTab = useSetAtom(settingsTabAtom)
  const setToolSettingsFocus = useSetAtom(toolSettingsFocusAtom)
  const setSettingsOpen = useSetAtom(settingsOpenAtom)
  const openSession = useOpenSession()
  /** 模型 controller 只在进入项目、模型广播和手动重试时访问主进程。 */
  const imageModelSelection = useDesignImageModelSelection(projectId)
  /** 当前项目内可接收素材的未归档会话，首项即默认目标。 */
  const targetSessions = React.useMemo(
    () => getDesignTargetSessions(sessions, projectId, activeSessionId),
    [activeSessionId, projectId, sessions],
  )
  /** 右栏只投递项目级恢复信号，由画布子树持有的 controller 消费。 */
  const handleRecoveryRequired = React.useCallback((): void => {
    requestRecovery({ projectId })
  }, [projectId, requestRecovery])
  const actions = useDesignInspectorActions(projectId, designAdapter, {
    onRecoveryRequired: handleRecoveryRequired,
  })
  /** 未加载项目仍展示稳定检查器骨架。 */
  const state = states.get(projectId) ?? createInitialDesignProjectState()
  /** 创建任务后立即展示 queued，随后由 job change 事件用完整 journal 校准。 */
  const handleCreateJob = React.useCallback((input: CreateDesignJobInput): void => {
    /** 缺少当前权威 profile 时不创建主进程任务或任何占位。 */
    if (!canCreateDesignJobWithSelectedModel(input, state.imageModelProfileId)) return
    void designAdapter.createJob(input).then((job) => {
      updateState({
        projectId,
        update: (current) => ({
          jobs: [...current.jobs.filter((candidate) => candidate.id !== job.id), job],
          ...(input.action === 'generate' ? { generationPrompt: '' } : { editPrompt: '' }),
        }),
      })
    }).catch((error: unknown) => {
      if (isDesignRecoveryRequired(error)) handleRecoveryRequired()
      toast.error(error instanceof Error ? error.message : '创建设计任务失败')
    })
  }, [handleRecoveryRequired, projectId, state.imageModelProfileId, updateState])
  /** 从 Inspector 直达工具设置中的 Nano Banana 生图配置。 */
  const handleConfigureImageModels = React.useCallback((): void => {
    setSettingsTab('tools')
    setToolSettingsFocus('nano-banana')
    setSettingsOpen(true)
  }, [setSettingsOpen, setSettingsTab, setToolSettingsFocus])
  /** 准备受控素材引用并填入目标会话 composer，不触发 Agent 发送。 */
  const handleSendAssetToSession = React.useCallback((assetId: string, sessionId: string): void => {
    const session = targetSessions.find((candidate) => candidate.id === sessionId)
    if (!session) return
    void designAdapter.prepareAssetForSession({ projectId, assetId, sessionId }).then((prepared) => (
      sendPreparedDesignAssetToSession(prepared, {
        openSession: () => openSession('agent', session.id, session.title),
        enqueueMention: (targetSessionId, items) => enqueuePendingMentions({ sessionId: targetSessionId, items }),
        setActiveView,
      })
    )).catch((error: unknown) => {
      toast.error(error instanceof Error ? error.message : '发送素材到会话失败')
    })
  }, [enqueuePendingMentions, openSession, projectId, setActiveView, targetSessions])
  return (
    <DesignInspectorStateView
      state={state}
      width={width}
      createJobEnabled
      onTabChange={(inspectorTab) => updateState({ projectId, update: { inspectorTab } })}
      onGenerationPromptChange={(generationPrompt) => updateState({ projectId, update: { generationPrompt } })}
      onEditPromptChange={(editPrompt) => updateState({ projectId, update: { editPrompt } })}
      onImportAssets={actions.importAssets}
      onDeleteAsset={actions.deleteAsset}
      onRelinkAsset={actions.relinkAsset}
      onExportAsset={actions.exportAsset}
      targetSessions={targetSessions}
      onSendAssetToSession={handleSendAssetToSession}
      onSelectAsset={actions.selectAsset}
      onClearSelection={() => updateState({ projectId, update: { selectedNodeIds: [], inspectorAssetId: null } })}
      onGroupSelection={() => executeEdit({ projectId, command: { type: 'group-selection', nodeIds: state.selectedNodeIds, groupId: globalThis.crypto.randomUUID(), name: `组 ${(state.snapshot?.document.groups.length ?? 0) + 1}` } })}
      onCreateJob={handleCreateJob}
      onImageModelChange={imageModelSelection.selectProfile}
      onConfigureImageModels={handleConfigureImageModels}
      onRetryImageModels={imageModelSelection.retryLoad}
    />
  )
}
