import type {
  ComfyPrompt,
  JsonValue,
  MediaWorkflowBinding,
  MediaWorkflowDefinition,
  MediaWorkflowFieldControlType,
  MediaWorkflowFieldMetadata,
  MediaWorkflowFieldValueKind,
} from './media-workflow'

/** API JSON 输入字段在编辑器中的分类。 */
export type MediaWorkflowFieldKind = MediaWorkflowFieldValueKind | 'linked' | 'complex'

/** 从 API JSON 真实节点输入提取的候选字段。 */
export interface MediaWorkflowField {
  nodeId: string
  input: string
  classType: string
  nodeTitle: string
  value: JsonValue
  valueKind: MediaWorkflowFieldKind
  editable: boolean
  reason?: string
}

/** 字段绑定校验的稳定问题码。 */
export type MediaWorkflowFieldBindingIssueCode =
  | 'FIELD_BINDING_LIMIT_EXCEEDED'
  | 'FIELD_KEY_DUPLICATE'
  | 'FIELD_TARGET_DUPLICATE'
  | 'FIELD_NODE_MISSING'
  | 'FIELD_CLASS_CHANGED'
  | 'FIELD_INPUT_MISSING'
  | 'FIELD_NOT_EDITABLE'
  | 'FIELD_VALUE_KIND_CHANGED'
  | 'FIELD_METADATA_INVALID'
  | 'FIELD_CONTROL_INVALID'
  | 'FIELD_CONSTRAINT_INVALID'

/** 单条字段绑定问题；列表固定最多返回 64 项。 */
export interface MediaWorkflowFieldBindingIssue {
  code: MediaWorkflowFieldBindingIssueCode
  key?: string
  nodeId?: string
  input?: string
  message: string
}

const MAX_PROMPT_NODES = 512
const MAX_PROMPT_INPUTS = 2_048
const MAX_BINDINGS = 128
const MAX_ISSUES = 64

/** 媒体控件到官方 loader 精确输入的映射。 */
const MEDIA_CONTROLS: Readonly<Record<'image' | 'audio' | 'video', {
  classType: string
  input: string
  loader: 'LoadImage' | 'LoadAudio' | 'LoadVideo'
}>> = {
  image: { classType: 'LoadImage', input: 'image', loader: 'LoadImage' },
  audio: { classType: 'LoadAudio', input: 'audio', loader: 'LoadAudio' },
  video: { classType: 'LoadVideo', input: 'file', loader: 'LoadVideo' },
}

/** 判断值是否为当前图内的标准 ComfyUI 连线。 */
function isPromptLink(prompt: ComfyPrompt, value: JsonValue): boolean {
  return Array.isArray(value) && value.length === 2 && typeof value[0] === 'string'
    && Object.hasOwn(prompt, value[0]) && typeof value[1] === 'number'
    && Number.isSafeInteger(value[1]) && value[1] >= 0
}

/** 返回 API 字面量的可编辑基础类型。 */
function scalarValueKind(value: JsonValue): MediaWorkflowFieldValueKind | undefined {
  if (typeof value === 'string') return 'string'
  if (typeof value === 'number') return 'number'
  if (typeof value === 'boolean') return 'boolean'
  return undefined
}

/** 克隆 JSON 值，避免编辑器意外改写公共模板。 */
function cloneJsonValue(value: JsonValue): JsonValue {
  return structuredClone(value)
}

/** 检查图的遍历边界并返回节点条目。 */
function boundedEntries(prompt: ComfyPrompt): Array<[string, ComfyPrompt[string]]> {
  /** 工作流节点条目。 */
  const entries = Object.entries(prompt)
  if (entries.length > MAX_PROMPT_NODES) throw new Error('COMFY_PROMPT_LIMIT_EXCEEDED')
  /** 已累计的真实输入数量。 */
  let inputCount = 0
  for (const [, node] of entries) {
    inputCount += Object.keys(node.inputs).length
    if (inputCount > MAX_PROMPT_INPUTS) throw new Error('COMFY_PROMPT_LIMIT_EXCEEDED')
  }
  return entries
}

/**
 * 列出 API JSON 中的真实 inputs；标量可编辑，连线和复杂值只读。
 * @param prompt 已解析的 ComfyUI API 图。
 * @returns 按节点及 input 原顺序排列的有界字段列表。
 */
export function listMediaWorkflowFields(prompt: ComfyPrompt): MediaWorkflowField[] {
  /** 提取后的字段列表。 */
  const fields: MediaWorkflowField[] = []
  for (const [nodeId, node] of boundedEntries(prompt)) {
    /** 节点标题仅用于展示，字段身份仍由 nodeId 与 class_type 固定。 */
    const nodeTitle = node._meta?.title.trim() || node.class_type
    for (const [input, value] of Object.entries(node.inputs)) {
      /** 当前输入的基础值类型。 */
      const scalarKind = scalarValueKind(value)
      if (scalarKind) {
        fields.push({ nodeId, input, classType: node.class_type, nodeTitle, value: cloneJsonValue(value), valueKind: scalarKind, editable: true })
      } else if (isPromptLink(prompt, value)) {
        fields.push({
          nodeId, input, classType: node.class_type, nodeTitle, value: cloneJsonValue(value), valueKind: 'linked', editable: false,
          reason: '该输入来自其他节点连线，不能直接覆盖。',
        })
      } else {
        fields.push({
          nodeId, input, classType: node.class_type, nodeTitle, value: cloneJsonValue(value), valueKind: 'complex', editable: false,
          reason: '数组、对象或空值不能映射为填写项。',
        })
      }
    }
  }
  return fields
}

/** 返回控件要求的原始值类型。 */
function controlValueKind(controlType: MediaWorkflowFieldControlType): MediaWorkflowFieldValueKind {
  if (controlType === 'boolean') return 'boolean'
  if (controlType === 'number' || controlType === 'seed' || controlType === 'width' || controlType === 'height') return 'number'
  return 'string'
}

/** 返回控件写入现有编译器时使用的绑定类别。 */
function controlBindingKind(controlType: MediaWorkflowFieldControlType): MediaWorkflowBinding['kind'] {
  if (controlType === 'image' || controlType === 'audio' || controlType === 'video') return controlType
  if (controlType === 'text') return 'text'
  if (controlType === 'boolean') return 'boolean'
  return 'number'
}

/** 判断控件是否为媒体上传控件。 */
export function isMediaWorkflowControl(controlType: MediaWorkflowFieldControlType): controlType is 'image' | 'audio' | 'video' {
  return controlType === 'image' || controlType === 'audio' || controlType === 'video'
}

/**
 * 校验 prepare 阶段收到的单个字段值，不做字符串转数字等隐式规范化。
 * @param binding 带可选新字段元数据的工作流绑定。
 * @param value 调用方提供的原始 scalar 值；可选字段可传 undefined 后由 Host 回退 prompt 字面量。
 * @returns 无问题返回 null，否则返回可直接展示的中文原因。
 */
export function validateMediaWorkflowFieldValue(binding: MediaWorkflowBinding, value: unknown): string | null {
  /** 新字段元数据；旧绑定继续由既有 prepare/compile 合同校验。 */
  const metadata = binding.field
  if (!metadata) return null
  if (isMediaWorkflowControl(metadata.controlType)) return `${metadata.label} 必须使用已上传媒体回执。`
  if (value === undefined) return metadata.required ? `${metadata.label} 是必填项。` : null
  if (typeof value !== metadata.valueKind) return `${metadata.label} 的数据类型已变化。`
  if (typeof value === 'string') {
    return metadata.required && value.trim().length === 0 ? `${metadata.label} 是必填项。` : null
  }
  if (typeof value !== 'number') return null
  if (!Number.isFinite(value)) return `${metadata.label} 必须是有限数字。`
  if (isIntegerFieldControl(metadata.controlType) && !Number.isSafeInteger(value)) return `${metadata.label} 必须是安全整数。`
  if (metadata.controlType === 'seed' && value < 0) return `${metadata.label} 不能小于 0。`
  if ((metadata.controlType === 'width' || metadata.controlType === 'height') && value < 1) return `${metadata.label} 必须是正整数。`
  if (metadata.min !== undefined && value < metadata.min) return `${metadata.label} 不能小于最小值 ${metadata.min}。`
  if (metadata.max !== undefined && value > metadata.max) return `${metadata.label} 不能大于最大值 ${metadata.max}。`
  if (metadata.step !== undefined) {
    /** 步长以显式最小值为基准，否则从 0 开始。 */
    const quotient = (value - (metadata.min ?? 0)) / metadata.step
    if (Math.abs(quotient - Math.round(quotient)) > 1e-9) return `${metadata.label} 不符合步长 ${metadata.step}。`
  }
  return null
}

/** 判断控件是否要求安全整数。 */
function isIntegerFieldControl(controlType: MediaWorkflowFieldControlType): boolean {
  return controlType === 'seed' || controlType === 'width' || controlType === 'height'
}

/**
 * 为一个真实 scalar input 创建声明式绑定，不写入或制造默认值。
 * @param field `listMediaWorkflowFields` 返回的字段。
 * @param controlType 用户选择的控件；缺省按原始类型选择普通控件。
 * @returns 可直接加入工作流定义的绑定。
 */
export function createMediaWorkflowFieldBinding(
  field: MediaWorkflowField,
  controlType?: MediaWorkflowFieldControlType,
): MediaWorkflowBinding {
  if (!field.editable || (field.valueKind !== 'string' && field.valueKind !== 'number' && field.valueKind !== 'boolean')) {
    throw new Error('MEDIA_WORKFLOW_FIELD_NOT_EDITABLE')
  }
  /** 未显式选择时与原始 JSON 类型一致的普通控件。 */
  const selectedControl = controlType ?? (field.valueKind === 'string' ? 'text' : field.valueKind)
  if (controlValueKind(selectedControl) !== field.valueKind) throw new Error('MEDIA_WORKFLOW_FIELD_CONTROL_INVALID')
  /** 媒体控件必须精确对应官方 loader 的唯一上传输入。 */
  const mediaContract = isMediaWorkflowControl(selectedControl) ? MEDIA_CONTROLS[selectedControl] : undefined
  if (mediaContract && (field.classType !== mediaContract.classType || field.input !== mediaContract.input)) {
    throw new Error('MEDIA_WORKFLOW_FIELD_CONTROL_INVALID')
  }
  /** 绑定的 UI 字段元数据。 */
  const metadata: MediaWorkflowFieldMetadata = {
    classType: field.classType,
    valueKind: field.valueKind,
    label: field.input,
    controlType: selectedControl,
    required: true,
    ...(selectedControl === 'seed' ? { min: 0, step: 1 } : {}),
    ...(selectedControl === 'width' || selectedControl === 'height' ? { min: 1, step: 1 } : {}),
  }
  return {
    key: `${field.nodeId}.${field.input}`,
    kind: controlBindingKind(selectedControl),
    nodeId: field.nodeId,
    input: field.input,
    ...(mediaContract ? { loader: mediaContract.loader } : {}),
    field: metadata,
  }
}

/** 判断字段元数据与绑定及其控件语义是否一致。 */
function metadataProblem(binding: MediaWorkflowBinding, metadata: MediaWorkflowFieldMetadata): MediaWorkflowFieldBindingIssue | undefined {
  /** 问题定位的公共字段。 */
  const location = { key: binding.key, nodeId: binding.nodeId, input: binding.input }
  if (!metadata.label.trim() || metadata.label.trim().length > 80 || controlValueKind(metadata.controlType) !== metadata.valueKind
    || controlBindingKind(metadata.controlType) !== binding.kind) {
    return { code: 'FIELD_METADATA_INVALID', ...location, message: `字段元数据无效：${binding.key}` }
  }
  /** 媒体控件必须保持官方 loader、节点类与输入字段三者一致。 */
  if (isMediaWorkflowControl(metadata.controlType)) {
    /** 当前媒体控件的官方合同。 */
    const contract = MEDIA_CONTROLS[metadata.controlType]
    if (metadata.classType !== contract.classType || binding.input !== contract.input || binding.loader !== contract.loader) {
      return { code: 'FIELD_CONTROL_INVALID', ...location, message: `媒体控件目标无效：${binding.key}` }
    }
  } else if (binding.loader !== undefined) {
    return { code: 'FIELD_CONTROL_INVALID', ...location, message: `标量控件不能声明 loader：${binding.key}` }
  }
  if (metadata.valueKind !== 'number') {
    if (metadata.min !== undefined || metadata.max !== undefined || metadata.step !== undefined) {
      return { code: 'FIELD_CONSTRAINT_INVALID', ...location, message: `非数字字段不能声明数值约束：${binding.key}` }
    }
    return undefined
  }
  /** 数字字段所有可选约束都必须是有限数值。 */
  const constraints = [metadata.min, metadata.max, metadata.step].filter((value): value is number => value !== undefined)
  if (!constraints.every(Number.isFinite) || (metadata.step !== undefined && metadata.step <= 0)
    || (metadata.min !== undefined && metadata.max !== undefined && metadata.min > metadata.max)) {
    return { code: 'FIELD_CONSTRAINT_INVALID', ...location, message: `数字约束无效：${binding.key}` }
  }
  if (metadata.controlType === 'seed' || metadata.controlType === 'width' || metadata.controlType === 'height') {
    /** 整数控件的语义下限。 */
    const semanticMinimum = metadata.controlType === 'seed' ? 0 : 1
    if (metadata.min === undefined || metadata.step === undefined
      || ![metadata.min, metadata.step, ...(metadata.max === undefined ? [] : [metadata.max])].every(Number.isSafeInteger)
      || metadata.step < 1 || metadata.min < semanticMinimum || (metadata.max !== undefined && metadata.max < semanticMinimum)) {
      return { code: 'FIELD_CONSTRAINT_INVALID', ...location, message: `整数控件约束无效：${binding.key}` }
    }
  }
  return undefined
}

/**
 * 校验新字段绑定与当前 API JSON 是否仍精确一致；旧无 field 绑定保持兼容。
 * @param definition 待保存或执行的工作流定义。
 * @returns 最多 64 条问题，不包含 output 选择器问题。
 */
export function validateMediaWorkflowFieldBindings(definition: MediaWorkflowDefinition): MediaWorkflowFieldBindingIssue[] {
  boundedEntries(definition.prompt)
  /** 有界问题列表。 */
  const issues: MediaWorkflowFieldBindingIssue[] = []
  /** 在问题上限内追加结果。 */
  const addIssue = (issue: MediaWorkflowFieldBindingIssue): void => {
    if (issues.length < MAX_ISSUES) issues.push(issue)
  }
  if (definition.bindings.length > MAX_BINDINGS) {
    addIssue({ code: 'FIELD_BINDING_LIMIT_EXCEEDED', message: `单个工作流最多映射 ${MAX_BINDINGS} 个填写项` })
  }
  /** 已使用的公开 key。 */
  const keys = new Set<string>()
  /** 已使用的真实节点输入。 */
  const targets = new Set<string>()
  for (const binding of definition.bindings) {
    /** 绑定的精确目标标识。 */
    const target = `${binding.nodeId}\0${binding.input}`
    if (keys.has(binding.key)) addIssue({
      code: 'FIELD_KEY_DUPLICATE', key: binding.key, nodeId: binding.nodeId, input: binding.input, message: `绑定 key 重复：${binding.key}`,
    })
    if (targets.has(target)) addIssue({
      code: 'FIELD_TARGET_DUPLICATE', key: binding.key, nodeId: binding.nodeId, input: binding.input, message: `节点输入被重复绑定：${binding.nodeId}.${binding.input}`,
    })
    keys.add(binding.key)
    targets.add(target)
    if (!binding.field) continue
    /** 当前绑定指向的节点。 */
    const node = definition.prompt[binding.nodeId]
    if (!node) {
      addIssue({ code: 'FIELD_NODE_MISSING', key: binding.key, nodeId: binding.nodeId, input: binding.input, message: `节点已不存在：${binding.nodeId}` })
      continue
    }
    if (binding.field.classType !== node.class_type) {
      addIssue({ code: 'FIELD_CLASS_CHANGED', key: binding.key, nodeId: binding.nodeId, input: binding.input, message: `节点类型已变化：${binding.nodeId}` })
      continue
    }
    if (!Object.hasOwn(node.inputs, binding.input)) {
      addIssue({ code: 'FIELD_INPUT_MISSING', key: binding.key, nodeId: binding.nodeId, input: binding.input, message: `节点输入已不存在：${binding.nodeId}.${binding.input}` })
      continue
    }
    /** 当前 prompt 字段的 scalar 类型。 */
    const actualKind = scalarValueKind(node.inputs[binding.input]!)
    if (!actualKind) {
      addIssue({ code: 'FIELD_NOT_EDITABLE', key: binding.key, nodeId: binding.nodeId, input: binding.input, message: `节点输入当前不可编辑：${binding.nodeId}.${binding.input}` })
      continue
    }
    if (actualKind !== binding.field.valueKind) {
      addIssue({ code: 'FIELD_VALUE_KIND_CHANGED', key: binding.key, nodeId: binding.nodeId, input: binding.input, message: `节点输入类型已变化：${binding.nodeId}.${binding.input}` })
      continue
    }
    /** 元数据自身与绑定类别的兼容性问题。 */
    const problem = metadataProblem(binding, binding.field)
    if (problem) addIssue(problem)
  }
  return issues
}
