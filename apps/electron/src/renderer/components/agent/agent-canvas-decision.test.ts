import { describe, expect, test } from 'bun:test'
import type { CanvasOrchestrationRecord } from '@proma/shared'
import { createAgentCanvasDecisionSender } from './agent-canvas-decision'

/** 决策卡片使用不依赖真实会话的完整委托。 */
function record(): CanvasOrchestrationRecord {
  return { schemaVersion: 1, id: 'task-secret', revision: 3, projectId: 'project', canvasId: 'canvas', ownerSessionId: 'owner',
    request: { requestId: 'request', goal: '完成镜头设计', intent: 'design', constraints: [], referenceNodeIds: [], deliverables: [] },
    coordinatorNodeId: 'agent', coordinatorSessionId: 'coordinator', status: 'waiting', steps: [], summary: '', runStartedAt: 1,
    createdAt: 1, updatedAt: 3, report: { summary: '等待方向', nextStep: '用户选择', reportedAt: 3, basedOnRevision: 2, stale: false,
      decision: { id: 'decision-secret', question: '选择哪种方向？', options: [
        { id: 'minimal', label: '简约方向', impact: '复用场景' }, { id: 'rich', label: '丰富方向', impact: '增加设计' },
      ], recommendedOptionId: 'minimal', reason: '符合现有素材' } } }
}

/** 可人工控制完成时机的读取，用于复现双击和会话切换。 */
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(complete => { resolve = complete })
  return { promise, resolve }
}

describe('聊天画布决策发送边界', () => {
  test('Given 连续点击 When 最新记录仍匹配 Then 仅提交一次自然语言且不暴露内部身份', async () => {
    const initial = record()
    const read = deferred<CanvasOrchestrationRecord | null>()
    const sent: string[] = []
    const sender = createAgentCanvasDecisionSender({ getRecord: () => read.promise, isCurrent: () => true, isDisabled: () => false,
      send: async text => { sent.push(text); return true } })
    const first = sender.choose(initial, 'minimal', '宣传片')
    expect(await sender.choose(initial, 'rich', '宣传片')).toBe('busy')
    read.resolve(initial)
    expect(await first).toBe('sent')
    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain('宣传片')
    expect(sent[0]).toContain('选择哪种方向？')
    expect(sent[0]).toContain('简约方向')
    expect(sent[0]).not.toContain('secret')
    expect(sender.hasSubmitted(initial)).toBe(true)
    expect(await sender.choose(initial, 'minimal', '宣传片')).toBe('busy')
  })

  test.each(['null', 'owner', 'project', 'canvas', 'task', 'question', 'answered', 'unmounted'] as const)(
    'Given 原问题可见 When 复读时%s变化 Then 不发送旧答案', async scenario => {
      const initial = record()
      const latest = structuredClone(initial)
      const read = deferred<CanvasOrchestrationRecord | null>()
      let current = true
      let sends = 0
      if (scenario === 'owner') latest.ownerSessionId = 'other'
      if (scenario === 'project') latest.projectId = 'other'
      if (scenario === 'canvas') latest.canvasId = 'other'
      if (scenario === 'task') latest.id = 'other'
      if (scenario === 'question') latest.report!.decision!.question = '新的问题'
      if (scenario === 'answered') latest.followUps = [{ id: 'answered', decisionId: 'decision-secret', instruction: '已回答', status: 'pending', createdAt: 3 }]
      const sender = createAgentCanvasDecisionSender({ getRecord: () => read.promise, isCurrent: () => current, isDisabled: () => false,
        send: async () => { sends++; return true } })
      const pending = sender.choose(initial, 'minimal', '宣传片')
      if (scenario === 'unmounted') current = false
      read.resolve(scenario === 'null' ? null : latest)
      expect(await pending).toBe('stale')
      expect(sends).toBe(0)
    },
  )

  test('Given 读取期间聊天开始运行 When 复读完成 Then 不插入或打断正在处理的消息', async () => {
    const initial = record()
    const read = deferred<CanvasOrchestrationRecord | null>()
    let disabled = false
    let sends = 0
    const sender = createAgentCanvasDecisionSender({ getRecord: () => read.promise, isCurrent: () => true, isDisabled: () => disabled,
      send: async () => { sends++; return true } })
    const pending = sender.choose(initial, 'minimal', '宣传片')
    disabled = true
    read.resolve(initial)
    expect(await pending).toBe('busy')
    expect(sends).toBe(0)
  })

  test('Given 报告陈旧但问题未回答 When 用户选择 Then 仍可回答该问题', async () => {
    const initial = record()
    initial.report!.stale = true
    const sender = createAgentCanvasDecisionSender({ getRecord: async () => initial, isCurrent: () => true, isDisabled: () => false,
      send: async () => true })
    expect(await sender.choose(initial, 'minimal', '宣传片')).toBe('sent')
  })

  test('Given 提交失败或暂不可发 When 用户重试 Then 释放发送锁并仅在接管成功后标为已发送', async () => {
    const initial = record()
    let attempt = 0
    const sender = createAgentCanvasDecisionSender({ getRecord: async () => initial, isCurrent: () => true, isDisabled: () => false,
      send: async () => { attempt++; if (attempt === 1) throw new Error('提交失败'); return attempt > 2 } })
    await expect(sender.choose(initial, 'minimal', '宣传片')).rejects.toThrow('提交失败')
    expect(sender.hasSubmitted(initial)).toBe(false)
    expect(await sender.choose(initial, 'minimal', '宣传片')).toBe('unavailable')
    expect(sender.hasSubmitted(initial)).toBe(false)
    expect(await sender.choose(initial, 'minimal', '宣传片')).toBe('sent')
  })

  test('Given 委托目标是长篇需求 When 选择关键问题 Then 完整保留问题与选择且答复仍在校正字数上限内', async () => {
    const initial = record()
    initial.request.goal = '长篇需求'.repeat(8000)
    initial.report!.decision!.question = '完整问题'.repeat(250)
    let message = ''
    const sender = createAgentCanvasDecisionSender({ getRecord: async () => initial, isCurrent: () => true, isDisabled: () => false,
      send: async text => { message = text; return true } })
    expect(await sender.choose(initial, 'minimal', '画布'.repeat(1000))).toBe('sent')
    expect(message.length).toBeLessThanOrEqual(4096)
    expect(message).toContain(initial.report!.decision!.question)
    expect(message).toContain('简约方向')
  })
})
