/** ComfyUI 协议允许的 JSON 基础值。 */
export type JsonPrimitive = string | number | boolean | null

/** ComfyUI 协议允许的 JSON 对象。 */
export interface JsonObject {
  [key: string]: JsonValue
}

/** ComfyUI 协议允许的递归 JSON 值。 */
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[]

/** API 格式工作流中的单个 ComfyUI 节点。 */
export interface ComfyPromptNode {
  class_type: string
  inputs: Record<string, JsonValue>
  _meta?: { title: string }
}

/** 可直接提交给 `/prompt` 的 ComfyUI API 图。 */
export type ComfyPrompt = Record<string, ComfyPromptNode>

/** object_info 中单个输入的声明，首项为类型名或枚举值。 */
export type ComfyNodeInputSchema = [string | JsonPrimitive[], JsonObject?]

/** object_info 中工作流静态校验所需的节点 schema。 */
export interface ComfyNodeSchema {
  input: {
    required: Record<string, ComfyNodeInputSchema>
    optional?: Record<string, ComfyNodeInputSchema>
    hidden?: Record<string, JsonValue>
  }
  output: string[]
  output_name?: string[]
  output_is_list?: boolean[]
  /** 输出匹配类型；长度必须与 output 一致，null 表示没有匹配类型。 */
  output_matchtypes?: (string | null)[]
  /** 官方 widget 序列化顺序，按 required/optional 分组保存。 */
  input_order?: { required: string[]; optional: string[]; hidden: string[] }
  input_is_list?: boolean
  output_node?: boolean
  category?: string
  display_name?: string
  description?: string
  hidden?: Record<string, JsonValue>
  unsupported?: true
}

/** 以 class_type 为键的 ComfyUI 节点 schema。 */
export type ComfyObjectInfo = Record<string, ComfyNodeSchema>

/** 工作流支持的声明式绑定类别，音视频仅预留协议位。 */
export type MediaWorkflowBindingKind = 'text' | 'number' | 'boolean' | 'image' | 'audio' | 'video'

/** API JSON scalar input 的原始数据类型。 */
export type MediaWorkflowFieldValueKind = 'string' | 'number' | 'boolean'

/** 真实 input 在画布上采用的控件类型。 */
export type MediaWorkflowFieldControlType = 'text' | 'number' | 'boolean' | 'image' | 'video' | 'audio' | 'seed' | 'width' | 'height'

/** 新字段绑定附带的静态身份与填写约束；旧绑定可不含此字段。 */
export interface MediaWorkflowFieldMetadata {
  classType: string
  valueKind: MediaWorkflowFieldValueKind
  label: string
  controlType: MediaWorkflowFieldControlType
  required: boolean
  min?: number
  max?: number
  step?: number
}

/** 工作流输入槽绑定，不允许携带任意转换脚本。 */
export interface MediaWorkflowBinding {
  key: string
  kind: MediaWorkflowBindingKind
  nodeId: string
  input: string
  loader?: 'LoadImage' | 'LoadAudio' | 'LoadVideo'
  field?: MediaWorkflowFieldMetadata
}

/** 工作流产物选择器，当前 outputIndex 指历史媒体数组下标。 */
export interface MediaWorkflowOutputSelector {
  key: string
  nodeId: string
  outputIndex: number
  mediaType: 'image' | 'audio' | 'video'
}

/** 本地保存且无需访问远端即可编译校验的工作流定义。 */
export interface MediaWorkflowDefinition {
  schemaVersion: 1
  prompt: ComfyPrompt
  bindings: MediaWorkflowBinding[]
  outputs: MediaWorkflowOutputSelector[]
}

const MAX_PROMPT_NODES = 512
const MAX_NODE_INPUTS = 128
const MAX_PROMPT_INPUTS = 2_048
const MAX_OBJECT_INFO_CLASSES = 2_048
const MAX_STRING_LENGTH = 16_384
const MAX_JSON_DEPTH = 32
const SAFE_KEY_PATTERN = /^[A-Za-z0-9_.:-]{1,256}$/
const SAFE_CLASS_TYPE_PATTERN = /^[^\u0000-\u001F\u007F/\\]{1,256}$/
const SAFE_CATALOG_CLASS_TYPE_PATTERN = /^[^\u0000-\u001F\u007F]{1,256}$/
const SAFE_LABEL_PATTERN = /^[^\u0000-\u001F\u007F]{1,256}$/
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

/** 判断对象键是否满足长度、字符和原型安全约束。 */
function isSafeKey(value: string): boolean {
  return SAFE_KEY_PATTERN.test(value) && !DANGEROUS_KEYS.has(value)
}

/** 判断节点类型名是否允许官方含空格命名，同时阻断路径与控制字符。 */
function isSafeClassType(value: string): boolean {
  return SAFE_CLASS_TYPE_PATTERN.test(value) && !DANGEROUS_KEYS.has(value) && value.trim() === value
}

/** 判断只用于目录展示的 opaque 节点名是否可安全作为对象键。 */
function isSafeCatalogClassType(value: string): boolean {
  return SAFE_CATALOG_CLASS_TYPE_PATTERN.test(value) && !DANGEROUS_KEYS.has(value) && value.trim() === value
}

/** 判断远端展示标签是否有界且不含控制字符。 */
function isSafeLabel(value: string): boolean {
  return SAFE_LABEL_PATTERN.test(value)
}

/** 判断未知值是否为普通记录。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** 严格比较对象字段集合。 */
function hasExactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key))
}

/** 校验输入是否为受限 JSON，避免递归深度和稀疏数组绕过。 */
function parseJsonValue(value: unknown, depth = 0): JsonValue {
  if (depth > MAX_JSON_DEPTH) throw new Error('COMFY_JSON_DEPTH_EXCEEDED')
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.length <= MAX_STRING_LENGTH) return value
  if (Array.isArray(value)) {
    if (value.length > MAX_NODE_INPUTS || !Array.from({ length: value.length }, (_, index) => Object.hasOwn(value, index)).every(Boolean)) {
      throw new Error('COMFY_JSON_INVALID')
    }
    return value.map((item) => parseJsonValue(item, depth + 1))
  }
  if (isRecord(value) && Object.keys(value).length <= MAX_NODE_INPUTS) {
    /** 复制后的 JSON 对象，阻断原对象后续变更。 */
    const parsed: JsonObject = {}
    for (const [key, item] of Object.entries(value)) {
      if (!isSafeKey(key)) throw new Error('COMFY_JSON_INVALID')
      parsed[key] = parseJsonValue(item, depth + 1)
    }
    return parsed
  }
  throw new Error('COMFY_JSON_INVALID')
}

/**
 * 严格解析 ComfyUI API 格式工作流。
 * @param value 来自文件或 IPC 的未知值。
 * @returns 可直接用于静态处理的有界 API 图。
 */
export function parseComfyPrompt(value: unknown): ComfyPrompt {
  if (!isRecord(value)) throw new Error('COMFY_PROMPT_INVALID')
  /** 图中节点条目。 */
  const entries = Object.entries(value)
  if (entries.length === 0 || entries.length > MAX_PROMPT_NODES) {
    throw new Error(entries.length > MAX_PROMPT_NODES ? 'COMFY_PROMPT_LIMIT_EXCEEDED' : 'COMFY_PROMPT_INVALID')
  }
  /** 解析后的 API 图。 */
  const prompt: ComfyPrompt = {}
  /** 图中累计的 input 数量。 */
  let totalInputs = 0
  for (const [nodeId, rawNode] of entries) {
    if (!isSafeKey(nodeId) || !isRecord(rawNode) || !hasExactKeys(rawNode, ['class_type', 'inputs', '_meta'])) {
      throw new Error('COMFY_PROMPT_INVALID')
    }
    if (typeof rawNode.class_type !== 'string' || !isSafeClassType(rawNode.class_type) || !isRecord(rawNode.inputs)) {
      throw new Error('COMFY_PROMPT_INVALID')
    }
    /** 当前节点 input 数量。 */
    const inputCount = Object.keys(rawNode.inputs).length
    totalInputs += inputCount
    if (inputCount > MAX_NODE_INPUTS || totalInputs > MAX_PROMPT_INPUTS) throw new Error('COMFY_PROMPT_LIMIT_EXCEEDED')
    /** 当前节点解析后的输入。 */
    const inputs: Record<string, JsonValue> = {}
    for (const [input, inputValue] of Object.entries(rawNode.inputs)) {
      if (!isSafeKey(input)) throw new Error('COMFY_PROMPT_INVALID')
      inputs[input] = parseJsonValue(inputValue)
    }
    /** 当前节点可选的显示元数据。 */
    let meta: { title: string } | undefined
    if (rawNode._meta !== undefined) {
      if (!isRecord(rawNode._meta) || !hasExactKeys(rawNode._meta, ['title']) || typeof rawNode._meta.title !== 'string' || rawNode._meta.title.length > 256) {
        throw new Error('COMFY_PROMPT_INVALID')
      }
      meta = { title: rawNode._meta.title }
    }
    prompt[nodeId] = { class_type: rawNode.class_type, inputs, ...(meta ? { _meta: meta } : {}) }
  }
  return prompt
}

/** 解析 object_info 中单个输入 schema。 */
function parseInputSchema(value: unknown, dynamicDepth = 0): ComfyNodeInputSchema {
  if (!Array.isArray(value) || value.length < 1 || value.length > 2) throw new Error('COMFY_OBJECT_INFO_INVALID')
  /** 输入类型名或枚举列表。 */
  const typeValue = value[0]
  let parsedType: string | JsonPrimitive[]
  if (typeof typeValue === 'string' && typeValue.length <= 256) parsedType = typeValue
  else if (Array.isArray(typeValue) && typeValue.length <= 2_048) {
    parsedType = typeValue.map((item) => {
      if (item === null || typeof item === 'boolean') return item
      if (typeof item === 'number' && Number.isFinite(item)) return item
      if (typeof item === 'string' && item.length <= MAX_STRING_LENGTH) return item
      throw new Error('COMFY_OBJECT_INFO_INVALID')
    })
  } else throw new Error('COMFY_OBJECT_INFO_INVALID')
  /** V3 COMBO 参数去除资源列表；显式单选可安全归一为旧枚举合同。 */
  let rawOptions = value[1]
  if (typeValue === 'COMBO' && isRecord(rawOptions) && Object.hasOwn(rawOptions, 'options')) {
    /** V3 未声明 multiselect 时按 ComfyUI 的单选默认值处理。 */
    const multiselect = rawOptions.multiselect
    if (multiselect !== undefined && typeof multiselect !== 'boolean') throw new Error('COMFY_OBJECT_INFO_INVALID')
    /** V3 COMBO 声明的有界基础值选项。 */
    const comboValues = rawOptions.options
    if (!Array.isArray(comboValues) || comboValues.length > 2_048) throw new Error('COMFY_OBJECT_INFO_INVALID')
    const parsedComboValues = comboValues.map((item): JsonPrimitive => {
      if (item === null || typeof item === 'boolean') return item
      if (typeof item === 'number' && Number.isFinite(item)) return item
      if (typeof item === 'string' && item.length <= MAX_STRING_LENGTH) return item
      throw new Error('COMFY_OBJECT_INFO_INVALID')
    })
    /** 删除第二项中的资源值，避免公共 schema 重复暴露远端文件目录。 */
    const redactedOptions: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(rawOptions)) {
      if (key !== 'options') redactedOptions[key] = item
    }
    rawOptions = redactedOptions
    if (multiselect !== true) parsedType = parsedComboValues
  }
  /** 输入 schema 的可选参数。 */
  /** 转换后的输入选项，解析错误统一归属 object_info 协议。 */
  let options: JsonValue | undefined
  try {
    options = rawOptions === undefined ? undefined : parseJsonValue(rawOptions)
  } catch {
    throw new Error('COMFY_OBJECT_INFO_INVALID')
  }
  if (options !== undefined && (options === null || Array.isArray(options) || typeof options !== 'object')) throw new Error('COMFY_OBJECT_INFO_INVALID')
  if (parsedType === 'COMFY_DYNAMICCOMBO_V3') options = normalizeDynamicComboOptions(options, dynamicDepth)
  return options === undefined ? [parsedType] : [parsedType, options]
}

/** 递归校验并归一动态选择器，避免嵌套 COMBO 泄漏资源列表。 */
function normalizeDynamicComboOptions(options: JsonObject | undefined, dynamicDepth: number): JsonObject {
  if (!options || dynamicDepth >= 4 || !Array.isArray(options.options) || options.options.length === 0 || options.options.length > 64) {
    throw new Error('COMFY_OBJECT_INFO_INVALID')
  }
  /** 归一后的动态分支列表。 */
  const normalizedOptions: JsonValue[] = []
  for (const option of options.options) {
    if (!isRecord(option) || !hasExactKeys(option, ['key', 'inputs']) || typeof option.key !== 'string'
      || !isSafeLabel(option.key) || !isRecord(option.inputs) || !hasExactKeys(option.inputs, ['required', 'optional'])) {
      throw new Error('COMFY_OBJECT_INFO_INVALID')
    }
    /** 当前动态分支的规范化输入区。 */
    const normalizedInputs: JsonObject = {}
    for (const section of ['required', 'optional'] as const) {
      /** 动态分支的当前输入区。 */
      const inputMap = option.inputs[section]
      if (inputMap === undefined) continue
      if (!isRecord(inputMap) || Object.keys(inputMap).length > MAX_NODE_INPUTS) throw new Error('COMFY_OBJECT_INFO_INVALID')
      /** 当前输入区中完成递归归一的 schema。 */
      const normalizedInputMap: JsonObject = {}
      for (const [name, schema] of Object.entries(inputMap)) {
        if (!isSafeKey(name)) throw new Error('COMFY_OBJECT_INFO_INVALID')
        /** 已校验且不含 undefined 槽位的嵌套输入 schema。 */
        const normalizedSchema = parseInputSchema(schema, dynamicDepth + 1)
        normalizedInputMap[name] = normalizedSchema[1] === undefined
          ? [normalizedSchema[0]]
          : [normalizedSchema[0], normalizedSchema[1]]
      }
      normalizedInputs[section] = normalizedInputMap
    }
    normalizedOptions.push({ key: option.key, inputs: normalizedInputs })
  }
  return { ...options, options: normalizedOptions }
}

/** 解析 required/optional 输入映射。 */
function parseInputMap(value: unknown): Record<string, ComfyNodeInputSchema> {
  if (!isRecord(value) || Object.keys(value).length > MAX_NODE_INPUTS) throw new Error('COMFY_OBJECT_INFO_INVALID')
  /** 解析后的输入映射。 */
  const result: Record<string, ComfyNodeInputSchema> = {}
  for (const [name, schema] of Object.entries(value)) {
    if (!isSafeKey(name)) throw new Error('COMFY_OBJECT_INFO_INVALID')
    result[name] = parseInputSchema(schema)
  }
  return result
}

/**
 * 解析 ComfyUI `/object_info` 响应的静态校验子集。
 * @param value 远端响应值。
 * @returns 有界的节点 schema 映射。
 */
export function parseComfyObjectInfo(value: unknown): ComfyObjectInfo {
  if (!isRecord(value) || Object.keys(value).length > MAX_OBJECT_INFO_CLASSES) throw new Error('COMFY_OBJECT_INFO_INVALID')
  /** 解析后的 class schema。 */
  const result: ComfyObjectInfo = {}
  for (const [classType, rawSchema] of Object.entries(value)) {
    if (!isRecord(rawSchema) || !(rawSchema.unsupported === true ? isSafeCatalogClassType(classType) : isSafeClassType(classType))
      || !isRecord(rawSchema.input) || !Array.isArray(rawSchema.output)) {
      throw new Error('COMFY_OBJECT_INFO_INVALID')
    }
    /** 节点输出类型名。 */
    const output = rawSchema.output.map((item) => {
      if (typeof item !== 'string' || item.length > 256) throw new Error('COMFY_OBJECT_INFO_INVALID')
      return item
    })
    /** 可选的输出显示名。 */
    const outputName = rawSchema.output_name === undefined ? undefined : (() => {
      if (!Array.isArray(rawSchema.output_name) || rawSchema.output_name.length !== output.length) throw new Error('COMFY_OBJECT_INFO_INVALID')
      return rawSchema.output_name.map((item) => {
        if (typeof item !== 'string' || item.length > 256) throw new Error('COMFY_OBJECT_INFO_INVALID')
        return item
      })
    })()
    /** 可选的布尔输出列表标记。 */
    const outputIsList = rawSchema.output_is_list === undefined ? undefined : (() => {
      if (!Array.isArray(rawSchema.output_is_list) || rawSchema.output_is_list.length !== output.length
        || !rawSchema.output_is_list.every((item) => item === null || typeof item === 'boolean')) throw new Error('COMFY_OBJECT_INFO_INVALID')
      return rawSchema.output_is_list.map((item) => item === true)
    })()
    const outputMatchTypes = rawSchema.output_matchtypes === undefined || rawSchema.output_matchtypes === null ? undefined : (() => {
      if (!Array.isArray(rawSchema.output_matchtypes) || rawSchema.output_matchtypes.length !== output.length
        || !rawSchema.output_matchtypes.every((item) => item === null || (typeof item === 'string' && isSafeLabel(item)))) {
        throw new Error('COMFY_OBJECT_INFO_INVALID')
      }
      return rawSchema.output_matchtypes as (string | null)[]
    })()
    const inputOrder = rawSchema.input_order === undefined ? undefined : (() => {
      if (!isRecord(rawSchema.input_order) || Object.keys(rawSchema.input_order).some((key) => key !== 'required' && key !== 'optional' && key !== 'hidden')
        || !Object.hasOwn(rawSchema.input_order, 'required')
        || !Array.isArray(rawSchema.input_order.required)
        || (rawSchema.input_order.optional !== undefined && !Array.isArray(rawSchema.input_order.optional))
        || (rawSchema.input_order.hidden !== undefined && !Array.isArray(rawSchema.input_order.hidden))
        || rawSchema.input_order.required.some((item) => typeof item !== 'string' || !isSafeKey(item))
        || (Array.isArray(rawSchema.input_order.optional)
          && rawSchema.input_order.optional.some((item) => typeof item !== 'string' || !isSafeKey(item)))) {
        throw new Error('COMFY_OBJECT_INFO_INVALID')
      }
      const required = rawSchema.input_order.required as string[]
      const optional = (rawSchema.input_order.optional ?? []) as string[]
      const hidden = (rawSchema.input_order.hidden ?? []) as string[]
      if (hidden.some((item) => typeof item !== 'string' || !isSafeKey(item))
        || new Set([...required, ...optional, ...hidden]).size !== required.length + optional.length + hidden.length) throw new Error('COMFY_OBJECT_INFO_INVALID')
      const requiredInputs = rawSchema.input.required ?? {}
      const optionalInputs = rawSchema.input.optional ?? {}
      if (required.some((name) => !Object.hasOwn(requiredInputs, name))
        || optional.some((name) => !Object.hasOwn(optionalInputs, name))) throw new Error('COMFY_OBJECT_INFO_INVALID')
      const hiddenInputs = rawSchema.input.hidden ?? {}
      if (hidden.some((name) => !Object.hasOwn(hiddenInputs, name))) throw new Error('COMFY_OBJECT_INFO_INVALID')
      return { required: [...required], optional: [...optional], hidden: [...hidden] }
    })()
    /** input 内或兼容顶层返回的隐藏输入。 */
    const rawHidden = rawSchema.hidden ?? rawSchema.input.hidden
    /** 解析后的隐藏输入映射。 */
    const hidden = rawHidden === undefined ? undefined : (() => {
      /** 隐藏输入仍按普通有界 JSON 解析。 */
      const parsed = parseJsonValue(rawHidden)
      if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error('COMFY_OBJECT_INFO_INVALID')
      return parsed
    })()
    /** 解析可选短文本元数据。 */
    const parseOptionalText = (field: unknown): string | undefined => {
      if (field === undefined || field === null) return undefined
      if (typeof field !== 'string' || field.length > MAX_STRING_LENGTH) throw new Error('COMFY_OBJECT_INFO_INVALID')
      return field
    }
    if (rawSchema.input_is_list !== undefined && typeof rawSchema.input_is_list !== 'boolean') throw new Error('COMFY_OBJECT_INFO_INVALID')
    if (rawSchema.is_input_list !== undefined && typeof rawSchema.is_input_list !== 'boolean') throw new Error('COMFY_OBJECT_INFO_INVALID')
    if (rawSchema.input_is_list !== undefined && rawSchema.is_input_list !== undefined
      && rawSchema.input_is_list !== rawSchema.is_input_list) throw new Error('COMFY_OBJECT_INFO_INVALID')
    if (rawSchema.output_node !== undefined && typeof rawSchema.output_node !== 'boolean') throw new Error('COMFY_OBJECT_INFO_INVALID')
    if (rawSchema.unsupported !== undefined && rawSchema.unsupported !== true) throw new Error('COMFY_OBJECT_INFO_INVALID')
    /** 兼容旧字段并优先读取 ComfyUI 0.30 的官方字段。 */
    const inputIsList = rawSchema.is_input_list ?? rawSchema.input_is_list
    result[classType] = {
      input: {
        required: parseInputMap(rawSchema.input.required ?? {}),
        ...(rawSchema.input.optional === undefined ? {} : { optional: parseInputMap(rawSchema.input.optional) }),
        ...(hidden ? { hidden } : {}),
      },
      output,
      ...(outputName ? { output_name: outputName } : {}),
      ...(outputIsList ? { output_is_list: outputIsList } : {}),
      ...(outputMatchTypes ? { output_matchtypes: outputMatchTypes } : {}),
      ...(inputOrder ? { input_order: inputOrder } : {}),
      ...(inputIsList === undefined ? {} : { input_is_list: inputIsList }),
      ...(rawSchema.output_node === undefined ? {} : { output_node: rawSchema.output_node }),
      ...(parseOptionalText(rawSchema.category) === undefined ? {} : { category: parseOptionalText(rawSchema.category) }),
      ...(parseOptionalText(rawSchema.display_name) === undefined ? {} : { display_name: parseOptionalText(rawSchema.display_name) }),
      ...(parseOptionalText(rawSchema.description) === undefined ? {} : { description: parseOptionalText(rawSchema.description) }),
      ...(hidden ? { hidden } : {}),
      ...(rawSchema.unsupported === true ? { unsupported: true as const } : {}),
    }
  }
  return result
}

/** 从不兼容节点中提取仅用于目录展示的安全短文本。 */
function parseCatalogText(value: unknown): string | undefined {
  return typeof value === 'string' && value.length <= MAX_STRING_LENGTH
    && !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value)
    ? value
    : undefined
}

/**
 * 解析远端 object_info 目录，并将不兼容的自定义节点保留为明确不可执行条目。
 * @param value 远端完整 object_info 响应。
 * @returns 包含受支持 schema 与不可执行目录占位的有界节点映射。
 */
export function parseComfyObjectCatalog(value: unknown): ComfyObjectInfo {
  if (!isRecord(value) || Object.keys(value).length > MAX_OBJECT_INFO_CLASSES) throw new Error('COMFY_OBJECT_INFO_INVALID')
  /** 兼容目录中的节点条目。 */
  const catalog: ComfyObjectInfo = {}
  for (const [classType, rawSchema] of Object.entries(value)) {
    if (!isSafeCatalogClassType(classType) || !isRecord(rawSchema)) throw new Error('COMFY_OBJECT_INFO_INVALID')
    try {
      /** 单节点严格解析成功时保留完整可执行 schema。 */
      const parsed = parseComfyObjectInfo({ [classType]: rawSchema })[classType]
      if (!parsed) throw new Error('COMFY_OBJECT_INFO_INVALID')
      catalog[classType] = parsed
    } catch {
      /** 不复制未知结构，避免自定义节点借 fallback 绕过 JSON 与输入边界。 */
      const displayName = parseCatalogText(rawSchema.display_name)
      const category = parseCatalogText(rawSchema.category)
      catalog[classType] = {
        input: { required: {} },
        output: [],
        unsupported: true,
        ...(displayName === undefined ? {} : { display_name: displayName }),
        ...(category === undefined ? {} : { category }),
      }
    }
  }
  return catalog
}

/** 判断未知值是否为受支持的绑定类别。 */
function isBindingKind(value: unknown): value is MediaWorkflowBindingKind {
  return value === 'text' || value === 'number' || value === 'boolean' || value === 'image' || value === 'audio' || value === 'video'
}

/** 严格解析新字段绑定元数据。 */
function parseFieldMetadata(value: unknown): MediaWorkflowFieldMetadata {
  if (!isRecord(value) || !hasExactKeys(value, ['classType', 'valueKind', 'label', 'controlType', 'required', 'min', 'max', 'step'])
    || typeof value.classType !== 'string' || !isSafeClassType(value.classType)
    || (value.valueKind !== 'string' && value.valueKind !== 'number' && value.valueKind !== 'boolean')
    || typeof value.label !== 'string' || value.label.trim().length === 0 || value.label.trim().length > 80
    || (value.controlType !== 'text' && value.controlType !== 'number' && value.controlType !== 'boolean'
      && value.controlType !== 'image' && value.controlType !== 'video' && value.controlType !== 'audio'
      && value.controlType !== 'seed' && value.controlType !== 'width' && value.controlType !== 'height')
    || typeof value.required !== 'boolean') throw new Error('MEDIA_WORKFLOW_FIELD_INVALID')
  /** 复制并校验单个可选数字约束。 */
  const constraint = (input: unknown): number | undefined => {
    if (input === undefined) return undefined
    if (typeof input !== 'number' || !Number.isFinite(input)) throw new Error('MEDIA_WORKFLOW_FIELD_INVALID')
    return input
  }
  return {
    classType: value.classType,
    valueKind: value.valueKind,
    label: value.label.trim(),
    controlType: value.controlType,
    required: value.required,
    ...(value.min === undefined ? {} : { min: constraint(value.min) }),
    ...(value.max === undefined ? {} : { max: constraint(value.max) }),
    ...(value.step === undefined ? {} : { step: constraint(value.step) }),
  }
}

/**
 * 严格解析持久化的媒体工作流定义。
 * @param value 来自配置文件的未知值。
 * @returns 不含脚本且字段有界的工作流定义。
 */
export function parseMediaWorkflowDefinition(value: unknown): MediaWorkflowDefinition {
  if (!isRecord(value) || !hasExactKeys(value, ['schemaVersion', 'prompt', 'bindings', 'outputs']) || value.schemaVersion !== 1
    || !Array.isArray(value.bindings) || value.bindings.length > 128 || !Array.isArray(value.outputs) || value.outputs.length > 32) {
    throw new Error('MEDIA_WORKFLOW_INVALID')
  }
  /** 解析后的声明式绑定。 */
  const bindings = value.bindings.map((rawBinding): MediaWorkflowBinding => {
    if (!isRecord(rawBinding) || !hasExactKeys(rawBinding, ['key', 'kind', 'nodeId', 'input', 'loader', 'field'])
      || typeof rawBinding.key !== 'string' || !isSafeKey(rawBinding.key)
      || !isBindingKind(rawBinding.kind) || typeof rawBinding.nodeId !== 'string' || !isSafeKey(rawBinding.nodeId)
      || typeof rawBinding.input !== 'string' || !isSafeKey(rawBinding.input)
      || (rawBinding.loader !== undefined && rawBinding.loader !== 'LoadImage' && rawBinding.loader !== 'LoadAudio' && rawBinding.loader !== 'LoadVideo')) {
      throw new Error('MEDIA_WORKFLOW_INVALID')
    }
    /** 媒体类别到唯一官方 loader 的映射。 */
    const expectedLoader = rawBinding.kind === 'image' ? 'LoadImage'
      : rawBinding.kind === 'audio' ? 'LoadAudio'
        : rawBinding.kind === 'video' ? 'LoadVideo' : undefined
    if ((expectedLoader !== undefined && rawBinding.loader !== expectedLoader)
      || (expectedLoader === undefined && rawBinding.loader !== undefined)) throw new Error('MEDIA_WORKFLOW_INVALID')
    return {
      key: rawBinding.key,
      kind: rawBinding.kind,
      nodeId: rawBinding.nodeId,
      input: rawBinding.input,
      ...(rawBinding.loader ? { loader: rawBinding.loader } : {}),
      ...(rawBinding.field === undefined ? {} : { field: parseFieldMetadata(rawBinding.field) }),
    }
  })
  /** 已使用的绑定 key。 */
  const bindingKeys = new Set<string>()
  /** 已使用的节点输入目标。 */
  const bindingTargets = new Set<string>()
  for (const binding of bindings) {
    /** 节点与输入组成的唯一绑定目标。 */
    const target = `${binding.nodeId}\0${binding.input}`
    if (bindingKeys.has(binding.key) || bindingTargets.has(target)) throw new Error('MEDIA_WORKFLOW_BINDING_DUPLICATE')
    bindingKeys.add(binding.key)
    bindingTargets.add(target)
  }
  /** 解析后的产物选择器。 */
  const outputs = value.outputs.map((rawOutput): MediaWorkflowOutputSelector => {
    if (!isRecord(rawOutput) || !hasExactKeys(rawOutput, ['key', 'nodeId', 'outputIndex', 'mediaType'])
      || typeof rawOutput.key !== 'string' || !isSafeKey(rawOutput.key)
      || typeof rawOutput.nodeId !== 'string' || !isSafeKey(rawOutput.nodeId)
      || !Number.isSafeInteger(rawOutput.outputIndex) || Number(rawOutput.outputIndex) < 0
      || (rawOutput.mediaType !== 'image' && rawOutput.mediaType !== 'audio' && rawOutput.mediaType !== 'video')) {
      throw new Error('MEDIA_WORKFLOW_INVALID')
    }
    return { key: rawOutput.key, nodeId: rawOutput.nodeId, outputIndex: Number(rawOutput.outputIndex), mediaType: rawOutput.mediaType }
  })
  /** 已使用的产物 key。 */
  const outputKeys = new Set<string>()
  for (const output of outputs) {
    if (outputKeys.has(output.key)) throw new Error('MEDIA_WORKFLOW_OUTPUT_DUPLICATE')
    outputKeys.add(output.key)
  }
  /** 完整解析后的定义，随后校验 field 与真实 prompt 的静态兼容。 */
  const definition: MediaWorkflowDefinition = { schemaVersion: 1, prompt: parseComfyPrompt(value.prompt), bindings, outputs }
  if (validateMediaWorkflowFieldBindings(definition).length > 0) throw new Error('MEDIA_WORKFLOW_FIELD_INVALID')
  return definition
}
import { validateMediaWorkflowFieldBindings } from './media-workflow-fields'
