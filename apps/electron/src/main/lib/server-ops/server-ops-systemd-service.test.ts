import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ServerOpsAuditAppendInput } from '@proma/shared'
import {
  SERVER_OPS_SYSTEMD_CAPABILITY_COMMAND,
  SERVER_OPS_SYSTEMD_LIST_COMMAND,
  ServerOpsSystemdService,
} from './server-ops-systemd-service'
import type { ServerOpsActiveConnectionIdentity } from './server-ops-connection-service'
import { ServerOpsAuditStore } from './server-ops-audit-store'
import type { ServerOpsRuntimeExecResult } from '../../../utility/server-ops/server-ops-runtime-protocol'

/** systemd 服务测试记录的一次远程执行。 */
interface ExecCall {
  hostId: string
  connectionId: string
  command: string
  timeoutMs: number
}

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
}

/** 创建可控 Promise，用于验证服务动作跨请求单飞。 */
function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve
    reject = nextReject
  })
  return { promise, resolve, reject }
}

/** 创建成功且未截断的远程执行结果。 */
function createExecResult(stdout = '', overrides: Partial<ServerOpsRuntimeExecResult> = {}): ServerOpsRuntimeExecResult {
  return { stdout, stderr: '', exitCode: 0, truncated: false, ...overrides }
}

/** 创建可被严格详情 parser 接受的 systemctl show 输出。 */
function createShowOutput(overrides: Partial<Record<string, string>> = {}): string {
  /** systemctl show 返回的固定字段。 */
  const fields: Record<string, string> = {
    Id: 'nginx.service',
    Description: 'A high performance web server',
    LoadState: 'loaded',
    ActiveState: 'active',
    SubState: 'running',
    UnitFileState: 'enabled',
    MainPID: '42',
    ActiveEnterTimestamp: 'Fri 2026-09-05 10:00:00 CST',
    ...overrides,
  }
  return Object.entries(fields).map(([key, value]) => `${key}=${value}`).join('\n')
}

/** 创建写入隔离临时目录的真实审计 Store。 */
function createRealAuditStore(): ServerOpsAuditStore {
  /** 为真实 Store 生成稳定且不重复的审计 ID。 */
  let sequence = 0
  return new ServerOpsAuditStore(mkdtempSync(join(tmpdir(), 'proma-systemd-service-')), {
    uuid: () => `audit-${++sequence}`,
    now: () => sequence,
    /** 此测试验证真实 Store schema；原生锁由独立 transaction 测试覆盖。 */
    transaction: (callback) => callback(),
  })
}

/** 创建按命令返回结果且允许切换连接身份的 systemd fixture。 */
function createFixture(options: {
  respond?: (call: ExecCall) => ServerOpsRuntimeExecResult | Promise<ServerOpsRuntimeExecResult>
  append?: (input: ServerOpsAuditAppendInput) => unknown
  now?: () => number
  uuid?: () => string
  prepareAudit?: () => Promise<void>
} = {}) {
  /** 当前 fresh-read 的连接身份。 */
  let identity: ServerOpsActiveConnectionIdentity | undefined = {
    hostId: 'host-1', connectionId: 'connection-1', generation: 1,
  }
  /** 所有实际远程调用。 */
  const execCalls: ExecCall[] = []
  /** 所有尝试写入的审计记录。 */
  const auditCalls: ServerOpsAuditAppendInput[] = []
  /** 默认生成可预测且互不相同的操作 ID。 */
  let operationSequence = 0
  /** 默认根据固定命令返回合法结果。 */
  const respond = options.respond ?? ((call: ExecCall) => {
    if (call.command === SERVER_OPS_SYSTEMD_CAPABILITY_COMMAND) return createExecResult('systemd\n/usr/bin/systemctl\n')
    if (call.command === SERVER_OPS_SYSTEMD_LIST_COMMAND) {
      return createExecResult([
        'nginx.service loaded active running A high performance web server',
        'redis.service loaded failed failed Redis data store',
      ].join('\n'))
    }
    if (call.command.startsWith('LC_ALL=C systemctl show ')) return createExecResult(createShowOutput())
    if (call.command.startsWith('LC_ALL=C journalctl ')) return createExecResult('Sep 05 10:00:00 edge nginx[42]: ready\n')
    return createExecResult()
  })
  /** 使用窄依赖构造的被测服务。 */
  const service = new ServerOpsSystemdService({
    getActiveIdentity: (hostId) => {
      if (!identity || identity.hostId !== hostId) throw new Error('SERVER_OPS_CONNECTION_NOT_ACTIVE')
      return { ...identity }
    },
    exec: async (hostId, connectionId, command, timeoutMs) => {
      /** 当前调用的完整事实。 */
      const call = { hostId, connectionId, command, timeoutMs }
      execCalls.push(call)
      return await respond(call)
    },
    audit: {
      prepareForWrites: options.prepareAudit,
      append: (input) => {
        auditCalls.push({ ...input })
        return options.append?.(input)
      },
    },
    now: options.now ?? (() => 1_000),
    uuid: options.uuid ?? (() => `operation-${++operationSequence}`),
  })
  return {
    service,
    execCalls,
    auditCalls,
    setIdentity: (next?: ServerOpsActiveConnectionIdentity) => { identity = next ? { ...next } : undefined },
  }
}

/** 断言 Promise 仅拒绝稳定错误码。 */
async function expectErrorCode(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toEqual(new Error(code))
}

describe('服务器运维 systemd Service', () => {
  test('Given 审计 schema guard 等待期间连接变化 When 执行动作 Then 不写 start 审计且不执行远程命令', async () => {
    const prepared = createDeferred<void>()
    const fixture = createFixture({ prepareAudit: () => prepared.promise })

    const pending = fixture.service.runAction({
      sessionId: 'session-1', hostId: 'host-1', unitId: 'nginx.service', action: 'restart',
    }, 1)
    fixture.setIdentity({ hostId: 'host-1', connectionId: 'connection-2', generation: 2 })
    prepared.resolve()

    await expectErrorCode(pending, 'SERVER_OPS_CONNECTION_CHANGED')
    expect(fixture.auditCalls).toHaveLength(0)
    expect(fixture.execCalls).toHaveLength(0)
  })

  test('Given PID 1 不是 systemd When 获取列表 Then 返回 unsupported 且不读取服务', async () => {
    /** 非 systemd 主机 fixture。 */
    const fixture = createFixture({ respond: () => createExecResult('init\n/usr/bin/systemctl\n') })

    await expect(fixture.service.listServices({ hostId: 'host-1' })).resolves.toEqual({
      hostId: 'host-1', capability: 'unsupported', services: [], warnings: [],
    })
    expect(fixture.execCalls).toEqual([{
      hostId: 'host-1', connectionId: 'connection-1', command: SERVER_OPS_SYSTEMD_CAPABILITY_COMMAND, timeoutMs: 5_000,
    }])
  })

  test('Given systemd 可用 When 获取列表 Then 单次读取并严格解析 active 与 failed', async () => {
    /** 默认合法列表 fixture。 */
    const fixture = createFixture()
    /** 结构化服务列表。 */
    const result = await fixture.service.listServices({ hostId: 'host-1' })

    expect(result).toEqual({
      hostId: 'host-1',
      capability: 'available',
      services: [
        { unitId: 'nginx.service', description: 'A high performance web server', loadState: 'loaded', activeState: 'active', subState: 'running', enabled: null },
        { unitId: 'redis.service', description: 'Redis data store', loadState: 'loaded', activeState: 'failed', subState: 'failed', enabled: null },
      ],
      warnings: [],
    })
    expect(fixture.execCalls.map((call) => call.command)).toEqual([
      SERVER_OPS_SYSTEMD_CAPABILITY_COMMAND,
      SERVER_OPS_SYSTEMD_LIST_COMMAND,
    ])
  })

  test('Given 超过一千条合法服务 When 获取列表 Then 只公开前一千条', async () => {
    /** 生成 1001 条合法 unit。 */
    const output = Array.from({ length: 1_001 }, (_, index) => `service-${index}.service loaded inactive dead Service ${index}`).join('\n')
    /** 大列表 fixture。 */
    const fixture = createFixture({ respond: (call) => call.command === SERVER_OPS_SYSTEMD_CAPABILITY_COMMAND
      ? createExecResult('systemd\n/usr/bin/systemctl\n')
      : createExecResult(output) })

    await expect(fixture.service.listServices({ hostId: 'host-1' })).resolves.toMatchObject({ services: { length: 1_000 } })
  })

  test('Given systemd 列表明确拒绝权限 When 获取列表 Then 返回 permission-denied 且不泄漏 stderr', async () => {
    /** systemctl 明确返回标准英文权限拒绝的 fixture。 */
    const fixture = createFixture({ respond: (call) => call.command === SERVER_OPS_SYSTEMD_CAPABILITY_COMMAND
      ? createExecResult('systemd\n/usr/bin/systemctl\n')
      : createExecResult('', { stderr: 'Failed to list units: Access denied\n', exitCode: 1 }) })

    await expect(fixture.service.listServices({ hostId: 'host-1' })).resolves.toEqual({
      hostId: 'host-1', capability: 'permission-denied', services: [], warnings: [],
    })
  })

  test('Given 用户确认 restart When 执行动作 Then 固定命令、双阶段审计并回读 active 详情', async () => {
    /** now 依次提供动作起止时间。 */
    let now = 1_000
    /** 正常动作 fixture。 */
    const fixture = createFixture({ now: () => { const current = now; now += 25; return current } })
    /** 动作后的权威结果。 */
    const result = await fixture.service.runAction({
      sessionId: 'session-1', hostId: 'host-1', unitId: 'nginx.service', action: 'restart',
    }, 1)

    expect(result.service).toMatchObject({ unitId: 'nginx.service', activeState: 'active', subState: 'running', mainPid: 42 })
    expect(fixture.execCalls.filter((call) => call.command === "LC_ALL=C systemctl restart -- 'nginx.service'")).toHaveLength(1)
    expect(fixture.auditCalls).toEqual([
      { actor: 'user', operationId: 'operation-1', windowId: 1, hostId: 'host-1', unitId: 'nginx.service', operation: 'service-restart', phase: 'start', outcome: 'pending' },
      { actor: 'user', operationId: 'operation-1', windowId: 1, hostId: 'host-1', unitId: 'nginx.service', operation: 'service-restart', phase: 'result', outcome: 'success', durationMs: 25 },
    ])
    expect(fixture.auditCalls.every((record) => record.sessionId === undefined)).toBe(true)
  })

  test('Given 同连接身份同 unit 动作在途 When 重复调用 Then 只 dispatch 一次且重复请求不写审计', async () => {
    const action = createDeferred<ServerOpsRuntimeExecResult>()
    const fixture = createFixture({ respond: (call) => call.command.includes('systemctl restart')
      ? action.promise
      : call.command === SERVER_OPS_SYSTEMD_CAPABILITY_COMMAND
        ? createExecResult('systemd\n/usr/bin/systemctl\n')
        : call.command.startsWith('LC_ALL=C systemctl show ')
          ? createExecResult(createShowOutput())
          : createExecResult('') })
    const input = { sessionId: 'session-1', hostId: 'host-1', unitId: 'nginx.service', action: 'restart' } as const
    const first = fixture.service.runAction(input, 1)

    await expectErrorCode(fixture.service.runAction(input, 1), 'SERVER_OPS_SERVICE_ACTION_IN_PROGRESS')
    expect(fixture.execCalls.filter((call) => call.command.includes('systemctl restart'))).toHaveLength(1)
    expect(fixture.auditCalls).toEqual([{
      actor: 'user', operationId: 'operation-1', windowId: 1, hostId: 'host-1', unitId: 'nginx.service',
      operation: 'service-restart', phase: 'start', outcome: 'pending',
    }])

    action.resolve(createExecResult())
    await first
  })

  test('Given 首个动作完成或拒绝 When 再次调用 Then flight 已释放并允许重试', async () => {
    for (const outcome of ['resolve', 'reject'] as const) {
      const firstAction = createDeferred<ServerOpsRuntimeExecResult>()
      let actionCalls = 0
      const fixture = createFixture({ respond: (call) => {
        if (call.command.includes('systemctl restart')) {
          actionCalls += 1
          return actionCalls === 1 ? firstAction.promise : createExecResult()
        }
        if (call.command === SERVER_OPS_SYSTEMD_CAPABILITY_COMMAND) return createExecResult('systemd\n/usr/bin/systemctl\n')
        if (call.command.startsWith('LC_ALL=C systemctl show ')) return createExecResult(createShowOutput())
        return createExecResult('')
      } })
      const input = { sessionId: 'session-1', hostId: 'host-1', unitId: 'nginx.service', action: 'restart' } as const
      const first = fixture.service.runAction(input, 1)
      if (outcome === 'resolve') firstAction.resolve(createExecResult())
      else firstAction.reject(new Error('remote secret timeout'))
      if (outcome === 'resolve') await first
      else await expectErrorCode(first, 'SERVER_OPS_SERVICE_ACTION_UNKNOWN')

      await expect(fixture.service.runAction(input, 1)).resolves.toMatchObject({ unitId: 'nginx.service' })
      expect(actionCalls).toBe(2)
      expect(fixture.auditCalls.filter((record) => record.phase === 'start').map((record) => record.operationId))
        .toEqual(['operation-1', 'operation-2'])
    }
  })

  test('Given 旧 generation 动作在途 When 新 generation 调用同 unit Then 新连接不被旧 flight 阻断', async () => {
    const oldAction = createDeferred<ServerOpsRuntimeExecResult>()
    let actionCalls = 0
    const fixture = createFixture({ respond: (call) => {
      if (call.command.includes('systemctl restart')) {
        actionCalls += 1
        return actionCalls === 1 ? oldAction.promise : createExecResult()
      }
      if (call.command === SERVER_OPS_SYSTEMD_CAPABILITY_COMMAND) return createExecResult('systemd\n/usr/bin/systemctl\n')
      if (call.command.startsWith('LC_ALL=C systemctl show ')) return createExecResult(createShowOutput())
      return createExecResult('')
    } })
    const input = { sessionId: 'session-1', hostId: 'host-1', unitId: 'nginx.service', action: 'restart' } as const
    const oldRequest = fixture.service.runAction(input, 1)
    fixture.setIdentity({ hostId: 'host-1', connectionId: 'connection-2', generation: 2 })

    await expect(fixture.service.runAction(input, 1)).resolves.toMatchObject({ unitId: 'nginx.service' })
    expect(actionCalls).toBe(2)
    oldAction.resolve(createExecResult())
    await expectErrorCode(oldRequest, 'SERVER_OPS_SERVICE_ACTION_UNKNOWN')
  })

  test('Given 成功或失败服务动作 When 使用真实 Audit Store Then 都持久化唯一 start/result', async () => {
    /** 成功动作使用的真实审计 Store。 */
    const successStore = createRealAuditStore()
    /** 成功动作 fixture，审计依赖直接绑定真实 Store。 */
    const successFixture = createFixture({ append: (input) => successStore.append(input) })
    /** 成功动作公开结果不得因真实审计合同失败而产生 warning。 */
    const successResult = await successFixture.service.runAction({
      sessionId: 'session-1', hostId: 'host-1', unitId: 'nginx.service', action: 'restart',
    }, 1)
    expect(successResult.warnings).toEqual([])
    expect(successStore.list({ operation: 'service-restart' }).records.map((record) => ({
      phase: record.phase, outcome: record.outcome, errorCode: record.errorCode,
    }))).toEqual([
      { phase: 'start', outcome: 'pending', errorCode: undefined },
      { phase: 'result', outcome: 'success', errorCode: undefined },
    ])

    /** 失败动作使用的真实审计 Store。 */
    const failureStore = createRealAuditStore()
    /** 非零退出只影响动作命令，详情回读仍返回合法数据。 */
    const failureFixture = createFixture({
      append: (input) => failureStore.append(input),
      respond: (call) => call.command.includes('systemctl stop')
        ? createExecResult('', { stderr: 'denied', exitCode: 5 })
        : call.command === SERVER_OPS_SYSTEMD_CAPABILITY_COMMAND
          ? createExecResult('systemd\n/usr/bin/systemctl\n')
          : call.command.startsWith('LC_ALL=C systemctl show ')
            ? createExecResult(createShowOutput())
            : createExecResult(''),
    })
    await expectErrorCode(failureFixture.service.runAction({
      sessionId: 'session-1', hostId: 'host-1', unitId: 'nginx.service', action: 'stop',
    }, 1), 'SERVER_OPS_SERVICE_ACTION_FAILED')
    expect(failureStore.list({ operation: 'service-stop' }).records.map((record) => ({
      phase: record.phase, outcome: record.outcome, errorCode: record.errorCode,
    }))).toEqual([
      { phase: 'start', outcome: 'pending', errorCode: undefined },
      { phase: 'result', outcome: 'error', errorCode: 'SERVER_OPS_SERVICE_ACTION_FAILED' },
    ])
  })

  test('Given 五种允许动作 When 分别执行 Then 固定命令、operation 且动作 exec 各一次', async () => {
    /** 固定动作、命令和审计 operation 的完整映射。 */
    const cases = [
      ['start', "LC_ALL=C systemctl start -- 'nginx.service'", 'service-start'],
      ['stop', "LC_ALL=C systemctl stop -- 'nginx.service'", 'service-stop'],
      ['restart', "LC_ALL=C systemctl restart -- 'nginx.service'", 'service-restart'],
      ['enable', "LC_ALL=C systemctl enable -- 'nginx.service'", 'service-enable'],
      ['disable', "LC_ALL=C systemctl disable -- 'nginx.service'", 'service-disable'],
    ] as const

    for (const [action, command, operation] of cases) {
      /** 每个动作使用独立 fixture，避免调用次数互相污染。 */
      const fixture = createFixture()
      await fixture.service.runAction({
        sessionId: 'session-1', hostId: 'host-1', unitId: 'nginx.service', action,
      }, 1)
      expect(fixture.execCalls.filter((call) => call.command === command)).toHaveLength(1)
      expect(fixture.auditCalls).toEqual([
        { actor: 'user', operationId: 'operation-1', windowId: 1, hostId: 'host-1', unitId: 'nginx.service', operation, phase: 'start', outcome: 'pending' },
        { actor: 'user', operationId: 'operation-1', windowId: 1, hostId: 'host-1', unitId: 'nginx.service', operation, phase: 'result', outcome: 'success', durationMs: 0 },
      ])
    }
  })

  test('Given enable 或 disable 成功时 stderr 有提示 When 执行动作 Then 仍成功且审计不包含 stderr', async () => {
    /** 需要允许正常 stderr 的两个配置动作。 */
    const actions = ['enable', 'disable'] as const
    for (const action of actions) {
      /** 仅动作命令返回 symlink 或兼容脚本提示的 fixture。 */
      const fixture = createFixture({ respond: (call) => call.command === `LC_ALL=C systemctl ${action} -- 'nginx.service'`
        ? createExecResult('', { stderr: `Created symlink for ${action}.\n` })
        : call.command === SERVER_OPS_SYSTEMD_CAPABILITY_COMMAND
          ? createExecResult('systemd\n/usr/bin/systemctl\n')
          : call.command.startsWith('LC_ALL=C systemctl show ')
            ? createExecResult(createShowOutput())
            : createExecResult('') })

      await expect(fixture.service.runAction({
        sessionId: 'session-1', hostId: 'host-1', unitId: 'nginx.service', action,
      }, 1)).resolves.toMatchObject({ warnings: [] })
      expect(fixture.auditCalls.at(-1)).toEqual({
        actor: 'user', operationId: 'operation-1', windowId: 1, hostId: 'host-1', unitId: 'nginx.service', operation: `service-${action}`,
        phase: 'result', outcome: 'success', durationMs: 0,
      })
      expect(JSON.stringify(fixture.auditCalls)).not.toContain('Created symlink')
    }
  })

  test('Given 动作返回后 generation 改变 When restart Then 标记 unknown 且动作只执行一次', async () => {
    /** 动作回调中切换代次的 fixture。 */
    let fixture: ReturnType<typeof createFixture>
    fixture = createFixture({ respond: (call) => {
      if (call.command.includes('systemctl restart')) {
        fixture.setIdentity({ hostId: 'host-1', connectionId: 'connection-1', generation: 2 })
        return createExecResult()
      }
      return createExecResult('systemd\n/usr/bin/systemctl\n')
    } })

    await expectErrorCode(fixture.service.runAction({
      sessionId: 'session-1', hostId: 'host-1', unitId: 'nginx.service', action: 'restart',
    }, 1), 'SERVER_OPS_SERVICE_ACTION_UNKNOWN')
    expect(fixture.execCalls.filter((call) => call.command.includes('systemctl restart'))).toHaveLength(1)
    expect(fixture.auditCalls.at(-1)).toMatchObject({ phase: 'result', outcome: 'unknown', errorCode: 'SERVER_OPS_SERVICE_ACTION_UNKNOWN' })
  })

  test('Given unit、NUL 或 action 注入 When 执行动作 Then 在 exec 与审计前拒绝', async () => {
    /** 记录所有副作用的 fixture。 */
    const fixture = createFixture()
    /** 三种恶意输入。 */
    const inputs = [
      { sessionId: 'session-1', hostId: 'host-1', unitId: 'nginx.service;reboot', action: 'restart' },
      { sessionId: 'session-1', hostId: 'host-1', unitId: 'nginx\0.service', action: 'restart' },
      { sessionId: 'session-1', hostId: 'host-1', unitId: 'nginx.service', action: 'reload' },
    ]
    for (const input of inputs) {
      await expect(fixture.service.runAction(input as never, 1)).rejects.toBeInstanceOf(Error)
    }
    expect(fixture.execCalls).toHaveLength(0)
    expect(fixture.auditCalls).toHaveLength(0)
  })

  test('Given 列表或详情输出畸形 When 读取 Then 只暴露稳定输出错误', async () => {
    /** 畸形列表 fixture。 */
    const malformedList = createFixture({ respond: (call) => call.command === SERVER_OPS_SYSTEMD_CAPABILITY_COMMAND
      ? createExecResult('systemd\n/usr/bin/systemctl\n')
      : createExecResult('not-a-service loaded active running bad') })
    await expectErrorCode(malformedList.service.listServices({ hostId: 'host-1' }), 'SERVER_OPS_SYSTEMD_OUTPUT_INVALID')

    /** 缺少固定 show 字段的详情 fixture。 */
    const malformedDetail = createFixture({ respond: (call) => call.command.startsWith('LC_ALL=C systemctl show ')
      ? createExecResult('Id=nginx.service\nActiveState=active')
      : call.command === SERVER_OPS_SYSTEMD_CAPABILITY_COMMAND
        ? createExecResult('systemd\n/usr/bin/systemctl\n')
        : createExecResult('') })
    await expectErrorCode(malformedDetail.service.getServiceDetail({ hostId: 'host-1', unitId: 'nginx.service' }), 'SERVER_OPS_SYSTEMD_OUTPUT_INVALID')
  })

  test('Given start 审计失败 When 执行动作 Then 零远程 exec', async () => {
    /** 首条审计即失败的 fixture。 */
    const fixture = createFixture({ append: () => { throw new Error('SERVER_OPS_AUDIT_WRITE_FAILED') } })

    await expectErrorCode(fixture.service.runAction({
      sessionId: 'session-1', hostId: 'host-1', unitId: 'nginx.service', action: 'restart',
    }, 1), 'SERVER_OPS_AUDIT_WRITE_FAILED')
    expect(fixture.execCalls).toHaveLength(0)
  })

  test('Given result 审计失败但动作成功 When 执行动作 Then 返回公开 warning', async () => {
    /** 第二条审计失败的计数。 */
    let appendCount = 0
    /** result 审计失败 fixture。 */
    const fixture = createFixture({ append: () => {
      appendCount += 1
      if (appendCount === 2) throw new Error('disk path and secret')
    } })

    await expect(fixture.service.runAction({
      sessionId: 'session-1', hostId: 'host-1', unitId: 'nginx.service', action: 'restart',
    }, 1))
      .resolves.toMatchObject({ warnings: ['SERVER_OPS_AUDIT_RESULT_WRITE_FAILED'] })
  })

  test('Given result 审计期间 generation 改变 When 动作返回 Then 稳定拒绝 unknown', async () => {
    /** 第二条审计触发连接代次变化的计数。 */
    let appendCount = 0
    /** 审计回调需要访问的可变 fixture。 */
    let fixture: ReturnType<typeof createFixture>
    fixture = createFixture({ append: () => {
      appendCount += 1
      if (appendCount === 2) fixture.setIdentity({ hostId: 'host-1', connectionId: 'connection-2', generation: 2 })
    } })

    await expectErrorCode(fixture.service.runAction({
      sessionId: 'session-1', hostId: 'host-1', unitId: 'nginx.service', action: 'restart',
    }, 1), 'SERVER_OPS_SERVICE_ACTION_UNKNOWN')
    expect(fixture.execCalls.filter((call) => call.command.includes('systemctl restart'))).toHaveLength(1)
  })

  test('Given 动作返回非零退出 When 执行动作 Then result 审计准确且拒绝稳定失败码', async () => {
    /** 非零动作 fixture。 */
    const fixture = createFixture({ respond: (call) => call.command.includes('systemctl stop')
      ? createExecResult('', { stderr: 'secret denial', exitCode: 5 })
      : call.command === SERVER_OPS_SYSTEMD_CAPABILITY_COMMAND
        ? createExecResult('systemd\n/usr/bin/systemctl\n')
        : call.command.startsWith('LC_ALL=C systemctl show ')
          ? createExecResult(createShowOutput())
          : createExecResult('') })

    await expectErrorCode(fixture.service.runAction({
      sessionId: 'session-1', hostId: 'host-1', unitId: 'nginx.service', action: 'stop',
    }, 1), 'SERVER_OPS_SERVICE_ACTION_FAILED')
    expect(fixture.auditCalls.at(-1)).toEqual({
      actor: 'user', operationId: 'operation-1', windowId: 1, hostId: 'host-1', unitId: 'nginx.service', operation: 'service-stop',
      phase: 'result', outcome: 'error', durationMs: 0, errorCode: 'SERVER_OPS_SERVICE_ACTION_FAILED',
    })
  })

  test('Given 固定动作返回标准 systemctl 权限拒绝 When 执行动作 Then 返回权限码并写入准确审计', async () => {
    const permissionOutputs = [
      'Failed to restart nginx.service: Access denied\n',
      'Failed to restart nginx.service: Permission denied.\n',
      "Failed to restart nginx.service: Interactive authentication required.\nSee system logs and 'systemctl status nginx.service' for details.\n",
    ]
    for (const stderr of permissionOutputs) {
      const fixture = createFixture({ respond: (call) => call.command.includes('systemctl restart')
        ? createExecResult('', { stderr, exitCode: 1 })
        : call.command === SERVER_OPS_SYSTEMD_CAPABILITY_COMMAND
          ? createExecResult('systemd\n/usr/bin/systemctl\n')
          : createExecResult('') })

      await expectErrorCode(fixture.service.runAction({
        sessionId: 'session-1', hostId: 'host-1', unitId: 'nginx.service', action: 'restart',
      }, 1), 'SERVER_OPS_SYSTEMD_PERMISSION_DENIED')
      expect(fixture.auditCalls.at(-1)).toMatchObject({
        phase: 'result', outcome: 'error', errorCode: 'SERVER_OPS_SYSTEMD_PERMISSION_DENIED',
      })
      expect(JSON.stringify(fixture.auditCalls)).not.toContain(stderr.trim())
    }
  })

  test('Given 非标准或身份不匹配的权限文本 When 动作非零退出 Then 不误判权限且不泄漏 stderr', async () => {
    const unsafeOutputs = [
      "Failed to restart nginx.service: Access denied.\nSee system logs and 'systemctl status nginx.service' for details.\n",
      'Failed to restart nginx.service: Interactive authentication required.\n',
      'Failed to restart nginx.service: Permission denied\n',
      "Failed to restart nginx.service: Permission denied.\nSee system logs and 'systemctl status nginx.service' for details.\n",
      'Failed to restart nginx.service: Permission denied by /Users/private\n',
      'Failed to restart redis.service: Access denied\n',
      'prefix Failed to restart nginx.service: Access denied\n',
      'Failed to stop nginx.service: Interactive authentication required.\n',
    ]
    for (const stderr of unsafeOutputs) {
      const fixture = createFixture({ respond: (call) => call.command.includes('systemctl restart')
        ? createExecResult('', { stderr, exitCode: 1 })
        : call.command === SERVER_OPS_SYSTEMD_CAPABILITY_COMMAND
          ? createExecResult('systemd\n/usr/bin/systemctl\n')
          : createExecResult('') })

      await expectErrorCode(fixture.service.runAction({
        sessionId: 'session-1', hostId: 'host-1', unitId: 'nginx.service', action: 'restart',
      }, 1), 'SERVER_OPS_SERVICE_ACTION_FAILED')
      expect(fixture.auditCalls.at(-1)).toMatchObject({
        phase: 'result', outcome: 'error', errorCode: 'SERVER_OPS_SERVICE_ACTION_FAILED',
      })
      expect(JSON.stringify(fixture.auditCalls)).not.toContain('/Users/private')
    }
  })

  test('Given 动作 exec Promise 拒绝 When 命令可能已 dispatch Then 结果与审计均为 unknown', async () => {
    /** 动作命令以稳定 timeout code 拒绝，模拟 dispatch 后失联。 */
    const fixture = createFixture({ respond: (call) => call.command.includes('systemctl restart')
      ? Promise.reject(new Error('SERVER_OPS_EXEC_TIMEOUT'))
      : call.command === SERVER_OPS_SYSTEMD_CAPABILITY_COMMAND
        ? createExecResult('systemd\n/usr/bin/systemctl\n')
        : call.command.startsWith('LC_ALL=C systemctl show ')
          ? createExecResult(createShowOutput())
          : createExecResult('') })

    await expectErrorCode(fixture.service.runAction({
      sessionId: 'session-1', hostId: 'host-1', unitId: 'nginx.service', action: 'restart',
    }, 1), 'SERVER_OPS_SERVICE_ACTION_UNKNOWN')
    expect(fixture.execCalls.filter((call) => call.command.includes('systemctl restart'))).toHaveLength(1)
    expect(fixture.auditCalls.at(-1)).toEqual({
      actor: 'user', operationId: 'operation-1', windowId: 1, hostId: 'host-1', unitId: 'nginx.service', operation: 'service-restart',
      phase: 'result', outcome: 'unknown', durationMs: 0, errorCode: 'SERVER_OPS_SERVICE_ACTION_UNKNOWN',
    })
  })

  test('Given 详情回读期间 generation 漂移 When 写 result 审计 Then 唯一结果记录为 unknown', async () => {
    /** journal 返回时切换身份，使漂移在 result 审计前可观测。 */
    let fixture: ReturnType<typeof createFixture>
    fixture = createFixture({ respond: (call) => {
      if (call.command === SERVER_OPS_SYSTEMD_CAPABILITY_COMMAND) return createExecResult('systemd\n/usr/bin/systemctl\n')
      if (call.command.startsWith('LC_ALL=C systemctl show ')) return createExecResult(createShowOutput())
      if (call.command.startsWith('LC_ALL=C journalctl ')) {
        fixture.setIdentity({ hostId: 'host-1', connectionId: 'connection-2', generation: 2 })
        return createExecResult('ready')
      }
      return createExecResult()
    } })

    await expectErrorCode(fixture.service.runAction({
      sessionId: 'session-1', hostId: 'host-1', unitId: 'nginx.service', action: 'restart',
    }, 1), 'SERVER_OPS_SERVICE_ACTION_UNKNOWN')
    expect(fixture.auditCalls.filter((record) => record.phase === 'result')).toEqual([{
      actor: 'user', operationId: 'operation-1', windowId: 1, hostId: 'host-1', unitId: 'nginx.service', operation: 'service-restart',
      phase: 'result', outcome: 'unknown', durationMs: 0, errorCode: 'SERVER_OPS_SERVICE_ACTION_UNKNOWN',
    }])
  })

  test('Given result 审计失败且动作失败或 unknown When 返回 Then 保留原动作错误优先级', async () => {
    /** 创建第二次 append 必然失败的依赖。 */
    const createFailingAppend = () => {
      /** 当前审计调用次数。 */
      let count = 0
      return (_input: ServerOpsAuditAppendInput): void => {
        count += 1
        if (count === 2) throw new Error('SERVER_OPS_AUDIT_WRITE_FAILED')
      }
    }
    /** 确定失败的动作 fixture。 */
    const failed = createFixture({
      append: createFailingAppend(),
      respond: (call) => call.command.includes('systemctl stop')
        ? createExecResult('', { exitCode: 5 })
        : call.command === SERVER_OPS_SYSTEMD_CAPABILITY_COMMAND
          ? createExecResult('systemd\n/usr/bin/systemctl\n')
          : call.command.startsWith('LC_ALL=C systemctl show ')
            ? createExecResult(createShowOutput())
            : createExecResult(''),
    })
    await expectErrorCode(failed.service.runAction({
      sessionId: 'session-1', hostId: 'host-1', unitId: 'nginx.service', action: 'stop',
    }, 1), 'SERVER_OPS_SERVICE_ACTION_FAILED')

    /** 结果未知的动作 fixture。 */
    const unknown = createFixture({
      append: createFailingAppend(),
      respond: (call) => call.command.includes('systemctl restart')
        ? Promise.reject(new Error('SERVER_OPS_EXEC_TIMEOUT'))
        : call.command === SERVER_OPS_SYSTEMD_CAPABILITY_COMMAND
          ? createExecResult('systemd\n/usr/bin/systemctl\n')
          : call.command.startsWith('LC_ALL=C systemctl show ')
            ? createExecResult(createShowOutput())
            : createExecResult(''),
    })
    await expectErrorCode(unknown.service.runAction({
      sessionId: 'session-1', hostId: 'host-1', unitId: 'nginx.service', action: 'restart',
    }, 1), 'SERVER_OPS_SERVICE_ACTION_UNKNOWN')
  })

  test('Given 合法详情 When 读取 Then show 使用安全 unit 且 journal 独立限制最近 100 行', async () => {
    /** 默认详情 fixture。 */
    const fixture = createFixture()
    /** 详情结果。 */
    const result = await fixture.service.getServiceDetail({ hostId: 'host-1', unitId: 'nginx.service' })

    expect(result.recentLogLines).toEqual(['Sep 05 10:00:00 edge nginx[42]: ready'])
    expect(fixture.execCalls.map((call) => call.command)).toEqual([
      SERVER_OPS_SYSTEMD_CAPABILITY_COMMAND,
      "LC_ALL=C systemctl show --no-pager --property=Id,Description,LoadState,ActiveState,SubState,UnitFileState,MainPID,ActiveEnterTimestamp -- 'nginx.service'",
      "LC_ALL=C journalctl --quiet --no-pager --lines=100 --unit='nginx.service'",
    ])
  })

  test('Given journalctl 普通用户提示 When 固定命令含 quiet Then 抑制提示并成功返回详情', async () => {
    /** 根据 journal 命令是否包含 quiet 模拟真实 journalctl 行为。 */
    const fixture = createFixture({ respond: (call) => {
      if (call.command === SERVER_OPS_SYSTEMD_CAPABILITY_COMMAND) return createExecResult('systemd\n/usr/bin/systemctl\n')
      if (call.command.startsWith('LC_ALL=C systemctl show ')) return createExecResult(createShowOutput())
      if (call.command.includes('journalctl --quiet ')) return createExecResult('Sep 05 nginx[42]: ready\n')
      return createExecResult('Sep 05 nginx[42]: ready\n', {
        stderr: 'Hint: You are currently not seeing messages from other users and the system.\n',
      })
    } })

    await expect(fixture.service.getServiceDetail({ hostId: 'host-1', unitId: 'nginx.service' }))
      .resolves.toMatchObject({ recentLogLines: ['Sep 05 nginx[42]: ready'] })
    expect(fixture.execCalls.some((call) => call.command.includes('journalctl --quiet '))).toBe(true)
  })

  test('Given list 或 detail 读取期间连接漂移 When 发布 Then fail closed', async () => {
    /** 列表 exec 后切换身份的 fixture。 */
    let listFixture: ReturnType<typeof createFixture>
    listFixture = createFixture({ respond: (call) => {
      if (call.command === SERVER_OPS_SYSTEMD_LIST_COMMAND) {
        listFixture.setIdentity({ hostId: 'host-1', connectionId: 'connection-2', generation: 2 })
        return createExecResult('nginx.service loaded active running Web server')
      }
      return createExecResult('systemd\n/usr/bin/systemctl\n')
    } })
    await expectErrorCode(listFixture.service.listServices({ hostId: 'host-1' }), 'SERVER_OPS_CONNECTION_CHANGED')

    /** journal 返回后切换身份的 fixture。 */
    let detailFixture: ReturnType<typeof createFixture>
    detailFixture = createFixture({ respond: (call) => {
      if (call.command === SERVER_OPS_SYSTEMD_CAPABILITY_COMMAND) return createExecResult('systemd\n/usr/bin/systemctl\n')
      if (call.command.startsWith('LC_ALL=C systemctl show ')) return createExecResult(createShowOutput())
      detailFixture.setIdentity({ hostId: 'host-1', connectionId: 'connection-2', generation: 2 })
      return createExecResult('ready')
    } })
    await expectErrorCode(detailFixture.service.getServiceDetail({ hostId: 'host-1', unitId: 'nginx.service' }), 'SERVER_OPS_CONNECTION_CHANGED')
  })

  test('Given exec 资格不合格 When list 或 detail Then 拒绝且不泄漏 stderr', async () => {
    /** 覆盖非零、signal、截断与 stderr 四类资格失败。 */
    const invalidResults = [
      createExecResult('', { exitCode: 1 }),
      createExecResult('', { signal: 'SIGTERM' }),
      createExecResult('', { truncated: true }),
      createExecResult('', { stderr: 'connection-1 token-canary' }),
    ]
    for (const invalidResult of invalidResults) {
      /** 能力成功、列表不合格的独立 fixture。 */
      const fixture = createFixture({ respond: (call) => call.command === SERVER_OPS_SYSTEMD_CAPABILITY_COMMAND
        ? createExecResult('systemd\n/usr/bin/systemctl\n')
        : invalidResult })
      await expectErrorCode(fixture.service.listServices({ hostId: 'host-1' }), 'SERVER_OPS_SYSTEMD_OUTPUT_INVALID')
    }
  })
})
