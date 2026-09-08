import type { JsonObject, JsonValue, MediaRemoteWorkflowAnalysisIssue } from '@proma/shared'

/** 展开后的 UI 图最多保留 512 个真实节点。 */
const MAX_EXPANDED_NODES = 512
/** 展开后的 UI 图最多保留 2048 条边。 */
const MAX_EXPANDED_LINKS = 2_048
/** 子图定义最多递归四层，避免恶意或损坏定义放大。 */
const MAX_SUBGRAPH_DEPTH = 4
/** 节点、边与接口身份只接受有界安全字符。 */
const SAFE_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,256}$/

/** canonical UI 子图展开结果，字段覆盖由后续 schema 转换阶段显式采用。 */
export interface FlattenComfyUiSubgraphsResult {
  definition: JsonObject
  inputOverrides: Record<string, Record<string, JsonValue>>
  issues: MediaRemoteWorkflowAnalysisIssue[]
}

/** 统一后的 LiteGraph 边。 */
interface UiLink {
  id: string
  originId: string
  originSlot: number
  targetId: string
  targetSlot: number
  type: string
}

/** 已解析的 canonical 子图接口。 */
interface SubgraphInterface {
  id: string
  name: string
  type: string
  linkIds: string[]
}

/** 判断未知值是否为普通 JSON 对象。 */
function isRecord(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** 把数字或字符串身份转换为安全字符串。 */
function safeId(value: unknown): string | null {
  const id = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : typeof value === 'string' ? value : ''
  return SAFE_ID_PATTERN.test(id) ? id : null
}

/** 解析非负槽位。 */
function safeSlot(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null
}

/** 克隆节点列表，避免任何失败路径修改原始正文。 */
function cloneNodes(value: JsonValue | undefined): JsonObject[] | null {
  return Array.isArray(value) && value.every(isRecord) ? structuredClone(value) : null
}

/** 同时兼容根图 tuple 边和 definitions.subgraphs 的对象边。 */
function parseLink(value: JsonValue): UiLink | null {
  const fields = Array.isArray(value)
    ? { id: value[0], originId: value[1], originSlot: value[2], targetId: value[3], targetSlot: value[4], type: value[5] }
    : isRecord(value)
      ? { id: value.id, originId: value.origin_id, originSlot: value.origin_slot, targetId: value.target_id, targetSlot: value.target_slot, type: value.type }
      : null
  if (!fields) return null
  const id = safeId(fields.id)
  const originId = safeId(fields.originId)
  const targetId = safeId(fields.targetId)
  const originSlot = safeSlot(fields.originSlot)
  const targetSlot = safeSlot(fields.targetSlot)
  const type = typeof fields.type === 'string' && fields.type.length <= 256 ? fields.type : ''
  return id && originId && targetId && originSlot !== null && targetSlot !== null
    ? { id, originId, originSlot, targetId, targetSlot, type }
    : null
}

/** 将边输出为 ComfyUI 根图可读取的 tuple。 */
function linkTuple(link: UiLink): JsonValue[] {
  return [link.id, link.originId, link.originSlot, link.targetId, link.targetSlot, link.type]
}

/** 解析并验证接口 ID、名称及边列表唯一性。 */
function parseInterfaces(value: JsonValue | undefined): SubgraphInterface[] | null {
  if (!Array.isArray(value)) return null
  const interfaces: SubgraphInterface[] = []
  const ids = new Set<string>()
  const names = new Set<string>()
  for (const item of value) {
    if (!isRecord(item)) return null
    const id = safeId(item.id)
    const name = safeId(item.name)
    const type = typeof item.type === 'string' && item.type.length <= 256 ? item.type : ''
    const linkIds = Array.isArray(item.linkIds) ? item.linkIds.map(safeId) : []
    if (!id || !name || !type || linkIds.length === 0 || linkIds.some((linkId) => !linkId)
      || ids.has(id) || names.has(name) || new Set(linkIds).size !== linkIds.length) return null
    ids.add(id)
    names.add(name)
    interfaces.push({ id, name, type, linkIds: linkIds as string[] })
  }
  return interfaces
}

/** 返回节点输入数组；缺少或非法输入不能用于边界证明。 */
function nodeInputs(node: JsonObject): JsonObject[] | null {
  return Array.isArray(node.inputs) && node.inputs.every(isRecord) ? node.inputs : null
}

/** 返回节点输出数组；缺少或非法输出不能用于边界证明。 */
function nodeOutputs(node: JsonObject): JsonObject[] | null {
  return Array.isArray(node.outputs) && node.outputs.every(isRecord) ? node.outputs : null
}

/** 在定义依赖图上预检循环和深度，避免先展开外层再留下半展开内层。 */
function validateDefinitionTree(
  definitionId: string,
  definitions: Map<string, JsonObject>,
  stack: string[],
  depth: number,
  budget: { visited: number },
): 'UI_SUBGRAPH_CYCLE' | 'UI_SUBGRAPH_DEPTH_EXCEEDED' | 'UI_SUBGRAPH_LIMIT_EXCEEDED' | null {
  if (stack.includes(definitionId)) return 'UI_SUBGRAPH_CYCLE'
  if (depth > MAX_SUBGRAPH_DEPTH) return 'UI_SUBGRAPH_DEPTH_EXCEEDED'
  const definition = definitions.get(definitionId)
  const nodes = definition && Array.isArray(definition.nodes) ? definition.nodes : null
  if (!nodes) return null
  budget.visited += nodes.length
  if (budget.visited > MAX_EXPANDED_NODES) return 'UI_SUBGRAPH_LIMIT_EXCEEDED'
  for (const node of nodes) {
    if (!isRecord(node)) continue
    const nestedId = typeof node.type === 'string' && definitions.has(node.type) ? node.type : null
    if (!nestedId) continue
    const issue = validateDefinitionTree(nestedId, definitions, [...stack, definitionId], depth + 1, budget)
    if (issue) return issue
  }
  return null
}

/** 更新克隆内部节点上的输入边引用。 */
function setInputLink(node: JsonObject, slot: number, linkId: string | null): boolean {
  const inputs = nodeInputs(node)
  if (!inputs?.[slot]) return false
  inputs[slot]!.link = linkId
  return true
}

/** 更新克隆内部节点上的输出边引用。 */
function replaceOutputLink(node: JsonObject, slot: number, oldId: string, replacementIds: string[]): boolean {
  const outputs = nodeOutputs(node)
  const output = outputs?.[slot]
  if (!output) return false
  const currentIds = Array.isArray(output.links) ? output.links.map(safeId) : []
  if (!currentIds.includes(oldId)) return false
  output.links = currentIds.flatMap((id) => id === oldId ? replacementIds : id).filter((id): id is string => Boolean(id))
  return true
}

/** 构造带实例前缀的内部节点或边身份。 */
function prefixed(hostId: string, innerId: string): string {
  return `${hostId}::${innerId}`
}

/**
 * 展开 ComfyUI canonical 子图实例。
 * @param body 原始 UI 工作流正文。
 * @returns 展平后的 UI 图、显式字段覆盖及安全问题。
 */
export function flattenComfyUiSubgraphs(body: JsonObject): FlattenComfyUiSubgraphsResult {
  const definition = structuredClone(body)
  const inputOverrides: Record<string, Record<string, JsonValue>> = {}
  const issues: MediaRemoteWorkflowAnalysisIssue[] = []
  const rawSubgraphs = isRecord(definition.definitions) && Array.isArray(definition.definitions.subgraphs)
    ? definition.definitions.subgraphs : []
  const definitions = new Map<string, JsonObject>()
  for (const raw of rawSubgraphs) {
    if (!isRecord(raw)) {
      issues.push({ code: 'UI_SUBGRAPH_DEFINITION_INVALID', message: '子图定义缺少唯一安全 ID' })
      continue
    }
    const id = safeId(raw.id)
    if (!id || definitions.has(id)) {
      issues.push({ code: 'UI_SUBGRAPH_DEFINITION_INVALID', message: '子图定义缺少唯一安全 ID' })
      continue
    }
    definitions.set(id, raw)
  }
  if (definitions.size === 0) return { definition, inputOverrides, issues }

  const initialNodes = cloneNodes(definition.nodes)
  const links = Array.isArray(definition.links) ? definition.links.map(parseLink) : null
  if (!initialNodes || !links || links.some((link) => !link)) {
    issues.push({ code: 'UI_SUBGRAPH_GRAPH_INVALID', message: '包含子图的 UI 工作流节点或边格式无效' })
    return { definition, inputOverrides, issues }
  }
  let nodes: JsonObject[] = initialNodes
  let normalizedLinks = links as UiLink[]
  const blockedHosts = new Set<string>()

  while (true) {
    const host: JsonObject | undefined = nodes.find((node) => typeof node.type === 'string' && definitions.has(node.type) && !blockedHosts.has(String(node.id)))
    if (!host) break
    const hostId = safeId(host.id)
    const definitionId = typeof host.type === 'string' ? safeId(host.type) : null
    if (!hostId || !definitionId) {
      issues.push({ code: 'UI_SUBGRAPH_HOST_INVALID', message: '子图实例缺少安全 ID 或定义引用' })
      break
    }
    const reject = (code: string, message: string, input?: string): void => {
      issues.push({ code, nodeId: hostId, ...(input ? { input } : {}), message })
      blockedHosts.add(hostId)
    }
    const nestedIssue = validateDefinitionTree(definitionId, definitions, [], 1, { visited: 0 })
    if (nestedIssue) {
      reject(nestedIssue, nestedIssue === 'UI_SUBGRAPH_CYCLE' ? '子图定义形成递归引用，不能安全展开'
        : nestedIssue === 'UI_SUBGRAPH_DEPTH_EXCEEDED' ? '子图嵌套超过四层上限' : '子图定义遍历超过 512 节点预算')
      continue
    }
    const subgraph = definitions.get(definitionId)!
    const innerNodes = cloneNodes(subgraph.nodes)
    const innerLinks = Array.isArray(subgraph.links) ? subgraph.links.map(parseLink) : null
    const inputs = parseInterfaces(subgraph.inputs)
    const outputs = parseInterfaces(subgraph.outputs)
    if (!innerNodes || !innerLinks || innerLinks.some((link) => !link) || !inputs || !outputs
      || !isRecord(subgraph.inputNode) || safeId(subgraph.inputNode.id) !== '-10'
      || !isRecord(subgraph.outputNode) || safeId(subgraph.outputNode.id) !== '-20') {
      reject('UI_SUBGRAPH_DEFINITION_INVALID', '子图定义缺少 canonical 输入、输出、节点或边结构')
      continue
    }
    if ([host, ...innerNodes].some((node) => node.mode !== undefined && node.mode !== 0)) {
      reject('UI_SUBGRAPH_NODE_MODE_UNSUPPORTED', '子图实例或内部节点使用了无法等价展开的 mute/bypass mode')
      continue
    }
    if (isRecord(host.properties) && Array.isArray(host.properties.proxyWidgets) && host.properties.proxyWidgets.length > 0) {
      reject('UI_SUBGRAPH_PROXY_UNSUPPORTED', '遗留 proxyWidgets 没有 canonical 边界来源，已隔离等待重新保存或修复')
      continue
    }
    const hostInputs = nodeInputs(host)
    const hostOutputs = nodeOutputs(host)
    if (!hostInputs || hostInputs.length !== inputs.length || hostInputs.some((input, index) => safeId(input.name) !== inputs[index]?.name)) {
      reject('UI_SUBGRAPH_INPUT_MISMATCH', `子图实例输入与定义不一致：host=${hostInputs?.length ?? 0} definition=${inputs.length}`)
      continue
    }
    if (!hostOutputs || hostOutputs.length !== outputs.length || hostOutputs.some((output, index) => safeId(output.name) !== outputs[index]?.name)) {
      reject('UI_SUBGRAPH_OUTPUT_MISMATCH', `子图实例输出与定义不一致：host=${hostOutputs?.length ?? 0} definition=${outputs.length}`)
      continue
    }
    const widgetInputs = hostInputs.filter((input) => input.link === null && isRecord(input.widget) && safeId(input.widget.name) === safeId(input.name))
    const widgetValues = Array.isArray(host.widgets_values) ? host.widgets_values : []
    /** 外层展开留下的具名值优先于嵌套 host 自身默认值。 */
    const inheritedOverrides = inputOverrides[hostId]
    const widgetNames = new Set(widgetInputs.map((input) => String(input.name)))
    if (widgetInputs.length !== widgetValues.length
      || (inheritedOverrides && Object.keys(inheritedOverrides).some((name) => !widgetNames.has(name)))) {
      reject('UI_SUBGRAPH_WIDGET_MAPPING_UNSUPPORTED', `子图实例 widget 无法一一映射：inputs=${widgetInputs.length} values=${widgetValues.length}`)
      continue
    }
    const incoming = normalizedLinks.filter((link) => link.targetId === hostId)
    const outgoing = normalizedLinks.filter((link) => link.originId === hostId)
    if (incoming.some((link) => safeId(hostInputs[link.targetSlot]?.link) !== link.id)
      || outgoing.some((link) => !Array.isArray(hostOutputs[link.originSlot]?.links)
        || !(hostOutputs[link.originSlot]!.links as JsonValue[]).map(safeId).includes(link.id))) {
      reject('UI_SUBGRAPH_LINK_INVALID', '子图实例边与 host 输入/输出槽声明不一致')
      continue
    }
    const nodeMap = new Map<string, JsonObject>()
    let invalidInnerNode = false
    for (const innerNode of innerNodes) {
      const innerId = safeId(innerNode.id)
      if (!innerId || innerId === '-10' || innerId === '-20' || nodeMap.has(innerId)) {
        invalidInnerNode = true
        break
      }
      innerNode.id = prefixed(hostId, innerId)
      nodeMap.set(innerId, innerNode)
    }
    if (invalidInnerNode) {
      reject('UI_SUBGRAPH_DEFINITION_INVALID', '子图包含无效、重复或保留节点 ID')
      continue
    }
    const parsedInnerLinks = innerLinks as UiLink[]
    const innerById = new Map(parsedInnerLinks.map((link) => [link.id, link]))
    /** 每条边界边都必须被接口显式登记，不能靠 -10/-20 魔术身份静默丢弃。 */
    const declaredBoundaryIds = new Set([...inputs, ...outputs].flatMap((item) => item.linkIds))
    if (innerById.size !== parsedInnerLinks.length
      || [...inputs, ...outputs].some((item) => item.linkIds.some((linkId) => !innerById.has(linkId)))
      || parsedInnerLinks.some((link) => (link.originId === '-10' || link.targetId === '-20') && !declaredBoundaryIds.has(link.id))
      || parsedInnerLinks.some((link) => link.targetId === '-10' || link.originId === '-20')) {
      reject('UI_SUBGRAPH_LINK_INVALID', '子图接口引用了缺失或重复的内部边')
      continue
    }
    const instanceLinks: UiLink[] = []
    const instanceOverrides: Record<string, Record<string, JsonValue>> = {}
    /** 外部 source 的 output.links 更新延迟到整实例验证通过后原子提交。 */
    const sourceFanouts: Array<{ nodeId: string; slot: number; oldId: string; replacementIds: string[] }> = []
    let boundaryFailure: { code: string; message: string; input?: string } | null = null
    for (let index = 0; index < inputs.length && !boundaryFailure; index += 1) {
      const input = inputs[index]!
      const hostInput = hostInputs[index]!
      const boundaryLinks = input.linkIds.map((id) => innerById.get(id)!)
      if (boundaryLinks.some((link) => link.originId !== '-10' || link.originSlot !== index || !nodeMap.has(link.targetId))) {
        boundaryFailure = { code: 'UI_SUBGRAPH_LINK_INVALID', input: input.name, message: `子图输入边界槽不一致：${input.name}` }
        break
      }
      const hostLinkId = hostInput.link === null ? null : safeId(hostInput.link)
      const source = hostLinkId ? incoming.find((link) => link.id === hostLinkId && link.targetSlot === index) : undefined
      const widgetIndex = widgetInputs.indexOf(hostInput)
      if (!source && widgetIndex < 0) {
        boundaryFailure = { code: 'UI_SUBGRAPH_INPUT_UNRESOLVED', input: input.name, message: `子图输入既无外部连线也无 canonical widget：${input.name}` }
        break
      }
      /** linked input 的外部 source 必须双向声明原 link，扇出 ID 一次性预先确定。 */
      const fanoutIds = boundaryLinks.map((boundary, linkIndex) => linkIndex === 0
        ? source?.id ?? '' : prefixed(hostId, `input:${boundary.id}`))
      if (source) {
        const sourceNode = nodes.find((node) => safeId(node.id) === source.originId)
        const sourceOutput = sourceNode ? nodeOutputs(sourceNode)?.[source.originSlot] : undefined
        const sourceDeclaredIds = sourceOutput && Array.isArray(sourceOutput.links)
          ? sourceOutput.links.map(safeId).filter((id): id is string => Boolean(id)) : []
        if (!sourceNode || !sourceDeclaredIds.includes(source.id)) {
          boundaryFailure = { code: 'UI_SUBGRAPH_LINK_INVALID', input: input.name, message: `子图外部输入来源槽声明不一致：${input.name}` }
          break
        }
        sourceFanouts.push({ nodeId: source.originId, slot: source.originSlot, oldId: source.id, replacementIds: fanoutIds })
      }
      for (let linkIndex = 0; linkIndex < boundaryLinks.length; linkIndex += 1) {
        const boundary = boundaryLinks[linkIndex]!
        const target = nodeMap.get(boundary.targetId)!
        const targetInputs = nodeInputs(target)
        const targetInput = targetInputs?.[boundary.targetSlot]
        if (!targetInput || safeId(targetInput.link) !== boundary.id || safeId(targetInput.name) === null) {
          boundaryFailure = { code: 'UI_SUBGRAPH_LINK_INVALID', input: input.name, message: `子图输入目标槽声明不一致：${input.name}` }
          break
        }
        if (source) {
          const linkId = fanoutIds[linkIndex]!
          setInputLink(target, boundary.targetSlot, linkId)
          instanceLinks.push({ ...source, id: linkId, targetId: String(target.id), targetSlot: boundary.targetSlot, type: boundary.type || source.type })
        } else {
          setInputLink(target, boundary.targetSlot, null)
          const targetId = String(target.id)
          instanceOverrides[targetId] ??= {}
          const inputName = String(targetInput.name)
          const widgetValue = inheritedOverrides && Object.hasOwn(inheritedOverrides, inputName)
            ? inheritedOverrides[inputName]!
            : widgetValues[widgetIndex]!
          instanceOverrides[targetId]![inputName] = structuredClone(widgetValue)
        }
      }
    }
    for (let index = 0; index < outputs.length && !boundaryFailure; index += 1) {
      const output = outputs[index]!
      const boundaryLinks = output.linkIds.map((id) => innerById.get(id)!)
      if (boundaryLinks.length !== 1 || boundaryLinks[0]!.targetId !== '-20' || boundaryLinks[0]!.targetSlot !== index || !nodeMap.has(boundaryLinks[0]!.originId)) {
        boundaryFailure = { code: 'UI_SUBGRAPH_LINK_INVALID', message: `子图输出边界槽不一致：${output.name}` }
        break
      }
      const externalLinks = outgoing.filter((link) => link.originSlot === index)
      const rawDeclaredIds = hostOutputs[index]!.links
      const declaredIds = Array.isArray(rawDeclaredIds) ? rawDeclaredIds.map(safeId).filter((id): id is string => Boolean(id)) : []
      if (declaredIds.length !== externalLinks.length || externalLinks.some((link) => !declaredIds.includes(link.id))) {
        boundaryFailure = { code: 'UI_SUBGRAPH_OUTPUT_MISMATCH', message: `子图输出外部边声明不一致：${output.name}` }
        break
      }
      const boundary = boundaryLinks[0]!
      const sourceNode = nodeMap.get(boundary.originId)!
      if (!replaceOutputLink(sourceNode, boundary.originSlot, boundary.id, externalLinks.map((link) => link.id))) {
        boundaryFailure = { code: 'UI_SUBGRAPH_LINK_INVALID', message: `子图输出来源槽声明不一致：${output.name}` }
        break
      }
      instanceLinks.push(...externalLinks.map((link) => ({ ...link, originId: String(sourceNode.id), originSlot: boundary.originSlot, type: boundary.type || link.type })))
    }
    if (boundaryFailure) {
      reject(boundaryFailure.code, boundaryFailure.message, boundaryFailure.input)
      continue
    }
    for (const link of parsedInnerLinks) {
      if (link.originId === '-10' || link.targetId === '-20') continue
      const sourceNode = nodeMap.get(link.originId)
      const targetNode = nodeMap.get(link.targetId)
      const nextId = prefixed(hostId, link.id)
      const targetInput = targetNode ? nodeInputs(targetNode)?.[link.targetSlot] : undefined
      if (!sourceNode || !targetNode || safeId(targetInput?.link) !== link.id || !setInputLink(targetNode, link.targetSlot, nextId)
        || !replaceOutputLink(sourceNode, link.originSlot, link.id, [nextId])) {
        boundaryFailure = { code: 'UI_SUBGRAPH_LINK_INVALID', message: `子图内部边端点或槽位无效：${link.id}` }
        break
      }
      instanceLinks.push({ ...link, id: nextId, originId: String(sourceNode.id), targetId: String(targetNode.id) })
    }
    if (boundaryFailure) {
      reject(boundaryFailure.code, boundaryFailure.message, boundaryFailure.input)
      continue
    }
    const retainedLinks = normalizedLinks.filter((link) => link.originId !== hostId && link.targetId !== hostId)
    if (nodes.length - 1 + innerNodes.length > MAX_EXPANDED_NODES || retainedLinks.length + instanceLinks.length > MAX_EXPANDED_LINKS) {
      reject('UI_SUBGRAPH_LIMIT_EXCEEDED', '子图展开后超过 512 节点或 2048 边上限')
      continue
    }
    /** 克隆保留节点后再更新 source，失败时不会污染当前图。 */
    const nextNodes = nodes.flatMap((node): JsonObject[] => node === host ? innerNodes : [structuredClone(node)])
    let sourceUpdateFailed = false
    for (const fanout of sourceFanouts) {
      const sourceNode = nextNodes.find((node) => safeId(node.id) === fanout.nodeId)
      if (!sourceNode || !replaceOutputLink(sourceNode, fanout.slot, fanout.oldId, fanout.replacementIds)) {
        sourceUpdateFailed = true
        break
      }
    }
    if (sourceUpdateFailed) {
      reject('UI_SUBGRAPH_LINK_INVALID', '子图外部输入来源在原子提交前失效')
      continue
    }
    nodes = nextNodes
    normalizedLinks = [...retainedLinks, ...instanceLinks]
    delete inputOverrides[hostId]
    Object.assign(inputOverrides, instanceOverrides)
  }

  definition.nodes = nodes
  definition.links = normalizedLinks.map(linkTuple)
  if (isRecord(definition.definitions)) definition.definitions = { ...definition.definitions, subgraphs: [] }
  return { definition, inputOverrides, issues }
}
