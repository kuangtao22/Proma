import { describe, expect, test } from 'bun:test'
import type { AgentCanvasBinding } from '@proma/shared'
import type { CanvasToolRunContext } from './canvas-tool-provider'
import { captureCanvasToolInitialContext } from './canvas-tool-initial-context'

/** 只提供上下文选择所需的已授权内存关联。 */
const context: CanvasToolRunContext = { projectId: 'project', sessionId: 'chat', runStartedAt: 1, explicitReferences: [], permissionCeiling: 'execute' }
const binding: AgentCanvasBinding = { projectId: 'project', sessionId: 'chat', linkedCanvasIds: ['a', 'b'], lastActiveCanvasId: 'a', defaultCanvasId: 'b', updatedAt: 1 }
const access = { authorizeRead: () => {}, getBinding: () => binding, requireLinkedCanvas: () => binding }

describe('运行准备固定画布目标', () => {
  test('Given 已授权活动画布 When 准备运行后用户切页 Then 原上下文目标保持不变', () => {
    const prepared = captureCanvasToolInitialContext(access, context)
    expect(prepared.initialCanvasId).toBe('a')
    expect(captureCanvasToolInitialContext({ ...access, getBinding: () => ({ ...binding, lastActiveCanvasId: 'b' }) }, prepared).initialCanvasId).toBe('a')
  })
  test('Given 单图引用或多图引用 When 准备运行 Then 明确引用优先且多图不猜测', () => {
    const reference = { projectId: 'project', canvasId: 'b', nodeId: 'node', nodeType: 'document' as const, nodeRevision: 0, title: '文档' }
    expect(captureCanvasToolInitialContext(access, { ...context, explicitReferences: [reference] }).initialCanvasId).toBe('b')
    expect(captureCanvasToolInitialContext(access, { ...context, explicitReferences: [reference, { ...reference, canvasId: 'a' }] }).initialCanvasId).toBeNull()
  })
  test('Given 授权或节点所属画布失效 When 准备普通聊天 Then 不猜另一个目标也不中断聊天', () => {
    expect(captureCanvasToolInitialContext({ ...access, authorizeRead: () => { throw new Error('denied') } }, context).initialCanvasId).toBeNull()
    expect(captureCanvasToolInitialContext({ ...access, requireLinkedCanvas: () => { throw new Error('archived') } }, context).initialCanvasId).toBeNull()
    expect(captureCanvasToolInitialContext({ ...access, getBinding: () => ({ ...binding, lastActiveCanvasId: 'unlinked' }) }, context).initialCanvasId).toBeNull()
  })
})
