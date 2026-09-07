import { describe, expect, test } from 'bun:test'
import type { ServerOpsAuditAppendInput } from '@proma/shared'
import type { ServerOpsActiveConnectionIdentity } from './server-ops-connection-service'
import type { ServerOpsRuntimeExecResult } from '../../../utility/server-ops/server-ops-runtime-protocol'
import {
  SERVER_OPS_DOCKER_CAPABILITY_COMMAND,
  SERVER_OPS_DOCKER_COMMAND_PREFIX,
  SERVER_OPS_DOCKER_CONTAINERS_COMMAND,
  SERVER_OPS_DOCKER_IMAGES_COMMAND,
  SERVER_OPS_DOCKER_NETWORKS_COMMAND,
  SERVER_OPS_DOCKER_VOLUMES_COMMAND,
  ServerOpsDockerService,
} from './server-ops-docker-service'

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
}

/** 创建可控 Promise，用于验证审计准备等待期间的连接竞态。 */
function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((nextResolve) => { resolve = nextResolve })
  return { promise, resolve }
}

/** 测试使用的完整容器 ID。 */
const containerId = 'a'.repeat(64)
/** 审批期间重建后的不同容器 ID。 */
const replacementId = 'b'.repeat(64)

/** 一次远程命令调用。 */
interface ExecCall { hostId: string; connectionId: string; command: string; timeoutMs: number }

/** 创建成功且未截断的远程结果。 */
function result(stdout = '', overrides: Partial<ServerOpsRuntimeExecResult> = {}): ServerOpsRuntimeExecResult {
  return { stdout, stderr: '', exitCode: 0, truncated: false, ...overrides }
}

/** Docker 容器列表的一行结构化输出。 */
function containerLine(id = containerId, name = 'web-1'): string {
  return JSON.stringify({ ID: id, Names: name, Image: 'web:1.0',
    State: 'running', Status: 'Up 1 minute', CreatedAt: '2026-09-07 10:00:00 +0800 CST', Ports: '0.0.0.0:8080->80/tcp', Mounts: 'web-data' })
}

/** Docker inspect 的单容器结构化输出，包含必须被剥离的秘密字段。 */
function inspectOutput(id = containerId, name = '/web-1', state = 'running'): string {
  return JSON.stringify([{
    Id: id, Name: name, Created: '2026-09-07T02:00:00Z', Platform: 'linux', RestartCount: 1,
    Image: `sha256:${'c'.repeat(64)}`,
    Config: { Image: 'web:1.0', Env: ['TOKEN=secret'], Cmd: ['--password=secret'], Entrypoint: ['/entry'], Labels: { token: 'secret' } },
    State: { Status: state, Running: state === 'running', ExitCode: state === 'running' ? 0 : 137 },
    NetworkSettings: { Ports: { '80/tcp': [{ HostIp: '0.0.0.0', HostPort: '8080' }] } },
    Mounts: [{ Type: 'volume', Name: 'web-data', Source: '/private/secret', Destination: '/var/lib/web', RW: true }],
  }])
}

/** 创建可切换连接身份与命令响应的 Docker Service fixture。 */
function fixture(options: {
  respond?: (call: ExecCall) => ServerOpsRuntimeExecResult | Promise<ServerOpsRuntimeExecResult>
  audit?: (input: ServerOpsAuditAppendInput) => unknown
  prepareAudit?: () => Promise<void>
  now?: () => number
} = {}) {
  let identity: ServerOpsActiveConnectionIdentity = { hostId: 'host-1', connectionId: 'connection-1', generation: 1 }
  let sequence = 0
  const calls: ExecCall[] = []
  const audit: ServerOpsAuditAppendInput[] = []
  const defaultResponse = (call: ExecCall): ServerOpsRuntimeExecResult => {
    if (call.command === SERVER_OPS_DOCKER_CAPABILITY_COMMAND) return result(JSON.stringify('27.1.1'))
    if (call.command === SERVER_OPS_DOCKER_CONTAINERS_COMMAND) return result(`${containerLine()}\n`)
    if (call.command === SERVER_OPS_DOCKER_IMAGES_COMMAND) return result(`${JSON.stringify({ ID: `sha256:${'c'.repeat(64)}`, Repository: 'web', Tag: '1.0', Digest: '<none>', CreatedAt: 'now', Size: '120MB' })}\n`)
    if (call.command === SERVER_OPS_DOCKER_NETWORKS_COMMAND) return result(`${JSON.stringify({ ID: 'd'.repeat(64), Name: 'bridge', Driver: 'bridge', Scope: 'local', Internal: 'false' })}\n`)
    if (call.command === SERVER_OPS_DOCKER_VOLUMES_COMMAND) return result(`${JSON.stringify({ Name: 'web-data', Driver: 'local', Scope: 'local' })}\n`)
    if (call.command.includes('container inspect')) return result(inspectOutput())
    return result(containerId)
  }
  const service = new ServerOpsDockerService({
    getActiveIdentity: (hostId) => {
      if (identity.hostId !== hostId) throw new Error('SERVER_OPS_CONNECTION_NOT_ACTIVE')
      return { ...identity }
    },
    exec: async (hostId, connectionId, command, timeoutMs) => {
      const call = { hostId, connectionId, command, timeoutMs }
      calls.push(call)
      return await (options.respond ?? defaultResponse)(call)
    },
    audit: {
      prepareForWrites: options.prepareAudit,
      append: (input) => { audit.push({ ...input }); return options.audit?.(input) },
    },
    uuid: () => `docker-operation-${++sequence}`,
    now: options.now ?? (() => 1_000),
  })
  return { service, calls, audit, setIdentity: (next: ServerOpsActiveConnectionIdentity) => { identity = { ...next } } }
}

/** 断言异步操作只暴露稳定错误码。 */
async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toEqual(new Error(code))
}

describe('服务器运维 Docker Service', () => {
  test('Given 逐次批准的 Agent 动作 When 执行 Then 复用容器核验并记录真实 session', async () => {
    const f = fixture()
    await f.service.runAgentAction('session-1', { hostId: 'host-1', containerId, action: 'restart' }, () => undefined)
    expect(f.audit).toHaveLength(2)
    expect(f.audit[0]).toMatchObject({ actor: 'agent', sessionId: 'session-1', operation: 'docker-restart' })
    expect(f.audit[0]?.windowId).toBeUndefined()
  })

  test('Given Agent 准备后失去授权 When 提交动作 Then 无 start 审计及变更命令', async () => {
    const f = fixture()
    await expect(f.service.runAgentAction('session-1', { hostId: 'host-1', containerId, action: 'restart' }, () => {
      throw new Error('SERVER_OPS_AGENT_ACCESS_REQUIRED')
    })).rejects.toThrow('SERVER_OPS_AGENT_ACCESS_REQUIRED')
    expect(f.audit).toHaveLength(0)
    expect(f.calls.some((call) => call.command.includes(' container restart '))).toBe(false)
    f.service.dispose()
  })
  test('Given 审计 schema guard 等待期间连接变化 When 提交动作 Then 不写 start 审计且不 dispatch', async () => {
    const prepared = createDeferred<void>()
    const prepareStarted = createDeferred<void>()
    const f = fixture({ prepareAudit: () => {
      prepareStarted.resolve()
      return prepared.promise
    } })
    const candidate = await f.service.prepareAction(7, { hostId: 'host-1', containerId, action: 'restart' })

    const pending = f.service.commitAction(7, { hostId: 'host-1', candidateId: candidate.candidateId })
    await prepareStarted.promise
    f.setIdentity({ hostId: 'host-1', connectionId: 'connection-2', generation: 2 })
    prepared.resolve()

    await expectCode(pending, 'SERVER_OPS_DOCKER_ACTION_CONFLICT')
    expect(f.audit).toHaveLength(0)
    expect(f.calls.filter((call) => call.command.includes(' container restart '))).toHaveLength(0)
  })

  test('Given prepare inspect 等待期间 owner 被销毁 When inspect 迟到 Then 不签发可提交候选', async () => {
    const inspect = createDeferred<ServerOpsRuntimeExecResult>()
    const inspectStarted = createDeferred<void>()
    const f = fixture({ respond: (call) => {
      if (call.command === SERVER_OPS_DOCKER_CAPABILITY_COMMAND) return result(JSON.stringify('27.1.1'))
      if (call.command.includes('container inspect')) { inspectStarted.resolve(); return inspect.promise }
      return result()
    } })

    const pending = f.service.prepareAction(7, { hostId: 'host-1', containerId, action: 'restart' })
    await inspectStarted.promise
    f.service.disposeOwner(7)
    inspect.resolve(result(inspectOutput()))

    await expectCode(pending, 'SERVER_OPS_ACCESS_DENIED')
    expect(f.audit).toHaveLength(0)
    expect(f.calls.some((call) => call.command.includes(' container restart '))).toBe(false)
  })

  test('Given 本地 Docker 可用 When 获取资源 Then 固定 socket 命令并返回四类脱敏摘要', async () => {
    const f = fixture()
    const snapshot = await f.service.listResources({ hostId: 'host-1' })
    expect(snapshot).toMatchObject({ capability: 'available', containers: [{ containerId, names: ['web-1'] }],
      images: [{ repository: 'web' }], networks: [{ name: 'bridge' }], volumes: [{ name: 'web-data' }] })
    expect(snapshot.containers[0]?.imageId).toBeUndefined()
    expect(f.calls.map((call) => call.command)).toEqual([
      SERVER_OPS_DOCKER_CAPABILITY_COMMAND, SERVER_OPS_DOCKER_CONTAINERS_COMMAND,
      SERVER_OPS_DOCKER_IMAGES_COMMAND, SERVER_OPS_DOCKER_NETWORKS_COMMAND, SERVER_OPS_DOCKER_VOLUMES_COMMAND,
    ])
    expect(f.calls.slice(1).every((call) => call.command.startsWith(SERVER_OPS_DOCKER_COMMAND_PREFIX))).toBe(true)
    expect(f.calls.some((call) => /sudo|DOCKER_HOST=|context use/u.test(call.command))).toBe(false)
  })

  test.each([
    ['cli-missing', result('', { exitCode: 127 })],
    ['permission-denied', result('', { stderr: 'permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock', exitCode: 1 })],
    ['daemon-unavailable', result('', { stderr: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?', exitCode: 1 })],
  ] as const)('Given Docker %s When 获取资源 Then 返回明确能力且不继续枚举', async (capability, capabilityResult) => {
    const f = fixture({ respond: () => capabilityResult })
    await expect(f.service.listResources({ hostId: 'host-1' })).resolves.toEqual({
      hostId: 'host-1', capability, containers: [], images: [], networks: [], volumes: [], warnings: [],
    })
    expect(f.calls).toHaveLength(1)
  })

  test('Given inspect 含秘密 When 读取详情 Then 仅公开白名单且无敏感启动信息或挂载源', async () => {
    const f = fixture()
    const detail = await f.service.getContainerDetail({ hostId: 'host-1', containerId })
    expect(detail.container).toMatchObject({ containerId, name: 'web-1', mounts: [{ destination: '/var/lib/web' }] })
    expect(JSON.stringify(detail)).not.toMatch(/TOKEN|password|Entrypoint|Labels|private\/secret|Source/)
    expect(f.calls.at(-1)?.command).toBe(`${SERVER_OPS_DOCKER_COMMAND_PREFIX} container inspect -- '${containerId}'`)
  })

  test('Given 旧完整容器 ID 已删除 When 读取详情或准备动作 Then 返回稳定不存在错误', async () => {
    const f = fixture({ respond: (call) => call.command === SERVER_OPS_DOCKER_CAPABILITY_COMMAND
      ? result(JSON.stringify('27.1.1'))
      : call.command.includes('container inspect')
        ? result('', { stderr: `Error: No such container: ${containerId}\n`, exitCode: 1 })
        : result() })
    await expectCode(f.service.getContainerDetail({ hostId: 'host-1', containerId }), 'SERVER_OPS_DOCKER_CONTAINER_NOT_FOUND')
    await expectCode(f.service.prepareAction(7, { hostId: 'host-1', containerId, action: 'restart' }), 'SERVER_OPS_DOCKER_CONTAINER_NOT_FOUND')
    expect(f.audit).toHaveLength(0)
  })

  test('Given 输出超限、截断或名称恶意 When 读取 Then fail closed 且不发布部分结果', async () => {
    const cases = [
      result(Array.from({ length: 501 }, () => containerLine()).join('\n')),
      result(containerLine(), { truncated: true }),
      result(containerLine(containerId, 'bad\nname')),
    ]
    for (const containersResult of cases) {
      const f = fixture({ respond: (call) => call.command === SERVER_OPS_DOCKER_CAPABILITY_COMMAND
        ? result(JSON.stringify('27.1.1')) : call.command === SERVER_OPS_DOCKER_CONTAINERS_COMMAND ? containersResult : result('') })
      await expectCode(f.service.listResources({ hostId: 'host-1' }), 'SERVER_OPS_DOCKER_OUTPUT_INVALID')
    }
  })

  test('Given 用户批准 restart When commit Then fresh inspect、审计前置、单次动作并回查', async () => {
    const f = fixture()
    const candidate = await f.service.prepareAction(7, { hostId: 'host-1', containerId, action: 'restart' })
    const actionResult = await f.service.commitAction(7, { hostId: 'host-1', candidateId: candidate.candidateId })
    expect(actionResult.container).toMatchObject({ containerId, running: true })
    expect(f.calls.filter((call) => call.command.includes('container restart'))).toHaveLength(1)
    expect(f.audit).toEqual([
      { actor: 'user', operationId: 'docker-operation-2', windowId: 7, hostId: 'host-1', resourceType: 'docker-container', containerId,
        operation: 'docker-restart', phase: 'start', outcome: 'pending' },
      { actor: 'user', operationId: 'docker-operation-2', windowId: 7, hostId: 'host-1', resourceType: 'docker-container', containerId,
        operation: 'docker-restart', phase: 'result', outcome: 'success', durationMs: 0 },
    ])
  })

  test('Given 审批期间容器被重建或连接代次改变 When commit Then 拒绝旧候选且不执行动作', async () => {
    for (const reason of ['container', 'connection'] as const) {
      let inspectCount = 0
      const f = fixture({ respond: (call) => {
        if (call.command === SERVER_OPS_DOCKER_CAPABILITY_COMMAND) return result(JSON.stringify('27.1.1'))
        if (call.command.includes('container inspect')) {
          inspectCount += 1
          return result(inspectOutput(reason === 'container' && inspectCount > 1 ? replacementId : containerId))
        }
        return result()
      } })
      const candidate = await f.service.prepareAction(7, { hostId: 'host-1', containerId, action: 'restart' })
      if (reason === 'connection') f.setIdentity({ hostId: 'host-1', connectionId: 'connection-2', generation: 2 })
      await expectCode(f.service.commitAction(7, { hostId: 'host-1', candidateId: candidate.candidateId }), 'SERVER_OPS_DOCKER_ACTION_CONFLICT')
      expect(f.calls.some((call) => call.command.includes('container restart'))).toBe(false)
      expect(f.audit).toHaveLength(0)
    }
  })

  test('Given commit inspect 等待期间候选被取消 When inspect 迟到 Then 不写审计且不执行动作', async () => {
    const secondInspect = createDeferred<ServerOpsRuntimeExecResult>()
    const inspectStarted = createDeferred<void>()
    let inspectCount = 0
    const f = fixture({ respond: (call) => {
      if (call.command === SERVER_OPS_DOCKER_CAPABILITY_COMMAND) return result(JSON.stringify('27.1.1'))
      if (call.command.includes('container inspect')) {
        inspectCount += 1
        if (inspectCount === 2) { inspectStarted.resolve(); return secondInspect.promise }
        return result(inspectOutput())
      }
      return result()
    } })
    const candidate = await f.service.prepareAction(7, { hostId: 'host-1', containerId, action: 'restart' })

    const pending = f.service.commitAction(7, { hostId: 'host-1', candidateId: candidate.candidateId })
    await inspectStarted.promise
    f.service.cancelAction(7, { hostId: 'host-1', candidateId: candidate.candidateId })
    secondInspect.resolve(result(inspectOutput()))

    await expectCode(pending, 'SERVER_OPS_DOCKER_ACTION_EXPIRED')
    expect(f.audit).toHaveLength(0)
    expect(f.calls.some((call) => call.command.includes(' container restart '))).toBe(false)
  })

  test('Given 审计 guard 等待期间候选过期或容器变化 When guard 完成 Then fresh 复核阻断旧批准', async () => {
    for (const reason of ['expired', 'container'] as const) {
      const prepared = createDeferred<void>()
      const prepareStarted = createDeferred<void>()
      let now = 1_000
      let inspectCount = 0
      const f = fixture({
        now: () => now,
        prepareAudit: () => { prepareStarted.resolve(); return prepared.promise },
        respond: (call) => {
          if (call.command === SERVER_OPS_DOCKER_CAPABILITY_COMMAND) return result(JSON.stringify('27.1.1'))
          if (call.command.includes('container inspect')) {
            inspectCount += 1
            return result(inspectOutput(reason === 'container' && inspectCount >= 3 ? replacementId : containerId))
          }
          return result()
        },
      })
      const candidate = await f.service.prepareAction(7, { hostId: 'host-1', containerId, action: 'restart' })

      const pending = f.service.commitAction(7, { hostId: 'host-1', candidateId: candidate.candidateId })
      await prepareStarted.promise
      if (reason === 'expired') now = candidate.expiresAt
      prepared.resolve()

      await expectCode(pending, reason === 'expired' ? 'SERVER_OPS_DOCKER_ACTION_EXPIRED' : 'SERVER_OPS_DOCKER_ACTION_CONFLICT')
      expect(f.audit).toHaveLength(0)
      expect(f.calls.some((call) => call.command.includes(' container restart '))).toBe(false)
      if (reason === 'container') expect(inspectCount).toBe(3)
    }
  })

  test('Given start 审计失败 When commit Then 零动作；同容器动作在途 When 重复提交 Then 单飞拒绝', async () => {
    const failed = fixture({ audit: () => { throw new Error('disk secret') } })
    const failedCandidate = await failed.service.prepareAction(7, { hostId: 'host-1', containerId, action: 'start' })
    await expectCode(failed.service.commitAction(7, { hostId: 'host-1', candidateId: failedCandidate.candidateId }), 'SERVER_OPS_AUDIT_WRITE_FAILED')
    expect(failed.calls.some((call) => call.command.includes('container start'))).toBe(false)

    const deferred = Promise.withResolvers<ServerOpsRuntimeExecResult>()
    const busy = fixture({ respond: (call) => call.command.includes('container restart') ? deferred.promise
      : call.command === SERVER_OPS_DOCKER_CAPABILITY_COMMAND ? result(JSON.stringify('27.1.1'))
        : call.command.includes('container inspect') ? result(inspectOutput()) : result() })
    const candidate = await busy.service.prepareAction(7, { hostId: 'host-1', containerId, action: 'restart' })
    const first = busy.service.commitAction(7, { hostId: 'host-1', candidateId: candidate.candidateId })
    await expectCode(busy.service.commitAction(7, { hostId: 'host-1', candidateId: candidate.candidateId }), 'SERVER_OPS_DOCKER_ACTION_BUSY')
    deferred.resolve(result())
    await first
  })

  test('Given 动作超时 When commit Then 不重试并只读回查后记录 unknown', async () => {
    const f = fixture({ respond: (call) => call.command.includes('container restart')
      ? Promise.reject(new Error('SERVER_OPS_EXEC_TIMEOUT'))
      : call.command === SERVER_OPS_DOCKER_CAPABILITY_COMMAND ? result(JSON.stringify('27.1.1'))
        : call.command.includes('container inspect') ? result(inspectOutput()) : result() })
    const candidate = await f.service.prepareAction(7, { hostId: 'host-1', containerId, action: 'restart' })
    await expectCode(f.service.commitAction(7, { hostId: 'host-1', candidateId: candidate.candidateId }), 'SERVER_OPS_DOCKER_ACTION_UNKNOWN')
    expect(f.calls.filter((call) => call.command.includes('container restart'))).toHaveLength(1)
    /** prepare、两次提交前复核和动作后对账各读取一次。 */
    expect(f.calls.filter((call) => call.command.includes('container inspect'))).toHaveLength(4)
    expect(f.audit.at(-1)).toMatchObject({ phase: 'result', outcome: 'unknown', errorCode: 'SERVER_OPS_DOCKER_ACTION_UNKNOWN' })
  })
})
