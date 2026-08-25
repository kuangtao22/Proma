import { describe, expect, test } from 'bun:test'
import type { NodeProps } from '@xyflow/react'
import { renderToStaticMarkup } from 'react-dom/server'
import { CanvasAgentNode } from './CanvasAgentNode'
import type { CanvasAgentFlowNode, CanvasAgentStatus } from './CanvasAgentNode'

/** 渲染指定状态的 Agent 节点。 */
function renderNode(status: CanvasAgentStatus, selected = false): string {
  const props = {
    id: 'agent-1',
    type: 'canvasAgent',
    data: { id: 'agent-1', title: '一个非常非常长且需要安全换行的 Agent 节点标题', agentSessionId: 'session-1', status },
    selected,
    dragging: false,
    draggable: true,
    selectable: true,
    deletable: false,
    isConnectable: false,
    positionAbsoluteX: 0,
    positionAbsoluteY: 0,
    zIndex: 0,
    width: 288,
    height: 144,
  } satisfies NodeProps<CanvasAgentFlowNode>
  return renderToStaticMarkup(<CanvasAgentNode {...props} />)
}

describe('Canvas Agent 节点', () => {
  test('Given 四种本地状态 When 渲染 Then 显示明确状态且不显示消息数', () => {
    expect(renderNode('idle')).toContain('空闲')
    expect(renderNode('running')).toContain('运行中')
    expect(renderNode('error')).toContain('异常')
    expect(renderNode('missing')).toContain('会话缺失')
    expect(renderNode('idle')).not.toContain('消息')
  })

  test('Given 长标题与选中态 When 渲染 Then 固定尺寸、不溢出并提供可访问名称', () => {
    const html = renderNode('running', true)

    expect(html).toContain('aria-label="Agent：一个非常非常长且需要安全换行的 Agent 节点标题，运行中"')
    expect(html).toContain('w-[288px]')
    expect(html).toContain('h-[144px]')
    expect(html).toContain('break-words')
    expect(html).toContain('ring-2')
  })
})
