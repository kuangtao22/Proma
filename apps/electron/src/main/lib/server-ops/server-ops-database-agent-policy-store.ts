import { closeSync, existsSync, mkdirSync, openSync, readSync } from 'node:fs'
import { constants as fsConstants } from 'node:fs'
import { join } from 'node:path'
import { parseServerOpsDatabaseAgentPolicy, parseServerOpsDatabaseAgentPolicyUpdate } from '@proma/shared'
import type { ServerOpsDatabaseAgentPolicy, ServerOpsDatabaseAgentPolicyUpdate } from '@proma/shared'
import { getConfigDir } from '../config-paths'
import { readAtomicFileState, writeJsonFileAtomicSecure } from '../safe-file'
import type { AtomicDestinationExpectation } from '../safe-file'
import { createServerOpsConfigTransaction, resolveServerOpsConfigFilePath } from './server-ops-config-transaction'
import type { ServerOpsConfigTransaction } from './server-ops-config-transaction'

/** 只允许读取权威主文件；旧备份绝不能自动恢复较宽松的禁用名单。 */
const FILE_NAME = 'database-agent-policy.json'
const MAX_FILE_BYTES = 1_048_576

/** Store 的独立事务注入点；生产始终使用同目录原生跨进程锁。 */
export interface ServerOpsDatabaseAgentPolicyStoreOptions {
  transaction?: ServerOpsConfigTransaction
}

/** 管理共享业务配置中的数据库 Agent 禁用表策略。 */
export class ServerOpsDatabaseAgentPolicyStore {
  private readonly filePath: string
  private readonly transaction: ServerOpsConfigTransaction
  private readonly listeners = new Set<(policy: ServerOpsDatabaseAgentPolicy) => void>()
  /** 当前进程已观察到的最高版本，阻断异常删除或旧文件回滚。 */
  private highestRevision = 0
  private hasObservedFile = false

  /**
   * 创建策略 Store 并绑定固定配置路径。
   * @param configDir Proma 业务配置根
   * @param options 测试可替换的同目录事务
   */
  constructor(configDir = getConfigDir(), options: ServerOpsDatabaseAgentPolicyStoreOptions = {}) {
    const directoryPath = join(configDir, 'server-ops')
    mkdirSync(directoryPath, { recursive: true })
    this.filePath = resolveServerOpsConfigFilePath(directoryPath, FILE_NAME)
    this.transaction = options.transaction ?? createServerOpsConfigTransaction(directoryPath)
  }

  /** 读取最新权威策略并返回独立快照。 */
  get(): ServerOpsDatabaseAgentPolicy {
    return this.readCurrent().policy
  }

  /**
   * 按版本原子替换完整禁用名单；只在持久提交后通知本实例订阅者。
   * @param update 带上次读取版本的完整策略更新
   * @returns 主进程分配新版 revision 的独立策略快照
   */
  set(update: ServerOpsDatabaseAgentPolicyUpdate): ServerOpsDatabaseAgentPolicy {
    const parsed = parseServerOpsDatabaseAgentPolicyUpdate(update)
    const result = this.transaction(() => {
      const current = this.readCurrent()
      if (current.policy.revision !== parsed.expectedRevision) throw new Error('SERVER_OPS_DATABASE_AGENT_POLICY_CONFLICT')
      if (current.policy.revision >= Number.MAX_SAFE_INTEGER) throw new Error('SERVER_OPS_DATABASE_AGENT_POLICY_REVISION_EXHAUSTED')
      const next = parseServerOpsDatabaseAgentPolicy({ revision: current.policy.revision + 1,
        exclusions: parsed.exclusions.filter((item) => item.excludedTables.length > 0) })
      writeJsonFileAtomicSecure(this.filePath, next, {
        expectedDestination: current.expectedDestination,
        // 首次写入也保留同版备份作为已保存标记；备份从不参与授权恢复。
        priorBackup: { filePath: `${this.filePath}.bak`, data: current.expectedDestination.kind === 'state' ? current.policy : next },
      })
      this.highestRevision = next.revision
      this.hasObservedFile = true
      return next
    })
    for (const listener of this.listeners) {
      try { listener(structuredClone(result)) } catch { /* 单个窗口监听异常不改变已提交的策略。 */ }
    }
    return result
  }

  /**
   * 订阅本实例成功提交事件；跨实例读取使用 get() 的 fresh-read。
   * @param listener 收到独立策略快照的监听函数
   * @returns 取消订阅函数
   */
  onChanged(listener: (policy: ServerOpsDatabaseAgentPolicy) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** 主文件是唯一权威；坏文件或候选备份不得解释为空授权策略。 */
  private readCurrent(): { policy: ServerOpsDatabaseAgentPolicy; expectedDestination: AtomicDestinationExpectation } {
    const before = readAtomicFileState(this.filePath)
    if (before === null) {
      if (this.hasObservedFile || existsSync(`${this.filePath}.bak`) || existsSync(`${this.filePath}.tmp`)) {
        throw new Error('SERVER_OPS_DATABASE_AGENT_POLICY_READ_FAILED')
      }
      return { policy: { revision: 0, exclusions: [] }, expectedDestination: { kind: 'missing' } }
    }
    this.hasObservedFile = true
    try {
      if (before.size > MAX_FILE_BYTES) throw new Error('policy too large')
      /** 即使并发写者持续扩大文件，也最多读取预算内的字节。 */
      const descriptor = openSync(this.filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
      let raw: string
      try {
        const buffer = Buffer.allocUnsafe(before.size + 1)
        let used = 0
        while (used < buffer.length) {
          const bytes = readSync(descriptor, buffer, used, buffer.length - used, used)
          if (bytes === 0) break
          used += bytes
        }
        if (used !== before.size) throw new Error('policy changed while reading')
        raw = buffer.toString('utf8', 0, used)
      } finally {
        closeSync(descriptor)
      }
      const after = readAtomicFileState(this.filePath)
      if (after === null || before.dev !== after.dev || before.ino !== after.ino
        || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
        throw new Error('policy changed while reading')
      }
      const policy = parseServerOpsDatabaseAgentPolicy(JSON.parse(raw) as unknown)
      if (policy.revision < this.highestRevision) throw new Error('SERVER_OPS_DATABASE_AGENT_POLICY_ROLLBACK')
      this.highestRevision = policy.revision
      return { policy, expectedDestination: { kind: 'state', state: after } }
    } catch (error) {
      if (error instanceof Error && error.message === 'SERVER_OPS_DATABASE_AGENT_POLICY_ROLLBACK') throw error
      throw new Error('SERVER_OPS_DATABASE_AGENT_POLICY_READ_FAILED')
    }
  }
}
