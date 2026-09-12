import { describe, expect, test } from 'bun:test'
import {
  AgentPermissionService,
  isServerOpsReadOnlyCommand,
  revalidateSingleApprovalResult,
  type CanUseToolOptions,
} from './agent-permission-service'
import type { AgentToolApprovalPolicy } from './agent-run-extensions'

function permissionOptions(signal: AbortSignal, toolUseID: string): CanUseToolOptions {
  return { signal, toolUseID, displayName: '删除分组', description: '删除 Todo 分组' }
}

/** 提供可切换且可观察订阅清理的媒体工具审批策略。 */
function approvalPolicy(initialMode: 'ask' | 'automatic' = 'ask'): AgentToolApprovalPolicy & {
  setMode(mode: 'ask' | 'automatic'): void
  listenerCount(): number
} {
  let mode = initialMode
  const listeners = new Set<() => void>()
  return {
    getMode: () => mode,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    setMode: (nextMode) => {
      mode = nextMode
      for (const listener of [...listeners]) listener()
    },
    listenerCount: () => listeners.size,
  }
}

test('Given 扩额审批正在等待 When 切换自动模式 Then 仍按原工具参数等待确认', async () => {
  const service = new AgentPermissionService()
  const policy = approvalPolicy()
  const getMode = policy.getMode
  /** 参数必须沿首次检查及动态订阅透传，不能丢失后自动批准。 */
  const input = { runId: 'workflow-1', addMediaRuns: 2 }
  const seen: unknown[] = []
  policy.getMode = (name, params) => {
    seen.push(params)
    return params?.addMediaRuns === 2 ? 'ask' : getMode(name, params)
  }
  const requests: Array<{ requestId: string }> = []
  const pending = service.requestSingleApproval('session-1', 'canvas_resume_workflow', input,
    permissionOptions(new AbortController().signal, 'budget-request'), request => { requests.push(request) },
    { policy, onResolved: () => undefined })
  policy.setMode('automatic')
  expect(seen.length).toBeGreaterThan(0)
  expect(seen.every(value => value === input)).toBe(true)
  expect(service.getPendingRequestOwner(requests[0]!.requestId)).not.toBeNull()
  service.respondToPermission(requests[0]!.requestId, 'deny', false)
  expect((await pending).behavior).toBe('deny')
  expect(policy.listenerCount()).toBe(0)
})

describe('服务器远程命令权限', () => {
  test.each(['server_docker_action', 'server_files_mutate'])(
    'Given %s 被批准并伪造 alwaysAllow When 再次调用 Then 仍需逐次审批', async (toolName) => {
      const service = new AgentPermissionService()
      const requests: Array<{ requestId: string; allowAlways?: boolean }> = []
      const canUse = service.createCanUseTool('session-1', (request) => requests.push(request))
      const first = canUse(toolName, { hostId: 'host-1', action: 'restart' }, permissionOptions(new AbortController().signal, 'action-1'))
      expect(requests[0]?.allowAlways).toBe(false)
      service.respondToPermission(requests[0]!.requestId, 'allow', true)
      await first
      const second = canUse(toolName, { hostId: 'host-1', action: 'restart' }, permissionOptions(new AbortController().signal, 'action-2'))
      expect(requests).toHaveLength(2)
      service.respondToPermission(requests[1]!.requestId, 'deny', false)
      expect((await second).behavior).toBe('deny')
    },
  )
  test('Given ss 主动销毁 socket 参数 When 分类远程命令 Then 不得视为只读', () => {
    expect(isServerOpsReadOnlyCommand('ss -K dst 10.0.0.1')).toBe(false)
  })

  test.each([
    'uname -a', 'uptime', 'df -h', 'free -m', 'ps aux', 'ss -lntp',
    'systemctl status nginx', 'systemctl show nginx', 'systemctl is-active nginx',
    'journalctl -u nginx -n 50', 'docker ps', 'docker inspect web', 'docker logs web --tail 20', 'docker stats --no-stream',
  ])('Given 窄只读命令 %s When 权限分类 Then 自动放行', async (command) => {
    const service = new AgentPermissionService()
    const requests: unknown[] = []
    const result = await service.createCanUseTool('session-1', (request) => requests.push(request))(
      'server_exec', { hostId: 'host-1', command }, permissionOptions(new AbortController().signal, 'tool-readonly'),
    )
    expect(result.behavior).toBe('allow')
    expect(requests).toHaveLength(0)
  })

  test.each([
    'uname > /tmp/out', 'echo $(id)', 'uptime; reboot', 'ps aux | kill 1', 'sudo df -h',
    'rm -rf /tmp/x', 'systemctl restart nginx', 'docker stop web', 'apt install curl',
    'redis-cli FLUSHALL', 'psql -c "DELETE FROM users"', 'unknown-reader --all',
  ])('Given 非白名单或高风险命令 %s When 权限分类 Then 逐次审批且不能永久授权', async (command) => {
    const service = new AgentPermissionService()
    const requests: Array<{ requestId: string; allowAlways?: boolean }> = []
    const pending = service.createCanUseTool('session-1', (request) => requests.push(request))(
      'server_exec', { hostId: 'host-1', command }, permissionOptions(new AbortController().signal, 'tool-dangerous'),
    )
    expect(requests[0]?.allowAlways).toBe(false)
    service.respondToPermission(requests[0]!.requestId, 'allow', true)
    expect((await pending).behavior).toBe('allow')

    const nextRequests: Array<{ requestId: string }> = []
    const next = service.createCanUseTool('session-1', (request) => nextRequests.push(request))(
      'server_exec', { hostId: 'host-1', command }, permissionOptions(new AbortController().signal, 'tool-next'),
    )
    expect(nextRequests).toHaveLength(1)
    service.respondToPermission(nextRequests[0]!.requestId, 'deny', false)
    expect((await next).behavior).toBe('deny')
  })

  test.each(['server_list', 'server_status', 'server_connect', 'server_disconnect'])(
    'Given Server Ops 元数据工具 %s When 权限分类 Then 自动放行', async (toolName) => {
      const service = new AgentPermissionService()
      const result = await service.createCanUseTool('session-1', () => {
        throw new Error('不应发起审批')
      })(toolName, { hostId: 'host-1' }, permissionOptions(new AbortController().signal, 'tool-meta'))
      expect(result.behavior).toBe('allow')
    },
  )
})


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

test('Given 媒体审批策略已经自动 When 请求逐次审批 Then 不展示审批并保留工具调用身份', async () => {
  const service = new AgentPermissionService()
  const policy = approvalPolicy('automatic')
  const requests: unknown[] = []
  const resolved: string[] = []
  const result = await service.requestSingleApproval(
    'session-media', 'media_execute_run', { runId: 'run-1' },
    permissionOptions(new AbortController().signal, 'tool-media-auto'),
    (request) => { requests.push(request) },
    { policy, onResolved: (requestId) => { resolved.push(requestId) } },
  )

  expect(result).toEqual({
    behavior: 'allow', updatedInput: { runId: 'run-1' }, toolUseID: 'tool-media-auto',
  })
  expect(requests).toEqual([])
  expect(resolved).toEqual([])
  expect(policy.listenerCount()).toBe(0)
})

test('Given 媒体审批正在等待 When 策略切换为自动 Then 释放当前请求并通知 UI 清理', async () => {
  const service = new AgentPermissionService()
  const policy = approvalPolicy()
  const requests: Array<{ requestId: string }> = []
  const resolved: Array<{ requestId: string; behavior: string }> = []
  const pending = service.requestSingleApproval(
    'session-media', 'canvas_run_nodes', { nodeIds: ['video-1'] },
    permissionOptions(new AbortController().signal, 'tool-media-switch'),
    (request) => { requests.push(request) },
    { policy, onResolved: (requestId, behavior) => { resolved.push({ requestId, behavior }) } },
  )
  expect(requests).toHaveLength(1)
  expect(policy.listenerCount()).toBe(1)

  policy.setMode('automatic')

  expect(await pending).toEqual({
    behavior: 'allow', updatedInput: { nodeIds: ['video-1'] }, toolUseID: 'tool-media-switch',
  })
  expect(resolved).toEqual([{ requestId: requests[0]!.requestId, behavior: 'allow' }])
  expect(service.getPendingRequestOwner(requests[0]!.requestId)).toBeNull()
  expect(service.respondToPermission(requests[0]!.requestId, 'deny', false)).toBeNull()
  expect(policy.listenerCount()).toBe(0)
})

test('Given 动态媒体审批正在等待 When 工具调用中止 Then 拒绝并清理策略监听', async () => {
  const service = new AgentPermissionService()
  const policy = approvalPolicy()
  const controller = new AbortController()
  const requests: Array<{ requestId: string }> = []
  const resolved: string[] = []
  const pending = service.requestSingleApproval(
    'session-media', 'media_execute_run', { runId: 'run-1' },
    permissionOptions(controller.signal, 'tool-media-abort'),
    (request) => { requests.push(request) },
    { policy, onResolved: (requestId) => { resolved.push(requestId) } },
  )

  controller.abort()

  expect(await pending).toEqual({ behavior: 'deny', message: '操作已中止', toolUseID: 'tool-media-abort' })
  expect(service.getPendingRequestOwner(requests[0]!.requestId)).toBeNull()
  expect(policy.listenerCount()).toBe(0)
  policy.setMode('automatic')
  expect(resolved).toEqual([])
})

test('Given 动态媒体审批正在等待 When 会话结束 Then 拒绝并清理策略监听', async () => {
  const service = new AgentPermissionService()
  const policy = approvalPolicy()
  const requests: Array<{ requestId: string }> = []
  const pending = service.requestSingleApproval(
    'session-media', 'media_execute_run', { runId: 'run-1' },
    permissionOptions(new AbortController().signal, 'tool-media-session-end'),
    (request) => { requests.push(request) },
    { policy, onResolved: () => {} },
  )

  service.clearSessionPending('session-media')

  expect(await pending).toEqual({ behavior: 'deny', message: '会话已结束', toolUseID: 'tool-media-session-end' })
  expect(service.getPendingRequestOwner(requests[0]!.requestId)).toBeNull()
  expect(policy.listenerCount()).toBe(0)
})

test('Given 审批卡片发送失败 When 动态审批初始化退出 Then 拒绝 Promise 且不遗留监听', async () => {
  const service = new AgentPermissionService()
  const policy = approvalPolicy()
  const requestError = new Error('renderer unavailable')
  const pending = service.requestSingleApproval(
    'session-media', 'media_execute_run', { runId: 'run-1' },
    permissionOptions(new AbortController().signal, 'tool-media-renderer-error'),
    () => { throw requestError },
    { policy, onResolved: () => {} },
  )

  await expect(pending).rejects.toBe(requestError)
  expect(service.getPendingRequests()).toEqual([])
  expect(policy.listenerCount()).toBe(0)
})

test('Given 工具调用进入审批前已经中止 When 策略为自动 Then 优先拒绝且不订阅策略', async () => {
  const service = new AgentPermissionService()
  const policy = approvalPolicy('automatic')
  const controller = new AbortController()
  const requests: unknown[] = []
  controller.abort()

  const result = await service.requestSingleApproval(
    'session-media', 'media_execute_run', { runId: 'run-1' },
    permissionOptions(controller.signal, 'tool-media-pre-abort'),
    (request) => { requests.push(request) },
    { policy, onResolved: () => {} },
  )

  expect(result).toEqual({ behavior: 'deny', message: '操作已中止', toolUseID: 'tool-media-pre-abort' })
  expect(requests).toEqual([])
  expect(service.getPendingRequests()).toEqual([])
  expect(policy.listenerCount()).toBe(0)
})

test('Given 动态审批策略订阅抛错 When 初始化审批 Then 拒绝 Promise 且清理 pending', async () => {
  const service = new AgentPermissionService()
  const policy = approvalPolicy()
  const policyError = new Error('policy subscribe failed')
  policy.subscribe = () => { throw policyError }

  const pending = service.requestSingleApproval(
    'session-media', 'media_execute_run', { runId: 'run-1' },
    permissionOptions(new AbortController().signal, 'tool-media-subscribe-error'),
    () => {},
    { policy, onResolved: () => {} },
  )

  await expect(pending).rejects.toBe(policyError)
  expect(service.getPendingRequests()).toEqual([])
  expect(policy.listenerCount()).toBe(0)
})

test('Given 等待期间策略读取失败 When 收到策略变化 Then 拒绝当前调用并清理审批 UI', async () => {
  const service = new AgentPermissionService()
  const policy = approvalPolicy()
  const requests: Array<{ requestId: string }> = []
  const resolved: Array<{ requestId: string; behavior: string }> = []
  const pending = service.requestSingleApproval(
    'session-media', 'media_execute_run', { runId: 'run-1' },
    permissionOptions(new AbortController().signal, 'tool-media-policy-event-error'),
    (request) => { requests.push(request) },
    { policy, onResolved: (requestId, behavior) => { resolved.push({ requestId, behavior }) } },
  )
  policy.getMode = () => { throw new Error('config unavailable') }

  policy.setMode('automatic')

  expect(await pending).toEqual({
    behavior: 'deny', message: '审批策略读取失败：config unavailable', toolUseID: 'tool-media-policy-event-error',
  })
  expect(resolved).toEqual([{ requestId: requests[0]!.requestId, behavior: 'deny' }])
  expect(service.getPendingRequests()).toEqual([])
  expect(policy.listenerCount()).toBe(0)
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
