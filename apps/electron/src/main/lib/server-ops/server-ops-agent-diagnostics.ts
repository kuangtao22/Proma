import type { ServerOpsAgentDiscoveryResult, ServerOpsDockerResourcesResult, ServerOpsServiceListResult } from '@proma/shared'

/** 仅依赖现有列表服务；不发起网络扫描或加载容器配置、环境变量。 */
export interface ServerOpsAgentDiscoveryServices {
  systemd: { listServices(input: { hostId: string }, signal?: AbortSignal): Promise<ServerOpsServiceListResult> }
  docker?: { listContainers(input: { hostId: string }, signal?: AbortSignal): Promise<Pick<ServerOpsDockerResourcesResult, 'hostId' | 'capability' | 'containers'>> }
}

/** 聚合现有 systemd 与 Docker 摘要，部分失败仍标明不可用及裁剪。 */
export async function discoverServerOpsServices(hostId: string, services: ServerOpsAgentDiscoveryServices, signal: AbortSignal): Promise<ServerOpsAgentDiscoveryResult> {
  if (signal.aborted) throw new Error('SERVER_OPS_AGENT_READ_CANCELLED')
  /** 两种来源相互独立；失败不伪装成主机没有运行服务。 */
  const [units, containers] = await Promise.allSettled([
    services.systemd.listServices({ hostId }, signal),
    services.docker ? services.docker.listContainers({ hostId }, signal) : Promise.reject(new Error('SERVER_OPS_DOCKER_UNAVAILABLE')),
  ])
  if (signal.aborted) throw new Error('SERVER_OPS_AGENT_READ_CANCELLED')
  const systemd = units.status === 'fulfilled' && units.value.hostId === hostId ? units.value : undefined
  const docker = containers.status === 'fulfilled' && containers.value.hostId === hostId ? containers.value : undefined
  const result: ServerOpsAgentDiscoveryResult = {
    hostId,
    systemd: {
      capability: systemd?.capability === 'available' ? 'available' : systemd?.capability === 'permission-denied' ? 'permission-denied' : 'unavailable',
      services: systemd?.capability === 'available' ? systemd.services.slice(0, 40).map((service) => ({ unitId: service.unitId, activeState: service.activeState, description: service.description })) : [],
    },
    docker: {
      capability: docker?.capability ?? 'unavailable',
      containers: docker?.capability === 'available' ? docker.containers.slice(0, 40).map((container) => ({
        containerId: container.containerId, name: container.names[0] ?? '', image: container.image, state: container.state,
        publishedPorts: container.publishedPorts.slice(0, 8),
      })) : [],
    },
    partial: !systemd || !docker || systemd.capability !== 'available' || docker.capability !== 'available',
    truncated: Boolean(systemd && systemd.services.length > 40 || docker && docker.containers.length > 40),
  }
  /** 输出按最终序列化后字节量限制，避免过长描述推高工具上下文。 */
  while (Buffer.byteLength(JSON.stringify(result, null, 2), 'utf8') > 32_256) {
    const target = result.systemd.services.length >= result.docker.containers.length ? result.systemd.services : result.docker.containers
    if (target.length === 0) throw new Error('SERVER_OPS_AGENT_RESULT_TOO_LARGE')
    target.pop()
    result.truncated = true
  }
  return result
}
