import { describe, expect, test } from 'bun:test'
import {
  acquireWorkspaceOperation,
  createWorkspaceOperationRegistry,
  getWorkspaceOperationBlockReason,
  getWorkspaceOperationKind,
} from './workspace-operation-lock'

/** 模拟未类型化边界调用工作区锁注册表。 */
interface UntypedWorkspaceOperationRegistry {
  acquireWorkspaceOperation: (workspaceId: unknown, kind: unknown) => () => void
  getWorkspaceOperationBlockReason: (workspaceId: unknown) => string | undefined
  getWorkspaceOperationKind: (workspaceId: unknown) => unknown
}

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

  test('Given 默认与两个实例注册表 When 同一工作区同时获取锁 Then 三者独立持有和释放', () => {
    /** 第一个独立实例注册表。 */
    const registryA = createWorkspaceOperationRegistry()
    /** 第二个独立实例注册表。 */
    const registryB = createWorkspaceOperationRegistry()
    /** 模块级默认注册表的释放函数。 */
    const releaseDefault = acquireWorkspaceOperation('workspace-registry-isolation', 'relocation')
    /** 第一个实例注册表的释放函数。 */
    const releaseA = registryA.acquireWorkspaceOperation('workspace-registry-isolation', 'relocation')
    /** 第二个实例注册表的释放函数。 */
    const releaseB = registryB.acquireWorkspaceOperation('workspace-registry-isolation', 'relocation')
    try {
      expect(getWorkspaceOperationKind('workspace-registry-isolation')).toBe('relocation')
      expect(registryA.getWorkspaceOperationKind('workspace-registry-isolation')).toBe('relocation')
      expect(registryB.getWorkspaceOperationKind('workspace-registry-isolation')).toBe('relocation')

      releaseDefault()
      expect(getWorkspaceOperationKind('workspace-registry-isolation')).toBeUndefined()
      expect(registryA.getWorkspaceOperationKind('workspace-registry-isolation')).toBe('relocation')
      expect(registryB.getWorkspaceOperationKind('workspace-registry-isolation')).toBe('relocation')

      releaseA()
      expect(registryA.getWorkspaceOperationKind('workspace-registry-isolation')).toBeUndefined()
      expect(registryB.getWorkspaceOperationKind('workspace-registry-isolation')).toBe('relocation')
    }
    finally {
      releaseDefault()
      releaseA()
      releaseB()
    }
    expect(registryB.getWorkspaceOperationKind('workspace-registry-isolation')).toBeUndefined()
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

  test('Given 未类型化边界传入非法工作区 ID When 锁已持有 Then 固定拒绝且不篡改原锁', () => {
    /** 使用实例注册表隔离当前用例。 */
    const registry = createWorkspaceOperationRegistry()
    /** 模拟来自未类型化边界的注册表调用。 */
    const untypedRegistry = registry as unknown as UntypedWorkspaceOperationRegistry
    /** 覆盖非字符串、空白以及首尾不规范的运行时输入。 */
    const invalidWorkspaceIds: unknown[] = [null, undefined, 1, {}, [], '', '   ', ' workspace-1', 'workspace-1 ']
    /** 释放验证期间持续持有的原迁移锁。 */
    const release = registry.acquireWorkspaceOperation('workspace-1', 'relocation')
    try {
      for (const workspaceId of invalidWorkspaceIds) {
        expect(() => untypedRegistry.acquireWorkspaceOperation(workspaceId, 'relocation')).toThrow('工作区 ID 无效')
        expect(() => untypedRegistry.getWorkspaceOperationBlockReason(workspaceId)).toThrow('工作区 ID 无效')
        expect(() => untypedRegistry.getWorkspaceOperationKind(workspaceId)).toThrow('工作区 ID 无效')
      }
      expect(registry.getWorkspaceOperationKind('workspace-1')).toBe('relocation')
      expect(registry.getWorkspaceOperationBlockReason('workspace-1')).toBe('项目正在迁移，请等待完成后重试')
    }
    finally {
      release()
    }
    expect(registry.getWorkspaceOperationKind('workspace-1')).toBeUndefined()
  })

  test('Given 工作区已有锁且未类型化边界传入未知操作类型 When 获取锁 Then 拒绝且保留原持有者', () => {
    /** 使用实例注册表隔离当前用例。 */
    const registry = createWorkspaceOperationRegistry()
    /** 模拟来自未类型化边界的注册表调用。 */
    const untypedRegistry = registry as unknown as UntypedWorkspaceOperationRegistry
    /** 释放验证期间持续持有的原迁移锁。 */
    const release = registry.acquireWorkspaceOperation('workspace-1', 'relocation')
    try {
      expect(() => untypedRegistry.acquireWorkspaceOperation('workspace-1', 'copy')).toThrow('工作区操作类型无效')
      expect(registry.getWorkspaceOperationKind('workspace-1')).toBe('relocation')
      expect(registry.getWorkspaceOperationBlockReason('workspace-1')).toBe('项目正在迁移，请等待完成后重试')
      expect(() => registry.acquireWorkspaceOperation('workspace-1', 'relocation'))
        .toThrow('项目正在迁移，请等待完成后重试')
    }
    finally {
      release()
    }
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

  test('Given 工作区有两个异步写 lease When 获取迁移锁 Then 直到全部释放前拒绝迁移', () => {
    const registry = createWorkspaceOperationRegistry()
    const releaseFirst = registry.acquireWorkspaceWriteLease('workspace-design')
    const releaseSecond = registry.acquireWorkspaceWriteLease('workspace-design')

    expect(() => registry.acquireWorkspaceOperation('workspace-design', 'relocation'))
      .toThrow('项目仍有 Design 写入正在进行，无法迁移')
    releaseFirst()
    expect(() => registry.acquireWorkspaceOperation('workspace-design', 'relocation'))
      .toThrow('项目仍有 Design 写入正在进行，无法迁移')
    releaseSecond()
    const releaseRelocation = registry.acquireWorkspaceOperation('workspace-design', 'relocation')
    releaseRelocation()
  })
})
