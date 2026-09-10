import { inspectCanvasMediaInputConnections } from '@proma/shared'
import type {
  CanvasDocument,
  CanvasMediaModuleConfig,
  CanvasMediaPreparationStatus,
  CanvasMediaTarget,
  CanvasMutation,
  CanvasTarget,
} from '@proma/shared'

/** 媒体输入补线在异步边界前后读取的当前权威上下文。 */
export interface CanvasMediaConnectContext {
  workspaceKey: string
  document: CanvasDocument
  permissionWritable: boolean
  blockedNodeIds: ReadonlySet<string>
}

/** 单次媒体输入补线所需的可注入边界。 */
export interface ConnectCanvasMediaInputsInput {
  target: CanvasMediaTarget
  config: CanvasMediaModuleConfig
  createOperationId: () => string
  getCurrentContext: () => CanvasMediaConnectContext | null
  beginOperation: (operationId: string) => boolean
  endOperation: (operationId: string) => void
  checkPreparation: (target: CanvasMediaTarget) => Promise<CanvasMediaPreparationStatus>
  save: (input: CanvasTarget & {
    expectedRevision: number
    mutations: CanvasMutation[]
  }) => Promise<CanvasDocument>
  onSuccess: (document: CanvasDocument) => void
}

/** 判断本轮实际要写入的目标或来源是否处于运行/等待审批状态。 */
function hasBlockedMediaConnection(
  target: CanvasMediaTarget,
  sourceNodeIds: ReadonlySet<string>,
  blockedNodeIds: ReadonlySet<string>,
): boolean {
  if (blockedNodeIds.has(target.nodeId)) return true
  for (const sourceNodeId of sourceNodeIds) {
    if (blockedNodeIds.has(sourceNodeId)) return true
  }
  return false
}

/**
 * 为已保存媒体输入补齐缺失的真实图边，并在提交前复验图、配置与活动状态。
 * @param input 当前工作台目标、配置基线和结构保存边界。
 * @returns 无缺边或一次 CAS 保存完成后结束；拒绝并发变化且不自动换 revision 重试。
 */
export async function connectCanvasMediaInputs(input: ConnectCanvasMediaInputsInput): Promise<void> {
  if (input.config.contentId !== input.target.mediaModuleId || input.config.mediaKind !== input.target.mediaKind) {
    throw new Error('CANVAS_MEDIA_TARGET_INVALID')
  }
  /** 初始文档对象身份与 revision 共同标识本次补线读取的图代次。 */
  const initial = input.getCurrentContext()
  if (!initial || !initial.permissionWritable) throw new Error('CANVAS_MEDIA_CONNECT_UNAVAILABLE')
  /** shared 检查器只依据当前图和已保存输入规划增量边，不读取素材或删除旧边。 */
  const inspection = inspectCanvasMediaInputConnections(initial.document, input.target, input.config.inputs)
  if (inspection.missingEdges.length === 0) return
  /** 来源集合同时用于活动态门禁；同来源多槽位不会重复检查或重复建边。 */
  const sourceNodeIds = new Set(inspection.missingEdges.map((edge) => edge.sourceNodeId))
  /** 配置 revision 固定为工作台触发时的已保存基线。 */
  const initialConfigRevision = input.config.revision
  /** 结构锁身份和图边身份均由 Workspace 的稳定 UUID 生成器提供。 */
  const operationId = input.createOperationId()
  if (!input.beginOperation(operationId)) throw new Error('CANVAS_MEDIA_CONNECT_BUSY')
  try {
    if (hasBlockedMediaConnection(input.target, sourceNodeIds, initial.blockedNodeIds)) {
      throw new Error('CANVAS_MEDIA_CONNECT_BLOCKED')
    }
    /** 准备态仅用于复验 Host 当前配置 revision；缺工作流不妨碍先补真实输入边。 */
    const preparation = await input.checkPreparation(input.target)
    /** await 后重新读取权威图，任何换代、失权或 Workspace 切换都丢弃旧计划。 */
    const current = input.getCurrentContext()
    if (!current
      || current.workspaceKey !== initial.workspaceKey
      || current.document !== initial.document
      || current.document.revision !== initial.document.revision
      || !current.permissionWritable) {
      throw new Error('CANVAS_MEDIA_CONNECT_STALE')
    }
    if (preparation.configRevision !== initialConfigRevision) {
      throw new Error('CANVAS_MEDIA_CONFIG_CONFLICT')
    }
    if (hasBlockedMediaConnection(input.target, sourceNodeIds, current.blockedNodeIds)) {
      throw new Error('CANVAS_MEDIA_CONNECT_BLOCKED')
    }
    /** 一次 upsert 只追加规划边，不隐式清理错误端口或其它业务关系。 */
    const mutation: Extract<CanvasMutation, { type: 'upsert-edges' }> = {
      type: 'upsert-edges',
      edges: inspection.missingEdges.map((edge) => ({ id: input.createOperationId(), ...edge })),
    }
    const saved = await input.save({
      projectId: input.target.projectId,
      canvasId: input.target.canvasId,
      expectedRevision: initial.document.revision,
      mutations: [mutation],
    })
    /** 保存成功不表示配置与图跨 Store 原子；Renderer 只接管仍属同一工作台且不会倒退的文档。 */
    const settled = input.getCurrentContext()
    if (settled
      && settled.workspaceKey === initial.workspaceKey
      && settled.document === initial.document
      && settled.document.revision <= saved.revision
      && settled.permissionWritable) {
      input.onSuccess(saved)
    }
  } finally {
    input.endOperation(operationId)
  }
}
