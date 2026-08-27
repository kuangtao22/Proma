import * as React from 'react'
import type { Node, NodeProps } from '@xyflow/react'
import { CanvasNodeCard } from './CanvasNodeCard'
import type { CanvasNodeCardData, CanvasNodeFlowData } from './CanvasNodeCard'

/** Agent 节点当前可显示的本地运行状态。 */
export type CanvasAgentStatus = 'idle' | 'running' | 'unavailable'

/** Agent 节点只公开身份、标题和本地状态，不包含任何消息数据。 */
export interface CanvasAgentNodeData extends CanvasNodeCardData {
  kind: 'agent'
  agentSessionId: string
  status: CanvasAgentStatus
}

/** Agent 展示数据与 XYFlow 索引签名要求之间的适配类型。 */
export type CanvasAgentFlowData = CanvasAgentNodeData & CanvasNodeFlowData
/** 原生 Canvas 的 Agent XYFlow 节点类型。 */
export type CanvasAgentFlowNode = Node<CanvasAgentFlowData, 'canvasAgent'>

/** Agent 状态对应的简洁中文标签。 */
export const AGENT_STATUS_LABELS: Record<CanvasAgentStatus, string> = {
  idle: '空闲',
  running: '运行中',
  unavailable: '会话不可用',
}

/**
 * 渲染固定尺寸的原生 Canvas Agent 卡片。
 * @param props XYFlow 注入的 Agent 数据与选中态。
 * @returns 不读取会话消息的通用折叠节点。
 */
export function CanvasAgentNode({ data, selected }: NodeProps<CanvasAgentFlowNode>): React.ReactElement {
  /** 故障 Agent 即使收到迟到回调也不得继续创建下游节点。 */
  const onCreateChild = data.status === 'unavailable' ? undefined : data.onCreateChild
  return <CanvasNodeCard {...data} onCreateChild={onCreateChild} selected={selected} />
}
