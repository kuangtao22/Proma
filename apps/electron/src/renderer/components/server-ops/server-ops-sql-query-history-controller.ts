import type {
  ServerOpsDataQueryHistoryEntry,
  ServerOpsDataQueryHistoryRecordInput,
  ServerOpsDataQueryHistoryResult,
  ServerOpsDataQueryHistoryScope,
} from '@proma/shared'

/** 历史面板绑定的连接、数据库与配置身份。 */
export interface ServerOpsSqlQueryHistoryContext {
  sourceId: string
  database: string | null
  configurationKey: string
}

/** SQL 查询历史的页面投影；失败正文保留在私有重试队列中。 */
export interface ServerOpsSqlQueryHistoryProjection {
  context: ServerOpsSqlQueryHistoryContext | null
  entries: ServerOpsDataQueryHistoryEntry[]
  status: 'idle' | 'loading' | 'ready' | 'error'
  error: string | null
  saving: boolean
  failedCount: number
}

/** 兼容新旧 preload 的最小历史桥接。 */
export interface ServerOpsSqlQueryHistoryApi {
  list?: (input: ServerOpsDataQueryHistoryScope) => Promise<ServerOpsDataQueryHistoryResult>
  save?: (input: ServerOpsDataQueryHistoryRecordInput) => Promise<ServerOpsDataQueryHistoryResult>
}

/** 控制器依赖只包含桥接和不可变投影发布函数。 */
export interface ServerOpsSqlQueryHistoryControllerOptions {
  api: ServerOpsSqlQueryHistoryApi
  publish: (projection: ServerOpsSqlQueryHistoryProjection) => void
}

interface FailedRecord {
  input: ServerOpsDataQueryHistoryRecordInput
}

/** 页面热更新不会更新主进程和 preload，需要完整重启才能加载新增接口。 */
const HISTORY_UNAVAILABLE_MESSAGE = 'SQL 查询历史接口尚未就绪，请重启应用后重试'

/** 按已知 IPC 错误区分版本不一致；未知正文不回显，以免泄漏 SQL 或本地路径。 */
function getHistoryErrorMessage(error: unknown, action: '读取' | '保存'): string {
  /** Electron 会在稳定错误码前添加调用通道描述，因此只匹配已知标记。 */
  const message = error instanceof Error ? error.message : ''
  if (message.includes('SERVER_OPS_DATA_QUERY_HISTORY_UNAVAILABLE')
    || /No handler registered for ['"]server-ops:data-query-history-(?:list|save)['"]/u.test(message)) {
    return HISTORY_UNAVAILABLE_MESSAGE
  }
  if (message === 'SERVER_OPS_QUERY_HISTORY_SCOPE_MISMATCH') return 'SQL 查询历史与当前数据库不匹配'
  return `${action} SQL 查询历史失败，请稍后重试`
}

/** 创建不含连接和业务数据的初始投影。 */
export function createServerOpsSqlQueryHistoryIdleProjection(): ServerOpsSqlQueryHistoryProjection {
  return { context: null, entries: [], status: 'idle', error: null, saving: false, failedCount: 0 }
}

/** 使用结构化 scope 身份，避免字符串拼接造成连接或库名碰撞。 */
function getScopeKey(scope: ServerOpsDataQueryHistoryScope): string {
  return JSON.stringify([scope.sourceId, scope.database])
}

/** 配置身份参与页面归属判断，但不改变磁盘历史的 source + database 分区。 */
function getContextKey(context: ServerOpsSqlQueryHistoryContext): string {
  return JSON.stringify([context.sourceId, context.database, context.configurationKey])
}

/** 校验主进程没有把其他连接或数据库的记录混入本次结果。 */
function matchesScope(result: ServerOpsDataQueryHistoryResult, scope: ServerOpsDataQueryHistoryScope): boolean {
  return result.entries.every((entry) => entry.sourceId === scope.sourceId && entry.database === scope.database)
}

/** 创建按数据库隔离的 SQL 查询历史控制器。 */
export function createServerOpsSqlQueryHistoryController(options: ServerOpsSqlQueryHistoryControllerOptions) {
  /** 当前页面投影仅由通过生命周期校验的异步回执更新。 */
  let state = createServerOpsSqlQueryHistoryIdleProjection()
  /** StrictMode 每次重新挂载都会推进 owner，旧 owner 回执只能完成持久化。 */
  let active = false
  let ownerGeneration = 0
  /** 读取代次用于切库、刷新和卸载时作废迟到列表。 */
  let listGeneration = 0
  /** 失败项保留原始 SQL 与 scope，重试绝不读取当前编辑器状态。 */
  const failedByScope = new Map<string, FailedRecord[]>()
  /** 每个 scope 独立统计保存与写代次，避免旧读取或旧保存回退较新结果。 */
  const savingByScope = new Map<string, number>()
  const writeGenerationByScope = new Map<string, number>()
  /** 同 scope 按调用顺序写入本地文件，不同 scope 仍可并行。 */
  const saveChainsByScope = new Map<string, Promise<void>>()

  /** 返回当前有效数据库 scope；未选库时不允许读取或重试。 */
  const currentScope = (): ServerOpsDataQueryHistoryScope | null => {
    const context = state.context
    return context?.database ? { sourceId: context.sourceId, database: context.database } : null
  }
  /** 当前上下文是否仍属于指定业务 scope。 */
  const isCurrentScope = (scope: ServerOpsDataQueryHistoryScope): boolean => {
    const current = currentScope()
    return current !== null && getScopeKey(current) === getScopeKey(scope)
  }
  /** 从私有映射同步当前 scope 的保存状态和失败数。 */
  const syncScopeStatus = (): void => {
    const scope = currentScope()
    const key = scope ? getScopeKey(scope) : null
    state.saving = key !== null && (savingByScope.get(key) ?? 0) > 0
    state.failedCount = key === null ? 0 : (failedByScope.get(key)?.length ?? 0)
  }
  /** 仅向当前挂载 owner 发布不可变副本。 */
  const publish = (): void => {
    syncScopeStatus()
    if (active) options.publish(structuredClone(state))
  }
  /** 记录失败项；同 scope 下仅保留一条 trim 后等价的 SQL。 */
  const retainFailed = (record: FailedRecord): void => {
    const key = getScopeKey(record.input)
    const normalizedSql = record.input.sql.trim()
    if ((failedByScope.get(key) ?? []).some((item) => item.input.sql.trim() === normalizedSql)) return
    failedByScope.set(key, [...(failedByScope.get(key) ?? []), record])
  }
  /** 保存成功后移除当前 scope 下所有等价 SQL 失败项。 */
  const removeFailed = (record: FailedRecord): void => {
    const key = getScopeKey(record.input)
    const normalizedSql = record.input.sql.trim()
    const remaining = (failedByScope.get(key) ?? []).filter((item) => item.input.sql.trim() !== normalizedSql)
    if (remaining.length > 0) failedByScope.set(key, remaining)
    else failedByScope.delete(key)
  }
  /** 更新 scope 在途保存计数，并同步当前页面。 */
  const changeSaving = (scope: ServerOpsDataQueryHistoryScope, delta: 1 | -1): void => {
    const key = getScopeKey(scope)
    const next = Math.max(0, (savingByScope.get(key) ?? 0) + delta)
    if (next > 0) savingByScope.set(key, next)
    else savingByScope.delete(key)
  }
  /** 执行队首保存；allowRetain=false 表示它已在失败队列中。 */
  const performSave = async (
    record: FailedRecord,
    allowRetain: boolean,
    owner: number,
    scope: ServerOpsDataQueryHistoryScope,
  ): Promise<void> => {
    const input = structuredClone(record.input)
    const key = getScopeKey(scope)
    const save = options.api.save
    if (!save) {
      if (allowRetain) retainFailed(record)
      if (active && ownerGeneration === owner && isCurrentScope(scope)) {
        state.status = 'error'
        state.error = HISTORY_UNAVAILABLE_MESSAGE
      }
      changeSaving(scope, -1)
      if (active && ownerGeneration === owner && isCurrentScope(scope)) publish()
      return
    }

    try {
      const result = await save(input)
      if (!matchesScope(result, scope)) throw new Error('SERVER_OPS_QUERY_HISTORY_SCOPE_MISMATCH')
      removeFailed(record)
    } catch (error) {
      if (allowRetain) retainFailed(record)
      if (active && ownerGeneration === owner && isCurrentScope(scope)) {
        state.status = 'error'
        state.error = getHistoryErrorMessage(error, '保存')
      }
    } finally {
      /** 只作废当前仍是同 scope 的读取，旧库保存不能干扰新库列表。 */
      if (isCurrentScope(scope)) listGeneration += 1
      changeSaving(scope, -1)
    }
    /** 队列未清空时由最后一项统一读取，避免连续重试产生重复 IPC。 */
    if ((savingByScope.get(key) ?? 0) > 0) {
      if (active && ownerGeneration === owner && isCurrentScope(scope)) publish()
      return
    }
    if (active && isCurrentScope(scope)) {
      /** 队尾无论成功失败都读取权威快照；失败提示由 failedCount 独立表达。 */
      await refresh()
    }
  }

  /** 将保存加入所属 scope 的串行链，并立即反映排队中的 saving 状态。 */
  const saveRecord = (record: FailedRecord, allowRetain: boolean): Promise<void> => {
    const scope: ServerOpsDataQueryHistoryScope = {
      sourceId: record.input.sourceId,
      database: record.input.database,
    }
    const key = getScopeKey(scope)
    const owner = ownerGeneration
    writeGenerationByScope.set(key, (writeGenerationByScope.get(key) ?? 0) + 1)
    changeSaving(scope, 1)
    if (active && isCurrentScope(scope)) publish()

    const previous = saveChainsByScope.get(key) ?? Promise.resolve()
    let queued: Promise<void>
    queued = previous
      .then(
        () => performSave(record, allowRetain, owner, scope),
        () => performSave(record, allowRetain, owner, scope),
      )
      .finally(() => {
        if (saveChainsByScope.get(key) === queued) saveChainsByScope.delete(key)
      })
    saveChainsByScope.set(key, queued)
    return queued
  }

  /** 主动读取当前库；仅上下文切换和显式刷新调用，不轮询。 */
  const refresh = async (): Promise<void> => {
    const scope = currentScope()
    if (!active || !scope) return
    const list = options.api.list
    const owner = ownerGeneration
    const context = state.context ? getContextKey(state.context) : ''
    const request = ++listGeneration
    const key = getScopeKey(scope)
    const expectedWrite = writeGenerationByScope.get(key) ?? 0
    state.error = null
    if (!list) {
      state.status = 'error'
      state.error = HISTORY_UNAVAILABLE_MESSAGE
      publish()
      return
    }
    state.status = 'loading'
    publish()
    try {
      const result = await list(structuredClone(scope))
      const valid = active
        && ownerGeneration === owner
        && listGeneration === request
        && state.context !== null
        && getContextKey(state.context) === context
        && (writeGenerationByScope.get(key) ?? 0) === expectedWrite
      if (!valid) return
      if (!matchesScope(result, scope)) {
        state.status = 'error'
        state.error = 'SQL 查询历史与当前数据库不匹配'
      } else {
        state.status = 'ready'
        state.error = null
        state.entries = structuredClone(result.entries)
      }
      publish()
    } catch (error) {
      if (!active
        || ownerGeneration !== owner
        || listGeneration !== request
        || state.context === null
        || getContextKey(state.context) !== context
        || (writeGenerationByScope.get(key) ?? 0) !== expectedWrite) return
      state.status = 'error'
      state.error = getHistoryErrorMessage(error, '读取')
      publish()
    }
  }

  return {
    /** 返回不可变快照，避免 React 或测试反向修改内部状态。 */
    snapshot(): ServerOpsSqlQueryHistoryProjection {
      syncScopeStatus()
      return structuredClone(state)
    },
    /** StrictMode 重新挂载时重新读取当前库，并隔离旧 owner 回执。 */
    activate(): void {
      if (active) return
      active = true
      ownerGeneration += 1
      publish()
      if (currentScope()) void refresh()
    },
    /** 卸载只停止页面发布；已经发起的保存仍必须完成。 */
    dispose(): void {
      active = false
      ownerGeneration += 1
      listGeneration += 1
    },
    /** 切换连接、数据库或配置身份时清空旧 UI，并读取新 scope。 */
    setContext(context: ServerOpsSqlQueryHistoryContext): void {
      if (state.context && getContextKey(state.context) === getContextKey(context)) return
      listGeneration += 1
      state = { ...state, context: { ...context }, entries: [], status: 'idle', error: null }
      publish()
      if (active && context.database) void refresh()
    },
    /** 显式刷新当前库历史。 */
    refresh,
    /** 保存查询执行时捕获的原始 scope 与 SQL，不读取当前页面上下文。 */
    async record(input: ServerOpsDataQueryHistoryRecordInput): Promise<void> {
      const record: FailedRecord = { input: structuredClone(input) }
      await saveRecord(record, true)
    },
    /** 只重试调用瞬间当前数据库的失败项，绝不重新执行 SQL。 */
    async retryFailed(): Promise<void> {
      const scope = currentScope()
      if (!scope) return
      const key = getScopeKey(scope)
      if ((savingByScope.get(key) ?? 0) > 0) return
      const records = [...(failedByScope.get(key) ?? [])]
      for (const record of records) await saveRecord(record, false)
    },
  }
}
