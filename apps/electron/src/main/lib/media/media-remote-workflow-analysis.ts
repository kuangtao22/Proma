import type {
  ComfyNodeInputSchema,
  ComfyObjectInfo,
  ComfyPrompt,
  JsonValue,
  MediaRemoteWorkflow,
  MediaWorkflowBinding,
  MediaWorkflowDefinition,
  MediaWorkflowFieldControlType,
} from '@proma/shared'
import {
  createMediaWorkflowFieldBinding,
  listMediaWorkflowFields,
  parseComfyPrompt,
  parseMediaWorkflowDefinition,
} from '@proma/shared'
import { COMFY_CORE_NODE_CONTRACTS, expandComfyNodeInputs, validateComfyWorkflow } from './comfyui-workflow'
import { flattenComfyUiSubgraphs } from './media-ui-workflow-subgraphs'

/** 远端工作流分析最多处理的节点数，与共享 prompt 解析边界一致。 */
const MAX_NODES = 512
/** 远端工作流分析最多处理的输入总数，与共享 prompt 解析边界一致。 */
const MAX_INPUTS = 2_048
/** 对 Agent 暴露的单个短文本上限。 */
const MAX_SUMMARY_TEXT = 256
/** UI 图中可识别的 control_after_generate 固定值。 */
const CONTROL_AFTER_GENERATE_VALUES = new Set(['fixed', 'increment', 'decrement', 'randomize'])
/** 工作流节点及字段身份允许的安全字符。 */
const SAFE_KEY_PATTERN = /^[A-Za-z0-9_.:-]{1,256}$/

/** 远端工作流分析问题。 */
export interface RemoteWorkflowAnalysisIssue {
  code: string
  message: string
  nodeId?: string
  input?: string
}

/** 节点的有界结构摘要。 */
export interface RemoteWorkflowNodeSummary {
  nodeId: string
  classType: string
  title?: string
  position?: { x: number; y: number }
  inputCount: number
  linkedInputCount: number
  outputTypes: string[]
  supported: boolean
  coreContract: boolean
}

/** 输入候选的有界结构摘要。 */
export interface RemoteWorkflowInputSummary {
  nodeId: string
  input: string
  classType: string
  label: string
  valueKind: 'string' | 'number' | 'boolean' | 'linked' | 'complex' | 'unknown'
  linked: boolean
  editable: boolean
  bindingKey?: string
}

/** 可从 history 收集的媒体产物摘要。 */
export interface RemoteWorkflowOutputSummary {
  key: string
  nodeId: string
  classType: string
  title?: string
  mediaType: 'image' | 'audio' | 'video'
  historyKey: 'images' | 'audio'
}

/** 远端工作流的结构、兼容性与可保存定义。 */
export interface RemoteWorkflowAnalysis {
  format: MediaRemoteWorkflow['format']
  definition: MediaWorkflowDefinition | null
  issues: RemoteWorkflowAnalysisIssue[]
  nodes: RemoteWorkflowNodeSummary[]
  inputs: RemoteWorkflowInputSummary[]
  outputs: RemoteWorkflowOutputSummary[]
  convertible: boolean
}

/** UI 图节点解析所需的有限字段。 */
interface UiNode {
  id: string
  classType: string
  title?: string
  position?: { x: number; y: number }
  mode?: number
  inputs: UiNodeInput[]
  outputTypes: string[]
  /** 仅当原图显式提供 outputs 时校验其反向边；兼容省略 UI 输出信息的精简图。 */
  outputLinks?: Array<Array<string | null> | null>
  widgets: JsonValue[]
  /** 某些历史 Primitive 节点把唯一 widget 直接序列化为标量，需由实时 schema 再次确认。 */
  scalarWidget?: JsonValue
}

/** UI 图节点上的输入槽。 */
interface UiNodeInput {
  name: string
  linkId: string | null
  /** 只有显式 widget 元数据才能证明已连接输入仍占用序列化槽位。 */
  widgetName?: string
  type?: string
}

/** UI 图全局 link 的权威端点。 */
interface UiLink {
  id: string
  sourceNodeId: string
  sourceSlot: number
  targetNodeId: string
  targetSlot: number
}

/** 判断未知值是否为普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** 将数字或字符串节点身份规范化为 API prompt 的安全字符串键。 */
function safeId(value: unknown): string | null {
  if ((typeof value !== 'string' && typeof value !== 'number') || (typeof value === 'number' && !Number.isSafeInteger(value))) return null
  /** 统一后的节点或 link 身份。 */
  const id = String(value)
  return SAFE_KEY_PATTERN.test(id) ? id : null
}

/** 截断远端短文本，避免结构分析把任意大字符串送入 Agent 上下文。 */
function shortText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  /** 去除首尾空白后的展示文本。 */
  const text = value.trim()
  return text.length > 0 ? text.slice(0, MAX_SUMMARY_TEXT) : undefined
}

/** 按共享 prompt 合同读取节点类型，非法值不进入 schema 查询。 */
function safeClassType(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_SUMMARY_TEXT && value.trim() === value
    && !/[\u0000-\u001F\u007F/\\]/.test(value)
    ? value
    : undefined
}

/** 判断 JSON 值是否为可生成声明式字段绑定的基础值。 */
function scalarKind(value: JsonValue): 'string' | 'number' | 'boolean' | undefined {
  if (typeof value === 'string') return 'string'
  if (typeof value === 'number') return 'number'
  if (typeof value === 'boolean') return 'boolean'
  return undefined
}

/** 返回 schema 中 required 与 optional 的稳定声明顺序。 */
function schemaInputs(objectInfo: ComfyObjectInfo, classType: string, values: Record<string, JsonValue> = {}): Array<{ name: string; schema: ComfyNodeInputSchema; required: boolean }> {
  /** 当前节点的实时静态 schema。 */
  const schema = objectInfo[classType]
  if (!schema) return []
  return expandComfyNodeInputs(schema, values).ordered
}

/** 根据字段名选择现有工作台控件，不引入新的执行语义。 */
function scalarControl(input: string, value: JsonValue): MediaWorkflowFieldControlType | undefined {
  if (typeof value === 'string') return 'text'
  if (typeof value === 'boolean') return 'boolean'
  if (typeof value !== 'number') return undefined
  if (/seed/i.test(input)) return 'seed'
  if (/^(?:width|max_width|min_width)$/i.test(input)) return 'width'
  if (/^(?:height|max_height|min_height)$/i.test(input)) return 'height'
  return 'number'
}

/** 将远端数值约束复制进字段元数据。 */
function applyNumberConstraints(binding: MediaWorkflowBinding, schema: ComfyNodeInputSchema): MediaWorkflowBinding {
  if (!binding.field || binding.field.valueKind !== 'number') return binding
  /** 当前 schema 中仅允许复制的静态数值约束。 */
  const options = schema[1]
  /** 种子、宽高控件只能编辑 JS 可精确表示的整数，不能直接复制 uint64 上限。 */
  const integerControl = ['seed', 'width', 'height'].includes(binding.field.controlType)
  return {
    ...binding,
    field: {
      ...binding.field,
      required: false,
      ...(typeof options?.min === 'number' && Number.isFinite(options.min) ? { min: options.min } : {}),
      ...(typeof options?.max === 'number' && Number.isFinite(options.max)
        ? { max: integerControl ? Math.min(options.max, Number.MAX_SAFE_INTEGER) : options.max } : {}),
      ...(typeof options?.step === 'number' && Number.isFinite(options.step) && options.step > 0 ? { step: options.step } : {}),
    },
  }
}

/** 判断保存节点文件名前缀是否满足现有执行器的相对路径合同。 */
function isSafeOutputPrefix(value: JsonValue): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512
    && !value.startsWith('/') && !value.startsWith('\\') && !value.includes('\0')
    && !value.split(/[\\/]/).some((segment) => segment === '..' || segment === '.')
}

/** 从节点合同生成 history 产物选择器与语义摘要。 */
function collectOutputs(prompt: ComfyPrompt): { selectors: MediaWorkflowDefinition['outputs']; summaries: RemoteWorkflowOutputSummary[] } {
  /** 可保存的产物选择器。 */
  const selectors: MediaWorkflowDefinition['outputs'] = []
  /** 提供给 Agent 的产物摘要。 */
  const summaries: RemoteWorkflowOutputSummary[] = []
  for (const [nodeId, node] of Object.entries(prompt)) {
    /** 当前节点已适配的 history 输出合同。 */
    const output = COMFY_CORE_NODE_CONTRACTS[node.class_type]?.historyOutput
    if (!output) continue
    /** 同一节点稳定且可作为调用参数的产物 key。 */
    const key = `${nodeId}.${output.mediaType}`
    selectors.push({ key, nodeId, outputIndex: 0, mediaType: output.mediaType })
    summaries.push({ key, nodeId, classType: node.class_type, ...(node._meta?.title ? { title: node._meta.title } : {}), ...output })
  }
  return { selectors, summaries }
}

/** 为已解析 API prompt 创建资源与可选标量绑定。 */
function prepareDefinition(prompt: ComfyPrompt, objectInfo: ComfyObjectInfo): { definition: MediaWorkflowDefinition; inputs: RemoteWorkflowInputSummary[] } {
  /** 防止修改远端快照的工作副本。 */
  const preparedPrompt = structuredClone(prompt)
  /** 自动生成的声明式绑定。 */
  const bindings: MediaWorkflowBinding[] = []
  for (const [nodeId, node] of Object.entries(preparedPrompt)) {
    /** 当前节点的本地安全合同。 */
    const contract = COMFY_CORE_NODE_CONTRACTS[node.class_type]
    if (contract?.resourceInput) {
      /** 先从远端原值建立媒体字段合同，再清成无资源身份的占位值。 */
      const resourceField = listMediaWorkflowFields(preparedPrompt).find((field) => field.nodeId === nodeId
        && field.input === contract.resourceInput?.input)
      if (!resourceField) throw new Error(`MEDIA_WORKFLOW_RESOURCE_FIELD_MISSING:${nodeId}.${contract.resourceInput.input}`)
      bindings.push(createMediaWorkflowFieldBinding(resourceField, contract.resourceInput.kind))
      node.inputs[contract.resourceInput.input] = ''
    }
    if (contract?.safeOutputPrefixInput) {
      /** 不安全或空前缀统一收敛到应用专属相对目录。 */
      const current = node.inputs[contract.safeOutputPrefixInput]
      if (!isSafeOutputPrefix(current ?? null)) node.inputs[contract.safeOutputPrefixInput] = 'Proma'
    }
  }
  /** 资源常量清洗后重新提取真实字段，防止为 Loader 创建普通文本绑定。 */
  const fields = listMediaWorkflowFields(preparedPrompt)
  for (const field of fields) {
    if (!field.editable || field.valueKind === 'linked' || field.valueKind === 'complex') continue
    /** 当前字段所在节点的安全合同。 */
    const contract = COMFY_CORE_NODE_CONTRACTS[field.classType]
    /** 模型枚举和输出前缀保留工作流默认值，不暴露成普通文本参数。 */
    if (contract?.resourceInput?.input === field.input || contract?.modelInputs?.includes(field.input)
      || contract?.safeOutputPrefixInput === field.input) continue
    /** 当前字段的实时 schema。 */
    const inputSchema = schemaInputs(objectInfo, field.classType, preparedPrompt[field.nodeId]!.inputs).find((item) => item.name === field.input)?.schema
    if (!inputSchema || Array.isArray(inputSchema[0])) continue
    /** 仅复用当前字段系统已有的标量控件。 */
    const control = scalarControl(field.input, field.value)
    if (!control || inputSchema[0] === 'COMFY_DYNAMICCOMBO_V3') continue
    /** 标量绑定默认可选，调用方不填写时沿用远端工作流的现值。 */
    const created = createMediaWorkflowFieldBinding(field, control)
    bindings.push(applyNumberConstraints({ ...created, field: { ...created.field!, required: false } }, inputSchema))
  }
  /** 自动识别的媒体输出。 */
  const outputs = collectOutputs(preparedPrompt).selectors
  /** 尚未重新严格解析的工作流定义。 */
  const definition: MediaWorkflowDefinition = { schemaVersion: 1, prompt: preparedPrompt, bindings, outputs }
  /** Agent 可见的输入摘要。 */
  const bindingKeys = new Map(bindings.map((binding) => [`${binding.nodeId}\0${binding.input}`, binding.key]))
  const inputs = listMediaWorkflowFields(preparedPrompt).map((field): RemoteWorkflowInputSummary => ({
    nodeId: field.nodeId,
    input: field.input,
    classType: field.classType,
    label: field.nodeTitle,
    valueKind: field.valueKind,
    linked: field.valueKind === 'linked',
    editable: field.editable,
    ...(bindingKeys.get(`${field.nodeId}\0${field.input}`) ? { bindingKey: bindingKeys.get(`${field.nodeId}\0${field.input}`) } : {}),
  }))
  return { definition, inputs }
}

/** 从 API prompt 构造节点摘要。 */
function summarizePrompt(prompt: ComfyPrompt, objectInfo: ComfyObjectInfo): RemoteWorkflowNodeSummary[] {
  return Object.entries(prompt).map(([nodeId, node]) => {
    /** 当前节点输入字段列表。 */
    const fields = listMediaWorkflowFields({ [nodeId]: node })
    /** 当前实时 schema 可见的输出类型。 */
    const schema = objectInfo[node.class_type]
    return {
      nodeId,
      classType: node.class_type,
      ...(node._meta?.title ? { title: node._meta.title } : {}),
      inputCount: fields.length,
      linkedInputCount: Object.values(node.inputs).filter((value) => Array.isArray(value) && value.length === 2 && typeof value[0] === 'string').length,
      outputTypes: [...(schema?.output ?? [])],
      supported: schema !== undefined && schema.unsupported !== true,
      coreContract: Object.hasOwn(COMFY_CORE_NODE_CONTRACTS, node.class_type),
    }
  })
}

/** 把 UI 图节点列表解析为有界、无行为的结构数据。 */
function parseUiNodes(value: unknown, issues: RemoteWorkflowAnalysisIssue[]): UiNode[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_NODES) {
    issues.push({ code: value && Array.isArray(value) && value.length > MAX_NODES ? 'REMOTE_WORKFLOW_LIMIT_EXCEEDED' : 'UI_GRAPH_INVALID', message: 'UI 工作流必须包含有界节点列表' })
    return []
  }
  /** 已解析的节点。 */
  const nodes: UiNode[] = []
  /** 用于拒绝字符串化后重复身份的集合。 */
  const nodeIds = new Set<string>()
  /** 累计输入槽数量。 */
  let inputCount = 0
  for (const raw of value) {
    if (!isRecord(raw)) {
      issues.push({ code: 'UI_NODE_INVALID', message: 'UI 工作流包含无效节点' })
      continue
    }
    /** 当前节点的规范化身份与类型。 */
    const id = safeId(raw.id)
    const classType = safeClassType(raw.type)
    if (!id || !classType) {
      issues.push({ code: 'UI_NODE_INVALID', message: 'UI 节点缺少安全 id 或 type' })
      continue
    }
    if (nodeIds.has(id)) issues.push({ code: 'UI_NODE_ID_DUPLICATE', nodeId: id, message: `UI 节点 ID 重复：${id}` })
    nodeIds.add(id)
    /** 官方备注节点没有执行输入/输出；若被连线引用，后续端点校验仍会拒绝。 */
    if ((classType === 'MarkdownNote' || classType === 'Note')
      && (raw.inputs === undefined || (Array.isArray(raw.inputs) && raw.inputs.length === 0))
      && (raw.outputs === undefined || (Array.isArray(raw.outputs) && raw.outputs.length === 0))) continue
    /** UI 节点输入槽。 */
    const rawInputs = raw.inputs === undefined ? [] : raw.inputs
    if (!Array.isArray(rawInputs) || rawInputs.length > 128) {
      issues.push({ code: 'UI_NODE_INVALID', nodeId: id, message: `UI 节点输入无效：${id}` })
      continue
    }
    inputCount += rawInputs.length
    if (inputCount > MAX_INPUTS) {
      issues.push({ code: 'REMOTE_WORKFLOW_LIMIT_EXCEEDED', nodeId: id, message: 'UI 工作流输入数量超过上限' })
      break
    }
    /** 已解析的当前输入槽。 */
    const inputs: UiNodeInput[] = []
    /** 同一节点内输入名必须唯一，否则 link target slot 会有歧义。 */
    const inputNames = new Set<string>()
    for (const rawInput of rawInputs) {
      if (!isRecord(rawInput) || !shortText(rawInput.name)) {
        issues.push({ code: 'UI_INPUT_INVALID', nodeId: id, message: `UI 节点包含无效输入槽：${id}` })
        continue
      }
      /** 当前输入槽的有界名称。 */
      const inputName = String(rawInput.name)
      if (inputNames.has(inputName)) issues.push({ code: 'UI_INPUT_DUPLICATE', nodeId: id, input: inputName, message: `UI 节点输入名重复：${id}.${inputName}` })
      inputNames.add(inputName)
      /** 输入槽引用的全局 link 身份。 */
      const linkId = rawInput.link === null || rawInput.link === undefined ? null : safeId(rawInput.link)
      if (rawInput.link !== null && rawInput.link !== undefined && !linkId) {
        issues.push({ code: 'UI_LINK_INVALID', nodeId: id, input: String(rawInput.name), message: `UI 输入引用了无效 link：${id}.${String(rawInput.name)}` })
      }
      inputs.push({ name: inputName, linkId,
        ...(isRecord(rawInput.widget) && typeof rawInput.widget.name === 'string' ? { widgetName: rawInput.widget.name } : {}),
        ...(typeof rawInput.type === 'string' ? { type: rawInput.type } : {}),
      })
    }
    /** UI 序列化的静态 widget 值；历史 Primitive 会把单值写成裸标量。 */
    const rawWidgets = raw.widgets_values
    const widgets = rawWidgets === undefined ? [] : rawWidgets
    const scalarWidget = typeof rawWidgets === 'string' || typeof rawWidgets === 'number' || typeof rawWidgets === 'boolean'
      ? rawWidgets : undefined
    if ((!Array.isArray(widgets) && scalarWidget === undefined) || (Array.isArray(widgets) && widgets.length > 128)) {
      issues.push({ code: 'UI_WIDGET_INVALID', nodeId: id, message: `UI 节点 widget 列表无效：${id}` })
      continue
    }
    /** UI 节点声明的输出槽只用于不可执行工作流的结构摘要。 */
    const rawOutputs = raw.outputs === undefined ? [] : raw.outputs
    /** 有界的 UI 输出类型列表。 */
    const outputTypes = Array.isArray(rawOutputs) && rawOutputs.length <= 128
      ? rawOutputs.flatMap((output) => isRecord(output) && shortText(output.type) ? [shortText(output.type)!] : [])
      : []
    if (!Array.isArray(rawOutputs) || rawOutputs.length > 128) {
      issues.push({ code: 'UI_NODE_INVALID', nodeId: id, message: `UI 节点输出无效：${id}` })
    }
    /** 可选画布位置只用于语义分析。 */
    const position = Array.isArray(raw.pos) && raw.pos.length === 2 && raw.pos.every((item) => typeof item === 'number' && Number.isFinite(item))
      ? { x: Number(raw.pos[0]), y: Number(raw.pos[1]) }
      : undefined
    /** 非零 mode 表示 mute、never 或 bypass，API prompt 无法等价表达。 */
    const mode = raw.mode === undefined ? undefined : typeof raw.mode === 'number' && Number.isSafeInteger(raw.mode) ? raw.mode : Number.NaN
    if (mode !== undefined && mode !== 0) issues.push({ code: 'UI_NODE_MODE_UNSUPPORTED', nodeId: id, message: `UI 节点使用了无法安全转换的 mute/bypass mode：${id}` })
    nodes.push({ id, classType, ...(shortText(raw.title) ? { title: shortText(raw.title) } : {}), ...(position ? { position } : {}),
      ...(mode === undefined ? {} : { mode }), inputs, outputTypes,
      ...(raw.outputs !== undefined && Array.isArray(rawOutputs) ? { outputLinks: rawOutputs.map((output) =>
        isRecord(output) && Array.isArray(output.links) ? output.links.map(safeId) : null) } : {}),
      widgets: Array.isArray(widgets) ? structuredClone(widgets) : [],
      ...(scalarWidget === undefined ? {} : { scalarWidget }) })
  }
  return nodes
}

/** 解析 UI 图全局 links 并验证真实端点。 */
function parseUiLinks(value: unknown, nodes: UiNode[], issues: RemoteWorkflowAnalysisIssue[]): Map<string, UiLink> {
  /** link 身份到权威端点的映射。 */
  const links = new Map<string, UiLink>()
  if (!Array.isArray(value) || value.length > MAX_INPUTS) {
    issues.push({ code: 'UI_GRAPH_INVALID', message: 'UI 工作流 links 列表无效或超过上限' })
    return links
  }
  /** 可被 link 引用的节点身份。 */
  const nodeMap = new Map(nodes.map((node) => [node.id, node]))
  for (const raw of value) {
    if (!Array.isArray(raw) || raw.length < 5 || raw.length > 6) {
      issues.push({ code: 'UI_LINK_INVALID', message: 'UI 工作流包含无效 link' })
      continue
    }
    /** link 及其端点身份。 */
    const id = safeId(raw[0])
    const sourceNodeId = safeId(raw[1])
    const targetNodeId = safeId(raw[3])
    /** link 两端槽位。 */
    const sourceSlot = raw[2]
    const targetSlot = raw[4]
    if (!id || !sourceNodeId || !targetNodeId || !Number.isSafeInteger(sourceSlot) || Number(sourceSlot) < 0
      || !Number.isSafeInteger(targetSlot) || Number(targetSlot) < 0 || !nodeMap.has(sourceNodeId) || !nodeMap.has(targetNodeId)) {
      issues.push({ code: 'UI_LINK_INVALID', message: `UI link 引用了不存在的节点或槽位：${id ?? 'unknown'}` })
      continue
    }
    if (links.has(id)) {
      issues.push({ code: 'UI_LINK_ID_DUPLICATE', message: `UI link ID 重复：${id}` })
      continue
    }
    const source = nodeMap.get(sourceNodeId)!
    if (source.outputLinks && !source.outputLinks[Number(sourceSlot)]?.includes(id)) {
      issues.push({ code: 'UI_LINK_INVALID', nodeId: sourceNodeId, message: `UI link 未被来源输出槽登记：${sourceNodeId}[${sourceSlot}] -> ${id}` })
    }
    links.set(id, { id, sourceNodeId, sourceSlot: Number(sourceSlot), targetNodeId, targetSlot: Number(targetSlot) })
  }
  return links
}

/** 判断 schema 是否对应官方可静态还原的 widget。 */
function isStaticWidget(schema: ComfyNodeInputSchema): boolean {
  return Array.isArray(schema[0]) || schema[0] === 'STRING' || schema[0] === 'INT' || schema[0] === 'FLOAT'
    || schema[0] === 'NUMBER' || schema[0] === 'BOOLEAN' || schema[0] === 'COMFY_DYNAMICCOMBO_V3'
    || (schema[0].includes(',') && schema[0].split(',').every((type) => ['FLOAT', 'INT', 'BOOLEAN', 'STRING'].includes(type))
      && typeof schema[1]?.widgetType === 'string' && schema[0].split(',').includes(schema[1].widgetType))
}

/** 将 UI 图转换为 API prompt；所有不确定语义都会留下阻塞问题。 */
function convertUiPrompt(nodes: UiNode[], links: Map<string, UiLink>, objectInfo: ComfyObjectInfo, issues: RemoteWorkflowAnalysisIssue[], inputOverrides: Record<string, Record<string, JsonValue>> = {}): ComfyPrompt {
  /** 转换后的 API prompt。 */
  const prompt: ComfyPrompt = {}
  for (const node of nodes) {
    /** 当前节点实时 schema 与本地执行合同。 */
    const schema = objectInfo[node.classType]
    const contract = COMFY_CORE_NODE_CONTRACTS[node.classType]
    if (!schema) issues.push({ code: 'NODE_CLASS_UNKNOWN', nodeId: node.id, message: `节点类型不存在：${node.classType}` })
    else if (schema.unsupported === true) issues.push({ code: 'NODE_INTERFACE_UNSUPPORTED', nodeId: node.id, message: `节点接口无法安全分析：${node.classType}` })
    /** 当前节点转换后的输入。 */
    const overrides = inputOverrides[node.id] ?? {}
    const inputs: Record<string, JsonValue> = structuredClone(overrides)
    /** 实时 schema 声明的全部输入名。 */
    let declaredInputs = schemaInputs(objectInfo, node.classType, inputs)
    /** 裸标量只能映射到唯一、无需附加策略的静态 widget，避免猜测多控件节点。 */
    const scalarWidgetInput = declaredInputs.length === 1 ? declaredInputs[0] : undefined
    const scalarWidgetSupported = scalarWidgetInput !== undefined && isStaticWidget(scalarWidgetInput.schema)
      && scalarWidgetInput.schema[0] !== 'COMFY_DYNAMICCOMBO_V3'
      && scalarWidgetInput.schema[1]?.forceInput !== true
      && scalarWidgetInput.schema[1]?.control_after_generate !== true
      && typeof scalarWidgetInput.schema[1]?.control_after_generate !== 'string'
    /** 仅在上述条件可证明时把历史裸值归一为正常序列化数组。 */
    const widgets = node.scalarWidget === undefined ? node.widgets
      : scalarWidgetSupported ? [node.scalarWidget] : node.widgets
    if (node.scalarWidget !== undefined && !scalarWidgetSupported) {
      issues.push({ code: 'UI_WIDGET_INVALID', nodeId: node.id, message: `UI 节点的标量 widget 无法唯一映射：${node.id}` })
    }
    const declaredNames = new Set<string>()
    /** 已消费的静态 widget 下标。 */
    let widgetIndex = 0
    for (let declaredIndex = 0; declaredIndex < declaredInputs.length; declaredIndex += 1) {
      const declared = declaredInputs[declaredIndex]!
      declaredNames.add(declared.name)
      /** 同名 UI 输入槽和其全局 link。 */
      const uiInputIndex = node.inputs.findIndex((input) => input.name === declared.name)
      const uiInput = uiInputIndex >= 0 ? node.inputs[uiInputIndex] : undefined
      if (uiInput?.linkId) {
        /** 目标输入必须与全局 link 的 target slot 双向一致。 */
        const link = links.get(uiInput.linkId)
        if (!link || link.targetNodeId !== node.id || link.targetSlot !== uiInputIndex) {
          issues.push({ code: 'UI_LINK_INVALID', nodeId: node.id, input: declared.name, message: `UI 输入 link 端点不一致：${node.id}.${declared.name}` })
        } else inputs[declared.name] = [link.sourceNodeId, link.sourceSlot]
      }
      if (!isStaticWidget(declared.schema) || declared.schema[1]?.forceInput === true
        || (Object.hasOwn(overrides, declared.name) && uiInput?.widgetName !== declared.name)
        || (uiInput?.linkId && uiInput.widgetName !== declared.name)) continue
      /** 当前 schema 顺序对应的静态 widget 值。 */
      const widgetValue = widgets[widgetIndex]
      if (widgetValue === undefined) {
        if (declared.required && !uiInput?.linkId && !Object.hasOwn(overrides, declared.name)) issues.push({ code: 'UI_WIDGET_MISSING', nodeId: node.id, input: declared.name, message: `UI 节点缺少静态 widget：${node.id}.${declared.name}` })
        continue
      }
      widgetIndex += 1
      /** Loader 文件名仅用于识别输入候选，最终 prompt 不保留。 */
      if (uiInput?.linkId || Object.hasOwn(overrides, declared.name)) {
        // 已连接 widget 的序列化值只是占位，仍消费槽位但不得覆盖真实连接。
      } else if (contract?.resourceInput?.input === declared.name) {
        /** 资源 widget 只证明这是一个可参数化 Loader，原文件名会在准备阶段清空。 */
        inputs[declared.name] = typeof widgetValue === 'string' ? widgetValue : ''
        if (typeof widgetValue !== 'string') issues.push({ code: 'UI_WIDGET_INVALID', nodeId: node.id, input: declared.name, message: `Loader widget 不是文件名字符串：${node.id}.${declared.name}` })
      } else inputs[declared.name] = structuredClone(widgetValue)
      /** seed 等控件会额外序列化一次生成后策略，该值不是 API input。 */
      if (declared.schema[1]?.control_after_generate === true
        || (typeof declared.schema[1]?.control_after_generate === 'string'
          && CONTROL_AFTER_GENERATE_VALUES.has(declared.schema[1].control_after_generate))) {
        /** control_after_generate 的固定策略值。 */
        const controlValue = widgets[widgetIndex]
        if (typeof controlValue !== 'string' || !CONTROL_AFTER_GENERATE_VALUES.has(controlValue)) {
          issues.push({ code: 'UI_WIDGET_INVALID', nodeId: node.id, input: declared.name, message: `无法识别 control_after_generate：${node.id}.${declared.name}` })
        } else widgetIndex += 1
      }
      if (declared.schema[0] === 'COMFY_DYNAMICCOMBO_V3') declaredInputs = schemaInputs(objectInfo, node.classType, inputs)
    }
    /** 官方上传按钮仅序列化媒体种类，不是额外 API 字段；只识别明确 Loader 合同。 */
    const uploadInput = node.inputs.find((input) => input.name === 'upload' && input.widgetName === 'upload'
      && input.linkId === null && input.type === `${contract?.resourceInput?.kind.toUpperCase()}UPLOAD`)
    if (uploadInput && contract?.resourceInput
      && schemaInputs(objectInfo, node.classType).some((input) => input.name === contract.resourceInput?.input
        && input.schema[1]?.[contract.resourceInput.uploadFlag] === true)) {
      declaredNames.add(uploadInput.name)
      if (widgets.length === widgetIndex + 1 && widgets[widgetIndex] === contract.resourceInput.kind) widgetIndex += 1
    }
    if (widgetIndex !== widgets.length) {
      issues.push({ code: 'UI_WIDGET_UNMAPPED', nodeId: node.id, message: `UI 节点包含 ${widgets.length - widgetIndex} 个无法映射的自定义 widget：${node.id}` })
    }
    for (const input of node.inputs) {
      if (!declaredNames.has(input.name)) {
        issues.push({ code: 'UI_INPUT_UNKNOWN', nodeId: node.id, input: input.name, message: `UI 输入不在实时 schema 中：${node.id}.${input.name}` })
      }
    }
    prompt[node.id] = { class_type: node.classType, inputs, ...(node.title ? { _meta: { title: node.title } } : {}) }
  }
  /** 每条全局 link 都必须被目标输入槽引用，避免静默丢边。 */
  for (const link of links.values()) {
    /** link 的目标节点及目标槽。 */
    const target = nodes.find((node) => node.id === link.targetNodeId)
    if (!target || target.inputs[link.targetSlot]?.linkId !== link.id) {
      issues.push({ code: 'UI_LINK_INVALID', nodeId: link.targetNodeId, message: `UI link 未被目标输入槽引用：${link.id}` })
    }
  }
  return prompt
}

/** 合并相同定位与问题码，控制 Agent 上下文中的重复诊断。 */
function deduplicateIssues(issues: RemoteWorkflowAnalysisIssue[]): RemoteWorkflowAnalysisIssue[] {
  /** 已返回的问题身份。 */
  const seen = new Set<string>()
  return issues.filter((issue) => {
    /** 稳定的问题去重键。 */
    const key = `${issue.code}\0${issue.nodeId ?? ''}\0${issue.input ?? ''}\0${issue.message}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  }).slice(0, 256)
}

/**
 * 从远端工作流中只提取有界、去重的节点类型。
 * @param workflow 已读取的远端 API 或 UI 工作流。
 * @returns 供调用方窄化 object_info 查询的节点类型列表。
 */
export function getRemoteWorkflowClassTypes(workflow: MediaRemoteWorkflow): string[] {
  /** 保持远端原顺序的去重类型。 */
  const classTypes = new Set<string>()
  if (workflow.format === 'api') {
    /** API 图仅查看最多 512 个顶层节点。 */
    for (const raw of Object.values(workflow.definition).slice(0, MAX_NODES)) {
      /** API 节点的有界类型名。 */
      const classType = isRecord(raw) ? safeClassType(raw.class_type) : undefined
      if (classType) classTypes.add(classType)
    }
  } else if (workflow.format === 'ui' && Array.isArray(workflow.definition.nodes)) {
    /** 子图类型是定义引用，不应把 UUID 当成服务器缺少的节点。 */
    const definitions = isRecord(workflow.definition.definitions) && Array.isArray(workflow.definition.definitions.subgraphs)
      ? workflow.definition.definitions.subgraphs.slice(0, MAX_NODES) : []
    const subgraphs = new Map(definitions.flatMap((definition) => isRecord(definition) && typeof definition.id === 'string'
      && Array.isArray(definition.nodes) ? [[definition.id, definition.nodes] as const] : []))
    const pending = [...workflow.definition.nodes.slice(0, MAX_NODES)]
    const visited = new Set<string>()
    for (let index = 0; index < pending.length && index < MAX_NODES; index += 1) {
      const raw = pending[index]
      const classType = isRecord(raw) ? safeClassType(raw.type) : undefined
      if (!classType) continue
      const innerNodes = subgraphs.get(classType)
      if (innerNodes) {
        if (!visited.has(classType)) {
          visited.add(classType)
          pending.push(...innerNodes.slice(0, MAX_NODES - pending.length))
        }
      } else if (classType !== 'Note' && classType !== 'MarkdownNote') classTypes.add(classType)
    }
  }
  return [...classTypes]
}

/**
 * 分析远端工作流，并只在现有安全合同可完整证明时返回可保存定义。
 * @param workflow 远端工作流正文与格式。
 * @param objectInfo 按工作流节点类型读取并严格解析的实时 schema。
 * @returns 有界结构摘要、阻塞问题及可选的可执行定义。
 */
export function analyzeRemoteWorkflow(workflow: MediaRemoteWorkflow, objectInfo: ComfyObjectInfo): RemoteWorkflowAnalysis {
  /** 转换与最终静态校验收集的问题。 */
  const issues: RemoteWorkflowAnalysisIssue[] = []
  if (workflow.format === 'unknown') {
    return { format: workflow.format, definition: null, issues: [{ code: 'REMOTE_WORKFLOW_FORMAT_UNSUPPORTED', message: '无法识别远端工作流格式' }], nodes: [], inputs: [], outputs: [], convertible: false }
  }
  /** 待准备的 API prompt。 */
  let prompt: ComfyPrompt
  /** UI 图保留的节点位置。 */
  let uiNodes: UiNode[] = []
  try {
    if (workflow.format === 'api') prompt = parseComfyPrompt(workflow.definition)
    else {
      /** UI 图正文。 */
      const flattened = flattenComfyUiSubgraphs(workflow.definition)
      const body = flattened.definition
      issues.push(...flattened.issues)
      uiNodes = parseUiNodes(body.nodes, issues)
      if (flattened.issues.length > 0) {
        return { format: workflow.format, convertible: false, definition: null, issues: deduplicateIssues(issues), inputs: [], outputs: [],
          nodes: uiNodes.map((node) => ({ nodeId: node.id, classType: node.classType, ...(node.title ? { title: node.title } : {}),
            inputCount: node.inputs.length, linkedInputCount: node.inputs.filter((input) => input.linkId !== null).length,
            outputTypes: node.outputTypes, supported: Boolean(objectInfo[node.classType] && !objectInfo[node.classType]?.unsupported),
            coreContract: Object.hasOwn(COMFY_CORE_NODE_CONTRACTS, node.classType), ...(node.position ? { position: node.position } : {}) })),
        }
      }
      /** UI 图的权威 link 映射。 */
      const links = parseUiLinks(body.links, uiNodes, issues)
      prompt = convertUiPrompt(uiNodes, links, objectInfo, issues, flattened.inputOverrides)
      prompt = parseComfyPrompt(prompt)
    }
  } catch (error) {
    /** 对 Agent 返回稳定且不包含内部对象的解析原因。 */
    const message = error instanceof Error ? error.message : 'REMOTE_WORKFLOW_INVALID'
    issues.push({ code: message.includes('LIMIT') ? 'REMOTE_WORKFLOW_LIMIT_EXCEEDED' : 'REMOTE_WORKFLOW_INVALID', message: `远端工作流无法严格解析：${message}` })
    return { format: workflow.format, definition: null, issues: deduplicateIssues(issues), nodes: [], inputs: [], outputs: [], convertible: false }
  }
  /** API 图节点结构摘要。 */
  const nodes = summarizePrompt(prompt, objectInfo).map((node) => {
    /** UI 图中同身份节点额外携带的位置。 */
    const uiNode = uiNodes.find((item) => item.id === node.nodeId)
    return uiNode ? {
      ...node,
      inputCount: Math.max(node.inputCount, uiNode.inputs.length),
      linkedInputCount: uiNode.inputs.filter((input) => input.linkId !== null).length,
      outputTypes: uiNode.outputTypes.length > 0 ? uiNode.outputTypes : node.outputTypes,
      ...(uiNode.position ? { position: uiNode.position } : {}),
    } : node
  })
  for (const node of nodes) {
    if (!objectInfo[node.classType]) issues.push({ code: 'NODE_CLASS_UNKNOWN', nodeId: node.nodeId, message: `节点类型不存在：${node.classType}` })
    else if (objectInfo[node.classType]?.unsupported === true) issues.push({ code: 'NODE_INTERFACE_UNSUPPORTED', nodeId: node.nodeId, message: `节点接口不受支持：${node.classType}` })
  }
  /** 清洗并生成绑定后的定义及输入摘要。 */
  let prepared: ReturnType<typeof prepareDefinition>
  try {
    prepared = prepareDefinition(prompt, objectInfo)
  } catch (error) {
    /** 字段生成失败同样视为不可安全转换。 */
    const message = error instanceof Error ? error.message : 'MEDIA_WORKFLOW_INVALID'
    issues.push({ code: 'WORKFLOW_DEFINITION_INVALID', message: `无法生成声明式工作流定义：${message}` })
    return { format: workflow.format, definition: null, issues: deduplicateIssues(issues), nodes, inputs: [], outputs: collectOutputs(prompt).summaries, convertible: false }
  }
  /** UI 原始输入槽即使来自未知节点，也作为不可编辑候选提供给 Agent。 */
  const knownInputKeys = new Set(prepared.inputs.map((input) => `${input.nodeId}\0${input.input}`))
  for (const node of uiNodes) {
    for (const input of node.inputs) {
      /** 当前 UI 输入槽的唯一身份。 */
      const key = `${node.id}\0${input.name}`
      if (knownInputKeys.has(key)) continue
      prepared.inputs.push({
        nodeId: node.id,
        input: input.name,
        classType: node.classType,
        label: node.title ?? input.name,
        valueKind: input.linkId === null ? 'unknown' : 'linked',
        linked: input.linkId !== null,
        editable: false,
      })
      knownInputKeys.add(key)
    }
  }
  /** 先通过共享持久化 parser，避免内存对象绕过磁盘合同。 */
  let definition: MediaWorkflowDefinition
  try {
    definition = parseMediaWorkflowDefinition(prepared.definition)
  } catch (error) {
    /** 持久化合同拒绝原因。 */
    const message = error instanceof Error ? error.message : 'MEDIA_WORKFLOW_INVALID'
    issues.push({ code: 'WORKFLOW_DEFINITION_INVALID', message: `生成的工作流不能保存：${message}` })
    return { format: workflow.format, definition: null, issues: deduplicateIssues(issues), nodes, inputs: prepared.inputs, outputs: collectOutputs(prompt).summaries, convertible: false }
  }
  /** 复用现有执行校验器验证节点、链接、资源和产物合同。 */
  const validation = validateComfyWorkflow(definition, objectInfo, { maxIssues: 256 })
  issues.push(...validation.issues)
  if (validation.truncated) issues.push({ code: 'WORKFLOW_VALIDATION_TRUNCATED', message: '工作流问题超过分析上限' })
  /** 最终产物摘要与保存定义使用同一已解析 prompt。 */
  const outputs = collectOutputs(definition.prompt).summaries
  /** 只有无结构问题且执行校验通过时才允许登记草稿。 */
  const finalIssues = deduplicateIssues(issues)
  const convertible = validation.valid && finalIssues.length === 0
  return { format: workflow.format, definition: convertible ? definition : null, issues: finalIssues, nodes, inputs: prepared.inputs, outputs, convertible }
}
