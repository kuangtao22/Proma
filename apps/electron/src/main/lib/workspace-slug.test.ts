import { describe, expect, test } from 'bun:test'
import { createWorkspaceSlug, isWorkspaceSlug } from './workspace-slug'

describe('workspace slug 合同', () => {
  test('Given manager 工作区名称 When 生成 slug Then 产出规范值并处理保留名', () => {
    expect(createWorkspaceSlug('Proma Project', new Set())).toBe('proma-project')
    expect(createWorkspaceSlug('CON', new Set())).toBe('workspace-con')
    expect(createWorkspaceSlug('Proma', new Set(['proma']))).toBe('proma-1')
    expect(createWorkspaceSlug('中文项目', new Set(), 1720000000000)).toBe('workspace-1720000000000')
  })

  test('Given 持久化 slug When 校验 Then 只接受生成器命名空间和默认 slug', () => {
    expect(['default', 'proma', 'product-dev', 'workspace-1720000000000', 'product-dev-2'].every(isWorkspaceSlug)).toBe(true)
    expect(['', '.', '..', 'CON', 'Alpha', 'alpha beta', 'alpha_beta', 'alpha/beta', 'alpha\\beta'].some(isWorkspaceSlug)).toBe(false)
  })
})
