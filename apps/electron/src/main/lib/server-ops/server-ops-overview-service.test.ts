import { describe, expect, test } from 'bun:test'
import type { ServerOpsOverviewResult } from '@proma/shared'
import { SERVER_OPS_OVERVIEW_COMMAND } from './server-ops-overview-command'
import { ServerOpsOverviewService } from './server-ops-overview-service'
import type { ServerOpsActiveConnectionIdentity } from './server-ops-connection-service'
import type { ServerOpsRuntimeExecResult } from '../../../utility/server-ops/server-ops-runtime-protocol'

/** 创建可被真实 overview parser 接受的最小完整输出。 */
function createValidOutput(): string {
  return [
    'system\thostname\tedge-1',
    'system\tosName\tUbuntu',
    'system\tosVersion\t24.04',
    'system\tkernel\t6.8.0',
    'system\tarch\tx86_64',
    'system\tuptimeSeconds\t3600',
    'cpu\tcores\t4',
    'cpu\tusagePercent\t12.5',
    'cpu\tload\t0.1\t0.2\t0.3',
    'memory\t1024\t512\t512\t128',
    'swap\t0\t0',
    'filesystem\t/dev/vda1\text4\t/\t1024\t512\t512\t50',
    'network\t1000\t2000',
    'process\t1\tsystemd\t0.1\t0.2',
  ].join('\n')
}

/** 创建成功的完整 runtime exec 结果。 */
function createExecResult(overrides: Partial<ServerOpsRuntimeExecResult> = {}): ServerOpsRuntimeExecResult {
  return { stdout: createValidOutput(), stderr: '', exitCode: 0, truncated: false, ...overrides }
}

/** 创建由测试显式决定完成时机的 Promise。 */
function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason: unknown) => void } {
  /** 暴露给测试的成功函数。 */
  let resolvePromise: (value: T) => void = () => undefined
  /** 暴露给测试的失败函数。 */
  let rejectPromise: (reason: unknown) => void = () => undefined
  /** 等待测试显式完成的 Promise。 */
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve
    rejectPromise = reject
  })
  return { promise, resolve: resolvePromise, reject: rejectPromise }
}

/** overview 测试记录的一次 exec 调用。 */
interface ExecCall {
  hostId: string
  connectionId: string
  command: string
  timeoutMs: number
}

/** 创建只模拟窄连接边界的 overview fixture。 */
function createOverviewFixture(
  execResults: Array<ServerOpsRuntimeExecResult | Promise<ServerOpsRuntimeExecResult>> = [createExecResult()],
  initialIdentity: ServerOpsActiveConnectionIdentity = { hostId: 'host-1', connectionId: 'connection-1', generation: 1 },
  now: () => number = () => 1234,
) {
  /** 当前 fresh-read 的活跃连接身份。 */
  let identity: ServerOpsActiveConnectionIdentity | undefined = { ...initialIdentity }
  /** 所有真实发起的 exec 调用。 */
  const execCalls: ExecCall[] = []
  /** 仅依赖窄连接接口的被测服务。 */
  const service = new ServerOpsOverviewService({
    connections: {
      getActiveIdentity: (hostId) => {
        if (!identity || identity.hostId !== hostId) throw new Error('SERVER_OPS_CONNECTION_NOT_ACTIVE')
        return { ...identity }
      },
      exec: async (hostId, connectionId, command, timeoutMs) => {
        execCalls.push({ hostId, connectionId, command, timeoutMs })
        return await (execResults.shift() ?? createExecResult())
      },
    },
    now,
  })

  return {
    service,
    execCalls,
    setIdentity: (nextIdentity?: ServerOpsActiveConnectionIdentity) => { identity = nextIdentity ? { ...nextIdentity } : undefined },
  }
}

/** 读取 Promise 的稳定错误消息。 */
async function expectErrorCode(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toEqual(new Error(code))
}

describe('服务器运维 Overview Service', () => {
  test('Given 同一活跃身份的两个并发请求 When 采集完成 Then 单飞一次并返回固定参数与 capturedAt', async () => {
    /** 保持唯一 exec 在途以证明并发复用。 */
    const pendingExec = createDeferred<ServerOpsRuntimeExecResult>()
    /** 固定采集时间的 overview fixture。 */
    const fixture = createOverviewFixture([pendingExec.promise], undefined, () => 5678)

    /** 第一位调用方收到的在途结果。 */
    const first = fixture.service.getOverview({ hostId: 'host-1' })
    /** 第二位调用方复用的在途结果。 */
    const second = fixture.service.getOverview({ hostId: 'host-1' })
    expect(fixture.execCalls).toHaveLength(1)
    pendingExec.resolve(createExecResult())
    /** 两位调用方收到的概览快照。 */
    const [firstResult, secondResult] = await Promise.all([first, second])

    expect(firstResult).toEqual(secondResult)
    expect(firstResult).toMatchObject({ hostId: 'host-1', capturedAt: 5678 })
    expect(fixture.execCalls).toEqual([{
      hostId: 'host-1',
      connectionId: 'connection-1',
      command: SERVER_OPS_OVERVIEW_COMMAND,
      timeoutMs: 10_000,
    }])
  })

  test('Given 旧代次采集在途 When 重连后启动新请求 Then 两代各自 exec 且旧结果拒绝', async () => {
    /** 旧连接保持在途的 exec。 */
    const oldExec = createDeferred<ServerOpsRuntimeExecResult>()
    /** 新连接保持在途的 exec。 */
    const newExec = createDeferred<ServerOpsRuntimeExecResult>()
    /** 可切换活跃身份的 overview fixture。 */
    const fixture = createOverviewFixture([oldExec.promise, newExec.promise])

    /** 旧代次的采集请求。 */
    const oldRequest = fixture.service.getOverview({ hostId: 'host-1' })
    fixture.setIdentity({ hostId: 'host-1', connectionId: 'connection-1', generation: 2 })
    /** 新代次的采集请求。 */
    const newRequest = fixture.service.getOverview({ hostId: 'host-1' })
    expect(fixture.execCalls).toHaveLength(2)

    oldExec.resolve(createExecResult())
    await expectErrorCode(oldRequest, 'SERVER_OPS_CONNECTION_CHANGED')
    /** 旧请求完成后再次请求新代次，应继续复用新 Promise。 */
    const joinedNewRequest = fixture.service.getOverview({ hostId: 'host-1' })
    expect(fixture.execCalls).toHaveLength(2)
    newExec.resolve(createExecResult())
    await expect(newRequest).resolves.toEqual(await joinedNewRequest)
  })

  test('Given 身份在执行前、exec 后或解析后变化 When 采集 Then 三个发布关口都拒绝旧结果', async () => {
    /** 执行前第二次 fresh-read 即变化的计数。 */
    let beforeExecReads = 0
    /** 执行前身份竞态的服务。 */
    const beforeExecService = new ServerOpsOverviewService({
      connections: {
        getActiveIdentity: () => (++beforeExecReads === 1
          ? { hostId: 'host-1', connectionId: 'connection-1', generation: 1 }
          : { hostId: 'host-1', connectionId: 'connection-2', generation: 2 }),
        exec: async () => createExecResult(),
      },
      now: () => 1,
    })
    await expectErrorCode(beforeExecService.getOverview({ hostId: 'host-1' }), 'SERVER_OPS_CONNECTION_CHANGED')

    /** exec 返回后由测试切换身份的 fixture。 */
    const afterExec = createDeferred<ServerOpsRuntimeExecResult>()
    /** exec 后竞态的 overview fixture。 */
    const afterExecFixture = createOverviewFixture([afterExec.promise])
    /** 等待 exec 返回的采集请求。 */
    const afterExecRequest = afterExecFixture.service.getOverview({ hostId: 'host-1' })
    afterExecFixture.setIdentity({ hostId: 'host-1', connectionId: 'connection-2', generation: 2 })
    afterExec.resolve(createExecResult())
    await expectErrorCode(afterExecRequest, 'SERVER_OPS_CONNECTION_CHANGED')

    /** now() 被调用时切换身份，从而模拟解析完成后的竞态。 */
    let parseFixture: ReturnType<typeof createOverviewFixture>
    parseFixture = createOverviewFixture([createExecResult()], undefined, () => {
      parseFixture.setIdentity({ hostId: 'host-1', connectionId: 'connection-2', generation: 2 })
      return 2
    })
    await expectErrorCode(parseFixture.service.getOverview({ hostId: 'host-1' }), 'SERVER_OPS_CONNECTION_CHANGED')
  })

  test('Given exec 因 stale active 失败 When fresh identity 尚未反映变化 Then 仍收敛为连接竞态', async () => {
    /** stale active 错误由测试显式触发。 */
    const pendingExec = createDeferred<ServerOpsRuntimeExecResult>()
    /** 保持 fresh identity 不变以覆盖底层 stale-active 的竞态窗口。 */
    const fixture = createOverviewFixture([pendingExec.promise])
    /** 等待底层失败的采集请求。 */
    const request = fixture.service.getOverview({ hostId: 'host-1' })
    pendingExec.reject(new Error('SERVER_OPS_CONNECTION_NOT_ACTIVE'))

    await expectErrorCode(request, 'SERVER_OPS_CONNECTION_CHANGED')
  })

  test('Given exit、signal、截断或 stderr 不合格 When 采集 Then 只暴露稳定输出错误码', async () => {
    /** 依次覆盖全部 runtime 输出资格错误。 */
    const invalidResults: ServerOpsRuntimeExecResult[] = [
      createExecResult({ exitCode: 1 }),
      createExecResult({ exitCode: undefined }),
      createExecResult({ signal: 'SIGTERM' }),
      createExecResult({ truncated: true }),
      createExecResult({ stderr: 'secret warning' }),
    ]

    for (const invalidResult of invalidResults) {
      /** 每个错误使用独立服务，避免单飞状态互相影响。 */
      const fixture = createOverviewFixture([invalidResult])
      await expectErrorCode(fixture.service.getOverview({ hostId: 'host-1' }), 'SERVER_OPS_OVERVIEW_OUTPUT_INVALID')
    }
  })

  test('Given stderr 仅空白 When 采集 Then 接受结果', async () => {
    /** stderr 只有空白的合法 fixture。 */
    const fixture = createOverviewFixture([createExecResult({ stderr: ' \n\t ' })])
    await expect(fixture.service.getOverview({ hostId: 'host-1' })).resolves.toMatchObject({ hostId: 'host-1' })
  })

  test('Given stdout 无法解析 When 采集 Then 收敛为稳定输出错误码', async () => {
    /** 超过 parser 上限的坏 stdout。 */
    const fixture = createOverviewFixture([createExecResult({ stdout: 'x'.repeat((512 * 1024) + 1) })])
    await expectErrorCode(fixture.service.getOverview({ hostId: 'host-1' }), 'SERVER_OPS_OVERVIEW_OUTPUT_INVALID')
  })

  test('Given transport 泄漏秘密错误 When 采集 Then 只暴露稳定失败码', async () => {
    /** 包含连接 ID、命令和秘密 stderr 的底层错误。 */
    const transportFailure = Promise.reject(new Error('connection-1 failed: cat /secret; stderr=token-canary'))
    /** transport 失败的 overview fixture。 */
    const fixture = createOverviewFixture([transportFailure])
    await expectErrorCode(fixture.service.getOverview({ hostId: 'host-1' }), 'SERVER_OPS_OVERVIEW_FAILED')
  })

  test('Given 底层稳定 overview 错误码 When 采集 Then 保留该错误码', async () => {
    /** 三个允许透传的稳定错误码。 */
    const stableCodes = [
      'SERVER_OPS_CONNECTION_CHANGED',
      'SERVER_OPS_OVERVIEW_OUTPUT_INVALID',
      'SERVER_OPS_OVERVIEW_FAILED',
    ]
    for (const code of stableCodes) {
      /** 使用完整错误对象验证 message 仍只有 code。 */
      const fixture = createOverviewFixture([Promise.reject(new Error(code))])
      await expectErrorCode(fixture.service.getOverview({ hostId: 'host-1' }), code)
    }
  })

  test('Given 非法 input When 请求概览 Then Shared 合同拒绝且零 exec', async () => {
    /** 记录非法输入是否错误触发远程调用。 */
    const fixture = createOverviewFixture()
    await expectErrorCode(fixture.service.getOverview({ hostId: 'host-1', generation: 1 } as never), 'SERVER_OPS_OVERVIEW_INPUT_INVALID')
    expect(fixture.execCalls).toHaveLength(0)
  })

  test('Given 前次 Promise 已清理 When 再次采集 Then 发起新的 exec', async () => {
    /** 两次合法采集结果。 */
    const fixture = createOverviewFixture([createExecResult(), createExecResult()])
    /** 首次采集结果。 */
    const firstResult: ServerOpsOverviewResult = await fixture.service.getOverview({ hostId: 'host-1' })
    /** 清理完成后的第二次采集结果。 */
    const secondResult: ServerOpsOverviewResult = await fixture.service.getOverview({ hostId: 'host-1' })

    expect(firstResult).toEqual(secondResult)
    expect(fixture.execCalls).toHaveLength(2)
  })
})
