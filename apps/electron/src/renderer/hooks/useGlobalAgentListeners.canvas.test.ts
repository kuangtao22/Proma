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
    expect(source).toContain('if (isCanvasAgentCompletion) {')
  })

  test('Given Canvas 完成通知 When 用户点击 Then 返回原 Canvas 与节点对话且不打开 Agent tab', () => {
    const source = readFileSync(join(import.meta.dir, 'useGlobalAgentListeners.ts'), 'utf8')
    const start = source.indexOf('const makeNavigateToCanvasAgent')
    const end = source.indexOf('\n    /**', start + 1)
    const body = source.slice(start, end)
    expect(body).toContain('store.set(activeCanvasSelectionAtom')
    expect(body).toContain("store.set(activeViewAtom, 'design')")
    expect(body).toContain('conversationNodeId: owner.nodeId')
    expect(body).toContain('selectedNodeId: owner.nodeId')
    expect(body).not.toContain('openTab(')
  })

  test('Given renderer 重载且 bootstrap 未完成 When 未知流与标题先到 Then 暂存并在 owner 恢复后重放一次', () => {
    const source = readFileSync(join(import.meta.dir, 'useGlobalAgentListeners.ts'), 'utf8')
    expect(source).toContain('window.electronAPI.listActiveCanvasAgentRuns()')
    expect(source).toContain('canvasAgentBootstrapGate.complete()')
    expect(source).toContain('canvasAgentBootstrapGate.fail()')
    expect(source).toContain('canvasAgentBootstrapGate.handle')
  })

  test('Given renderer 重载且 completion 早到 When bootstrap deferred 或失败 Then completion 也通过有界 gate', () => {
    /** completion 必须与 stream/title 共用 bootstrap 判定，禁止直接走普通通知。 */
    const source = readFileSync(join(import.meta.dir, 'useGlobalAgentListeners.ts'), 'utf8')
    expect(source).toContain("| { type: 'complete'; sessionId: string; value: AgentStreamCompletePayload }")
    expect(source).toContain("allowUnknownAfterReady: (event) => event.type !== 'complete'")
    expect(source).toContain("allowInternalInvalid: (event) => event.type === 'complete'")
    expect(source).toContain("isTerminalEvent: (event) => event.type === 'complete'")
    expect(source).toContain("type: 'complete', sessionId: data.sessionId, value: data")
  })

  test('Given completion payload 明确损坏 When 本地已有旧 owner Then 失效缓存且禁止 fallback', () => {
    const source = readFileSync(join(import.meta.dir, 'useGlobalAgentListeners.ts'), 'utf8')
    expect(source).toContain("completionRoute.kind === 'internal-invalid'")
    expect(source).toContain("type: 'invalidated'")
    expect(source).not.toContain("completionRoute.kind === 'canvas'\n          ? completionRoute.owner\n          : store.get(canvasAgentOwnersAtom).get(data.sessionId)")
  })

  test('Given internal-invalid soft completion When 处理终态 Then 保留 active 阻断直到 hard terminal', () => {
    /** soft completion 必须把终态语义显式传入 lifecycle，不能无条件 terminalize。 */
    const source = readFileSync(join(import.meta.dir, 'useGlobalAgentListeners.ts'), 'utf8')
    expect(source).toContain("type: 'invalidated', sessionId: data.sessionId, terminal: !backgroundTasksPending")
  })
})
