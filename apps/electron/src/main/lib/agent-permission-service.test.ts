import { describe, expect, test } from 'bun:test'
import {
  AgentPermissionService,
  revalidateSingleApprovalResult,
  type CanUseToolOptions,
} from './agent-permission-service'

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

test('Given bypass 发起单次审批后切到 plan When 用户批准 Then fresh mode 拒绝且工具零副作用', async () => {
  /** 真实权限服务用于建立 pending 审批 Promise。 */
  const service = new AgentPermissionService()
  /** 控制本次 SDK 工具调用的中止生命周期。 */
  const controller = new AbortController()
  /** 模拟 canUseTool 每次动态读取的当前权限模式。 */
  let currentMode: 'bypassPermissions' | 'plan' = 'bypassPermissions'
  /** 记录批准后是否进入真实工具副作用。 */
  let toolEffects = 0
  /** 记录审批返回后的安全复核顺序。 */
  const revalidationSteps: string[] = []
  /** 捕获 Renderer 返回审批时使用的请求身份。 */
  let requestId = ''
  /** 发起不可白名单化的 Canvas 单次审批。 */
  const pending = service.requestSingleApproval(
    'session-canvas', 'canvas_run_nodes', { nodeIds: ['image-1'] },
    permissionOptions(controller.signal, 'tool-run-plan-switch'),
    (request) => { requestId = request.requestId },
  )
  /** 审批等待期间切换到 plan，复现入场快照过期竞态。 */
  currentMode = 'plan'
  expect(service.respondToPermission(requestId, 'allow', false)).toBe('session-canvas')

  /** 模拟 canUseTool 在审批后先复核 generation，再 fresh-read mode。 */
  const result = revalidateSingleApprovalResult(
    await pending,
    () => {
      revalidationSteps.push('stale')
      return undefined
    },
    () => {
      revalidationSteps.push('mode')
      return currentMode
    },
  )
  if (result.behavior === 'allow') toolEffects += 1

  expect(result).toEqual({
    behavior: 'deny',
    message: '计划模式下不能执行需要逐次批准的工具，请在计划获批后执行。',
    toolUseID: 'tool-run-plan-switch',
  })
  expect(revalidationSteps).toEqual(['stale', 'mode'])
  expect(toolEffects).toBe(0)
})

test('Given bypass 单次审批 When 用户拒绝 Then 保留对应 toolUseID 的稳定 deny', async () => {
  /** 真实权限服务用于验证用户拒绝结果不会被通用收口改写。 */
  const service = new AgentPermissionService()
  /** 控制本次 SDK 工具调用的中止生命周期。 */
  const controller = new AbortController()
  /** 捕获 Renderer 返回审批时使用的请求身份。 */
  let requestId = ''
  /** 发起 Canvas 单次审批并保持 bypass 模式。 */
  const pending = service.requestSingleApproval(
    'session-canvas', 'canvas_run_nodes', { nodeIds: ['image-1'] },
    permissionOptions(controller.signal, 'tool-run-user-deny'),
    (request) => { requestId = request.requestId },
  )
  expect(service.respondToPermission(requestId, 'deny', false)).toBe('session-canvas')

  const result = revalidateSingleApprovalResult(
    await pending,
    () => undefined,
    () => 'bypassPermissions',
  )

  expect(result).toEqual({
    behavior: 'deny',
    message: '用户拒绝了此操作',
    toolUseID: 'tool-run-user-deny',
  })
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
