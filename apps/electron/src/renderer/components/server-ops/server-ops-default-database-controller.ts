import type { ServerOpsDataSource, ServerOpsDataSourceSetDefaultDatabaseInput, ServerOpsDataSourceUpsertResult } from '@proma/shared'
import { getServerOpsDatabaseReadIdentity } from '@/atoms/server-ops-database-atoms'

/** 选库记忆依赖；只接收已成功打开的库，不承担目录查询。 */
interface ServerOpsDefaultDatabaseOptions {
  source: ServerOpsDataSource
  save?: (input: ServerOpsDataSourceSetDefaultDatabaseInput) => Promise<ServerOpsDataSourceUpsertResult>
  onSaved: () => void
}

/** 完整公开快照键；名称和归属也参与 CAS，但不扩大浏览身份。 */
function snapshotKey(source: ServerOpsDataSource): string {
  return JSON.stringify([getServerOpsDatabaseReadIdentity(source), source.label, source.projectId, source.createdAt, source.localFileId])
}

/**
 * 串行保存默认库，并识别本工作台自己产生的配置回执。
 * @param options 初始连接、窄字段保存接口和列表刷新通知
 * @returns 配置同步、保存和浏览身份读取方法；外部配置编辑仍使旧导航失效
 */
export function createServerOpsDefaultDatabaseController(options: ServerOpsDefaultDatabaseOptions) {
  /** 后续 CAS 始终使用最近一次权威配置，不使用旧 React props 覆盖。 */
  let source = options.source
  /** 父组件最近交付的配置与当前工作台稳定浏览身份。 */
  let externalKey = snapshotKey(source)
  let readIdentity = getServerOpsDatabaseReadIdentity(source)
  /** 外部编辑推进代次，迟到的保存不能覆盖新端点。 */
  let revision = 0
  /** 尚未被父组件消费的本地保存回执；只保留最近 32 次。 */
  const savedKeys = new Set<string>()
  /** 保存串行化，连续选库严格按成功选择顺序写入。 */
  let pending: Promise<void> = Promise.resolve()

  return {
    /** 返回最新快照，用于连接设置和导航的持久化身份。 */
    getSource: (): ServerOpsDataSource => source,
    /** 自己保存的默认库沿用本次浏览身份；真正的外部编辑产生新身份。 */
    getReadIdentity(next: ServerOpsDataSource): string {
      /** 父组件交付快照的完整比较键。 */
      const key = snapshotKey(next)
      return key === externalKey || savedKeys.has(key) ? readIdentity : getServerOpsDatabaseReadIdentity(next)
    },
    /** 接收父组件权威刷新；已确认的默认库保存不清空表格和 SQL 编辑状态。 */
    setSource(next: ServerOpsDataSource): void {
      /** 识别本工作台的保存回执，其他更新仍按外部编辑处理。 */
      const key = snapshotKey(next)
      if (key === externalKey) return
      externalKey = key
      if (savedKeys.delete(key)) return
      source = next
      readIdentity = getServerOpsDatabaseReadIdentity(next)
      revision += 1
      savedKeys.clear()
    },
    /** 保存仍有效的成功选库；失败透传给界面，后续选择仍能继续保存。 */
    remember(database: string, isCurrent: () => boolean): Promise<void> {
      /** 本次选择归属的配置代次，排队期间不允许跨配置写入。 */
      const owner = revision
      /** 当前保存任务，成功与失败都会释放后续任务。 */
      const request = pending.then(async () => {
        if (owner !== revision || !isCurrent() || database === source.database) return
        if (source.engine !== 'mysql' && source.engine !== 'postgresql') return
        if (!options.save) throw new Error('SERVER_OPS_DATA_DEFAULT_DATABASE_UNAVAILABLE')
        /** 主进程完成 CAS 后返回的新快照。 */
        const result = await options.save({ source, database })
        if (owner !== revision) return
        source = result.source
        savedKeys.add(snapshotKey(source))
        if (savedKeys.size > 32) {
          /** 丢弃最早的未消费标记，限制长时间连续选库的内存占用。 */
          const oldest = savedKeys.values().next().value
          if (oldest !== undefined) savedKeys.delete(oldest)
        }
        options.onSaved()
      })
      pending = request.catch(() => undefined)
      return request
    },
  }
}
