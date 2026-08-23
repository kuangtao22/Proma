import { describe, expect, test } from 'bun:test'
import type { PreparedDesignAssetMention } from '@proma/shared'
import { sendPreparedDesignAssetToSession } from './design-session-actions'

describe('Design 会话发送动作', () => {
  test('Given 已准备好的设计素材 When 发送到会话 Then 先打开会话再填入引用并切回对话且不自动发送', async () => {
    /** 记录用户可观察的 composer-only 调用顺序。 */
    const calls: string[] = []
    /** 主进程准备好的项目级文件引用。 */
    const prepared: PreparedDesignAssetMention = {
      sessionId: 'session-1', path: '/project/.proma/design/assets/a.png',
      name: 'a.png', isDirectory: false, scope: 'project',
    }

    await sendPreparedDesignAssetToSession(prepared, {
      openSession: async (sessionId) => { calls.push(`open:${sessionId}`) },
      dispatchMention: (items) => { calls.push(`mention:${items[0]?.path}`) },
      setActiveView: (view) => { calls.push(`view:${view}`) },
    })

    expect(calls).toEqual([
      'open:session-1',
      'mention:/project/.proma/design/assets/a.png',
      'view:conversations',
    ])
  })
})
