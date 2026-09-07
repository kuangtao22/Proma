import { describe, expect, test } from 'bun:test'
import { SERVER_OPS_DOCKER_CHANNELS } from '@proma/shared'
import {
  createServerOpsDockerPreload,
} from './server-ops-docker-preload'

/** Docker preload 测试使用的完整容器身份。 */
const CONTAINER_ID = 'a'.repeat(64)

/** 创建严格公开的容器详情。 */
function createContainerDetail() {
  return {
    containerId: CONTAINER_ID,
    name: 'api',
    image: 'registry.example/api:1.0',
    imageId: `sha256:${'b'.repeat(64)}`,
    createdAt: '2026-09-07T00:00:00Z',
    platform: 'linux',
    state: 'running' as const,
    running: true,
    exitCode: 0,
    restartCount: 1,
    ports: [{ privatePort: 3000, protocol: 'tcp' as const, publicPort: 8080, address: '127.0.0.1' }],
    mounts: [{ type: 'volume' as const, name: 'api-data', destination: '/data', readOnly: false }],
  }
}

describe('Server Ops Docker preload', () => {
  test('Given 五类合法请求 When 调用 bridge Then 使用固定通道并严格重建返回值', async () => {
    const calls: Array<{ channel: string; input: unknown }> = []
    const responses = new Map<string, unknown>([
      [SERVER_OPS_DOCKER_CHANNELS.LIST_RESOURCES, {
        hostId: 'host-1', capability: 'available', containers: [], images: [], networks: [], volumes: [], warnings: [],
      }],
      [SERVER_OPS_DOCKER_CHANNELS.GET_CONTAINER_DETAIL, {
        hostId: 'host-1', capability: 'available', container: createContainerDetail(), warnings: [],
      }],
      [SERVER_OPS_DOCKER_CHANNELS.PREPARE_ACTION, {
        candidateId: 'candidate-1', hostId: 'host-1', action: 'restart', container: createContainerDetail(), expiresAt: Date.now() + 300_000,
      }],
      [SERVER_OPS_DOCKER_CHANNELS.COMMIT_ACTION, {
        hostId: 'host-1', containerId: CONTAINER_ID, action: 'restart', container: createContainerDetail(), warnings: [],
      }],
      [SERVER_OPS_DOCKER_CHANNELS.CANCEL_ACTION, undefined],
    ])
    const bridge = createServerOpsDockerPreload(async (channel, input) => {
      calls.push({ channel, input })
      return responses.get(channel)
    })

    await expect(bridge.listServerOpsDockerResources({ hostId: 'host-1' })).resolves.toMatchObject({ capability: 'available' })
    await expect(bridge.getServerOpsDockerContainerDetail({ hostId: 'host-1', containerId: CONTAINER_ID })).resolves.toMatchObject({ container: { name: 'api' } })
    const candidate = await bridge.prepareServerOpsDockerAction({ hostId: 'host-1', containerId: CONTAINER_ID, action: 'restart' })
    await expect(bridge.commitServerOpsDockerAction({ hostId: 'host-1', candidateId: candidate.candidateId })).resolves.toMatchObject({ action: 'restart' })
    await expect(bridge.cancelServerOpsDockerAction({ hostId: 'host-1', candidateId: candidate.candidateId })).resolves.toBeUndefined()

    expect(calls.map((call) => call.channel)).toEqual([
      SERVER_OPS_DOCKER_CHANNELS.LIST_RESOURCES,
      SERVER_OPS_DOCKER_CHANNELS.GET_CONTAINER_DETAIL,
      SERVER_OPS_DOCKER_CHANNELS.PREPARE_ACTION,
      SERVER_OPS_DOCKER_CHANNELS.COMMIT_ACTION,
      SERVER_OPS_DOCKER_CHANNELS.CANCEL_ACTION,
    ])
  })

  test('Given Renderer 输入或 Main 输出夹带字段 When 调用 bridge Then fail closed', async () => {
    const bridge = createServerOpsDockerPreload(async () => ({
      hostId: 'host-1', capability: 'available', containers: [], images: [], networks: [], volumes: [], warnings: [], secret: 'blocked',
    }))
    await expect(bridge.listServerOpsDockerResources({ hostId: 'host-1', secret: 'blocked' } as never)).rejects.toThrow('SERVER_OPS_DOCKER_RESOURCES_INPUT_INVALID')
    await expect(bridge.listServerOpsDockerResources({ hostId: 'host-1' })).rejects.toThrow('SERVER_OPS_DOCKER_RESOURCES_RESULT_INVALID')
  })

  test('Given cancel 返回非空结果 When bridge 校验 Then 拒绝模糊完成状态', async () => {
    const bridge = createServerOpsDockerPreload(async () => ({ cancelled: true }))
    await expect(bridge.cancelServerOpsDockerAction({ hostId: 'host-1', candidateId: 'candidate-1' }))
      .rejects.toThrow('SERVER_OPS_DOCKER_ACTION_CANCEL_RESULT_INVALID')
  })
})
