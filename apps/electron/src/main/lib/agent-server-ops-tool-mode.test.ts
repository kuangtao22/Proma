import { describe, expect, test } from 'bun:test'
import { AGENT_DEFAULT_TOOL_MODE, isAgentToolMode } from '@proma/shared'
import { denyToolOutsideAgentMode, resolveAgentModeToolNames } from './agent-run-tool-policy'
import { createAgentRunIdentity } from './agent-run-identity'

describe('运维只读运行模式', () => {
  test('Given 外部传入模式 When 校验 Then 仅接受两种精确模式', () => {
    expect(AGENT_DEFAULT_TOOL_MODE).toBe('standard')
    expect(isAgentToolMode('standard')).toBe(true)
    expect(isAgentToolMode('server-ops-read')).toBe(true)
    for (const value of ['SERVER-OPS-READ', 'server-ops-read ', 'plan', null, {}]) {
      expect(isAgentToolMode(value)).toBe(false)
    }
  })

  test('Given 运维只读模式 When 注册与分派 Then 仅九个只读工具可执行', () => {
    const names = resolveAgentModeToolNames('server-ops-read')
    expect(names).toEqual([
      'ops_resources', 'ops_server_overview', 'ops_server_services',
      'ops_data_test', 'ops_data_diagnose', 'ops_database_tables',
      'ops_database_describe', 'ops_database_rows', 'ops_database_query',
    ])
    for (const name of names!) expect(denyToolOutsideAgentMode(name, 'server-ops-read')).toBeUndefined()
    for (const name of ['Bash', 'PowerShell', 'read', 'BrowserNavigate', 'mcp__other__tool', 'server_exec', 'server_list', 'Task']) {
      expect(denyToolOutsideAgentMode(name, 'server-ops-read')?.behavior).toBe('deny')
    }
  })

  test('Given 普通模式 When 注册与分派 Then 不改变原有工具能力', () => {
    expect(resolveAgentModeToolNames('standard')).toBeUndefined()
    for (const name of ['Bash', 'mcp__other__tool', 'server_exec']) {
      expect(denyToolOutsideAgentMode(name, 'standard')).toBeUndefined()
    }
  })

  test('Given 停止或启动新代际 When 旧运维结果迟到 Then 旧身份失效且新身份不受影响', () => {
    let currentGeneration = 1
    const oldRun = createAgentRunIdentity('session-a', 1, () => currentGeneration === 1)
    expect(oldRun.signal.aborted).toBe(false)
    expect(oldRun.assertActive()).toBeUndefined()
    oldRun.abort()
    expect(oldRun.signal.aborted).toBe(true)
    expect(() => oldRun.assertActive()).toThrow('当前 Agent 运行已停止')

    currentGeneration = 2
    const newRun = createAgentRunIdentity('session-a', 2, () => currentGeneration === 2)
    expect(newRun.assertActive()).toBeUndefined()
    expect(() => oldRun.assertActive()).toThrow('当前 Agent 运行已停止')
    expect(newRun.signal.aborted).toBe(false)
    currentGeneration = 3
    expect(() => newRun.assertActive()).toThrow('当前 Agent 运行已停止')
  })
})
