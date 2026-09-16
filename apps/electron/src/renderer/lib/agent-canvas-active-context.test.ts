import { describe, expect, test } from 'bun:test'
import { createStore } from 'jotai'
import { agentDiffPanelTabAtom, agentSidePanelOpenAtomFamily, agentSidePanelSplitMapAtom } from '@/atoms/agent-atoms'
import { readVisibleAgentCanvasId, synchronizeVisibleAgentCanvas } from './agent-canvas-active-context'

describe('发送前同步可见画布', () => {
  test('Given 当前会话打开画布 When 读取 Then 采用焦点画布且关闭面板不回退旧默认', () => {
    /** 测试独立Jotai容器，不读取实际会话。 */
    const store = createStore()
    store.set(agentSidePanelOpenAtomFamily('session'), true)
    store.set(agentDiffPanelTabAtom, new Map([['session', 'canvas:visible'], ['other', 'canvas:other']]))
    expect(readVisibleAgentCanvasId(store, 'session')).toBe('visible')
    store.set(agentSidePanelSplitMapAtom, new Map([['session', { leftTab: 'canvas:left', rightTab: 'canvas:right', focusedPane: 'right', ratio: 0.5 }]]))
    expect(readVisibleAgentCanvasId(store, 'session')).toBe('right')
    store.set(agentSidePanelOpenAtomFamily('session'), false)
    expect(readVisibleAgentCanvasId(store, 'session')).toBeNull()
  })

  test('Given 更新在途时切换画布 When 同步 Then 等待最新画布写入后才允许发送', async () => {
    /** 可控回执用于精确复现异步切换，不依赖时间等待。 */
    let release!: () => void
    let current: string | null = 'old'
    const calls: string[] = []
    let finished = false
    const pending = synchronizeVisibleAgentCanvas(() => current, async (canvasId) => {
      calls.push(canvasId)
      if (canvasId === 'old') await new Promise<void>(resolve => { release = resolve })
      return { lastActiveCanvasId: canvasId }
    }).then(() => { finished = true })
    expect(finished).toBe(false)
    current = 'visible'
    release()
    await pending
    expect(calls).toEqual(['old', 'visible'])
    expect(finished).toBe(true)
  })

  test('Given 活动画布更新失败 When 发送前同步 Then 拒绝继续而不静默使用旧画布', async () => {
    await expect(synchronizeVisibleAgentCanvas(() => 'visible', async () => { throw new Error('rejected') })).rejects.toThrow('rejected')
  })

  test('Given 更新已被其他请求替代 When 回执指向另一画布 Then 必须重新同步目标后才允许发送', async () => {
    /** 首次回执来自另一在途选择，第二次才确认实际可见画布。 */
    let attempts = 0
    await synchronizeVisibleAgentCanvas(() => 'visible', async () => {
      attempts += 1
      return { lastActiveCanvasId: attempts === 1 ? 'other' : 'visible' }
    })
    expect(attempts).toBe(2)
    await expect(synchronizeVisibleAgentCanvas(() => 'visible', async () => ({ lastActiveCanvasId: 'other' })))
      .rejects.toThrow('画布仍在切换')
  })

  test('Given 非画布焦点或连续切换 When 同步 Then 不写默认且有界终止', async () => {
    /** 收集实际更新目标，空焦点不产生写入。 */
    const calls: string[] = []
    await synchronizeVisibleAgentCanvas(() => null, async id => { calls.push(id); return { lastActiveCanvasId: id } })
    expect(calls).toEqual([])
    let current = 'a'
    await expect(synchronizeVisibleAgentCanvas(() => current, async id => {
      calls.push(id)
      current = id === 'a' ? 'b' : 'a'
      return { lastActiveCanvasId: id }
    })).rejects.toThrow('画布仍在切换')
    expect(calls).toHaveLength(3)
  })
})
