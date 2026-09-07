import type { MediaAssetRecord, MediaAssetRef, MediaKind, MediaRunSnapshot, MediaRunSourceReference } from './media'
import type { CanvasTarget } from './canvas'

/** Canvas 通用音视频模块的固定 IPC 通道。 */
export const CANVAS_MEDIA_IPC_CHANNELS = {
  LOAD: 'canvas-media:load',
  SAVE: 'canvas-media:save',
  RUN: 'canvas-media:run',
  CANCEL: 'canvas-media:cancel',
  ADOPT: 'canvas-media:adopt',
  READ_PREVIEW: 'canvas-media:read-preview',
  RELEASE_PREVIEW: 'canvas-media:release-preview',
  EXPORT_OUTPUT: 'canvas-media:export-output',
  MODULE_CHANGED: 'canvas-media:module-changed',
} as const

/** 新媒体节点只扩展音频和视频；旧图片节点继续使用 CanvasImageNode。 */
export type CanvasMediaNodeKind = Exclude<MediaKind, 'image'>

/** 通用媒体模块的完整业务身份。 */
export interface CanvasMediaTarget extends CanvasTarget {
  nodeId: string
  mediaModuleId: string
  mediaKind: CanvasMediaNodeKind
}

/** 固定预设版本，运行时不得解析为较新的同名预设。 */
export interface CanvasMediaProfileReference {
  profileId: string
  profileRevision: number
}

/** 公共工作流运行固定到不可变版本与显式连接，不随目录 latest 漂移。 */
export interface CanvasMediaWorkflowReference {
  workflowId: string
  workflowRevision: number
  connectionId: string
}

/** 标量与媒体输入通过判别联合保持工作流绑定类型。 */
export type CanvasMediaInputBinding =
  | { key: string; kind: 'text'; source: { type: 'literal'; value: string } }
  | { key: string; kind: 'number'; source: { type: 'literal'; value: number } }
  | { key: string; kind: 'boolean'; source: { type: 'literal'; value: boolean } }
  | { key: string; kind: MediaKind; source: { type: 'literal'; value: MediaAssetRef } }
  | {
      key: string
      kind: 'text' | MediaKind
      source: { type: 'canvas-output'; nodeId: string; outputKey: string }
    }

/** 输出角色决定 UI 和下游消费语义，不改变工作流 output key。 */
export type CanvasMediaOutputRole = 'primary' | 'preview' | 'auxiliary'

/** 固定工作流输出的 key、类型和顺序合同。 */
export interface CanvasMediaOutputBinding {
  key: string
  mediaKind: MediaKind
  role: CanvasMediaOutputRole
  order: number
  /** 同名 bundle 的输出必须来自同一候选并一次性采用；缺省时各 key 独立采用。 */
  bundle?: string
}

/** 当前正式输出按 key 独立指向候选运行，不默认捆绑其它角色。 */
export interface CanvasMediaAdoptedOutput extends CanvasMediaOutputBinding {
  candidateId: string
  runId: string
  asset: MediaAssetRef
}

/** Shell/Skill 本地产物候选的可信来源；路径不会进入持久化合同。 */
export interface CanvasMediaLocalImportSource {
  kind: 'local-import'
  operationId: string
  sourceSessionId: string
}

/** 通用音视频节点的 CAS 配置。 */
export interface CanvasMediaModuleConfig {
  schemaVersion: 1
  contentId: string
  mediaKind: CanvasMediaNodeKind
  revision: number
  createdAt: number
  updatedAt: number
  profile: CanvasMediaProfileReference | null
  /** 旧配置可能没有此字段；新工作流配置保存 null 或固定公共工作流引用。 */
  workflow?: CanvasMediaWorkflowReference | null
  inputs: CanvasMediaInputBinding[]
  outputs: CanvasMediaOutputBinding[]
  adoptedOutputs: CanvasMediaAdoptedOutput[]
}

/** 单次运行产生的候选；sourceConfigRevision 允许识别迟到结果。 */
export interface CanvasMediaCandidate {
  id: string
  operationId: string
  runId: string
  sourceConfigRevision: number
  sourceRef?: MediaRunSourceReference
  /** 仅本地导入候选设置；远端运行继续使用 sourceRef。 */
  source?: CanvasMediaLocalImportSource
  /** 旧 profile 候选兼容字段；draft 候选不伪造预设。 */
  profile?: CanvasMediaProfileReference
  outputs: Array<CanvasMediaOutputBinding & { asset: MediaAssetRef }>
  createdAt: number
}

/** Renderer 加载媒体模块时得到的公开快照。 */
export interface CanvasMediaModuleSnapshot {
  target: CanvasMediaTarget
  config: CanvasMediaModuleConfig
  candidates: CanvasMediaCandidate[]
  runs: MediaRunSnapshot[]
  assets: MediaAssetRecord[]
}

/** 单个候选输出的临时媒体授权，不暴露本地文件路径。 */
export interface CanvasMediaOutputPreview {
  candidateId: string
  outputKey: string
  outputOrder: number
  asset: MediaAssetRecord
  mediaLeaseId: string
  mediaUrl: string
}

/** 保存媒体配置时绑定当前 revision，正式采用结果不随普通编辑回滚。 */
export interface SaveCanvasMediaModuleInput extends CanvasMediaTarget {
  expectedConfigRevision: number
  /** null 表示只保存供 project workflow draft 运行使用的 typed 合同。 */
  profile: CanvasMediaProfileReference | null
  /** 新保存使用公共工作流引用；旧 profile 调用方可省略。 */
  workflow?: CanvasMediaWorkflowReference | null
  inputs: CanvasMediaInputBinding[]
  outputs: CanvasMediaOutputBinding[]
}

/** 创建运行时由调用方提供可重放的确切 operationId。 */
export interface RunCanvasMediaModuleInput extends CanvasMediaTarget {
  expectedConfigRevision: number
  operationId: string
}

/** 把已登记的本地项目资产按当前输出合同追加为候选。 */
export interface AttachCanvasMediaImportedAssetsInput extends CanvasMediaTarget {
  expectedConfigRevision: number
  operationId: string
  outputs: Array<{ key: string; asset: MediaAssetRef }>
}

/** 运行控制始终绑定模块和确切 run。 */
export interface ControlCanvasMediaRunInput extends CanvasMediaTarget {
  runId: string
}

/** 采用候选通过 config CAS 原子替换整组正式输出。 */
export interface AdoptCanvasMediaCandidateInput extends CanvasMediaTarget {
  expectedConfigRevision: number
  candidateId: string
  /** 只采用明确选择的输出 key；服务会补全并校验同 bundle 的全部 key。 */
  selectedKeys: string[]
}

/** 导出定位候选中的唯一有序输出，不接受任意资产路径。 */
export interface ExportCanvasMediaOutputInput extends CanvasMediaTarget {
  candidateId: string
  outputKey: string
  outputOrder: number
}

/** 读取候选预览与导出使用同一精确输出定位。 */
export type ReadCanvasMediaOutputPreviewInput = ExportCanvasMediaOutputInput

/** 释放预览授权时绑定模块目标和授权代次。 */
export interface ReleaseCanvasMediaPreviewInput extends CanvasMediaTarget {
  mediaLeaseId: string
}

/** 导出对话框取消属于正常结果，不返回用户本地路径。 */
export interface ExportCanvasMediaOutputResult {
  cancelled: boolean
}

/** 模块配置、候选或采用结果提交后的跨窗口刷新事件。 */
export interface CanvasMediaModuleChangedEvent {
  target: CanvasMediaTarget
  revision: number
}

/** Renderer 只通过类型安全 preload 调用通用音视频模块。 */
export interface CanvasMediaPreloadApi {
  canvasMediaLoad(input: CanvasMediaTarget): Promise<CanvasMediaModuleSnapshot>
  canvasMediaSave(input: SaveCanvasMediaModuleInput): Promise<CanvasMediaModuleConfig>
  canvasMediaRun(input: RunCanvasMediaModuleInput): Promise<MediaRunSnapshot>
  canvasMediaCancel(input: ControlCanvasMediaRunInput): Promise<MediaRunSnapshot>
  canvasMediaAdopt(input: AdoptCanvasMediaCandidateInput): Promise<CanvasMediaModuleConfig>
  canvasMediaReadPreview(input: ReadCanvasMediaOutputPreviewInput): Promise<CanvasMediaOutputPreview>
  canvasMediaReleasePreview(input: ReleaseCanvasMediaPreviewInput): Promise<void>
  canvasMediaExportOutput(input: ExportCanvasMediaOutputInput): Promise<ExportCanvasMediaOutputResult>
  onCanvasMediaChanged(callback: (event: CanvasMediaModuleChangedEvent) => void): () => void
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/
const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/
const HASH_PATTERN = /^[0-9a-f]{64}$/
const MAX_BINDINGS = 128

/** 判断未知值是无额外字段的普通对象。 */
function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

/** 判断值为非负安全整数。 */
function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/** 判断媒体类别属于统一协议。 */
function isMediaKind(value: unknown): value is MediaKind {
  return value === 'image' || value === 'audio' || value === 'video'
}

/** 严格解析不可变资产引用。 */
function parseAssetReference(value: unknown): MediaAssetRef {
  if (!hasExactKeys(value, ['assetId', 'revision', 'hash', 'mediaKind'])
    || typeof value.assetId !== 'string' || !ID_PATTERN.test(value.assetId)
    || !isNonNegativeInteger(value.revision) || value.revision < 1
    || typeof value.hash !== 'string' || !HASH_PATTERN.test(value.hash)
    || !isMediaKind(value.mediaKind)) throw new Error('CANVAS_MEDIA_INPUT_INVALID')
  return { assetId: value.assetId, revision: value.revision, hash: value.hash, mediaKind: value.mediaKind }
}

/** 严格解析固定预设版本。 */
function parseProfile(value: unknown): CanvasMediaProfileReference {
  if (!hasExactKeys(value, ['profileId', 'profileRevision'])
    || typeof value.profileId !== 'string' || !ID_PATTERN.test(value.profileId)
    || !isNonNegativeInteger(value.profileRevision) || value.profileRevision < 1) {
    throw new Error('CANVAS_MEDIA_PROFILE_INVALID')
  }
  return { profileId: value.profileId, profileRevision: value.profileRevision }
}

/** 严格解析固定公共工作流版本和连接。 */
function parseWorkflowReference(value: unknown): CanvasMediaWorkflowReference {
  if (!hasExactKeys(value, ['workflowId', 'workflowRevision', 'connectionId'])
    || typeof value.workflowId !== 'string' || !ID_PATTERN.test(value.workflowId)
    || !isNonNegativeInteger(value.workflowRevision) || value.workflowRevision < 1
    || typeof value.connectionId !== 'string' || !ID_PATTERN.test(value.connectionId)) {
    throw new Error('CANVAS_MEDIA_WORKFLOW_INVALID')
  }
  return {
    workflowId: value.workflowId,
    workflowRevision: value.workflowRevision,
    connectionId: value.connectionId,
  }
}

/** 严格解析运行定义来源，旧候选由 profile 字段迁移为 profile-version。 */
function parseSourceReference(value: unknown): MediaRunSourceReference {
  if (hasExactKeys(value, ['kind', 'profileId', 'profileRevision'])
    && value.kind === 'profile-version') {
    return { kind: 'profile-version', ...parseProfile({
      profileId: value.profileId, profileRevision: value.profileRevision,
    }) }
  }
  if (hasExactKeys(value, ['kind', 'workflowId', 'workflowRevision', 'connectionId', 'mediaKind'])
    && value.kind === 'project-draft-revision'
    && typeof value.workflowId === 'string' && ID_PATTERN.test(value.workflowId)
    && isNonNegativeInteger(value.workflowRevision) && value.workflowRevision >= 1
    && typeof value.connectionId === 'string' && ID_PATTERN.test(value.connectionId)
    && isMediaKind(value.mediaKind)) {
    return { kind: 'project-draft-revision', workflowId: value.workflowId,
      workflowRevision: value.workflowRevision, connectionId: value.connectionId, mediaKind: value.mediaKind }
  }
  throw new Error('CANVAS_MEDIA_SOURCE_INVALID')
}

/** 严格解析本地导入来源，禁止路径或其它文件系统信息进入候选。 */
function parseLocalImportSource(value: unknown): CanvasMediaLocalImportSource {
  if (!hasExactKeys(value, ['kind', 'operationId', 'sourceSessionId'])
    || value.kind !== 'local-import'
    || typeof value.operationId !== 'string' || !KEY_PATTERN.test(value.operationId)
    || typeof value.sourceSessionId !== 'string' || !ID_PATTERN.test(value.sourceSessionId)) {
    throw new Error('CANVAS_MEDIA_SOURCE_INVALID')
  }
  return { kind: 'local-import', operationId: value.operationId, sourceSessionId: value.sourceSessionId }
}

/** 严格解析类型化输入并隔离资产引用。 */
function parseInput(value: unknown): CanvasMediaInputBinding {
  if (!hasExactKeys(value, ['key', 'kind', 'source'])
    || typeof value.key !== 'string' || !KEY_PATTERN.test(value.key)) throw new Error('CANVAS_MEDIA_INPUT_INVALID')
  if (hasExactKeys(value.source, ['type', 'nodeId', 'outputKey'])
    && value.source.type === 'canvas-output'
    && (value.kind === 'text' || isMediaKind(value.kind))
    && typeof value.source.nodeId === 'string' && ID_PATTERN.test(value.source.nodeId)
    && typeof value.source.outputKey === 'string' && KEY_PATTERN.test(value.source.outputKey)) {
    return {
      key: value.key,
      kind: value.kind,
      source: { type: 'canvas-output', nodeId: value.source.nodeId, outputKey: value.source.outputKey },
    }
  }
  if (!hasExactKeys(value.source, ['type', 'value']) || value.source.type !== 'literal') {
    throw new Error('CANVAS_MEDIA_INPUT_INVALID')
  }
  if (value.kind === 'text' && typeof value.source.value === 'string' && value.source.value.length <= 100_000) {
    return { key: value.key, kind: 'text', source: { type: 'literal', value: value.source.value } }
  }
  if (value.kind === 'number' && typeof value.source.value === 'number' && Number.isFinite(value.source.value)) {
    return { key: value.key, kind: 'number', source: { type: 'literal', value: value.source.value } }
  }
  if (value.kind === 'boolean' && typeof value.source.value === 'boolean') {
    return { key: value.key, kind: 'boolean', source: { type: 'literal', value: value.source.value } }
  }
  if (isMediaKind(value.kind)) {
    const asset = parseAssetReference(value.source.value)
    if (asset.mediaKind === value.kind) {
      return { key: value.key, kind: value.kind, source: { type: 'literal', value: asset } }
    }
  }
  throw new Error('CANVAS_MEDIA_INPUT_INVALID')
}

/** 严格解析有序输出角色。 */
function parseOutput(value: unknown): CanvasMediaOutputBinding {
  const keys = value && typeof value === 'object' && Object.hasOwn(value, 'bundle')
    ? ['key', 'mediaKind', 'role', 'order', 'bundle']
    : ['key', 'mediaKind', 'role', 'order']
  if (!hasExactKeys(value, keys)
    || typeof value.key !== 'string' || !KEY_PATTERN.test(value.key)
    || !isMediaKind(value.mediaKind)
    || (value.role !== 'primary' && value.role !== 'preview' && value.role !== 'auxiliary')
    || !isNonNegativeInteger(value.order)
    || (value.bundle !== undefined && (typeof value.bundle !== 'string' || !ID_PATTERN.test(value.bundle)))) {
    throw new Error('CANVAS_MEDIA_OUTPUT_INVALID')
  }
  return {
    key: value.key,
    mediaKind: value.mediaKind,
    role: value.role,
    order: value.order,
    ...(typeof value.bundle === 'string' ? { bundle: value.bundle } : {}),
  }
}

/** 严格解析候选输出及其不可变资产引用。 */
function parseCandidateOutput(value: unknown): CanvasMediaCandidate['outputs'][number] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('CANVAS_MEDIA_CANDIDATE_INVALID')
  const record = value as Record<string, unknown>
  const binding = parseOutput({
    key: record.key,
    mediaKind: record.mediaKind,
    role: record.role,
    order: record.order,
    ...(record.bundle === undefined ? {} : { bundle: record.bundle }),
  })
  const keys = ['key', 'mediaKind', 'role', 'order', ...(record.bundle === undefined ? [] : ['bundle']), 'asset']
  if (!hasExactKeys(record, keys)) throw new Error('CANVAS_MEDIA_CANDIDATE_INVALID')
  const asset = parseAssetReference(record.asset)
  if (asset.mediaKind !== binding.mediaKind) throw new Error('CANVAS_MEDIA_CANDIDATE_INVALID')
  return { ...binding, asset }
}

/** 严格解析单个运行候选，并保持输出数组的原始合同顺序。 */
export function parseCanvasMediaCandidate(value: unknown): CanvasMediaCandidate {
  const record = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
  const hasSourceRef = record ? Object.hasOwn(record, 'sourceRef') : false
  const hasSource = record ? Object.hasOwn(record, 'source') : false
  const hasProfile = record ? Object.hasOwn(record, 'profile') : false
  const legacy = !hasSourceRef && !hasSource
  const expectedKeys = [
    'id', 'operationId', 'runId', 'sourceConfigRevision',
    ...(hasSourceRef ? ['sourceRef'] : []), ...(hasSource ? ['source'] : []), ...(hasProfile ? ['profile'] : []),
    'outputs', 'createdAt',
  ]
  if (!hasExactKeys(value, expectedKeys)
    || typeof value.id !== 'string' || !ID_PATTERN.test(value.id)
    || typeof value.operationId !== 'string' || !KEY_PATTERN.test(value.operationId)
    || typeof value.runId !== 'string' || !ID_PATTERN.test(value.runId)
    || !isNonNegativeInteger(value.sourceConfigRevision)
    || !isNonNegativeInteger(value.createdAt)) throw new Error('CANVAS_MEDIA_CANDIDATE_INVALID')
  const outputs = parseBindings(value.outputs, parseCandidateOutput, (output) => output.key)
  if (outputs.length === 0 || outputs.some((output, index) => output.order !== index)) {
    throw new Error('CANVAS_MEDIA_CANDIDATE_INVALID')
  }
  if (hasSourceRef && hasSource) throw new Error('CANVAS_MEDIA_CANDIDATE_INVALID')
  const profile = hasProfile ? parseProfile(value.profile) : undefined
  const sourceRef = legacy
    ? { kind: 'profile-version' as const, ...parseProfile(value.profile) }
    : hasSourceRef ? parseSourceReference(value.sourceRef) : undefined
  const source = hasSource ? parseLocalImportSource(value.source) : undefined
  if ((sourceRef?.kind === 'profile-version' && (!profile
      || profile.profileId !== sourceRef.profileId || profile.profileRevision !== sourceRef.profileRevision))
    || (sourceRef?.kind === 'project-draft-revision' && profile)
    || (source && (profile || source.operationId !== value.operationId))) {
    throw new Error('CANVAS_MEDIA_CANDIDATE_INVALID')
  }
  return {
    id: value.id,
    operationId: value.operationId,
    runId: value.runId,
    sourceConfigRevision: value.sourceConfigRevision,
    ...(sourceRef ? { sourceRef } : {}),
    ...(source ? { source } : {}),
    ...(profile ? { profile } : {}),
    outputs,
    createdAt: value.createdAt,
  }
}

/** 解析绑定数组并要求 key 唯一、输出顺序连续。 */
function parseBindings<T>(value: unknown, parse: (item: unknown) => T, identity: (item: T) => string): T[] {
  if (!Array.isArray(value) || value.length > MAX_BINDINGS
    || !Array.from({ length: value.length }, (_, index) => Object.hasOwn(value, index)).every(Boolean)) {
    throw new Error('CANVAS_MEDIA_BINDINGS_INVALID')
  }
  const bindings = value.map(parse)
  if (new Set(bindings.map(identity)).size !== bindings.length) throw new Error('CANVAS_MEDIA_BINDINGS_INVALID')
  return bindings
}

/** 严格解析通用媒体模块配置。 */
export function parseCanvasMediaModuleConfig(value: unknown): CanvasMediaModuleConfig {
  const keys = [
    'schemaVersion', 'contentId', 'mediaKind', 'revision', 'createdAt', 'updatedAt',
    'profile', ...(value && typeof value === 'object' && Object.hasOwn(value, 'workflow') ? ['workflow'] : []),
    'inputs', 'outputs', 'adoptedOutputs',
  ]
  if (!hasExactKeys(value, keys)
    || value.schemaVersion !== 1
    || typeof value.contentId !== 'string' || !ID_PATTERN.test(value.contentId)
    || (value.mediaKind !== 'audio' && value.mediaKind !== 'video')
    || !isNonNegativeInteger(value.revision)
    || !isNonNegativeInteger(value.createdAt)
    || !isNonNegativeInteger(value.updatedAt)) {
    throw new Error('CANVAS_MEDIA_CONFIG_INVALID')
  }
  const inputs = parseBindings(value.inputs, parseInput, (input) => input.key)
  const outputs = parseBindings(value.outputs, parseOutput, (output) => output.key)
  if (!Array.isArray(value.adoptedOutputs)) throw new Error('CANVAS_MEDIA_CONFIG_INVALID')
  /** 正式输出的深解析由服务按候选和输出合同再次校验，此处先锁定 key 唯一与公共字段。 */
  const adoptedOutputs = parseBindings(value.adoptedOutputs, (item): CanvasMediaAdoptedOutput => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('CANVAS_MEDIA_OUTPUT_INVALID')
    const record = item as Record<string, unknown>
    const binding = parseOutput({
      key: record.key,
      mediaKind: record.mediaKind,
      role: record.role,
      order: record.order,
      ...(record.bundle === undefined ? {} : { bundle: record.bundle }),
    })
    if (!hasExactKeys(record, [
      'key', 'mediaKind', 'role', 'order', ...(record.bundle === undefined ? [] : ['bundle']),
      'candidateId', 'runId', 'asset',
    ])
      || typeof record.candidateId !== 'string' || !ID_PATTERN.test(record.candidateId)
      || typeof record.runId !== 'string' || !ID_PATTERN.test(record.runId)) throw new Error('CANVAS_MEDIA_OUTPUT_INVALID')
    const asset = parseAssetReference(record.asset)
    if (asset.mediaKind !== binding.mediaKind) throw new Error('CANVAS_MEDIA_OUTPUT_INVALID')
    return { ...binding, candidateId: record.candidateId, runId: record.runId, asset }
  }, (output) => output.key)
  const profile = value.profile === null ? null : parseProfile(value.profile)
  const workflow = value.workflow === undefined || value.workflow === null
    ? null
    : parseWorkflowReference(value.workflow)
  if (profile && workflow) throw new Error('CANVAS_MEDIA_SOURCE_CONFLICT')
  if ((profile !== null || workflow !== null || inputs.length > 0 || outputs.length > 0 || adoptedOutputs.length > 0)
    && (outputs.length === 0
      || outputs.some((output, index) => output.order !== index)
      || outputs.filter((output) => output.role === 'primary').length !== 1
      || outputs.find((output) => output.role === 'primary')?.mediaKind !== value.mediaKind)) {
    throw new Error('CANVAS_MEDIA_OUTPUT_INVALID')
  }
  for (const adopted of adoptedOutputs) {
    const binding = outputs.find((output) => output.key === adopted.key)
    if (!binding || binding.mediaKind !== adopted.mediaKind || binding.role !== adopted.role
      || binding.order !== adopted.order || binding.bundle !== adopted.bundle) {
      throw new Error('CANVAS_MEDIA_OUTPUT_INVALID')
    }
  }
  return {
    schemaVersion: 1,
    contentId: value.contentId,
    mediaKind: value.mediaKind,
    revision: value.revision,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    profile,
    ...(value.workflow === undefined ? {} : { workflow }),
    inputs,
    outputs,
    adoptedOutputs,
  }
}

/** 严格解析通用媒体目标。 */
export function parseCanvasMediaTarget(value: unknown): CanvasMediaTarget {
  if (!hasExactKeys(value, ['projectId', 'canvasId', 'nodeId', 'mediaModuleId', 'mediaKind'])
    || typeof value.projectId !== 'string' || !ID_PATTERN.test(value.projectId)
    || typeof value.canvasId !== 'string' || !ID_PATTERN.test(value.canvasId)
    || typeof value.nodeId !== 'string' || !ID_PATTERN.test(value.nodeId)
    || typeof value.mediaModuleId !== 'string' || !ID_PATTERN.test(value.mediaModuleId)
    || (value.mediaKind !== 'audio' && value.mediaKind !== 'video')) throw new Error('CANVAS_MEDIA_TARGET_INVALID')
  return {
    projectId: value.projectId,
    canvasId: value.canvasId,
    nodeId: value.nodeId,
    mediaModuleId: value.mediaModuleId,
    mediaKind: value.mediaKind,
  }
}

/** 从带额外命令字段的记录解析媒体目标。 */
function parseTargetFields(value: Record<string, unknown>): CanvasMediaTarget {
  return parseCanvasMediaTarget({
    projectId: value.projectId,
    canvasId: value.canvasId,
    nodeId: value.nodeId,
    mediaModuleId: value.mediaModuleId,
    mediaKind: value.mediaKind,
  })
}

/** 严格解析确切 operationId 和配置 revision 绑定的运行命令。 */
export function parseRunCanvasMediaModuleInput(value: unknown): RunCanvasMediaModuleInput {
  if (!hasExactKeys(value, [
    'projectId', 'canvasId', 'nodeId', 'mediaModuleId', 'mediaKind',
    'expectedConfigRevision', 'operationId',
  ])
    || !isNonNegativeInteger(value.expectedConfigRevision)
    || typeof value.operationId !== 'string' || !KEY_PATTERN.test(value.operationId)) {
    throw new Error('CANVAS_MEDIA_RUN_INPUT_INVALID')
  }
  return { ...parseTargetFields(value), expectedConfigRevision: value.expectedConfigRevision, operationId: value.operationId }
}

/** 严格解析本地项目资产回填命令，并锁定唯一 key 与不可变资产引用。 */
export function parseAttachCanvasMediaImportedAssetsInput(value: unknown): AttachCanvasMediaImportedAssetsInput {
  if (!hasExactKeys(value, [
    'projectId', 'canvasId', 'nodeId', 'mediaModuleId', 'mediaKind',
    'expectedConfigRevision', 'operationId', 'outputs',
  ])
    || !isNonNegativeInteger(value.expectedConfigRevision)
    || typeof value.operationId !== 'string' || !KEY_PATTERN.test(value.operationId)
    || !Array.isArray(value.outputs) || value.outputs.length < 1 || value.outputs.length > MAX_BINDINGS) {
    throw new Error('CANVAS_MEDIA_LOCAL_IMPORT_INPUT_INVALID')
  }
  const outputs = value.outputs.map((output) => {
    if (!hasExactKeys(output, ['key', 'asset']) || typeof output.key !== 'string' || !KEY_PATTERN.test(output.key)) {
      throw new Error('CANVAS_MEDIA_LOCAL_IMPORT_INPUT_INVALID')
    }
    return { key: output.key, asset: parseAssetReference(output.asset) }
  })
  if (new Set(outputs.map((output) => output.key)).size !== outputs.length) {
    throw new Error('CANVAS_MEDIA_LOCAL_IMPORT_INPUT_INVALID')
  }
  return {
    ...parseTargetFields(value), expectedConfigRevision: value.expectedConfigRevision,
    operationId: value.operationId, outputs,
  }
}

/** 严格解析完整配置保存命令，并复用配置解析器验证输入输出合同。 */
export function parseSaveCanvasMediaModuleInput(value: unknown): SaveCanvasMediaModuleInput {
  const keys = [
    'projectId', 'canvasId', 'nodeId', 'mediaModuleId', 'mediaKind',
    'expectedConfigRevision', 'profile', ...(value && typeof value === 'object' && Object.hasOwn(value, 'workflow') ? ['workflow'] : []),
    'inputs', 'outputs',
  ]
  if (!hasExactKeys(value, keys) || !isNonNegativeInteger(value.expectedConfigRevision)) {
    throw new Error('CANVAS_MEDIA_SAVE_INPUT_INVALID')
  }
  const target = parseTargetFields(value)
  try {
    const parsed = parseCanvasMediaModuleConfig({
      schemaVersion: 1,
      contentId: target.mediaModuleId,
      mediaKind: target.mediaKind,
      revision: value.expectedConfigRevision,
      createdAt: 0,
      updatedAt: 0,
      profile: value.profile,
      ...(value.workflow === undefined ? {} : { workflow: value.workflow }),
      inputs: value.inputs,
      outputs: value.outputs,
      adoptedOutputs: [],
    })
    return {
      ...target,
      expectedConfigRevision: value.expectedConfigRevision,
      profile: parsed.profile,
      ...(value.workflow === undefined ? {} : { workflow: parsed.workflow ?? null }),
      inputs: parsed.inputs,
      outputs: parsed.outputs,
    }
  } catch (error) {
    throw new Error('CANVAS_MEDIA_SAVE_INPUT_INVALID', { cause: error })
  }
}

/** 严格解析绑定确切 run 的取消命令。 */
export function parseControlCanvasMediaRunInput(value: unknown): ControlCanvasMediaRunInput {
  if (!hasExactKeys(value, [
    'projectId', 'canvasId', 'nodeId', 'mediaModuleId', 'mediaKind', 'runId',
  ]) || typeof value.runId !== 'string' || !ID_PATTERN.test(value.runId)) {
    throw new Error('CANVAS_MEDIA_CONTROL_INPUT_INVALID')
  }
  return { ...parseTargetFields(value), runId: value.runId }
}

/** 严格解析按 key 选择的候选采用命令。 */
export function parseAdoptCanvasMediaCandidateInput(value: unknown): AdoptCanvasMediaCandidateInput {
  if (!hasExactKeys(value, [
    'projectId', 'canvasId', 'nodeId', 'mediaModuleId', 'mediaKind',
    'expectedConfigRevision', 'candidateId', 'selectedKeys',
  ])
    || !isNonNegativeInteger(value.expectedConfigRevision)
    || typeof value.candidateId !== 'string' || !ID_PATTERN.test(value.candidateId)
    || !Array.isArray(value.selectedKeys) || value.selectedKeys.length < 1 || value.selectedKeys.length > MAX_BINDINGS
    || !value.selectedKeys.every((key) => typeof key === 'string' && KEY_PATTERN.test(key))
    || new Set(value.selectedKeys).size !== value.selectedKeys.length) {
    throw new Error('CANVAS_MEDIA_ADOPT_INPUT_INVALID')
  }
  return {
    ...parseTargetFields(value),
    expectedConfigRevision: value.expectedConfigRevision,
    candidateId: value.candidateId,
    selectedKeys: [...value.selectedKeys] as string[],
  }
}

/** 严格解析候选输出定位，拒绝把 UI order 当成工作流 output index。 */
export function parseExportCanvasMediaOutputInput(value: unknown): ExportCanvasMediaOutputInput {
  if (!hasExactKeys(value, [
    'projectId', 'canvasId', 'nodeId', 'mediaModuleId', 'mediaKind',
    'candidateId', 'outputKey', 'outputOrder',
  ])
    || typeof value.candidateId !== 'string' || !ID_PATTERN.test(value.candidateId)
    || typeof value.outputKey !== 'string' || !KEY_PATTERN.test(value.outputKey)
    || !isNonNegativeInteger(value.outputOrder)) {
    throw new Error('CANVAS_MEDIA_EXPORT_INPUT_INVALID')
  }
  return {
    ...parseTargetFields(value),
    candidateId: value.candidateId,
    outputKey: value.outputKey,
    outputOrder: value.outputOrder,
  }
}

/** 预览读取与导出共享同一精确候选输出定位合同。 */
export const parseReadCanvasMediaOutputPreviewInput = parseExportCanvasMediaOutputInput

/** 严格解析预览授权释放命令。 */
export function parseReleaseCanvasMediaPreviewInput(value: unknown): ReleaseCanvasMediaPreviewInput {
  if (!hasExactKeys(value, [
    'projectId', 'canvasId', 'nodeId', 'mediaModuleId', 'mediaKind', 'mediaLeaseId',
  ]) || typeof value.mediaLeaseId !== 'string' || !ID_PATTERN.test(value.mediaLeaseId)) {
    throw new Error('CANVAS_MEDIA_RELEASE_INPUT_INVALID')
  }
  return { ...parseTargetFields(value), mediaLeaseId: value.mediaLeaseId }
}

/** 严格解析模块变化事件，避免跨窗口订阅接收伪造 revision。 */
export function parseCanvasMediaModuleChangedEvent(value: unknown): CanvasMediaModuleChangedEvent {
  if (!hasExactKeys(value, ['target', 'revision']) || !isNonNegativeInteger(value.revision)) {
    throw new Error('CANVAS_MEDIA_CHANGED_EVENT_INVALID')
  }
  return { target: parseCanvasMediaTarget(value.target), revision: value.revision }
}
