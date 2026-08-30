import { describe, expect, test } from 'bun:test'
import { AgentPermissionService, type CanUseToolOptions } from './agent-permission-service'

function permissionOptions(signal: AbortSignal, toolUseID: string): CanUseToolOptions {
  return { signal, toolUseID, displayName: '删除分组', description: '删除 Todo 分组' }
}

test('Given a destructive planning request When it is approved Then approval is single-use and cannot create a session whitelist', async () => {
  const service = new AgentPermissionService()
  const controller = new AbortController()
  let firstRequest: { requestId: string; allowAlways?: boolean } | undefined

  const firstResult = service.requestSingleApproval(
    'session-1',
    'mcp__planning__delete_group',
    { id: 'group-1', scope: 'todo' },
    permissionOptions(controller.signal, 'tool-1'),
    (request) => { firstRequest = request },
  )

  expect(firstRequest?.allowAlways).toBe(false)
  expect(service.respondToPermission(firstRequest!.requestId, 'allow', true)).toBe('session-1')
  expect((await firstResult).behavior).toBe('allow')

  let secondRequest: { requestId: string } | undefined
  const secondResult = service.createCanUseTool('session-1', (request) => { secondRequest = request })(
    'mcp__planning__delete_group',
    { id: 'group-2', scope: 'todo' },
    permissionOptions(controller.signal, 'tool-2'),
  )

  expect(secondRequest).toBeDefined()
  expect(service.respondToPermission(secondRequest!.requestId, 'deny', false)).toBe('session-1')
  expect((await secondResult).behavior).toBe('deny')
})

test('Given 两个逐次审批工具调用 When 只批准其中一个 Then 结果只绑定对应 toolUseID', async () => {
  const service = new AgentPermissionService()
  const controller = new AbortController()
  const requestIds: string[] = []
  const first = service.requestSingleApproval(
    'session-canvas', 'canvas_run_nodes', { nodeIds: ['image-1'] },
    permissionOptions(controller.signal, 'tool-run-1'),
    (request) => { requestIds.push(request.requestId) },
  )
  const second = service.requestSingleApproval(
    'session-canvas', 'canvas_run_nodes', { nodeIds: ['image-2'] },
    permissionOptions(controller.signal, 'tool-run-2'),
    (request) => { requestIds.push(request.requestId) },
  )

  expect(service.respondToPermission(requestIds[0]!, 'allow', false)).toBe('session-canvas')
  expect(await first).toMatchObject({ behavior: 'allow', toolUseID: 'tool-run-1' })
  expect(service.getPendingRequestOwner(requestIds[1]!)).toBe('session-canvas')
  expect(service.respondToPermission(requestIds[1]!, 'deny', false)).toBe('session-canvas')
  expect(await second).toMatchObject({ behavior: 'deny', toolUseID: 'tool-run-2' })
})

describe('权限请求 owner 查询', () => {
  test('Given 待处理请求 When 只读查询 owner Then 返回会话且不消费请求', async () => {
    const service = new AgentPermissionService()
    const controller = new AbortController()
    let requestId = ''
    const result = service.requestSingleApproval(
      'session-visible',
      'Write',
      { file_path: '/tmp/demo.txt' },
      permissionOptions(controller.signal, 'tool-owner'),
      (request) => { requestId = request.requestId },
    )

    expect(service.getPendingRequestOwner(requestId)).toBe('session-visible')
    expect(service.getPendingRequestOwner('missing-request')).toBeNull()
    expect(service.respondToPermission(requestId, 'deny', false)).toBe('session-visible')
    expect((await result).behavior).toBe('deny')
  })
})
