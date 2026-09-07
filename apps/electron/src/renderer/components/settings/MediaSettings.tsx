import * as React from 'react'
import { useAtom } from 'jotai'
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  ChevronLeft,
  ChevronRight,
  Copy,
  Eye,
  FileJson,
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
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { cn } from '@/lib/utils'
import { MediaApiModelSettings } from './MediaApiModelSettings'
import { SettingsCard, SettingsRow, SettingsSection } from './primitives'

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

/** 将异常整理为用户可见文本。 */
function formatMediaError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
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
  if (remote.format === 'ui') throw new Error('ComfyUI UI 工作流不能直接执行，请先在 ComfyUI 导出 API 格式')
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
}: {
  activeTab: MediaSettingsTab
  onTabChange: (tab: MediaSettingsTab) => void
}): React.ReactElement {
  return (
    <Tabs value={activeTab} onValueChange={(value) => onTabChange(value as MediaSettingsTab)}>
      <TabsList className="grid h-9 w-full grid-cols-3 rounded-md p-0.5">
        <TabsTrigger value="models" className="min-w-0 px-2 text-xs">媒体模型</TabsTrigger>
        <TabsTrigger value="connections" className="min-w-0 px-2 text-xs">服务连接</TabsTrigger>
        <TabsTrigger value="workflows" className="min-w-0 px-2 text-xs">公共工作流</TabsTrigger>
      </TabsList>
    </Tabs>
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
  onImportWorkflow: (descriptor: MediaRemoteDescriptor, name: string) => Promise<void>
}): React.ReactElement {
  /** 资源查询条件在切换页面时保持。 */
  const [state, setState] = React.useState<MediaResourceBrowserState>({ connectionId: connection?.id ?? '', kind: 'models', query: '', folder: '', offset: 0 })
  /** 当前权威资源页。 */
  const [page, setPage] = React.useState<MediaResourcePage | null>(null)
  /** 展开的资源 ID。 */
  const [selectedId, setSelectedId] = React.useState<string | null>(null)
  /** 查询错误。 */
  const [error, setError] = React.useState<string | null>(null)
  /** 查询加载状态。 */
  const [loading, setLoading] = React.useState(false)
  /** 正在读取并导入的远端工作流 ID。 */
  const [importingId, setImportingId] = React.useState<string | null>(null)
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
  /** 当前模型快照携带的完整目录。 */
  const modelFolders = getMediaResourceModelFolders(page)
  /** 空筛选时后端读取首个真实模型目录，选择器必须显示同一目录。 */
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
  /** 通过稳定 descriptor 读取远端工作流正文，再交给公共草稿编辑器。 */
  const importWorkflow = async (descriptor: MediaRemoteDescriptor, name: string, id: string): Promise<void> => {
    setImportingId(id)
    setError(null)
    try { await onImportWorkflow(descriptor, name) } catch (importError) { setError(formatMediaError(importError)) } finally { setImportingId(null) }
  }
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
          <Tabs value={state.kind} onValueChange={(kind) => changeFilters({ kind: kind as MediaResourceKind, folder: '' })}>
            <TabsList className="grid h-9 w-full grid-cols-4 rounded-md p-0.5">{(Object.keys(resourceLabels) as MediaResourceKind[]).map((kind) => <TabsTrigger key={kind} value={kind} className="min-w-0 px-1 text-xs">{resourceLabels[kind]}</TabsTrigger>)}</TabsList>
          </Tabs>
          {state.kind === 'models' && modelFolders.length ? <Select value={selectedModelFolder} onValueChange={(folder) => changeFilters({ folder })}><SelectTrigger><SelectValue placeholder="选择模型目录" /></SelectTrigger><SelectContent>{modelFolders.map((folder) => <SelectItem key={folder} value={folder}>{folder}</SelectItem>)}</SelectContent></Select> : null}
          <div className="flex gap-2">
            <div className="relative min-w-0 flex-1"><Search className="pointer-events-none absolute left-3 top-2.5 size-4 text-muted-foreground" /><Input className="pl-9" value={state.query} placeholder="搜索当前资源" disabled={locked} onChange={(event) => changeFilters({ query: event.target.value })} /></div>
            <Button type="button" size="icon" variant="outline" disabled={locked || loading || !state.connectionId} aria-label={refreshLabel} title={refreshLabel} onClick={() => void load(true, 0)}>{loading ? <Loader2 className="animate-spin" /> : <RefreshCw />}</Button>
          </div>
          {pageStatus && <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground"><span>{pageStatus.sourceLabel}</span>{snapshotTime && <span>{pageStatus.timeLabel}：{snapshotTime}</span>}</div>}
          {syncErrorMessage && <MediaError message={syncErrorMessage} />}
          {capabilityMessage && <MediaError message={capabilityMessage} />}
          {error && <MediaError message={error} onRetry={() => void load(false)} />}
        </div>
        {locked || !page ? <EmptyState>{connection ? loading ? state.kind === 'assets' ? '正在查询远端资源...' : '正在读取资源快照...' : state.kind === 'assets' ? '暂无远端资源，点击刷新后获取' : '暂无资源快照，点击同步后获取' : '先保存当前服务连接'}</EmptyState> : page.items.length === 0 ? <EmptyState>{state.kind === 'assets' ? '没有匹配的远端资源' : '快照中没有匹配的资源'}</EmptyState> : (
          <div className="border-t border-border/60">
            {page.items.map((item) => (
              <div key={item.id} className="border-b border-border/60 last:border-b-0">
                <button type="button" className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-muted/30" onClick={() => setSelectedId((current) => current === item.id ? null : item.id)}>
                  <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{item.name}</span><span className="block truncate text-xs text-muted-foreground">{item.category || '未分类'}</span></span>
                  <span className={cn('text-[11px]', item.supported ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground')}>{item.supported ? '已支持' : '只读'}</span>
                </button>
                {selected?.id === item.id && <div className="border-t border-border/60 bg-muted/20"><pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words p-3 text-[11px] leading-5 text-muted-foreground">{JSON.stringify(item.schema ?? item.metadata ?? item.descriptor ?? {}, null, 2)}</pre>{state.kind === 'assets' && item.descriptor && <RemoteAssetPreview key={item.id} descriptor={item.descriptor} name={item.name} />}{state.kind === 'workflows' && item.descriptor && <div className="flex justify-end border-t border-border/60 p-2"><Button type="button" size="sm" variant="outline" disabled={importingId !== null} onClick={() => void importWorkflow(item.descriptor!, item.name, item.id)}>{importingId === item.id ? <Loader2 className="animate-spin" /> : <Copy />}读取并导入公共草稿</Button></div>}</div>}
              </div>
            ))}
            <div className="flex items-center justify-between px-4 py-3 text-xs text-muted-foreground">
              <span>{state.offset + 1}-{Math.min(state.offset + page.items.length, page.total)} / {page.total}</span>
              <div className="flex gap-1"><Button type="button" size="icon-sm" variant="ghost" disabled={loading || state.offset === 0} aria-label="上一页" onClick={() => void load(false, Math.max(0, state.offset - 50))}><ChevronLeft /></Button><Button type="button" size="icon-sm" variant="ghost" disabled={loading || page.nextOffset === null} aria-label="下一页" onClick={() => { if (page.nextOffset !== null) void load(false, page.nextOffset) }}><ChevronRight /></Button></div>
            </div>
          </div>
        )}
      </SettingsCard>
    </div>
  )
}

/** 统一媒体设置页。 */
export function MediaSettings({ onOpenWorkflowInCanvas }: MediaSettingsProps = {}): React.ReactElement {
  /** 当前平级页签；草稿位于父级，因此切换不丢失。 */
  const [activeTab, setActiveTab] = React.useState<MediaSettingsTab>('models')
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

  /** 按 descriptor 读取远端工作流；只有 API 图可进入独立公共草稿。 */
  const importRemoteWorkflow = async (descriptor: MediaRemoteDescriptor, name: string): Promise<void> => {
    /** 主进程完成认证与稳定身份校验后的远端正文。 */
    const remote = await window.electronAPI.mediaReadRemoteWorkflow(descriptor)
    setWorkflowDraft(createRemoteWorkflowDraft(remote, name, createMediaId('workflow')))
    setActiveTab('workflows')
  }

  /** 可见连接排除已归档条目。 */
  const connections = snapshot?.connections.filter((connection) => connection.archivedAt === undefined) ?? []
  /** 连接过滤只读取本地列表，不触发远端探测。 */
  const filteredConnections = connections.filter((connection) => `${connection.name} ${connection.baseUrl} ${connection.comfyUser ?? ''}`.toLocaleLowerCase().includes(connectionQuery.trim().toLocaleLowerCase()))
  /** 公共工作流只展示每个 ID 最新版本。 */
  const publicWorkflows = React.useMemo(() => {
    /** 按 ID 收集的最新版本。 */
    const latest = new Map<string, MediaWorkflowVersion>()
    for (const workflow of snapshot?.workflows ?? []) {
      if (workflow.projectId !== null || snapshot?.archivedWorkflowIds?.includes(workflow.id)) continue
      /** 已收集的版本。 */
      const current = latest.get(workflow.id)
      if (!current || workflow.revision > current.revision) latest.set(workflow.id, workflow)
    }
    return [...latest.values()]
  }, [snapshot])
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
  /** 旧项目私有版本作为只读来源展示。 */
  const privateWorkflows = snapshot?.workflows.filter((workflow) => workflow.projectId !== null) ?? []

  return (
    <div className="min-w-0 max-w-full space-y-6">
      <MediaSettingsTabsView activeTab={activeTab} onTabChange={setActiveTab} />
      {loadError && <MediaError message={loadError} onRetry={() => { setLoading(true); void loadSettings() }} />}
      {formError && !connectionDraft && !workflowDraft && <MediaError message={formError} />}

      {activeTab === 'models' && <MediaApiModelSettings />}

      {activeTab === 'connections' && (
        <div className="space-y-8">
          <SettingsSection title="服务连接" action={<Button type="button" size="sm" disabled={loading || busyAction !== null || connectionDraft !== null} onClick={() => {
            setFormError(null)
            setConnectionBaseline(null)
            setConnectionDraft({ id: createMediaId('connection'), name: '', baseUrl: '', enabled: true, authKind: 'none', headerName: '', credential: '', credentialConfigured: false, comfyUser: '' })
            setResourcesLocked(true)
          }}><Plus />添加连接</Button>}>
            {!connectionDraft && <Input className="mb-3" aria-label="搜索连接" placeholder="搜索连接名称或地址" value={connectionQuery} onChange={(event) => setConnectionQuery(event.target.value)} />}
            {connectionDraft ? <div className="space-y-8"><ConnectionEditor draft={connectionDraft} baseline={connectionBaseline} busy={busyAction !== null} error={formError} onChange={(draft, identityChanged) => { setConnectionDraft(draft); setResourcesLocked(identityChanged) }} onCancel={() => { setConnectionDraft(null); setConnectionBaseline(null); setResourcesLocked(false); setFormError(null) }} onSave={() => void saveConnection()} /><ResourceBrowser key={connectionDraft.id} connection={resolveEditedMediaConnection(connections, connectionBaseline)} locked={resourcesLocked || connectionBaseline === null} probe={probe} onProbe={probeConnection} onImportWorkflow={importRemoteWorkflow} /></div> : loading && !snapshot ? <SettingsCard divided={false}><EmptyState><Loader2 className="mr-2 inline size-4 animate-spin" />正在读取连接...</EmptyState></SettingsCard> : connections.length === 0 ? <SettingsCard divided={false}><EmptyState>尚未保存服务连接</EmptyState></SettingsCard> : (
              <SettingsCard>{filteredConnections.map((connection) => <SettingsRow key={connection.id} label={connection.name} icon={<Server className="size-5 text-muted-foreground" />} description={`${connection.baseUrl}${connection.comfyUser ? ` · 用户 ${connection.comfyUser}` : ''}${probe?.connectionId === connection.id ? ` · 连接正常${probe.nodeCount > 0 ? ` · 本地 ${probe.nodeCount} 个节点` : ''}` : ''}`}><div className="flex flex-wrap items-center justify-end gap-1"><Switch aria-label={`启用 ${connection.name}`} checked={connection.enabled} disabled={busyAction !== null} onCheckedChange={(enabled) => void toggleConnection(connection, enabled)} /><Button type="button" size="icon-sm" variant="ghost" aria-label={`测试 ${connection.name}`} title="测试连接" disabled={busyAction !== null} onClick={() => void probeConnection(connection.id)}>{busyAction === `probe:${connection.id}` ? <Loader2 className="animate-spin" /> : <TestTube2 />}</Button><Button type="button" size="icon-sm" variant="ghost" aria-label={`复制 ${connection.name}`} title="复制" disabled={busyAction !== null} onClick={() => { const draft = connectionToDraft(connection); setConnectionBaseline(null); setConnectionDraft({ ...draft, id: createMediaId('connection'), name: `${draft.name} 副本`, credentialConfigured: false }); setResourcesLocked(true) }}><Copy /></Button><Button type="button" size="icon-sm" variant="ghost" aria-label={`编辑 ${connection.name}`} title="编辑" disabled={busyAction !== null} onClick={() => { const draft = connectionToDraft(connection); setConnectionBaseline(draft); setConnectionDraft(draft); setResourcesLocked(false) }}><Pencil /></Button><Button type="button" size="icon-sm" variant="ghost" aria-label={`删除 ${connection.name}`} title="删除" disabled={busyAction !== null} onClick={() => setArchiveTarget({ kind: 'connection', id: connection.id, name: connection.name })}><Trash2 /></Button></div></SettingsRow>)}{!filteredConnections.length && <EmptyState>没有匹配的连接</EmptyState>}</SettingsCard>
            )}
          </SettingsSection>
        </div>
      )}

      {activeTab === 'workflows' && (
        <div className="space-y-8">
          <SettingsSection title="公共工作流" action={<Button type="button" size="sm" disabled={loading || busyAction !== null || workflowDraft !== null} onClick={() => { setFormError(null); setWorkflowDraft({ id: createMediaId('workflow'), name: '', definitionText: '', definition: null, invalidated: true, parseError: null }) }}><Plus />添加工作流</Button>}>
            {!workflowDraft && <Input className="mb-3" aria-label="搜索公共工作流" placeholder="搜索名称、输入或输出类型" value={workflowQuery} onChange={(event) => setWorkflowQuery(event.target.value)} />}
            {workflowDraft ? <WorkflowEditor draft={workflowDraft} busy={busyAction !== null} error={formError} onChange={(draft) => { setWorkflowDraft(draft); setFormError(null) }} onCancel={() => { setWorkflowDraft(null); setFormError(null) }} onSave={() => void saveWorkflow(false)} onSaveAndOpen={onOpenWorkflowInCanvas ? () => void saveWorkflow(true) : undefined} /> : loading && !snapshot ? <SettingsCard divided={false}><EmptyState><Loader2 className="mr-2 inline size-4 animate-spin" />正在读取工作流...</EmptyState></SettingsCard> : publicWorkflows.length === 0 ? <SettingsCard divided={false}><EmptyState>尚未保存公共工作流</EmptyState></SettingsCard> : (
              <SettingsCard>{filteredWorkflows.map((workflow) => <SettingsRow key={workflow.id} label={workflow.name} icon={<Workflow className="size-5 text-muted-foreground" />} description={`r${workflow.revision} · ${workflowSummary(workflow)}`}><div className="flex items-center gap-1"><Button type="button" size="icon-sm" variant="ghost" aria-label={`复制 ${workflow.name}`} title="复制" disabled={busyAction !== null} onClick={() => setWorkflowDraft(workflowToDraft(workflow, true))}><Copy /></Button><Button type="button" size="icon-sm" variant="ghost" aria-label={`编辑 ${workflow.name}`} title="发布新版本" disabled={busyAction !== null} onClick={() => setWorkflowDraft(workflowToDraft(workflow))}><Pencil /></Button><Button type="button" size="icon-sm" variant="ghost" aria-label={`删除 ${workflow.name}`} title="归档" disabled={busyAction !== null} onClick={() => setArchiveTarget({ kind: 'workflow', id: workflow.id, name: workflow.name })}><Trash2 /></Button></div></SettingsRow>)}{!filteredWorkflows.length && <EmptyState>没有匹配的工作流</EmptyState>}</SettingsCard>
            )}
          </SettingsSection>
          {privateWorkflows.length > 0 && <SettingsSection title="项目历史" description="旧项目私有版本只读保留，可清洗资源引用后复制为公共版本。"><SettingsCard>{privateWorkflows.map((workflow) => <SettingsRow key={`${workflow.id}:${workflow.revision}`} label={workflow.name} description={`${workflow.projectId} · r${workflow.revision} · 只读来源`}><Button type="button" size="sm" variant="outline" disabled={busyAction !== null || workflowDraft !== null} onClick={() => setWorkflowDraft(workflowToDraft(workflow, true))}><Copy />复制为公共</Button></SettingsRow>)}</SettingsCard></SettingsSection>}
        </div>
      )}

      <ConfirmDialog open={archiveTarget !== null} onOpenChange={(open) => { if (!open) setArchiveTarget(null) }} title={`删除${archiveTarget?.kind === 'connection' ? '连接' : '工作流'}？`} description={archiveTarget ? `${archiveTarget.name} 将从新任务列表归档，历史运行快照仍保留。` : ''} confirmLabel="删除" loading={busyAction === 'archive'} variant="destructive" onConfirm={() => void archiveConfiguration()} />
    </div>
  )
}
