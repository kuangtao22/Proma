import * as React from 'react'
import type {
  CreateDesignJobInput,
  DesignAsset,
} from '@proma/shared'
import { Download, ImageOff, RefreshCw, Send, Trash2, Upload, X } from 'lucide-react'
import { useAtomValue, useSetAtom } from 'jotai'
import { toast } from 'sonner'
import {
  createInitialDesignProjectState,
  designProjectStatesAtom,
  executeDesignEditAtom,
  requestDesignRecoveryAtom,
  updateDesignProjectStateAtom,
} from '@/atoms/design-atoms'
import type { DesignProjectState } from '@/atoms/design-atoms'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { designAdapter } from '@/lib/design-adapter'
import { cn } from '@/lib/utils'
import {
  buildDesignVersionTree,
  flattenDesignVersionTree,
  type DesignVersionTreeNode,
  type DesignVersionTreeRow,
} from './design-version-tree'
import { useDesignInspectorActions } from './use-design-inspector-actions'
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
  position: { x: number; y: number },
): CreateDesignJobInput {
  return {
    projectId,
    action: 'generate',
    prompt: serializeDesignGenerationPrompt(prompt, aspectRatio, imageSize),
    position,
  }
}

/** 创建单素材局部编辑任务输入。 */
export function createDesignEditJobInput(
  projectId: string,
  prompt: string,
  sourceAssetId: string,
  maskAnnotationId: string | undefined,
  position: { x: number; y: number },
): CreateDesignJobInput {
  return {
    projectId,
    action: 'edit',
    prompt: prompt.trim(),
    sourceAssetId,
    ...(maskAnnotationId ? { maskAnnotationId } : {}),
    position,
  }
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
  onGroupSelection: () => void
  onSelectAsset: (assetId: string) => void
  onClearSelection?: () => void
  onCreateJob: (input: CreateDesignJobInput) => void
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
  onGroupSelection: () => void
  onSelectAsset: (assetId: string) => void
  onPreviewError: (assetId: string) => void
  onPreviewLoad: (assetId: string) => void
}): React.ReactElement {
  /** 父组件已保证 snapshot 存在。 */
  const snapshot = state.snapshot!
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
              <p className="break-words text-xs font-medium">{selection.asset.filename}</p>
              <p className="text-[11px] text-muted-foreground">{selection.asset.width} × {selection.asset.height}</p>
              <p className="text-[11px] text-muted-foreground">{getAssetSourceLabel(selection.asset)}</p>
            </div>
            <div className="flex gap-1">
              <Button type="button" variant="outline" size="icon-sm" aria-label="导出素材" onClick={() => onExportAsset(selection.asset!.id)}><Download aria-hidden="true" /></Button>
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
}: {
  state: DesignProjectState
  selection: InspectorSelection
  writable: boolean
  createJobEnabled: boolean
  onGenerationPromptChange?: (prompt: string) => void
  onEditPromptChange?: (prompt: string) => void
  onCreateJob: (input: CreateDesignJobInput) => void
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
  const enabled = writable && createJobEnabled

  /** 提交空选区生成任务。 */
  const handleGenerate = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (!enabled || !state.generationPrompt.trim()) return
    onCreateJob(createDesignGenerationJobInput(
      snapshot.document.projectId,
      state.generationPrompt,
      aspectRatio,
      imageSize,
      position,
    ))
  }
  /** 提交单素材编辑任务。 */
  const handleEdit = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (!enabled || !selection.canvasAssetNodeSelected || !selection.asset || !state.editPrompt.trim()) return
    onCreateJob(createDesignEditJobInput(
      snapshot.document.projectId,
      state.editPrompt,
      selection.asset.id,
      maskAnnotationId === 'none' ? undefined : maskAnnotationId,
      position,
    ))
  }

  if (selection.selectedNodeCount > 0 && !selection.canvasAssetNodeSelected) return <p className="text-xs text-muted-foreground">AI 编辑仅支持单个素材节点</p>
  if (selection.asset && !selection.canvasAssetNodeSelected) return <p className="text-xs text-muted-foreground">AI 编辑仅支持画布素材节点</p>
  if (selection.assetId && selection.missing) return <p className="text-xs text-muted-foreground">请先重新定位缺失素材</p>
  if (selection.asset) {
    /** 只有 mask 批注允许作为编辑输入。 */
    const masks = snapshot.document.annotations.filter((annotation) => annotation.kind === 'mask')
    return (
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
  }
  return (
    <form className="space-y-3" onSubmit={handleGenerate}>
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
  )
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
  if (!state.snapshot) return <aside className="flex h-full items-center justify-center border-l border-border text-xs text-muted-foreground" style={{ width }}>正在加载检查器</aside>
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
    <aside className="flex h-full min-h-0 shrink-0 flex-col border-l border-border bg-background" style={{ width }} aria-label="设计检查器">
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
        <TabsContent value="assets" forceMount className="mt-0 min-h-0 flex-1 data-[state=inactive]:hidden"><AssetsPanel state={state} selection={selection} writable={writable} onImportAssets={props.onImportAssets} onDeleteAsset={props.onDeleteAsset} onRelinkAsset={props.onRelinkAsset} onExportAsset={props.onExportAsset} onGroupSelection={props.onGroupSelection} onSelectAsset={props.onSelectAsset} onPreviewError={(failedAssetId) => setMissingAssetIds((current) => new Set(current).add(failedAssetId))} onPreviewLoad={(loadedAssetId) => setMissingAssetIds((current) => { if (!current.has(loadedAssetId)) return current; const next = new Set(current); next.delete(loadedAssetId); return next })} /></TabsContent>
        <TabsContent value="ai" forceMount className="mt-0 min-h-0 flex-1 overflow-y-auto px-3 py-3 data-[state=inactive]:hidden"><AiPanel state={state} selection={selection} writable={writable} createJobEnabled={props.createJobEnabled ?? true} onGenerationPromptChange={props.onGenerationPromptChange} onEditPromptChange={props.onEditPromptChange} onCreateJob={props.onCreateJob} /></TabsContent>
        <TabsContent value="versions" forceMount className="mt-0 min-h-0 flex-1 overflow-y-auto px-3 py-3 data-[state=inactive]:hidden"><h3 className="mb-2 text-xs font-semibold">素材版本</h3><VersionsPanel assets={state.snapshot.document.assets} currentAssetId={selection.asset?.id ?? null} onSelectAsset={props.onSelectAsset} /></TabsContent>
      </Tabs>
    </aside>
  )
}

export interface DesignInspectorProps {
  projectId: string
  width?: number
}

/** 从项目 Jotai 状态连接右栏素材操作与真实 Design Job。 */
export function DesignInspector({ projectId, width }: DesignInspectorProps): React.ReactElement {
  const states = useAtomValue(designProjectStatesAtom)
  const updateState = useSetAtom(updateDesignProjectStateAtom)
  const executeEdit = useSetAtom(executeDesignEditAtom)
  const requestRecovery = useSetAtom(requestDesignRecoveryAtom)
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
  }, [handleRecoveryRequired, projectId, updateState])
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
      onSelectAsset={actions.selectAsset}
      onClearSelection={() => updateState({ projectId, update: { selectedNodeIds: [], inspectorAssetId: null } })}
      onGroupSelection={() => executeEdit({ projectId, command: { type: 'group-selection', nodeIds: state.selectedNodeIds, groupId: globalThis.crypto.randomUUID(), name: `组 ${(state.snapshot?.document.groups.length ?? 0) + 1}` } })}
      onCreateJob={handleCreateJob}
    />
  )
}
