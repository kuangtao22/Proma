import * as React from 'react'
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
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
  test('Given 画布产物已由 Agent 语义工具驱动 When 渲染普通 Agent Then 不保留 Renderer 关键词分流弹窗', () => {
    const source = readFileSync(new URL('./AgentView.tsx', import.meta.url), 'utf8')

    expect(source).not.toContain('shouldOfferDesignHandoff')
    expect(source).not.toContain('pendingDesignHandoff')
    expect(source).not.toContain('handleOpenDesignHandoff')
    expect(source).not.toContain('LEGACY_DESIGN_CANVAS_ID')
  })

  test('Given 历史用户消息带 rev3 引用且错误 UUID 缺失 When 点击重试 Then 正文与 exact 引用从同一 SDK 消息透传', () => {
    const source = readFileSync(new URL('./AgentView.tsx', import.meta.url), 'utf8')
    const retryStart = source.indexOf('const handleRetry = React.useCallback(')
    const retryEnd = source.indexOf('\n  /**', retryStart + 1)
    const retryBody = source.slice(retryStart, retryEnd)

    expect(retryBody).toContain('lastUserSDKMessage')
    expect(retryBody).toContain('lastUserSDKMessage._canvasNodeReferences')
    expect(retryBody).toContain('canvasNodeReferences: [...lastUserSDKMessage._canvasNodeReferences]')
    expect(retryBody).toContain("canvasNodeReferenceMode: 'exact'")
  })

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

  test('Given 普通发送携带 Canvas 引用 When 主进程接管或拒绝 Then 立即清理 composer 且失败时完整恢复', () => {
    const source = readFileSync(new URL('./AgentView.tsx', import.meta.url), 'utf8')
    const sendCall = 'window.electronAPI.sendAgentMessage(input)'
    const sendStart = source.indexOf('window.electronAPI.sendAgentMessage(input)')
    const sendEnd = source.indexOf('\n  }, [', sendStart)
    const optimisticStart = source.lastIndexOf(
      'appendOptimisticPersistedMessage(tempUserSDKMsg)',
      sendStart,
    )
    const sendPrefix = source.slice(optimisticStart, sendStart)
    const sendBody = source.slice(sendStart, sendEnd)
    /** 引用不能等待整轮 Agent 完成才清理，否则运行期间继续发送会重复引用同一节点。 */
    expect(sendPrefix).toContain('clearSentCanvasNodeReferences(canvasNodeReferencesSnapshot)')
    expect(source.indexOf(sendCall, optimisticStart)).toBe(sendStart)
    expect(sendBody).toContain('rollbackOptimisticPersistedMessage(tempUserSDKMsg)')
    expect(sendBody).toContain('restoreMissingCanvasNodeReferences(current, canvasNodeReferencesSnapshot)')
    expect(sendBody).toContain("toast.error('消息发送失败'")
  })

  test('Given composer 只有 Canvas 引用 When 计算发送按钮状态 Then 引用本身属于可发送内容', () => {
    const source = readFileSync(new URL('./AgentView.tsx', import.meta.url), 'utf8')
    const canSendStart = source.indexOf('const canSend =')
    const canSendEnd = source.indexOf('\n\n', canSendStart)
    const canSendBody = source.slice(canSendStart, canSendEnd)

    expect(canSendBody).toContain('canvasNodeReferences.length > 0')
  })
})
