import type {
  ComfyNodeInputSchema,
  ComfyNodeSchema,
  ComfyObjectInfo,
  ComfyPrompt,
  JsonObject,
  JsonValue,
  MediaWorkflowBinding,
  MediaWorkflowDefinition,
  MediaWorkflowFieldMetadata,
} from '../../../../../../packages/shared/src/types/media-workflow'
import { parseComfyPrompt } from '../../../../../../packages/shared/src/types/media-workflow'
import { validateMediaWorkflowFieldBindings } from '../../../../../../packages/shared/src/types/media-workflow-fields'

/** 静态工作流校验的稳定错误码。 */
export type ComfyWorkflowIssueCode =
  | 'NODE_CLASS_UNKNOWN'
  | 'INPUT_REQUIRED'
  | 'INPUT_ENUM_INVALID'
  | 'INPUT_TYPE_INVALID'
  | 'LINK_NODE_UNKNOWN'
  | 'OUTPUT_INDEX_INVALID'
  | 'WORKFLOW_CYCLE'
  | 'OUTPUT_REQUIRED'
  | 'BINDING_TARGET_INVALID'
  | 'NODE_CLASS_UNSAFE'
  | 'NODE_INTERFACE_UNSUPPORTED'
  | 'INPUT_UNKNOWN'
  | 'INPUT_HIDDEN'
  | 'INPUT_RANGE_INVALID'
  | 'LINK_TYPE_INVALID'
  | 'LINK_LIST_UNSUPPORTED'
  | 'RESOURCE_BINDING_REQUIRED'
  | 'RESOURCE_CONSTANT_FORBIDDEN'
  | 'RESOURCE_ENUM_REQUIRED'
  | 'RESOURCE_CONTRACT_REQUIRED'
  | 'OUTPUT_PREFIX_INVALID'
  | 'OUTPUT_SELECTOR_INVALID'
  | 'OUTPUT_MEDIA_UNSUPPORTED'
  | 'OUTPUT_DECLARATION_REQUIRED'

/** 单条静态校验问题。 */
export interface ComfyWorkflowIssue {
  code: ComfyWorkflowIssueCode
  nodeId?: string
  input?: string
  message: string
}

/** 有界静态校验结果。 */
export interface ComfyWorkflowValidationResult {
  valid: boolean
  issues: ComfyWorkflowIssue[]
  truncated: boolean
}

/** 校验器的资源边界。 */
export interface ComfyWorkflowValidationOptions {
  maxIssues?: number
}

/** ComfyUI 上传媒体后的权威文件描述。 */
export interface ComfyUploadedImage {
  name: string
  subfolder: string
  type: 'input' | 'output' | 'temp'
}

/** 编译期标量绑定值。 */
export interface ComfyScalarBindingValue {
  kind: 'text' | 'number' | 'boolean'
  value: string | number | boolean
}

/** 编译期已上传图片值。 */
export interface ComfyImageBindingValue {
  kind: 'image'
  upload?: ComfyUploadedImage
  descriptor?: { path: string }
}

/** 编译期已上传音视频值。 */
export interface ComfyReservedMediaBindingValue {
  kind: 'audio' | 'video'
  upload?: ComfyUploadedImage
}

/** 所有声明式编译输入。 */
export type ComfyBindingValue = ComfyScalarBindingValue | ComfyImageBindingValue | ComfyReservedMediaBindingValue

/** 工作流编译结果。 */
export interface CompiledComfyWorkflow {
  prompt: ComfyPrompt
}

/** 运行时从 history 收集输出时使用的精确媒体合同。 */
export interface ComfyHistoryOutputContract {
  mediaType: 'image' | 'audio' | 'video'
  historyKey: 'images' | 'audio'
}

/** loader 资源输入合同。 */
export interface ComfyResourceInputContract {
  kind: 'image' | 'audio' | 'video'
  input: string
  loader: 'LoadImage' | 'LoadAudio' | 'LoadVideo'
  uploadFlag: 'image_upload' | 'audio_upload' | 'video_upload'
}

/** 资源、模型枚举与输出副作用必须显式适配的本地节点合同。 */
export interface ComfyCoreNodeContract {
  readonly modelInputs?: readonly string[]
  outputNode?: boolean
  resourceInput?: ComfyResourceInputContract
  historyOutput?: ComfyHistoryOutputContract
  safeOutputPrefixInput?: string
}

/** 经官方源码确认且已适配静态 schema 的 ComfyUI 核心节点。 */
export const COMFY_CORE_NODE_CONTRACTS: Readonly<Record<string, ComfyCoreNodeContract>> = {
  LoadImage: { resourceInput: { kind: 'image', input: 'image', loader: 'LoadImage', uploadFlag: 'image_upload' } },
  LoadAudio: { resourceInput: { kind: 'audio', input: 'audio', loader: 'LoadAudio', uploadFlag: 'audio_upload' } },
  LoadVideo: { resourceInput: { kind: 'video', input: 'file', loader: 'LoadVideo', uploadFlag: 'video_upload' } },
  SaveImage: { outputNode: true, historyOutput: { mediaType: 'image', historyKey: 'images' }, safeOutputPrefixInput: 'filename_prefix' },
  PreviewImage: { outputNode: true, historyOutput: { mediaType: 'image', historyKey: 'images' } },
  SaveAudio: { outputNode: true, historyOutput: { mediaType: 'audio', historyKey: 'audio' }, safeOutputPrefixInput: 'filename_prefix' },
  SaveAudioMP3: { outputNode: true, historyOutput: { mediaType: 'audio', historyKey: 'audio' }, safeOutputPrefixInput: 'filename_prefix' },
  SaveAudioOpus: { outputNode: true, historyOutput: { mediaType: 'audio', historyKey: 'audio' }, safeOutputPrefixInput: 'filename_prefix' },
  SaveAudioAdvanced: { outputNode: true, historyOutput: { mediaType: 'audio', historyKey: 'audio' }, safeOutputPrefixInput: 'filename_prefix' },
  PreviewAudio: { outputNode: true, historyOutput: { mediaType: 'audio', historyKey: 'audio' } },
  SaveWEBM: { outputNode: true, historyOutput: { mediaType: 'video', historyKey: 'images' }, safeOutputPrefixInput: 'filename_prefix' },
  SaveVideo: { outputNode: true, historyOutput: { mediaType: 'video', historyKey: 'images' }, safeOutputPrefixInput: 'filename_prefix' },
  CreateVideo: {},
  CheckpointLoaderSimple: { modelInputs: ['ckpt_name'] },
  CLIPLoader: { modelInputs: ['clip_name'] },
  DualCLIPLoader: { modelInputs: ['clip_name1', 'clip_name2'] },
  TripleCLIPLoader: { modelInputs: ['clip_name1', 'clip_name2', 'clip_name3'] },
  UNETLoader: { modelInputs: ['unet_name'] },
  VAELoader: { modelInputs: ['vae_name'] },
  LoraLoader: { modelInputs: ['lora_name'] },
  ControlNetLoader: { modelInputs: ['control_net_name'] },
  CLIPVisionLoader: { modelInputs: ['clip_name'] },
  CLIPVisionEncode: {},
  UpscaleModelLoader: { modelInputs: ['model_name'] },
  CLIPTextEncode: {},
  EmptyLatentImage: {},
  EmptySD3LatentImage: {},
  KSampler: {},
  KSamplerAdvanced: {},
  VAEDecode: {},
  VAEEncode: {},
  ImageScale: {},
  ImageScaleBy: {},
  ImageInvert: {},
  ImageBatch: {},
  LatentUpscale: {},
  LatentUpscaleBy: {},
  ConditioningCombine: {},
  ConditioningConcat: {},
  ConditioningSetArea: {},
  ConditioningZeroOut: {},
  SetLatentNoiseMask: {},
  RepeatLatentBatch: {},
  EmptyLatentAudio: {},
  ConditioningStableAudio: {},
  VAEDecodeAudio: {},
  VAEEncodeAudio: {},
  'TextEncodeAceStepAudio1.5': {},
  'EmptyAceStep1.5LatentAudio': {},
  ReferenceTimbreAudio: {},
  ModelSamplingAuraFlow: {},
  WanImageToVideo: {},
  Wan22ImageToVideoLatent: {},
}

/** 已适配为 API JSON 字面量的基础输入类型。 */
const COMFY_LITERAL_INPUT_TYPES = new Set(['STRING', 'INT', 'FLOAT', 'NUMBER', 'BOOLEAN', 'COMFY_DYNAMICCOMBO_V3'])

/** object_info 中表示上传入口的已知标记。 */
const COMFY_UPLOAD_FLAGS = ['image_upload', 'audio_upload', 'video_upload'] as const

/** 需要显式远端资源合同的输入名；避免把字符串绑定当成任意路径或 URL 权限。 */
const RESOURCE_INPUT_NAME_PATTERN = /^(?:file|filename|filepath|path|url|uri|directory|folder|source|image|audio|video)$|(?:^|[_.:-])(?:file|filename|filepath|path|url|uri|directory|folder)(?:$|[_.:-])/i

/** 判断输入 schema 是否声明了 ComfyUI 上传控件。 */
function hasUploadFlag(schema: ComfyNodeInputSchema): boolean {
  return COMFY_UPLOAD_FLAGS.some((flag) => schema[1]?.[flag] === true)
}

/** 判断字符串是否直接携带外部路径或 URL；模型枚举由远端枚举单独约束。 */
function isExternalLocator(value: JsonValue): boolean {
  if (typeof value !== 'string') return false
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value) || /^file:/i.test(value)
    || /^[\\/]/.test(value) || /^[A-Za-z]:[\\/]/.test(value)
    || value.split(/[\\/]/).some((segment) => segment === '..')
}

/** 判断未显式适配节点的某个字面量输入是否会扩大远端资源访问能力。 */
function requiresResourceContract(input: string, value: JsonValue, schema: ComfyNodeInputSchema): boolean {
  if (hasUploadFlag(schema)) return true
  if (Array.isArray(schema[0])) return false
  return schema[0] === 'STRING' && (RESOURCE_INPUT_NAME_PATTERN.test(input) || isExternalLocator(value))
}

/** 判断未显式适配节点的字面量是否属于本地可静态验证的 API 类型。 */
function supportsInstalledNodeLiteral(value: JsonValue, schema: ComfyNodeInputSchema): boolean {
  if (Array.isArray(schema[0])) return true
  if (!COMFY_LITERAL_INPUT_TYPES.has(schema[0])) return false
  if (schema[0] === 'STRING' || schema[0] === 'COMFY_DYNAMICCOMBO_V3') return typeof value === 'string'
  if (schema[0] === 'BOOLEAN') return typeof value === 'boolean'
  return typeof value === 'number'
}

/** 判断未知图是否明显为 ComfyUI 前端 UI 格式。 */
function isUiWorkflow(value: unknown): boolean {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && ('nodes' in value || 'links' in value)
}

/**
 * 解析用户导出的 ComfyUI API 图并拒绝 UI 格式。
 * @param value 待解析工作流。
 * @returns 保留 `[nodeId, outputIndex]` 链接的 API 图。
 */
export function parseComfyApiWorkflow(value: unknown): ComfyPrompt {
  if (isUiWorkflow(value)) throw new Error('COMFY_UI_WORKFLOW_UNSUPPORTED')
  return parseComfyPrompt(value)
}

/** 判断输入值是否为现有节点的 ComfyUI 输出链接。 */
function parseLink(value: JsonValue, prompt: ComfyPrompt): [string, number] | undefined {
  if (!Array.isArray(value) || value.length !== 2 || typeof value[0] !== 'string'
    || typeof value[1] !== 'number' || !Number.isSafeInteger(value[1]) || value[1] < 0) return undefined
  return Object.hasOwn(prompt, value[0]) ? [value[0], value[1]] : undefined
}

/** 判断字面量是否匹配 object_info 的基础类型。 */
function matchesInputType(value: JsonValue, schema: ComfyNodeInputSchema): boolean {
  /** schema 第一项为基础类型名或枚举列表。 */
  const type = schema[0]
  if (Array.isArray(type)) return type.some((candidate) => candidate === value)
  if (type === 'STRING') return typeof value === 'string'
  if (type === 'INT') return typeof value === 'number' && Number.isSafeInteger(value)
  if (type === 'FLOAT' || type === 'NUMBER') return typeof value === 'number' && Number.isFinite(value)
  if (type === 'BOOLEAN') return typeof value === 'boolean'
  if (type === 'COMFY_DYNAMICCOMBO_V3') return typeof value === 'string' && findDynamicOption(schema, value) !== undefined
  return true
}

/** 判断未知 JSON 值是否具备输入 schema 的最小元组形状。 */
function isInputSchema(value: unknown): value is ComfyNodeInputSchema {
  if (!Array.isArray(value) || value.length < 1 || value.length > 2) return false
  /** schema 的类型声明。 */
  const type = value[0]
  return typeof type === 'string' || (Array.isArray(type) && type.every((item) => item === null
    || typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean'))
}

/** 从动态选择器 schema 中查找当前选择的分支。 */
function findDynamicOption(schema: ComfyNodeInputSchema, selected: string): JsonObject | undefined {
  if (schema[0] !== 'COMFY_DYNAMICCOMBO_V3') return undefined
  /** 动态选择器声明的可选分支。 */
  const options = schema[1]?.options
  if (!Array.isArray(options) || options.length > 64) return undefined
  /** 与 prompt 当前值匹配的分支。 */
  const option = options.find((candidate) => candidate !== null && !Array.isArray(candidate) && typeof candidate === 'object'
    && candidate.key === selected)
  return option !== null && !Array.isArray(option) && typeof option === 'object' ? option : undefined
}

/** 展开选中动态分支的扁平输入名，例如 format.codec。 */
function expandNodeInputs(
  schema: ComfyNodeSchema,
  values: Record<string, JsonValue>,
): { required: Record<string, ComfyNodeInputSchema>; optional: Record<string, ComfyNodeInputSchema> } {
  /** 展开后的必填输入。 */
  const required: Record<string, ComfyNodeInputSchema> = {}
  /** 展开后的可选输入。 */
  const optional: Record<string, ComfyNodeInputSchema> = {}
  /** 递归复制一层输入并解析当前动态选择。 */
  const append = (inputMap: Record<string, ComfyNodeInputSchema>, target: 'required' | 'optional', prefix = '', depth = 0): void => {
    if (depth > 4) return
    for (const [name, inputSchema] of Object.entries(inputMap)) {
      /** ComfyUI API prompt 使用点号表示动态分支路径。 */
      const fullName = prefix ? `${prefix}.${name}` : name
      /** 当前 schema 应写入的必填或可选映射。 */
      const targetMap = target === 'required' ? required : optional
      targetMap[fullName] = inputSchema
      /** 当前动态分支选择值。 */
      const selected = values[fullName]
      if (inputSchema[0] !== 'COMFY_DYNAMICCOMBO_V3' || typeof selected !== 'string') continue
      /** 当前选中的动态分支描述。 */
      const branch = findDynamicOption(inputSchema, selected)
      /** 分支内部的 required/optional 输入集合。 */
      const branchInputs = branch?.inputs
      if (!branchInputs || Array.isArray(branchInputs) || typeof branchInputs !== 'object') continue
      for (const section of ['required', 'optional'] as const) {
        /** 动态分支当前输入区。 */
        const rawMap = branchInputs[section]
        if (!rawMap || Array.isArray(rawMap) || typeof rawMap !== 'object') continue
        /** 经过形状验证的动态输入区。 */
        const parsedMap: Record<string, ComfyNodeInputSchema> = {}
        for (const [nestedName, rawSchema] of Object.entries(rawMap)) {
          if (isInputSchema(rawSchema)) parsedMap[nestedName] = rawSchema
        }
        append(parsedMap, section, fullName, depth + 1)
      }
    }
  }
  append(schema.input.required, 'required')
  append(schema.input.optional ?? {}, 'optional')
  return { required, optional }
}

/** 判断数值字面量是否满足远端 schema 的 min/max。 */
function matchesNumberRange(value: JsonValue, schema: ComfyNodeInputSchema): boolean {
  if (typeof value !== 'number') return true
  /** 数值输入的可选约束。 */
  const options = schema[1]
  /** 可选最小值。 */
  const min = options?.min
  /** 可选最大值。 */
  const max = options?.max
  return (typeof min !== 'number' || value >= min) && (typeof max !== 'number' || value <= max)
}

/** 判断 SaveImage 文件名前缀为有界相对路径且没有目录穿越。 */
function isSafeOutputPrefix(value: JsonValue): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512
    && !value.startsWith('/') && !value.startsWith('\\') && !value.includes('\0')
    && !value.split(/[\\/]/).some((segment) => segment === '..' || segment === '.')
}

/** 返回首个图环路；没有环路时返回空数组。 */
function findCycle(prompt: ComfyPrompt): string[] {
  /** 尚未访问、访问中、已完成三态。 */
  const states = new Map<string, 0 | 1 | 2>()
  /** 当前深度优先路径。 */
  const stack: string[] = []
  /** 深度优先搜索节点依赖。 */
  const visit = (nodeId: string): string[] => {
    states.set(nodeId, 1)
    stack.push(nodeId)
    for (const value of Object.values(prompt[nodeId]?.inputs ?? {})) {
      /** 当前输入引用的上游节点。 */
      const link = parseLink(value, prompt)
      if (!link) continue
      /** 上游节点当前访问状态。 */
      const state = states.get(link[0]) ?? 0
      if (state === 1) return [...stack.slice(stack.indexOf(link[0])), link[0]]
      if (state === 0) {
        /** 子图中发现的环路。 */
        const cycle = visit(link[0])
        if (cycle.length > 0) return cycle
      }
    }
    stack.pop()
    states.set(nodeId, 2)
    return []
  }
  for (const nodeId of Object.keys(prompt)) {
    if ((states.get(nodeId) ?? 0) === 0) {
      /** 当前连通分量发现的环路。 */
      const cycle = visit(nodeId)
      if (cycle.length > 0) return cycle
    }
  }
  return []
}

/**
 * 使用 object_info 静态校验工作流，不执行远端 custom VALIDATE_INPUTS。
 * @param definition 本地工作流定义。
 * @param objectInfo 远端 schema 的已解析快照。
 * @param options 错误数量边界。
 * @returns 有界问题列表。
 */
export function validateComfyWorkflow(
  definition: MediaWorkflowDefinition,
  objectInfo: ComfyObjectInfo,
  options: ComfyWorkflowValidationOptions = {},
): ComfyWorkflowValidationResult {
  /** 最大问题数，避免错误响应无界增长。 */
  const maxIssues = Math.min(256, Math.max(1, options.maxIssues ?? 64))
  /** 已收集问题。 */
  const issues: ComfyWorkflowIssue[] = []
  /** 是否还有被上限截断的问题。 */
  let truncated = false
  /** 添加一条问题并遵守数量上限。 */
  const addIssue = (issue: ComfyWorkflowIssue): void => {
    if (issues.length < maxIssues) issues.push(issue)
    else truncated = true
  }

  if (definition.outputs.length === 0) addIssue({ code: 'OUTPUT_REQUIRED', message: '工作流至少需要一个产物选择器' })
  for (const fieldIssue of validateMediaWorkflowFieldBindings(definition)) {
    addIssue({
      code: 'BINDING_TARGET_INVALID',
      ...(fieldIssue.nodeId ? { nodeId: fieldIssue.nodeId } : {}),
      ...(fieldIssue.input ? { input: fieldIssue.input } : {}),
      message: fieldIssue.message,
    })
  }
  /** 图中首个环路。 */
  const cycle = findCycle(definition.prompt)
  if (cycle.length > 0) addIssue({ code: 'WORKFLOW_CYCLE', message: `工作流存在环路：${cycle.join(' -> ')}` })

  /** 被绑定覆盖的节点输入。 */
  const boundInputs = new Set<string>()
  /** 已使用的绑定 key，用于防御绕过 shared parser 的内存对象。 */
  const bindingKeys = new Set<string>()
  for (const binding of definition.bindings) {
    /** 当前绑定目标。 */
    const target = `${binding.nodeId}\0${binding.input}`
    if (bindingKeys.has(binding.key) || boundInputs.has(target)) {
      addIssue({ code: 'BINDING_TARGET_INVALID', nodeId: binding.nodeId, input: binding.input, message: `绑定重复：${binding.key}` })
    }
    bindingKeys.add(binding.key)
    boundInputs.add(target)
  }
  for (const [nodeId, node] of Object.entries(definition.prompt)) {
    /** 当前节点的本地执行合同。 */
    const contract = COMFY_CORE_NODE_CONTRACTS[node.class_type]
    /** 当前节点的远端静态 schema。 */
    const schema = objectInfo[node.class_type]
    if (!schema) {
      addIssue({ code: 'NODE_CLASS_UNKNOWN', nodeId, message: `节点类型不存在：${node.class_type}` })
      continue
    }
    if (schema.unsupported === true) {
      addIssue({ code: 'NODE_INTERFACE_UNSUPPORTED', nodeId, message: `节点已安装，但当前接口尚不支持自动执行：${node.class_type}` })
      continue
    }
    if (schema.output_node === true && contract?.outputNode !== true) {
      addIssue({ code: 'NODE_CLASS_UNSAFE', nodeId, message: `节点声明了未适配的输出副作用：${node.class_type}` })
    }
    /** 依据当前 prompt 选择展开后的静态输入集合。 */
    const expandedInputs = expandNodeInputs(schema, node.inputs)
    for (const input of Object.keys(expandedInputs.required)) {
      if (!Object.hasOwn(node.inputs, input) && !boundInputs.has(`${nodeId}\0${input}`)) {
        addIssue({ code: 'INPUT_REQUIRED', nodeId, input, message: `缺少必填输入：${input}` })
      }
    }
    /** 节点全部可识别的输入 schema。 */
    const allInputs = { ...expandedInputs.optional, ...expandedInputs.required }
    for (const [input, value] of Object.entries(node.inputs)) {
      if (Object.hasOwn(schema.input.hidden ?? {}, input)) {
        addIssue({ code: 'INPUT_HIDDEN', nodeId, input, message: `禁止用户填入隐藏输入：${input}` })
        continue
      }
      /** 当前输入的静态 schema。 */
      const inputSchema = allInputs[input]
      if (!inputSchema) {
        addIssue({ code: 'INPUT_UNKNOWN', nodeId, input, message: `节点输入不存在：${input}` })
        continue
      }
      // 上传槽的模板值会被权威回执替换；绑定类别和 Loader 合同仍在下方统一复核。
      if (contract?.resourceInput?.input === input && boundInputs.has(`${nodeId}\0${input}`)) continue
      /** 当前值可能引用的上游节点。 */
      const link = parseLink(value, definition.prompt)
      if (link) {
        /** 上游节点的输出 schema。 */
        const sourceSchema = objectInfo[definition.prompt[link[0]]?.class_type ?? '']
        if (sourceSchema && link[1] >= sourceSchema.output.length) {
          addIssue({ code: 'OUTPUT_INDEX_INVALID', nodeId, input, message: `输出索引越界：${link[0]}[${link[1]}]` })
        } else if (sourceSchema) {
          /** 上游端口类型。 */
          const sourceType = sourceSchema.output[link[1]]
          /** 当前输入要求的类型；枚举输入不接受链接。 */
          const targetType = inputSchema[0]
          if (typeof targetType !== 'string' || sourceType !== targetType) {
            addIssue({ code: 'LINK_TYPE_INVALID', nodeId, input, message: `链接类型不兼容：${sourceType ?? 'unknown'} -> ${Array.isArray(targetType) ? 'enum' : targetType}` })
          }
          if (sourceSchema.output_is_list?.[link[1]] === true || schema.input_is_list === true) {
            addIssue({ code: 'LINK_LIST_UNSUPPORTED', nodeId, input, message: `链接包含尚未适配的 list 语义：${link[0]}[${link[1]}]` })
          }
        }
      } else if (Array.isArray(value) && value.length === 2 && typeof value[0] === 'string' && typeof value[1] === 'number') {
        addIssue({ code: 'LINK_NODE_UNKNOWN', nodeId, input, message: `链接节点不存在：${value[0]}` })
      } else if (inputSchema[0] === 'COMBO') {
        // 已验证的单选 COMBO 已归一为枚举，剩余选择语义不能按核心节点名称放行。
        addIssue({ code: 'NODE_INTERFACE_UNSUPPORTED', nodeId, input, message: `节点参数尚不支持自动填写：${node.class_type}.${input}` })
      } else if (!contract && requiresResourceContract(input, value, inputSchema)) {
        addIssue({
          code: 'RESOURCE_CONTRACT_REQUIRED',
          nodeId,
          input,
          message: `节点已安装，但 ${node.class_type}.${input} 需要显式资源适配；请改用受支持的上传节点或为该节点增加本地合同`,
        })
      } else if (!contract && !supportsInstalledNodeLiteral(value, inputSchema)) {
        addIssue({
          code: 'NODE_INTERFACE_UNSUPPORTED',
          nodeId,
          input,
          message: `节点已安装，但 ${node.class_type}.${input} 使用未适配的字面量类型：${String(inputSchema[0])}；请改用节点链接或增加输入适配`,
        })
      } else if (!matchesInputType(value, inputSchema)) {
        addIssue({
          code: Array.isArray(inputSchema[0]) ? 'INPUT_ENUM_INVALID' : 'INPUT_TYPE_INVALID',
          nodeId,
          input,
          message: `输入类型不匹配：${input}`,
        })
      } else if (!matchesNumberRange(value, inputSchema)) {
        addIssue({ code: 'INPUT_RANGE_INVALID', nodeId, input, message: `输入超出数值范围：${input}` })
      }
    }
    if (contract?.resourceInput) {
      /** loader 唯一允许的资源绑定。 */
      const resourceBinding = definition.bindings.find((binding) => binding.nodeId === nodeId
        && binding.input === contract.resourceInput?.input && binding.kind === contract.resourceInput?.kind
        && binding.loader === contract.resourceInput?.loader)
      if (!resourceBinding) {
        addIssue({ code: 'RESOURCE_BINDING_REQUIRED', nodeId, input: contract.resourceInput.input, message: `${node.class_type}.${contract.resourceInput.input} 必须绑定已上传媒体` })
        if (Object.hasOwn(node.inputs, contract.resourceInput.input)) {
          addIssue({ code: 'RESOURCE_CONSTANT_FORBIDDEN', nodeId, input: contract.resourceInput.input, message: `${node.class_type}.${contract.resourceInput.input} 不允许直接引用远端常量` })
        }
      }
    }
    if (contract?.safeOutputPrefixInput && !boundInputs.has(`${nodeId}\0${contract.safeOutputPrefixInput}`)
      && !isSafeOutputPrefix(node.inputs[contract.safeOutputPrefixInput] ?? null)) {
      addIssue({ code: 'OUTPUT_PREFIX_INVALID', nodeId, input: contract.safeOutputPrefixInput, message: `${node.class_type}.${contract.safeOutputPrefixInput} 必须是安全相对前缀` })
    }
    for (const modelInput of contract?.modelInputs ?? []) {
      /** 模型资源字段必须由当前 object_info 枚举授权。 */
      const modelSchema = allInputs[modelInput]
      if (!modelSchema || !Array.isArray(modelSchema[0])) {
        addIssue({ code: 'RESOURCE_ENUM_REQUIRED', nodeId, input: modelInput, message: `模型字段缺少实时枚举：${modelInput}` })
      }
    }
  }
  for (const binding of definition.bindings) {
    /** 绑定目标节点。 */
    const node = definition.prompt[binding.nodeId]
    /** 绑定目标的实时输入 schema。 */
    /** 当前节点的远端 schema。 */
    const nodeSchema = node ? objectInfo[node.class_type] : undefined
    /** 当前节点依据动态选择展开后的输入。 */
    const expandedInputs = node && nodeSchema ? expandNodeInputs(nodeSchema, node.inputs) : undefined
    /** 绑定目标的实时输入 schema。 */
    const inputSchema = expandedInputs ? { ...expandedInputs.optional, ...expandedInputs.required }[binding.input] : undefined
    /** 标量绑定对应的 ComfyUI 基础类型。 */
    const expectedTypes = binding.kind === 'text' ? ['STRING']
      : binding.kind === 'number' ? ['INT', 'FLOAT', 'NUMBER']
        : binding.kind === 'boolean' ? ['BOOLEAN'] : []
    /** 资源输入不能伪装成普通标量绑定。 */
    const nodeContract = COMFY_CORE_NODE_CONTRACTS[node?.class_type ?? '']
    /** loader 或模型字段都只能通过对应资源合同填充。 */
    const resourceTarget = nodeContract?.resourceInput?.input === binding.input
      || nodeContract?.modelInputs?.includes(binding.input) === true
    /** 媒体绑定必须精确落在受控 loader 的唯一上传输入。 */
    const validMediaBinding = binding.kind !== 'image' && binding.kind !== 'audio' && binding.kind !== 'video'
      || (nodeContract?.resourceInput?.kind === binding.kind && nodeContract.resourceInput.loader === binding.loader
        && nodeContract.resourceInput.input === binding.input)
    /** 标量绑定必须落在类型相容且非隐藏的公开输入。 */
    const validScalarBinding = expectedTypes.length === 0 || (!resourceTarget && inputSchema !== undefined && typeof inputSchema[0] === 'string'
      && expectedTypes.includes(inputSchema[0]) && !Object.hasOwn(objectInfo[node?.class_type ?? '']?.input.hidden ?? {}, binding.input))
    /** 已安装处理节点允许公开基础标量绑定；媒体资源仍必须命中显式 loader 合同。 */
    const installedScalarTarget = nodeContract !== undefined || (nodeSchema !== undefined && nodeSchema.output_node !== true
      && binding.kind !== 'image' && binding.kind !== 'audio' && binding.kind !== 'video'
      && inputSchema !== undefined && !requiresResourceContract(binding.input, node?.inputs[binding.input] ?? null, inputSchema))
    if (!node || !installedScalarTarget || !validMediaBinding || !validScalarBinding) {
      addIssue({ code: 'BINDING_TARGET_INVALID', nodeId: binding.nodeId, input: binding.input, message: `绑定目标无效：${binding.key}` })
    }
  }
  for (const output of definition.outputs) {
    /** 选择器目标节点。 */
    const node = definition.prompt[output.nodeId]
    /** 目标节点的 history 收集合同。 */
    const historyOutput = node ? COMFY_CORE_NODE_CONTRACTS[node.class_type]?.historyOutput : undefined
    if (!historyOutput) addIssue({ code: 'OUTPUT_SELECTOR_INVALID', nodeId: output.nodeId, message: `产物选择器必须指向已适配的保存或预览节点：${output.key}` })
    if (historyOutput && output.mediaType !== historyOutput.mediaType) {
      addIssue({ code: 'OUTPUT_MEDIA_UNSUPPORTED', nodeId: output.nodeId, message: `产物媒体类型与节点合同不一致：${output.mediaType}` })
    }
  }
  /** 已声明产物的输出节点。 */
  const declaredOutputNodes = new Set(definition.outputs.filter((output) => {
    /** 当前选择器目标的收集合同。 */
    const node = definition.prompt[output.nodeId]
    return node !== undefined && COMFY_CORE_NODE_CONTRACTS[node.class_type]?.historyOutput?.mediaType === output.mediaType
  }).map((output) => output.nodeId))
  for (const [nodeId, node] of Object.entries(definition.prompt)) {
    if (COMFY_CORE_NODE_CONTRACTS[node.class_type]?.historyOutput && !declaredOutputNodes.has(nodeId)) {
      addIssue({ code: 'OUTPUT_DECLARATION_REQUIRED', nodeId, message: `媒体输出节点缺少产物声明：${nodeId}` })
    }
  }
  return { valid: issues.length === 0 && !truncated, issues, truncated }
}

/** 将上传回执转换为 Comfy loader 接受的相对文件名。 */
function toLoadMediaValue(upload: ComfyUploadedImage): string {
  if (upload.type !== 'input' || !upload.name || upload.name.length > 255 || upload.name.includes('/') || upload.name.includes('\\')
    || upload.name.includes('\0') || upload.name === '.' || upload.name === '..' || upload.subfolder.length > 1_024
    || upload.subfolder.startsWith('/') || upload.subfolder.startsWith('\\') || upload.subfolder.includes('\0')
    || upload.subfolder.split(/[\\/]/).some((segment) => segment === '..' || segment === '.')) throw new Error('MEDIA_BINDING_UPLOAD_INVALID')
  /** 统一为正斜杠的受控子目录。 */
  const subfolder = upload.subfolder.replaceAll('\\', '/').replace(/^\/+|\/+$/g, '')
  return subfolder ? `${subfolder}/${upload.name}` : upload.name
}

/** 判断字段控件是否要求安全整数。 */
function isIntegerField(metadata: MediaWorkflowFieldMetadata): boolean {
  return metadata.controlType === 'seed' || metadata.controlType === 'width' || metadata.controlType === 'height'
}

/** 校验新字段绑定仍指向相同节点、input 与原始 scalar 类型。 */
function assertFieldTarget(prompt: ComfyPrompt, binding: MediaWorkflowBinding): void {
  if (!binding.field) return
  /** 绑定目标节点。 */
  const node = prompt[binding.nodeId]
  /** 当前 input 的原始 API JSON 字面量。 */
  const original = node?.inputs[binding.input]
  if (!node || node.class_type !== binding.field.classType || !Object.hasOwn(node.inputs, binding.input)
    || typeof original !== binding.field.valueKind) throw new Error('MEDIA_BINDING_FIELD_INVALID')
  /** 复用共享纯校验，防止内存对象绕过持久化 parser。 */
  const issues = validateMediaWorkflowFieldBindings({ schemaVersion: 1, prompt, bindings: [binding], outputs: [] })
  if (issues.length > 0) throw new Error('MEDIA_BINDING_FIELD_INVALID')
}

/** 校验新字段的必填及数值语义约束。 */
function assertFieldValue(binding: MediaWorkflowBinding, value: string | number | boolean): void {
  /** 新字段元数据；旧 binding 不改变既有行为。 */
  const metadata = binding.field
  if (!metadata) return
  if (typeof value !== metadata.valueKind) throw new Error('MEDIA_BINDING_INVALID')
  if (metadata.required && typeof value === 'string' && value.trim().length === 0) throw new Error('MEDIA_BINDING_REQUIRED')
  if (typeof value !== 'number') return
  if (!Number.isFinite(value)) throw new Error('MEDIA_BINDING_INVALID')
  if (isIntegerField(metadata) && !Number.isSafeInteger(value)) throw new Error('MEDIA_BINDING_INTEGER_INVALID')
  if (metadata.controlType === 'seed' && value < 0) throw new Error('MEDIA_BINDING_RANGE_INVALID')
  if ((metadata.controlType === 'width' || metadata.controlType === 'height') && value < 1) throw new Error('MEDIA_BINDING_RANGE_INVALID')
  if ((metadata.min !== undefined && value < metadata.min) || (metadata.max !== undefined && value > metadata.max)) {
    throw new Error('MEDIA_BINDING_RANGE_INVALID')
  }
  if (metadata.step !== undefined) {
    /** 步长以显式最小值为基准，否则从 0 开始。 */
    const quotient = (value - (metadata.min ?? 0)) / metadata.step
    if (Math.abs(quotient - Math.round(quotient)) > 1e-9) throw new Error('MEDIA_BINDING_STEP_INVALID')
  }
}

/** 从可选新字段的 API JSON 原始 scalar 生成回退编译值。 */
function fallbackBindingValue(prompt: ComfyPrompt, binding: MediaWorkflowBinding): ComfyBindingValue {
  if (!binding.field || binding.field.required || binding.kind === 'image' || binding.kind === 'audio' || binding.kind === 'video') {
    throw new Error(binding.kind === 'image' || binding.kind === 'audio' || binding.kind === 'video'
      ? 'MEDIA_BINDING_UPLOAD_REQUIRED' : 'MEDIA_BINDING_REQUIRED')
  }
  try {
    assertFieldTarget(prompt, binding)
  } catch {
    throw new Error('MEDIA_BINDING_FALLBACK_INVALID')
  }
  /** 当前定义中的原始 scalar 默认值。 */
  const fallback = prompt[binding.nodeId]?.inputs[binding.input]
  if (typeof fallback !== binding.field.valueKind || (typeof fallback !== 'string' && typeof fallback !== 'number' && typeof fallback !== 'boolean')) {
    throw new Error('MEDIA_BINDING_FALLBACK_INVALID')
  }
  try {
    assertFieldValue(binding, fallback)
  } catch {
    throw new Error('MEDIA_BINDING_FALLBACK_INVALID')
  }
  if (binding.kind === 'text' && typeof fallback === 'string') return { kind: 'text', value: fallback }
  if (binding.kind === 'number' && typeof fallback === 'number') return { kind: 'number', value: fallback }
  if (binding.kind === 'boolean' && typeof fallback === 'boolean') return { kind: 'boolean', value: fallback }
  throw new Error('MEDIA_BINDING_FALLBACK_INVALID')
}

/** 把单个声明式输入写入克隆后的节点。 */
function applyBinding(
  prompt: ComfyPrompt,
  binding: MediaWorkflowBinding,
  value: ComfyBindingValue,
  objectInfo: ComfyObjectInfo,
): void {
  assertFieldTarget(prompt, binding)
  /** 绑定目标节点。 */
  const node = prompt[binding.nodeId]
  /** 当前节点的远端静态接口。 */
  const nodeSchema = node ? objectInfo[node.class_type] : undefined
  /** 当前节点的显式资源或输出合同。 */
  const nodeContract = node ? COMFY_CORE_NODE_CONTRACTS[node.class_type] : undefined
  if (!node || !nodeSchema || (!nodeContract && nodeSchema.output_node === true) || value.kind !== binding.kind) {
    throw new Error('MEDIA_BINDING_INVALID')
  }
  if (binding.kind === 'image' || binding.kind === 'audio' || binding.kind === 'video') {
    /** 当前 loader 的受控资源输入合同。 */
    const resourceInput = nodeContract?.resourceInput
    if (!resourceInput || resourceInput.kind !== binding.kind || resourceInput.loader !== binding.loader
      || resourceInput.input !== binding.input) throw new Error('MEDIA_BINDING_UNSUPPORTED')
    /** loader 资源字段的实时上传 schema。 */
    const mediaSchema = {
      ...objectInfo[node.class_type]?.input.optional,
      ...objectInfo[node.class_type]?.input.required,
    }[binding.input]
    if (!mediaSchema || (mediaSchema[0] !== 'STRING' && !Array.isArray(mediaSchema[0]))
      || mediaSchema[1]?.[resourceInput.uploadFlag] !== true) throw new Error('MEDIA_BINDING_SCHEMA_INVALID')
    if (!('upload' in value) || !value.upload) throw new Error('MEDIA_BINDING_UPLOAD_REQUIRED')
    node.inputs[binding.input] = toLoadMediaValue(value.upload)
    return
  }
  if (value.kind !== 'text' && value.kind !== 'number' && value.kind !== 'boolean') throw new Error('MEDIA_BINDING_INVALID')
  assertFieldValue(binding, value.value)
  /** 目标公开输入的实时 schema。 */
  const schema = {
    ...nodeSchema.input.optional,
    ...nodeSchema.input.required,
  }[binding.input]
  if (!schema || Object.hasOwn(nodeSchema.input.hidden ?? {}, binding.input)
    || (!nodeContract && requiresResourceContract(binding.input, node.inputs[binding.input] ?? null, schema))) {
    throw new Error('MEDIA_BINDING_SCHEMA_INVALID')
  }
  /** 绑定类别对应的 JavaScript 基础类型。 */
  const expectedType = binding.kind === 'text' ? 'string' : binding.kind
  if (typeof value.value !== expectedType || (typeof value.value === 'number' && !Number.isFinite(value.value))) throw new Error('MEDIA_BINDING_INVALID')
  /** 标量类别允许的 ComfyUI 类型。 */
  const allowedSchemaTypes = binding.kind === 'text' ? ['STRING']
    : binding.kind === 'number' ? ['INT', 'FLOAT', 'NUMBER'] : ['BOOLEAN']
  if (typeof schema[0] !== 'string' || !allowedSchemaTypes.includes(schema[0])) throw new Error('MEDIA_BINDING_SCHEMA_INVALID')
  if (schema[0] === 'INT' && typeof value.value === 'number' && !Number.isSafeInteger(value.value)) {
    throw new Error('MEDIA_BINDING_INTEGER_INVALID')
  }
  if (!matchesNumberRange(value.value, schema)) throw new Error('MEDIA_BINDING_RANGE_INVALID')
  if (nodeContract?.safeOutputPrefixInput === binding.input && !isSafeOutputPrefix(value.value)) {
    throw new Error('MEDIA_OUTPUT_PREFIX_INVALID')
  }
  node.inputs[binding.input] = value.value
}

/**
 * 将已解析绑定编译为可提交图；资源必须先完成受支持上传。
 * @param definition 静态工作流定义。
 * @param values 以绑定 key 为键的运行输入。
 * @param objectInfo 用于约束绑定类型与数值范围的实时 schema 快照。
 * @returns 深克隆且已填值的 API 图。
 */
export function compileComfyWorkflow(
  definition: MediaWorkflowDefinition,
  values: Record<string, ComfyBindingValue>,
  objectInfo: ComfyObjectInfo,
): CompiledComfyWorkflow {
  /** 深克隆后的工作流，避免修改持久化定义。 */
  const prompt = parseComfyPrompt(structuredClone(definition.prompt))
  for (const binding of definition.bindings) {
    /** 当前槽位的调用方输入。 */
    const value = values[binding.key] ?? fallbackBindingValue(prompt, binding)
    applyBinding(prompt, binding, value, objectInfo)
  }
  return { prompt }
}
