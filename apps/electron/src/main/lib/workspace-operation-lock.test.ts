import { describe, expect, test } from 'bun:test'
import {
  acquireWorkspaceOperation,
  createWorkspaceOperationRegistry,
  getWorkspaceOperationBlockReason,
} from './workspace-operation-lock'

describe('工作区进程内独占锁', () => {
  test('Given 空闲工作区 When 获取迁移锁 Then 返回固定阻断原因且释放后清除', () => {
    /** 释放模块级默认注册表中的测试锁。 */
    const release = acquireWorkspaceOperation('workspace-default', 'relocation')
    try {
      expect(getWorkspaceOperationBlockReason('workspace-default')).toBe('项目正在迁移，请等待完成后重试')
    }
    finally {
      release()
    }
    expect(getWorkspaceOperationBlockReason('workspace-default')).toBeUndefined()
  })

  test('Given 工作区已有迁移锁 When 再次获取 Then 明确拒绝且保留原持有者', () => {
    /** 使用实例注册表隔离当前用例。 */
    const registry = createWorkspaceOperationRegistry()
    /** 释放首次获取的迁移锁。 */
    const release = registry.acquireWorkspaceOperation('workspace-1', 'relocation')
    try {
      expect(() => registry.acquireWorkspaceOperation('workspace-1', 'relocation'))
        .toThrow('项目正在迁移，请等待完成后重试')
      expect(registry.getWorkspaceOperationKind('workspace-1')).toBe('relocation')
    }
    finally {
      release()
    }
    expect(registry.getWorkspaceOperationKind('workspace-1')).toBeUndefined()
  })

  test('Given 两个不同工作区 When 同时获取迁移锁 Then 两者互不阻塞', () => {
    /** 使用实例注册表隔离当前用例。 */
    const registry = createWorkspaceOperationRegistry()
    /** 释放第一个工作区的迁移锁。 */
    const releaseFirst = registry.acquireWorkspaceOperation('workspace-1', 'relocation')
    /** 释放第二个工作区的迁移锁。 */
    const releaseSecond = registry.acquireWorkspaceOperation('workspace-2', 'relocation')
    try {
      expect(registry.getWorkspaceOperationKind('workspace-1')).toBe('relocation')
      expect(registry.getWorkspaceOperationKind('workspace-2')).toBe('relocation')
    }
    finally {
      releaseFirst()
      releaseSecond()
    }
  })

  test('Given 旧锁已释放且同工作区重新获取 When 旧 release 再次调用 Then 不释放新锁', () => {
    /** 使用实例注册表隔离当前用例。 */
    const registry = createWorkspaceOperationRegistry()
    /** 模拟可能被重复调用的旧释放函数。 */
    const staleRelease = registry.acquireWorkspaceOperation('workspace-1', 'relocation')
    staleRelease()
    /** 释放同一工作区后来获取的新锁。 */
    const currentRelease = registry.acquireWorkspaceOperation('workspace-1', 'relocation')
    try {
      staleRelease()
      expect(registry.getWorkspaceOperationKind('workspace-1')).toBe('relocation')
    }
    finally {
      currentRelease()
    }
    currentRelease()
    expect(registry.getWorkspaceOperationKind('workspace-1')).toBeUndefined()
  })

  test('Given 非规范工作区 ID When 获取或查询锁 Then 拒绝而不合并原始 ID', () => {
    /** 使用实例注册表隔离当前用例。 */
    const registry = createWorkspaceOperationRegistry()
    for (const workspaceId of ['', '   ', ' workspace-1', 'workspace-1 ']) {
      expect(() => registry.acquireWorkspaceOperation(workspaceId, 'relocation')).toThrow('工作区 ID 无效')
      expect(() => registry.getWorkspaceOperationKind(workspaceId)).toThrow('工作区 ID 无效')
    }
  })

  test('Given 未类型化边界传入未知操作类型 When 获取锁 Then 运行时拒绝且不占锁', () => {
    /** 使用实例注册表隔离当前用例。 */
    const registry = createWorkspaceOperationRegistry()
    /** 模拟从未类型化边界进入模块的非法操作类型。 */
    const invalidKind = 'copy' as Parameters<typeof registry.acquireWorkspaceOperation>[1]
    expect(() => registry.acquireWorkspaceOperation('workspace-1', invalidKind)).toThrow('工作区操作类型无效')
    expect(registry.getWorkspaceOperationKind('workspace-1')).toBeUndefined()
  })

  test('Given 未知工作区 When 查询锁状态 Then 返回 undefined 且不产生占用', () => {
    /** 使用实例注册表隔离当前用例。 */
    const registry = createWorkspaceOperationRegistry()
    expect(registry.getWorkspaceOperationBlockReason('workspace-unknown')).toBeUndefined()
    expect(registry.getWorkspaceOperationKind('workspace-unknown')).toBeUndefined()
    /** 查询后仍应能正常获取，证明查询没有写入注册表。 */
    const release = registry.acquireWorkspaceOperation('workspace-unknown', 'relocation')
    release()
  })
})
