import { describe, expect, test } from 'bun:test'
import type { PreparedDesignAssetMention } from '@proma/shared'
import { deliverPendingMentionsToComposer, sendPreparedDesignAssetToSession } from './design-session-actions'

describe('Design 会话发送动作', () => {
  test('Given 已准备好的设计素材 When 发送到会话 Then 先按目标会话入队再导航且不自动发送', async () => {
    /** 记录用户可观察的 composer-only 调用顺序。 */
    const calls: string[] = []
    /** 主进程准备好的项目级文件引用。 */
    const prepared: PreparedDesignAssetMention = {
      sessionId: 'session-1', path: '/project/.proma/design/assets/a.png',
      name: 'a.png', isDirectory: false, scope: 'project',
    }

    await sendPreparedDesignAssetToSession(prepared, {
      openSession: async (sessionId) => { calls.push(`open:${sessionId}`) },
      enqueueMention: (sessionId, items) => { calls.push(`enqueue:${sessionId}:${items[0]?.path}`) },
      setActiveView: (view) => { calls.push(`view:${view}`) },
    })

    expect(calls).toEqual([
      'enqueue:session-1:/project/.proma/design/assets/a.png',
      'open:session-1',
      'view:conversations',
    ])
  })

  test('Given composer 插入失败 When 尝试消费队列 Then 不确认队列也不提示成功', () => {
    /** 记录消费阶段发生的副作用。 */
    const calls: string[] = []
    /** 等待插入 composer 的文件引用。 */
    const items = [{
      path: '/project/a.png', name: 'a.png', isDirectory: false, scope: 'project' as const,
    }]

    const delivered = deliverPendingMentionsToComposer(items, {
      insertMentions: () => false,
      acknowledge: () => { calls.push('ack'); return true },
      notifySuccess: () => { calls.push('toast') },
    })

    expect(delivered).toBe(false)
    expect(calls).toEqual([])
  })

  test('Given composer 插入成功 When 消费队列 Then 确认后才提示成功', () => {
    /** 记录插入、确认和用户提示的严格顺序。 */
    const calls: string[] = []
    /** 等待插入 composer 的文件引用。 */
    const items = [{
      path: '/project/a.png', name: 'a.png', isDirectory: false, scope: 'project' as const,
    }]

    const delivered = deliverPendingMentionsToComposer(items, {
      insertMentions: () => { calls.push('insert'); return true },
      acknowledge: () => { calls.push('ack'); return true },
      notifySuccess: () => { calls.push('toast') },
    })

    expect(delivered).toBe(true)
    expect(calls).toEqual(['insert', 'ack', 'toast'])
  })
})
