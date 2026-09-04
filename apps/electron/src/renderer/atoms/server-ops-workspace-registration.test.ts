import { describe, expect, test } from 'bun:test'
import {
  WORKSPACE_COMPONENT_TABS,
  isWorkspaceComponentTab,
  sanitizeWorkspaceComponentTabs,
} from './agent-atoms'

describe('运维右侧工作区注册', () => {
  test('server-ops 作为可持久化且可清理的工作区组件', () => {
    expect(WORKSPACE_COMPONENT_TABS).toContain('server-ops')
    expect(isWorkspaceComponentTab('server-ops')).toBe(true)
    expect(sanitizeWorkspaceComponentTabs(['files', 'server-ops', 'unknown'])).toEqual(['server-ops'])
  })
})
