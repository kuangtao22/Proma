import { describe, expect, test } from 'bun:test'
import { ReactFlowProvider } from '@xyflow/react'
import type { NodeProps } from '@xyflow/react'
import { renderToStaticMarkup } from 'react-dom/server'
import { CanvasAgentNode } from './CanvasAgentNode'
import type { CanvasAgentFlowNode, CanvasAgentStatus } from './CanvasAgentNode'

/** 渲染指定状态的 Agent 节点。 */
function renderNode(status: CanvasAgentStatus, selected = false, canExpand = false): string {
  const props = {
    id: 'agent-1',
    type: 'canvasAgent',
    data: {
      id: 'agent-1',
      title: '一个非常非常长且需要安全换行的 Agent 节点标题',
      agentSessionId: 'session-1',
      status,
      canExpand,
      onExpand: canExpand ? () => undefined : undefined,
    },
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
  return renderToStaticMarkup(
    <ReactFlowProvider>
      <CanvasAgentNode {...props} />
    </ReactFlowProvider>,
  )
}

describe('Canvas Agent 节点', () => {
  test('Given 三种本地状态 When 渲染 Then 显示明确状态且不显示消息数', () => {
    expect(renderNode('idle')).toContain('空闲')
    expect(renderNode('running')).toContain('运行中')
    expect(renderNode('unavailable')).toContain('会话不可用')
    expect(renderNode('idle')).not.toContain('消息')
  })

  test('Given 健康节点可扩展 When 渲染 Then 显示固定图标按钮且坏节点不显示', () => {
    const healthy = renderNode('idle', true, true)
    const unavailable = renderNode('unavailable', true, true)

    expect(healthy).toContain('aria-label="从此节点扩展"')
    expect(healthy).toContain('size-7')
    expect(unavailable).not.toContain('aria-label="从此节点扩展"')
  })

  test('Given 长标题与选中态 When 渲染 Then 固定尺寸、不溢出并提供可访问名称', () => {
    const html = renderNode('running', true)

    expect(html).toContain('aria-label="Agent：一个非常非常长且需要安全换行的 Agent 节点标题，运行中"')
    expect(html).toContain('w-[288px]')
    expect(html).toContain('h-[144px]')
    expect(html).toContain('break-words')
    expect(html).toContain('ring-2')
  })

  test('Given Agent 参与持久关系 When 渲染健康或坏节点 Then 固定输入输出端口始终存在', () => {
    for (const status of ['idle', 'unavailable'] satisfies CanvasAgentStatus[]) {
      const html = renderNode(status)

      expect(html).toContain('data-handleid="input"')
      expect(html).toContain('data-handleid="output"')
      expect(html).toMatch(/data-handleid="input"[^>]*class="[^"]*\btarget\b/u)
      expect(html).toMatch(/data-handleid="output"[^>]*class="[^"]*\bsource\b/u)
      expect(html).not.toContain('connectablestart')
      expect(html).not.toContain('connectableend')
    }
  })
})
