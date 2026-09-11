import * as React from 'react'
import type {
  CanvasMediaInputBinding,
  CanvasMediaModuleConfig,
  CanvasMediaModuleSnapshot,
  CanvasMediaOutputBinding,
  CanvasMediaOutputPreview,
  CanvasMediaPreloadApi,
  CanvasMediaTarget,
  CanvasDocument,
  CanvasImagePreview,
  CanvasMediaInputConnections,
  CanvasMediaPreparationStatus,
  MediaAssetRecord,
  MediaAssetRef,
  MediaInputValue,
  MediaPreloadApi,
  MediaRunSnapshot,
  MediaSettingsSnapshot,
  MediaWorkflowVersion,
} from '@proma/shared'
import { inspectCanvasMediaInputConnections, validateMediaWorkflowFieldValue } from '@proma/shared'
import { AudioLines, Check, Download, Eye, FileUp, Film, History, LoaderCircle, Play, RefreshCw, Square } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { getMediaProjectWatchLeaseRegistry, projectMediaRunProgress } from './use-media-run-progress'
import { CanvasMediaImagePicker } from './CanvasMediaImagePicker'
import { CanvasMediaSourcePicker } from './CanvasMediaSourcePicker'

/** 媒体工作台只依赖公开 IPC，不读取本地路径。 */
export type CanvasMediaWorkbenchAdapter = CanvasMediaPreloadApi
  & Pick<MediaPreloadApi, 'mediaGetSettings' | 'mediaWatchProject' | 'mediaUnwatchProject' | 'onMediaRunChanged'>

/** 工作台输入草稿允许用户在保存前暂存未完成的 Canvas 输出身份。 */
export interface CanvasMediaWorkflowInputDraft {
  key: string
  kind: CanvasMediaInputBinding['kind']
  label: string
  controlType: NonNullable<MediaWorkflowVersion['definition']['bindings'][number]['field']>['controlType']
  required: boolean
  min?: number
  max?: number
  step?: number
  sourceType: 'literal' | 'canvas-output'
  value: string
  asset: MediaAssetRef | null
  /** ComfyUI 工作流中真实输入节点，用于向用户定位字段。 */
  bindingNodeId: string
  /** ComfyUI 工作流中真实 input 名称，用于向用户定位字段。 */
  bindingInput: string
  /** 选择 Canvas 输出来源时填写的画布节点，不得与工作流节点混用。 */
  sourceNodeId: string
  outputKey: string
}

/** 从权威配置创建可编辑草稿，资产只保存稳定 assetId。 */
export function createInputDrafts(
  config: CanvasMediaModuleConfig,
  workflow: MediaWorkflowVersion | undefined,
): CanvasMediaWorkflowInputDraft[] {
  const initial = workflow ? createCanvasMediaWorkflowDraft(workflow, {}, false) : config.inputs.map((input): CanvasMediaWorkflowInputDraft => ({
    key: input.key,
    kind: input.kind,
    label: input.key,
    controlType: input.kind,
    required: true,
    sourceType: 'literal',
    value: '',
    asset: null,
    bindingNodeId: '',
    bindingInput: input.key,
    sourceNodeId: '',
    outputKey: defaultOutputKey(input.kind),
  }))
  return initial.map((draft) => {
    const input = config.inputs.find((candidate) => candidate.key === draft.key && candidate.kind === draft.kind)
    if (!input) return draft
    return input.source.type === 'canvas-output'
    ? {
        ...draft, sourceType: 'canvas-output', value: '', asset: null,
        sourceNodeId: input.source.nodeId, outputKey: input.source.outputKey,
      }
    : {
        ...draft, sourceType: 'literal',
        value: input.kind === 'image' || input.kind === 'audio' || input.kind === 'video'
          ? input.source.value.assetId
          : String(input.source.value),
        asset: input.kind === 'image' || input.kind === 'audio' || input.kind === 'video'
          ? input.source.value
          : null,
        sourceNodeId: '', outputKey: '',
      }
  })
}

/** 按媒体类别返回 Canvas 正式输出的默认固定 key。 */
function defaultOutputKey(kind: CanvasMediaInputBinding['kind']): string {
  if (kind === 'text') return 'agent.text'
  if (kind === 'image') return 'image.asset'
  if (kind === 'audio') return 'audio.asset'
  if (kind === 'video') return 'video.asset'
  return ''
}

/** 将未绑定工作流的已完成草稿转换为 typed 输入，保留直接值且不猜测模板字段。 */
export function buildCanvasMediaUnboundInputs(drafts: readonly CanvasMediaWorkflowInputDraft[]): CanvasMediaInputBinding[] {
  return drafts.flatMap((draft): CanvasMediaInputBinding[] => {
    if (draft.sourceType === 'canvas-output') {
      if (!draft.sourceNodeId || !draft.outputKey || draft.kind === 'number' || draft.kind === 'boolean') return []
      return [{ key: draft.key, kind: draft.kind, source: { type: 'canvas-output', nodeId: draft.sourceNodeId, outputKey: draft.outputKey } }]
    }
    if (draft.kind === 'image' || draft.kind === 'audio' || draft.kind === 'video') {
      return draft.asset?.mediaKind === draft.kind
        ? [{ key: draft.key, kind: draft.kind, source: { type: 'literal', value: { ...draft.asset } } }] : []
    }
    if (draft.kind === 'text') return [{ key: draft.key, kind: 'text', source: { type: 'literal', value: draft.value } }]
    if (draft.kind === 'boolean') return [{ key: draft.key, kind: 'boolean', source: { type: 'literal', value: draft.value === 'true' } }]
    /** 空数值保留为未完成槽位，不能转换成意外的零。 */
    const value = Number(draft.value)
    return draft.value.trim() !== '' && Number.isFinite(value)
      ? [{ key: draft.key, kind: 'number', source: { type: 'literal', value } }] : []
  })
}

/** 把工作流版本转换为节点配置；缺少媒体素材时由 Canvas 输出草稿承接。 */
export function createCanvasMediaWorkflowDraft(
  workflow: MediaWorkflowVersion,
  values: Record<string, MediaInputValue> = {},
  usePromptDefaults = true,
): CanvasMediaWorkflowInputDraft[] {
  return workflow.definition.bindings.map((binding): CanvasMediaWorkflowInputDraft => {
    if (!binding.field) throw new Error(`工作流输入 ${binding.key} 缺少字段合同。`)
    const provided = values[binding.key]
    const promptValue = workflow.definition.prompt[binding.nodeId]?.inputs[binding.input]
    const scalar = provided?.kind === 'scalar'
      ? provided.value
      : usePromptDefaults && (typeof promptValue === 'string' || typeof promptValue === 'number' || typeof promptValue === 'boolean')
        ? promptValue
        : binding.kind === 'boolean' ? false : ''
    const asset = provided?.kind === 'asset' && provided.asset.mediaKind === binding.kind
      ? provided.asset
      : null
    return {
      key: binding.key,
      kind: binding.kind,
      label: binding.field.label,
      controlType: binding.field.controlType,
      required: binding.field.required,
      ...(binding.field.min === undefined ? {} : { min: binding.field.min }),
      ...(binding.field.max === undefined ? {} : { max: binding.field.max }),
      ...(binding.field.step === undefined ? {} : { step: binding.field.step }),
      sourceType: 'literal',
      value: asset?.assetId ?? String(scalar),
      asset,
      bindingNodeId: binding.nodeId,
      bindingInput: binding.input,
      sourceNodeId: '',
      outputKey: defaultOutputKey(binding.kind),
    }
  })
}

/** 将字段草稿严格转换为 MediaRun typed values，返回首个用户可修复的中文错误。 */
export function buildCanvasMediaWorkflowValues(
  workflow: MediaWorkflowVersion,
  drafts: readonly CanvasMediaWorkflowInputDraft[],
): { values: Record<string, MediaInputValue>; error: string | null } {
  if (drafts.length !== workflow.definition.bindings.length) return { values: {}, error: '工作流输入合同已变化，请重新载入版本。' }
  const values: Record<string, MediaInputValue> = {}
  for (const [index, binding] of workflow.definition.bindings.entries()) {
    const draft = drafts[index]
    if (!draft || draft.key !== binding.key || draft.kind !== binding.kind || draft.sourceType !== 'literal') {
      return { values: {}, error: `输入 ${binding.key} 与工作流合同不一致。` }
    }
    if (binding.kind === 'image' || binding.kind === 'audio' || binding.kind === 'video') {
      if (!draft.asset || draft.asset.mediaKind !== binding.kind) return { values: {}, error: `输入 ${draft.label} 需要选择素材。` }
      values[binding.key] = { kind: 'asset', asset: draft.asset }
      continue
    }
    const value = binding.kind === 'number'
      ? draft.value.trim() === '' ? Number.NaN : Number(draft.value)
      : binding.kind === 'boolean' ? draft.value === 'true' : draft.value
    const problem = validateMediaWorkflowFieldValue(binding, value)
    if (problem) return { values: {}, error: problem }
    values[binding.key] = { kind: 'scalar', value }
  }
  return { values, error: null }
}

/** 将当前草稿中可验证的字段转换为部分值，未完成字段留待运行前校验。 */
export function buildCanvasMediaWorkflowPartialValues(
  workflow: MediaWorkflowVersion,
  drafts: readonly CanvasMediaWorkflowInputDraft[],
): { values: Record<string, MediaInputValue>; errors: Record<string, string> } {
  const values: Record<string, MediaInputValue> = {}
  const errors: Record<string, string> = {}
  for (const binding of workflow.definition.bindings) {
    const draft = drafts.find((item) => item.key === binding.key && item.kind === binding.kind)
    if (!draft || draft.sourceType !== 'literal') { errors[binding.key] = `输入 ${binding.key} 尚未填写。`; continue }
    if (binding.kind === 'image' || binding.kind === 'audio' || binding.kind === 'video') {
      if (!draft.asset || draft.asset.mediaKind !== binding.kind) errors[binding.key] = `输入 ${draft.label} 需要选择素材。`
      else values[binding.key] = { kind: 'asset', asset: draft.asset }
      continue
    }
    const value = binding.kind === 'number'
      ? draft.value.trim() === '' ? Number.NaN : Number(draft.value)
      : binding.kind === 'boolean' ? draft.value === 'true' : draft.value
    const problem = validateMediaWorkflowFieldValue(binding, value)
    if (problem) errors[binding.key] = problem
    else values[binding.key] = { kind: 'scalar', value }
  }
  return { values, errors }
}

/** 校验音视频表单中的直接值；Canvas 输出由 Host resolver 在运行前验证。 */
export function validateCanvasMediaWorkflowDrafts(
  workflow: MediaWorkflowVersion,
  drafts: readonly CanvasMediaWorkflowInputDraft[],
): string | null {
  if (drafts.length !== workflow.definition.bindings.length) return '工作流输入合同已变化，请重新载入版本。'
  for (const [index, binding] of workflow.definition.bindings.entries()) {
    const draft = drafts[index]
    if (!draft || draft.key !== binding.key || draft.kind !== binding.kind) return `输入 ${binding.key} 与工作流合同不一致。`
    if (draft.sourceType === 'canvas-output') {
      if (!draft.sourceNodeId || !draft.outputKey) return `输入 ${draft.label} 的 Canvas 来源不完整。`
      continue
    }
    if (binding.kind === 'image' || binding.kind === 'audio' || binding.kind === 'video') {
      if (!draft.asset || draft.asset.mediaKind !== binding.kind) return `输入 ${draft.label} 需要选择素材。`
      continue
    }
    const value = binding.kind === 'number'
      ? draft.value.trim() === '' ? Number.NaN : Number(draft.value)
      : binding.kind === 'boolean' ? draft.value === 'true' : draft.value
    const problem = validateMediaWorkflowFieldValue(binding, value)
    if (problem) return problem
  }
  return null
}

/** 把可用工作流版本转换为音视频节点配置，不为媒体字段猜测或默认选择素材。 */
export function createCanvasMediaWorkflowSelectionDraft(
  target: CanvasMediaTarget,
  workflow: MediaWorkflowVersion,
): { inputs: CanvasMediaWorkflowInputDraft[]; outputs: CanvasMediaOutputBinding[] } {
  const primaryIndex = workflow.definition.outputs.findIndex((output) => output.mediaType === target.mediaKind)
  if (primaryIndex < 0) throw new Error('当前工作流没有匹配节点类型的主输出。')
  const inputs = createCanvasMediaWorkflowDraft(workflow)
  const outputs = workflow.definition.outputs.map((output, order): CanvasMediaOutputBinding => ({
    key: output.key,
    mediaKind: output.mediaType,
    role: order === primaryIndex ? 'primary' : output.mediaType === 'image' ? 'preview' : 'auxiliary',
    order,
  }))
  return { inputs, outputs }
}

/** 只保存当前已完成且合法的输入，保留工作流其余字段待后续补全。 */
export function buildPartialInputs(
  workflow: MediaWorkflowVersion,
  drafts: readonly CanvasMediaWorkflowInputDraft[],
): CanvasMediaInputBinding[] {
  const partial = buildCanvasMediaWorkflowPartialValues(workflow, drafts).values
  const literalInputs = workflow.definition.bindings.flatMap((binding): CanvasMediaInputBinding[] => {
    const value = partial[binding.key]
    if (!value) return []
    return [{
      key: binding.key,
      kind: binding.kind,
      source: value.kind === 'asset'
        ? { type: 'literal', value: { ...value.asset } }
        : { type: 'literal', value: value.value },
    } as CanvasMediaInputBinding]
  })
  const canvasInputs = drafts.flatMap((draft): CanvasMediaInputBinding[] => {
    if (draft.sourceType !== 'canvas-output' || !draft.sourceNodeId || !draft.outputKey
      || draft.kind === 'number' || draft.kind === 'boolean') return []
    return [{
      key: draft.key,
      kind: draft.kind,
      source: { type: 'canvas-output', nodeId: draft.sourceNodeId, outputKey: draft.outputKey },
    }]
  })
  return workflow.definition.bindings.flatMap((binding) => {
    const input = [...literalInputs, ...canvasInputs].find((candidate) => candidate.key === binding.key)
    return input ? [input] : []
  })
}

/** 判断运行仍允许取消。 */
function isActiveRun(run: MediaRunSnapshot): boolean {
  return run.phase !== 'succeeded' && run.phase !== 'failed' && run.phase !== 'cancelled'
}

/** 把预设身份编码为 Select 的稳定值，避免同 ID 的历史 revision 相互覆盖。 */
export function createCanvasMediaWorkflowSelection(
  workflow: Pick<MediaWorkflowVersion, 'id' | 'revision'>,
): string {
  return `${workflow.id}:${workflow.revision}`
}

/** 按 Select 的完整身份精确解析工作流 revision。 */
export function resolveCanvasMediaWorkflow(
  workflows: readonly MediaWorkflowVersion[],
  selection: string,
): MediaWorkflowVersion | undefined {
  return workflows.find((workflow) => createCanvasMediaWorkflowSelection(workflow) === selection)
}

/**
 * 解析音视频工作流首次使用的连接。
 * @param savedConnectionId 节点配置中已经保存的连接。
 * @param defaultConnectionId 画布当前默认连接。
 * @returns 已保存连接优先，否则继承默认；均无值时返回空选择。
 */
export function resolveCanvasMediaWorkflowConnection(
  savedConnectionId: string | null | undefined,
  defaultConnectionId: string | null | undefined,
): string {
  return savedConnectionId ?? defaultConnectionId ?? ''
}

/**
 * 仅让尚未形成配置的干净草稿跟随稍晚到达的画布默认连接。
 * @param currentConnectionId 当前工作台本地连接选择。
 * @param defaultConnectionId 画布最新默认连接。
 * @param hasPersistedConfiguration 节点是否已有保存配置。
 * @param hasLocalWorkflowSelection 用户是否已在本地选择工作流。
 * @param dirty 用户是否已修改当前草稿。
 * @returns 可安全应用的连接；已有配置或本地编辑时保持当前值。
 */
export function resolveDelayedCanvasDefaultConnection(
  currentConnectionId: string,
  defaultConnectionId: string | null | undefined,
  hasPersistedConfiguration: boolean,
  hasLocalWorkflowSelection: boolean,
  dirty: boolean,
): string {
  if (hasPersistedConfiguration || hasLocalWorkflowSelection || dirty) return currentConnectionId
  return defaultConnectionId ?? ''
}

/**
 * 在默认连接异步变化时同步一个仍可继承默认值的本地草稿。
 * @param currentConnectionId 当前本地连接。
 * @param defaultConnectionId 画布最新默认连接。
 * @param hasPersistedConfiguration 是否已有权威配置。
 * @param hasLocalWorkflowSelection 是否已选择本地工作流。
 * @param dirty 是否已有用户编辑。
 * @param onChange 仅在可继承值真实变化时更新本地连接。
 */
export function useDelayedCanvasDefaultConnection(
  currentConnectionId: string,
  defaultConnectionId: string | null | undefined,
  hasPersistedConfiguration: boolean,
  hasLocalWorkflowSelection: boolean,
  dirty: boolean,
  onChange: (connectionId: string) => void,
): void {
  React.useEffect(() => {
    /** 当前规则允许应用的连接值。 */
    const nextConnectionId = resolveDelayedCanvasDefaultConnection(
      currentConnectionId,
      defaultConnectionId,
      hasPersistedConfiguration,
      hasLocalWorkflowSelection,
      dirty,
    )
    if (nextConnectionId !== currentConnectionId) onChange(nextConnectionId)
  }, [currentConnectionId, defaultConnectionId, dirty, hasLocalWorkflowSelection, hasPersistedConfiguration, onChange])
}

/**
 * 过滤音视频节点可见的工作流作用域。
 * @param workflows 全局媒体目录中的工作流版本。
 * @param projectId 当前画布所属项目。
 * @returns 公共工作流与当前项目工作流，保持原目录顺序。
 */
export function selectCanvasMediaWorkflowsForProject(
  workflows: readonly MediaWorkflowVersion[],
  projectId: string,
): MediaWorkflowVersion[] {
  return workflows.filter((workflow) => workflow.projectId === null || workflow.projectId === projectId)
}

/** 优先展示活跃运行；没有活跃运行时展示最近更新的终态运行。 */
export function getCanvasMediaDisplayRun(
  runs: readonly MediaRunSnapshot[],
): MediaRunSnapshot | null {
  const ordered = [...runs].sort((left, right) => (
    right.updatedAt - left.updatedAt || right.revision - left.revision
  ))
  return ordered.find(isActiveRun) ?? ordered[0] ?? null
}

/** 隔离工作台异步 LOAD 代次，并记录草稿是否已被用户修改。 */
export class CanvasMediaDraftLoadGuard {
  /** 最近一次 LOAD 或目标切换的代次。 */
  private generation = 0
  /** true 表示本地草稿尚未保存。 */
  private dirty = false

  /** 开始一轮读取并返回本轮唯一代次。 */
  begin(): number {
    this.generation += 1
    return this.generation
  }

  /** 目标切换或卸载时让全部在途读取失效。 */
  invalidate(): void {
    this.generation += 1
  }

  /** 记录用户对当前草稿的修改。 */
  markDirty(): void {
    this.dirty = true
  }

  /** 保存成功或目标切换后允许权威配置重新建立草稿。 */
  markClean(): void {
    this.dirty = false
  }

  /** 返回当前草稿是否存在尚未保存的用户修改。 */
  isDirty(): boolean {
    return this.dirty
  }

  /** 判断异步回调是否仍属于当前目标的最后一轮读取。 */
  isCurrent(generation: number): boolean {
    return generation === this.generation
  }

  /** 决定当前响应能否提交，以及是否允许覆盖本地草稿。 */
  accept(generation: number, preserveDirtyDraft: boolean): {
    accepted: boolean
    replaceDraft: boolean
  } {
    const accepted = this.isCurrent(generation)
    return {
      accepted,
      replaceDraft: accepted && (!preserveDirtyDraft || !this.dirty),
    }
  }
}

/** 可恢复错误只匹配完整错误码，所有展示文本均由 Renderer 本地确定。 */
const CANVAS_MEDIA_RECOVERY_MESSAGES: Readonly<Record<string, string>> = {
  MEDIA_FILE_BUSY: '媒体数据正在被其他操作使用，请稍后重试。',
  CANVAS_MEDIA_CONNECT_UNAVAILABLE: '当前画布不可编辑，请恢复写权限后重试。',
  CANVAS_MEDIA_CONNECT_BUSY: '画布正在保存或整理，请完成后重试。',
  CANVAS_MEDIA_CONNECT_BLOCKED: '请等待相关节点运行或审批结束，再补齐输入连线。',
  CANVAS_MEDIA_CONNECT_STALE: '画布已变化，请重新打开详情后补齐输入连线。',
  CANVAS_MEDIA_CONFIG_CONFLICT: '输入配置已变化，请重新打开详情核对来源后重试。',
  CANVAS_REVISION_CONFLICT: '画布已被其他操作更新，请重新打开详情后重试。',
  CANVAS_MEDIA_TARGET_INVALID: '媒体节点已变化，请重新打开该节点的详情。',
  COMFY_OBJECT_INFO_SIZE_LIMIT: 'ComfyUI 节点目录超过安全处理上限，请更新应用；若仍失败，请精简服务端自定义节点。',
  COMFY_OBJECT_INFO_INVALID: '节点接口响应失效，请刷新 ComfyUI 节点目录后重试。',
  COMFYUI_REQUEST_TIMEOUT: '连接 ComfyUI 超时，请检查服务状态后重试。',
  COMFYUI_RESPONSE_SIZE_LIMIT: 'ComfyUI 响应超过安全大小上限，请更新应用；若仍失败，请精简服务端自定义节点。',
  COMFYUI_AUTHENTICATION_REQUIRED: 'ComfyUI 认证失败，请检查连接凭据和访问权限。',
  COMFYUI_NETWORK_UNAVAILABLE: '无法连接 ComfyUI，请检查服务地址和网络状态后重试。',
}

/** 工作流错误码对应的本地文案；绝不采用 IPC 携带的原因文本。 */
const CANVAS_MEDIA_WORKFLOW_ISSUE_MESSAGES: Readonly<Record<string, string>> = {
  NODE_CLASS_UNKNOWN: '服务器未安装该节点',
  NODE_CLASS_UNSAFE: '节点没有安全执行合同',
  NODE_INTERFACE_UNSUPPORTED: '服务器未提供可验证的节点接口',
  INPUT_REQUIRED: '缺少必填输入',
  INPUT_UNKNOWN: '输入不在节点接口中',
  INPUT_HIDDEN: '输入不可由工作流提交',
  INPUT_ENUM_INVALID: '输入不在服务器允许选项中',
  INPUT_TYPE_INVALID: '输入类型与服务器要求不匹配',
  INPUT_RANGE_INVALID: '数值超出服务器允许范围',
  LINK_NODE_UNKNOWN: '连接来源节点不存在',
  LINK_TYPE_INVALID: '连接两端类型不兼容',
  LINK_LIST_UNSUPPORTED: '当前不支持列表连接',
  OUTPUT_INDEX_INVALID: '连接引用了不存在的输出',
  WORKFLOW_CYCLE: '工作流包含循环依赖',
  OUTPUT_REQUIRED: '缺少可收集的输出节点',
  OUTPUT_SELECTOR_INVALID: '输出选择器无效',
  OUTPUT_MEDIA_UNSUPPORTED: '输出媒体类型未适配',
  OUTPUT_DECLARATION_REQUIRED: '输出节点缺少可收集声明',
  OUTPUT_PREFIX_INVALID: '输出目录前缀不安全',
  BINDING_TARGET_INVALID: '媒体绑定目标无效',
  RESOURCE_BINDING_REQUIRED: '资源输入必须使用受管素材绑定',
  RESOURCE_CONSTANT_FORBIDDEN: '资源输入不能直接写入远端路径',
  RESOURCE_ENUM_REQUIRED: '资源输入缺少服务器文件枚举合同',
  RESOURCE_CONTRACT_REQUIRED: '资源输入缺少安全上传合同',
}

/** 从可信工作流错误合同重建最多四项中文诊断，并保留安全节点和字段定位。 */
function formatCanvasMediaWorkflowValidationError(message: string): string | null {
  if (!message.startsWith('MEDIA_WORKFLOW_INVALID:')) return null
  /** 主进程错误类最多公开四项，Renderer 再次限长以防伪造的 IPC 文本扩大展示。 */
  const descriptions = message.slice('MEDIA_WORKFLOW_INVALID:'.length).split('|').slice(0, 4).flatMap((item) => {
    /** 原因正文不可信，只读取稳定 code 与受限定位符。 */
    const match = /^([A-Z0-9_]{1,96})(?:@([A-Za-z0-9_.:-]{1,513}))?:/.exec(item)
    if (!match) return []
    const code = match[1]!
    const location = match[2]
    const reason = CANVAS_MEDIA_WORKFLOW_ISSUE_MESSAGES[code] ?? '工作流结构不满足安全执行要求'
    if (!location) return [`${reason}。（${code}）`]
    /** 旧 wire 用点拼接两个均可含点的字段，无法无歧义拆分，因此完整保留中性定位。 */
    return [`位置 ${location}：${reason}。（${code}）`]
  })
  return descriptions.length > 0 ? `工作流校验失败：${descriptions.join('；')}` : null
}

/** 从 Canvas 准备错误的安全 key/nodeId/input 三元组重建输入诊断。 */
function formatCanvasMediaInputPreparationError(message: string): string | null {
  /** 仅支持已有准备错误类产生的三种输入码，拒绝任意错误正文。 */
  const match = /^(CANVAS_MEDIA_INPUT_REQUIRED|CANVAS_MEDIA_INPUT_CONTRACT_MISMATCH|CANVAS_MEDIA_INPUT_INVALID):[\s\S]*（key=([A-Za-z0-9_.:-]{1,256})，nodeId=([A-Za-z0-9_.:-]{1,256})，input=([A-Za-z0-9_.:-]{1,256})）。?$/.exec(message)
  if (!match) return null
  const code = match[1]!
  const key = match[2]!
  const nodeId = match[3]!
  const input = match[4]!
  const description = code === 'CANVAS_MEDIA_INPUT_REQUIRED'
    ? `输入 ${key} 未配置`
    : code === 'CANVAS_MEDIA_INPUT_CONTRACT_MISMATCH'
      ? `输入 ${key} 与工作流字段类型不匹配`
      : `输入 ${key} 的值不符合字段约束`
  return `${description}（节点 ${nodeId} 的字段 ${input}）。（${code}）`
}

/** 把未知异常收敛为工作台可展示文本；入参为本地或 IPC 异常，返回恢复说明。 */
export function getCanvasMediaErrorMessage(cause: unknown, fallback: string): string {
  if (!(cause instanceof Error) || !cause.message.trim()) return fallback
  /** Electron 包装只影响传输前缀，不改变业务错误码。 */
  const message = cause.message.replace(/^Error invoking remote method '[^']+': Error: /, '')
  const workflowMessage = formatCanvasMediaWorkflowValidationError(message)
  if (workflowMessage) return workflowMessage
  const inputMessage = formatCanvasMediaInputPreparationError(message)
  if (inputMessage) return inputMessage
  /** 普通业务错误只读取首个稳定 code；其余正文可能含路径、凭据或堆栈。 */
  const code = /^([A-Z0-9_]{1,96})(?::|$)/.exec(message)?.[1]
  if (!code) return fallback
  const recovery = CANVAS_MEDIA_RECOVERY_MESSAGES[code]
  return recovery ? `${recovery}（${code}）` : fallback
}

/** 保存配置成功后才启动运行，避免运行消费未提交草稿。 */
export async function saveAndRunCanvasMedia(
  target: CanvasMediaTarget,
  operationId: string,
  save: () => Promise<CanvasMediaModuleConfig>,
  run: CanvasMediaWorkbenchAdapter['canvasMediaRun'],
): Promise<MediaRunSnapshot> {
  const config = await save()
  return run({ ...target, expectedConfigRevision: config.revision, operationId })
}

/** bundle 输出一次采用整组 key；普通输出只采用自身。 */
export function getCanvasMediaAdoptionKeys(
  candidate: CanvasMediaModuleSnapshot['candidates'][number],
  outputKey: string,
): string[] {
  const output = candidate.outputs.find((item) => item.key === outputKey)
  if (!output) return []
  return output.bundle
    ? candidate.outputs.filter((item) => item.bundle === output.bundle).map((item) => item.key)
    : [output.key]
}

/** 候选预览的稳定身份；目标字段由工作台在调用 IPC 时补齐。 */
export interface CanvasMediaPreviewIdentity {
  candidateId: string
  outputKey: string
  outputOrder: number
}

/** 判断两个预览身份是否指向同一候选输出。 */
function isSameCanvasMediaPreviewIdentity(
  left: CanvasMediaPreviewIdentity,
  right: CanvasMediaPreviewIdentity,
): boolean {
  return left.candidateId === right.candidateId
    && left.outputKey === right.outputKey
    && left.outputOrder === right.outputOrder
}

/**
 * 解析视频工作台首次应展示的主输出。
 * 已采用输出优先；尚未采用时按候选创建时间、原数组顺序及输出 order 选择第一份有效视频主输出。
 */
export function resolveCanvasMediaDefaultPreview(
  snapshot: CanvasMediaModuleSnapshot,
): CanvasMediaPreviewIdentity | null {
  if (snapshot.target.mediaKind !== 'video') return null
  for (const adopted of snapshot.config.adoptedOutputs) {
    if (adopted.mediaKind !== 'video' || adopted.role !== 'primary') continue
    const candidate = snapshot.candidates.find((item) => item.id === adopted.candidateId)
    const output = candidate?.outputs.find((item) => (
      item.key === adopted.key
      && item.order === adopted.order
      && item.mediaKind === 'video'
      && item.role === 'primary'
    ))
    if (candidate && output) {
      return { candidateId: candidate.id, outputKey: output.key, outputOrder: output.order }
    }
  }
  const candidates = snapshot.candidates
    .map((candidate, index) => ({ candidate, index }))
    .sort((left, right) => left.candidate.createdAt - right.candidate.createdAt || left.index - right.index)
  for (const { candidate } of candidates) {
    const output = candidate.outputs
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => item.mediaKind === 'video' && item.role === 'primary')
      .sort((left, right) => left.item.order - right.item.order || left.index - right.index)[0]?.item
    if (output) return { candidateId: candidate.id, outputKey: output.key, outputOrder: output.order }
  }
  return null
}

/** 记录默认预览的单次尝试与用户手动意图，避免刷新重试风暴或抢回选择。 */
export class CanvasMediaPreviewAutoloadGuard {
  /** 当前媒体目标的稳定身份。 */
  private targetIdentity = ''
  /** 用户手动预览或采用后，当前目标不再自动切换。 */
  private manual = false
  /** 最近一次自动尝试，失败后普通刷新也不会重复读取。 */
  private attempted: CanvasMediaPreviewIdentity | null = null

  /** 目标变化时清空上个节点的自动尝试和手动选择；同一目标普通刷新保持原记录。 */
  resetForTarget(targetIdentity: string): void {
    if (targetIdentity === this.targetIdentity) return
    this.targetIdentity = targetIdentity
    this.manual = false
    this.attempted = null
  }

  /** 用户已明确选择当前目标的预览，后续快照刷新保持该选择。 */
  markManual(targetIdentity: string): void {
    this.resetForTarget(targetIdentity)
    this.manual = true
  }

  /** 原子认领一次默认读取；相同目标和输出最多认领一次。 */
  claim(targetIdentity: string, preview: CanvasMediaPreviewIdentity): boolean {
    this.resetForTarget(targetIdentity)
    if (this.manual || (this.attempted && isSameCanvasMediaPreviewIdentity(this.attempted, preview))) return false
    this.attempted = preview
    return true
  }
}

/** 释放预览授权；null 表示当前没有活跃 lease。 */
export async function releaseCanvasMediaPreview(
  adapter: Pick<CanvasMediaWorkbenchAdapter, 'canvasMediaReleasePreview'>,
  target: CanvasMediaTarget,
  current: CanvasMediaOutputPreview | null,
): Promise<void> {
  if (current) await adapter.canvasMediaReleasePreview({ ...target, mediaLeaseId: current.mediaLeaseId })
}

/** 切换预览时先释放旧 lease，再读取新候选。 */
export async function replaceCanvasMediaPreview(
  adapter: Pick<CanvasMediaWorkbenchAdapter, 'canvasMediaReleasePreview' | 'canvasMediaReadPreview'>,
  target: CanvasMediaTarget,
  current: CanvasMediaOutputPreview | null,
  input: Parameters<CanvasMediaWorkbenchAdapter['canvasMediaReadPreview']>[0],
): Promise<CanvasMediaOutputPreview> {
  await releaseCanvasMediaPreview(adapter, target, current)
  return adapter.canvasMediaReadPreview(input)
}

/** 串行化预览 lease 的所有权；过期读取完成后立即释放，避免快速切换或卸载造成授权泄漏。 */
export class CanvasMediaPreviewLeaseOwner {
  /** 当前请求代次；每次切换或释放都会让更早的异步读取失效。 */
  private generation = 0
  /** 当前由工作台持有且正在展示的预览 lease。 */
  private current: CanvasMediaOutputPreview | null = null

  constructor(
    /** 提供预览读取与释放能力的渲染器适配器。 */
    private readonly adapter: Pick<CanvasMediaWorkbenchAdapter, 'canvasMediaReleasePreview' | 'canvasMediaReadPreview'>,
    /** lease 所属的固定 Canvas 媒体节点。 */
    private readonly target: CanvasMediaTarget,
    /** 同步工作台展示状态；null 表示当前没有有效预览。 */
    private readonly onPreviewChanged: (preview: CanvasMediaOutputPreview | null) => void,
  ) {}

  /** 切换到指定候选；只有最后一次仍有效的读取可以成为当前 lease。 */
  async replace(input: Parameters<CanvasMediaWorkbenchAdapter['canvasMediaReadPreview']>[0]): Promise<void> {
    const requestGeneration = ++this.generation
    const previous = this.current
    this.current = null
    this.onPreviewChanged(null)
    await releaseCanvasMediaPreview(this.adapter, this.target, previous)
    const next = await this.adapter.canvasMediaReadPreview(input)
    if (requestGeneration !== this.generation) {
      await releaseCanvasMediaPreview(this.adapter, this.target, next)
      return
    }
    this.current = next
    this.onPreviewChanged(next)
  }

  /** 使所有在途读取失效，并释放当前已取得的 lease。 */
  async release(): Promise<void> {
    this.generation += 1
    const current = this.current
    this.current = null
    this.onPreviewChanged(null)
    await releaseCanvasMediaPreview(this.adapter, this.target, current)
  }
}

/** 由工作流 field 元数据驱动的共享表单；素材必须由用户显式选择。 */
export function CanvasMediaWorkflowForm({
  inputs,
  assets,
  writable,
  busy,
  allowCanvasOutput = false,
  onInputChange,
  projectId,
  canvasDocument,
  imagePreviews,
  onConnectInputs,
  canvasTarget,
  canvasMediaReadConfig,
  dirty = false,
  connectionState,
}: {
  inputs: readonly CanvasMediaWorkflowInputDraft[]
  assets: readonly MediaAssetRecord[]
  writable: boolean
  busy: boolean
  allowCanvasOutput?: boolean
  onInputChange(index: number, input: CanvasMediaWorkflowInputDraft): void
  /** 素材导入必须落入当前项目，未提供项目的只读预览不显示导入动作。 */
  projectId?: string
  canvasDocument?: CanvasDocument
  imagePreviews?: readonly CanvasImagePreview[]
  onConnectInputs?: () => Promise<void>
  canvasTarget?: CanvasMediaTarget
  canvasMediaReadConfig?: CanvasMediaWorkbenchAdapter['canvasMediaReadConfig']
  dirty?: boolean
  connectionState?: CanvasMediaInputConnections | null
}): React.ReactElement {
  /** 新导入素材在父目录刷新前保留短期投影，不改变工作流模板。 */
  const [importedAssets, setImportedAssets] = React.useState<MediaAssetRecord[]>([])
  const [importingKey, setImportingKey] = React.useState<string | null>(null)
  const [importError, setImportError] = React.useState<string | null>(null)
  const active = React.useRef(true)
  const current = React.useRef({ inputs, projectId, onInputChange })
  current.current = { inputs, projectId, onInputChange }
  React.useEffect(() => { active.current = true; return () => { active.current = false } }, [])
  React.useEffect(() => { setImportedAssets([]); setImportError(null) }, [projectId])
  const availableAssets = [...assets, ...importedAssets.filter((item) => !assets.some((asset) => asset.id === item.id))]
  const fieldErrors = React.useMemo(() => {
    const errors: Record<string, string> = {}
    for (const input of inputs) {
      if (input.sourceType === 'canvas-output') {
        if (!input.sourceNodeId || !input.outputKey) errors[input.key] = '待填写 Canvas 来源。'
      } else if (input.kind === 'image' || input.kind === 'audio' || input.kind === 'video') {
        if (!input.asset) errors[input.key] = '待选择素材。'
      } else if (input.kind === 'number') {
        const value = Number(input.value)
        if (input.value.trim() === '' || !Number.isFinite(value)) errors[input.key] = '待填写有效数值。'
        else if (input.min !== undefined && value < input.min) errors[input.key] = `不能小于 ${input.min}。`
        else if (input.max !== undefined && value > input.max) errors[input.key] = `不能大于 ${input.max}。`
      }
      else if (input.kind === 'text' && input.required && input.value.trim() === '') errors[input.key] = '待填写必填文本。'
    }
    return errors
  }, [inputs])
  /** 原生选择器返回后仍校验原槽位和项目，防止迟到文件填入另一个工作流。 */
  const importAsset = async (index: number, input: CanvasMediaWorkflowInputDraft): Promise<void> => {
    if (!projectId || (input.kind !== 'image' && input.kind !== 'audio' && input.kind !== 'video')) return
    setImportingKey(input.key)
    setImportError(null)
    try {
      const asset = await window.electronAPI.mediaImportLocalAsset(projectId, input.kind)
      if (!active.current || projectId !== current.current.projectId || input !== current.current.inputs[index] || !asset) return
      setImportedAssets((items) => [...items.filter((item) => item.id !== asset.id), asset].slice(-128))
      current.current.onInputChange(index, { ...input, value: asset.id, asset: { assetId: asset.id, revision: asset.revision, hash: asset.hash, mediaKind: asset.mediaKind } })
    } catch (error) {
      if (active.current && projectId === current.current.projectId) setImportError(error instanceof Error ? error.message : '媒体导入失败')
    } finally { if (active.current) setImportingKey(null) }
  }
  /** 渲染单个真实绑定字段；高级字段由外层统一折叠。 */
  const renderInput = (input: CanvasMediaWorkflowInputDraft, index: number): React.ReactElement => {
        /** 单点更新保持父组件对 dirty 草稿的唯一所有权。 */
        const update = (changes: Partial<CanvasMediaWorkflowInputDraft>): void => onInputChange(index, { ...input, ...changes })
        const mediaInput = input.kind === 'image' || input.kind === 'audio' || input.kind === 'video'
        return (
          <div key={input.key} className="canvas-media-form-field grid min-w-0 gap-2 border-b border-border pb-3">
            <Label className="min-w-0 break-words pt-2 text-xs">{input.label}{input.required ? ' *' : ''}<span className="mt-0.5 block break-all text-[10px] text-muted-foreground">{input.bindingNodeId ? `节点 ${input.bindingNodeId} · ${input.bindingInput || input.key}` : '待工作流绑定'}</span></Label>
            {allowCanvasOutput && (mediaInput || input.kind === 'text') ? (
              <Select value={input.sourceType} disabled={!writable || busy} onValueChange={(value: 'literal' | 'canvas-output') => update({ sourceType: value })}>
                <SelectTrigger className="canvas-media-form-source h-8 w-28 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="literal">直接值</SelectItem><SelectItem value="canvas-output">Canvas 输出</SelectItem></SelectContent>
              </Select>
            ) : <div className="canvas-media-form-source-empty" />}
            <div className="canvas-media-form-value min-w-0">
            {input.sourceType === 'canvas-output' ? (
              canvasDocument ? <CanvasMediaSourcePicker
                document={canvasDocument}
                imagePreviews={imagePreviews}
                inputKind={input.kind}
                label={input.label}
                targetNodeId={canvasTarget?.nodeId}
                value={input.sourceNodeId ? { nodeId: input.sourceNodeId, outputKey: input.outputKey } : null}
                disabled={!writable || busy}
                loadMediaConfig={canvasMediaReadConfig && canvasTarget ? async (node) => {
                  const loaded = await canvasMediaReadConfig({ ...canvasTarget, nodeId: node.id, mediaModuleId: node.mediaModuleId, mediaKind: node.kind })
                  return loaded.outputs
                } : undefined}
                onChange={(value) => update({ sourceNodeId: value.nodeId, outputKey: value.outputKey })}
              /> : <p className="text-xs text-muted-foreground">等待 Canvas 节点来源。</p>
            ) : mediaInput ? (
              <div className="flex min-w-0 items-center gap-1">{input.kind === 'image' ? <CanvasMediaImagePicker
                projectId={projectId}
                assets={availableAssets}
                value={input.value}
                label={input.label}
                disabled={!writable || busy || importingKey !== null}
                onSelect={(asset) => update({ value: asset.id, asset: {
                  assetId: asset.id, revision: asset.revision, hash: asset.hash, mediaKind: asset.mediaKind,
                } })}
              /> : <Select value={input.value} disabled={!writable || busy || importingKey !== null} onValueChange={(value) => {
                const asset = availableAssets.find((candidate) => candidate.id === value && candidate.mediaKind === input.kind)
                update({ value, asset: asset ? {
                  assetId: asset.id, revision: asset.revision, hash: asset.hash, mediaKind: asset.mediaKind,
                } : null })
              }}>
                <SelectTrigger className="min-w-0 flex-1"><SelectValue placeholder="选择素材" /></SelectTrigger>
                <SelectContent>{availableAssets.filter((asset) => asset.mediaKind === input.kind).map((asset) => <SelectItem key={asset.id} value={asset.id}>{asset.filename}</SelectItem>)}</SelectContent>
              </Select>}{projectId ? <Button type="button" variant="ghost" size="icon-sm" className="shrink-0" disabled={!writable || busy || importingKey !== null} aria-label={`导入${input.label}`} title={`导入${input.label}`} onClick={() => { void importAsset(index, input) }}>{importingKey === input.key ? <LoaderCircle className="animate-spin" /> : <FileUp />}</Button> : null}</div>
            ) : input.kind === 'boolean' ? (
              <Switch aria-label={`${input.label} 值`} checked={input.value === 'true'} disabled={!writable || busy} onCheckedChange={(value) => update({ value: String(value) })} />
            ) : input.kind === 'text' ? (
              <Textarea aria-label={`${input.label} 值`} className="min-h-20" value={input.value} required={input.required} disabled={!writable || busy} onChange={(event) => update({ value: event.target.value })} />
            ) : (
              <Input
                aria-label={`${input.label} 值`}
                type={input.kind === 'number' ? 'number' : 'text'}
                value={input.value}
                min={input.min}
                max={input.max}
                step={input.step}
                required={input.required}
                disabled={!writable || busy}
                onChange={(event) => update({ value: event.target.value })}
              />
            )}
            </div>
            {fieldErrors[input.key] ? <p className="canvas-media-form-error break-words text-xs text-amber-600" role="status">{fieldErrors[input.key]}</p> : null}
          </div>
        )
  }
  /** 生成类标量统一收进一个高级参数区域，减少长工作流的视觉噪音。 */
  const advanced = inputs.map((input, index) => ({ input, index })).filter(({ input }) => (
    input.controlType === 'number' || input.controlType === 'boolean' || input.controlType === 'seed'
      || input.controlType === 'width' || input.controlType === 'height'
  ))
  const basic = inputs.map((input, index) => ({ input, index })).filter(({ input }) => !advanced.some((item) => item.input.key === input.key))
  const advancedProblemCount = advanced.filter(({ input }) => fieldErrors[input.key]).length
  return (
    <section className="canvas-media-form-container space-y-3" aria-label="工作流输入">
      <h3 className="text-sm font-medium">输入</h3>
      {importError ? <p role="alert" className="text-xs text-destructive">{importError}</p> : null}
      {inputs.length === 0 ? <p className="text-xs text-muted-foreground">当前工作流没有输入。</p> : basic.map(({ input, index }) => renderInput(input, index))}
      {connectionState && !connectionState.connected ? <div role="status" className="space-y-1 text-xs text-amber-600">
        <p>{connectionState.bindings.filter((item) => item.errorCode).length} 项输入待接通。</p>
        {connectionState.bindings.filter((item) => item.errorCode).map((item) => <p key={item.inputKey}>{inputs.find((input) => input.key === item.inputKey)?.label ?? item.inputKey}：{item.message}</p>)}
      </div> : null}
      {onConnectInputs && connectionState?.missingEdges.length ? <Button type="button" variant="outline" size="sm" disabled={!writable || busy || dirty} onClick={() => { void onConnectInputs() }}>补齐输入连线</Button> : null}
      {advanced.length > 0 ? <details className="rounded-sm border border-border px-3 py-2">
        <summary className="cursor-pointer text-xs font-medium text-muted-foreground">高级参数{advancedProblemCount > 0 ? ` · ${advancedProblemCount} 项待配置` : ''}</summary>
        <div className="space-y-3 pt-3">{advanced.map(({ input, index }) => renderInput(input, index))}</div>
      </details> : null}
    </section>
  )
}

/** Canvas 音视频节点完整工作台，负责配置、运行、候选验收和 lease 清理。 */
export function CanvasMediaWorkbench({
  target,
  writable,
  adapter,
  defaultComfyuiConnectionId = null,
  canvasDocument,
  imagePreviews,
  onConnectInputs,
}: {
  target: CanvasMediaTarget
  writable: boolean
  adapter: CanvasMediaWorkbenchAdapter
  /** 新工作流草稿继承的画布默认连接。 */
  defaultComfyuiConnectionId?: string | null
  canvasDocument?: CanvasDocument
  imagePreviews?: readonly CanvasImagePreview[]
  onConnectInputs?: (config: CanvasMediaModuleConfig) => Promise<void>
}): React.ReactElement {
  /** 默认连接只供尚未保存连接的干净草稿读取，切换默认不会直接重置当前编辑。 */
  const defaultConnectionRef = React.useRef(defaultComfyuiConnectionId)
  defaultConnectionRef.current = defaultComfyuiConnectionId
  /** 固定目标对象，避免父组件普通重渲染触发重复 LOAD。 */
  const stableTarget = React.useMemo<CanvasMediaTarget>(() => ({
    projectId: target.projectId,
    canvasId: target.canvasId,
    nodeId: target.nodeId,
    mediaModuleId: target.mediaModuleId,
    mediaKind: target.mediaKind,
  }), [
    target.canvasId,
    target.mediaKind,
    target.mediaModuleId,
    target.nodeId,
    target.projectId,
  ])
  /** 命令可在后台完成，但旧目标回调不得清除新草稿或重新加载旧详情。 */
  const activeTargetRef = React.useRef<CanvasMediaTarget | null>(stableTarget)
  activeTargetRef.current = stableTarget
  const [snapshot, setSnapshot] = React.useState<CanvasMediaModuleSnapshot | null>(null)
  const [settings, setSettings] = React.useState<MediaSettingsSnapshot | null>(null)
  const [inputs, setInputs] = React.useState<CanvasMediaWorkflowInputDraft[]>([])
  const [outputs, setOutputs] = React.useState<CanvasMediaOutputBinding[]>([])
  const [workflowSelection, setWorkflowSelection] = React.useState('')
  const [connectionSelection, setConnectionSelection] = React.useState('')
  const [loading, setLoading] = React.useState(true)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [preview, setPreview] = React.useState<CanvasMediaOutputPreview | null>(null)
  const [previewError, setPreviewError] = React.useState<string | null>(null)
  /** 准备检查仅属于当前已保存配置，不替代运行时复验。 */
  const [preparationStatus, setPreparationStatus] = React.useState<CanvasMediaPreparationStatus | null>(null)
  /** 当前请求错误不混入持久化工作流诊断。 */
  const [preparationError, setPreparationError] = React.useState<string | null>(null)
  /** LOAD 代次和 dirty 状态不参与渲染，使用单个稳定守卫保存。 */
  const loadGuardRef = React.useRef(new CanvasMediaDraftLoadGuard())
  /** 每个媒体目标拥有独立 lease owner，目标切换会清理旧 owner。 */
  const previewLeaseOwner = React.useMemo(() => new CanvasMediaPreviewLeaseOwner(
    adapter,
    stableTarget,
    setPreview,
  ), [adapter, stableTarget])
  /** 视频默认预览仅尝试一次，并在用户手动选择后停止跟随快照。 */
  const previewAutoloadGuardRef = React.useRef(new CanvasMediaPreviewAutoloadGuard())
  /** 预览请求代次隔离快速切换、目标变化及迟到错误。 */
  const previewRequestGenerationRef = React.useRef(0)
  /** 目标身份不依赖对象引用，供预览守卫判断真实节点切换。 */
  const previewTargetIdentity = React.useMemo(() => [
    stableTarget.projectId,
    stableTarget.canvasId,
    stableTarget.nodeId,
    stableTarget.mediaModuleId,
    stableTarget.mediaKind,
  ].join('\u0000'), [stableTarget])
  /** 展开工作台与折叠 AV 卡片共享同一项目 watch 引用计数。 */
  const mediaWatchRegistry = React.useMemo(
    () => getMediaProjectWatchLeaseRegistry(adapter),
    [adapter],
  )

  /** 重新读取模块与媒体目录；事件刷新只在草稿干净时同步配置编辑区。 */
  const load = React.useCallback(async (options: {
    preserveDirtyDraft?: boolean
    showLoading?: boolean
  } = {}): Promise<void> => {
    const generation = loadGuardRef.current.begin()
    if (options.showLoading !== false) setLoading(true)
    setError(null)
    try {
      const [nextSnapshot, nextSettings] = await Promise.all([
        adapter.canvasMediaLoad(stableTarget),
        adapter.mediaGetSettings(),
      ])
      const decision = loadGuardRef.current.accept(generation, options.preserveDirtyDraft === true)
      if (!decision.accepted) return
      setSnapshot(nextSnapshot)
      setSettings(nextSettings)
      if (decision.replaceDraft) {
        const selectedWorkflow = nextSnapshot.config.workflow
          ? nextSettings.workflows.find((item) => item.id === nextSnapshot.config.workflow?.workflowId
            && item.revision === nextSnapshot.config.workflow.workflowRevision)
          : undefined
        setInputs(createInputDrafts(nextSnapshot.config, selectedWorkflow))
        setOutputs(nextSnapshot.config.outputs)
        setWorkflowSelection(nextSnapshot.config.workflow
          ? createCanvasMediaWorkflowSelection({
              id: nextSnapshot.config.workflow.workflowId,
              revision: nextSnapshot.config.workflow.workflowRevision,
            })
          : '')
        setConnectionSelection(resolveCanvasMediaWorkflowConnection(
          nextSnapshot.config.workflow?.connectionId,
          defaultConnectionRef.current,
        ))
      }
    } catch (cause) {
      if (loadGuardRef.current.isCurrent(generation)) {
        setError(getCanvasMediaErrorMessage(cause, '媒体模块加载失败。'))
      }
    } finally {
      if (loadGuardRef.current.isCurrent(generation)) setLoading(false)
    }
  }, [adapter, stableTarget])

  React.useEffect(() => {
    activeTargetRef.current = stableTarget
    loadGuardRef.current.markClean()
    setSnapshot(null)
    setSettings(null)
    setInputs([])
    setOutputs([])
    setWorkflowSelection('')
    setConnectionSelection('')
    setLoading(true)
    setBusy(false)
    setError(null)
    void load()
    return () => {
      loadGuardRef.current.invalidate()
      if (activeTargetRef.current === stableTarget) activeTargetRef.current = null
    }
  }, [load])
  React.useEffect(() => {
    /** cleanup 后忽略迟到 watch 失败，避免旧目标覆盖当前错误。 */
    let disposed = false
    const releaseModule = adapter.onCanvasMediaChanged((event) => {
      if (event.target.projectId === stableTarget.projectId && event.target.canvasId === stableTarget.canvasId
        && event.target.nodeId === stableTarget.nodeId && event.target.mediaModuleId === stableTarget.mediaModuleId) {
        void load({ preserveDirtyDraft: true, showLoading: false })
      }
    })
    const releaseRun = adapter.onMediaRunChanged((event) => {
      if (event.run.projectId !== stableTarget.projectId) return
      setSnapshot((current) => current && current.runs.some((run) => run.id === event.run.id)
        ? {
            ...current,
            runs: current.runs.map((run) => run.id === event.run.id && event.run.revision > run.revision
              ? event.run
              : run),
          }
        : current)
    })
    void mediaWatchRegistry.acquire(stableTarget.projectId).catch(() => {
      if (!disposed) setError('媒体进度订阅失败，请重试。')
    })
    return () => {
      disposed = true
      releaseModule()
      releaseRun()
      void mediaWatchRegistry.release(stableTarget.projectId)
    }
  }, [adapter, load, mediaWatchRegistry, stableTarget])
  React.useEffect(() => {
    previewAutoloadGuardRef.current.resetForTarget(previewTargetIdentity)
    setPreviewError(null)
    return () => {
      previewRequestGenerationRef.current += 1
      void previewLeaseOwner.release()
    }
  }, [previewLeaseOwner])

  React.useEffect(() => {
    /** 清除上一图/配置的结果；effect 清理阻断卸载和后续请求的迟到响应。 */
    let active = true
    setPreparationStatus(null)
    setPreparationError(null)
    if (!adapter.canvasMediaCheckPreparation || !snapshot || loadGuardRef.current.isDirty()) {
      return
    }
    const expectedRevision = snapshot.config.revision
    void adapter.canvasMediaCheckPreparation(stableTarget).then((status) => {
      if (!active || loadGuardRef.current.isDirty()) return
      if (status.configRevision !== expectedRevision) { setPreparationError('配置已变化，请刷新后重新检查。'); return }
      setPreparationStatus(status)
    }).catch(() => { if (active) setPreparationError('准备状态检查失败，请刷新后重试。') })
    return () => { active = false }
  }, [adapter, canvasDocument?.revision, snapshot?.config.revision, stableTarget])

  /** 读取精确候选；手动读取允许重试，并阻止后续刷新改回默认项。 */
  const openPreview = React.useCallback(async (
    identity: CanvasMediaPreviewIdentity,
    manual: boolean,
  ): Promise<void> => {
    if (manual) previewAutoloadGuardRef.current.markManual(previewTargetIdentity)
    const requestGeneration = ++previewRequestGenerationRef.current
    setPreviewError(null)
    try {
      await previewLeaseOwner.replace({ ...stableTarget, ...identity })
    } catch (cause) {
      if (requestGeneration === previewRequestGenerationRef.current) {
        setPreviewError(getCanvasMediaErrorMessage(cause, '视频预览加载失败，请重试。'))
      }
    }
  }, [previewLeaseOwner, previewTargetIdentity, stableTarget])

  React.useEffect(() => {
    if (!snapshot || snapshot.target.projectId !== stableTarget.projectId
      || snapshot.target.canvasId !== stableTarget.canvasId
      || snapshot.target.nodeId !== stableTarget.nodeId
      || snapshot.target.mediaModuleId !== stableTarget.mediaModuleId
      || snapshot.target.mediaKind !== stableTarget.mediaKind) return
    const identity = resolveCanvasMediaDefaultPreview(snapshot)
    if (!identity || !previewAutoloadGuardRef.current.claim(previewTargetIdentity, identity)) return
    void openPreview(identity, false)
  }, [openPreview, previewTargetIdentity, snapshot, stableTarget])

  const workflows = selectCanvasMediaWorkflowsForProject(
    settings?.workflows ?? [],
    stableTarget.projectId,
  ).filter((workflow) => workflow.definition.outputs.some((output) => output.mediaType === stableTarget.mediaKind)
    && (!(settings?.archivedWorkflowIds ?? []).includes(workflow.id)
      || workflow.id === snapshot?.config.workflow?.workflowId))
  const connections = (settings?.connections ?? []).filter((connection) => connection.enabled
    && connection.archivedAt === undefined)
  /** 未完成 LOAD，或旧预设、工作流、残留输入输出存在时，都不能继承新默认。 */
  const hasPersistedConfiguration = snapshot === null || Boolean(
    snapshot.config.profile
    || snapshot.config.workflow
    || snapshot.config.inputs.length
    || snapshot.config.outputs.length,
  )
  useDelayedCanvasDefaultConnection(
    connectionSelection,
    defaultComfyuiConnectionId,
    hasPersistedConfiguration,
    workflowSelection !== '',
    loadGuardRef.current.isDirty(),
    setConnectionSelection,
  )

  /** 保存当前草稿并返回提交后的配置 revision。 */
  const save = React.useCallback(async (): Promise<CanvasMediaModuleConfig> => {
    if (!snapshot || !settings) throw new Error('媒体模块尚未加载。')
    const workflow = resolveCanvasMediaWorkflow(workflows, workflowSelection)
    if (workflowSelection && !workflow) throw new Error('所选工作流版本不可用，请重新选择。')
    const connection = connections.find((item) => item.id === connectionSelection)
    if (workflow && !connection) throw new Error('请选择已启用的连接。')
    const config = await adapter.canvasMediaSave({
      ...stableTarget,
      expectedConfigRevision: snapshot.config.revision,
      profile: workflow ? null : snapshot.config.profile,
      workflow: workflow ? { workflowId: workflow.id, workflowRevision: workflow.revision, connectionId: connection!.id } : null,
      preparation: null,
      inputs: workflow ? buildPartialInputs(workflow, inputs) : buildCanvasMediaUnboundInputs(inputs),
      outputs,
    })
    /** 配置已经持久化；即使随后启动运行失败，也不能继续把相同草稿标成未保存。 */
    if (activeTargetRef.current === stableTarget) loadGuardRef.current.markClean()
    return config
  }, [adapter, connectionSelection, connections, inputs, outputs, settings, snapshot, stableTarget, workflowSelection, workflows])

  /** 串行执行命令并统一刷新权威快照。 */
  const execute = React.useCallback(async (
    command: () => Promise<unknown>,
    options: { commitDraft?: boolean; refresh?: boolean } = {},
  ): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await command()
      if (activeTargetRef.current !== stableTarget) return
      if (options.commitDraft) loadGuardRef.current.markClean()
      if (options.refresh !== false) {
        await load({ preserveDirtyDraft: !options.commitDraft, showLoading: false })
      }
    } catch (cause) {
      if (activeTargetRef.current === stableTarget) setError(getCanvasMediaErrorMessage(cause, '媒体操作失败。'))
    } finally {
      if (activeTargetRef.current === stableTarget) setBusy(false)
    }
  }, [busy, load, stableTarget])

  /** 更新单个输入草稿并统一标记未保存状态。 */
  const updateInput = React.useCallback((
    index: number,
    update: (current: CanvasMediaWorkflowInputDraft) => CanvasMediaWorkflowInputDraft,
  ): void => {
    loadGuardRef.current.markDirty()
    setInputs((current) => current.map((item, itemIndex) => itemIndex === index ? update(item) : item))
  }, [])

  /** 连接只由已保存输入和图决定，编辑文本时复用结果；切换中的过期目标暂不展示。 */
  const connectionState = React.useMemo<CanvasMediaInputConnections | null>(() => {
    if (!canvasDocument || !snapshot) return null
    try { return inspectCanvasMediaInputConnections(canvasDocument, stableTarget, snapshot.config.inputs) }
    catch { return null }
  }, [canvasDocument, snapshot?.config.inputs, stableTarget])

  if (loading) return <div className="flex h-full items-center justify-center gap-2 text-xs text-muted-foreground" role="status"><LoaderCircle className="size-4 animate-spin" />加载媒体模块</div>
  if (!snapshot || !settings) return (
    <div className="flex h-full min-w-0 flex-col items-center justify-center gap-3 p-4 text-sm text-muted-foreground">
      <p className="max-w-md break-words text-center [overflow-wrap:anywhere]" role="alert">{error ?? '媒体模块不可用。'}</p>
      <Button size="sm" variant="outline" onClick={() => void load()}><RefreshCw />重试</Button>
    </div>
  )

  const activeRun = snapshot.runs.find(isActiveRun)
  const displayRun = getCanvasMediaDisplayRun(snapshot.runs)
  const runProgress = displayRun ? projectMediaRunProgress(displayRun) : null
  /** 每个可用工作流的最高 revision 只用于标注，不会自动切换当前历史版本。 */
  const latestWorkflowRevisions = new Map<string, number>()
  for (const workflow of workflows) {
    latestWorkflowRevisions.set(workflow.id, Math.max(latestWorkflowRevisions.get(workflow.id) ?? 0, workflow.revision))
  }
  const canSaveWorkflow = !workflowSelection || Boolean(connectionSelection)
  const canRunLegacyProfile = Boolean(snapshot.config.profile && !snapshot.config.workflow && !workflowSelection)
  const selectedWorkflow = resolveCanvasMediaWorkflow(workflows, workflowSelection)
  const workflowValidationError = selectedWorkflow
    ? validateCanvasMediaWorkflowDrafts(selectedWorkflow, inputs)
    : '请选择工作流。'
  const canRunWorkflow = canSaveWorkflow && workflowValidationError === null
  const preparation = snapshot.config.preparation
  const runError = displayRun?.error?.trim() || null
  return (
    <div className="canvas-media-workbench-container h-full min-h-0">
      <div className="canvas-media-workbench-layout">
        <section className="canvas-media-preview-pane flex min-h-0 min-w-0 flex-col border-b border-border" aria-label="媒体预览与版本">
          <header className="flex min-w-0 shrink-0 items-center justify-between gap-3 px-4 py-3">
            <h3 className="shrink-0 text-sm font-semibold">{stableTarget.mediaKind === 'video' ? '视频预览' : '音频预览'}</h3>
            {runProgress ? <div className="flex min-w-0 items-center gap-1.5 text-xs" role="status" aria-live="polite">
              {activeRun ? <LoaderCircle className="size-3.5 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : null}
              <span className="truncate">{runProgress.phaseLabel}</span>
            </div> : null}
          </header>
          <ScrollArea className="canvas-media-preview-scroll min-h-0 flex-1">
            <div className="space-y-4 px-4 pb-4">
              <section aria-label="候选预览" className="flex aspect-video w-full min-w-0 items-center justify-center overflow-hidden rounded-sm border border-border bg-muted/40">
                {preview?.asset.mediaKind === 'video' ? <video className="h-full w-full object-contain" controls preload="metadata" src={preview.mediaUrl} />
                  : preview?.asset.mediaKind === 'audio' ? <div className="flex w-full min-w-0 flex-col items-center gap-6 px-4 py-6"><AudioLines className="size-10 text-muted-foreground" aria-hidden="true" /><audio className="w-full min-w-0" controls preload="metadata" src={preview.mediaUrl} /></div>
                    : preview ? <img className="h-full w-full object-contain" src={preview.mediaUrl} alt="候选输出预览" />
                      : <div className="flex flex-col items-center gap-2 px-3 py-6 text-xs text-muted-foreground">
                        {stableTarget.mediaKind === 'video' ? <Film className="size-7" aria-hidden="true" /> : <AudioLines className="size-7" aria-hidden="true" />}
                        <span>{snapshot.candidates.length > 0 ? '尚未选择预览' : stableTarget.mediaKind === 'video' ? '尚未生成视频' : '尚未生成音频'}</span>
                      </div>}
              </section>
              {previewError ? <p className="break-words text-xs text-destructive" role="alert">预览加载失败：{previewError}</p> : null}
              {runProgress?.nodeProgressLabel ? <p className="break-words text-xs text-muted-foreground" role="status">{runProgress.nodeProgressLabel}</p> : null}
              {runError ? <p className="break-words text-xs text-destructive" role="alert">运行失败：{runError}</p> : null}
              <section className="space-y-3" aria-label="候选历史">
                <h3 className="flex items-center gap-1.5 text-xs font-medium"><History className="size-3.5" aria-hidden="true" />历史版本</h3>
                {snapshot.candidates.length === 0 ? <p className="text-xs text-muted-foreground">暂无历史版本</p> : [...snapshot.candidates].reverse().map((candidate) => (
                  <div key={candidate.id} className="space-y-3 border-b border-border pb-3">
                    <p className="break-words text-[11px] text-muted-foreground">配置 v{candidate.sourceConfigRevision} · {new Date(candidate.createdAt).toLocaleString('zh-CN')}</p>
                    {candidate.outputs.map((output) => {
                      /** 预览、导出与采用沿用同一份精确候选身份，不因布局改动而改变执行对象。 */
                      const selectedKeys = getCanvasMediaAdoptionKeys(candidate, output.key)
                      const adoptedOutput = snapshot.config.adoptedOutputs.find((item) => item.key === output.key && item.candidateId === candidate.id)
                      const adopted = adoptedOutput !== undefined
                      const initiallySelected = adoptedOutput !== undefined
                        && 'selectionOrigin' in adoptedOutput
                        && adoptedOutput.selectionOrigin === 'initial'
                      const exact = { ...stableTarget, candidateId: candidate.id, outputKey: output.key, outputOrder: output.order }
                      const selected = preview?.candidateId === candidate.id && preview.outputKey === output.key && preview.outputOrder === output.order
                      return <div key={output.key} className="space-y-1.5 text-xs">
                        <p className="break-all text-muted-foreground">{output.key} · {output.mediaKind === 'video' ? '视频' : output.mediaKind === 'audio' ? '音频' : '图片'} · {output.role === 'primary' ? '主输出' : output.role === 'preview' ? '预览' : '辅助输出'}</p>
                        <div className="flex flex-wrap items-center gap-1">
                          <Button size="sm" variant={selected ? 'secondary' : 'ghost'} aria-pressed={selected} disabled={busy} onClick={() => void openPreview(exact, true)}><Eye />预览</Button>
                          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void execute(() => adapter.canvasMediaExportOutput(exact), { refresh: false })}><Download />导出</Button>
                          {initiallySelected ? <span className="text-muted-foreground">当前默认</span> : null}
                          <Button size="sm" variant={adopted ? 'secondary' : 'outline'} className="h-auto min-h-8 max-w-full whitespace-normal break-all" disabled={!writable || busy || (adopted && !initiallySelected)} onClick={() => void execute(async () => {
                            previewAutoloadGuardRef.current.markManual(previewTargetIdentity)
                            await adapter.canvasMediaAdopt({ ...stableTarget, expectedConfigRevision: snapshot.config.revision, candidateId: candidate.id, selectedKeys })
                            await openPreview(exact, false)
                          })}><Check />{initiallySelected ? '确认采用' : adopted ? '已采用' : output.bundle ? `采用 ${output.bundle} 组` : '采用'}</Button>
                        </div>
                      </div>
                    })}
                  </div>
                ))}
              </section>
            </div>
          </ScrollArea>
        </section>

        <section className="flex min-h-0 min-w-0 flex-col" aria-label="媒体生成配置">
          <header className="shrink-0 px-4 py-3"><h3 className="text-sm font-semibold">生成配置</h3></header>
          <ScrollArea className="canvas-media-config-scroll min-h-0 flex-1">
            <div className="space-y-4 px-4 pb-4">
              {!writable ? <p className="text-xs text-muted-foreground">当前画布为只读状态</p> : null}
              {preparation ? <p className="break-words border-l-2 border-amber-500/40 pl-2 text-xs text-amber-700" role="status">待配置：{preparation.message}</p> : null}
              <section aria-label="媒体准备阶段" className="space-y-2 rounded-md border border-border p-3 text-xs">
                <div className="flex flex-wrap gap-x-3 gap-y-1 text-muted-foreground">
                  <span>已建卡</span>
                  <span>{connectionState?.connected ? '输入已接通' : '输入待接通'}</span>
                  <span>{preparationStatus ? preparationStatus.workflowBound ? '工作流已绑定' : '工作流待绑定' : '工作流待检查'}</span>
                  <span>{loadGuardRef.current.isDirty() ? '配置待保存' : preparationStatus?.ready && connectionState?.connected ? '可运行' : '运行条件待满足'}</span>
                </div>
                {loadGuardRef.current.isDirty() ? <p className="text-amber-600" role="status">有未保存配置，准备状态将在保存后更新。</p>
                  : preparationError ? <p className="text-amber-600" role="status">{preparationError}</p>
                  : preparationStatus ? preparationStatus.issues.map((issue, index) => <p key={`${issue.code}:${index}`} className="text-amber-600" role="status">{issue.message}</p>)
                  : <p className="text-muted-foreground" role="status">运行准备尚未检查。</p>}
              </section>
              <div className="min-w-0 space-y-1.5">
                <Label className="text-xs" htmlFor="canvas-media-workflow">工作流</Label>
                <Select value={workflowSelection} disabled={!writable || busy} onValueChange={(value) => {
                  const workflow = resolveCanvasMediaWorkflow(workflows, value)
                  if (!workflow) { setError('工作流版本不可用。'); return }
                  try {
                    const draft = createCanvasMediaWorkflowSelectionDraft(stableTarget, workflow)
                    loadGuardRef.current.markDirty()
                    setWorkflowSelection(value); setInputs(draft.inputs); setOutputs(draft.outputs); setError(null)
                  } catch (cause) { setError(getCanvasMediaErrorMessage(cause, '工作流不可用。')) }
                }}>
                  <SelectTrigger id="canvas-media-workflow" className="h-8 w-full min-w-0 text-xs"><SelectValue placeholder="选择工作流" /></SelectTrigger>
                  <SelectContent>{workflows.map((workflow) => {
                    const current = workflow.id === snapshot.config.workflow?.workflowId
                      && workflow.revision === snapshot.config.workflow.workflowRevision
                    const latest = workflow.revision === latestWorkflowRevisions.get(workflow.id)
                    return <SelectItem key={createCanvasMediaWorkflowSelection(workflow)} value={createCanvasMediaWorkflowSelection(workflow)}>{workflow.name}{workflow.projectId === null ? '' : ' · 项目'} · v{workflow.revision}{latest ? ' · 最新' : ''}{current ? ' · 当前' : ''}</SelectItem>
                  })}</SelectContent>
                </Select>
              </div>
              <div className="min-w-0 space-y-1.5">
                <Label className="text-xs" htmlFor="canvas-media-connection">服务器</Label>
                <Select value={connectionSelection} disabled={!writable || busy} onValueChange={(value) => {
                  loadGuardRef.current.markDirty(); setConnectionSelection(value); setError(null)
                }}>
                  <SelectTrigger id="canvas-media-connection" className="h-8 w-full min-w-0 text-xs"><SelectValue placeholder="选择连接" /></SelectTrigger>
                  <SelectContent>{connections.map((connection) => <SelectItem key={connection.id} value={connection.id}>{connection.name}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              {canRunLegacyProfile ? <p className="text-xs text-muted-foreground">旧预设配置</p> : null}
              <CanvasMediaWorkflowForm
                projectId={stableTarget.projectId}
                inputs={inputs}
                assets={snapshot.assets}
                writable={writable}
                busy={busy}
                allowCanvasOutput
                canvasDocument={canvasDocument}
                imagePreviews={imagePreviews}
                canvasTarget={stableTarget}
                canvasMediaReadConfig={adapter.canvasMediaReadConfig}
                dirty={loadGuardRef.current.isDirty()}
                connectionState={connectionState}
                onConnectInputs={onConnectInputs ? async () => {
                  if (loadGuardRef.current.isDirty()) { setError('请先保存当前输入。'); return }
                  await execute(() => onConnectInputs(snapshot.config))
                } : undefined}
                onInputChange={(index, input) => updateInput(index, () => input)}
              />
            </div>
          </ScrollArea>
          <footer className="shrink-0 space-y-2 border-t border-border bg-background p-3" aria-label="媒体主操作">
            {error ? <p className="max-h-12 overflow-y-auto break-words text-xs text-destructive" role="alert">{error}</p> : null}
            <div className="flex items-center gap-2">
              <Button size="sm" variant="outline" disabled={!writable || busy || !canSaveWorkflow} onClick={() => void execute(save, { commitDraft: true })}><Check />保存</Button>
              {activeRun ? (
                <Button className="min-w-0 flex-1" size="sm" variant="outline" disabled={busy} onClick={() => void execute(() => adapter.canvasMediaCancel({ ...stableTarget, runId: activeRun.id }))}><Square />取消</Button>
              ) : (
                <Button className="min-w-0 flex-1" size="sm" disabled={!writable || busy || (!canRunWorkflow && !canRunLegacyProfile)} title={!canRunLegacyProfile && workflowValidationError ? workflowValidationError : undefined} onClick={() => void execute(async () => {
                  if (canRunLegacyProfile) {
                    await adapter.canvasMediaRun({ ...stableTarget, expectedConfigRevision: snapshot.config.revision, operationId: crypto.randomUUID() })
                  } else {
                    const workflow = resolveCanvasMediaWorkflow(workflows, workflowSelection)
                    const inputProblem = workflow ? validateCanvasMediaWorkflowDrafts(workflow, inputs) : '请选择工作流。'
                    if (inputProblem) { setError(inputProblem); return }
                    await saveAndRunCanvasMedia(stableTarget, crypto.randomUUID(), save, adapter.canvasMediaRun)
                  }
                }, { commitDraft: true })}>{busy ? <LoaderCircle className="animate-spin motion-reduce:animate-none" /> : <Play />}运行</Button>
              )}
            </div>
          </footer>
        </section>
      </div>
    </div>
  )
}
