import type { WorkspaceOperationKind } from '@proma/shared'

/** 工作区操作锁注册表对外能力。 */
export interface WorkspaceOperationRegistry {
  /** 获取指定工作区的独占操作锁，并返回幂等释放函数。 */
  acquireWorkspaceOperation: (workspaceId: string, kind: WorkspaceOperationKind) => () => void
  /** 查询指定工作区当前操作对新任务的稳定阻断原因。 */
  getWorkspaceOperationBlockReason: (workspaceId: string) => string | undefined
  /** 查询指定工作区当前持有的操作类型。 */
  getWorkspaceOperationKind: (workspaceId: string) => WorkspaceOperationKind | undefined
  /** 获取工作区异步写 lease，迁移只能在全部 lease 释放后开始。 */
  acquireWorkspaceWriteLease: (workspaceId: string) => () => void
}

/** 工作区锁在注册表中的内部持有记录。 */
interface WorkspaceOperationEntry {
  kind: WorkspaceOperationKind
  token: symbol
}

/** 迁移期间向新写任务返回的稳定用户提示。 */
const WORKSPACE_RELOCATION_BLOCK_REASON = '项目正在迁移，请等待完成后重试'

/** 拒绝空白或带首尾空白的 ID，避免不同原始 ID 被静默合并。 */
function assertWorkspaceId(workspaceId: unknown): asserts workspaceId is string {
  if (typeof workspaceId !== 'string' || workspaceId.length === 0 || workspaceId !== workspaceId.trim()) {
    throw new Error('工作区 ID 无效')
  }
}

/** 在未类型化运行时边界再次限制允许的工作区操作类型。 */
function assertWorkspaceOperationKind(kind: WorkspaceOperationKind): void {
  if (kind !== 'relocation') {
    throw new Error('工作区操作类型无效')
  }
}

/** 创建相互隔离的工作区操作锁注册表。 */
export function createWorkspaceOperationRegistry(): WorkspaceOperationRegistry {
  /** 仅保存当前进程中正在执行的工作区操作。 */
  const entries = new Map<string, WorkspaceOperationEntry>()
  /** 每个工作区尚未 settled 的异步写引用计数。 */
  const writeLeaseCounts = new Map<string, number>()

  return {
    acquireWorkspaceOperation: (workspaceId, kind) => {
      assertWorkspaceId(workspaceId)
      assertWorkspaceOperationKind(kind)
      if ((writeLeaseCounts.get(workspaceId) ?? 0) > 0) {
        throw new Error('项目仍有 Design 写入正在进行，无法迁移')
      }
      if (entries.has(workspaceId)) {
        throw new Error(WORKSPACE_RELOCATION_BLOCK_REASON)
      }

      /** 唯一持有令牌用于阻止旧释放函数清除后来获取的新锁。 */
      const token = Symbol(workspaceId)
      entries.set(workspaceId, { kind, token })
      /** 标记当前释放函数是否已消费，确保重复调用无副作用。 */
      let released = false
      return () => {
        if (released) return
        released = true
        /** 只有仍持有同一令牌时才能删除注册表条目。 */
        const currentEntry = entries.get(workspaceId)
        if (currentEntry?.token === token) entries.delete(workspaceId)
      }
    },
    getWorkspaceOperationBlockReason: (workspaceId) => {
      assertWorkspaceId(workspaceId)
      return entries.has(workspaceId) ? WORKSPACE_RELOCATION_BLOCK_REASON : undefined
    },
    getWorkspaceOperationKind: (workspaceId) => {
      assertWorkspaceId(workspaceId)
      return entries.get(workspaceId)?.kind
    },
    acquireWorkspaceWriteLease: (workspaceId) => {
      assertWorkspaceId(workspaceId)
      if (entries.has(workspaceId)) throw new Error(WORKSPACE_RELOCATION_BLOCK_REASON)
      writeLeaseCounts.set(workspaceId, (writeLeaseCounts.get(workspaceId) ?? 0) + 1)
      let released = false
      return () => {
        if (released) return
        released = true
        const remaining = (writeLeaseCounts.get(workspaceId) ?? 1) - 1
        if (remaining <= 0) writeLeaseCounts.delete(workspaceId)
        else writeLeaseCounts.set(workspaceId, remaining)
      }
    },
  }
}

/** 生产进程共享的默认工作区操作锁注册表。 */
const defaultRegistry = createWorkspaceOperationRegistry()

/** 获取默认注册表中的工作区独占操作锁。 */
export const acquireWorkspaceOperation = defaultRegistry.acquireWorkspaceOperation

/** 查询默认注册表中的稳定阻断原因。 */
export const getWorkspaceOperationBlockReason = defaultRegistry.getWorkspaceOperationBlockReason

/** 查询默认注册表中的当前操作类型。 */
export const getWorkspaceOperationKind = defaultRegistry.getWorkspaceOperationKind

/** 获取默认注册表的异步写 lease。 */
export const acquireWorkspaceWriteLease = defaultRegistry.acquireWorkspaceWriteLease
