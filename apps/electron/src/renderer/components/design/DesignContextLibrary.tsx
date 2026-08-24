import * as React from 'react'
import type {
  DesignAsset,
  DesignContextCategory,
  DesignContextEntry,
  RegisterDesignContextAssetInput,
} from '@proma/shared'
import { FilePlus2, FileUp, Pencil, Search, Trash2 } from 'lucide-react'
import type { DesignProjectState } from '@/atoms/design-atoms'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Textarea } from '@/components/ui/textarea'
import type { DesignAdapter } from '@/lib/design-adapter'
import { designAdapter } from '@/lib/design-adapter'

/** 资料库支持的稳定类别及中文名称。 */
export const DESIGN_CONTEXT_CATEGORY_OPTIONS: ReadonlyArray<{
  value: DesignContextCategory
  label: string
}> = [
  { value: 'brand', label: '品牌' },
  { value: 'product', label: '产品' },
  { value: 'code', label: '项目代码' },
  { value: 'character', label: '角色' },
  { value: 'story', label: '故事' },
  { value: 'scene', label: '场景' },
  { value: 'continuity', label: '连续性' },
  { value: 'reference', label: '视觉参考' },
]

/** 资料库类别筛选支持查看全部。 */
export type DesignContextCategoryFilter = DesignContextCategory | 'all'

/** 获取创作资料类别的稳定中文名称。 */
function getDesignContextCategoryLabel(category: DesignContextCategory): string {
  return DESIGN_CONTEXT_CATEGORY_OPTIONS.find((option) => option.value === category)?.label ?? category
}

/** 把逗号分隔标签清洗为去空、去重的稳定数组。 */
export function parseDesignContextTags(value: string): string[] {
  return [...new Set(value.split(/[,，]/u).map((tag) => tag.trim()).filter(Boolean))]
}

/** 按标题、标签和类别在 Renderer 已加载清单中筛选，不触发额外读盘。 */
export function filterDesignContextEntries(
  entries: readonly DesignContextEntry[],
  query: string,
  category: DesignContextCategoryFilter,
): DesignContextEntry[] {
  /** 搜索词统一小写，中文内容保持原样。 */
  const normalizedQuery = query.trim().toLocaleLowerCase()
  return entries.filter((entry) => {
    if (category !== 'all' && entry.category !== category) return false
    if (!normalizedQuery) return true
    /** 只搜索公开元数据，不读取或索引 Markdown 正文。 */
    const searchableText = [
      entry.title,
      getDesignContextCategoryLabel(entry.category),
      ...entry.tags,
    ].join('\n').toLocaleLowerCase()
    return searchableText.includes(normalizedQuery)
  })
}

/** 构建素材登记输入，只携带稳定 ID 和用户确认的元数据。 */
export function createVisualStandardRegistrationInput(
  projectId: string,
  asset: DesignAsset,
  category: DesignContextCategory,
  title: string,
  tags: string,
): RegisterDesignContextAssetInput {
  return {
    projectId,
    assetId: asset.id,
    category,
    title: title.trim(),
    tags: parseDesignContextTags(tags),
  }
}

/** 资料编辑器当前处理的命令类型。 */
type ContextEditorMode = 'create' | 'import' | 'edit'

/** 资料新建、导入和元数据编辑共享的表单草稿。 */
interface ContextEditorDraft {
  mode: ContextEditorMode
  entryId?: string
  category: DesignContextCategory
  title: string
  tags: string
  markdown: string
}

/** 创建空白 Markdown 资料草稿。 */
function createEmptyContextDraft(mode: 'create' | 'import'): ContextEditorDraft {
  return {
    mode,
    category: 'reference',
    title: '',
    tags: '',
    markdown: '',
  }
}

/** 从现有条目创建只修改元数据的草稿。 */
function createContextEntryDraft(entry: DesignContextEntry): ContextEditorDraft {
  return {
    mode: 'edit',
    entryId: entry.id,
    category: entry.category,
    title: entry.title,
    tags: entry.tags.join(', '),
    markdown: '',
  }
}

/** 资料库纯视图输入，异步读写由外层组件统一处理。 */
export interface DesignContextLibraryViewProps {
  projectId?: string
  open: boolean
  entries: DesignContextEntry[]
  loadState: DesignProjectState['contextLoadState']
  error: string | null
  searchQuery: string
  category: DesignContextCategoryFilter
  saving: boolean
  writable?: boolean
  visualStandardCandidate?: DesignAsset
  onOpenChange: (open: boolean) => void
  onSearchQueryChange: (query: string) => void
  onCategoryChange: (category: DesignContextCategoryFilter) => void
  onCreateDocument: () => void
  onImportDocument: () => void
  onEditEntry: (entry: DesignContextEntry) => void
  onDeleteEntry: (entry: DesignContextEntry) => void
  onRetry: () => void
  onConfirmVisualStandard: (input: RegisterDesignContextAssetInput) => void
  onCancelVisualStandard?: () => void
}

/** 资料库主体：紧凑列表、稳定状态区和素材标准确认表单。 */
export function DesignContextLibraryView({
  projectId = 'project-1',
  open,
  entries,
  loadState,
  error,
  searchQuery,
  category,
  saving,
  writable = true,
  visualStandardCandidate,
  onOpenChange,
  onSearchQueryChange,
  onCategoryChange,
  onCreateDocument,
  onImportDocument,
  onEditEntry,
  onDeleteEntry,
  onRetry,
  onConfirmVisualStandard,
  onCancelVisualStandard,
}: DesignContextLibraryViewProps): React.ReactElement {
  /** 视觉标准确认默认使用素材文件名，用户可在提交前修改。 */
  const [visualCategory, setVisualCategory] = React.useState<DesignContextCategory>('reference')
  const [visualTitle, setVisualTitle] = React.useState(visualStandardCandidate?.filename ?? '')
  const [visualTags, setVisualTags] = React.useState('')
  /** 同一 Sheet 内切换候选素材时重置确认草稿。 */
  React.useEffect(() => {
    setVisualCategory('reference')
    setVisualTitle(visualStandardCandidate?.filename ?? '')
    setVisualTags('')
  }, [visualStandardCandidate])
  /** 当前可见列表只基于已经按需加载的公开元数据。 */
  const visibleEntries = React.useMemo(
    () => filterDesignContextEntries(entries, searchQuery, category),
    [category, entries, searchQuery],
  )
  /** 清单稳定后才开放写操作，避免初次读取覆盖并发新建结果。 */
  const writeEnabled = writable && loadState === 'ready' && !saving
  /** 提交视觉标准前复核必填名称。 */
  const handleVisualStandardSubmit = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (!visualStandardCandidate || !visualTitle.trim() || saving) return
    onConfirmVisualStandard(createVisualStandardRegistrationInput(
      projectId,
      visualStandardCandidate,
      visualCategory,
      visualTitle,
      visualTags,
    ))
  }

  if (!open) return <></>
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="grid shrink-0 grid-cols-[minmax(0,1fr)_132px] gap-2 border-b border-border px-4 py-3">
        <label className="relative min-w-0">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" aria-hidden="true" />
          <span className="sr-only">搜索创作资料</span>
          <Input
            value={searchQuery}
            onChange={(event) => onSearchQueryChange(event.target.value)}
            placeholder="搜索名称或标签"
            className="h-9 pl-8 text-sm"
          />
        </label>
        <Select value={category} onValueChange={(value) => onCategoryChange(value as DesignContextCategoryFilter)}>
          <SelectTrigger className="h-9 min-w-0"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部类别</SelectItem>
            {DESIGN_CONTEXT_CATEGORY_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2">
        <Button type="button" size="sm" onClick={onCreateDocument} disabled={!writeEnabled}>
          <FilePlus2 aria-hidden="true" />新建资料
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={onImportDocument} disabled={!writeEnabled}>
          <FileUp aria-hidden="true" />导入 Markdown
        </Button>
      </div>

      {visualStandardCandidate && (
        <form aria-label="采用为视觉标准" className="shrink-0 space-y-3 border-b border-primary/30 bg-primary/5 px-4 py-3" onSubmit={handleVisualStandardSubmit}>
          <div>
            <h3 className="text-sm font-semibold">采用为视觉标准</h3>
            <p className="mt-1 break-words text-xs text-muted-foreground">确认后，这张素材会成为后续创作可引用的项目资料。</p>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1.5">
              <Label htmlFor="design-visual-standard-category" className="text-xs">类别</Label>
              <Select value={visualCategory} onValueChange={(value) => setVisualCategory(value as DesignContextCategory)} disabled={saving}>
                <SelectTrigger id="design-visual-standard-category" className="h-8"><SelectValue /></SelectTrigger>
                <SelectContent>{DESIGN_CONTEXT_CATEGORY_OPTIONS.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="design-visual-standard-title" className="text-xs">名称</Label>
              <Input id="design-visual-standard-title" value={visualTitle} onChange={(event) => setVisualTitle(event.target.value)} disabled={saving} className="h-8" />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="design-visual-standard-tags" className="text-xs">标签（可选）</Label>
            <Input id="design-visual-standard-tags" value={visualTags} onChange={(event) => setVisualTags(event.target.value)} disabled={saving} placeholder="首页, 深色" className="h-8" />
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={onCancelVisualStandard} disabled={saving}>取消</Button>
            <Button type="submit" size="sm" disabled={!writeEnabled || !visualTitle.trim()}>{saving ? '正在保存' : '确认采用'}</Button>
          </div>
        </form>
      )}

      {loadState !== 'failed' && error && (
        <div role="alert" className="shrink-0 border-b border-destructive/30 bg-destructive/5 px-4 py-2 text-xs text-destructive">
          {error}
        </div>
      )}

      <div className="min-h-40 flex-1 overflow-y-auto" aria-live="polite">
        {loadState === 'loading' && (
          <div className="flex min-h-40 items-center justify-center text-sm text-muted-foreground">正在加载创作资料</div>
        )}
        {loadState === 'failed' && (
          <div className="flex min-h-40 flex-col items-center justify-center gap-3 px-4 text-center">
            <p className="break-words text-sm text-destructive">{error ?? '加载创作资料失败'}</p>
            <Button type="button" variant="outline" size="sm" onClick={onRetry}>重试</Button>
          </div>
        )}
        {loadState === 'ready' && visibleEntries.length === 0 && (
          <div className="flex min-h-40 flex-col items-center justify-center gap-1 px-4 text-center">
            <p className="text-sm font-medium">{entries.length === 0 ? '暂无创作资料' : '没有匹配的资料'}</p>
            <p className="text-xs text-muted-foreground">{entries.length === 0 ? '新建或导入 Markdown，建立项目长期创作标准。' : '调整搜索词或类别筛选。'}</p>
          </div>
        )}
        {loadState === 'ready' && visibleEntries.length > 0 && (
          <ul className="divide-y divide-border">
            {visibleEntries.map((entry) => (
              <li key={entry.id} className="flex min-h-14 items-center gap-3 px-4 py-2">
                <span className="flex size-7 shrink-0 items-center justify-center rounded-sm border border-border bg-muted text-[11px] font-medium text-muted-foreground">
                  {entry.kind === 'asset' ? '图' : '文'}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="break-words text-sm font-medium">{entry.title}</p>
                  <p className="mt-0.5 break-words text-xs text-muted-foreground">
                    {getDesignContextCategoryLabel(entry.category)}
                    {entry.tags.length > 0 ? ` · ${entry.tags.join('、')}` : ''}
                  </p>
                </div>
                <Button type="button" variant="ghost" size="icon-sm" aria-label={`编辑 ${entry.title}`} onClick={() => onEditEntry(entry)} disabled={!writeEnabled}><Pencil aria-hidden="true" /></Button>
                <Button type="button" variant="ghost" size="icon-sm" aria-label={`删除 ${entry.title}`} onClick={() => onDeleteEntry(entry)} disabled={!writeEnabled}><Trash2 aria-hidden="true" /></Button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <button type="button" className="sr-only" onClick={() => onOpenChange(false)}>关闭创作资料库</button>
    </div>
  )
}

/** 连接主进程资料 API 所需的最小适配器接口。 */
type DesignContextLibraryAdapter = Pick<
  DesignAdapter,
  'listContext' | 'upsertContextDocument' | 'importContextDocument' | 'updateContext' | 'registerContextAsset' | 'deleteContext' | 'onChanged'
>

/** 资料库连接组件输入。 */
export interface DesignContextLibraryProps {
  projectId: string
  state: Pick<DesignProjectState, 'contextEntries' | 'contextLoadState' | 'contextError' | 'contextLibraryOpen'>
  visualStandardCandidate?: DesignAsset
  writable: boolean
  onStateChange: (update: Partial<Pick<DesignProjectState, 'contextEntries' | 'contextLoadState' | 'contextError' | 'contextLibraryOpen'>>) => void
  onVisualStandardCandidateChange?: (asset: DesignAsset | undefined) => void
  adapter?: DesignContextLibraryAdapter
}

/** 用最新返回条目替换同 ID 项，并保持更新时间倒序。 */
function upsertContextEntry(entries: readonly DesignContextEntry[], entry: DesignContextEntry): DesignContextEntry[] {
  return [...entries.filter((candidate) => candidate.id !== entry.id), entry]
    .sort((left, right) => right.updatedAt - left.updatedAt)
}

/** 创作资料库连接层：按需读取并串联受控的新建、导入、编辑和删除。 */
export function DesignContextLibrary({
  projectId,
  state,
  visualStandardCandidate,
  writable,
  onStateChange,
  onVisualStandardCandidateChange,
  adapter = designAdapter,
}: DesignContextLibraryProps): React.ReactElement {
  /** 搜索和类别仅影响当前已加载列表。 */
  const [searchQuery, setSearchQuery] = React.useState('')
  const [category, setCategory] = React.useState<DesignContextCategoryFilter>('all')
  /** 编辑草稿存在时打开资料表单。 */
  const [editorDraft, setEditorDraft] = React.useState<ContextEditorDraft | null>(null)
  /** 删除意图在用户二次确认前不调用主进程。 */
  const [deleteIntent, setDeleteIntent] = React.useState<DesignContextEntry | null>(null)
  const [saving, setSaving] = React.useState(false)
  /** 记录上一次开关状态，只在关闭到打开的边沿刷新一次。 */
  const wasOpenRef = React.useRef(false)

  /** 读取项目资料清单并把失败原因保留在 Sheet 内。 */
  const loadEntries = React.useCallback((): void => {
    onStateChange({ contextLoadState: 'loading', contextError: null })
    void adapter.listContext({ projectId }).then(
      (entries) => onStateChange({ contextEntries: entries, contextLoadState: 'ready', contextError: null }),
      (loadError: unknown) => onStateChange({
        contextLoadState: 'failed',
        contextError: loadError instanceof Error ? loadError.message : '加载创作资料失败',
      }),
    )
  }, [adapter, onStateChange, projectId])

  /** 每次重新打开都刷新，但关闭期间不让资料清单进入启动路径。 */
  React.useEffect(() => {
    if (state.contextLibraryOpen && !wasOpenRef.current) loadEntries()
    wasOpenRef.current = state.contextLibraryOpen
  }, [loadEntries, state.contextLibraryOpen])

  /** 打开期间接管其他窗口的上下文变更广播，保持资料清单一致。 */
  React.useEffect(() => {
    if (!state.contextLibraryOpen) return undefined
    return adapter.onChanged((change) => {
      if (change.projectId === projectId && change.cause === 'context') loadEntries()
    })
  }, [adapter, loadEntries, projectId, state.contextLibraryOpen])

  /** 提交资料编辑器并采用主进程返回的权威条目。 */
  const submitEditor = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (!editorDraft || saving) return
    if (editorDraft.mode !== 'import' && !editorDraft.title.trim()) return
    setSaving(true)
    onStateChange({ contextError: null })
    /** 不同模式只向 adapter 发送各自允许的窄输入。 */
    const operation = editorDraft.mode === 'create'
      ? adapter.upsertContextDocument({
          projectId,
          category: editorDraft.category,
          title: editorDraft.title.trim(),
          tags: parseDesignContextTags(editorDraft.tags),
          markdown: editorDraft.markdown,
        })
      : editorDraft.mode === 'import'
        ? adapter.importContextDocument({
            projectId,
            category: editorDraft.category,
            tags: parseDesignContextTags(editorDraft.tags),
          })
        : adapter.updateContext({
            projectId,
            entryId: editorDraft.entryId!,
            category: editorDraft.category,
            title: editorDraft.title.trim(),
            tags: parseDesignContextTags(editorDraft.tags),
          })
    void operation.then((entry) => {
      if (entry) onStateChange({
        contextEntries: upsertContextEntry(state.contextEntries, entry),
        contextLoadState: 'ready',
        contextError: null,
      })
      setEditorDraft(null)
    }).catch((saveError: unknown) => {
      onStateChange({ contextError: saveError instanceof Error ? saveError.message : '保存创作资料失败' })
    }).finally(() => setSaving(false))
  }

  /** 二次确认后删除条目，引用阻断原因原样展示。 */
  const confirmDelete = (): void => {
    if (!deleteIntent || saving) return
    setSaving(true)
    void adapter.deleteContext({ projectId, entryId: deleteIntent.id }).then(() => {
      onStateChange({
        contextEntries: state.contextEntries.filter((entry) => entry.id !== deleteIntent.id),
        contextError: null,
      })
      setDeleteIntent(null)
    }).catch((deleteError: unknown) => {
      onStateChange({ contextError: deleteError instanceof Error ? deleteError.message : '删除创作资料失败' })
    }).finally(() => setSaving(false))
  }

  /** 用户确认后才登记素材，并立即刷新当前列表。 */
  const confirmVisualStandard = (input: RegisterDesignContextAssetInput): void => {
    if (saving) return
    setSaving(true)
    void adapter.registerContextAsset(input).then((entry) => {
      onStateChange({
        contextEntries: upsertContextEntry(state.contextEntries, entry),
        contextLoadState: 'ready',
        contextError: null,
      })
      onVisualStandardCandidateChange?.(undefined)
    }).catch((saveError: unknown) => {
      onStateChange({ contextError: saveError instanceof Error ? saveError.message : '登记视觉标准失败' })
    }).finally(() => setSaving(false))
  }

  return (
    <>
      <Sheet open={state.contextLibraryOpen} onOpenChange={(open) => {
        onStateChange({ contextLibraryOpen: open })
        if (!open) onVisualStandardCandidateChange?.(undefined)
      }}>
        <SheetContent side="right" className="flex w-[520px] max-w-[92vw] flex-col gap-0 p-0 sm:max-w-[520px]">
          <SheetHeader className="shrink-0 border-b border-border px-4 py-4 pr-12 text-left">
            <SheetTitle className="text-base">创作资料库</SheetTitle>
            <SheetDescription className="text-xs">维护品牌、产品、角色、故事和视觉参考，供 Design Agent 按任务读取。</SheetDescription>
          </SheetHeader>
          <DesignContextLibraryView
            projectId={projectId}
            open={state.contextLibraryOpen}
            entries={state.contextEntries}
            loadState={state.contextLoadState}
            error={state.contextError}
            searchQuery={searchQuery}
            category={category}
            saving={saving}
            writable={writable}
            visualStandardCandidate={visualStandardCandidate}
            onOpenChange={(open) => onStateChange({ contextLibraryOpen: open })}
            onSearchQueryChange={setSearchQuery}
            onCategoryChange={setCategory}
            onCreateDocument={() => setEditorDraft(createEmptyContextDraft('create'))}
            onImportDocument={() => setEditorDraft(createEmptyContextDraft('import'))}
            onEditEntry={(entry) => setEditorDraft(createContextEntryDraft(entry))}
            onDeleteEntry={setDeleteIntent}
            onRetry={loadEntries}
            onConfirmVisualStandard={confirmVisualStandard}
            onCancelVisualStandard={() => onVisualStandardCandidateChange?.(undefined)}
          />
        </SheetContent>
      </Sheet>

      <Dialog open={editorDraft !== null} onOpenChange={(open) => { if (!open && !saving) setEditorDraft(null) }}>
        <DialogContent className="max-w-[520px] rounded-lg" aria-describedby="design-context-editor-description">
          <DialogHeader>
            <DialogTitle className="text-base">
              {editorDraft?.mode === 'create' ? '新建创作资料' : editorDraft?.mode === 'import' ? '导入 Markdown' : '编辑资料信息'}
            </DialogTitle>
            <DialogDescription id="design-context-editor-description" className="text-xs">
              {editorDraft?.mode === 'import' ? '文件由主进程选择并复制到项目受管目录，不保存来源路径。' : '资料会保存在当前项目中，供后续设计任务按需引用。'}
            </DialogDescription>
          </DialogHeader>
          {editorDraft && (
            <form className="space-y-3" onSubmit={submitEditor}>
              {editorDraft.mode !== 'import' && (
                <div className="space-y-1.5">
                  <Label htmlFor="design-context-title">名称</Label>
                  <Input id="design-context-title" value={editorDraft.title} maxLength={120} disabled={saving} onChange={(event) => setEditorDraft({ ...editorDraft, title: event.target.value })} />
                </div>
              )}
              <div className="space-y-1.5">
                <Label htmlFor="design-context-category">类别</Label>
                <Select value={editorDraft.category} disabled={saving} onValueChange={(value) => setEditorDraft({ ...editorDraft, category: value as DesignContextCategory })}>
                  <SelectTrigger id="design-context-category"><SelectValue /></SelectTrigger>
                  <SelectContent>{DESIGN_CONTEXT_CATEGORY_OPTIONS.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="design-context-tags">标签（可选）</Label>
                <Input id="design-context-tags" value={editorDraft.tags} disabled={saving} placeholder="首页, 品牌" onChange={(event) => setEditorDraft({ ...editorDraft, tags: event.target.value })} />
              </div>
              {editorDraft.mode === 'create' && (
                <div className="space-y-1.5">
                  <Label htmlFor="design-context-markdown">Markdown 内容</Label>
                  <Textarea id="design-context-markdown" value={editorDraft.markdown} disabled={saving} className="min-h-40" onChange={(event) => setEditorDraft({ ...editorDraft, markdown: event.target.value })} />
                </div>
              )}
              <DialogFooter>
                <Button type="button" variant="outline" disabled={saving} onClick={() => setEditorDraft(null)}>取消</Button>
                <Button type="submit" disabled={saving || (editorDraft.mode !== 'import' && !editorDraft.title.trim())}>
                  {saving ? '正在保存' : editorDraft.mode === 'import' ? '选择并导入' : '保存'}
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={deleteIntent !== null}
        onOpenChange={(open) => { if (!open) setDeleteIntent(null) }}
        title="删除创作资料？"
        description={deleteIntent ? `将从项目资料库移除“${deleteIntent.title}”。被任务或素材引用时会安全阻断。` : undefined}
        confirmLabel="删除"
        loadingLabel="正在删除"
        loading={saving}
        onConfirm={confirmDelete}
      />
    </>
  )
}
