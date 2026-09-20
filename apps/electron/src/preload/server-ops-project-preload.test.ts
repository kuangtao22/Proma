import { describe, expect, test } from 'bun:test'
import { SERVER_OPS_PROJECT_CHANNELS } from '@proma/shared'
import { createServerOpsProjectPreload } from './server-ops-project-preload'

describe('Server Ops 项目 preload 边界', () => {
  test('Given 合法移动输入和回执 When 调用 Then 使用独立通道并严格解析', async () => {
    /** 记录 Renderer 实际发往主进程的请求。 */
    const calls: Array<{ channel: string; input: unknown }> = []
    const preload = createServerOpsProjectPreload(async (channel, input) => {
      calls.push({ channel, input })
      return {
        kind: 'data',
        source: {
          id: 'source-1', projectId: 'project-2', transport: 'direct', engine: 'redis', label: '缓存',
          address: '127.0.0.1', port: 6379, database: '0', tlsMode: 'disabled', hasPassword: true,
          createdAt: 1, updatedAt: 2,
        },
      }
    })
    const input = { kind: 'data' as const, id: 'source-1', fromProjectId: 'project-1', targetProjectId: 'project-2' }

    await expect(preload.moveServerOpsConnection(input)).resolves.toMatchObject({
      kind: 'data', source: { id: 'source-1', projectId: 'project-2', hasPassword: true },
    })
    expect(calls).toEqual([{ channel: SERVER_OPS_PROJECT_CHANNELS.MOVE_CONNECTION, input }])
  })

  test('Given 未知输入字段或泄漏内部凭据的回执 When 调用 Then 两侧都 fail closed', async () => {
    const preload = createServerOpsProjectPreload(async () => ({
      kind: 'data',
      source: {
        id: 'source-1', projectId: 'project-2', transport: 'direct', engine: 'redis', label: '缓存',
        address: '127.0.0.1', port: 6379, tlsMode: 'disabled', hasPassword: true,
        credentialRef: 'credential-1', createdAt: 1, updatedAt: 2,
      },
    }))
    await expect(preload.moveServerOpsConnection({
      kind: 'ssh', id: 'host-1', fromProjectId: 'project-1', targetProjectId: 'project-2', extra: true,
    } as never)).rejects.toThrow('SERVER_OPS_CONNECTION_MOVE_INPUT_INVALID')
    await expect(preload.moveServerOpsConnection({
      kind: 'data', id: 'source-1', fromProjectId: 'project-1', targetProjectId: 'project-2',
    })).rejects.toThrow('SERVER_OPS_CONNECTION_MOVE_RESULT_INVALID')
  })
})
