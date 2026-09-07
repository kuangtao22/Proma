import type { ComfyObjectInfo, MediaAssetRef, MediaWorkflowDefinition } from '../../../../../../packages/shared/src/types'
import { COMFY_CORE_NODE_CONTRACTS, validateComfyWorkflow } from './comfyui-workflow'

export interface MediaWorkflowInspection {
  nodes: Array<{ nodeId: string; classType: string; inputs: string[]; requiredInputs: string[]; outputTypes: string[] }>
  modelFields: Array<{ nodeId: string; input: string; values: string[]; totalValues: number }>
  bindings: Array<{ key: string; kind: string; nodeId: string; input: string; defaultValue?: string | number | boolean }>
  outputs: Array<{ key: string; nodeId: string; outputIndex: number; mediaType: string }>
  issues: Array<{ code: string; nodeId?: string; input?: string; message: string }>
  unsupportedReasons: string[]
  totalNodes: number
  nextOffset: number | null
  truncated: boolean
}

export interface MediaInputCandidate {
  asset: MediaAssetRef
  roles: string[]
  width?: number
  height?: number
  durationMs?: number
}

export interface MediaInputMatch {
  bindings: Record<string, MediaAssetRef>
  ambiguous: string[]
  missing: string[]
  incompatible: string[]
}

/** 分析工作流结构，所有数组均按定义原始顺序返回，保证结果稳定。 */
export function inspectMediaWorkflow(definition: MediaWorkflowDefinition, objectInfo: ComfyObjectInfo, options: { offset?: number; limit?: number } = {}): MediaWorkflowInspection {
  const validation = validateComfyWorkflow(definition, objectInfo)
  const offset = options.offset ?? 0
  const limit = options.limit ?? 16
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 32) throw new Error('MEDIA_INSPECTION_PAGE_INVALID')
  const modelFields: MediaWorkflowInspection['modelFields'] = []
  const entries = Object.entries(definition.prompt)
  const nodes = entries.slice(offset, offset + limit).map(([nodeId, node]) => {
    const schema = objectInfo[node.class_type]
    for (const input of COMFY_CORE_NODE_CONTRACTS[node.class_type]?.modelInputs ?? []) {
      const type = schema?.input.required[input]?.[0] ?? schema?.input.optional?.[input]?.[0]
      if (Array.isArray(type)) modelFields.push({ nodeId, input, values: type.filter((item): item is string => typeof item === 'string').slice(0, 20), totalValues: type.length })
    }
    return { nodeId, classType: node.class_type, inputs: Object.keys(node.inputs), requiredInputs: Object.keys(schema?.input.required ?? {}), outputTypes: schema?.output ?? [] }
  })
  const unsupportedReasons = [...new Set(validation.issues
    .filter((issue) => issue.code !== 'OUTPUT_REQUIRED')
    .map((issue) => issue.message))]
  for (const binding of definition.bindings) {
    if (binding.kind === 'audio' || binding.kind === 'video') unsupportedReasons.push(`绑定 ${binding.key} 的 ${binding.kind} 输入尚未适配 ComfyUI 上传协议`)
  }
  return {
    nodes,
    modelFields,
    bindings: definition.bindings.map(({ key, kind, nodeId, input }) => {
      const value = definition.prompt[nodeId]?.inputs[input]
      const scalar = ['text', 'number', 'boolean'].includes(kind) && (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
      return { key, kind, nodeId, input, ...(scalar ? { defaultValue: typeof value === 'string' ? value.slice(0, 4096) : value } : {}) }
    }),
    outputs: definition.outputs.map(({ key, nodeId, outputIndex, mediaType }) => ({ key, nodeId, outputIndex, mediaType })),
    issues: validation.issues.slice(0, 64),
    unsupportedReasons: [...new Set(unsupportedReasons)].slice(0, 32),
    totalNodes: entries.length,
    nextOffset: offset + limit < entries.length ? offset + limit : null,
    truncated: entries.length > nodes.length || validation.issues.length > 64 || modelFields.some((field) => field.values.length < field.totalValues),
  }
}

/** 按显式资产 ID、角色和媒体类型匹配输入；不按文件名或数组位置推断。 */
export function matchMediaWorkflowInputs(
  definition: MediaWorkflowDefinition,
  candidates: MediaInputCandidate[],
  explicitBindings: Record<string, string> = {},
): MediaInputMatch {
  const result: MediaInputMatch = { bindings: {}, ambiguous: [], missing: [], incompatible: [] }
  if (Object.keys(explicitBindings).some((key) => !definition.bindings.some((binding) => binding.key === key))) throw new Error('MEDIA_INPUT_UNEXPECTED')
  for (const binding of definition.bindings) {
    if (!['image', 'video', 'audio'].includes(binding.kind)) continue
    const explicitId = explicitBindings[binding.key]
    const roleMatches = candidates.filter((candidate) => candidate.roles.includes(binding.key))
    const matches = (roleMatches.length ? roleMatches : candidates).filter((candidate) => candidate.asset.mediaKind === binding.kind)
    const explicit = explicitId ? candidates.find((candidate) => candidate.asset.assetId === explicitId) : undefined
    if (explicit) {
      if (explicit.asset.mediaKind !== binding.kind) result.incompatible.push(binding.key)
      else result.bindings[binding.key] = explicit.asset
      continue
    }
    if (explicitId) { result.incompatible.push(binding.key); continue }
    if (matches.length === 1) result.bindings[binding.key] = matches[0]!.asset
    else if (matches.length > 1) result.ambiguous.push(binding.key)
    else if (roleMatches.length > 0) result.incompatible.push(binding.key)
    else result.missing.push(binding.key)
  }
  return result
}
