import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

describe('全局 Agent listener 的 Canvas 隔离', () => {
  test('Given Canvas owner When 流式事件到达 Then 跳过未知普通会话刷新', () => {
    const source = readFileSync(join(import.meta.dir, 'useGlobalAgentListeners.ts'), 'utf8')
    expect(source).toContain('const isCanvasAgent = store.get(canvasAgentOwnersAtom).has(sessionId)')
    expect(source).toContain('if (!isCanvasAgent && !knownSessions.some((s) => s.id === sessionId))')
  })

  test('Given Canvas 完成 When 处理终态 Then 不 upsert 普通列表或写普通未读并保留 live', () => {
    const source = readFileSync(join(import.meta.dir, 'useGlobalAgentListeners.ts'), 'utf8')
    expect(source).toContain('if (!isCanvasAgentCompletion && data.session && !backgroundTasksPending)')
    expect(source).toContain('else if (!isCanvasAgentCompletion) notifyAgentCompletion')
    expect(source).toContain('if (!isCanvasAgentCompletion && completionMarkers.markUnviewedCompleted')
    expect(source).toContain('if (isCanvasAgentCompletion) return')
  })

  test('Given Canvas 完成通知 When 用户点击 Then 返回原 Canvas 与节点对话且不打开 Agent tab', () => {
    const source = readFileSync(join(import.meta.dir, 'useGlobalAgentListeners.ts'), 'utf8')
    const start = source.indexOf('const makeNavigateToCanvasAgent')
    const end = source.indexOf('\n    /**', start + 1)
    const body = source.slice(start, end)
    expect(body).toContain('store.set(activeCanvasSelectionAtom')
    expect(body).toContain('conversationNodeId: owner.nodeId')
    expect(body).toContain('selectedNodeId: owner.nodeId')
    expect(body).not.toContain('openTab(')
  })
})
