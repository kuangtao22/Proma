import { describe, expect, test } from 'bun:test'
import type { ServerOpsConnectionState, ServerOpsLogExitEvent, ServerOpsLogOutputEvent } from '@proma/shared'
import type {
  ServerOpsActiveConnectionIdentity,
  ServerOpsConnectionLogExitEvent,
  ServerOpsConnectionLogOutputEvent,
} from './server-ops-connection-service'
import { ServerOpsLogService, type ServerOpsLogConnection } from './server-ops-log-service'

/** 创建可控连接代次、runtime 事件与调用记录的日志 fixture。 */
function createFixture() {
  /** 每台主机当前连接身份。 */
  const identities = new Map<string, ServerOpsActiveConnectionIdentity>([
    ['host-1', { hostId: 'host-1', connectionId: 'connection-1', generation: 1 }],
  ])
  /** 日志启动调用。 */
  const starts: Array<{ identity: ServerOpsActiveConnectionIdentity; streamId: string; command: string }> = []
  /** 日志停止调用。 */
  const stops: Array<{ identity: ServerOpsActiveConnectionIdentity; streamId: string }> = []
  /** 日志 ACK 调用。 */
  const acks: Array<{ identity: ServerOpsActiveConnectionIdentity; streamId: string; sequence: number }> = []
  /** 可选的在途启动门闩。 */
  let startGate: Promise<void> | undefined
  /** 连接与日志 runtime 监听器。 */
  let stateListener: ((state: ServerOpsConnectionState) => void) | undefined
  let outputListener: ((event: ServerOpsConnectionLogOutputEvent) => void) | undefined
  let exitListener: ((event: ServerOpsConnectionLogExitEvent) => void) | undefined
  /** 生成稳定且不重复的流 ID。 */
  let nextStream = 0
  const connection: ServerOpsLogConnection = {
    getActiveIdentity: (hostId) => {
      const identity = identities.get(hostId)
      if (!identity) throw new Error('SERVER_OPS_CONNECTION_NOT_ACTIVE')
      return { ...identity }
    },
    startLog: async (identity, streamId, command) => {
      starts.push({ identity: { ...identity }, streamId, command })
      await startGate
    },
    stopLog: (identity, streamId) => { stops.push({ identity: { ...identity }, streamId }) },
    acknowledgeLog: (identity, streamId, sequence) => { acks.push({ identity: { ...identity }, streamId, sequence }) },
    onState: (listener) => { stateListener = listener; return () => { stateListener = undefined } },
    onLogOutput: (listener) => { outputListener = listener; return () => { outputListener = undefined } },
    onLogExit: (listener) => { exitListener = listener; return () => { exitListener = undefined } },
  }
  const service = new ServerOpsLogService({ connection, uuid: () => `stream-${++nextStream}` })
  return {
    service,
    starts,
    stops,
    acks,
    setIdentity: (identity?: ServerOpsActiveConnectionIdentity) => {
      if (identity) identities.set(identity.hostId, { ...identity })
      else identities.delete('host-1')
    },
    setStartGate: (gate?: Promise<void>) => { startGate = gate },
    emitState: (state: ServerOpsConnectionState) => stateListener?.(state),
    emitOutput: (event: ServerOpsConnectionLogOutputEvent) => outputListener?.(event),
    emitExit: (event: ServerOpsConnectionLogExitEvent) => exitListener?.(event),
  }
}

/** 创建由测试显式放行的 Promise。 */
function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolvePromise: () => void = () => undefined
  const promise = new Promise<void>((resolve) => { resolvePromise = resolve })
  return { promise, resolve: resolvePromise }
}

describe('服务器运维日志 Service', () => {
  test('Given 合法查询 When runtime started Then 返回不含 connectionId 的公开身份与严格命令', async () => {
    const fixture = createFixture()
    const gate = createDeferred()
    fixture.setStartGate(gate.promise)
    /** started 前保持在途的公开结果。 */
    const starting = fixture.service.start('owner-1', {
      hostId: 'host-1', source: { kind: 'unit', unitId: 'nginx.service' }, since: '15m', priority: 'warning', tailLines: 200,
    })
    let settled = false
    void starting.finally(() => { settled = true })
    await Promise.resolve()

    expect(settled).toBe(false)
    expect(fixture.starts[0]?.command).toBe("LC_ALL=C journalctl --no-pager --output=short-iso-precise --priority=warning --lines=200 --since='-15 minutes' --unit='nginx.service' --follow")
    gate.resolve()
    const result = await starting
    expect(result).toEqual({ hostId: 'host-1', streamId: 'stream-1' })
    expect('connectionId' in result).toBe(false)
  })

  test('Given 多 owner When 同 owner 切换来源 Then 先停旧流且不影响其它 owner', async () => {
    const fixture = createFixture()
    const first = await fixture.service.start('owner-1', { hostId: 'host-1', source: { kind: 'system' }, since: 'boot', priority: 'info', tailLines: 100 })
    const second = await fixture.service.start('owner-2', { hostId: 'host-1', source: { kind: 'system' }, since: '1h', priority: 'debug', tailLines: 50 })
    await fixture.service.start('owner-1', { hostId: 'host-1', source: { kind: 'unit', unitId: 'ssh.service' }, since: '6h', priority: 'err', tailLines: 10 })

    expect(fixture.stops.map((item) => item.streamId)).toEqual([first.streamId])
    fixture.service.acknowledge('owner-2', { hostId: second.hostId, streamId: second.streamId, sequence: 9 })
    fixture.service.acknowledge('owner-1', { hostId: second.hostId, streamId: second.streamId, sequence: 10 })
    expect(fixture.acks).toHaveLength(1)
    expect(fixture.acks[0]?.sequence).toBe(9)
  })

  test('Given start await 中连接代次漂移 When started 返回 Then 停止新流并稳定拒绝', async () => {
    const fixture = createFixture()
    const gate = createDeferred()
    fixture.setStartGate(gate.promise)
    const starting = fixture.service.start('owner-1', { hostId: 'host-1', source: { kind: 'system' }, since: '24h', priority: 'notice', tailLines: 1 })
    await Promise.resolve()
    fixture.setIdentity({ hostId: 'host-1', connectionId: 'connection-2', generation: 2 })
    gate.resolve()

    await expect(starting).rejects.toThrow('SERVER_OPS_LOG_CONNECTION_CHANGED')
    expect(fixture.stops.at(-1)?.streamId).toBe('stream-1')
  })

  test('Given owner 已有日志 When 合法新请求的主机未连接 Then 仍先停旧流并公开 stopped', async () => {
    const fixture = createFixture()
    const current = await fixture.service.start('owner-1', { hostId: 'host-1', source: { kind: 'system' }, since: 'boot', priority: 'info', tailLines: 100 })
    /** 新启动失败前必须观察到的旧流终态。 */
    const exits: ServerOpsLogExitEvent[] = []
    fixture.service.onExit((event) => exits.push(event))

    await expect(fixture.service.start('owner-1', {
      hostId: 'host-2', source: { kind: 'system' }, since: '15m', priority: 'info', tailLines: 10,
    })).rejects.toThrow('SERVER_OPS_CONNECTION_NOT_ACTIVE')

    expect(fixture.stops.at(-1)?.streamId).toBe(current.streamId)
    expect(exits).toEqual([{ hostId: 'host-1', streamId: current.streamId, reason: 'stopped' }])
    fixture.emitOutput({ hostId: 'host-1', connectionId: 'connection-1', generation: 1, streamId: current.streamId, sequence: 1, data: 'stale' })
  })

  test('Given active 流 When 输出、重复退出与 listener 抛错 Then 公开 DTO 精确且退出一次', async () => {
    const fixture = createFixture()
    const started = await fixture.service.start('owner-1', { hostId: 'host-1', source: { kind: 'system' }, since: '1h', priority: 'info', tailLines: 20 })
    /** 后续订阅者收到的公开事件。 */
    const outputs: ServerOpsLogOutputEvent[] = []
    const exits: ServerOpsLogExitEvent[] = []
    fixture.service.onOutput(() => { throw new Error('listener-secret') })
    fixture.service.onOutput((event) => outputs.push(event))
    fixture.service.onExit(() => { throw new Error('listener-secret') })
    fixture.service.onExit((event) => exits.push(event))

    const internal = { hostId: 'host-1', connectionId: 'connection-1', generation: 1, streamId: started.streamId }
    fixture.emitOutput({ ...internal, sequence: 0, data: '中文日志\n' })
    fixture.emitExit({ ...internal, reason: 'remote-exit' })
    fixture.emitExit({ ...internal, reason: 'remote-exit' })

    expect(outputs).toEqual([{ hostId: 'host-1', streamId: started.streamId, sequence: 0, data: '中文日志\n' }])
    expect(exits).toEqual([{ hostId: 'host-1', streamId: started.streamId, reason: 'remote-exit' }])
    expect(JSON.stringify([...outputs, ...exits])).not.toContain('connectionId')
  })

  test('Given 连接变化或恶意 unit When 收口或启动 Then 公开 connection-closed 且无注入副作用', async () => {
    const fixture = createFixture()
    const started = await fixture.service.start('owner-1', { hostId: 'host-1', source: { kind: 'system' }, since: 'boot', priority: 'info', tailLines: 100 })
    /** 连接变化后收到的公开终态。 */
    const exits: ServerOpsLogExitEvent[] = []
    fixture.service.onExit((event) => exits.push(event))
    fixture.setIdentity(undefined)
    fixture.emitState({ hostId: 'host-1', phase: 'disconnected' })

    expect(exits).toEqual([{ hostId: 'host-1', streamId: started.streamId, reason: 'connection-closed' }])
    await expect(fixture.service.start('owner-2', {
      hostId: 'host-1', source: { kind: 'unit', unitId: "nginx.service'; touch /tmp/pwned; echo '" }, since: '15m', priority: 'info', tailLines: 10,
    })).rejects.toThrow('SERVER_OPS_SYSTEMD_UNIT_INVALID')
    expect(fixture.starts).toHaveLength(1)
  })
})
