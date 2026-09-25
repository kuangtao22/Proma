import * as React from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import {
  Archive,
  Check,
  ChevronDown,
  ChevronRight,
  CircleStop,
  CircleDot,
  Cookie,
  Copy,
  Download,
  Eye,
  FileInput,
  Folder,
  FolderPlus,
  GitCompare,
  GitCompareArrows,
  History,
  KeyRound,
  ListChecks,
  Menu,
  Link2,
  MoreHorizontal,
  Play,
  Plus,
  Save,
  Search,
  Server,
  Settings2,
  ShieldCheck,
  Terminal,
  Trash2,
  Upload,
  X,
} from 'lucide-react'
import type {
  ApiAssertion,
  ApiCatalog,
  ApiCatalogSnapshot,
  ApiCollection,
  ApiCookieJarEntry,
  ApiEnvironment,
  ApiExtraction,
  ApiField,
  ApiMethod,
  ApiPickedFile,
  ApiRequestBody,
  ApiRequestDraft,
  ApiRequestDefinition,
  ApiRun,
  ApiRuntimeVariable,
  ApiSseEvent,
  ApiWorkbenchApi,
} from '@proma/shared'
import {
  API_LIMITS,
  apiDraftFromDefinition,
  createApiCatalogSnapshotExport,
  createApiRequestDraft,
  createCurlCommand,
  extractApiBaseUrlVariable,
  formatApiCaseReportCells,
  formatApiCaseReportMarkdown,
  mergeApiCatalogSnapshot,
} from '@proma/shared'
import { copyTextToClipboard } from '@/lib/clipboard'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import { Badge } from '@/components/ui/badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { ApiCatalogDrawer } from './ApiCatalogDrawer'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import {
  apiWorkbenchLiveStreamAtom,
  apiWorkbenchOpenRunTargetAtom,
  apiWorkbenchSessionStateAtomFamily,
  createApiWorkbenchUiScope,
  sanitizeApiEnvironmentId,
} from '@/atoms/api-workbench-atoms'
import {
  appendBodySlice,
  clearApiValue,
  cloneApiRequestDraft,
  createApiCase,
  createApiWorkbenchController,
  createImportedRequestTabs,
  createRequestTab,
  diffApiRuns,
  draftFromRun,
  draftAssertions,
  editApiValue,
  formatCookieExpiry,
  formatApiResponseBody,
  isAgentApiCase,
  isApiRequestDirty,
  removeApiCase,
  renameCatalogFolder,
  renameApiCase,
  resolveApiCaseName,
  runAllApiCases,
  saveCatalogWithLatestRevision,
  upsertCatalogRequest,
  withDraftAssertions,
} from './api-workbench-model'
import type { ApiRunDiff, ApiWorkbenchBodyPage, ApiWorkbenchCaseBatch, ApiWorkbenchRequestTab } from './api-workbench-model'
import { ApiImportDialog } from './ApiImportDialog'
import { ApiScenarioPanel } from './ApiScenarioPanel'

/** 历史运行的重发事件名；只携带身份，执行由会话决定。 */
export const RESEND_API_RUN_EVENT = 'proma:resend-api-run'

/**
 * 分派「按当前定义重发」事件。
 * @param run 历史运行；必须属于当前会话且来自已保存请求。
 * @param currentSessionId 当前内容块所属会话。
 * @param target 事件目标，测试可注入。
 * @returns 是否真的分派了事件。
 */
export function dispatchResendApiRun(run: ApiRun, currentSessionId: string | undefined, target: EventTarget = window): boolean {
  if (!currentSessionId || run.sessionId !== currentSessionId || !run.requestId) return false
  return target.dispatchEvent(new CustomEvent(RESEND_API_RUN_EVENT, { detail: { sessionId: run.sessionId, requestId: run.requestId } }))
}

/** 阶段 A 支持的请求方法。 */
const METHODS: readonly ApiMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']
/** 编辑器一级分区。 */
type EditorSection = 'query' | 'headers' | 'body' | 'auth' | 'cases' | 'assertions' | 'extract' | 'settings'
/** 窄 Pane 当前显示的主区域。 */
type CompactView = 'request' | 'response'
/** 目录命名弹窗支持的操作。 */
type CatalogNameAction =
  | { kind: 'create-collection' }
  | { kind: 'rename-collection'; collection: ApiCollection }
  | { kind: 'create-folder'; collection: ApiCollection }
  | { kind: 'rename-folder'; collectionId: string; folder: string }

/** 获取当前 preload 的接口工作台能力；旧 preload 明确返回不可用。 */
function getApiWorkbenchApi(): ApiWorkbenchApi | null {
  /** 兼容热更新后仍运行旧 preload 的窗口类型。 */
  const electronApi = window.electronAPI as typeof window.electronAPI & { apiWorkbench?: ApiWorkbenchApi }
  return electronApi.apiWorkbench ?? null
}

/** 创建符合 Shared ID 白名单的本地编辑身份。 */
function createLocalId(prefix: string): string {
  /** UUID 删除连字符后仍是稳定安全标识符。 */
  const suffix = typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID().replaceAll('-', '')
    : `${Date.now()}${Math.random().toString(16).slice(2)}`
  return `${prefix}_${suffix}`
}

/** 创建一个可编辑空行。 */
function createField(name = '', value = ''): ApiField {
  return { id: createLocalId('field'), name, value, enabled: true }
}

/** 创建一个声明式断言。 */
function createAssertion(): ApiAssertion {
  return { id: createLocalId('assertion'), kind: 'status', path: '', expected: '200' }
}

/** 统一显示未知异常，不回显对象内部字段。 */
export function errorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof Error) || !error.message) return fallback
  /** 将稳定 Host 错误转换成用户可采取行动的说明。 */
  const messages: Record<string, string> = {
    API_WORKBENCH_SECRET_NOT_FOUND: '已保存的秘密值不可用，请重新输入后再试',
    API_WORKBENCH_SECRET_DECRYPT_FAILED: '秘密值无法解密，请重新输入后再试',
    API_WORKBENCH_SECRET_OWNER_MISMATCH: '秘密值不属于当前请求或环境，请重新输入',
    API_WORKBENCH_SECRET_BUDGET_EXCEEDED: '秘密值总量超过 1 MiB 上限，请减少后再保存',
    API_WORKBENCH_CAPACITY_LIMIT: '运行历史空间已满，请取消部分收藏后重试',
    API_WORKBENCH_USER_CASE_PROTECTED: '人工创建的用例不能被 Agent 修改或删除，请在界面上手动调整',
    API_WORKBENCH_FILE_REF_NOT_FOUND: '所选文件在本机已失效（应用重启或引用被清理），请重新选择文件',
    API_WORKBENCH_FILE_CHANGED: '所选文件在选择之后发生了变化，请重新选择文件',
    API_WORKBENCH_FILE_UNREADABLE: '所选文件已不存在或不可读，请重新选择文件',
    API_WORKBENCH_FILE_MISSING: '文件不存在或无法解析真实路径',
    API_WORKBENCH_FILE_INVALID_TYPE: '只支持常规文件，目录与特殊文件不可上传',
    API_WORKBENCH_FILE_TOO_LARGE: '文件超过单次上传上限（20 MiB）',
    API_WORKBENCH_FILE_LIMIT: '本次请求可携带的文件数量已达上限（16 个）',
    API_WORKBENCH_MULTIPART_TOO_LARGE: '附件与字段合计超过单次请求正文上限（20 MiB）',
    API_WORKBENCH_SHUTTING_DOWN: '应用正在退出或需要重启客户端：请重启 Proma 后重试',
    API_WORKBENCH_SCENARIO_PREPARED_NOT_FOUND: '这条流程的准备工作已失效，请重新点运行',
    API_WORKBENCH_SCENARIO_PREPARED_STALE: '目录在这条流程准备之后被改动过，请重新点运行',
    API_WORKBENCH_SCENARIO_PREPARED_EXPIRED: '这条流程的准备已过期，请重新点运行',
    API_WORKBENCH_SCENARIO_RUN_NOT_FOUND: '找不到这次流程运行记录，请刷新后重试',
  }
  /** 错误码位于冒号前，后续 Host 中文细节单独取出。 */
  const [code, ...detailParts] = error.message.split(':')
  const detail = detailParts.join(':').trim()
  /** 拒绝类错误的可行动原因就在 Host 细节里（例如「这是探索子会话…」），直接展示它。 */
  if (code === 'API_ACCESS_DENIED') return detail || '当前会话不能使用接口工作台；请回到有项目的会话或重启客户端后重试'
  return messages[code!] ?? error.message
}

/** 按名称、方法、URL 或文件夹过滤请求目录，不修改原始顺序。 */
export function filterApiCatalogRequests(requests: ApiRequestDefinition[], query: string): ApiRequestDefinition[] {
  /** 空白搜索展示完整目录。 */
  const normalized = query.trim().toLocaleLowerCase()
  if (!normalized) return requests
  return requests.filter((request) => [request.name, request.method, request.url, request.folder].some((value) => value.toLocaleLowerCase().includes(normalized)))
}

/** 小型图标按钮，统一工作台工具动作的尺寸与提示。 */
function ToolButton({ label, children, className, ...props }: React.ComponentProps<typeof Button> & { label: string }): React.ReactElement {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button type="button" variant="ghost" size="icon" className={cn('size-7 shrink-0', className)} aria-label={label} {...props}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

/** 可重复名称的键值行编辑器。 */
function FieldRows({
  rows,
  onChange,
  allowSecrets = false,
  namePlaceholder = '名称',
  valuePlaceholder = '值',
}: {
  rows: ApiField[]
  onChange: (rows: ApiField[]) => void
  allowSecrets?: boolean
  namePlaceholder?: string
  valuePlaceholder?: string
}): React.ReactElement {
  /** 更新指定行，保留数组顺序和重复名称。 */
  const updateRow = (id: string, update: (row: ApiField) => ApiField): void => {
    onChange(rows.map((row) => row.id === id ? update(row) : row))
  }
  return (
    <div className="space-y-1.5">
      {rows.map((row) => (
        <div key={row.id} className="grid grid-cols-[20px_minmax(92px,0.8fr)_minmax(120px,1.2fr)_auto] items-center gap-1.5">
          <input
            type="checkbox"
            checked={row.enabled}
            onChange={(event) => updateRow(row.id, (current) => ({ ...current, enabled: event.target.checked }))}
            aria-label={`启用 ${row.name || '空行'}`}
            className="size-3.5 accent-primary"
          />
          <Input value={row.name} onChange={(event) => updateRow(row.id, (current) => ({ ...current, name: event.target.value }))} placeholder={namePlaceholder} className="h-8 text-xs" />
          <div className="relative min-w-0">
            <Input
              type={allowSecrets && (row.secret || row.secretRef) ? 'password' : 'text'}
              value={row.value}
              onChange={(event) => updateRow(row.id, (current) => ({ ...current, ...editApiValue(current, event.target.value, current.secret === true || Boolean(current.secretRef)) }))}
              placeholder={row.secretRef && !row.value ? '已保存秘密（留空不修改）' : valuePlaceholder}
              className="h-8 pr-8 text-xs"
            />
            {allowSecrets && (row.secret || row.secretRef) && <KeyRound className="pointer-events-none absolute right-2 top-2 size-3.5 text-muted-foreground" />}
          </div>
          <div className="flex items-center">
            {allowSecrets && (
              <ToolButton
                label={row.secret || row.secretRef ? '改为普通变量' : '设为秘密变量'}
                onClick={() => updateRow(row.id, (current) => ({ ...current, ...editApiValue(current, current.value, !(current.secret || current.secretRef)) }))}
              >
                <KeyRound className={cn('size-3.5', (row.secret || row.secretRef) && 'text-primary')} />
              </ToolButton>
            )}
            {allowSecrets && (row.secret || row.secretRef) && (
              <ToolButton label="清除秘密值" onClick={() => updateRow(row.id, (current) => ({ ...current, ...clearApiValue(current) }))}>
                <X className="size-3.5" />
              </ToolButton>
            )}
            <ToolButton label="删除此行" onClick={() => onChange(rows.filter((item) => item.id !== row.id))}>
              <Trash2 className="size-3.5" />
            </ToolButton>
          </div>
        </div>
      ))}
      <Button type="button" variant="ghost" size="sm" className="h-7 gap-1.5 px-2 text-xs" onClick={() => onChange([...rows, createField()])}>
        <Plus className="size-3.5" /> 添加一行
      </Button>
    </div>
  )
}

/** 请求目录，集合和文件夹操作都直接落到最新目录 revision。 */
function CatalogPanel({
  catalog,
  sessionId,
  activeTabId,
  onOpenRequest,
  onCreateRequest,
  onCreateCollection,
  onRenameCollection,
  onDeleteCollection,
  onCreateFolder,
  onExtractBaseUrl,
  onExtractBaseUrlToEnvironment,
  onRenameFolder,
  onDeleteFolder,
  onExportSnapshot,
}: {
  catalog: ApiCatalog
  sessionId: string
  activeTabId: string | null
  onOpenRequest: (request: ApiRequestDefinition) => void
  onCreateRequest: (collectionId: string, folder?: string) => void
  onCreateCollection: () => void
  onRenameCollection: (collection: ApiCollection) => void
  onDeleteCollection: (collection: ApiCollection) => void
  onCreateFolder: (collection: ApiCollection) => void
  /** 把集合里硬编码的主机抽成 `baseUrl` 变量：批量导入后的一键整理。 */
  onExtractBaseUrl: (collection: ApiCollection) => void
  /** 同上，但抽到当前选中的环境里，并把这些请求绑定到该环境（对应「测试环境 http://...」）。 */
  onExtractBaseUrlToEnvironment: (collection: ApiCollection) => void
  onRenameFolder: (collectionId: string, folder: string) => void
  onDeleteFolder: (collectionId: string, folder: string) => void
  onExportSnapshot: () => void
}): React.ReactElement {
  /** 当前展开的集合。 */
  const [expanded, setExpanded] = React.useState<Set<string>>(() => new Set(catalog.collections.map((item) => item.id)))
  /** 目录内请求搜索词，只影响当前渲染投影。 */
  const [query, setQuery] = React.useState('')
  /** 当前搜索命中的请求。 */
  const visibleRequests = React.useMemo(() => filterApiCatalogRequests(catalog.requests, query), [catalog.requests, query])
  /** 搜索时隐藏没有命中请求的集合。 */
  const visibleCollections = React.useMemo(() => query.trim()
    ? catalog.collections.filter((collection) => visibleRequests.some((request) => request.collectionId === collection.id))
    : catalog.collections, [catalog.collections, query, visibleRequests])
  return (
    <aside className="flex h-full min-h-0 w-full flex-col border-r border-border/50 bg-muted/[0.18]">
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-border/50 px-2.5">
        <span className="text-xs font-semibold">目录</span>
        <div className="flex items-center gap-1">
          <ToolButton label="复制集合快照" onClick={onExportSnapshot}><Download className="size-3.5" /></ToolButton>
          <ToolButton label="新建集合" onClick={onCreateCollection}><Plus className="size-3.5" /></ToolButton>
        </div>
      </div>
      <div className="relative shrink-0 border-b border-border/40 p-2">
        <Search className="pointer-events-none absolute left-4 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input value={query} onChange={(event) => setQuery(event.target.value)} aria-label="搜索请求" placeholder="搜索请求" className="h-7 pl-8 text-xs" />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {catalog.collections.length === 0 ? (
          <button type="button" className="flex w-full flex-col items-center gap-2 rounded-md border border-dashed border-border/70 px-3 py-8 text-center text-xs text-muted-foreground hover:bg-muted/40" onClick={onCreateCollection}>
            <Archive className="size-5" />
            创建第一个集合
          </button>
        ) : visibleCollections.length === 0 ? (
          <div className="px-3 py-8 text-center text-xs text-muted-foreground">没有匹配的请求</div>
        ) : visibleCollections.map((collection) => {
          /** 当前集合下的文件夹路径。 */
          const folders = [...new Set(visibleRequests.filter((request) => request.collectionId === collection.id && request.folder).map((request) => request.folder))].sort()
          /** 当前集合根目录请求。 */
          const rootRequests = visibleRequests.filter((request) => request.collectionId === collection.id && !request.folder)
          /** 集合是否展开。 */
          const isExpanded = Boolean(query.trim()) || expanded.has(collection.id)
          return (
            <section key={collection.id} className="mb-1">
              <div className="group flex items-center gap-1 rounded-md hover:bg-muted/60">
                <button type="button" className="flex min-w-0 flex-1 items-center gap-1.5 px-1.5 py-1.5 text-left text-xs font-medium" onClick={() => setExpanded((previous) => {
                  /** 复制集合，避免原地修改 React 状态。 */
                  const next = new Set(previous)
                  if (next.has(collection.id)) next.delete(collection.id); else next.add(collection.id)
                  return next
                })}>
                  {isExpanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
                  <span className="truncate">{collection.name}</span>
                </button>
                <ToolButton label="新建请求" className="opacity-0 group-hover:opacity-100" onClick={() => onCreateRequest(collection.id)}><Plus className="size-3" /></ToolButton>
                <ToolButton label="新建文件夹" className="opacity-0 group-hover:opacity-100" onClick={() => onCreateFolder(collection)}><FolderPlus className="size-3" /></ToolButton>
                <ToolButton label="主机提取为变量" className="opacity-0 group-hover:opacity-100" onClick={() => onExtractBaseUrl(collection)}><Link2 className="size-3" /></ToolButton>
                <ToolButton label="主机提取到环境" className="opacity-0 group-hover:opacity-100" onClick={() => onExtractBaseUrlToEnvironment(collection)}><Server className="size-3" /></ToolButton>
                <ToolButton label="重命名集合" className="opacity-0 group-hover:opacity-100" onClick={() => onRenameCollection(collection)}><MoreHorizontal className="size-3" /></ToolButton>
                <ToolButton label="删除集合" className="opacity-0 group-hover:opacity-100" onClick={() => onDeleteCollection(collection)}><Trash2 className="size-3" /></ToolButton>
              </div>
              {isExpanded && (
                <div className="ml-4 border-l border-border/50 pl-1.5">
                  {rootRequests.map((request) => <RequestTreeButton key={request.id} request={request} activeTabId={activeTabId} onOpen={onOpenRequest} environmentKind={catalog.environments.find((item) => item.id === request.targetEnvironmentId)?.kind} />)}
                  {folders.map((folder) => (
                    <div key={folder} className="group/folder">
                      <div className="flex items-center gap-1 px-1 py-1 text-[11px] text-muted-foreground">
                        <Folder className="size-3.5" />
                        <span className="min-w-0 flex-1 truncate">{folder}</span>
                        <ToolButton label="在文件夹中新建请求" className="opacity-0 group-hover/folder:opacity-100" onClick={() => onCreateRequest(collection.id, folder)}><Plus className="size-3" /></ToolButton>
                        <ToolButton label="重命名文件夹" className="opacity-0 group-hover/folder:opacity-100" onClick={() => onRenameFolder(collection.id, folder)}><MoreHorizontal className="size-3" /></ToolButton>
                        <ToolButton label="删除文件夹" className="opacity-0 group-hover/folder:opacity-100" onClick={() => onDeleteFolder(collection.id, folder)}><Trash2 className="size-3" /></ToolButton>
                      </div>
                      <div className="ml-3">
                        {visibleRequests.filter((request) => request.collectionId === collection.id && request.folder === folder).map((request) => <RequestTreeButton key={request.id} request={request} activeTabId={activeTabId} onOpen={onOpenRequest} environmentKind={catalog.environments.find((item) => item.id === request.targetEnvironmentId)?.kind} />)}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>
          )
        })}
        <ApiScenarioPanel
          sessionId={sessionId}
          scenarios={catalog.scenarios ?? []}
          requestNames={new Map(catalog.requests.map((request) => [request.id, request.name]))}
        />
      </div>
    </aside>
  )
}

/** 集合与文件夹共用受控命名弹窗，确保 Electron 内可交互。 */
function CatalogNameDialog({ action, onOpenChange, onSubmit }: { action: CatalogNameAction | null; onOpenChange: (open: boolean) => void; onSubmit: (name: string) => void }): React.ReactElement {
  /** 根据当前操作初始化名称。 */
  const initialName = action?.kind === 'rename-collection' ? action.collection.name : action?.kind === 'rename-folder' ? action.folder : action?.kind === 'create-folder' ? '新文件夹' : '新集合'
  /** 弹窗本地输入，取消不会修改目录。 */
  const [name, setName] = React.useState(initialName)
  React.useEffect(() => setName(initialName), [action, initialName])
  /** 集合和文件夹使用对应标题。 */
  const title = action?.kind === 'create-collection' ? '新建集合' : action?.kind === 'rename-collection' ? '重命名集合' : action?.kind === 'create-folder' ? '新建文件夹' : '重命名文件夹'
  return (
    <Dialog open={action !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <form onSubmit={(event) => { event.preventDefault(); const value = name.trim(); if (value) onSubmit(value) }}>
          <DialogHeader><DialogTitle>{title}</DialogTitle><DialogDescription>名称不能为空；文件夹可使用路径形式组织请求。</DialogDescription></DialogHeader>
          <Input autoFocus value={name} onChange={(event) => setName(event.target.value)} aria-label={title} className="my-4" />
          <DialogFooter><Button type="button" variant="outline" onClick={() => onOpenChange(false)}>取消</Button><Button type="submit" disabled={!name.trim()}>确认</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** 目录中的请求入口。 */
function RequestTreeButton({ request, activeTabId, onOpen, environmentKind }: {
  request: ApiRequestDefinition
  activeTabId: string | null
  onOpen: (request: ApiRequestDefinition) => void
  environmentKind?: ApiEnvironment['kind']
}): React.ReactElement {
  /** 请求已打开时由 requestId 定位标签，按钮仍负责切换活动项。 */
  const active = activeTabId === `request_${request.id}`
  /** 该接口声明的用例数量；为 0 时不显示徽标。 */
  const caseCount = request.cases?.length ?? 0
  return (
    <button type="button" className={cn('flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-muted/60', active && 'bg-muted text-foreground')} onClick={() => onOpen(request)}>
      <span className={cn('w-10 shrink-0 font-mono text-[9px] font-semibold', request.method === 'GET' ? 'text-emerald-600 dark:text-emerald-400' : 'text-sky-600 dark:text-sky-400')}>{request.method}</span>
      {environmentKind && <EnvironmentKindBadge kind={environmentKind} />}
      <span className="min-w-0 flex-1 truncate">{request.name}</span>
      {caseCount > 0 && <span className="ml-auto shrink-0 rounded bg-muted px-1 text-[9px] text-muted-foreground" title={`该接口有 ${caseCount} 条测试用例`}>{caseCount} 用例</span>}
    </button>
  )
}

/** 多请求编辑标签栏。 */
function RequestTabBar({ tabs, activeTabId, onSelect, onClose }: { tabs: ApiWorkbenchRequestTab[]; activeTabId: string | null; onSelect: (id: string) => void; onClose: (id: string) => void }): React.ReactElement {
  return (
    <div className="flex h-9 shrink-0 items-end gap-1 overflow-x-auto border-b border-border/50 px-2 scrollbar-none" role="tablist" aria-label="请求编辑标签">
      {tabs.map((tab) => (
        <div key={tab.id} className={cn('group flex h-8 min-w-[110px] max-w-52 items-center rounded-t-md border border-b-0 px-2 text-xs', tab.id === activeTabId ? 'border-border/60 bg-background text-foreground' : 'border-transparent text-muted-foreground hover:bg-muted/40')}>
          <button type="button" role="tab" aria-selected={tab.id === activeTabId} className="min-w-0 flex-1 truncate text-left" onClick={() => onSelect(tab.id)}>
            {tab.dirty && <span className="mr-1 text-primary">●</span>}{tab.draft.name || '未命名请求'}
          </button>
          <button type="button" className="ml-1 rounded p-0.5 opacity-50 hover:bg-muted hover:opacity-100" onClick={() => onClose(tab.id)} aria-label={`关闭 ${tab.draft.name}`}><X className="size-3" /></button>
        </div>
      ))}
    </div>
  )
}

/** 请求编辑器主体。 */
function RequestEditor({ tab, environmentId, environments, casesRunning, onChange, onCasesChange, onActiveCaseChange, onRunAllCases, onSave, onDuplicate, onCopyCurl, onDelete, onSend, onCancel, onPickFiles }: {
  tab: ApiWorkbenchRequestTab
  environmentId: string | null
  /** 用于「目标环境」标记选择：标记只区分开发/测试/生产，不改变发送权限。 */
  environments: ApiEnvironment[]
  /** 是否正在跑全部用例：期间不允许再触发批量或改选用例。 */
  casesRunning: boolean
  onChange: (draft: ApiRequestDraft) => void
  onCasesChange: (draft: ApiRequestDraft, activeCaseId: string | undefined) => void
  onActiveCaseChange: (caseId: string | undefined) => void
  onRunAllCases: () => void
  onSave: () => void
  onDuplicate: () => void
  onCopyCurl: () => void
  onDelete: () => void
  onSend: () => void
  onCancel: () => void
  /** 打开原生文件对话框选择待上传文件（multipart 正文用）。 */
  onPickFiles: () => Promise<ApiPickedFile[]>
}): React.ReactElement {
  /** 当前编辑分区。 */
  const [section, setSection] = React.useState<EditorSection>('query')
  /** 当前选中的用例；用例被删除后自动回落为请求默认断言。 */
  const activeCase = (tab.draft.cases ?? []).find((item) => item.id === tab.activeCaseId)
  /** 「断言」页当前编辑的对象说明。 */
  const assertionTarget = activeCase ? `用例「${activeCase.name}」的断言` : '请求默认断言（不随用例执行）'
  /** 只更新草稿某个顶层字段。 */
  const patchDraft = <Key extends keyof ApiRequestDraft>(key: Key, value: ApiRequestDraft[Key]): void => onChange({ ...tab.draft, [key]: value })
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex shrink-0 items-center gap-2 border-b border-border/40 px-3 py-2">
        <Input value={tab.draft.name} onChange={(event) => patchDraft('name', event.target.value)} className="h-8 min-w-0 flex-1 border-transparent bg-transparent px-1 text-sm font-semibold shadow-none hover:border-border/50" aria-label="请求名称" />
        <span className="hidden text-[10px] text-muted-foreground xl:inline">{environmentId ? '使用所选环境' : '无环境'}</span>
        <ToolButton label="跑全部用例" onClick={onRunAllCases} disabled={casesRunning || tab.sending || (tab.draft.cases ?? []).length === 0}><ListChecks className="size-3.5" /></ToolButton>
        <ToolButton label="保存请求 (⌘S)" onClick={onSave} disabled={tab.saving}><Save className="size-3.5" /></ToolButton>
        <ToolButton label="复制请求" onClick={onDuplicate}><Copy className="size-3.5" /></ToolButton>
        <ToolButton label="复制为 cURL" onClick={onCopyCurl}><Terminal className="size-3.5" /></ToolButton>
        <ToolButton label="删除请求" onClick={onDelete}><Trash2 className="size-3.5" /></ToolButton>
      </div>
      <div className="flex shrink-0 items-center gap-1.5 px-3 py-2">
        <Select value={tab.draft.method} onValueChange={(value) => patchDraft('method', value as ApiMethod)}>
          <SelectTrigger className="h-9 w-[108px] font-mono text-xs font-semibold"><SelectValue /></SelectTrigger>
          <SelectContent>{METHODS.map((method) => <SelectItem key={method} value={method}>{method}</SelectItem>)}</SelectContent>
        </Select>
        <Input value={tab.draft.url} onChange={(event) => patchDraft('url', event.target.value)} placeholder="https://api.example.com/users/{{id}}" className="h-9 min-w-0 flex-1 font-mono text-xs" aria-label="请求 URL" />
        {tab.sending ? (
          <Button type="button" variant="destructive" className="h-9 gap-1.5 px-3" onClick={onCancel}><CircleStop className="size-4" />取消</Button>
        ) : (
          <Button type="button" className="h-9 gap-1.5 px-3" onClick={onSend} disabled={casesRunning} title={casesRunning ? '正在跑全部用例，请等这批结束或取消' : undefined}><Play className="size-4" />发送</Button>
        )}
      </div>
      {tab.error && <div className="mx-3 mb-2 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">{tab.error}</div>}
      <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-border/50 px-3 scrollbar-none">
        {([['query', '查询'], ['headers', 'Headers'], ['body', 'Body'], ['auth', '鉴权'], ['cases', '用例'], ['assertions', '断言'], ['extract', '提取'], ['settings', '设置']] as const).map(([id, label]) => (
          <button key={id} type="button" className={cn('h-8 shrink-0 border-b-2 px-2 text-xs', section === id ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground')} onClick={() => setSection(id)}>{label}</button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {section === 'query' && <FieldRows rows={tab.draft.query} allowSecrets onChange={(rows) => patchDraft('query', rows)} namePlaceholder="参数" />}
        {section === 'headers' && <FieldRows rows={tab.draft.headers} allowSecrets onChange={(rows) => patchDraft('headers', rows)} namePlaceholder="Header" />}
        {section === 'body' && <BodyEditor body={tab.draft.body} onChange={(body) => patchDraft('body', body)} onPickFiles={onPickFiles} />}
        {section === 'auth' && <AuthEditor draft={tab.draft} onChange={onChange} />}
        {section === 'cases' && <CaseEditor draft={tab.draft} activeCaseId={activeCase?.id} onCasesChange={onCasesChange} onActiveCaseChange={onActiveCaseChange} />}
        {section === 'assertions' && <AssertionEditor assertions={draftAssertions(tab.draft, activeCase?.id)} target={assertionTarget} onChange={(assertions) => onChange(withDraftAssertions(tab.draft, activeCase?.id, assertions))} />}
        {section === 'extract' && <ExtractionEditor extractions={tab.draft.extractions ?? []} onChange={(extractions) => patchDraft('extractions', extractions)} />}
        {section === 'settings' && <RequestSettings draft={tab.draft} environments={environments} activeEnvironmentId={environmentId} onChange={onChange} />}
      </div>
    </div>
  )
}

/** 正文类型和内容编辑器；multipart 的文件只能经原生对话框选择。 */
function BodyEditor({ body, onChange, onPickFiles }: {
  body: ApiRequestBody
  onChange: (body: ApiRequestBody) => void
  /** 打开原生文件对话框并登记引用；取消时返回空数组。 */
  onPickFiles: () => Promise<ApiPickedFile[]>
}): React.ReactElement {
  /** 文件选择中的忙碌标记，避免重复弹窗。 */
  const [picking, setPicking] = React.useState(false)
  /** 本地展示的错误（例如文件超限），不污染请求状态。 */
  const [pickError, setPickError] = React.useState<string | null>(null)
  /** 选择文件并追加到草稿；引用失效由发送阶段 fail closed。 */
  const pickFiles = async (): Promise<void> => {
    if (picking) return
    setPicking(true)
    setPickError(null)
    try {
      const picked = await onPickFiles()
      if (picked.length === 0) return
      const files = [...(body.files ?? []), ...picked.map((file) => ({ id: createLocalId('part'), name: 'file', fileName: file.fileName, sizeBytes: file.sizeBytes, contentType: file.contentType, ref: file.ref }))]
      onChange({ ...body, files })
    } catch (error) {
      setPickError(errorMessage(error, '选择文件失败'))
    } finally {
      setPicking(false)
    }
  }
  return (
    <div className="space-y-3">
      <Select value={body.kind} onValueChange={(kind) => onChange({ ...body, kind: kind as ApiRequestBody['kind'] })}>
        <SelectTrigger className="h-8 w-44 text-xs"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="none">none</SelectItem><SelectItem value="json">JSON</SelectItem><SelectItem value="text">Text</SelectItem><SelectItem value="urlencoded">x-www-form-urlencoded</SelectItem><SelectItem value="multipart">multipart/form-data</SelectItem>
        </SelectContent>
      </Select>
      {(body.kind === 'json' || body.kind === 'text') && <Textarea value={body.text} onChange={(event) => onChange({ ...body, text: event.target.value })} className="min-h-40 resize-y font-mono text-xs" placeholder={body.kind === 'json' ? '{\n  "name": "Proma"\n}' : '请求正文'} />}
      {body.kind === 'urlencoded' && <FieldRows rows={body.fields} allowSecrets onChange={(fields) => onChange({ ...body, fields })} namePlaceholder="字段" />}
      {body.kind === 'multipart' && (
        <div className="space-y-3">
          <FieldRows rows={body.fields} allowSecrets onChange={(fields) => onChange({ ...body, fields })} namePlaceholder="字段" />
          <div className="space-y-1.5">
            {(body.files ?? []).map((file) => (
              <div key={file.id} className="grid grid-cols-[minmax(96px,140px)_minmax(120px,1fr)_auto_32px] items-center gap-2">
                <Input value={file.name} aria-label="文件字段名" onChange={(event) => onChange({ ...body, files: (body.files ?? []).map((item) => item.id === file.id ? { ...item, name: event.target.value } : item) })} className="h-8 text-xs" />
                <span className="min-w-0 truncate text-xs text-muted-foreground" title={file.fileName}>{file.fileName} · {(file.sizeBytes / 1024).toFixed(1)} KiB</span>
                <span className="shrink-0 rounded bg-muted px-1 text-[9px] text-muted-foreground">{file.contentType ?? 'application/octet-stream'}</span>
                <ToolButton label={`移除文件 ${file.fileName}`} onClick={() => onChange({ ...body, files: (body.files ?? []).filter((item) => item.id !== file.id) })}><Trash2 className="size-3.5" /></ToolButton>
              </div>
            ))}
            <Button type="button" variant="ghost" size="sm" className="h-7 gap-1.5 px-2 text-xs" disabled={picking} onClick={() => void pickFiles()}><Plus className="size-3.5" />选择文件</Button>
          </div>
          <p className="text-[11px] text-muted-foreground">文件只在主进程内存里保存引用，不写入请求定义；应用重启后需要重新选择。附件内容不写入运行记录，只保留文件名、大小与 sha256。</p>
          {pickError && <p className="text-[11px] text-destructive">{pickError}</p>}
        </div>
      )}
      {body.kind === 'none' && <div className="rounded-md border border-dashed border-border/60 px-3 py-8 text-center text-xs text-muted-foreground">该请求不发送正文</div>}
    </div>
  )
}

/** 鉴权编辑器，秘密输入遵循显式编辑和清除规则。 */
function AuthEditor({ draft, onChange }: { draft: ApiRequestDraft; onChange: (draft: ApiRequestDraft) => void }): React.ReactElement {
  /** 更新鉴权对象。 */
  const patchAuth = (patch: Partial<ApiRequestDraft['auth']>): void => onChange({ ...draft, auth: { ...draft.auth, ...patch } })
  /** 当前值是否使用秘密存储。 */
  const secret = draft.auth.value.secret === true || Boolean(draft.auth.value.secretRef)
  return (
    <div className="max-w-xl space-y-3">
      <Select value={draft.auth.type} onValueChange={(type) => patchAuth({ type: type as ApiRequestDraft['auth']['type'] })}>
        <SelectTrigger className="h-8 w-48 text-xs"><SelectValue /></SelectTrigger>
        <SelectContent><SelectItem value="none">无鉴权</SelectItem><SelectItem value="bearer">Bearer Token</SelectItem><SelectItem value="basic">Basic Auth</SelectItem><SelectItem value="api-key">API Key</SelectItem></SelectContent>
      </Select>
      {draft.auth.type === 'basic' && <Input value={draft.auth.username ?? ''} onChange={(event) => patchAuth({ username: event.target.value })} placeholder="用户名" className="h-8 text-xs" />}
      {draft.auth.type === 'api-key' && (
        <div className="grid grid-cols-[1fr_120px] gap-2">
          <Input value={draft.auth.name ?? ''} onChange={(event) => patchAuth({ name: event.target.value })} placeholder="Key 名称" className="h-8 text-xs" />
          <Select value={draft.auth.in ?? 'header'} onValueChange={(location) => patchAuth({ in: location as 'header' | 'query' })}><SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="header">Header</SelectItem><SelectItem value="query">Query</SelectItem></SelectContent></Select>
        </div>
      )}
      {draft.auth.type !== 'none' && (
        <div className="flex gap-2">
          <Input type={secret ? 'password' : 'text'} value={draft.auth.value.value} onChange={(event) => patchAuth({ value: editApiValue(draft.auth.value, event.target.value, secret) })} placeholder={draft.auth.value.secretRef ? '已保存秘密（留空不修改）' : draft.auth.type === 'basic' ? '密码' : '凭据'} className="h-8 text-xs" />
          <Button type="button" variant={secret ? 'secondary' : 'outline'} size="sm" className="h-8 gap-1.5" onClick={() => patchAuth({ value: editApiValue(draft.auth.value, draft.auth.value.value, !secret) })}><KeyRound className="size-3.5" />秘密</Button>
          {secret && <Button type="button" variant="ghost" size="sm" className="h-8" onClick={() => patchAuth({ value: clearApiValue(draft.auth.value) })}>清除</Button>}
        </div>
      )}
    </div>
  )
}

/** 环境用途的展示标签；local 对用户就是「开发」。 */
const ENVIRONMENT_KIND_LABEL: Record<ApiEnvironment['kind'], string> = { local: '开发', test: '测试', production: '生产' }

/** 环境用途徽标：生产用红色，测试用琥珀色，开发用中性色。 */
function EnvironmentKindBadge({ kind }: { kind: ApiEnvironment['kind'] }): React.ReactElement {
  return (
    <span
      className={cn('shrink-0 rounded px-1 text-[9px] font-medium',
        kind === 'production' ? 'bg-destructive/10 text-destructive'
          : kind === 'test' ? 'bg-amber-500/15 text-amber-700 dark:text-amber-400'
            : 'bg-muted text-muted-foreground')}
      title={`该接口标记的目标环境：${ENVIRONMENT_KIND_LABEL[kind]}`}
    >
      {ENVIRONMENT_KIND_LABEL[kind]}
    </span>
  )
}

/** 声明式提取编辑器：提取值只进入宿主会话内存，可用 {{变量名}} 复用。 */
function ExtractionEditor({ extractions, onChange }: { extractions: ApiExtraction[]; onChange: (extractions: ApiExtraction[]) => void }): React.ReactElement {
  /** 更新单条规则。 */
  const update = (id: string, patch: Partial<ApiExtraction>): void => onChange(extractions.map((item) => item.id === id ? { ...item, ...patch } : item))
  return (
    <div className="space-y-2">
      {extractions.map((rule) => (
        <div key={rule.id} className="grid grid-cols-[minmax(96px,150px)_minmax(120px,150px)_minmax(90px,1fr)_auto_32px] items-center gap-2">
          <Input value={rule.name} onChange={(event) => update(rule.id, { name: event.target.value })} placeholder="变量名" aria-label="提取变量名" className="h-8 font-mono text-xs" />
          <Select value={rule.from} onValueChange={(from) => update(rule.id, { from: from as ApiExtraction['from'] })}><SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="json">正文 JSON</SelectItem><SelectItem value="header">响应 Header</SelectItem><SelectItem value="sse-last-data">事件流最后一段</SelectItem></SelectContent></Select>
          <Input value={rule.path} onChange={(event) => update(rule.id, { path: event.target.value })} placeholder={rule.from === 'json' ? 'data.token' : rule.from === 'header' ? 'Set-Cookie' : '路径（可空）'} className="h-8 text-xs" />
          <label className="flex items-center gap-1 text-[11px] text-muted-foreground"><input type="checkbox" className="size-3.5 accent-primary" checked={rule.secret} aria-label="按秘密处理" onChange={(event) => update(rule.id, { secret: event.target.checked })} />秘密</label>
          <ToolButton label="删除提取" onClick={() => onChange(extractions.filter((item) => item.id !== rule.id))}><Trash2 className="size-3.5" /></ToolButton>
        </div>
      ))}
      <Button type="button" variant="ghost" size="sm" className="h-7 gap-1.5 px-2 text-xs" onClick={() => onChange([...extractions, { id: createLocalId('extract'), name: 'token', from: 'json', path: '', secret: true }])}><Plus className="size-3.5" />添加提取</Button>
      <p className="text-[11px] text-muted-foreground">提取值只存在本次应用会话的内存里（1 小时过期，重启失效，不写入磁盘），可用 {'{{变量名}}'} 在后续请求中引用。</p>
    </div>
  )
}

/** 声明式断言编辑器；target 说明这组断言属于请求默认还是某条用例。 */
function AssertionEditor({ assertions, target, onChange }: { assertions: ApiAssertion[]; target: string; onChange: (assertions: ApiAssertion[]) => void }): React.ReactElement {
  /** 更新单条断言。 */
  const updateAssertion = (id: string, patch: Partial<ApiAssertion>): void => onChange(assertions.map((item) => item.id === id ? { ...item, ...patch } : item))
  return (
    <div className="space-y-2">
      <p className="text-[11px] text-muted-foreground">正在编辑：{target}</p>
      {assertions.map((assertion) => (
        <div key={assertion.id} className="grid grid-cols-[140px_minmax(100px,1fr)_minmax(100px,1fr)_32px] gap-2">
          <Select value={assertion.kind} onValueChange={(kind) => updateAssertion(assertion.id, { kind: kind as ApiAssertion['kind'] })}><SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="status">状态码</SelectItem><SelectItem value="header">Header</SelectItem><SelectItem value="json-value">JSON 值</SelectItem><SelectItem value="json-exists">JSON 存在</SelectItem><SelectItem value="json-type">JSON 类型</SelectItem><SelectItem value="duration">耗时</SelectItem><SelectItem value="sse-count">事件数量</SelectItem><SelectItem value="sse-first-event">首事件耗时</SelectItem><SelectItem value="sse-ended">事件流结束</SelectItem><SelectItem value="sse-last-data">最后一段事件数据</SelectItem></SelectContent></Select>
          <Input value={assertion.path} onChange={(event) => updateAssertion(assertion.id, { path: event.target.value })} placeholder={assertion.kind === 'header' ? 'Header 名称' : assertion.kind.startsWith('json') ? 'data.items[0].id' : '路径（可空）'} className="h-8 text-xs" />
          <Input value={assertion.expected} onChange={(event) => updateAssertion(assertion.id, { expected: event.target.value })} placeholder={assertion.kind === 'sse-count' ? '>=3 或 3' : assertion.kind === 'sse-first-event' ? '<=500' : assertion.kind === 'sse-ended' ? 'completed' : assertion.kind === 'sse-last-data' ? '[DONE] 或 =精确值' : assertion.kind === 'json-type' ? 'string/number/boolean/object/array/null' : '期望值'} className="h-8 text-xs" />
          <ToolButton label="删除断言" onClick={() => onChange(assertions.filter((item) => item.id !== assertion.id))}><Trash2 className="size-3.5" /></ToolButton>
        </div>
      ))}
      <Button type="button" variant="ghost" size="sm" className="h-7 gap-1.5 px-2 text-xs" onClick={() => onChange([...assertions, createAssertion()])}><Plus className="size-3.5" />添加断言</Button>
    </div>
  )
}

/** 用例编辑器：维护用例清单与当前编辑目标，断言仍在「断言」页编辑。 */
function CaseEditor({ draft, activeCaseId, onCasesChange, onActiveCaseChange }: {
  draft: ApiRequestDraft
  activeCaseId?: string
  onCasesChange: (draft: ApiRequestDraft, activeCaseId: string | undefined) => void
  onActiveCaseChange: (caseId: string | undefined) => void
}): React.ReactElement {
  /** 当前请求声明的用例，保持用户顺序。 */
  const cases = draft.cases ?? []
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          aria-pressed={!activeCaseId}
          className={cn('rounded-md border px-2 py-1 text-xs', !activeCaseId ? 'border-primary text-foreground' : 'border-border/60 text-muted-foreground hover:bg-muted/40')}
          onClick={() => onActiveCaseChange(undefined)}
        >默认断言（请求自身）</button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 gap-1.5 px-2 text-xs"
          disabled={cases.length >= API_LIMITS.maxCases}
          onClick={() => {
            /** 新用例默认只跑请求；创建后立即选中，方便马上补断言。 */
            const created = createApiCase(createLocalId('case'))
            onCasesChange({ ...draft, cases: [...cases, created] }, created.id)
          }}
        ><Plus className="size-3.5" />新增用例</Button>
        <span className="text-[11px] text-muted-foreground">{cases.length}/{API_LIMITS.maxCases}</span>
      </div>
      {cases.map((item) => (
        <div key={item.id} className="grid grid-cols-[auto_minmax(120px,1fr)_auto_auto_auto] items-center gap-2">
          <button
            type="button"
            aria-label={`设为当前用例 ${item.name}`}
            aria-pressed={item.id === activeCaseId}
            className={cn('flex size-6 items-center justify-center rounded-md border', item.id === activeCaseId ? 'border-primary bg-primary/10 text-primary' : 'border-border/60 text-muted-foreground hover:bg-muted/40')}
            onClick={() => onActiveCaseChange(item.id)}
          >{item.id === activeCaseId ? <Check className="size-3.5" /> : <CircleDot className="size-3.5" />}</button>
          <Input value={item.name} aria-label="用例名称" onChange={(event) => onCasesChange(renameApiCase(draft, item.id, event.target.value), activeCaseId)} className="h-8 text-xs" />
          {isAgentApiCase(item) && <Badge variant="secondary" className="shrink-0 px-1 text-[9px]" title="由 Agent 声明；人工写下的用例不可被 Agent 修改或删除，报告里也会标注来源">Agent</Badge>}
          <span className="shrink-0 text-[11px] text-muted-foreground">{item.assertions.length} 条断言</span>
          <ToolButton label={`删除用例 ${item.name}`} onClick={() => onCasesChange(removeApiCase(draft, item.id), activeCaseId === item.id ? undefined : activeCaseId)}><Trash2 className="size-3.5" /></ToolButton>
        </div>
      ))}
      {cases.length === 0 && <p className="rounded-md border border-dashed border-border/60 px-3 py-6 text-center text-xs text-muted-foreground">还没有用例。用「正常 / 缺参数 / 越权」这类用例固定各自的断言，就能一键跑全部并拿到结论。</p>}
      <p className="text-[11px] text-muted-foreground">选中用例后，「断言」页编辑的是该用例的断言；未选中时编辑的是请求自身的默认断言。</p>
    </div>
  )
}

/** 取消标记时删掉字段，避免留下 undefined 键影响脏值比较。 */
function withoutTargetEnvironment(draft: ApiRequestDraft): ApiRequestDraft {
  const next = { ...draft }
  delete next.targetEnvironmentId
  return next
}

/** 超时、重定向与目标环境标记。 */
function RequestSettings({ draft, environments, activeEnvironmentId, onChange }: {
  draft: ApiRequestDraft
  environments: ApiEnvironment[]
  activeEnvironmentId: string | null
  onChange: (draft: ApiRequestDraft) => void
}): React.ReactElement {
  /** 标记的目标环境与当前发送环境，用于展示不一致提示。 */
  const boundKind = environments.find((item) => item.id === draft.targetEnvironmentId)?.kind
  const activeKind = environments.find((item) => item.id === activeEnvironmentId)?.kind
  return (
    <div className="max-w-md space-y-4 text-xs">
      <label className="grid grid-cols-[120px_1fr] items-center gap-3">
        <span>目标环境</span>
        <div className="flex items-center gap-2">
          <Select value={draft.targetEnvironmentId ?? 'none'} onValueChange={(value) => onChange(value === 'none' ? withoutTargetEnvironment(draft) : { ...draft, targetEnvironmentId: value })}>
            <SelectTrigger className="h-8 text-xs" aria-label="目标环境"><SelectValue placeholder="未标记" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="none">未标记</SelectItem>
              {environments.map((item) => <SelectItem key={item.id} value={item.id}>{item.name}（{ENVIRONMENT_KIND_LABEL[item.kind]}）</SelectItem>)}
            </SelectContent>
          </Select>
          {boundKind && <EnvironmentKindBadge kind={boundKind} />}
        </div>
      </label>
      <p className="text-[11px] text-muted-foreground">标记用于区分开发/测试/生产，并在打开接口时作为默认环境；它不改变发送权限，真正发送仍以工具栏当前环境为准。</p>
      {boundKind && activeKind && boundKind !== activeKind && (
        <p className="text-[11px] text-destructive">当前发送环境是「{ENVIRONMENT_KIND_LABEL[activeKind]}」，而该接口标记的是「{ENVIRONMENT_KIND_LABEL[boundKind]}」，发送前请确认目标。</p>
      )}
      <label className="grid grid-cols-[120px_1fr] items-center gap-3"><span>超时（毫秒）</span><Input type="number" min={100} max={300000} value={draft.timeoutMs} onChange={(event) => onChange({ ...draft, timeoutMs: Number(event.target.value) })} className="h-8" /></label>
      <label className="flex items-center justify-between gap-3"><span>跟随重定向（仅同源）</span><Switch checked={draft.followRedirects} onCheckedChange={(followRedirects) => onChange({ ...draft, followRedirects })} /></label>
      <label className="grid grid-cols-[120px_1fr] items-center gap-3"><span>最多重定向</span><Input type="number" min={0} max={10} disabled={!draft.followRedirects} value={draft.maxRedirects} onChange={(event) => onChange({ ...draft, maxRedirects: Number(event.target.value) })} className="h-8" /></label>
      <label className="flex items-center justify-between gap-3">
        <span>自动 Cookie（仅本机内存）</span>
        <Switch checked={draft.useCookieJar === true} onCheckedChange={(useCookieJar) => onChange({ ...draft, useCookieJar })} />
      </label>
      <p className="text-[11px] text-muted-foreground">开启后本次请求会读取并写入本机内存里的 Cookie：默认关闭，避免某条请求因为上次的 cookie 而悄悄成功。取值不落盘、也不进入运行记录；草稿里手写的 Cookie 头始终优先。</p>
    </div>
  )
}

/** 响应与历史区域。 */
function ResponsePanel({ api, sessionId, run, historyRuns, historyOpen, onHistoryOpenChange, onOpenRun, onPinRun, resolveCaseName, onLoadToEditor, onSetBaseline, onCompareBaseline, baselineRunId, historyHasMore = false, onLoadMoreHistory }: {
  api: ApiWorkbenchApi
  sessionId: string
  run: ApiRun | null
  historyRuns: ApiRun[]
  historyOpen: boolean
  onHistoryOpenChange: (open: boolean) => void
  onOpenRun: (runId: string, reveal?: boolean) => void
  onPinRun: (run: ApiRun) => void
  /** 运行所属用例名；未按用例运行时返回 null。 */
  resolveCaseName: (run: ApiRun) => string | null
  /** 把这次运行的真实请求载入成一份新的未保存草稿。 */
  onLoadToEditor: (run: ApiRun) => void
  /** 记录当前显示运行作为对比基线；可选给出随行提示。 */
  onSetBaseline: (run: ApiRun) => void
  /** 与已记录的基线对比当前运行。 */
  onCompareBaseline: (run: ApiRun) => void
  /** 当前基线运行身份；为空表示还没设过基线。 */
  baselineRunId: string | null
  historyHasMore?: boolean
  onLoadMoreHistory?: () => void
}): React.ReactElement {
  /** 已按页读取的正文。 */
  const [bodyPage, setBodyPage] = React.useState<ApiWorkbenchBodyPage | null>(null)
  /** 正文展示模式。 */
  const [formatted, setFormatted] = React.useState(true)
  /** 正文读取状态。 */
  const [loadingBody, setLoadingBody] = React.useState(false)
  /** 当前正文是否由用户显式 reveal。 */
  const [revealed, setRevealed] = React.useState(false)
  /** 用户显式读取的完整原始运行，仅在当前 run 生命周期内保留。 */
  const [revealedRun, setRevealedRun] = React.useState<ApiRun | null>(null)
  /** 当前响应详情分区。 */
  const [section, setSection] = React.useState<'overview' | 'body' | 'request' | 'headers' | 'timings' | 'tls' | 'assertions' | 'events' | 'extract'>('overview')
  /** 正文或原文读取错误。 */
  const [responseError, setResponseError] = React.useState<string | null>(null)
  /** 当前运行身份用于丢弃切换后的迟到原文。 */
  const currentRunId = React.useRef<string | null>(run?.id ?? null)
  currentRunId.current = run?.id ?? null
  React.useEffect(() => {
    setBodyPage(run ? { text: run.body.preview, startOffset: 0, nextOffset: run.body.previewTruncated ? run.body.preview.length : null, totalChars: run.body.preview.length, truncated: run.body.previewTruncated } : null)
    setRevealed(false)
    setRevealedRun(null)
    setSection('overview')
    setResponseError(null)
  }, [run?.id, run?.body.preview, run?.body.previewTruncated])
  /** 展示显式 reveal 的完整事实，否则使用默认脱敏运行。 */
  const displayedRun = revealedRun ?? run
  /** 实时事件增量与运行记录共用同一原子，切换运行时整体替换。 */
  const liveStream = useAtomValue(apiWorkbenchLiveStreamAtom)
  /** 当前展示运行对应的实时事件增量；没有展示其它运行时也允许只看流。 */
  const liveEvents = liveStream && (displayedRun === null || liveStream.runId === displayedRun.id) ? liveStream.events : []
  /** 按下一页 offset 读取正文，默认保持脱敏。 */
  const loadNextPage = async (): Promise<void> => {
    if (!run || bodyPage?.nextOffset === null || loadingBody) return
    /** 发起读取时固定运行身份。 */
    const requestedRunId = run.id
    setLoadingBody(true)
    setResponseError(null)
    try {
      /** IPC 返回的下一页正文。 */
      const slice = await api.readBody({ sessionId, runId: requestedRunId, offset: bodyPage?.nextOffset ?? 0, reveal: revealed })
      if (currentRunId.current !== requestedRunId) return
      setBodyPage((current) => appendBodySlice(current, slice))
    } catch (error) {
      if (currentRunId.current === requestedRunId) setResponseError(errorMessage(error, '读取响应正文失败'))
    } finally {
      if (currentRunId.current === requestedRunId) setLoadingBody(false)
    }
  }
  /** 本地 UI 显式请求原始运行和正文首页。 */
  const revealOriginal = async (): Promise<void> => {
    if (!run) return
    /** 发起 reveal 时固定运行身份。 */
    const requestedRunId = run.id
    setLoadingBody(true)
    setResponseError(null)
    try {
      /** 原始运行包含请求、Header、跳转与连接事实。 */
      const originalRun = await api.getRun({ sessionId, runId: requestedRunId, reveal: true })
      /** 原始正文第一页仍走分页接口，避免一次载入大响应。 */
      const slice = await api.readBody({ sessionId, runId: requestedRunId, offset: 0, reveal: true })
      if (currentRunId.current !== requestedRunId || originalRun.id !== requestedRunId) return
      setBodyPage(appendBodySlice(null, slice))
      setRevealedRun(originalRun)
      setRevealed(true)
    } catch (error) {
      if (currentRunId.current === requestedRunId) setResponseError(errorMessage(error, '读取本地原始内容失败'))
    } finally {
      if (currentRunId.current === requestedRunId) setLoadingBody(false)
    }
  }
  if (historyOpen) return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-border/50 px-3"><span className="text-xs font-semibold">历史</span><Button type="button" variant="ghost" size="sm" className="h-7" onClick={() => onHistoryOpenChange(false)}>返回响应</Button></div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {historyRuns.length === 0 ? <div className="py-10 text-center text-xs text-muted-foreground">暂无运行记录</div> : historyRuns.map((item) => (
          <div key={item.id} className="mb-1 flex items-center rounded-md hover:bg-muted/50">
            <button type="button" className="flex min-w-0 flex-1 items-center gap-3 px-2.5 py-2 text-left" onClick={() => onOpenRun(item.id)} aria-label={`打开运行 ${item.requestName}`}>
              <span className="w-14 shrink-0 font-mono text-[10px] font-semibold">{item.request.method}</span>
              <span className="min-w-0 flex-1 truncate text-xs">{item.requestName}</span>
              {item.caseId && <span className="shrink-0 text-[10px] text-muted-foreground">用例 {resolveCaseName(item)}</span>}
              <span className="text-[10px] text-muted-foreground">{item.hops.at(-1)?.status ?? item.state}</span>
            </button>
            <button type="button" className="mr-2 rounded p-1 hover:bg-muted" onClick={() => onPinRun(item)} aria-label={item.pinned ? '取消收藏' : '收藏运行'}><ShieldCheck className={cn('size-3.5', item.pinned && 'text-primary')} /></button>
          </div>
        ))}
        {historyHasMore && <Button type="button" variant="ghost" size="sm" className="mt-2 w-full" onClick={onLoadMoreHistory}>加载更多</Button>}
      </div>
    </div>
  )
  /** 运行头部尚未到达时，流式事件仍然直接可见，避免长连接期间界面空白。 */
  if (!displayedRun) {
    if (liveEvents.length === 0) return <div className="flex min-h-0 flex-1 items-center justify-center text-xs text-muted-foreground">发送请求或从历史中选择一次运行</div>
    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border/50 px-3 text-xs"><Badge variant="secondary">事件流</Badge><span>实时接收中</span></div>
        <div className="min-h-0 flex-1 overflow-y-auto p-3 text-xs"><StreamEventList stream={undefined} events={liveEvents} live /></div>
      </div>
    )
  }
  /** 最后一次 HTTP 跳转。 */
  const finalHop = displayedRun.hops.at(-1)
  /** 断言统计。 */
  const assertionPassed = displayedRun.assertions.filter((item) => item.passed).length
  /** 本次运行所属用例名；未按用例运行时为空。 */
  const caseName = resolveCaseName(displayedRun)
  /** 当前正文格式化结果。 */
  const formattedBody = formatApiResponseBody(bodyPage?.text ?? displayedRun.body.preview, displayedRun.body.contentType)
  /** 响应详情的稳定分区。 */
  /** 事件分区只在存在流式事实时出现。 */
  const sections = [
    ['overview', '概览'], ['body', '正文'], ['request', '请求'], ['headers', 'Headers'],
    ['timings', 'Timing'], ['tls', 'TLS'], ['assertions', '断言'],
    ...(displayedRun.sse || liveEvents.length > 0 ? [['events', '事件'] as const] : []),
    ...(displayedRun.extracted && displayedRun.extracted.length > 0 ? [['extract', '提取'] as const] : []),
  ] as const
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border/50 px-3 text-xs">
        <Badge variant={displayedRun.state === 'completed' ? 'secondary' : 'destructive'}>{finalHop?.status ?? displayedRun.state}</Badge>
        <span>{finalHop ? `${finalHop.timings.totalMs} ms` : '耗时不适用'}</span>
        <span>{displayedRun.body.rawBytes.toLocaleString()} B</span>
        {displayedRun.assertions.length === 0
          ? <span className="text-muted-foreground">{caseName ? `用例 ${caseName} · 未验证` : '未验证'}</span>
          : <span className={cn('font-medium', assertionPassed !== displayedRun.assertions.length ? 'text-destructive' : 'text-emerald-600 dark:text-emerald-400')}>{caseName ? `用例 ${caseName} · ` : ''}断言 {assertionPassed}/{displayedRun.assertions.length}</span>}
        <span className="ml-auto text-[10px] text-muted-foreground">{revealed ? '本地原始内容' : '默认脱敏'}</span>
        {!revealed && displayedRun.recording !== 'failed' && <ToolButton label="查看本地原始内容" onClick={revealOriginal}><Eye className="size-3.5" /></ToolButton>}
        <ToolButton label="运行历史" onClick={() => onHistoryOpenChange(true)}><History className="size-3.5" /></ToolButton>
        {displayedRun.requestId && <ToolButton label="用当前定义重发" onClick={() => { dispatchResendApiRun(displayedRun, sessionId) }}><Play className="size-3.5" /></ToolButton>}
        <ToolButton label="载入编辑器" onClick={() => onLoadToEditor(displayedRun)}><FileInput className="size-3.5" /></ToolButton>
        <ToolButton label="设为对比基线" onClick={() => onSetBaseline(displayedRun)} disabled={baselineRunId === displayedRun.id}><GitCompare className="size-3.5" /></ToolButton>
        <ToolButton label="与基线对比" onClick={() => onCompareBaseline(displayedRun)} disabled={baselineRunId === null || baselineRunId === displayedRun.id}><GitCompareArrows className="size-3.5" /></ToolButton>
      </div>
      <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-border/50 px-3 scrollbar-none">
        {sections.map(([id, label]) => <button key={id} type="button" className={cn('h-8 shrink-0 border-b-2 px-2 text-xs', section === id ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground')} onClick={() => setSection(id)}>{label}</button>)}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3 text-xs">
        {responseError && <div className="mb-3 rounded-md bg-destructive/10 p-2 text-destructive">{responseError}</div>}
        {displayedRun.error && <div className="mb-3 rounded-md bg-destructive/10 p-2 text-destructive"><strong>{displayedRun.error.phase}</strong> · {displayedRun.error.code}<div>{displayedRun.error.message}</div></div>}
        {section === 'overview' && <div className="grid gap-2 sm:grid-cols-2"><div>状态：{displayedRun.state}</div><div>记录：{displayedRun.recording === 'saved' ? '已保存，可读取完整正文' : displayedRun.recording === 'memory-only' ? '仅保留内存预览；本次运行期间可尝试读取原始内容' : '记录失败，仅显示当前预览，原始内容不可用'}</div><div>创建：{new Date(displayedRun.createdAt).toLocaleString()}</div><div>完成：{displayedRun.finishedAt ? new Date(displayedRun.finishedAt).toLocaleString() : '不适用'}</div><div>原始字节：{displayedRun.body.rawBytes}</div><div>解码字节：{displayedRun.body.decodedBytes}</div></div>}
        {section === 'body' && <section>
          <div className="mb-1.5 flex items-center"><h4 className="font-semibold">Body</h4><div className="ml-auto flex rounded-md bg-muted p-0.5"><button type="button" className={cn('rounded px-2 py-1 text-[10px]', !formatted && 'bg-background shadow-sm')} onClick={() => setFormatted(false)}>原文</button><button type="button" className={cn('rounded px-2 py-1 text-[10px]', formatted && 'bg-background shadow-sm')} onClick={() => setFormatted(true)}>格式化</button></div></div>
          <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border/50 bg-muted/20 p-3 font-mono text-[11px] leading-5">{formatted && formattedBody.valid ? formattedBody.formatted : bodyPage?.text ?? displayedRun.body.preview}</pre>
          <div className="mt-1 flex items-center justify-between text-[10px] text-muted-foreground"><span>字符范围 {bodyPage?.startOffset ?? 0}–{(bodyPage?.text.length ?? 0) + (bodyPage?.startOffset ?? 0)} / {bodyPage?.totalChars ?? displayedRun.body.preview.length}</span>{(bodyPage?.nextOffset ?? null) !== null && <Button type="button" variant="ghost" size="sm" className="h-7" disabled={loadingBody} onClick={loadNextPage}>读取下一页</Button>}</div>
        </section>}
        {section === 'request' && <div className="space-y-2"><div className="font-mono font-semibold">{displayedRun.request.method} {displayedRun.request.url}</div><HeaderList headers={displayedRun.request.headers} /><pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border/50 p-3 font-mono text-[11px]">{displayedRun.request.body || '无请求正文'}</pre></div>}
        {section === 'headers' && displayedRun.hops.map((hop, index) => <details key={`${hop.url}-${index}`} className="mb-2 rounded-md border border-border/50 p-2" open={index === displayedRun.hops.length - 1}><summary>跳转 {index + 1} · HTTP/{hop.httpVersion} · {hop.status}</summary><div className="mt-2 space-y-2"><div>请求 Headers（{hop.requestHeadersSource}）</div><HeaderList headers={hop.requestHeaders} /><div>响应 Headers</div><HeaderList headers={hop.responseHeaders} /><div>Trailers</div><HeaderList headers={hop.trailers} /></div></details>)}
        {section === 'timings' && displayedRun.hops.map((hop, index) => <div key={`${hop.url}-${index}`} className="mb-2 rounded-md border border-border/50 p-2"><div className="font-medium">跳转 {index + 1} · HTTP/{hop.httpVersion}</div><div className="mt-2 grid gap-1 text-muted-foreground sm:grid-cols-2"><span>DNS {hop.timings.dnsMs ?? '不适用'} ms</span><span>Connect {hop.timings.connectMs ?? '不适用'} ms</span><span>TLS {hop.timings.tlsMs ?? '不适用'} ms</span><span>Send {hop.timings.sendMs ?? '不适用'} ms</span><span>TTFB {hop.timings.ttfbMs ?? '不适用'} ms</span><span>Download {hop.timings.downloadMs ?? '不适用'} ms</span><span>Total {hop.timings.totalMs} ms</span><span>连接 {hop.connection.reused ? '复用' : '新建'}</span><span>本地 {hop.connection.localAddress ?? '不适用'}:{hop.connection.localPort ?? '不适用'}</span><span>远端 {hop.connection.remoteAddress ?? '不适用'}:{hop.connection.remotePort ?? '不适用'}</span></div></div>)}
        {section === 'tls' && <div className="space-y-2">{displayedRun.hops.map((hop, index) => <div key={`${hop.url}-${index}`} className="rounded-md border border-border/50 p-2">{hop.connection.tls ? <><div>TLS {hop.connection.tls.protocol} · {hop.connection.tls.cipher}</div><div>{hop.connection.tls.authorized ? '证书已验证' : hop.connection.tls.authorizationError || '证书未验证'}</div><div>{hop.connection.tls.subject} → {hop.connection.tls.issuer}</div><div>有效期 {hop.connection.tls.validFrom} 至 {hop.connection.tls.validTo}</div></> : '该跳转没有 TLS 信息'}</div>)}</div>}
        {section === 'assertions' && (displayedRun.assertions.length === 0 ? <div className="text-muted-foreground">没有声明式断言</div> : displayedRun.assertions.map((item) => <div key={item.id} className={cn('flex gap-2 py-1', item.passed ? 'text-emerald-600 dark:text-emerald-400' : 'text-destructive')}>{item.passed ? <Check className="size-3.5" /> : <X className="size-3.5" />}<span>{item.message || `${item.actual} / ${item.expected}`}</span></div>))}
        {section === 'events' && <StreamEventList stream={displayedRun.sse} events={liveEvents.length > 0 ? liveEvents : displayedRun.sse?.events ?? []} live={liveEvents.length > 0} />}
        {section === 'extract' && displayedRun.extracted?.map((item) => (
          <div key={item.id} className="py-1">
            <span className={cn('font-mono', item.found ? 'text-emerald-600 dark:text-emerald-400' : 'text-destructive')}>{item.name}</span>
            <span className="ml-2 text-muted-foreground">{item.found ? '已写入运行时变量' : item.message ?? '未命中'}{item.secret ? ' · 按秘密处理' : ''}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

/** 用例报告弹窗：表格结论与复制出的 Markdown 同源，避免两处判断漂移。 */
function CaseReportDialog({ batch, onOpenChange, onCopy, onOpenRun, onCancel }: {
  batch: ApiWorkbenchCaseBatch | null
  onOpenChange: (open: boolean) => void
  onCopy: () => void
  onOpenRun: (runId: string) => void
  onCancel: () => void
}): React.ReactElement {
  /** 当前报告行；批量运行中会持续追加。 */
  const rows = batch?.rows ?? []
  /** 只统计已执行且带断言的用例，与导出报告的通过率口径一致。 */
  const executed = rows.filter((row) => row.runId !== undefined && row.assertionsTotal > 0)
  /** 通过数取自与表格相同的结论函数。 */
  const passed = executed.filter((row) => formatApiCaseReportCells(row).verdict === '通过').length
  /** 表头与数据行共用同一列宽，避免窄窗口下错位。 */
  const columns = 'grid-cols-[minmax(110px,1.2fr)_56px_64px_64px_64px_80px_minmax(80px,1.1fr)_88px]'
  return (
    <Dialog open={batch !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>用例报告</DialogTitle>
          <DialogDescription>
            {batch === null ? '' : `${batch.meta.method} ${batch.meta.url} · ${executed.length === 0 ? '尚未执行' : `${passed}/${executed.length} 通过`}${batch.running ? ' · 正在跑剩余用例' : ''}`}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1 text-xs">
          <div className={cn('grid items-center gap-2 px-2 text-[10px] text-muted-foreground', columns)}>
            <span>用例</span><span>来源</span><span>结果</span><span>状态码</span><span>断言</span><span>耗时</span><span>备注</span><span />
          </div>
          {rows.map((row) => {
            /** 与复制报告同源的单元格文本。 */
            const cells = formatApiCaseReportCells(row)
            /** 该行对应的运行身份；未执行时为空。 */
            const runId = row.runId
            return (
              <div key={row.caseId ?? row.caseName} className={cn('grid items-center gap-2 rounded-md border border-border/50 px-2 py-1.5', columns)}>
                <span className="truncate" title={cells.caseName}>{cells.caseName}</span>
                <span className={cn(cells.source === 'Agent' ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground')}>{cells.source}</span>
                <span className={cn(cells.verdict === '通过' ? 'text-emerald-600 dark:text-emerald-400' : cells.verdict === '失败' ? 'text-destructive' : 'text-muted-foreground')}>{cells.verdict}</span>
                <span>{cells.status}</span>
                <span>{cells.assertions}</span>
                <span>{cells.duration}</span>
                <span className="truncate text-muted-foreground" title={cells.remark}>{cells.remark || '—'}</span>
                {runId
                  ? <Button type="button" variant="ghost" size="sm" className="h-6 px-2 text-[11px]" onClick={() => onOpenRun(runId)}>打开运行</Button>
                  : <span className="text-[10px] text-muted-foreground">无运行</span>}
              </div>
            )
          })}
          {rows.length === 0 && <p className="py-6 text-center text-muted-foreground">正在准备第一个用例…</p>}
        </div>
        <DialogFooter className="items-center">
          {batch?.running && <Button type="button" variant="destructive" className="mr-auto" onClick={onCancel}>取消剩余用例</Button>}
          <Button type="button" variant="outline" disabled={rows.length === 0} onClick={onCopy}>复制报告</Button>
          <Button type="button" disabled={batch?.running} title={batch?.running ? '跑完之后再关闭，避免看不到中途结果' : undefined} onClick={() => onOpenChange(false)}>关闭</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** 运行对比面板：两次运行的差异事实，两侧都是脱敏投影。 */
function RunDiffDialog({ open, diff, baselineLabel, candidateLabel, onOpenChange }: {
  open: boolean
  diff: ApiRunDiff | null
  baselineLabel: string
  candidateLabel: string
  onOpenChange: (open: boolean) => void
}): React.ReactElement {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>运行对比</DialogTitle>
          <DialogDescription>
            基线：{baselineLabel} · 对比：{candidateLabel}。两侧都是脱敏投影，被遮罩的秘密不会出现在差异里。
          </DialogDescription>
        </DialogHeader>
        {diff === null ? <p className="text-xs text-muted-foreground">正在读取两次运行…</p> : (
          <div className="space-y-3 text-xs">
            <p className={cn('font-medium', diff.identical ? 'text-emerald-600 dark:text-emerald-400' : 'text-foreground')}>
              {diff.identical ? '两次运行一致' : `共 ${diff.rows.filter((row) => row.changed).length} 个字段、${diff.headers.length} 个响应头、${diff.assertions.length} 条断言有变化`}
            </p>
            <div className="space-y-1">
              {diff.rows.map((row) => (
                <div key={row.label} className={cn('grid grid-cols-[110px_minmax(0,1fr)_minmax(0,1fr)] items-start gap-2 rounded-md border border-border/50 px-2 py-1', row.changed && 'border-amber-500/40 bg-amber-500/5')}>
                  <span className="text-muted-foreground">{row.label}</span>
                  <span className="break-all font-mono">{row.baseline}</span>
                  <span className="break-all font-mono">{row.candidate}</span>
                </div>
              ))}
            </div>
            {diff.headers.length > 0 && (
              <section className="space-y-1">
                <h4 className="font-semibold">响应头差异</h4>
                {diff.headers.map((header) => (
                  <div key={header.name} className="grid grid-cols-[110px_minmax(0,1fr)_minmax(0,1fr)] items-start gap-2 rounded-md border border-border/50 px-2 py-1">
                    <span className="text-muted-foreground">{header.name} · {header.change === 'added' ? '新增' : header.change === 'removed' ? '删除' : '变化'}</span>
                    <span className="break-all font-mono">{header.baseline}</span>
                    <span className="break-all font-mono">{header.candidate}</span>
                  </div>
                ))}
              </section>
            )}
            {diff.assertions.length > 0 && (
              <section className="space-y-1">
                <h4 className="font-semibold">断言结论变化</h4>
                {diff.assertions.map((assertion) => (
                  <div key={assertion.id} className="flex items-center gap-2 rounded-md border border-border/50 px-2 py-1">
                    <span className="font-mono">{assertion.id}</span>
                    <span className="text-muted-foreground">{assertion.baseline} → {assertion.candidate}</span>
                  </div>
                ))}
              </section>
            )}
            <section className="space-y-1">
              <h4 className="font-semibold">正文</h4>
              {!diff.body.compared
                ? <p className="text-muted-foreground">{diff.body.reason}</p>
                : diff.body.lines.length === 0
                  ? <p className="text-muted-foreground">正文相同</p>
                  : (
                    <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border/50 bg-muted/20 p-2 font-mono text-[11px] leading-5">
                      {diff.body.lines.map((line, index) => (
                        <div key={index} className={line.kind === 'added' ? 'text-emerald-600 dark:text-emerald-400' : 'text-destructive'}>{line.kind === 'added' ? '+' : '-'}{line.text}</div>
                      ))}
                    </pre>
                  )}
              {diff.body.truncated && <p className="text-muted-foreground">变化行超过展示上限，只显示前 200 行。</p>}
            </section>
          </div>
        )}
        <DialogFooter><Button type="button" onClick={() => onOpenChange(false)}>关闭</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Cookie 面板：只展示元数据，取值既不显示也不导出。 */
function CookieJarDialog({ open, cookies, onOpenChange, onRefresh, onClear }: {
  open: boolean
  cookies: ApiCookieJarEntry[]
  onOpenChange: (open: boolean) => void
  onRefresh: () => void
  onClear: () => void
}): React.ReactElement {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[80vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Cookie</DialogTitle>
          <DialogDescription>只有开启「自动 Cookie」的请求才会读写这里：按项目隔离、只存在本机内存（重启即失效）、不写入运行记录。取值不展示也无法导出。</DialogDescription>
        </DialogHeader>
        {cookies.length === 0
          ? <p className="text-xs text-muted-foreground">还没有 cookie。在有会话的接口上开启「自动 Cookie」并发送一次即可。</p>
          : (
            <div className="space-y-1 text-xs">
              {cookies.map((cookie) => (
                <div key={`${cookie.domain}${cookie.path}${cookie.name}`} className="flex items-center gap-2 rounded-md border border-border/50 px-2 py-1.5">
                  <span className="font-mono">{cookie.name}</span>
                  {cookie.httpOnly && <Badge variant="secondary">HttpOnly</Badge>}
                  {cookie.secure && <Badge variant="secondary">Secure</Badge>}
                  <span className="min-w-0 flex-1 truncate text-muted-foreground" title={`${cookie.domain}${cookie.path}`}>{cookie.domain}{cookie.path}</span>
                  <span className="shrink-0 text-muted-foreground">{formatCookieExpiry(cookie.expiresAt)}</span>
                </div>
              ))}
            </div>
          )}
        <DialogFooter className="items-center">
          <Button type="button" variant="destructive" className="mr-auto" disabled={cookies.length === 0} onClick={onClear}>清空</Button>
          <Button type="button" variant="outline" onClick={onRefresh}>刷新</Button>
          <Button type="button" onClick={() => onOpenChange(false)}>关闭</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** 运行时变量面板：只展示元数据，取值永不出主进程。 */
function RuntimeVariablesDialog({ open, variables, onOpenChange, onRefresh, onClear }: {
  open: boolean
  variables: ApiRuntimeVariable[]
  onOpenChange: (open: boolean) => void
  onRefresh: () => void
  onClear: () => void
}): React.ReactElement {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[80vh] max-w-xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>运行时变量</DialogTitle>
          <DialogDescription>提取出的值只存在本次应用会话的内存里：按 workspace 隔离、1 小时后过期、重启即失效，也不会写进运行记录。</DialogDescription>
        </DialogHeader>
        {variables.length === 0
          ? <p className="text-xs text-muted-foreground">还没有提取到变量。在请求的「提取」页声明规则后发送，命中即会出现在这里。</p>
          : (
            <div className="space-y-1 text-xs">
              {variables.map((item) => (
                <div key={item.name} className="flex items-center gap-2 rounded-md border border-border/50 px-2 py-1.5">
                  <span className="font-mono">{item.name}</span>
                  {item.secret && <Badge variant="secondary">秘密</Badge>}
                  <span className="min-w-0 flex-1 truncate text-muted-foreground">{item.source}</span>
                  <span className="shrink-0 text-muted-foreground">{new Date(item.updatedAt).toLocaleTimeString()}</span>
                </div>
              ))}
            </div>
          )}
        <DialogFooter className="items-center">
          <Button type="button" variant="destructive" className="mr-auto" disabled={variables.length === 0} onClick={onClear}>清空</Button>
          <Button type="button" variant="outline" onClick={onRefresh}>刷新</Button>
          <Button type="button" onClick={() => onOpenChange(false)}>关闭</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** 事件流分区：先给计数事实，再逐帧展开可核对的原始片段。 */
function StreamEventList({ stream, events, live }: { stream: ApiRun['sse']; events: ApiSseEvent[]; live: boolean }): React.ReactElement {
  return (
    <div className="space-y-2">
      <div className="grid gap-1 text-muted-foreground sm:grid-cols-2">
        <span>{live ? `实时接收中 · 已收到 ${events.length} 条` : `事件总数 ${stream?.totalEvents ?? 0}`}</span>
        <span>首事件 {stream?.firstEventMs === null || stream?.firstEventMs === undefined ? '不适用' : `${stream.firstEventMs} ms`}</span>
        <span>结束 {stream === undefined ? '接收中' : stream.endedReason === 'completed' ? '正常结束' : stream.endedReason === 'cancelled' ? '已取消' : '读取中断'}</span>
        <span>保留 {events.length}{stream && stream.droppedEvents > 0 ? ` · 超出上限 ${stream.droppedEvents}` : ''}</span>
      </div>
      {events.length === 0
        ? <div className="text-muted-foreground">尚未收到事件</div>
        : events.map((event) => (
          <details key={event.index} className="rounded-md border border-border/50 p-2">
            <summary className="cursor-pointer text-[11px]">
              {event.index + 1}. +{event.receivedMs} ms
              {event.event ? ` · ${event.event}` : ''}
              {event.id ? ` · id=${event.id}` : ''}
              {event.comment ? ' · 心跳' : ''}
              {event.truncated ? ' · 已截断' : ''}
            </summary>
            {event.comment && <div className="mt-1 text-muted-foreground">注释：{event.comment}</div>}
            {event.retry !== undefined && <div className="text-muted-foreground">重连建议：{event.retry} ms</div>}
            <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px]">{event.data || '（无 data 字段）'}</pre>
            <details className="mt-1">
              <summary className="cursor-pointer text-muted-foreground">原始片段</summary>
              <pre className="mt-1 overflow-auto whitespace-pre-wrap break-words font-mono text-[10px] text-muted-foreground">{event.raw}</pre>
            </details>
          </details>
        ))}
    </div>
  )
}

/** 保留重复项和原始顺序的 Header 列表。 */
function HeaderList({ headers }: { headers: Array<{ name: string; value: string }> }): React.ReactElement {
  return <div className="font-mono">{headers.length === 0 ? <span>无</span> : headers.map((header, index) => <div key={`${header.name}-${index}`} className="grid grid-cols-[minmax(80px,0.35fr)_1fr] gap-2"><span className="break-all">{header.name}</span><span className="break-all">{header.value}</span></div>)}</div>
}

/** 环境及普通/秘密变量编辑弹窗。 */
function EnvironmentDialog({ open, environment, onOpenChange, onSave, onDelete }: { open: boolean; environment: ApiEnvironment | null; onOpenChange: (open: boolean) => void; onSave: (environment: ApiEnvironment) => void; onDelete: (environment: ApiEnvironment) => void }): React.ReactElement {
  /** 弹窗内独立草稿，取消时不污染目录状态。 */
  const [draft, setDraft] = React.useState<ApiEnvironment | null>(environment)
  React.useEffect(() => setDraft(environment), [environment, open])
  if (!draft) return <></>
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[80vh] max-w-2xl overflow-y-auto">
        <DialogHeader><DialogTitle>环境变量</DialogTitle><DialogDescription>秘密值保存后只显示引用。留空不会清除，需使用行内清除按钮。</DialogDescription></DialogHeader>
        <div className="grid grid-cols-[1fr_160px] gap-2"><Input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="环境名称" /><Select value={draft.kind} onValueChange={(kind) => setDraft({ ...draft, kind: kind as ApiEnvironment['kind'] })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="local">本地</SelectItem><SelectItem value="test">测试</SelectItem><SelectItem value="production">生产</SelectItem></SelectContent></Select></div>
        <FieldRows rows={draft.variables} allowSecrets onChange={(variables) => setDraft({ ...draft, variables })} namePlaceholder="变量名" />
        <DialogFooter className="items-center"><Button type="button" variant="destructive" className="mr-auto" onClick={() => onDelete(draft)}>删除环境</Button><Button type="button" variant="outline" onClick={() => onOpenChange(false)}>取消</Button><Button type="button" onClick={() => onSave(draft)}>保存环境</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** 接口工作台阶段 A 主视图。 */
function ApiWorkbenchSession({ sessionId, uiScope, workspaceLabel }: { sessionId: string; uiScope: string; workspaceLabel?: string }): React.ReactElement {
  /** 当前 preload 能力。 */
  const api = React.useMemo(() => getApiWorkbenchApi(), [])
  /** 目录快照。 */
  const [catalog, setCatalog] = React.useState<ApiCatalog | null>(null)
  /** 初始化或目录写入错误。 */
  const [loadError, setLoadError] = React.useState<string | null>(null)
  /** 当前会话编辑状态。 */
  const [view, setView] = useAtom(apiWorkbenchSessionStateAtomFamily(uiScope))
  /** Agent 卡片请求定位的运行目标。 */
  const openRunTarget = useAtomValue(apiWorkbenchOpenRunTargetAtom)
  const setOpenRunTarget = useSetAtom(apiWorkbenchOpenRunTargetAtom)
  /** 最近运行列表。 */
  const [historyRuns, setHistoryRuns] = React.useState<ApiRun[]>([])
  /** 下一页历史游标，null 表示已加载完。 */
  const [historyNextCursor, setHistoryNextCursor] = React.useState<number | null>(null)
  /** 容器宽度，用于窄 Pane 布局。 */
  const [width, setWidth] = React.useState(900)
  /** 窄 Pane 目录抽屉。 */
  const [catalogDrawerOpen, setCatalogDrawerOpen] = React.useState(false)
  /** 窄 Pane 主区域。 */
  const [compactView, setCompactView] = React.useState<CompactView>('request')
  /** 环境编辑弹窗。 */
  const [environmentDialogOpen, setEnvironmentDialogOpen] = React.useState(false)
  /** 环境弹窗草稿身份。 */
  const [editingEnvironment, setEditingEnvironment] = React.useState<ApiEnvironment | null>(null)
  /** 当前集合或文件夹命名操作。 */
  const [catalogNameAction, setCatalogNameAction] = React.useState<CatalogNameAction | null>(null)
  /** 导入对话框开关。 */
  const [importOpen, setImportOpen] = React.useState(false)
  /** 一次性操作反馈，与错误提示分开显示。 */
  const [notice, setNotice] = React.useState<string | null>(null)
  /** 正在接收的流式事件：与响应面板共用同一原子，终态后交还运行记录。 */
  const [liveStream, setLiveStream] = useAtom(apiWorkbenchLiveStreamAtom)
  /** 运行时变量面板开关与元数据列表。 */
  const [runtimeOpen, setRuntimeOpen] = React.useState(false)
  const [runtimeVariables, setRuntimeVariables] = React.useState<ApiRuntimeVariable[]>([])
  /** Cookie 面板开关与元数据列表；取值不在这条通道上。 */
  const [cookieOpen, setCookieOpen] = React.useState(false)
  const [cookies, setCookies] = React.useState<ApiCookieJarEntry[]>([])
  /** 运行对比：基线身份与标签，以及本次对比结果。 */
  const [baselineRun, setBaselineRun] = React.useState<{ id: string; label: string } | null>(null)
  const [runDiff, setRunDiff] = React.useState<{ diff: ApiRunDiff; baselineLabel: string; candidateLabel: string } | null>(null)
  const [runDiffOpen, setRunDiffOpen] = React.useState(false)
  /** 一次「跑全部用例」的报告状态；关闭弹窗即清空，不写入目录。 */
  const [caseBatch, setCaseBatch] = React.useState<ApiWorkbenchCaseBatch | null>(null)
  /** 批量用例代次；取消后置空，后续用例不再派发。 */
  const caseBatchTokenRef = React.useRef<symbol | null>(null)
  /** 控制器最近一次投递的错误文案，供批量运行标注失败用例。 */
  const lastExecutionErrorRef = React.useRef(new Map<string, string | undefined>())
  /** 根容器引用。 */
  const rootRef = React.useRef<HTMLDivElement>(null)
  /** 当前请求标签。 */
  const activeTab = view.tabs.find((tab) => tab.id === view.activeTabId) ?? null
  /** 当前展示的运行。 */
  const activeRun = view.selectedRun ?? activeTab?.run ?? null
  /** 是否使用紧凑布局。 */
  const compact = width < 720

  /** 更新指定请求标签，迟到结果不会覆盖当前其它标签。 */
  const updateTab = React.useCallback((tabId: string, update: (tab: ApiWorkbenchRequestTab) => ApiWorkbenchRequestTab): void => {
    setView((previous) => ({ ...previous, tabs: previous.tabs.map((tab) => tab.id === tabId ? update(tab) : tab) }))
  }, [setView])
  /** 请求执行控制器固定原标签身份。 */
  const controller = React.useMemo(() => api ? createApiWorkbenchController(api, sessionId, (tabId, patch) => {
    /** 批量运行在 send 返回 null 时读取这里的原因，不额外扩展控制器接口。 */
    lastExecutionErrorRef.current.set(tabId, patch.error)
    updateTab(tabId, (tab) => ({ ...tab, ...patch }))
    if (patch.run) setView((previous) => ({ ...previous, selectedRun: previous.activeTabId === tabId ? patch.run ?? null : previous.selectedRun }))
  }) : null, [api, sessionId, setView, updateTab])

  /** 刷新运行历史。 */
  const refreshHistory = React.useCallback(async (): Promise<void> => {
    if (!api) return
    /** 最新一页运行。 */
    const result = await api.listRuns({ sessionId, limit: 50 })
    setHistoryRuns(result.runs)
    setHistoryNextCursor(result.nextCursor)
  }, [api, sessionId])

  /** 追加下一页历史并按运行身份去重。 */
  const loadMoreHistory = React.useCallback(async (): Promise<void> => {
    if (!api || historyNextCursor === null) return
    try {
      /** Host 返回的下一页历史。 */
      const result = await api.listRuns({ sessionId, cursor: historyNextCursor, limit: 50 })
      setHistoryRuns((previous) => [...previous, ...result.runs.filter((run) => !previous.some((item) => item.id === run.id))])
      setHistoryNextCursor(result.nextCursor)
    } catch (error) {
      setLoadError(errorMessage(error, '加载更多运行历史失败'))
    }
  }, [api, historyNextCursor, sessionId])

  React.useEffect(() => {
    /** 工作台根节点。 */
    const element = rootRef.current
    if (!element) return
    /** 发布真实 Pane 宽度。 */
    const publish = (): void => setWidth(Math.round(element.getBoundingClientRect().width))
    publish()
    /** 监听 SidePanel 或 split 比例变化。 */
    const observer = new ResizeObserver(publish)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  React.useEffect(() => {
    if (!api) { setLoadError('接口工作台尚未就绪，请重启应用后重试'); return }
    let disposed = false
    void Promise.all([api.getCatalog({ sessionId }), api.listRuns({ sessionId, limit: 50 })])
      .then(([nextCatalog, runs]) => {
        if (disposed) return
        setCatalog(nextCatalog)
        setHistoryRuns(runs.runs)
        setHistoryNextCursor(runs.nextCursor)
        setView((previous) => ({ ...previous, environmentId: sanitizeApiEnvironmentId(previous.environmentId, nextCatalog.environments) }))
      })
      .catch((error: unknown) => { if (!disposed) setLoadError(errorMessage(error, '加载接口目录失败')) })
    /** 运行变化只刷新当前会话；正文继续按需读取。 */
    const unsubscribe = api.onChanged((event) => {
      if (event.sessionId !== sessionId) return
      void refreshHistory()
      setView((previous) => {
        if (previous.selectedRun?.id !== event.runId) return previous
        void api.getRun({ sessionId, runId: event.runId }).then((run) => setView((current) => current.selectedRun?.id === run.id ? { ...current, selectedRun: run } : current))
        return previous
      })
    })
    return () => { disposed = true; unsubscribe() }
  }, [api, refreshHistory, sessionId, setView])

  React.useEffect(() => {
    if (!api || openRunTarget?.sessionId !== sessionId) return
    /** 只读取目标运行，历史点击和结果卡定位都不会自动发送。 */
    void api.getRun({ sessionId, runId: openRunTarget.runId })
      .then((run) => setView((previous) => ({ ...previous, selectedRun: run, historyOpen: false })))
      .catch((error: unknown) => setLoadError(errorMessage(error, '读取运行记录失败')))
      .finally(() => setOpenRunTarget((current) => current?.sessionId === sessionId && current.runId === openRunTarget.runId ? null : current))
  }, [api, openRunTarget, sessionId, setOpenRunTarget, setView])

  React.useEffect(() => {
    if (!api) return
    /** 只接收当前会话的增量；切换运行整体替换，避免两次执行串流。 */
    return api.onStream((event) => {
      if (event.sessionId !== sessionId) return
      setLiveStream((previous) => previous?.runId === event.runId
        ? { runId: event.runId, events: [...previous.events, ...event.events].slice(-API_LIMITS.sseEvents) }
        : { runId: event.runId, events: [...event.events] })
    })
  }, [api, sessionId])

  React.useEffect(() => {
    if (!activeRun || liveStream?.runId !== activeRun.id) return
    if (!['completed', 'failed', 'cancelled', 'interrupted'].includes(activeRun.state)) return
    /** 终态之后以运行记录为准，避免实时缓存与落盘明细重复显示。 */
    if (activeRun.sse) setLiveStream(null)
  }, [activeRun, liveStream?.runId])

  /** 打开已保存请求，重复点击只切换现有标签。 */
  const openRequest = React.useCallback((request: ApiRequestDefinition): void => {
    /** 保存请求对应的稳定编辑标签。 */
    const tabId = `request_${request.id}`
    /** 该接口标记的目标环境只有在仍存在时才作为默认选择，避免悬空引用。 */
    const bound = request.targetEnvironmentId && catalog?.environments.some((item) => item.id === request.targetEnvironmentId)
      ? request.targetEnvironmentId
      : undefined
    setView((previous) => previous.tabs.some((tab) => tab.id === tabId)
      ? { ...previous, activeTabId: tabId, ...(bound ? { environmentId: bound } : {}) }
      : { ...previous, tabs: [...previous.tabs, createRequestTab(tabId, apiDraftFromDefinition(request), request.id, request.revision)], activeTabId: tabId, selectedRun: null, ...(bound ? { environmentId: bound } : {}) })
  }, [catalog, setView])

  /** 待重发的请求：等对应标签真正挂载后再发送，避免 React 批处理竞态。 */
  const [pendingResend, setPendingResend] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (!pendingResend || !controller) return
    /** 目录里当前版本的标签；没有就等下一次渲染。 */
    const tab = view.tabs.find((item) => item.requestId === pendingResend)
    if (!tab) return
    setPendingResend(null)
    void controller.send(tab.id, cloneApiRequestDraft(tab.draft), tab.requestId, view.environmentId ?? undefined).then(() => refreshHistory())
  }, [controller, pendingResend, refreshHistory, view.environmentId, view.tabs])

  /** 用当前定义重发一次历史运行；秘密仍由 Host 解析，不复制旧快照。 */
  const resendRun = React.useCallback((requestId: string): void => {
    const definition = catalog?.requests.find((item) => item.id === requestId)
    if (!definition) {
      setLoadError('该运行对应的请求已不在目录中，无法重发')
      return
    }
    setNotice('已按当前定义重发：使用请求的最新版本，秘密仍由 Host 解析')
    openRequest(definition)
    setPendingResend(requestId)
  }, [catalog, openRequest])

  React.useEffect(() => {
    /** 结果卡与历史里的重发入口只发事件，执行方式由会话决定。 */
    const handle = (event: Event): void => {
      const detail = (event as CustomEvent<{ sessionId?: string; requestId?: string }>).detail
      if (!detail || detail.sessionId !== sessionId || !detail.requestId) return
      resendRun(detail.requestId)
    }
    window.addEventListener(RESEND_API_RUN_EVENT, handle)
    return () => window.removeEventListener(RESEND_API_RUN_EVENT, handle)
  }, [resendRun, sessionId])

  /** 新建未保存请求标签。 */
  const createRequest = React.useCallback((collectionId: string, folder = ''): void => {
    /** 本地草稿标签身份。 */
    const tabId = createLocalId('draft')
    /** 带目录归属的新草稿。 */
    const draft = { ...createApiRequestDraft(collectionId), folder }
    setView((previous) => ({ ...previous, tabs: [...previous.tabs, createRequestTab(tabId, draft)], activeTabId: tabId, selectedRun: null }))
    setCatalogDrawerOpen(false)
  }, [setView])

  /** 用最新目录 revision 执行写入并刷新本地快照。 */
  const mutateCatalog = React.useCallback(async (update: (latest: ApiCatalog) => ApiCatalog): Promise<ApiCatalog | null> => {
    if (!api) return null
    setLoadError(null)
    try {
      /** Host 接受后的真实目录。 */
      const saved = await saveCatalogWithLatestRevision(api, sessionId, update)
      setCatalog(saved)
      setView((previous) => ({ ...previous, environmentId: sanitizeApiEnvironmentId(previous.environmentId, saved.environments) }))
      return saved
    } catch (error) {
      setLoadError(errorMessage(error, '保存接口目录失败，请刷新后重试'))
      return null
    }
  }, [api, sessionId, setView])

  /**
   * 把集合里硬编码的主机一键抽成集合变量。
   *
   * 批量导入最常见的劣化就是「126 条请求各自写着同一个 host」；这里先在当前目录上算一遍，
   * 把「抽哪个主机、改几条」讲清楚再落库，避免静默改写用户的请求。
   */
  const extractBaseUrl = React.useCallback((collection: ApiCollection): void => {
    if (!catalog) return
    const preview = extractApiBaseUrlVariable(catalog, collection.id)
    if (!preview.variableName || preview.updated === 0) {
      setLoadError(preview.message ?? '这个集合里没有可抽取的主机')
      return
    }
    if (!window.confirm(`把 ${preview.origin} 抽成集合变量 {{${preview.variableName}}}？\n将改写 ${preview.updated} 条请求的 URL，其它请求不动。`)) return
    void mutateCatalog((latest) => extractApiBaseUrlVariable(latest, collection.id).catalog)
      .then((saved) => { if (saved) setNotice(`已把 ${preview.origin} 抽成 {{${preview.variableName}}}，改写 ${preview.updated} 条请求`) })
  }, [catalog, mutateCatalog])

  /**
   * 把硬编码主机抽到**当前选中的环境**里，并把这些请求绑定到该环境。
   *
   * 这才是「测试环境 http://127.0.0.1:18080」的标准形态：地址属于环境，请求只写 `{{baseUrl}}/...`，
   * 换生产环境时改一处即可。没选环境时给出可行动提示，而不是默默抽成集合变量。
   */
  const extractBaseUrlToEnvironment = React.useCallback((collection: ApiCollection): void => {
    if (!catalog) return
    const environmentId = view.environmentId
    if (!environmentId) {
      setLoadError('先在右上角选择一个环境（例如「测试环境」），再把这个集合的主机提取到该环境')
      return
    }
    const preview = extractApiBaseUrlVariable(catalog, collection.id, { environmentId })
    if (!preview.variableName || preview.updated === 0) {
      setLoadError(preview.message ?? '这个集合里没有可抽取的主机')
      return
    }
    if (!window.confirm(`把 ${preview.origin} 抽成环境「${preview.environmentName}」的变量 {{${preview.variableName}}}？\n将改写并绑定 ${preview.updated} 条请求到该环境。`)) return
    void mutateCatalog((latest) => extractApiBaseUrlVariable(latest, collection.id, { environmentId }).catalog)
      .then((saved) => { if (saved) setNotice(`已把 ${preview.origin} 抽成环境「${preview.environmentName}」的 {{${preview.variableName}}}，并绑定 ${preview.updated} 条请求`) })
  }, [catalog, mutateCatalog, view.environmentId])

  /** 保存当前请求并更新标签基线。 */
  const saveActive = React.useCallback(async (): Promise<void> => {
    if (!activeTab) return
    updateTab(activeTab.id, (tab) => ({ ...tab, saving: true, error: undefined }))
    /** 新请求在首次保存时生成稳定资源 ID。 */
    const requestId = activeTab.requestId ?? createLocalId('request')
    /** Host 保存后的目录。 */
    const saved = await mutateCatalog((latest) => upsertCatalogRequest(latest, requestId, activeTab.draft, Date.now(), activeTab.baseRevision))
    if (!saved) { updateTab(activeTab.id, (tab) => ({ ...tab, saving: false })); return }
    /** 保存后 Host 返回的请求版本。 */
    const savedRequest = saved.requests.find((request) => request.id === requestId)
    if (!savedRequest) return
    setView((previous) => ({
      ...previous,
      activeTabId: `request_${requestId}`,
      tabs: previous.tabs.map((tab) => tab.id === activeTab.id ? { ...tab, id: `request_${requestId}`, requestId, baseRevision: savedRequest.revision, draft: apiDraftFromDefinition(savedRequest), savedDraft: apiDraftFromDefinition(savedRequest), dirty: false, saving: false } : tab),
    }))
  }, [activeTab, mutateCatalog, setView, updateTab])

  /** 打开一次运行；历史点击、报告行与结果卡定位都不会自动重发。 */
  const openRun = React.useCallback((runId: string, reveal = false): void => {
    if (!api) return
    void api.getRun({ sessionId, runId, ...(reveal ? { reveal: true } : {}) })
      .then((run) => setView((previous) => ({ ...previous, selectedRun: run, historyOpen: false })))
      .catch((error: unknown) => setLoadError(errorMessage(error, '读取运行记录失败')))
  }, [api, sessionId, setView])

  /** 发送当前请求；选中用例时按该用例的断言与覆盖执行。 */
  const sendActive = React.useCallback(async (): Promise<void> => {
    if (!activeTab || !controller) return
    /** 批量用例运行期间的发送入口统一关闭，避免插进另一个用例的执行。 */
    if (caseBatch !== null && caseBatch.tabId === activeTab.id && caseBatch.running) return
    setCompactView('response')
    await controller.send(activeTab.id, cloneApiRequestDraft(activeTab.draft), activeTab.requestId, view.environmentId ?? undefined, activeTab.activeCaseId)
    await refreshHistory()
  }, [activeTab, caseBatch, controller, refreshHistory, view.environmentId])

  /** 取消当前标签的发送；批量运行中同时停止后续用例。 */
  const cancelActive = React.useCallback((): void => {
    if (!activeTab || !controller) return
    /** 先作废批量代次，循环不会再派发下一个用例。 */
    caseBatchTokenRef.current = null
    setCaseBatch((current) => current && current.tabId === activeTab.id ? { ...current, running: false } : current)
    void controller.cancel(activeTab.id)
  }, [activeTab, controller])

  /**
   * 顺序跑完当前请求的全部用例。
   * 跑完再汇总：某个用例失败或取消不影响其它用例的记录，一次就能看全。
   */
  const runAllCases = React.useCallback(async (): Promise<void> => {
    if (!activeTab || !controller) return
    /** 用例声明，顺序即执行顺序。 */
    const cases = activeTab.draft.cases ?? []
    if (cases.length === 0) return
    /** 发起批量时固定标签身份、请求快照与运行代次，中途切换标签不会写错位置。 */
    const tabId = activeTab.id
    const request = cloneApiRequestDraft(activeTab.draft)
    const requestId = activeTab.requestId
    const token = Symbol('case-batch')
    caseBatchTokenRef.current = token
    lastExecutionErrorRef.current.delete(tabId)
    setCompactView('response')
    setCaseBatch({ tabId, running: true, rows: [], meta: { requestName: request.name, method: request.method, url: request.url, startedAt: Date.now() } })
    await runAllApiCases(cases, (caseId) => controller.send(tabId, request, requestId, view.environmentId ?? undefined, caseId), {
      isCancelled: () => caseBatchTokenRef.current !== token,
      describeError: () => lastExecutionErrorRef.current.get(tabId),
      onProgress: (rows) => setCaseBatch((current) => current && current.tabId === tabId ? { ...current, rows } : current),
    })
    setCaseBatch((current) => current && current.tabId === tabId ? { ...current, running: false } : current)
    await refreshHistory()
  }, [activeTab, controller, refreshHistory, view.environmentId])

  /** 复制用例报告；表格结论与复制文本同源。 */
  const copyCaseReport = React.useCallback(async (): Promise<void> => {
    if (!caseBatch) return
    try {
      await copyTextToClipboard(formatApiCaseReportMarkdown(caseBatch.rows, caseBatch.meta))
      setNotice('已复制用例报告，可直接粘贴到评审或工单里')
    } catch (error) {
      setLoadError(errorMessage(error, '复制用例报告失败'))
    }
  }, [caseBatch])

  /** 运行所属用例名；先看当前标签草稿，再按目录回查已保存请求。 */
  const resolveCaseName = React.useCallback((run: ApiRun): string | null => resolveApiCaseName(run, activeTab?.draft ?? null, catalog), [activeTab, catalog])

  /**
   * 打开原生文件对话框选择待上传文件。
   * 渲染层只拿到引用与元数据；路径始终留在主进程。
   */
  const pickFiles = React.useCallback(async (): Promise<ApiPickedFile[]> => {
    if (!api) return []
    const result = await api.pickApiFiles({ sessionId })
    return result.files
  }, [api, sessionId])

  /**
   * 把一次运行的真实请求载入成新的未保存草稿。
   * 记录里的取值是遮罩过的，因此这里只还原可见事实：被遮罩的位置留空并列入提示，绝不写回 [REDACTED]。
   */
  const loadRunToEditor = React.useCallback((run: ApiRun): void => {
    /** 本地草稿标签身份；载入不覆盖任何已保存定义。 */
    const tabId = createLocalId('draft')
    const loaded = draftFromRun(run, catalog, () => createLocalId('field'))
    setView((previous) => ({ ...previous, tabs: [...previous.tabs, createRequestTab(tabId, loaded.draft)], activeTabId: tabId, selectedRun: null, historyOpen: false }))
    setCompactView('request')
    setNotice(loaded.redacted.length > 0
      ? `已按历史还原成未保存草稿；以下位置在运行记录里是遮罩值，必须重新填写：${loaded.redacted.join('、')}`
      : '已按历史还原成未保存草稿；鉴权已体现在请求头里，确认后再发送或保存')
  }, [catalog, setView])

  /** 运行在界面上的稳定标签：请求名 + 创建时间 + 运行号尾段，同一秒内也能分辨是哪两次。 */
  const describeRun = React.useCallback((run: ApiRun): string => `${run.requestName} · ${new Date(run.createdAt).toLocaleTimeString()} · ${run.id.slice(-6)}`, [])

  /** 记录当前显示运行作为对比基线；只存在界面状态，不写目录。 */
  const setBaseline = React.useCallback((run: ApiRun): void => {
    setBaselineRun({ id: run.id, label: describeRun(run) })
    setNotice(`已把「${describeRun(run)}」设为对比基线；打开另一条运行后点「与基线对比」`)
  }, [describeRun])

  /** 读取两条运行（默认脱敏投影）并计算差异。 */
  const compareWithBaseline = React.useCallback(async (run: ApiRun): Promise<void> => {
    if (!api || !baselineRun) return
    if (baselineRun.id === run.id) {
      setLoadError('当前运行就是基线，请先打开另一条运行再对比')
      return
    }
    try {
      /** 两侧都用默认投影：绝不 reveal，差异里不会出现被遮罩的秘密。 */
      const [baselineRecord, candidateRecord] = await Promise.all([
        api.getRun({ sessionId, runId: baselineRun.id }),
        api.getRun({ sessionId, runId: run.id }),
      ])
      /** 用例一行显示可读名称，而不是把 caseId 原样丢给用户。 */
      const diff = diffApiRuns(baselineRecord, candidateRecord)
      const caseLabels: Record<'baseline' | 'candidate', string> = {
        baseline: resolveCaseName(baselineRecord) ?? '未按用例',
        candidate: resolveCaseName(candidateRecord) ?? '未按用例',
      }
      const rows = diff.rows.map((row) => row.label === '用例'
        ? { ...row, baseline: caseLabels.baseline, candidate: caseLabels.candidate, changed: caseLabels.baseline !== caseLabels.candidate }
        : row)
      setRunDiff({ diff: { ...diff, rows }, baselineLabel: baselineRun.label, candidateLabel: describeRun(run) })
      setRunDiffOpen(true)
    } catch (error) {
      setLoadError(errorMessage(error, '读取对比运行失败'))
    }
  }, [api, baselineRun, describeRun, resolveCaseName, sessionId])

  /** 导入的 cURL 草稿一律新开标签，确认无误后才写入目录。 */
  const importDrafts = React.useCallback((drafts: ApiRequestDraft[]): void => {
    if (drafts.length === 0) return
    setView((previous) => {
      /** 新标签使用本地草稿 ID，保存时才生成稳定资源 ID。 */
      const tabs = createImportedRequestTabs(drafts, () => createLocalId('draft'))
      return { ...previous, tabs: [...previous.tabs, ...tabs], activeTabId: tabs[0]!.id, selectedRun: null, historyOpen: false }
    })
    setNotice(`已导入 ${drafts.length} 条请求草稿，确认无误后保存到集合`)
  }, [setView])

  /** 集合快照以最新 revision 追加，ID 冲突时只新增不覆盖。 */
  const importSnapshot = React.useCallback(async (snapshot: ApiCatalogSnapshot): Promise<void> => {
    /** 合并摘要在目录更新回调内产生，供反馈文案复用。 */
    let summary: string | null = null
    const saved = await mutateCatalog((latest) => {
      const merged = mergeApiCatalogSnapshot(latest, snapshot)
      summary = `已导入 ${merged.added.collections} 个集合、${merged.added.environments} 个环境、${merged.added.requests} 条请求`
        + (merged.emptiedSecrets.length > 0 ? `；${merged.emptiedSecrets.length} 处秘密需要重新填写` : '')
      return merged.catalog
    })
    if (!saved || summary === null) return
    setNotice(summary)
  }, [mutateCatalog])

  /** 把当前请求导出为 cURL 并复制；秘密只以变量占位符出现。 */
  const copyActiveCurl = React.useCallback(async (): Promise<void> => {
    if (!activeTab) return
    try {
      const exported = createCurlCommand(activeTab.draft)
      await copyTextToClipboard(exported.command)
      setNotice(exported.redactedSecrets.length > 0
        ? `已复制 cURL；${exported.redactedSecrets.length} 处秘密已替换为变量占位符`
        : '已复制 cURL 命令')
    } catch (error) {
      setLoadError(errorMessage(error, '复制 cURL 失败'))
    }
  }, [activeTab])

  /** 复制整个集合快照；秘密值清空并提示需要重新填写的位置数量。 */
  const copyCatalogSnapshot = React.useCallback(async (): Promise<void> => {
    if (!catalog) return
    try {
      const exported = createApiCatalogSnapshotExport(catalog, Date.now())
      await copyTextToClipboard(exported.text)
      setNotice(exported.emptiedSecrets.length > 0
        ? `已复制集合快照；${exported.emptiedSecrets.length} 处秘密已清空，导回后需要重新填写`
        : '已复制集合快照 JSON')
    } catch (error) {
      setLoadError(errorMessage(error, '复制集合快照失败'))
    }
  }, [catalog])

  /** 读取运行时变量元数据；值只在主进程使用，界面永远拿不到。 */
  const loadRuntimeVariables = React.useCallback(async (): Promise<void> => {
    if (!api) return
    try {
      const result = await api.getRuntimeVariables({ sessionId })
      setRuntimeVariables(result.variables)
    } catch (error) {
      setLoadError(errorMessage(error, '读取运行时变量失败'))
    }
  }, [api, sessionId])

  /** 面板打开期间读取变量，并在运行状态变化时同步刷新。 */
  React.useEffect(() => {
    if (!api || !runtimeOpen) return
    void loadRuntimeVariables()
    return api.onChanged((event) => { if (event.sessionId === sessionId) void loadRuntimeVariables() })
  }, [api, loadRuntimeVariables, runtimeOpen, sessionId])

  /** 清空当前 workspace 的运行时变量。 */
  const clearRuntimeVariables = React.useCallback(async (): Promise<void> => {
    if (!api) return
    try {
      const result = await api.clearRuntimeVariables({ sessionId })
      setNotice(result.cleared > 0 ? `已清空 ${result.cleared} 个运行时变量` : '没有可清空的运行时变量')
      await loadRuntimeVariables()
    } catch (error) {
      setLoadError(errorMessage(error, '清空运行时变量失败'))
    }
  }, [api, loadRuntimeVariables, sessionId])

  /** 读取 Cookie 元数据；取值只在主进程使用，界面永远拿不到。 */
  const loadCookies = React.useCallback(async (): Promise<void> => {
    if (!api) return
    try {
      const result = await api.getCookieJar({ sessionId })
      setCookies(result.cookies)
    } catch (error) {
      setLoadError(errorMessage(error, '读取 Cookie 失败'))
    }
  }, [api, sessionId])

  /** 面板打开期间读取 Cookie，并在运行状态变化时同步刷新。 */
  React.useEffect(() => {
    if (!api || !cookieOpen) return
    void loadCookies()
    return api.onChanged((event) => { if (event.sessionId === sessionId) void loadCookies() })
  }, [api, cookieOpen, loadCookies, sessionId])

  /** 清空当前 workspace 的 Cookie Jar。 */
  const clearCookies = React.useCallback(async (): Promise<void> => {
    if (!api) return
    try {
      const result = await api.clearCookieJar({ sessionId })
      setNotice(result.cleared > 0 ? `已清空 ${result.cleared} 条 Cookie` : '没有可清空的 Cookie')
      await loadCookies()
    } catch (error) {
      setLoadError(errorMessage(error, '清空 Cookie 失败'))
    }
  }, [api, loadCookies, sessionId])

  React.useEffect(() => {
    /** 工作台快捷键只在焦点位于当前组件内时生效。 */
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) return
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); void sendActive() }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') { event.preventDefault(); void saveActive() }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [saveActive, sendActive])

  if (!api) return <div ref={rootRef} className="flex h-full items-center justify-center p-6 text-center text-xs text-muted-foreground">接口工作台尚未就绪，请重启应用后重试</div>
  if (!catalog && !loadError) return <div ref={rootRef} className="flex h-full items-center justify-center text-xs text-muted-foreground">正在加载接口目录...</div>
  if (!catalog) return <div ref={rootRef} className="flex h-full items-center justify-center p-6 text-center text-xs text-destructive">{loadError}</div>

  /** 目录组件共用属性。 */
  const catalogPanel = <CatalogPanel
    catalog={catalog}
    sessionId={sessionId}
    activeTabId={view.activeTabId}
    onOpenRequest={openRequest}
    onCreateRequest={createRequest}
    onCreateCollection={() => setCatalogNameAction({ kind: 'create-collection' })}
    onRenameCollection={(collection) => setCatalogNameAction({ kind: 'rename-collection', collection })}
    onDeleteCollection={(collection) => {
      if (!window.confirm(`删除集合“${collection.name}”及其中所有请求？`)) return
      void mutateCatalog((latest) => ({ ...latest, collections: latest.collections.filter((item) => item.id !== collection.id), requests: latest.requests.filter((request) => request.collectionId !== collection.id) }))
    }}
    onCreateFolder={(collection) => setCatalogNameAction({ kind: 'create-folder', collection })}
    onExtractBaseUrl={extractBaseUrl}
    onExtractBaseUrlToEnvironment={extractBaseUrlToEnvironment}
    onRenameFolder={(collectionId, folder) => setCatalogNameAction({ kind: 'rename-folder', collectionId, folder })}
    onDeleteFolder={(collectionId, folder) => {
      if (!window.confirm(`删除文件夹“${folder}”及其中所有请求？`)) return
      void mutateCatalog((latest) => ({ ...latest, requests: latest.requests.filter((request) => !(request.collectionId === collectionId && request.folder === folder)) }))
    }}
    onExportSnapshot={() => void copyCatalogSnapshot()}
  />

  return (
    /**
     * relative：窄栏抽屉要在这一栏内部绝对定位，不能跑到窗口最左侧。
     * data-api-workbench-root 供真机验收（界面 smoke）量抽屉是否仍在工作台范围内。
     */
    <div ref={rootRef} data-api-workbench-root="true" className="relative flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-content-area text-foreground">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border/50 px-2.5">
        {compact && <ToolButton label="打开目录" onClick={() => setCatalogDrawerOpen(true)}><Menu className="size-4" /></ToolButton>}
        <span className="text-xs font-semibold">接口工作台</span>
        {/** 项目制：接口资产按项目隔离，这里必须让用户看见自己在哪个项目。 */}
        <span className="max-w-[180px] truncate text-[11px] text-muted-foreground" title={workspaceLabel ? `接口资产归项目「${workspaceLabel}」，与其它项目互不可见` : '接口资产按项目隔离'}>
          {workspaceLabel ? `· ${workspaceLabel}` : '· 当前项目'}
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          <Select value={view.environmentId ?? 'none'} onValueChange={(environmentId) => setView((previous) => ({ ...previous, environmentId: environmentId === 'none' ? null : environmentId }))}>
            <SelectTrigger className="h-7 w-36 text-[11px]"><SelectValue placeholder="无环境" /></SelectTrigger>
            <SelectContent><SelectItem value="none">无环境</SelectItem>{catalog.environments.map((environment) => <SelectItem key={environment.id} value={environment.id}>{environment.name}</SelectItem>)}</SelectContent>
          </Select>
          <ToolButton label="编辑当前环境" disabled={!view.environmentId} onClick={() => { setEditingEnvironment(catalog.environments.find((item) => item.id === view.environmentId) ?? null); setEnvironmentDialogOpen(true) }}><Settings2 className="size-3.5" /></ToolButton>
          <ToolButton label="新建环境" onClick={() => { setEditingEnvironment({ id: createLocalId('environment'), name: '新环境', kind: 'local', variables: [] }); setEnvironmentDialogOpen(true) }}><Plus className="size-3.5" /></ToolButton>
          <ToolButton label="运行历史" onClick={() => setView((previous) => ({ ...previous, historyOpen: true }))}><History className="size-3.5" /></ToolButton>
          <ToolButton label="运行时变量" onClick={() => setRuntimeOpen(true)}><KeyRound className="size-3.5" /></ToolButton>
          <ToolButton label="Cookie" onClick={() => setCookieOpen(true)}><Cookie className="size-3.5" /></ToolButton>
          <ToolButton label="导入接口" onClick={() => setImportOpen(true)}><Upload className="size-3.5" /></ToolButton>
        </div>
      </div>
      {loadError && <div className="shrink-0 border-b border-destructive/20 bg-destructive/10 px-3 py-1.5 text-xs text-destructive">{loadError}</div>}
      {notice && (
        <div className="flex shrink-0 items-center gap-2 border-b border-emerald-500/20 bg-emerald-500/10 px-3 py-1.5 text-xs text-emerald-700 dark:text-emerald-400">
          <span className="min-w-0 flex-1">{notice}</span>
          <button type="button" className="shrink-0 rounded px-1 hover:bg-emerald-500/20" aria-label="关闭提示" onClick={() => setNotice(null)}><X className="size-3.5" /></button>
        </div>
      )}
      {compact && <div className="flex h-9 shrink-0 items-center justify-center border-b border-border/50 bg-muted/20"><div className="flex rounded-md bg-muted p-0.5"><button type="button" className={cn('rounded px-3 py-1 text-xs', compactView === 'request' && 'bg-background shadow-sm')} onClick={() => setCompactView('request')}>请求</button><button type="button" className={cn('rounded px-3 py-1 text-xs', compactView === 'response' && 'bg-background shadow-sm')} onClick={() => setCompactView('response')}>响应</button></div></div>}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {!compact && <div className="w-56 shrink-0">{catalogPanel}</div>}
        <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <RequestTabBar tabs={view.tabs} activeTabId={view.activeTabId} onSelect={(activeTabId) => setView((previous) => ({ ...previous, activeTabId, selectedRun: previous.tabs.find((tab) => tab.id === activeTabId)?.run ?? null }))} onClose={(tabId) => setView((previous) => {
            /** 关闭后优先选择相邻标签。 */
            const index = previous.tabs.findIndex((tab) => tab.id === tabId)
            /** 剩余标签。 */
            const tabs = previous.tabs.filter((tab) => tab.id !== tabId)
            /** 下一活动标签。 */
            const activeTabId = previous.activeTabId === tabId ? tabs[Math.min(index, tabs.length - 1)]?.id ?? null : previous.activeTabId
            return { ...previous, tabs, activeTabId, selectedRun: tabs.find((tab) => tab.id === activeTabId)?.run ?? null }
          })} />
          {!activeTab && !view.historyOpen && !activeRun ? (
            <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 text-center text-xs text-muted-foreground"><Archive className="size-6" /><span>从目录打开请求，或新建一个请求</span>{catalog.collections[0] && <Button type="button" variant="outline" size="sm" onClick={() => createRequest(catalog.collections[0]!.id)}><Plus className="mr-1 size-3.5" />新建请求</Button>}</div>
          ) : (
            <div className={cn('flex min-h-0 flex-1 overflow-hidden', compact ? 'flex-col' : 'flex-col')}>
              {activeTab && !view.historyOpen && (!compact || compactView === 'request') && <section className={cn('flex min-h-0 flex-col', compact ? 'flex-1' : 'basis-[58%] border-b border-border/50')}><RequestEditor tab={activeTab} environmentId={view.environmentId} onChange={(draft) => updateTab(activeTab.id, (tab) => { const next = { ...tab, draft }; return { ...next, dirty: isApiRequestDirty(next) } })} onSave={() => void saveActive()} onDuplicate={() => {
                /** 复制出的草稿使用独立身份且不覆盖原请求。 */
                const tabId = createLocalId('draft')
                setView((previous) => ({ ...previous, tabs: [...previous.tabs, createRequestTab(tabId, { ...cloneApiRequestDraft(activeTab.draft), name: `${activeTab.draft.name} 副本` })], activeTabId: tabId, selectedRun: null }))
              }} onDelete={() => {
                if (activeTab.requestId && !window.confirm(`删除请求“${activeTab.draft.name}”？`)) return
                if (activeTab.requestId) void mutateCatalog((latest) => ({ ...latest, requests: latest.requests.filter((request) => request.id !== activeTab.requestId) }))
                setView((previous) => ({ ...previous, tabs: previous.tabs.filter((tab) => tab.id !== activeTab.id), activeTabId: null, selectedRun: null }))
              }} onCopyCurl={() => void copyActiveCurl()} environments={catalog.environments} casesRunning={caseBatch !== null && caseBatch.tabId === activeTab.id && caseBatch.running} onCasesChange={(draft, activeCaseId) => updateTab(activeTab.id, (tab) => { const next = { ...tab, draft, activeCaseId }; return { ...next, dirty: isApiRequestDirty(next) } })} onActiveCaseChange={(activeCaseId) => updateTab(activeTab.id, (tab) => ({ ...tab, activeCaseId }))} onRunAllCases={() => void runAllCases()} onSend={() => void sendActive()} onCancel={cancelActive} onPickFiles={pickFiles} /></section>}
              {(!compact || compactView === 'response' || view.historyOpen || !activeTab) && <section className={cn('flex min-h-0 flex-col', compact ? 'flex-1' : activeTab ? 'basis-[42%]' : 'flex-1')}><ResponsePanel api={api} sessionId={sessionId} run={activeRun} historyRuns={historyRuns} historyOpen={view.historyOpen} historyHasMore={historyNextCursor !== null} onLoadMoreHistory={() => void loadMoreHistory()} onHistoryOpenChange={(historyOpen) => setView((previous) => ({ ...previous, historyOpen }))} onOpenRun={openRun} onPinRun={(run) => { void api.pinRun({ sessionId, runId: run.id, pinned: !run.pinned }).then(() => refreshHistory()).catch((error: unknown) => setLoadError(errorMessage(error, '更新运行收藏失败'))) }} resolveCaseName={resolveCaseName} onLoadToEditor={loadRunToEditor} onSetBaseline={setBaseline} onCompareBaseline={(run) => void compareWithBaseline(run)} baselineRunId={baselineRun?.id ?? null} /></section>}
            </div>
          )}
        </main>
      </div>
      <ApiCatalogDrawer open={catalogDrawerOpen} onClose={() => setCatalogDrawerOpen(false)}>{catalogPanel}</ApiCatalogDrawer>
      <CatalogNameDialog action={catalogNameAction} onOpenChange={(open) => { if (!open) setCatalogNameAction(null) }} onSubmit={(name) => {
        /** 提交后立即关闭，失败信息由工作台顶部统一展示。 */
        const action = catalogNameAction
        setCatalogNameAction(null)
        if (!action) return
        if (action.kind === 'create-collection') { void mutateCatalog((latest) => ({ ...latest, collections: [...latest.collections, { id: createLocalId('collection'), name, description: '', variables: [] }] })); return }
        if (action.kind === 'rename-collection') { void mutateCatalog((latest) => ({ ...latest, collections: latest.collections.map((item) => item.id === action.collection.id ? { ...item, name } : item) })); return }
        /** 文件夹由请求路径承载，新建时直接创建首个草稿。 */
        if (action.kind === 'create-folder') { createRequest(action.collection.id, name); return }
        if (name !== action.folder) void mutateCatalog((latest) => renameCatalogFolder(latest, action.collectionId, action.folder, name, Date.now()))
      }} />
      <EnvironmentDialog open={environmentDialogOpen} environment={editingEnvironment} onOpenChange={setEnvironmentDialogOpen} onSave={(environment) => void mutateCatalog((latest) => ({ ...latest, environments: latest.environments.some((item) => item.id === environment.id) ? latest.environments.map((item) => item.id === environment.id ? environment : item) : [...latest.environments, environment] })).then((saved) => { if (saved) { setView((previous) => ({ ...previous, environmentId: environment.id })); setEnvironmentDialogOpen(false) } })} onDelete={(environment) => { if (!window.confirm(`删除环境“${environment.name}”？`)) return; void mutateCatalog((latest) => ({ ...latest, environments: latest.environments.filter((item) => item.id !== environment.id) })).then(() => setEnvironmentDialogOpen(false)) }} />
      <ApiImportDialog open={importOpen} onOpenChange={setImportOpen} onImportDrafts={importDrafts} onImportSnapshot={importSnapshot} />
      <CaseReportDialog
        batch={caseBatch}
        onOpenChange={(open) => { if (!open && !caseBatch?.running) setCaseBatch(null) }}
        onCopy={() => void copyCaseReport()}
        onOpenRun={(runId) => { /** 报告是模态弹层，打开某次运行时要先让位给响应面板。 */ setCaseBatch(null); openRun(runId) }}
        onCancel={cancelActive}
      />
      <CookieJarDialog
        open={cookieOpen}
        cookies={cookies}
        onOpenChange={setCookieOpen}
        onRefresh={() => void loadCookies()}
        onClear={() => void clearCookies()}
      />
      <RunDiffDialog
        open={runDiffOpen}
        diff={runDiff?.diff ?? null}
        baselineLabel={runDiff?.baselineLabel ?? ''}
        candidateLabel={runDiff?.candidateLabel ?? ''}
        onOpenChange={setRunDiffOpen}
      />
      <RuntimeVariablesDialog
        open={runtimeOpen}
        variables={runtimeVariables}
        onOpenChange={setRuntimeOpen}
        onRefresh={() => void loadRuntimeVariables()}
        onClear={() => void clearRuntimeVariables()}
      />
    </div>
  )
}

/** 工作区或会话切换时同步重建本地状态，避免旧目录残留一帧可操作。 */
export function ApiWorkbench({ sessionId, workspaceScope, workspaceLabel }: { sessionId: string; workspaceScope?: string; workspaceLabel?: string }): React.ReactElement {
  /** UI 隔离键不进入 IPC，workspace 身份仍由 Host 自报和校验。 */
  const uiScope = createApiWorkbenchUiScope(sessionId, workspaceScope)
  return <ApiWorkbenchSession key={uiScope} sessionId={sessionId} uiScope={uiScope} workspaceLabel={workspaceLabel} />
}
