import type {
  DesignAnnotation,
  DesignCanvasDocument,
  DesignCanvasNode,
  DesignGroup,
  DesignMutation,
} from '@proma/shared'
import { applyDesignEntityPatch } from '@proma/shared'

/** 复制选区命令，副本 ID 必须由调用方按节点顺序提供。 */
export interface DuplicateSelectionCommand {
  type: 'duplicate-selection'
  nodeIds: string[]
  duplicateNodeIds: string[]
}

/** 删除选区命令，仅移除画布节点，不删除素材。 */
export interface DeleteSelectionCommand {
  type: 'delete-selection'
  nodeIds: string[]
}

/** 创建节点分组命令，分组身份由调用方提供。 */
export interface GroupSelectionCommand {
  type: 'group-selection'
  nodeIds: string[]
  groupId: string
  name: string
}

/** 从节点当前所在分组中移除选区。 */
export interface UngroupSelectionCommand {
  type: 'ungroup-selection'
  nodeIds: string[]
}

/** 添加调用方已生成身份的批注。 */
export interface AddAnnotationCommand {
  type: 'add-annotation'
  annotation: DesignAnnotation
}

/** 按稳定 ID 删除单个批注。 */
export interface RemoveAnnotationCommand {
  type: 'remove-annotation'
  annotationId: string
}

/** Design 编辑器允许进入历史记录的有限命令集合。 */
export type DesignEditCommand =
  | DuplicateSelectionCommand
  | DeleteSelectionCommand
  | GroupSelectionCommand
  | UngroupSelectionCommand
  | AddAnnotationCommand
  | RemoveAnnotationCommand

/** 单次纯编辑归约的文档、持久化 mutation 与新选区。 */
export interface DesignEditResult {
  document: DesignCanvasDocument
  forward: DesignMutation[]
  inverse: DesignMutation[]
  selection: string[]
}

/** 画布全局快捷键解析后的有限动作集合。 */
export type DesignKeyboardAction = 'duplicate' | 'undo' | 'redo' | 'delete' | 'group' | 'ungroup'

/** 解析快捷键所需的最小事件目标。 */
export interface DesignKeyboardTarget {
  tagName?: string
  isContentEditable?: boolean
}

/** 解析快捷键所需的最小键盘事件结构，便于无 DOM 单测。 */
export interface DesignKeyboardEvent {
  key: string
  metaKey?: boolean
  ctrlKey?: boolean
  shiftKey?: boolean
  target?: unknown
}

/** 使用稳定 ID 合并实体，保留原有顺序并把新增实体追加到末尾。 */
function upsertById<T extends { id: string }>(current: T[], updates: T[]): T[] {
  /** 现有实体映射保留数组插入顺序。 */
  const entities = new Map(current.map((item) => [item.id, item]))
  for (const update of updates) entities.set(update.id, update)
  return [...entities.values()]
}

/**
 * 在 Renderer 内纯函数应用 Design mutation，供编辑预览和撤销重做共用。
 * @param document 当前不可修改的画布文档。
 * @param mutations 按顺序执行的持久化变更。
 * @returns 深拷贝并应用全部变更后的文档。
 */
export function applyDesignMutations(
  document: DesignCanvasDocument,
  mutations: DesignMutation[],
): DesignCanvasDocument {
  /** 深拷贝保证历史归约不会修改调用方基线。 */
  let next = structuredClone(document)
  for (const mutation of mutations) {
    switch (mutation.type) {
      case 'set-viewport':
        next.viewport = mutation.viewport
        break
      case 'move-nodes': {
        /** 本次 mutation 的最终节点位置索引。 */
        const positions = new Map(mutation.positions.map((item) => [item.nodeId, item.position]))
        next.nodes = next.nodes.map((node) => positions.has(node.id)
          ? { ...node, position: positions.get(node.id)! }
          : node)
        break
      }
      case 'upsert-nodes':
        next.nodes = upsertById(next.nodes, mutation.nodes)
        break
      case 'remove-nodes': {
        /** 删除集合避免节点数量增长后重复线性查找。 */
        const removedIds = new Set(mutation.nodeIds)
        next.nodes = next.nodes.filter((node) => !removedIds.has(node.id))
        break
      }
      case 'patch-nodes':
        next.nodes = applyDesignEntityPatch(next.nodes, mutation.removeIds, mutation.upserts)
        break
      case 'upsert-assets':
        next.assets = upsertById(next.assets, mutation.assets)
        break
      case 'remove-assets': {
        /** 删除集合避免素材数量增长后重复线性查找。 */
        const removedIds = new Set(mutation.assetIds)
        next.assets = next.assets.filter((asset) => !removedIds.has(asset.id))
        break
      }
      case 'upsert-groups':
        next.groups = upsertById(next.groups, mutation.groups)
        break
      case 'remove-groups': {
        /** 删除集合避免分组数量增长后重复线性查找。 */
        const removedIds = new Set(mutation.groupIds)
        next.groups = next.groups.filter((group) => !removedIds.has(group.id))
        break
      }
      case 'patch-groups':
        next.groups = applyDesignEntityPatch(next.groups, mutation.removeIds, mutation.upserts)
        break
      case 'upsert-annotations':
        next.annotations = upsertById(next.annotations, mutation.annotations)
        break
      case 'remove-annotations': {
        /** 删除集合避免批注数量增长后重复线性查找。 */
        const removedIds = new Set(mutation.annotationIds)
        next.annotations = next.annotations.filter((annotation) => !removedIds.has(annotation.id))
        break
      }
      case 'patch-annotations':
        next.annotations = applyDesignEntityPatch(next.annotations, mutation.removeIds, mutation.upserts)
        break
    }
  }
  return next
}

/** 从完整数组中提取受影响实体及其绝对索引。 */
function indexedEntities<T extends { id: string }>(entities: T[], entityIds: Set<string>) {
  return entities.flatMap((entity, index) => entityIds.has(entity.id) ? [{ entity, index }] : [])
}

/** 返回没有持久化副作用的编辑结果。 */
function unchangedResult(document: DesignCanvasDocument, selection: string[] = []): DesignEditResult {
  return { document: structuredClone(document), forward: [], inverse: [], selection }
}

/**
 * 把一个确定性编辑命令归约为文档和可持久化的正向/逆向 mutation。
 * @param document 当前项目画布文档。
 * @param command 调用方已补齐新 ID 与时间的编辑命令。
 * @returns 不修改输入文档的编辑结果。
 */
export function reduceDesignEdit(
  document: DesignCanvasDocument,
  command: DesignEditCommand,
): DesignEditResult {
  switch (command.type) {
    case 'duplicate-selection': {
      /** 按调用方选区顺序查找可复制节点。 */
      const nodesById = new Map(document.nodes.map((node) => [node.id, node]))
      const sourceNodes = command.nodeIds.flatMap((nodeId) => {
        /** 缺失节点不参与复制。 */
        const node = nodesById.get(nodeId)
        return node ? [node] : []
      })
      if (sourceNodes.length === 0 || sourceNodes.length !== command.duplicateNodeIds.length) {
        return unchangedResult(document, command.nodeIds)
      }
      /** 副本不继承 groupId，避免未同步修改原分组的双向关系。 */
      const duplicates = sourceNodes.map((node, index): DesignCanvasNode => {
        const { groupId: _groupId, ...ungroupedNode } = node
        return {
          ...ungroupedNode,
          id: command.duplicateNodeIds[index]!,
          position: { x: node.position.x + 24, y: node.position.y + 24 },
        }
      })
      /** 正向 mutation 只新增节点，素材记录保持共享。 */
      const forward: DesignMutation[] = [{ type: 'upsert-nodes', nodes: duplicates }]
      /** 逆向 mutation 只移除本次确定性副本。 */
      const inverse: DesignMutation[] = [{
        type: 'remove-nodes',
        nodeIds: duplicates.map((node) => node.id),
      }]
      return {
        document: applyDesignMutations(document, forward),
        forward,
        inverse,
        selection: duplicates.map((node) => node.id),
      }
    }
    case 'delete-selection': {
      /** 只选择文档中真实存在的节点。 */
      const removedIds = new Set(command.nodeIds.filter((nodeId) => document.nodes.some((node) => node.id === nodeId)))
      if (removedIds.size === 0) return unchangedResult(document)
      /** 删除节点后的完整节点集合用于确定性重建。 */
      const nextNodes = document.nodes.filter((node) => !removedIds.has(node.id))
      /** 同步移除分组成员并清理空组，保持双向引用合法。 */
      const nextGroups = document.groups
        .map((group) => ({ ...group, nodeIds: group.nodeIds.filter((nodeId) => !removedIds.has(nodeId)) }))
        .filter((group) => group.nodeIds.length > 0)
      /** 只有成员发生变化的分组进入局部 patch。 */
      const affectedGroupIds = new Set(document.groups
        .filter((group) => group.nodeIds.some((nodeId) => removedIds.has(nodeId)))
        .map((group) => group.id))
      const forward: DesignMutation[] = [{ type: 'patch-nodes', removeIds: [...removedIds], upserts: [] }]
      const inverse: DesignMutation[] = [{
        type: 'patch-nodes',
        removeIds: [],
        upserts: indexedEntities(document.nodes, removedIds),
      }]
      if (affectedGroupIds.size > 0) {
        forward.push({
          type: 'patch-groups',
          removeIds: [...affectedGroupIds],
          upserts: indexedEntities(nextGroups, affectedGroupIds),
        })
        inverse.push({
          type: 'patch-groups',
          removeIds: [...affectedGroupIds],
          upserts: indexedEntities(document.groups, affectedGroupIds),
        })
      }
      return { document: applyDesignMutations(document, forward), forward, inverse, selection: [] }
    }
    case 'group-selection': {
      /** 分组至少需要两个不同且真实存在的节点。 */
      const selectedIds = [...new Set(command.nodeIds)].filter((nodeId) => document.nodes.some((node) => node.id === nodeId))
      if (selectedIds.length < 2) return unchangedResult(document, selectedIds)
      const selectedSet = new Set(selectedIds)
      /** 新分组前先从旧分组移除所选节点。 */
      const retainedGroups = document.groups
        .filter((group) => group.id !== command.groupId)
        .map((group) => ({ ...group, nodeIds: group.nodeIds.filter((nodeId) => !selectedSet.has(nodeId)) }))
        .filter((group) => group.nodeIds.length > 0)
      /** 新分组固定追加到分组数组末尾。 */
      const nextGroups: DesignGroup[] = [
        ...retainedGroups,
        { id: command.groupId, name: command.name, nodeIds: selectedIds },
      ]
      /** 节点与分组同步声明同一 groupId。 */
      const nextNodes = document.nodes.map((node) => selectedSet.has(node.id)
        ? { ...node, groupId: command.groupId }
        : node)
      /** 旧分组和新分组共同构成唯一受影响集合。 */
      const affectedGroupIds = new Set([
        command.groupId,
        ...document.nodes.flatMap((node) => selectedSet.has(node.id) && node.groupId ? [node.groupId] : []),
      ])
      const forward: DesignMutation[] = [
        { type: 'patch-nodes', removeIds: selectedIds, upserts: indexedEntities(nextNodes, selectedSet) },
        { type: 'patch-groups', removeIds: [...affectedGroupIds], upserts: indexedEntities(nextGroups, affectedGroupIds) },
      ]
      const inverse: DesignMutation[] = [
        { type: 'patch-nodes', removeIds: selectedIds, upserts: indexedEntities(document.nodes, selectedSet) },
        { type: 'patch-groups', removeIds: [...affectedGroupIds], upserts: indexedEntities(document.groups, affectedGroupIds) },
      ]
      return { document: applyDesignMutations(document, forward), forward, inverse, selection: selectedIds }
    }
    case 'ungroup-selection': {
      /** 只处理当前确实属于分组的选中节点。 */
      const selectedIds = new Set(command.nodeIds.filter((nodeId) => document.nodes.some(
        (node) => node.id === nodeId && node.groupId !== undefined,
      )))
      if (selectedIds.size === 0) return unchangedResult(document, command.nodeIds)
      /** 清除节点侧 groupId。 */
      const nextNodes = document.nodes.map((node) => selectedIds.has(node.id)
        ? (({ groupId: _groupId, ...ungroupedNode }) => ungroupedNode)(node)
        : node)
      /** 清除分组侧成员并移除空组。 */
      const nextGroups = document.groups
        .map((group) => ({ ...group, nodeIds: group.nodeIds.filter((nodeId) => !selectedIds.has(nodeId)) }))
        .filter((group) => group.nodeIds.length > 0)
      /** 仅选中节点原所属分组会变化。 */
      const affectedGroupIds = new Set(document.nodes.flatMap((node) => (
        selectedIds.has(node.id) && node.groupId ? [node.groupId] : []
      )))
      const forward: DesignMutation[] = [
        { type: 'patch-nodes', removeIds: [...selectedIds], upserts: indexedEntities(nextNodes, selectedIds) },
        { type: 'patch-groups', removeIds: [...affectedGroupIds], upserts: indexedEntities(nextGroups, affectedGroupIds) },
      ]
      const inverse: DesignMutation[] = [
        { type: 'patch-nodes', removeIds: [...selectedIds], upserts: indexedEntities(document.nodes, selectedIds) },
        { type: 'patch-groups', removeIds: [...affectedGroupIds], upserts: indexedEntities(document.groups, affectedGroupIds) },
      ]
      return { document: applyDesignMutations(document, forward), forward, inverse, selection: command.nodeIds }
    }
    case 'add-annotation': {
      /** 同 ID 批注存在时 inverse 恢复旧值，否则删除新增值。 */
      const previousIndex = document.annotations.findIndex((annotation) => annotation.id === command.annotation.id)
      const previous = previousIndex >= 0 ? document.annotations[previousIndex] : undefined
      const targetIndex = previousIndex >= 0 ? previousIndex : document.annotations.length
      const forward: DesignMutation[] = [{
        type: 'patch-annotations',
        removeIds: [command.annotation.id],
        upserts: [{ entity: command.annotation, index: targetIndex }],
      }]
      const inverse: DesignMutation[] = previous
        ? [{
            type: 'patch-annotations',
            removeIds: [command.annotation.id],
            upserts: [{ entity: previous, index: previousIndex }],
          }]
        : [{ type: 'patch-annotations', removeIds: [command.annotation.id], upserts: [] }]
      return { document: applyDesignMutations(document, forward), forward, inverse, selection: [] }
    }
    case 'remove-annotation': {
      /** 不存在的批注不产生历史噪音。 */
      const annotationIndex = document.annotations.findIndex((item) => item.id === command.annotationId)
      const annotation = annotationIndex >= 0 ? document.annotations[annotationIndex] : undefined
      if (!annotation) return unchangedResult(document)
      const forward: DesignMutation[] = [{ type: 'patch-annotations', removeIds: [annotation.id], upserts: [] }]
      const inverse: DesignMutation[] = [{
        type: 'patch-annotations',
        removeIds: [],
        upserts: [{ entity: annotation, index: annotationIndex }],
      }]
      return { document: applyDesignMutations(document, forward), forward, inverse, selection: [] }
    }
  }
}

/**
 * 解析 Design 画布快捷键，输入控件和 contenteditable 始终保留原生行为。
 * @param event 键盘事件的可测试最小结构。
 * @param hasSelection 当前项目是否有节点选区。
 * @returns 可执行编辑动作；不应拦截时返回 null。
 */
export function resolveDesignKeyboardAction(
  event: DesignKeyboardEvent,
  hasSelection: boolean,
): DesignKeyboardAction | null {
  /** 输入类目标不接管复制、删除或分组键。 */
  const target = typeof event.target === 'object' && event.target !== null
    ? event.target as DesignKeyboardTarget
    : undefined
  const targetTag = target?.tagName?.toUpperCase()
  if (target?.isContentEditable
    || targetTag === 'INPUT'
    || targetTag === 'TEXTAREA'
    || targetTag === 'SELECT') return null

  /** 平台主修饰键同时兼容 macOS 与 Windows/Linux。 */
  const commandKey = event.metaKey === true || event.ctrlKey === true
  const key = event.key.toLowerCase()
  if (commandKey && key === 'z') return event.shiftKey ? 'redo' : 'undo'
  if (!hasSelection) return null
  if (commandKey && key === 'c') return 'duplicate'
  if (key === 'backspace' || key === 'delete') return 'delete'
  if (commandKey && key === 'g') return event.shiftKey ? 'ungroup' : 'group'
  return null
}
