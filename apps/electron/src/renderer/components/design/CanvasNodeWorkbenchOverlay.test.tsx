import { describe, expect, test } from 'bun:test'
import type { CanvasNode } from '@proma/shared'
import { renderToStaticMarkup } from 'react-dom/server'
import { CanvasNodeWorkbenchOverlay } from './CanvasNodeWorkbenchOverlay'

/** 创建四类最小节点，验证工作台壳不依赖正文或执行结果。 */
function createNode(kind: CanvasNode['kind']): CanvasNode {
  const base = { id: `node-${kind}`, title: `${kind} 节点`, position: { x: 0, y: 0 } }
  if (kind === 'agent') return { ...base, kind, agentSessionId: 'session-1' }
  if (kind === 'image') return { ...base, kind, imageModuleId: 'image-module-1' }
  if (kind === 'document') return { ...base, kind, documentId: 'document-1', contentRevision: 0 }
  return { ...base, kind, prototypeId: 'prototype-1', contentRevision: 0 }
}

describe('Canvas 节点工作台覆盖层', () => {
  test.each([
    ['agent', 'Agent'],
    ['image', '生图'],
    ['document', '文档'],
    ['webview', '原型'],
  ] as const)('Given %s 节点 When 渲染基础工作台 Then 使用稳定中文标签与锚定尺寸', (kind, label) => {
    const html = renderToStaticMarkup(
      <CanvasNodeWorkbenchOverlay
        node={createNode(kind)}
        dirty={false}
        onDirtyChange={() => undefined}
        onClose={() => undefined}
      />,
    )

    expect(html).toContain(`aria-label="${label}工作台"`)
    expect(html).toContain(`aria-label="收起${label}工作台"`)
    expect(html).toContain('top-[calc(100%+8px)]')
    expect(html).toContain('max-w-[720px]')
    expect(html).toContain('max-h-[620px]')
  })

  test('Given Agent 工作台有对话内容 When 渲染 Then 只使用传入内容入口且不显示非 Agent 空状态', () => {
    const html = renderToStaticMarkup(
      <CanvasNodeWorkbenchOverlay
        node={createNode('agent')}
        dirty={false}
        onDirtyChange={() => undefined}
        onClose={() => undefined}
      >
        <div data-testid="agent-conversation">对话内容</div>
      </CanvasNodeWorkbenchOverlay>,
    )

    expect(html).toContain('data-testid="agent-conversation"')
    expect(html).not.toContain('下一步：')
  })
})
