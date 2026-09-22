import type { ServerOpsAgentReadAccess } from '@proma/shared'

/** 运维授权弹窗使用的紧凑公开摘要，不展示内部资源 ID。 */
export interface ServerOpsReadSummary {
  target: string
  capability: string
  remaining: string
}

/** 从主进程授权快照计算目标、结构/行/SQL 能力和剩余期限。 */
export function summarizeServerOpsReadAccess(access: ServerOpsAgentReadAccess | null, now: number, names?: ReadonlyMap<string, string>): ServerOpsReadSummary {
  if (!access || access.expiresAt <= now) return { target: '未授权', capability: '结构/行/SQL 未启用', remaining: access ? '已到期' : '无租约' }
  /** 依据已保存事实展示库表范围，兼容尚未重新保存的旧白名单。 */
  const databaseTargets = access.resources.flatMap((resource) => {
    if (resource.kind !== 'mysql' && resource.kind !== 'sqlite') return []
    const label = names?.get(`data:${resource.sourceId}`) || (resource.kind === 'mysql' ? 'MySQL' : 'SQLite')
    const scopes = resource.databases.map((scope) => `${scope.database} · ${scope.tables === null
      ? scope.excludedTables?.length ? `已禁用 ${scope.excludedTables.length} 张表` : '全部表'
      : scope.tables.length === 1 ? scope.tables[0] : `${scope.tables[0]} 等 ${scope.tables.length} 表`}`)
    return [[label, ...(resource.kind === 'mysql' && resource.instance ? ['实例诊断'] : []), scopes.join(' / ')].filter(Boolean).join(' · ')]
  })
  const sshCount = access.resources.filter((resource) => resource.kind === 'ssh').length
  const redisCount = access.resources.filter((resource) => resource.kind === 'redis').length
  const sshName = access.resources.find((resource) => resource.kind === 'ssh')
  const redisName = access.resources.find((resource) => resource.kind === 'redis')
  const instanceCount = access.resources.filter((resource) => resource.kind === 'mysql' && resource.instance).length
  const targets = [
    ...databaseTargets,
    ...(sshCount ? [sshName?.kind === 'ssh' && names?.get(`ssh:${sshName.hostId}`)
      ? sshCount === 1 ? names.get(`ssh:${sshName.hostId}`)! : `${names.get(`ssh:${sshName.hostId}`)} 等 ${sshCount} 台`
      : `服务器 ${sshCount} 台`] : []),
    ...(redisCount ? [redisName?.kind === 'redis' && names?.get(`data:${redisName.sourceId}`)
      ? redisCount === 1 ? names.get(`data:${redisName.sourceId}`)! : `${names.get(`data:${redisName.sourceId}`)} 等 ${redisCount} 个`
      : `Redis ${redisCount} 个`] : []),
  ]
  const scopes = access.resources.flatMap((resource) => resource.kind === 'mysql' || resource.kind === 'sqlite' ? resource.databases : [])
  const capabilities = [
    ...(scopes.length ? ['结构'] : []),
    ...(scopes.some((scope) => scope.readRows) ? ['行'] : []),
    ...(scopes.some((scope) => scope.query) ? ['SQL'] : []),
    ...(access.resources.some((resource) => resource.kind === 'ssh' && resource.readLogs === true) ? ['日志'] : []),
  ]
  const capability = capabilities.join('/')
  return {
    target: targets.join(' · ') || '未授权',
    capability: [capability, sshCount || redisCount || instanceCount ? '概览' : ''].filter(Boolean).join(' · ') || '结构/行/SQL 未启用',
    remaining: `剩余 ${Math.ceil((access.expiresAt - now) / 60_000)} 分钟`,
  }
}
