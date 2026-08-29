import { describe, expect, test } from 'bun:test'
import type { AgentSendInput } from '@proma/shared'
import { CanvasReferenceInvalidError } from './design/canvas-node-reference-resolver'
import {
  prepareAgentCanvasMessageForSend,
  runAgentMessageInvoke,
} from './agent-canvas-message-preparation'

/** 构造普通发送输入。 */
function createInput(): AgentSendInput {
  return { sessionId: 'session-1', userMessage: '继续', channelId: 'channel-1' }
}

describe('Agent Canvas 消息接管前置阶段', () => {
  test('Given 普通无引用消息 When prepare Then resolver 零调用且输入原样返回', () => {
    let calls = 0
    const input = createInput()
    const prepared = prepareAgentCanvasMessageForSend(input, {}, {
      resolveForSend: () => { calls += 1; throw new Error('不应调用') },
    })

    expect(calls).toBe(0)
    expect(prepared.input).toBe(input)
  })

  test.each([undefined, null, { length: 0 }, ''])('Given 引用字段为畸形值 %p When prepare Then resolver 零调用且稳定拒绝', (canvasNodeReferences) => {
    let calls = 0
    const input = { ...createInput(), canvasNodeReferences } as unknown as AgentSendInput

    expect(() => prepareAgentCanvasMessageForSend(input, {}, {
      resolveForSend: () => { calls += 1; throw new Error('不应调用') },
    })).toThrow(CanvasReferenceInvalidError)
    expect(calls).toBe(0)
  })

  test('Given 引用字段为合法空数组 When prepare Then resolver 零调用并保持无引用', () => {
    let calls = 0
    const input = { ...createInput(), canvasNodeReferences: [] }
    const prepared = prepareAgentCanvasMessageForSend(input, {}, {
      resolveForSend: () => { calls += 1; throw new Error('不应调用') },
    })

    expect(calls).toBe(0)
    expect(prepared).toEqual({ input, extensions: {}, references: undefined })
  })

  test('Given 有效引用消息 When prepare Then 只解析一次并固化权威输入与 prompt', () => {
    let calls = 0
    const prepared = prepareAgentCanvasMessageForSend({
      ...createInput(),
      canvasNodeReferences: [{
        projectId: 'project-1', canvasId: 'canvas-1', nodeId: 'node-1',
        nodeType: 'document', nodeRevision: 1, title: '旧标题',
      }],
    }, {}, {
      resolveForSend: () => {
        calls += 1
        return {
          references: [{
            projectId: 'project-1', canvasId: 'canvas-1', nodeId: 'node-1',
            nodeType: 'document', nodeRevision: 2, title: '权威标题',
          }],
          changedNodeIds: ['node-1'],
          promptSummary: '{"references":[]}',
        }
      },
    })

    expect(calls).toBe(1)
    expect(prepared.input.canvasNodeReferences?.[0]?.title).toBe('权威标题')
    expect(prepared.extensions.systemPromptAppend).toContain('<canvas_workspace>')
  })

  test('Given 内部解析故障 When IPC 接管 Then 记录 cause 且只返回稳定公开错误', async () => {
    const cause = new Error('/private/canvas.json')
    const logs: unknown[] = []
    const result = await runAgentMessageInvoke(async () => {
      throw new CanvasReferenceInvalidError(cause)
    }, (error) => { logs.push(error) })

    expect(logs).toEqual([cause])
    expect(result).toEqual({
      ok: false,
      error: { code: 'CANVAS_REFERENCE_INVALID', message: '画布节点引用已失效，请重新选择后发送。' },
    })
    expect(JSON.stringify(result)).not.toContain('/private')
  })
})
