import { createHash } from 'node:crypto'
import { serverOpsReadResourceKey } from '@proma/shared'
import type { ServerOpsAgentReadResource, ServerOpsHost } from '@proma/shared'
import type { ServerOpsAgentAccessStore, ServerOpsAgentReadBinding } from './server-ops-agent-access-store'
import type { ServerOpsHostStoreContract } from './server-ops-ipc'
import type { ServerOpsDataService } from './server-ops-data-service'

/** 配置身份捕获仅需要公开资产目录，不接触凭据解密或远程读取。 */
interface ServerOpsReadIdentityServices {
  hosts: Pick<ServerOpsHostStoreContract, 'get'>
  data?: Pick<ServerOpsDataService, 'listSources'>
}

/** SSH 身份仅取连接事实；名称、标签、项目和修改时间不改变安全目标。 */
function hostIdentity(host: ServerOpsHost): unknown[] {
  return [host.id, host.address, host.port, host.username, host.authMethod, host.credentialRef ?? null]
}

/**
 * 捕获授权资源对应的稳定配置摘要，供授予与每次读取前后比较。
 * @param resources 用户明确选择的资源集合
 * @param services 主进程拥有的配置读取器
 * @returns 与资源一一对应的内部摘要；数据跳板只产生撤权依赖，不产生 SSH 能力
 */
export function captureServerOpsReadBindings(resources: ServerOpsAgentReadResource[], services: ServerOpsReadIdentityServices): ServerOpsAgentReadBinding[] {
  /** 整次捕获最多读取一份数据源目录，避免按资源重复扫盘。 */
  const sources = resources.some((resource) => resource.kind !== 'ssh') ? services.data?.listSources().sources : undefined
  return resources.map((resource) => {
    /** 此资源的稳定键与配置身份材料，均不向模型返回。 */
    const key = serverOpsReadResourceKey(resource)
    let facts: unknown[]
    let hostId: string | undefined
    if (resource.kind === 'ssh') {
      const host = services.hosts.get(resource.hostId)
      if (!host) throw new Error('SERVER_OPS_HOST_NOT_FOUND')
      facts = hostIdentity(host)
      hostId = host.id
    } else {
      const source = sources?.find((entry) => entry.id === resource.sourceId)
      if (!source) throw new Error('SERVER_OPS_DATA_SOURCE_NOT_FOUND')
      if (source.engine !== resource.kind) throw new Error('SERVER_OPS_READ_ENGINE_MISMATCH')
      const jumpHost = source.transport === 'ssh' && source.hostId ? services.hosts.get(source.hostId) : undefined
      if (source.transport === 'ssh' && !jumpHost) throw new Error('SERVER_OPS_HOST_NOT_FOUND')
      hostId = jumpHost?.id
      facts = [source.id, source.engine, source.transport, source.address, source.port, source.username ?? null,
        source.database ?? null, source.tlsMode, source.tlsServerName ?? null, source.hasPassword, jumpHost ? hostIdentity(jumpHost) : null]
    }
    return { key, fingerprint: createHash('sha256').update(JSON.stringify(facts)).digest('hex'), ...(hostId ? { hostId } : {}) }
  })
}

/** 目录变更或 UI 刷新时剔除配置已失效的授权，名称/项目变更仍保留。 */
export function revalidateServerOpsReadBindings(access: ServerOpsAgentAccessStore, services: ServerOpsReadIdentityServices): void {
  const current = access.getReadCurrent()
  if (!current) return
  /** 一个批次只读取一次数据目录，避免多资源授权导致重复扫盘。 */
  const sources = services.data?.listSources()
  const snapshotServices = { hosts: services.hosts, ...(sources ? { data: { listSources: () => sources } } : {}) }
  for (const resource of current.resources) {
    try {
      const expected = access.getReadBinding(serverOpsReadResourceKey(resource))
      const actual = captureServerOpsReadBindings([resource], snapshotServices)[0]
      if (actual && expected?.fingerprint === actual.fingerprint && expected.hostId === actual.hostId) continue
    } catch { /* 目标删除/改引擎/跳板消失都按缩权处理。 */ }
    if (resource.kind === 'ssh') access.revokeHost(resource.hostId)
    else access.revokeSource(resource.sourceId)
  }
}
