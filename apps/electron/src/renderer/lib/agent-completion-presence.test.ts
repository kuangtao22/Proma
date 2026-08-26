import { describe, expect, mock, test } from 'bun:test'
import {
  getAgentCompletionMarkers,
  isAgentSessionActiveForCompletion,
  notifyAgentCompletionWarning,
  shouldNotifyAgentCompletion,
} from './agent-completion-presence'
import type { TabItem } from '@/atoms/tab-atoms'

describe('Agent 完成归属判断', () => {
  test('Given 当前激活的是同一个 Agent Tab When Agent 完成 Then 视为用户仍在查看', () => {
    const tabs: TabItem[] = [
      { id: '__scratch-pad__', type: 'scratch', sessionId: '__scratch-pad__', title: '草稿' },
      { id: 'agent-1', type: 'agent', sessionId: 'agent-1', title: '当前任务' },
    ]
    const input = {
      tabs,
      activeTabId: 'agent-1',
      currentAgentSessionId: 'agent-1',
      sessionId: 'agent-1',
      documentHasFocus: true,
    }

    expect(isAgentSessionActiveForCompletion(input)).toBe(true)
    expect(getAgentCompletionMarkers(input)).toEqual({
      markUnviewedCompleted: false,
    })
  })

  test('Given 当前激活的是草稿页 When 旧 Agent 完成 Then 视为后台完成', () => {
    const tabs: TabItem[] = [
      { id: '__scratch-pad__', type: 'scratch', sessionId: '__scratch-pad__', title: '草稿' },
      { id: 'agent-1', type: 'agent', sessionId: 'agent-1', title: '后台任务' },
    ]
    const input = {
      tabs,
      activeTabId: '__scratch-pad__',
      currentAgentSessionId: 'agent-1',
      sessionId: 'agent-1',
      documentHasFocus: true,
    }

    expect(isAgentSessionActiveForCompletion(input)).toBe(false)
    expect(getAgentCompletionMarkers(input)).toEqual({
      markUnviewedCompleted: true,
    })
  })

  test('Given Tab 状态尚未恢复但 currentAgentSessionId 匹配 When Agent 完成 Then 使用兼容判断', () => {
    expect(isAgentSessionActiveForCompletion({
      tabs: [],
      activeTabId: null,
      currentAgentSessionId: 'agent-1',
      sessionId: 'agent-1',
      documentHasFocus: true,
    })).toBe(true)
  })

  test('Given 当前激活的就是该 Agent Tab 但窗口在后台 When Agent 完成 Then 视为未查看并入账角标', () => {
    const tabs: TabItem[] = [
      { id: '__scratch-pad__', type: 'scratch', sessionId: '__scratch-pad__', title: '草稿' },
      { id: 'agent-1', type: 'agent', sessionId: 'agent-1', title: '当前任务' },
    ]
    const input = {
      tabs,
      activeTabId: 'agent-1',
      currentAgentSessionId: 'agent-1',
      sessionId: 'agent-1',
      documentHasFocus: false,
    }

    expect(isAgentSessionActiveForCompletion(input)).toBe(false)
    expect(getAgentCompletionMarkers(input)).toEqual({
      markUnviewedCompleted: true,
    })
  })

  test('Given Canvas Agent 完成 When 计算普通提醒和未读 Then 不进入普通 Agent 表面', () => {
    const session = {
      sourceCanvasProjectId: 'project-1',
      sourceCanvasId: 'canvas-1',
      sourceCanvasNodeId: 'node-1',
    }
    expect(shouldNotifyAgentCompletion({
      completion: { sessionId: 'session-1', stoppedByUser: false },
      session,
    })).toBe(false)
    expect(getAgentCompletionMarkers({
      tabs: [],
      activeTabId: null,
      currentAgentSessionId: null,
      sessionId: 'session-1',
      session,
      documentHasFocus: false,
    })).toEqual({ markUnviewedCompleted: false })
  })

  test.each(['canvas', 'internal-invalid'] as const)(
    'Given %s error completion When 分派警告 Then 不调用普通 toast',
    (routeKind) => {
      /** 模拟真实 listener 传入的 toast.warning 分派函数。 */
      const warn = mock((_message: string): void => undefined)
      notifyAgentCompletionWarning(routeKind, {
        sessionId: 'session-1', resultSubtype: 'error_during_execution', resultErrors: ['模型失败'],
      }, warn)
      expect(warn).toHaveBeenCalledTimes(0)
    },
  )

  test('Given 普通 Agent error completion When 分派警告 Then 调用一次具体错误 toast', () => {
    /** 模拟真实 listener 传入的 toast.warning 分派函数。 */
    const warn = mock((_message: string): void => undefined)
    notifyAgentCompletionWarning('agent', {
      sessionId: 'session-1', resultSubtype: 'error_during_execution', resultErrors: ['模型失败'],
    }, warn)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith('任务执行出错：模型失败')
  })
})
