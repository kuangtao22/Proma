import * as React from 'react'
import { useAtom } from 'jotai'
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  Eye,
  FileJson,
  Folder,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Search,
  Server,
  TestTube2,
  Trash2,
  Workflow,
} from 'lucide-react'
import type {
  MediaConnectionAuth,
  MediaConnectionProbe,
  MediaAuthorizationMode,
  MediaRemoteCapability,
  MediaResourceKind,
  MediaResourcePage,
  MediaResourceQuery,
  MediaRemoteDescriptor,
  MediaRemoteWorkflow,
  MediaSettingsSnapshot,
  MediaWorkflowBinding,
  MediaWorkflowDefinition,
  MediaWorkflowField,
  MediaWorkflowFieldControlType,
  MediaWorkflowOutputSelector,
  MediaWorkflowVersion,
  SaveMediaConnectionInput,
  SaveMediaWorkflowInput,
} from '@proma/shared'
import {
  createMediaWorkflowFieldBinding,
  listMediaWorkflowFields,
  parseComfyPrompt,
  parseMediaWorkflowDefinition,
  validateMediaWorkflowFieldBindings,
} from '@proma/shared'
import { mediaSettingsFocusAtom } from '@/atoms/settings-tab'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { JsonCodeEditor } from '@/components/ui/json-code-editor'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { cn } from '@/lib/utils'
import { copyTextToClipboard } from '@/lib/clipboard'
import { MediaApiModelSettings } from './MediaApiModelSettings'
import { MediaSettingsPage } from './MediaSettingsPage'
import { SettingsCard, SettingsRow } from './primitives'

/** Renderer 可读取的工作流文件上限。 */
export const MEDIA_WORKFLOW_IMPORT_MAX_BYTES = 2 * 1024 * 1024

/** 媒体设置的三个平级页面。 */
export type MediaSettingsTab = 'models' | 'connections' | 'workflows'

/** 连接表单的独立本地草稿。 */
export interface MediaConnectionDraft {
  id: string
  name: string
  baseUrl: string
  enabled: boolean
  authKind: MediaConnectionAuth['kind']
  headerName: string
  credential: string
  credentialConfigured: boolean
  comfyUser: string
}

/** 公共工作流的独立本地草稿。 */
export interface MediaWorkflowDraft {
  id: string
  name: string
  definitionText: string
  definition: MediaWorkflowDefinition | null
  invalidated: boolean
  parseError: string | null
}

/** 资源浏览器当前查询状态。 */
export interface MediaResourceBrowserState {
  connectionId: string
  kind: MediaResourceKind
  query: string
  folder: string
  offset: number
}

/** 资源筛选变化后的视图状态。 */
interface MediaResourceFilterTransition {
  resourceState: MediaResourceBrowserState
  resourcePage: null
  selectedResourceId: null
}

/** 资源读取失败后的可见状态，旧快照必须继续保留。 */
interface MediaResourceLoadFailure {
  page: MediaResourcePage | null
  error: string
}

/** 资源页来源与时间文案，区分持久快照和实时资源库。 */
export interface MediaResourcePageStatus {
  sourceLabel: string
  timeLabel: string
}

/** 连接和工作流归档对话框目标。 */
interface ArchiveTarget {
  kind: 'connection' | 'workflow'
  id: string
  name: string
}

/** 工作流保存后的画布导航请求。 */
export interface MediaWorkflowCanvasTarget {
  workflowId: string
  revision: number
}

/** 媒体设置页可选跨导航接口，由上层工作区接入真实画布。 */
export interface MediaSettingsProps {
  onOpenWorkflowInCanvas?: (target: MediaWorkflowCanvasTarget) => void
}

/** 判断未知值是否为普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** 将稳定错误码整理为用户可操作文本，其它表单错误保留原有说明。 */
export function formatMediaError(error: unknown): string {
  /** Electron IPC 拒绝后的稳定消息。 */
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes('MEDIA_REMOTE_WORKFLOW_READ_FAILED')) {
    return '工作流详情读取或兼容性分析失败，请重新同步工作流列表后重试。'
  }
  if (message.includes('MEDIA_REMOTE_WORKFLOW_NOT_IMPORTABLE')) {
    return '当前工作流未通过转换校验，请查看详情中的问题定位后重试。'
  }
  return message
}

/** 创建稳定 ID。 */
function createMediaId(prefix: string): string {
  return `${prefix}-${globalThis.crypto.randomUUID()}`
}

/** 深复制工作流定义，避免草稿修改服务端快照。 */
function cloneDefinition(definition: MediaWorkflowDefinition): MediaWorkflowDefinition {
  return structuredClone(definition)
}

/** 构建连接保存输入并执行 Renderer 可判断的校验。 */
export function buildSaveMediaConnectionInput(draft: MediaConnectionDraft): SaveMediaConnectionInput {
  /** 去除展示字段空白后的名称。 */
  const name = draft.name.trim()
  if (!draft.id.trim()) throw new Error('连接 ID 不能为空')
  if (!name) throw new Error('请输入连接名称')
  /** 解析后的服务地址。 */
  let url: URL
  try {
    url = new URL(draft.baseUrl.trim())
  } catch {
    throw new Error('请输入有效的 HTTP 服务地址')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('服务地址必须使用 HTTP 或 HTTPS')
  if (url.username || url.password) throw new Error('服务地址不能包含认证信息')
  /** 根据认证模式创建公开配置。 */
  const auth: MediaConnectionAuth = draft.authKind === 'header'
    ? { kind: 'header', headerName: draft.headerName.trim() }
    : { kind: draft.authKind }
  if (auth.kind === 'header' && !auth.headerName) throw new Error('请输入认证 Header 名称')
  if (auth.kind !== 'none' && !draft.credential && !draft.credentialConfigured) throw new Error('请输入认证秘密')
  /** 可选的 ComfyUI 用户身份。 */
  const comfyUser = draft.comfyUser.trim()
  return {
    id: draft.id.trim(),
    name,
    driver: 'comfyui',
    baseUrl: draft.baseUrl.trim(),
    enabled: draft.enabled,
    auth,
    ...(comfyUser ? { comfyUser } : {}),
    ...(draft.credential ? { credential: draft.credential } : {}),
  }
}

/** 判断地址、认证或 Comfy 用户是否改变，改变后旧资源身份不再可信。 */
export function hasMediaConnectionIdentityChanged(
  baseline: Pick<MediaConnectionDraft, 'baseUrl' | 'authKind' | 'headerName' | 'credential' | 'comfyUser'>,
  draft: Pick<MediaConnectionDraft, 'baseUrl' | 'authKind' | 'headerName' | 'credential' | 'comfyUser'>,
): boolean {
  return baseline.baseUrl.trim() !== draft.baseUrl.trim()
    || baseline.authKind !== draft.authKind
    || baseline.headerName.trim() !== draft.headerName.trim()
    || baseline.credential !== draft.credential
    || baseline.comfyUser.trim() !== draft.comfyUser.trim()
}

/** 解析导入的 API JSON 或完整工作流定义。 */
export function parseMediaWorkflowImportText(text: string): MediaWorkflowDefinition {
  if (new TextEncoder().encode(text).byteLength > MEDIA_WORKFLOW_IMPORT_MAX_BYTES) {
    throw new Error('工作流文件不能超过 2 MiB')
  }
  /** JSON 解码后的未知值。 */
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new Error('工作流不是有效 JSON')
  }
  if (isRecord(value) && ('nodes' in value || 'links' in value)) {
    throw new Error('不支持 ComfyUI UI 工作流，请导出 API 格式')
  }
  if (isRecord(value) && value.schemaVersion === 1) return parseMediaWorkflowDefinition(value)
  return { schemaVersion: 1, prompt: parseComfyPrompt(value), bindings: [], outputs: [] }
}

/** 构建公共工作流保存输入。 */
export function buildSaveMediaWorkflowInput(
  draft: Pick<MediaWorkflowDraft, 'id' | 'name' | 'definitionText'>,
): SaveMediaWorkflowInput {
  /** 去除展示字段空白后的名称。 */
  const name = draft.name.trim()
  if (!draft.id.trim()) throw new Error('工作流 ID 不能为空')
  if (!name) throw new Error('请输入工作流名称')
  /** 严格解析后的公共定义。 */
  const definition = parseMediaWorkflowImportText(draft.definitionText)
  if (definition.outputs.length === 0) throw new Error('至少选择一个输出节点')
  /** 字段绑定问题列表。 */
  const issues = validateMediaWorkflowFieldBindings(definition)
  if (issues.length > 0) throw new Error(issues[0]?.message ?? '工作流字段绑定无效')
  for (const output of definition.outputs) {
    if (!Object.hasOwn(definition.prompt, output.nodeId)) throw new Error(`输出节点不存在：${output.nodeId}`)
  }
  return { id: draft.id.trim(), name, projectId: null, definition }
}

/** 清除官方媒体 Loader 中的本地文件身份，避免私有资源进入公共模板。 */
function redactWorkflowMediaInputs(definition: MediaWorkflowDefinition): MediaWorkflowDefinition {
  /** 深复制后的定义。 */
  const copy = cloneDefinition(definition)
  /** Loader 与可公开参数化输入的精确映射。 */
  const loaderInputs: Readonly<Record<string, string>> = {
    LoadImage: 'image',
    LoadAudio: 'audio',
    LoadVideo: 'file',
  }
  for (const node of Object.values(copy.prompt)) {
    /** 当前 Loader 唯一允许的媒体输入。 */
    const input = loaderInputs[node.class_type]
    if (input && Object.hasOwn(node.inputs, input)) node.inputs[input] = ''
  }
  return copy
}

/** 将任意历史版本复制为新的公共工作流输入。 */
export function createPublicWorkflowCopyInput(
  workflow: MediaWorkflowVersion,
  id: string,
): SaveMediaWorkflowInput {
  return {
    id,
    name: `${workflow.name} 副本`,
    projectId: null,
    definition: redactWorkflowMediaInputs(workflow.definition),
  }
}

/** 将已读取的远端 API 图转换为尚未发布的公共草稿。 */
export function createRemoteWorkflowDraft(
  remote: MediaRemoteWorkflow,
  name: string,
  id: string,
): MediaWorkflowDraft {
  if (remote.analysis?.definition) {
    /** 采用主进程已通过实时 schema 与执行校验的转换定义。 */
    const definition = cloneDefinition(remote.analysis.definition)
    return { id, name, definitionText: JSON.stringify(definition, null, 2), definition, invalidated: false, parseError: null }
  }
  if (remote.analysis && !remote.analysis.convertible) throw new Error('当前工作流未通过转换校验，请查看详情中的问题定位')
  if (remote.format === 'ui') throw new Error('ComfyUI UI 工作流不能直接执行；尚未完成转换分析，暂不能导入')
  if (remote.format !== 'api') throw new Error('无法确认远端工作流格式，不能导入为可执行模板')
  /** 远端 API 图经现有严格解析器形成公共定义草稿。 */
  const definition = parseMediaWorkflowImportText(JSON.stringify(remote.definition))
  return {
    id,
    name,
    definitionText: JSON.stringify(definition, null, 2),
    definition,
    invalidated: false,
    parseError: null,
  }
}

/** 应用资源筛选变化，并同步失效旧页和展开项。 */
export function changeMediaResourceFilters(
  state: MediaResourceBrowserState,
  patch: Partial<Omit<MediaResourceBrowserState, 'offset'>>,
): MediaResourceFilterTransition {
  return {
    resourceState: { ...state, ...patch, offset: 0 },
    resourcePage: null,
    selectedResourceId: null,
  }
}

/** 判断资源响应是否仍属于当前查询代次。 */
export function isCurrentMediaResourceRequest(requestRevision: number, currentRevision: number): boolean {
  return requestRevision === currentRevision
}

/** 创建快照查询；只有用户点击同步按钮时才允许 refresh。 */
export function createMediaResourceQuery(
  state: MediaResourceBrowserState,
  refresh: boolean,
  offset = state.offset,
): MediaResourceQuery {
  return {
    connectionId: state.connectionId,
    kind: state.kind,
    query: state.query.trim() || undefined,
    folder: state.kind === 'models' ? state.folder || undefined : undefined,
    offset,
    limit: 50,
    refresh,
  }
}

/** 搜索输入短暂防抖，其它筛选立即读取本地快照。 */
export function getMediaResourceAutoLoadDelay(query: string): number {
  return query.length > 0 ? 300 : 0
}

/** 同步或读取失败时保留当前快照，仅更新错误提示。 */
export function retainMediaResourcePageAfterFailure(
  page: MediaResourcePage | null,
  error: unknown,
): MediaResourceLoadFailure {
  return { page, error: formatMediaError(error) }
}

/** 模型目录随模型快照返回，不依赖连接测试。 */
export function getMediaResourceModelFolders(page: MediaResourcePage | null): string[] {
  return page?.modelFolders ?? []
}

/** 按资源真实来源展示快照或实时查询状态。 */
export function getMediaResourcePageStatus(
  page: MediaResourcePage | null,
  kind: MediaResourceKind,
): MediaResourcePageStatus | null {
  if (!page) return null
  if (kind === 'assets') return { sourceLabel: '远端资源', timeLabel: '查询时间' }
  return {
    sourceLabel: page.snapshotOrigin === 'remote' ? '刚刚同步' : '本地快照',
    timeLabel: '上次同步',
  }
}

/** 展示资源接口能力或模型目录降级来源，不隐藏仍可用的兼容列表。 */
export function getMediaResourceCapabilityMessage(
  page: MediaResourcePage | null,
  kind: MediaResourceKind,
): string | null {
  if (!page?.capability || page.capability === 'available') return null
  if (kind === 'models' && page.source === 'loader-schema' && page.capability === 'unsupported') {
    return '模型目录接口不可用，当前展示从工作节点解析的兼容模型列表。'
  }
  const labels: Readonly<Record<Exclude<MediaRemoteCapability, 'available'>, string>> = {
    unsupported: '服务不支持此资源接口。',
    disabled: '服务未启用此资源接口。',
    'authentication-required': '资源接口需要重新认证。',
    failed: '资源接口查询失败。',
    unknown: '资源接口状态未知。',
  }
  return labels[page.capability]
}

/** 将后端能力状态转为简短中文原因。 */
function formatMediaRemoteCapability(capability: MediaRemoteCapability): string {
  const labels: Readonly<Record<MediaRemoteCapability, string>> = {
    available: '同步成功',
    unsupported: '服务不支持此资源接口',
    disabled: '服务未启用此资源接口',
    'authentication-required': '认证失败或需要重新登录',
    failed: '远端同步失败',
    unknown: '远端状态未知',
  }
  return labels[capability]
}

/** 资源浏览器只绑定当前编辑的已保存连接，新建草稿没有远端身份。 */
export function resolveEditedMediaConnection(
  connections: MediaSettingsSnapshot['connections'],
  baseline: MediaConnectionDraft | null,
): MediaSettingsSnapshot['connections'][number] | undefined {
  return baseline ? connections.find((connection) => connection.id === baseline.id) : undefined
}

/** Renderer 持有的单个远端素材临时预览。 */
export interface MediaAssetPreview {
  url: string
  contentType: string
}

/** 预览字节读取与 Object URL 生命周期依赖。 */
export interface MediaAssetPreviewDependencies {
  read: (descriptor: MediaRemoteDescriptor) => Promise<{ bytes: Uint8Array; contentType: string }>
  createUrl: (bytes: Uint8Array, contentType: string) => string
  revokeUrl: (url: string) => void
}

/** 释放 Renderer 持有的远端素材 Object URL。 */
export function releaseMediaAssetPreview(
  preview: MediaAssetPreview | null,
  revokeUrl: (url: string) => void,
): void {
  if (preview) revokeUrl(preview.url)
}

/** 显式读取一个远端素材，并在替换或失败前释放旧 Object URL。 */
export async function replaceMediaAssetPreview(
  current: MediaAssetPreview | null,
  descriptor: MediaRemoteDescriptor,
  dependencies: MediaAssetPreviewDependencies,
): Promise<{ preview: MediaAssetPreview | null; error: string | null }> {
  releaseMediaAssetPreview(current, dependencies.revokeUrl)
  try {
    /** Host 验签并限制为 16 MiB 后返回的单个素材字节。 */
    const result = await dependencies.read(descriptor)
    if (!result.contentType.startsWith('image/') && !result.contentType.startsWith('audio/') && !result.contentType.startsWith('video/')) {
      throw new Error('该素材类型不支持预览')
    }
    /** 新 Object URL 只属于当前展开项。 */
    const url = dependencies.createUrl(result.bytes, result.contentType)
    return { preview: { url, contentType: result.contentType }, error: null }
  } catch (error) {
    return { preview: null, error: formatMediaError(error) }
  }
}

/** 只在用户明确点击后读取单个远端素材的预览。 */
function RemoteAssetPreview({ descriptor, name }: { descriptor: MediaRemoteDescriptor; name: string }): React.ReactElement {
  /** 当前组件拥有的 Object URL。 */
  const previewRef = React.useRef<MediaAssetPreview | null>(null)
  /** 当前可见预览。 */
  const [preview, setPreview] = React.useState<MediaAssetPreview | null>(null)
  /** 单个素材读取状态。 */
  const [loading, setLoading] = React.useState(false)
  /** 单个素材读取错误。 */
  const [error, setError] = React.useState<string | null>(null)
  /** 读取代次用于拒绝折叠或切换后的迟到响应。 */
  const requestRevisionRef = React.useRef(0)
  /** 浏览器 Object URL 依赖。 */
  const dependencies = React.useMemo<MediaAssetPreviewDependencies>(() => ({
    read: (target) => window.electronAPI.mediaReadRemoteAsset(target),
    createUrl: (bytes, contentType) => URL.createObjectURL(new Blob([new Uint8Array(bytes).buffer], { type: contentType })),
    revokeUrl: (url) => URL.revokeObjectURL(url),
  }), [])

  React.useEffect(() => () => {
    requestRevisionRef.current += 1
    releaseMediaAssetPreview(previewRef.current, dependencies.revokeUrl)
    previewRef.current = null
  }, [dependencies])

  /** 用户明确请求读取或重新读取当前素材。 */
  const loadPreview = async (): Promise<void> => {
    /** 当前预览读取代次。 */
    const requestRevision = requestRevisionRef.current + 1
    requestRevisionRef.current = requestRevision
    /** 旧 URL 在新请求开始时立即失效。 */
    const current = previewRef.current
    previewRef.current = null
    setPreview(null)
    setLoading(true)
    setError(null)
    /** 单个远端素材的读取结果。 */
    const result = await replaceMediaAssetPreview(current, descriptor, dependencies)
    if (requestRevision !== requestRevisionRef.current) {
      releaseMediaAssetPreview(result.preview, dependencies.revokeUrl)
      return
    }
    previewRef.current = result.preview
    setPreview(result.preview)
    setError(result.error)
    setLoading(false)
  }

  return (
    <div className="space-y-2 border-t border-border/60 p-3">
      {preview?.contentType.startsWith('image/') && <img src={preview.url} alt={name} className="max-h-80 w-full object-contain" />}
      {preview?.contentType.startsWith('audio/') && <audio src={preview.url} controls className="w-full" aria-label={`预览 ${name}`} />}
      {preview?.contentType.startsWith('video/') && <video src={preview.url} controls className="max-h-80 w-full" aria-label={`预览 ${name}`} />}
      {error && <MediaError message={error} />}
      <div className="flex justify-end"><Button type="button" size="sm" variant="outline" disabled={loading} onClick={() => void loadPreview()}>{loading ? <Loader2 className="animate-spin" /> : <Eye />}{preview ? '重新加载预览' : '加载预览'}</Button></div>
    </div>
  )
}

/** 从已有连接创建编辑草稿。 */
function connectionToDraft(connection: MediaSettingsSnapshot['connections'][number]): MediaConnectionDraft {
  return {
    id: connection.id,
    name: connection.name,
    baseUrl: connection.baseUrl,
    enabled: connection.enabled,
    authKind: connection.auth.kind,
    headerName: connection.auth.kind === 'header' ? connection.auth.headerName : '',
    credential: '',
    credentialConfigured: connection.credentialConfigured,
    comfyUser: connection.comfyUser ?? '',
  }
}

/** 从已有工作流创建不污染快照的草稿。 */
function workflowToDraft(workflow: MediaWorkflowVersion, copy = false): MediaWorkflowDraft {
  /** 私有复制必须清除媒体资源身份。 */
  const definition = copy ? redactWorkflowMediaInputs(workflow.definition) : cloneDefinition(workflow.definition)
  return {
    id: copy ? createMediaId('workflow') : workflow.id,
    name: copy ? `${workflow.name} 副本` : workflow.name,
    definitionText: JSON.stringify(definition, null, 2),
    definition,
    invalidated: false,
    parseError: null,
  }
}

/** 设置页字段标签。 */
function FieldLabel({ children }: { children: React.ReactNode }): React.ReactElement {
  return <label className="block min-w-0 space-y-1.5 text-xs font-medium text-foreground">{children}</label>
}

/** 统一错误条。 */
function MediaError({ message, onRetry }: { message: string; onRetry?: () => void }): React.ReactElement {
  return (
    <div role="alert" className="flex items-center gap-2 border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
      <AlertTriangle className="size-4 shrink-0" />
      <span className="min-w-0 flex-1 break-words">{message}</span>
      {onRetry && <Button type="button" size="icon-sm" variant="ghost" aria-label="重试" title="重试" onClick={onRetry}><RefreshCw /></Button>}
    </div>
  )
}

/** 小型空状态。 */
function EmptyState({ children }: { children: React.ReactNode }): React.ReactElement {
  return <div className="px-4 py-8 text-center text-xs text-muted-foreground">{children}</div>
}

/** 三个平级设置页签的可测试视图。 */
export function MediaSettingsTabsView({
  activeTab,
  onTabChange,
  focusActiveTab = false,
}: {
  activeTab: MediaSettingsTab
  onTabChange: (tab: MediaSettingsTab) => void
  /** 用户切页后恢复活动页签焦点，初次进入设置时不抢焦点。 */
  focusActiveTab?: boolean
}): React.ReactElement {
  return (
    <Tabs value={activeTab} onValueChange={(value) => onTabChange(value as MediaSettingsTab)}>
      <TabsList aria-label="媒体配置" className="max-w-full">
        <TabsTrigger value="models" autoFocus={focusActiveTab && activeTab === 'models'}>媒体模型</TabsTrigger>
        <TabsTrigger value="connections" autoFocus={focusActiveTab && activeTab === 'connections'}>服务连接</TabsTrigger>
        <TabsTrigger value="workflows" autoFocus={focusActiveTab && activeTab === 'workflows'}>本地工作流</TabsTrigger>
      </TabsList>
    </Tabs>
  )
}

/** 三个媒体配置页共享的生成授权控件。 */
export function MediaAuthorizationControl({
  mode = 'ask',
  saving,
  disabled = false,
  error,
  onChange,
}: {
  mode?: MediaAuthorizationMode
  saving: boolean
  disabled?: boolean
  error: string | null
  onChange: (mode: MediaAuthorizationMode) => void
}): React.ReactElement {
  /** 当前模式对应的可见标签，确保服务端渲染和加载期间也能明确显示。 */
  const modeLabel = mode === 'automatic' ? 'Agent 自主执行' : '每次确认'
  return (
    <div className="space-y-2 border-y border-border/60 py-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">生成授权</p>
          <p className="mt-0.5 text-xs text-muted-foreground">控制媒体生成和任务所需的工作流创建、保存</p>
        </div>
        <div className="flex w-full shrink-0 items-center gap-2 sm:w-auto">
          {saving && <Loader2 aria-label="正在保存生成授权策略" className="size-4 shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none" />}
          <Select value={mode} disabled={disabled || saving} onValueChange={(value) => onChange(value as MediaAuthorizationMode)}>
            <SelectTrigger aria-label="生成授权策略" className="w-full sm:w-48">
              <SelectValue>{modeLabel}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ask">每次确认</SelectItem>
              <SelectItem value="automatic">Agent 自主执行</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    </div>
  )
}

/** 连接编辑表单。 */
function ConnectionEditor({
  draft,
  baseline,
  busy,
  error,
  onChange,
  onCancel,
  onSave,
}: {
  draft: MediaConnectionDraft
  baseline: MediaConnectionDraft | null
  busy: boolean
  error: string | null
  onChange: (draft: MediaConnectionDraft, identityChanged: boolean) => void
  onCancel: () => void
  onSave: () => void
}): React.ReactElement {
  /** 提交字段变化并报告资源身份是否已经变化。 */
  const update = (patch: Partial<MediaConnectionDraft>): void => {
    /** 应用本次字段变化后的草稿。 */
    const next = { ...draft, ...patch }
    onChange(next, baseline === null || hasMediaConnectionIdentityChanged(baseline, next))
  }
  return (
    <SettingsCard divided={false}>
      <div className="space-y-4 p-4">
        {error && <MediaError message={error} />}
        <div className="grid gap-3 sm:grid-cols-2">
          <FieldLabel>名称<Input value={draft.name} disabled={busy} onChange={(event) => update({ name: event.target.value })} /></FieldLabel>
          <FieldLabel>服务地址<Input value={draft.baseUrl} disabled={busy} placeholder="http://127.0.0.1:8188" onChange={(event) => update({ baseUrl: event.target.value })} /></FieldLabel>
          <FieldLabel>ComfyUI 用户名（可选）<Input value={draft.comfyUser} disabled={busy} onChange={(event) => update({ comfyUser: event.target.value })} /></FieldLabel>
          <FieldLabel>
            认证方式
            <Select value={draft.authKind} disabled={busy} onValueChange={(authKind: MediaConnectionAuth['kind']) => update({ authKind })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">无认证</SelectItem>
                <SelectItem value="bearer">Bearer Token</SelectItem>
                <SelectItem value="header">自定义 Header</SelectItem>
              </SelectContent>
            </Select>
          </FieldLabel>
          {draft.authKind === 'header' && <FieldLabel>Header 名称<Input value={draft.headerName} disabled={busy} placeholder="X-API-Key" onChange={(event) => update({ headerName: event.target.value })} /></FieldLabel>}
          {draft.authKind !== 'none' && (
            <FieldLabel>认证秘密<Input type="password" value={draft.credential} disabled={busy} placeholder={draft.credentialConfigured ? '留空保留现有秘密' : '输入认证秘密'} onChange={(event) => update({ credential: event.target.value })} /></FieldLabel>
          )}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/60 pt-3">
          <label className="flex items-center gap-2 text-xs"><Switch checked={draft.enabled} disabled={busy} onCheckedChange={(enabled) => update({ enabled })} />启用连接</label>
          <div className="ml-auto flex gap-2">
            <Button type="button" size="sm" variant="outline" disabled={busy} onClick={onCancel}>取消</Button>
            <Button type="button" size="sm" disabled={busy} onClick={onSave}>{busy ? <Loader2 className="animate-spin" /> : <Save />}保存连接</Button>
          </div>
        </div>
      </div>
    </SettingsCard>
  )
}

/** 返回字段类型可使用的控件。 */
function controlsForField(field: MediaWorkflowField): MediaWorkflowFieldControlType[] {
  if (field.valueKind === 'boolean') return ['boolean']
  if (field.valueKind === 'number') return ['number', 'seed', 'width', 'height']
  /** 字符串字段先提供文本；只有官方 Loader 精确槽位可提供媒体控件。 */
  const controls: MediaWorkflowFieldControlType[] = ['text']
  if (field.classType === 'LoadImage' && field.input === 'image') controls.push('image')
  if (field.classType === 'LoadAudio' && field.input === 'audio') controls.push('audio')
  if (field.classType === 'LoadVideo' && field.input === 'file') controls.push('video')
  return controls
}

/** 更新一条绑定的字段元数据。 */
function updateBindingMetadata(
  binding: MediaWorkflowBinding,
  patch: Partial<NonNullable<MediaWorkflowBinding['field']>>,
): MediaWorkflowBinding {
  if (!binding.field) return binding
  return { ...binding, field: { ...binding.field, ...patch } }
}

/** 工作流真实节点字段与输出编辑器。 */
function WorkflowDefinitionEditor({
  definition,
  onChange,
}: {
  definition: MediaWorkflowDefinition
  onChange: (definition: MediaWorkflowDefinition) => void
}): React.ReactElement {
  /** API JSON 中的真实输入字段。 */
  const fields = React.useMemo(() => listMediaWorkflowFields(definition.prompt), [definition.prompt])
  /** 当前查看的节点。 */
  const [selectedNodeId, setSelectedNodeId] = React.useState(Object.keys(definition.prompt)[0] ?? '')
  /** 当前节点输入字段。 */
  const visibleFields = fields.filter((field) => field.nodeId === selectedNodeId)
  /** 更新指定绑定。 */
  const updateBinding = (target: MediaWorkflowBinding): void => {
    onChange({ ...definition, bindings: definition.bindings.map((binding) => binding.nodeId === target.nodeId && binding.input === target.input ? target : binding) })
  }
  /** 将绑定在公共表单中的顺序移动一格。 */
  const moveBinding = (binding: MediaWorkflowBinding, direction: -1 | 1): void => {
    /** 当前绑定在全局字段列表中的位置。 */
    const currentIndex = definition.bindings.findIndex((candidate) => candidate.nodeId === binding.nodeId && candidate.input === binding.input)
    /** 移动后的目标位置。 */
    const nextIndex = currentIndex + direction
    if (currentIndex < 0 || nextIndex < 0 || nextIndex >= definition.bindings.length) return
    /** 复制后的绑定顺序。 */
    const bindings = [...definition.bindings]
    const [moved] = bindings.splice(currentIndex, 1)
    if (!moved) return
    bindings.splice(nextIndex, 0, moved)
    onChange({ ...definition, bindings })
  }
  /** 切换一个真实输入是否公开为表单字段。 */
  const toggleField = (field: MediaWorkflowField, checked: boolean): void => {
    if (!checked) {
      onChange({ ...definition, bindings: definition.bindings.filter((binding) => binding.nodeId !== field.nodeId || binding.input !== field.input) })
      return
    }
    onChange({ ...definition, bindings: [...definition.bindings, createMediaWorkflowFieldBinding(field)] })
  }
  /** 新增一个必须由用户补全的输出选择器。 */
  const addOutput = (): void => {
    /** 首个真实节点 ID。 */
    const nodeId = Object.keys(definition.prompt)[0] ?? ''
    /** 新输出的稳定序号。 */
    const index = definition.outputs.length + 1
    onChange({ ...definition, outputs: [...definition.outputs, { key: `output-${index}`, nodeId, outputIndex: 0, mediaType: 'image' }] })
  }
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)]">
      <div className="space-y-3">
        <FieldLabel>
          节点
          <Select value={selectedNodeId} onValueChange={setSelectedNodeId}>
            <SelectTrigger><SelectValue placeholder="选择节点" /></SelectTrigger>
            <SelectContent>{Object.entries(definition.prompt).map(([nodeId, node]) => <SelectItem key={nodeId} value={nodeId}>{node._meta?.title || node.class_type} · {nodeId}</SelectItem>)}</SelectContent>
          </Select>
        </FieldLabel>
        <div className="border border-border/60">
          {visibleFields.length === 0 ? <EmptyState>该节点没有输入字段</EmptyState> : visibleFields.map((field) => {
            /** 当前字段已有的绑定。 */
            const binding = definition.bindings.find((candidate) => candidate.nodeId === field.nodeId && candidate.input === field.input)
            return (
              <div key={`${field.nodeId}:${field.input}`} className="space-y-2 border-b border-border/60 p-3 last:border-b-0">
                <label className="flex items-start gap-2 text-xs">
                  <input type="checkbox" className="mt-0.5" checked={binding !== undefined} disabled={!field.editable} onChange={(event) => toggleField(field, event.target.checked)} />
                  <span className="min-w-0"><span className="block font-medium">{field.input}</span><span className="block break-words text-muted-foreground">默认值：{JSON.stringify(field.value)}{field.reason ? ` · ${field.reason}` : ''}</span></span>
                </label>
                {binding?.field && (
                  <div className="grid gap-2 sm:grid-cols-2">
                    <FieldLabel>字段 Key<Input value={binding.key} onChange={(event) => updateBinding({ ...binding, key: event.target.value })} /></FieldLabel>
                    <FieldLabel>标签<Input value={binding.field.label} onChange={(event) => updateBinding(updateBindingMetadata(binding, { label: event.target.value }))} /></FieldLabel>
                    <FieldLabel>
                      控件
                      <Select value={binding.field.controlType} onValueChange={(controlType: MediaWorkflowFieldControlType) => {
                        /** 由共享函数重新建立一致的 kind、loader 与元数据。 */
                        const recreated = createMediaWorkflowFieldBinding(field, controlType)
                        updateBinding({ ...recreated, key: binding.key, field: { ...recreated.field!, label: binding.field?.label ?? field.input, required: binding.field?.required ?? true } })
                      }}>
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>{controlsForField(field).map((control) => <SelectItem key={control} value={control}>{control}</SelectItem>)}</SelectContent>
                      </Select>
                    </FieldLabel>
                    <label className="flex items-center gap-2 self-end pb-2 text-xs"><input type="checkbox" checked={binding.field.required} onChange={(event) => updateBinding(updateBindingMetadata(binding, { required: event.target.checked }))} />必填</label>
                    <div className="flex items-center justify-end gap-1 sm:col-span-2"><Button type="button" size="icon-sm" variant="ghost" aria-label={`上移字段 ${binding.field.label}`} title="上移" onClick={() => moveBinding(binding, -1)}><ArrowUp /></Button><Button type="button" size="icon-sm" variant="ghost" aria-label={`下移字段 ${binding.field.label}`} title="下移" onClick={() => moveBinding(binding, 1)}><ArrowDown /></Button></div>
                    {binding.field.valueKind === 'number' && (['number', 'seed', 'width', 'height'] as const).includes(binding.field.controlType as 'number' | 'seed' | 'width' | 'height') && (
                      <div className="grid grid-cols-3 gap-2 sm:col-span-2">
                        <FieldLabel>最小值<Input type="number" value={binding.field.min ?? ''} onChange={(event) => updateBinding(updateBindingMetadata(binding, { min: event.target.value === '' ? undefined : Number(event.target.value) }))} /></FieldLabel>
                        <FieldLabel>最大值<Input type="number" value={binding.field.max ?? ''} onChange={(event) => updateBinding(updateBindingMetadata(binding, { max: event.target.value === '' ? undefined : Number(event.target.value) }))} /></FieldLabel>
                        <FieldLabel>步长<Input type="number" value={binding.field.step ?? ''} onChange={(event) => updateBinding(updateBindingMetadata(binding, { step: event.target.value === '' ? undefined : Number(event.target.value) }))} /></FieldLabel>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>
      <div className="space-y-3">
        <div className="flex items-center justify-between gap-3"><span className="text-xs font-medium">输出节点</span><Button type="button" size="sm" variant="outline" onClick={addOutput}><Plus />添加输出</Button></div>
        {definition.outputs.length === 0 ? <div className="border border-border/60"><EmptyState>至少选择一个输出节点</EmptyState></div> : definition.outputs.map((output, outputPosition) => {
          /** 替换当前位置输出的函数。 */
          const updateOutput = (patch: Partial<MediaWorkflowOutputSelector>): void => {
            onChange({ ...definition, outputs: definition.outputs.map((candidate, index) => index === outputPosition ? { ...candidate, ...patch } : candidate) })
          }
          return (
            <div key={`${outputPosition}:${output.key}`} className="grid gap-2 border border-border/60 p-3 sm:grid-cols-2">
              <FieldLabel>输出 Key<Input value={output.key} onChange={(event) => updateOutput({ key: event.target.value })} /></FieldLabel>
              <FieldLabel>媒体类型<Select value={output.mediaType} onValueChange={(mediaType: MediaWorkflowOutputSelector['mediaType']) => updateOutput({ mediaType })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="image">图片</SelectItem><SelectItem value="audio">音频</SelectItem><SelectItem value="video">视频</SelectItem></SelectContent></Select></FieldLabel>
              <FieldLabel>节点<Select value={output.nodeId} onValueChange={(nodeId) => updateOutput({ nodeId })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{Object.entries(definition.prompt).map(([nodeId, node]) => <SelectItem key={nodeId} value={nodeId}>{node._meta?.title || node.class_type} · {nodeId}</SelectItem>)}</SelectContent></Select></FieldLabel>
              <FieldLabel>输出索引<Input type="number" min={0} step={1} value={output.outputIndex} onChange={(event) => updateOutput({ outputIndex: Number(event.target.value) })} /></FieldLabel>
              <div className="flex justify-end sm:col-span-2"><Button type="button" size="sm" variant="ghost" onClick={() => onChange({ ...definition, outputs: definition.outputs.filter((_, index) => index !== outputPosition) })}><Trash2 />移除输出</Button></div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** 公共工作流编辑表单。 */
function WorkflowEditor({
  draft,
  busy,
  error,
  onChange,
  onCancel,
  onSave,
  onSaveAndOpen,
}: {
  draft: MediaWorkflowDraft
  busy: boolean
  error: string | null
  onChange: (draft: MediaWorkflowDraft) => void
  onCancel: () => void
  onSave: () => void
  onSaveAndOpen?: () => void
}): React.ReactElement {
  /** 解析当前 JSON 并使字段与输出编辑器重新生效。 */
  const applyJson = (): void => {
    /** 严格解析后的定义。 */
    const definition = parseMediaWorkflowImportText(draft.definitionText)
    onChange({ ...draft, definition, invalidated: false, parseError: null, definitionText: JSON.stringify(definition, null, 2) })
  }
  /** 导入并解析本地 API JSON 文件。 */
  const importFile = async (file: File): Promise<void> => {
    try {
      if (file.size > MEDIA_WORKFLOW_IMPORT_MAX_BYTES) throw new Error('工作流文件不能超过 2 MiB')
      /** 文件中严格解析后的定义。 */
      const definition = parseMediaWorkflowImportText(await file.text())
      onChange({ ...draft, definition, definitionText: JSON.stringify(definition, null, 2), invalidated: false, parseError: null })
    } catch (importError) {
      onChange({ ...draft, definition: null, invalidated: true, parseError: formatMediaError(importError) })
    }
  }
  /** 字段绑定校验问题。 */
  const issues = draft.definition ? validateMediaWorkflowFieldBindings(draft.definition) : []
  /** 保存是否被 JSON 或结构校验阻断。 */
  const saveDisabled = busy || draft.invalidated || draft.definition === null || issues.length > 0 || draft.definition.outputs.length === 0
  return (
    <SettingsCard divided={false}>
      <div className="space-y-4 p-4">
        {error && <MediaError message={error} />}
        {draft.invalidated && <MediaError message="JSON 已变化，请重新解析。现有字段与输出映射已失效，保存已阻止。" />}
        {draft.parseError && <MediaError message={draft.parseError} />}
        {issues[0] && <MediaError message={issues[0].message} />}
        <FieldLabel>工作流名称<Input value={draft.name} disabled={busy} onChange={(event) => onChange({ ...draft, name: event.target.value })} /></FieldLabel>
        <div className="space-y-1.5">
          <div className="flex flex-wrap items-center justify-between gap-2"><span className="text-xs font-medium">ComfyUI API JSON</span><div className="flex gap-2"><label className="inline-flex h-8 cursor-pointer items-center gap-2 rounded-md border border-border/60 bg-background px-3 text-xs hover:bg-muted/50"><FileJson className="size-4" />导入 JSON<input className="sr-only" type="file" accept="application/json,.json" disabled={busy} onChange={(event) => { const file = event.target.files?.[0]; if (file) void importFile(file); event.target.value = '' }} /></label><Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => {
            try { applyJson() } catch (applyError) { onChange({ ...draft, definition: null, invalidated: true, parseError: formatMediaError(applyError) }) }
          }}><FileJson />解析 JSON</Button></div></div>
          <Textarea className="min-h-56 font-mono text-xs" value={draft.definitionText} disabled={busy} spellCheck={false} onChange={(event) => onChange({ ...draft, definitionText: event.target.value, invalidated: true, parseError: null })} />
        </div>
        {draft.definition && !draft.invalidated && <WorkflowDefinitionEditor definition={draft.definition} onChange={(definition) => onChange({ ...draft, definition, definitionText: JSON.stringify(definition, null, 2), parseError: null })} />}
        <div className="flex flex-wrap justify-end gap-2 border-t border-border/60 pt-3">
          <Button type="button" size="sm" variant="outline" disabled={busy} onClick={onCancel}>取消</Button>
          {onSaveAndOpen && <Button type="button" size="sm" variant="outline" disabled={saveDisabled} onClick={onSaveAndOpen}>保存并查看画布</Button>}
          <Button type="button" size="sm" disabled={saveDisabled} onClick={onSave}>{busy ? <Loader2 className="animate-spin" /> : <Save />}保存工作流</Button>
        </div>
      </div>
    </SettingsCard>
  )
}

/** 展示完整工作流正文；UI/未知格式只预览，API 格式才提供显式导入入口。 */
export function RemoteWorkflowContent({ remote, onImport }: {
  remote: MediaRemoteWorkflow
  onImport: () => void
}): React.ReactElement {
  /** 仅在正文变化时序列化，保留节点、连线及未知扩展字段。 */
  const definitionText = React.useMemo(() => JSON.stringify(remote.definition, null, 2), [remote.definition])
  /** 完整正文的复制反馈。 */
  const [copied, setCopied] = React.useState(false)
  /** 复制或导入错误属于当前详情，不污染资源目录的读取状态。 */
  const [error, setError] = React.useState<string | null>(null)
  /** 格式识别只决定导入能力，不阻止查看原始内容。 */
  const formatLabel = remote.format === 'ui' ? 'ComfyUI UI 格式' : remote.format === 'api' ? 'ComfyUI API 格式' : '未识别格式'
  /** 主进程分析结果同时决定状态、错误展示和导入能力。 */
  const analysis = remote.analysis
  const canImport = analysis ? analysis.definition !== null && analysis.convertible : remote.format === 'api'
  const analysisLabel = analysis
    ? canImport ? '已转换并通过校验' : '暂不可导入'
    : remote.format === 'api' ? '尚未执行远端兼容性分析' : '仅预览'
  /** 使用现有跨平台剪贴板封装复制完整 JSON，并报告失败。 */
  const copyDefinition = async (): Promise<void> => {
    setError(null)
    try {
      await copyTextToClipboard(definitionText)
      setCopied(true)
    } catch (copyError) {
      setError(formatMediaError(copyError))
    }
  }
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 px-4 py-2">
        <span className="text-xs text-muted-foreground">{formatLabel} · {analysisLabel}</span>
        <Button type="button" size="icon-sm" variant="ghost" aria-label="复制完整工作流 JSON" title={copied ? '已复制' : '复制完整工作流 JSON'} onClick={() => void copyDefinition()}>{copied ? <Check /> : <Copy />}</Button>
      </div>
      {error && <div className="px-3 pb-2"><MediaError message={error} /></div>}
      {analysis && analysis.issues.length > 0 && (
        <div className="max-h-40 shrink-0 space-y-1 overflow-y-auto border-y border-border/60 bg-muted/20 px-4 py-2" aria-label="工作流分析问题">
          {analysis.issues.map((issue, index) => (
            <div key={`${issue.code}-${issue.nodeId ?? ''}-${issue.input ?? ''}-${index}`} className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
              <span className="font-mono text-foreground">{issue.code}</span>
              {issue.nodeId && <span> · 节点 {issue.nodeId}</span>}
              {issue.input && <span> · 字段 {issue.input}</span>}
              <span>：{issue.message}</span>
            </div>
          ))}
        </div>
      )}
      <JsonCodeEditor value={definitionText} className="min-h-0 flex-1 border-y border-border/60" />
      <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 px-4 py-3">
        {canImport ? (
          <Button type="button" size="sm" variant="outline" onClick={() => {
            setError(null)
            try { onImport() } catch (importError) { setError(formatMediaError(importError)) }
          }}><Copy />另存为本地工作流</Button>
        ) : <span className="text-xs text-muted-foreground">{analysis?.issues[0]?.message ?? (remote.format === 'ui' ? '当前 UI 工作流暂不可导入，请查看分析问题。' : '无法确认工作流格式，暂不可导入为可执行模板。')}</span>}
      </div>
    </div>
  )
}

/** 打开弹窗时按 descriptor 读取单个工作流；关闭、换页或换连接后忽略迟到响应。 */
function RemoteWorkflowPreview({ descriptor, onImport }: {
  descriptor: MediaRemoteDescriptor
  onImport: (remote: MediaRemoteWorkflow) => void
}): React.ReactElement {
  /** 当前详情读取到的完整正文。 */
  const [remote, setRemote] = React.useState<MediaRemoteWorkflow | null>(null)
  /** 正文读取错误独立于目录查询，重试只读取当前文件。 */
  const [error, setError] = React.useState<string | null>(null)
  /** 用户显式重试时重新发起读取。 */
  const [attempt, setAttempt] = React.useState(0)
  React.useEffect(() => {
    /** 只有本次挂载的请求可以更新预览。 */
    let active = true
    setRemote(null)
    setError(null)
    void window.electronAPI.mediaReadRemoteWorkflow(descriptor).then((result) => {
      if (active) setRemote(result)
    }).catch((readError: unknown) => {
      if (active) setError(formatMediaError(readError))
    })
    return () => { active = false }
  }, [descriptor, attempt])
  if (error) return <div className="p-3"><MediaError message={error} onRetry={() => setAttempt((current) => current + 1)} /></div>
  if (!remote) return <div role="status" className="flex items-center gap-2 p-3 text-xs text-muted-foreground"><Loader2 className="size-4 animate-spin" />正在读取工作流内容...</div>
  return <RemoteWorkflowContent remote={remote} onImport={() => onImport(remote)} />
}

/** 连接下方的四类远端资源浏览器。 */
function ResourceBrowser({
  connection,
  locked,
  probe,
  onProbe,
  onImportWorkflow,
}: {
  connection: MediaSettingsSnapshot['connections'][number] | undefined
  locked: boolean
  probe: MediaConnectionProbe | null
  onProbe: (connectionId: string) => Promise<void>
  onImportWorkflow: (remote: MediaRemoteWorkflow, name: string) => void
}): React.ReactElement {
  /** 资源查询条件在切换页面时保持。 */
  const [state, setState] = React.useState<MediaResourceBrowserState>({ connectionId: connection?.id ?? '', kind: 'models', query: '', folder: '', offset: 0 })
  /** 当前权威资源页。 */
  const [page, setPage] = React.useState<MediaResourcePage | null>(null)
  /** 独立保存已验证的模型目录，翻页与搜索清空结果时保持左侧导航稳定。 */
  const [modelFolders, setModelFolders] = React.useState<string[]>([])
  /** 当前详情资源 ID，工作流使用弹窗，其它资源保留行内详情。 */
  const [selectedId, setSelectedId] = React.useState<string | null>(null)
  /** 记录实际点击的条目，关闭弹窗后恢复键盘焦点与列表位置。 */
  const detailTriggerRef = React.useRef<HTMLButtonElement | null>(null)
  /** 查询错误。 */
  const [error, setError] = React.useState<string | null>(null)
  /** 查询加载状态。 */
  const [loading, setLoading] = React.useState(false)
  /** 查询代次用于拒绝迟到响应。 */
  const requestRevisionRef = React.useRef(0)
  /** 始终指向最新筛选，避免防抖回调读取旧闭包。 */
  const stateRef = React.useRef(state)
  stateRef.current = state
  /** 失败时读取最新成功快照，且不让快照变化重建加载函数。 */
  const pageRef = React.useRef(page)
  pageRef.current = page
  React.useEffect(() => {
    if (!locked) return
    requestRevisionRef.current += 1
    setPage(null)
    setModelFolders([])
    setSelectedId(null)
    setError(null)
  }, [locked])

  /** 改变筛选并立即移除旧页。 */
  const changeFilters = (patch: Partial<Omit<MediaResourceBrowserState, 'offset'>>): void => {
    requestRevisionRef.current += 1
    setLoading(false)
    /** 统一的筛选迁移结果。 */
    const transition = changeMediaResourceFilters(state, patch)
    setState(transition.resourceState)
    setPage(transition.resourcePage)
    setSelectedId(transition.selectedResourceId)
    setError(null)
  }
  /** 分页读取当前资源类别；普通读取只访问本地快照。 */
  const load = React.useCallback(async (refresh = false, offset = stateRef.current.offset): Promise<void> => {
    /** 发起请求时的最新筛选快照。 */
    const currentState = stateRef.current
    if (!currentState.connectionId || locked) return
    /** 当前请求条件快照。 */
    const requestState = { ...currentState, offset }
    /** 当前请求代次。 */
    const requestRevision = requestRevisionRef.current + 1
    requestRevisionRef.current = requestRevision
    setLoading(true)
    setError(null)
    try {
      /** 当前页的远端结果。 */
      const result = await window.electronAPI.mediaListResources(createMediaResourceQuery(requestState, refresh, offset))
      if (!isCurrentMediaResourceRequest(requestRevision, requestRevisionRef.current)) return
      setPage(result)
      if (requestState.kind === 'models') setModelFolders(getMediaResourceModelFolders(result))
      setState((current) => ({ ...current, offset }))
      setSelectedId(null)
    } catch (loadError) {
      if (isCurrentMediaResourceRequest(requestRevision, requestRevisionRef.current)) {
        /** 同步失败不能清空用户仍可使用的旧快照。 */
        const failure = retainMediaResourcePageAfterFailure(pageRef.current, loadError)
        setPage(failure.page)
        setError(failure.error)
      }
    } finally {
      if (isCurrentMediaResourceRequest(requestRevision, requestRevisionRef.current)) setLoading(false)
    }
  }, [locked])
  /** 首次进入及筛选变化自动读取本地快照，搜索输入合并为一次请求。 */
  React.useEffect(() => {
    if (locked || !state.connectionId) return
    const timeout = window.setTimeout(() => void load(false, 0), getMediaResourceAutoLoadDelay(state.query))
    return () => window.clearTimeout(timeout)
  }, [load, locked, state.connectionId, state.folder, state.kind, state.query])
  /** 当前展开资源。 */
  const selected = page?.items.find((item) => item.id === selectedId)
  /** 四类资源标签。 */
  const resourceLabels: Readonly<Record<MediaResourceKind, string>> = { models: '模型', nodes: '工作节点', workflows: '工作流', assets: '资源库' }
  /** 空筛选时后端读取首个真实模型目录，左侧选中态必须对应同一目录。 */
  const selectedModelFolder = state.folder || modelFolders[0] || ''
  /** 快照时间来自上次成功同步，失败重试不会改写。 */
  const snapshotTime = page?.checkedAt ? new Date(page.checkedAt).toLocaleString() : null
  /** 当前页的真实来源与时间语义。 */
  const pageStatus = getMediaResourcePageStatus(page, state.kind)
  /** 接口不可用或降级时的用户可见原因。 */
  const capabilityMessage = page?.syncError ? null : getMediaResourceCapabilityMessage(page, state.kind)
  /** 资源库保持实时查询，其它目录才使用同步语义。 */
  const refreshLabel = state.kind === 'assets' ? '刷新资源库' : `同步${resourceLabels[state.kind]}`
  /** 同步失败时准确描述当前保留的数据来源。 */
  const syncErrorMessage = page?.syncError && page.syncError !== 'available'
    ? state.kind === 'assets'
      ? `刷新失败，正在显示上次查询结果：${formatMediaRemoteCapability(page.syncError)}`
      : `同步失败，正在显示上次本地快照：${formatMediaRemoteCapability(page.syncError)}`
    : null
  return (
    <div className="space-y-3">
      <h3 className="text-sm font-medium">资源快照</h3>
      <SettingsCard divided={false}>
        <div className="space-y-3 p-4">
          {locked && <MediaError message="连接尚未保存或地址、认证已变化。保存后才能读取该连接的资源。" />}
          <div className="flex flex-wrap items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-sm font-medium">{connection?.name ?? '保存连接后可查看资源'}</span>
            {!locked && probe?.connectionId === state.connectionId && <span className="text-xs text-muted-foreground">连接正常</span>}
            <Button type="button" size="sm" variant="outline" disabled={locked || !state.connectionId} onClick={() => void onProbe(state.connectionId)}><TestTube2 />测试连接</Button>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Tabs value={state.kind} onValueChange={(kind) => changeFilters({ kind: kind as MediaResourceKind, folder: '' })}>
              <TabsList aria-label="资源类型" className="max-w-full">{(Object.keys(resourceLabels) as MediaResourceKind[]).map((kind) => <TabsTrigger key={kind} value={kind}>{resourceLabels[kind]}</TabsTrigger>)}</TabsList>
            </Tabs>
            <div className="ml-auto flex min-w-0 max-w-full items-center gap-2">
              <div className="relative min-w-0 w-64"><Search className="pointer-events-none absolute left-3 top-2.5 size-4 text-muted-foreground" /><Input className="pl-9" value={state.query} placeholder="搜索当前资源" disabled={locked} onChange={(event) => changeFilters({ query: event.target.value })} /></div>
              <Button type="button" size="icon" variant="outline" className="shrink-0" disabled={locked || loading || !state.connectionId} aria-label={refreshLabel} title={refreshLabel} onClick={() => void load(true, 0)}>{loading ? <Loader2 className="animate-spin" /> : <RefreshCw />}</Button>
            </div>
          </div>
          {(pageStatus || state.kind === 'models') && <div className="flex min-h-4 flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground"><span>{pageStatus?.sourceLabel}</span>{pageStatus && snapshotTime && <span>{pageStatus.timeLabel}：{snapshotTime}</span>}</div>}
          {syncErrorMessage && <MediaError message={syncErrorMessage} />}
          {capabilityMessage && <MediaError message={capabilityMessage} />}
          {error && <MediaError message={error} onRetry={() => void load(false)} />}
        </div>
        <div className={cn('border-t border-border/60', state.kind === 'models' && 'grid h-[32rem] grid-cols-[minmax(8rem,24%)_minmax(0,1fr)]')}>
          {state.kind === 'models' && (
            <aside className="flex min-h-0 min-w-0 flex-col border-r border-border/60 bg-muted/10">
              <h4 className="flex h-10 shrink-0 items-center border-b border-border/60 px-3 text-xs font-medium text-muted-foreground">模型目录</h4>
              <nav aria-label="模型目录" className="min-h-0 flex-1 space-y-1 overflow-y-auto p-2">
                {!locked && modelFolders.length > 0 ? modelFolders.map((folder) => (
                  <button
                    key={folder}
                    type="button"
                    aria-current={folder === selectedModelFolder ? 'true' : undefined}
                    title={folder}
                    className={cn('flex min-h-9 w-full items-start gap-2 rounded-md px-2 py-2 text-left text-xs transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring', folder === selectedModelFolder ? 'bg-accent font-medium text-accent-foreground' : 'text-muted-foreground hover:text-foreground')}
                    onClick={() => { if (folder !== selectedModelFolder) changeFilters({ folder }) }}
                  >
                    <Folder className="size-4 shrink-0" aria-hidden="true" />
                    <span className="min-w-0 break-all leading-4">{folder}</span>
                  </button>
                )) : <p className="px-2 py-4 text-xs text-muted-foreground">{locked ? '保存后可查看目录' : loading ? '正在读取目录...' : '暂无模型目录'}</p>}
              </nav>
            </aside>
          )}
          <div className={cn('min-w-0', state.kind === 'models' && 'flex min-h-0 flex-col')}>
            {state.kind === 'models' && <h4 className="flex h-10 shrink-0 items-center border-b border-border/60 px-4 text-xs font-medium"><span className="min-w-0 truncate" title={locked ? undefined : selectedModelFolder}>{!locked && selectedModelFolder ? selectedModelFolder : '模型'}</span></h4>}
            <div className={cn(state.kind === 'models' && 'min-h-0 flex-1 overflow-y-auto')}>
              {locked || !page ? <EmptyState>{connection ? loading ? state.kind === 'assets' ? '正在查询远端资源...' : '正在读取资源快照...' : state.kind === 'assets' ? '暂无远端资源，点击刷新后获取' : '暂无资源快照，点击同步后获取' : '先保存当前服务连接'}</EmptyState> : page.items.length === 0 ? <EmptyState>{state.kind === 'assets' ? '没有匹配的远端资源' : '快照中没有匹配的资源'}</EmptyState> : (
                <div>
                  {page.items.map((item) => (
                    <div key={item.id} className="border-b border-border/60 last:border-b-0">
                      <button type="button" aria-haspopup={state.kind === 'workflows' ? 'dialog' : undefined} aria-expanded={selected?.id === item.id} className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-muted/30" onClick={(event) => {
                        detailTriggerRef.current = event.currentTarget
                        setSelectedId((current) => state.kind === 'workflows' ? item.id : current === item.id ? null : item.id)
                      }}>
                        <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{item.name}</span><span className="block truncate text-xs text-muted-foreground">{item.category || '未分类'}</span></span>
                        <span className={cn('text-[11px]', item.supported ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground')}>{item.supported ? '已支持' : '只读'}</span>
                      </button>
                      {state.kind !== 'workflows' && selected?.id === item.id && (
                        <div className="border-t border-border/60 bg-muted/20">
                          <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words p-3 text-[11px] leading-5 text-muted-foreground">{JSON.stringify(item.schema ?? item.metadata ?? item.descriptor ?? {}, null, 2)}</pre>
                          {state.kind === 'assets' && item.descriptor && <RemoteAssetPreview key={item.id} descriptor={item.descriptor} name={item.name} />}
                        </div>
                      )}
                    </div>
                  ))}
                  <div className="flex items-center justify-between px-4 py-3 text-xs text-muted-foreground">
                    <span>{state.offset + 1}-{Math.min(state.offset + page.items.length, page.total)} / {page.total}</span>
                    <div className="flex gap-1"><Button type="button" size="icon-sm" variant="ghost" disabled={loading || state.offset === 0} aria-label="上一页" onClick={() => void load(false, Math.max(0, state.offset - 50))}><ChevronLeft /></Button><Button type="button" size="icon-sm" variant="ghost" disabled={loading || page.nextOffset === null} aria-label="下一页" onClick={() => { if (page.nextOffset !== null) void load(false, page.nextOffset) }}><ChevronRight /></Button></div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </SettingsCard>
      <Dialog open={!locked && state.kind === 'workflows' && Boolean(selected)} onOpenChange={(open) => { if (!open) setSelectedId(null) }}>
        <DialogContent
          className="flex h-[min(80vh,48rem)] w-[calc(100vw-2rem)] max-w-5xl flex-col gap-0 overflow-hidden rounded-lg p-0"
          aria-describedby={undefined}
          onCloseAutoFocus={(event) => {
            if (!detailTriggerRef.current?.isConnected) return
            event.preventDefault()
            detailTriggerRef.current.focus({ preventScroll: true })
          }}
        >
          <DialogHeader className="shrink-0 border-b border-border/60 px-4 py-4 pr-12 text-left">
            <DialogTitle className="truncate text-sm tracking-normal" title={selected?.name}>{selected?.name ?? '工作流详情'}</DialogTitle>
          </DialogHeader>
          {!locked && state.kind === 'workflows' && selected && (selected.descriptor ? (
            <RemoteWorkflowPreview key={`${page?.snapshotId}:${selected.id}`} descriptor={selected.descriptor} onImport={(remote) => onImportWorkflow(remote, selected.name)} />
          ) : <div className="p-4"><MediaError message="工作流缺少有效的文件标识，请同步工作流列表后重试。" /></div>)}
        </DialogContent>
      </Dialog>
    </div>
  )
}

/** 统一媒体设置页。 */
/** 从配置历史中选择用户主动保存的最新本地模板，不展示内部快照或迁移旧项目数据。 */
export function selectLocalMediaWorkflows(workflows: readonly MediaWorkflowVersion[], archivedIds: readonly string[] = []): MediaWorkflowVersion[] {
  /** 同一模板只展示最新修订，完整历史继续供已绑定卡片和任务恢复。 */
  const latest = new Map<string, MediaWorkflowVersion>()
  for (const workflow of workflows) {
    if (workflow.projectId !== null || workflow.remoteSource || archivedIds.includes(workflow.id)) continue
    /** 已收集的旧修订。 */
    const current = latest.get(workflow.id)
    if (!current || workflow.revision > current.revision) latest.set(workflow.id, workflow)
  }
  return [...latest.values()]
}

export function MediaSettings({ onOpenWorkflowInCanvas }: MediaSettingsProps = {}): React.ReactElement {
  /** 当前平级页签；草稿位于父级，因此切换不丢失。 */
  const [activeTab, setActiveTab] = React.useState<MediaSettingsTab>('models')
  /** 只为用户发起的切页恢复焦点，避免导航随各页标题重挂载后中断键盘操作。 */
  const restoreTabFocusRef = React.useRef(false)
  React.useEffect(() => { restoreTabFocusRef.current = false }, [activeTab])
  /** 各列表的搜索独立保存，不影响编辑草稿。 */
  const [connectionQuery, setConnectionQuery] = React.useState('')
  const [workflowQuery, setWorkflowQuery] = React.useState('')
  /** 服务端权威媒体配置。 */
  const [snapshot, setSnapshot] = React.useState<MediaSettingsSnapshot | null>(null)
  /** 初次加载状态。 */
  const [loading, setLoading] = React.useState(true)
  /** 页面读取错误。 */
  const [loadError, setLoadError] = React.useState<string | null>(null)
  /** 当前互斥动作名称。 */
  const [busyAction, setBusyAction] = React.useState<string | null>(null)
  /** 生成授权保存失败独立显示，不污染连接或工作流草稿。 */
  const [authorizationError, setAuthorizationError] = React.useState<string | null>(null)
  /** 连接独立草稿。 */
  const [connectionDraft, setConnectionDraft] = React.useState<MediaConnectionDraft | null>(null)
  /** 连接编辑基线。 */
  const [connectionBaseline, setConnectionBaseline] = React.useState<MediaConnectionDraft | null>(null)
  /** 草稿是否阻止读取旧资源。 */
  const [resourcesLocked, setResourcesLocked] = React.useState(false)
  /** 公共工作流独立草稿。 */
  const [workflowDraft, setWorkflowDraft] = React.useState<MediaWorkflowDraft | null>(null)
  /** 表单错误。 */
  const [formError, setFormError] = React.useState<string | null>(null)
  /** 最近连接探测结果。 */
  const [probe, setProbe] = React.useState<MediaConnectionProbe | null>(null)
  /** 待归档条目。 */
  const [archiveTarget, setArchiveTarget] = React.useState<ArchiveTarget | null>(null)
  /** 旧入口聚焦意图。 */
  const [focusedSection, setFocusedSection] = useAtom(mediaSettingsFocusAtom)

  /** 读取权威配置，失败时保留已显示内容。 */
  const loadSettings = React.useCallback(async (): Promise<void> => {
    setLoadError(null)
    try { setSnapshot(await window.electronAPI.mediaGetSettings()) } catch (error) { setLoadError(formatMediaError(error)) } finally { setLoading(false) }
  }, [])

  React.useEffect(() => { void loadSettings() }, [loadSettings])
  React.useEffect(() => {
    if (focusedSection !== 'image-models') return
    setActiveTab('models')
    setFocusedSection(null)
  }, [focusedSection, setFocusedSection])

  /** 使用当前配置 revision 保存生成授权，失败后刷新权威快照以消解并发修改。 */
  const saveAuthorizationMode = async (mode: MediaAuthorizationMode): Promise<void> => {
    /** 缺失字段兼容旧配置，默认按每次确认处理。 */
    const currentMode = snapshot?.authorizationMode ?? 'ask'
    if (!snapshot || busyAction || mode === currentMode) return
    setBusyAction('authorization-save')
    setAuthorizationError(null)
    try {
      setSnapshot(await window.electronAPI.mediaSaveAuthorizationMode(mode, snapshot.revision))
    } catch (error) {
      setAuthorizationError(formatMediaError(error))
      setLoadError(null)
      try {
        /** 保存失败可能来自 revision 冲突，重新读取后继续展示真实配置。 */
        setSnapshot(await window.electronAPI.mediaGetSettings())
      } catch (refreshError) {
        setLoadError(formatMediaError(refreshError))
      }
    } finally {
      setBusyAction(null)
    }
  }

  /** 保存连接并只在成功后替换权威列表。 */
  const saveConnection = async (): Promise<void> => {
    if (!snapshot || !connectionDraft || busyAction) return
    setBusyAction('connection-save')
    setFormError(null)
    try {
      /** 清洗后的全局连接输入。 */
      const input = buildSaveMediaConnectionInput(connectionDraft)
      setSnapshot(await window.electronAPI.mediaSaveConnection(input, snapshot.revision))
      setConnectionDraft(null)
      setConnectionBaseline(null)
      setResourcesLocked(false)
    } catch (error) { setFormError(formatMediaError(error)) } finally { setBusyAction(null) }
  }

  /** 探测指定全局连接。 */
  const probeConnection = async (connectionId: string): Promise<void> => {
    if (busyAction) return
    setBusyAction(`probe:${connectionId}`)
    setFormError(null)
    try { setProbe(await window.electronAPI.mediaProbeConnection(connectionId)) } catch (error) { setFormError(formatMediaError(error)) } finally { setBusyAction(null) }
  }

  /** 仅切换启用状态，沿用同一连接身份与配置 revision。 */
  const toggleConnection = async (connection: MediaSettingsSnapshot['connections'][number], enabled: boolean): Promise<void> => {
    if (!snapshot || busyAction) return
    setBusyAction(`toggle:${connection.id}`)
    setFormError(null)
    try {
      const input = buildSaveMediaConnectionInput({ ...connectionToDraft(connection), enabled })
      setSnapshot(await window.electronAPI.mediaSaveConnection(input, snapshot.revision))
    } catch (error) { setFormError(formatMediaError(error)) } finally { setBusyAction(null) }
  }

  /** 保存工作流，可选在成功后请求画布导航。 */
  const saveWorkflow = async (openCanvas: boolean): Promise<void> => {
    if (!snapshot || !workflowDraft || busyAction) return
    setBusyAction('workflow-save')
    setFormError(null)
    try {
      /** 已验证的公共工作流输入。 */
      const input = buildSaveMediaWorkflowInput(workflowDraft)
      /** 保存后的权威快照。 */
      const nextSnapshot = await window.electronAPI.mediaSaveWorkflow(input, snapshot.revision)
      setSnapshot(nextSnapshot)
      setWorkflowDraft(null)
      if (openCanvas && onOpenWorkflowInCanvas) {
        /** 当前 ID 的最新保存版本。 */
        const saved = nextSnapshot.workflows.filter((workflow) => workflow.id === input.id).sort((left, right) => right.revision - left.revision)[0]
        if (saved) onOpenWorkflowInCanvas({ workflowId: saved.id, revision: saved.revision })
      }
    } catch (error) { setFormError(formatMediaError(error)) } finally { setBusyAction(null) }
  }

  /** 归档连接或工作流，历史快照仍由主进程保留。 */
  const archiveConfiguration = async (): Promise<void> => {
    if (!snapshot || !archiveTarget || busyAction) return
    setBusyAction('archive')
    setFormError(null)
    try {
      setSnapshot(await window.electronAPI.mediaArchiveConfiguration({ kind: archiveTarget.kind, id: archiveTarget.id }, snapshot.revision))
      setArchiveTarget(null)
    } catch (error) { setFormError(formatMediaError(error)) } finally { setBusyAction(null) }
  }

  /** 将用户已预览的 API 正文复制为公共草稿，复用严格校验且无需再次远端读取。 */
  const importRemoteWorkflow = (remote: MediaRemoteWorkflow, name: string): void => {
    setWorkflowDraft(createRemoteWorkflowDraft(remote, name, createMediaId('workflow')))
    setActiveTab('workflows')
  }

  /** 可见连接排除已归档条目。 */
  const connections = snapshot?.connections.filter((connection) => connection.archivedAt === undefined) ?? []
  /** 连接过滤只读取本地列表，不触发远端探测。 */
  const filteredConnections = connections.filter((connection) => `${connection.name} ${connection.baseUrl} ${connection.comfyUser ?? ''}`.toLocaleLowerCase().includes(connectionQuery.trim().toLocaleLowerCase()))
  /** 本地管理只展示显式保存模板，远端执行快照仍可由原卡片读取。 */
  const publicWorkflows = React.useMemo(() => selectLocalMediaWorkflows(snapshot?.workflows ?? [], snapshot?.archivedWorkflowIds), [snapshot])
  /** 按输入种类计数，保留多图和混合媒体区别。 */
  const workflowSummary = (workflow: MediaWorkflowVersion): string => {
    const labels = { image: '图片', audio: '音频', video: '视频', text: '文本', number: '数值', boolean: '开关' }
    const counts = new Map<string, number>()
    for (const binding of workflow.definition.bindings) counts.set(labels[binding.kind], (counts.get(labels[binding.kind]) ?? 0) + 1)
    const inputs = [...counts].map(([label, count]) => `${label}${count > 1 ? ` × ${count}` : ''}`).join(' + ') || '无输入'
    const outputs = workflow.definition.outputs.map((output) => labels[output.mediaType]).join(' + ') || '未声明输出'
    return `${inputs} → ${outputs}`
  }
  /** 工作流可按名称、输入组合与输出类型检索。 */
  const filteredWorkflows = publicWorkflows.filter((workflow) => `${workflow.name} ${workflowSummary(workflow)}`.toLocaleLowerCase().includes(workflowQuery.trim().toLocaleLowerCase()))

  /** 返回连接列表并释放本地草稿，已保存配置保持不变。 */
  const cancelConnectionDraft = (): void => {
    setConnectionDraft(null)
    setConnectionBaseline(null)
    setResourcesLocked(false)
    setFormError(null)
  }
  /** 返回工作流列表，清除未发布草稿与当前表单错误。 */
  const cancelWorkflowDraft = (): void => {
    setWorkflowDraft(null)
    setFormError(null)
  }

  /** 各列表工具栏左侧共用的页签，右侧由当前列表提供搜索筛选。 */
  const navigation = (
    <MediaSettingsTabsView activeTab={activeTab} focusActiveTab={restoreTabFocusRef.current} onTabChange={(tab) => {
      restoreTabFocusRef.current = tab !== activeTab
      setActiveTab(tab)
    }} />
  )
  /** 错误独占工具栏下方一行，避免挤压导航和搜索。 */
  const notices = (
    <>
      {loadError && <MediaError message={loadError} onRetry={() => { setLoading(true); void loadSettings() }} />}
      {formError && !connectionDraft && !workflowDraft && <MediaError message={formError} />}
    </>
  )
  /** 所有媒体配置页面在各自标题下方展示同一全局授权策略。 */
  const authorizationControl = (
    <MediaAuthorizationControl
      mode={snapshot?.authorizationMode ?? 'ask'}
      saving={busyAction === 'authorization-save'}
      disabled={loading || busyAction !== null}
      error={authorizationError}
      onChange={(mode) => { void saveAuthorizationMode(mode) }}
    />
  )

  return (
    <div className="min-w-0 max-w-full space-y-6">
      {activeTab === 'models' && <MediaApiModelSettings navigation={navigation} headerContent={authorizationControl}>{notices}</MediaApiModelSettings>}

      {activeTab === 'connections' && (
        <div className="space-y-8">
          <MediaSettingsPage title={connectionDraft ? (connectionBaseline ? '编辑服务连接' : '添加服务连接') : '服务连接'} onBack={connectionDraft ? cancelConnectionDraft : undefined} busy={busyAction !== null} headerContent={authorizationControl} action={<Button type="button" size="sm" disabled={loading || busyAction !== null || connectionDraft !== null} onClick={() => {
            setFormError(null)
            setConnectionBaseline(null)
            setConnectionDraft({ id: createMediaId('connection'), name: '', baseUrl: '', enabled: true, authKind: 'none', headerName: '', credential: '', credentialConfigured: false, comfyUser: '' })
            setResourcesLocked(true)
          }}><Plus />添加连接</Button>}>
            {!connectionDraft && <div className="flex flex-wrap items-center justify-between gap-3">
              {navigation}
              <Input className="w-64 max-w-full" aria-label="搜索连接" placeholder="搜索连接名称或地址" value={connectionQuery} onChange={(event) => setConnectionQuery(event.target.value)} />
            </div>}
            {notices}
            {connectionDraft ? <div className="space-y-8"><ConnectionEditor draft={connectionDraft} baseline={connectionBaseline} busy={busyAction !== null} error={formError} onChange={(draft, identityChanged) => { setConnectionDraft(draft); setResourcesLocked(identityChanged) }} onCancel={cancelConnectionDraft} onSave={() => void saveConnection()} /><ResourceBrowser key={connectionDraft.id} connection={resolveEditedMediaConnection(connections, connectionBaseline)} locked={resourcesLocked || connectionBaseline === null} probe={probe} onProbe={probeConnection} onImportWorkflow={importRemoteWorkflow} /></div> : loading && !snapshot ? <SettingsCard divided={false}><EmptyState><Loader2 className="mr-2 inline size-4 animate-spin" />正在读取连接...</EmptyState></SettingsCard> : connections.length === 0 ? <SettingsCard divided={false}><EmptyState>尚未保存服务连接</EmptyState></SettingsCard> : (
              <SettingsCard>{filteredConnections.map((connection) => <SettingsRow key={connection.id} label={connection.name} icon={<Server className="size-5 text-muted-foreground" />} description={`${connection.baseUrl}${connection.comfyUser ? ` · 用户 ${connection.comfyUser}` : ''}${probe?.connectionId === connection.id ? ` · 连接正常${probe.nodeCount > 0 ? ` · 本地 ${probe.nodeCount} 个节点` : ''}` : ''}`}><div className="flex flex-wrap items-center justify-end gap-1"><Switch aria-label={`启用 ${connection.name}`} checked={connection.enabled} disabled={busyAction !== null} onCheckedChange={(enabled) => void toggleConnection(connection, enabled)} /><Button type="button" size="icon-sm" variant="ghost" aria-label={`测试 ${connection.name}`} title="测试连接" disabled={busyAction !== null} onClick={() => void probeConnection(connection.id)}>{busyAction === `probe:${connection.id}` ? <Loader2 className="animate-spin" /> : <TestTube2 />}</Button><Button type="button" size="icon-sm" variant="ghost" aria-label={`复制 ${connection.name}`} title="复制" disabled={busyAction !== null} onClick={() => { const draft = connectionToDraft(connection); setConnectionBaseline(null); setConnectionDraft({ ...draft, id: createMediaId('connection'), name: `${draft.name} 副本`, credentialConfigured: false }); setResourcesLocked(true) }}><Copy /></Button><Button type="button" size="icon-sm" variant="ghost" aria-label={`编辑 ${connection.name}`} title="编辑" disabled={busyAction !== null} onClick={() => { const draft = connectionToDraft(connection); setConnectionBaseline(draft); setConnectionDraft(draft); setResourcesLocked(false) }}><Pencil /></Button><Button type="button" size="icon-sm" variant="ghost" aria-label={`删除 ${connection.name}`} title="删除" disabled={busyAction !== null} onClick={() => setArchiveTarget({ kind: 'connection', id: connection.id, name: connection.name })}><Trash2 /></Button></div></SettingsRow>)}{!filteredConnections.length && <EmptyState>没有匹配的连接</EmptyState>}</SettingsCard>
            )}
          </MediaSettingsPage>
        </div>
      )}

      {activeTab === 'workflows' && (
        <div className="space-y-8">
          <MediaSettingsPage title={workflowDraft ? (publicWorkflows.some((workflow) => workflow.id === workflowDraft.id) ? '编辑本地工作流' : '添加本地工作流') : '本地工作流'} onBack={workflowDraft ? cancelWorkflowDraft : undefined} busy={busyAction !== null} headerContent={authorizationControl} action={<Button type="button" size="sm" disabled={loading || busyAction !== null || workflowDraft !== null} onClick={() => { setFormError(null); setWorkflowDraft({ id: createMediaId('workflow'), name: '', definitionText: '', definition: null, invalidated: true, parseError: null }) }}><Plus />添加工作流</Button>}>
            {!workflowDraft && <div className="flex flex-wrap items-center justify-between gap-3">
              {navigation}
              <Input className="w-64 max-w-full" aria-label="搜索本地工作流" placeholder="搜索名称、输入或输出类型" value={workflowQuery} onChange={(event) => setWorkflowQuery(event.target.value)} />
            </div>}
            {notices}
            {workflowDraft ? <WorkflowEditor draft={workflowDraft} busy={busyAction !== null} error={formError} onChange={(draft) => { setWorkflowDraft(draft); setFormError(null) }} onCancel={cancelWorkflowDraft} onSave={() => void saveWorkflow(false)} onSaveAndOpen={onOpenWorkflowInCanvas ? () => void saveWorkflow(true) : undefined} /> : loading && !snapshot ? <SettingsCard divided={false}><EmptyState><Loader2 className="mr-2 inline size-4 animate-spin" />正在读取工作流...</EmptyState></SettingsCard> : publicWorkflows.length === 0 ? <SettingsCard divided={false}><EmptyState>尚未保存本地工作流</EmptyState></SettingsCard> : (
              <SettingsCard>{filteredWorkflows.map((workflow) => <SettingsRow key={workflow.id} label={workflow.name} icon={<Workflow className="size-5 text-muted-foreground" />} description={`r${workflow.revision} · ${workflowSummary(workflow)}`}><div className="flex items-center gap-1"><Button type="button" size="icon-sm" variant="ghost" aria-label={`复制 ${workflow.name}`} title="复制" disabled={busyAction !== null} onClick={() => setWorkflowDraft(workflowToDraft(workflow, true))}><Copy /></Button><Button type="button" size="icon-sm" variant="ghost" aria-label={`编辑 ${workflow.name}`} title="发布新版本" disabled={busyAction !== null} onClick={() => setWorkflowDraft(workflowToDraft(workflow))}><Pencil /></Button><Button type="button" size="icon-sm" variant="ghost" aria-label={`删除 ${workflow.name}`} title="归档" disabled={busyAction !== null} onClick={() => setArchiveTarget({ kind: 'workflow', id: workflow.id, name: workflow.name })}><Trash2 /></Button></div></SettingsRow>)}{!filteredWorkflows.length && <EmptyState>没有匹配的工作流</EmptyState>}</SettingsCard>
            )}
          </MediaSettingsPage>
        </div>
      )}

      <ConfirmDialog open={archiveTarget !== null} onOpenChange={(open) => { if (!open) setArchiveTarget(null) }} title={`删除${archiveTarget?.kind === 'connection' ? '连接' : '工作流'}？`} description={archiveTarget ? `${archiveTarget.name} 将从新任务列表归档，历史运行快照仍保留。` : ''} confirmLabel="删除" loading={busyAction === 'archive'} variant="destructive" onConfirm={() => void archiveConfiguration()} />
    </div>
  )
}
