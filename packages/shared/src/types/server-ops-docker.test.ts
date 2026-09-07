import { describe, expect, test } from 'bun:test'
import {
  parseServerOpsDockerActionCandidate,
  parseServerOpsDockerActionCancelInput,
  parseServerOpsDockerActionCommitInput,
  parseServerOpsDockerActionPrepareInput,
  parseServerOpsDockerActionResult,
  parseServerOpsDockerContainerDetailInput,
  parseServerOpsDockerContainerDetailResult,
  parseServerOpsDockerResourcesInput,
  parseServerOpsDockerResourcesResult,
} from './server-ops-docker'

/** 测试使用的完整 Docker 容器 ID。 */
const containerId = 'a'.repeat(64)
/** 公开容器摘要。 */
const container = {
  containerId,
  names: ['web-1'],
  image: 'registry.example.com/web:1.0',
  imageId: `sha256:${'b'.repeat(64)}`,
  state: 'running' as const,
  status: 'Up 10 minutes',
  createdAt: '2026-09-07 10:00:00 +0800 CST',
  publishedPorts: ['0.0.0.0:8080->80/tcp'],
  mountNames: ['web-data'],
}
/** 公开容器详情，不包含环境、命令、标签或挂载源路径。 */
const detail = {
  containerId,
  name: 'web-1',
  image: 'registry.example.com/web:1.0',
  imageId: `sha256:${'b'.repeat(64)}`,
  createdAt: '2026-09-07T02:00:00Z',
  platform: 'linux',
  state: 'running' as const,
  running: true,
  exitCode: 0,
  restartCount: 1,
  ports: [{ privatePort: 80, protocol: 'tcp' as const, publicPort: 8080, address: '0.0.0.0' }],
  mounts: [{ type: 'volume' as const, name: 'web-data', destination: '/var/lib/web', readOnly: false }],
}

describe('服务器运维 Docker 公开合同', () => {
  test('Given 合法资源快照 When 严格解析 Then 深复制四类有界摘要', () => {
    const parsed = parseServerOpsDockerResourcesResult({
      hostId: 'host-1', capability: 'available', containers: [container],
      images: [{ imageId: `sha256:${'b'.repeat(64)}`, repository: 'web', tag: '1.0', digest: '<none>', createdAt: 'now', size: '120MB' }],
      networks: [{ networkId: 'c'.repeat(64), name: 'bridge', driver: 'bridge', scope: 'local', internal: false }],
      volumes: [{ name: 'web-data', driver: 'local', scope: 'local' }], warnings: [],
    })
    parsed.containers[0]!.names[0] = 'changed'
    expect(container.names[0]).toBe('web-1')
    expect(parseServerOpsDockerResourcesInput({ hostId: 'host-1' })).toEqual({ hostId: 'host-1' })
    expect(parsed.capability).toBe('available')
  })

  test('Given 不可用能力或越界资源 When 解析 Then 空快照有效且超限 fail closed', () => {
    for (const capability of ['cli-missing', 'daemon-unavailable', 'permission-denied'] as const) {
      expect(parseServerOpsDockerResourcesResult({
        hostId: 'host-1', capability, containers: [], images: [], networks: [], volumes: [], warnings: [],
      }).capability).toBe(capability)
    }
    expect(() => parseServerOpsDockerResourcesResult({
      hostId: 'host-1', capability: 'available', containers: Array.from({ length: 501 }, () => container),
      images: [], networks: [], volumes: [], warnings: [],
    })).toThrow('SERVER_OPS_DOCKER_RESOURCES_RESULT_INVALID')
    expect(() => parseServerOpsDockerResourcesResult({
      hostId: 'host-1', capability: 'available', containers: [{ ...container, names: ['bad\nname'] }],
      images: [], networks: [], volumes: [], warnings: [],
    })).toThrow('SERVER_OPS_DOCKER_RESOURCES_RESULT_INVALID')
    expect(() => parseServerOpsDockerResourcesResult({
      hostId: 'host-1', capability: 'permission-denied', containers: [container],
      images: [], networks: [], volumes: [], warnings: [],
    })).toThrow('SERVER_OPS_DOCKER_RESOURCES_RESULT_INVALID')
    expect(() => parseServerOpsDockerResourcesResult({
      hostId: 'host-1', capability: 'available', containers: [{ ...container, names: ['web;reboot'] }],
      images: [], networks: [], volumes: [], warnings: [],
    })).toThrow('SERVER_OPS_DOCKER_RESOURCES_RESULT_INVALID')
  })

  test('Given 容器详情 When 解析 Then 只接受白名单投影并拒绝秘密字段', () => {
    expect(parseServerOpsDockerContainerDetailInput({ hostId: 'host-1', containerId }))
      .toEqual({ hostId: 'host-1', containerId })
    expect(parseServerOpsDockerContainerDetailResult({ hostId: 'host-1', capability: 'available', container: detail, warnings: [] }))
      .toMatchObject({ container: { containerId, name: 'web-1' } })
    for (const secret of [{ env: ['TOKEN=secret'] }, { command: ['--password=secret'] }, { labels: { token: 'secret' } }, { source: '/private/secret' }]) {
      expect(() => parseServerOpsDockerContainerDetailResult({
        hostId: 'host-1', capability: 'available', container: { ...detail, ...secret }, warnings: [],
      })).toThrow('SERVER_OPS_DOCKER_DETAIL_RESULT_INVALID')
    }
    expect(() => parseServerOpsDockerContainerDetailInput({ hostId: 'host-1', containerId: 'web-1' })).toThrow()
    expect(() => parseServerOpsDockerContainerDetailResult({
      hostId: 'host-1', capability: 'daemon-unavailable', container: detail, warnings: [],
    })).toThrow('SERVER_OPS_DOCKER_DETAIL_RESULT_INVALID')
  })

  test('Given Docker 动作意图 When 解析 Then 只接受完整 ID 与不透明候选', () => {
    expect(parseServerOpsDockerActionPrepareInput({ hostId: 'host-1', containerId, action: 'restart' }))
      .toEqual({ hostId: 'host-1', containerId, action: 'restart' })
    const candidate = parseServerOpsDockerActionCandidate({
      candidateId: 'candidate-1', hostId: 'host-1', action: 'restart', container: detail, expiresAt: 300_000,
    })
    expect(candidate.container.containerId).toBe(containerId)
    expect(parseServerOpsDockerActionCommitInput({ hostId: 'host-1', candidateId: 'candidate-1' }))
      .toEqual({ hostId: 'host-1', candidateId: 'candidate-1' })
    expect(parseServerOpsDockerActionCancelInput({ hostId: 'host-1', candidateId: 'candidate-1' }))
      .toEqual({ hostId: 'host-1', candidateId: 'candidate-1' })
    expect(parseServerOpsDockerActionResult({
      hostId: 'host-1', containerId, action: 'restart', container: detail, warnings: [],
    })).toMatchObject({ hostId: 'host-1', action: 'restart' })
    for (const invalid of ['web-1', 'a'.repeat(63), 'g'.repeat(64), `${containerId};reboot`]) {
      expect(() => parseServerOpsDockerActionPrepareInput({ hostId: 'host-1', containerId: invalid, action: 'restart' })).toThrow()
    }
    expect(() => parseServerOpsDockerActionPrepareInput({ hostId: 'host-1', containerId, action: 'remove' })).toThrow()
  })
})
