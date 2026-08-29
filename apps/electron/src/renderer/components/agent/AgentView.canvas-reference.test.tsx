import * as React from 'react'
import { describe, expect, test } from 'bun:test'
import type { CanvasNodeReference } from '@proma/shared'
import { createStore } from 'jotai'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  agentCanvasNodeReferencesAtomFamily,
} from '@/atoms/agent-atoms'
import {
  CanvasNodeReferenceChips,
  UserMessageContent,
} from '@/components/ai-elements/message'
import { shouldRenderUserMessageContent } from './SDKMessageRenderer'

/** Agent composer 与历史展示共同使用的完整引用快照。 */
const reference: CanvasNodeReference = {
  projectId: 'project-1',
  canvasId: 'canvas-1',
  nodeId: 'node-1',
  nodeType: 'document',
  nodeRevision: 3,
  title: '需求说明 v3',
}

describe('Agent Canvas 节点引用 composer', () => {
  test('Given 两个 Agent 会话 When 分别写入和移除引用 Then 状态按 session 隔离', () => {
    const store = createStore()
    store.set(agentCanvasNodeReferencesAtomFamily('session-a'), [reference])
    store.set(agentCanvasNodeReferencesAtomFamily('session-b'), [{
      ...reference,
      nodeId: 'node-b',
      title: '会话 B 节点',
    }])

    store.set(agentCanvasNodeReferencesAtomFamily('session-a'), [])

    expect(store.get(agentCanvasNodeReferencesAtomFamily('session-a'))).toEqual([])
    expect(store.get(agentCanvasNodeReferencesAtomFamily('session-b'))).toHaveLength(1)
    expect(store.get(agentCanvasNodeReferencesAtomFamily('session-b'))[0]?.title).toBe('会话 B 节点')
  })

  test('Given composer 引用 When 渲染可移除 chip Then 显示类型标题与友好画布名且不暴露 UUID', () => {
    const html = renderToStaticMarkup(
      <CanvasNodeReferenceChips
        references={[reference]}
        getCanvasTitle={() => '产品画布'}
        onRemove={() => undefined}
      />,
    )

    expect(html).toContain('文档')
    expect(html).toContain('需求说明 v3')
    expect(html).toContain('产品画布')
    expect(html).toContain('aria-label="移除需求说明 v3引用"')
    expect(html).not.toContain('canvas-1')
    expect(html).not.toContain('node-1')
  })

  test('Given 历史消息引用缺少画布 metadata When 渲染只读 chip Then 使用快照标题和通用画布名', () => {
    const html = renderToStaticMarkup(
      <UserMessageContent sdkUserMessage={{ _canvasNodeReferences: [reference] }}>
        继续完善
      </UserMessageContent>,
    )

    expect(html).toContain('需求说明 v3')
    expect(html).toContain('画布')
    expect(html).toContain('版本 3')
    expect(html).not.toContain('移除需求说明 v3引用')
  })

  test('Given 历史消息正文为空但引用非空 When 判断用户内容 Then 仍渲染引用 chip', () => {
    expect(shouldRenderUserMessageContent('', [reference])).toBe(true)
    expect(shouldRenderUserMessageContent('', [])).toBe(false)
  })
})
