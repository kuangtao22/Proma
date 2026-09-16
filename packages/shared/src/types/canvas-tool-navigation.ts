/** Agent 工具确认画布写入后的界面定位动作。 */
export type CanvasToolNavigationAction = 'create' | 'update' | 'delete' | 'batch' | 'orchestration'

/**
 * 可信画布修改回执只携带定位所需身份，不复制节点正文或媒体内容。
 * revision 始终表示画布图版本；正文和媒体配置版本继续使用各自原字段。
 */
export interface CanvasToolNavigationResult {
  status: 'changed'
  projectId: string
  canvasId: string
  /** 提交后仍存在、可以在画布中定位的节点。 */
  nodeIds: string[]
  /** 本次明确删除、只能在变更摘要中展示的节点。 */
  deletedNodeIds: string[]
  action: CanvasToolNavigationAction
  revision?: number
  operationId?: string
  sourceToolCallId?: string
  /** 编排子 Agent 的修改归属；只能由 Host 按持久编排记录签发。 */
  ownerSessionId?: string
}
