import { describe, expect, test } from 'bun:test'
import type {
  ServerOpsConnectionState,
  ServerOpsHost,
  ServerOpsTerminalExitEvent,
  ServerOpsTerminalOutputEvent,
} from '@proma/shared'
import { ServerOpsConnectionService } from './server-ops-connection-service'
import type { ServerOpsResolvedCredential } from './server-ops-credential-store'
import type { ServerOpsRuntimeConnectionInput } from './server-ops-runtime-client'
import type { ServerOpsRuntimeLogExitEvent, ServerOpsRuntimeLogOutputEvent } from './server-ops-runtime-client'
import type { ServerOpsRuntimeConnectResult } from '../../../utility/server-ops/server-ops-runtime-protocol'

/** 创建连接测试使用的公开主机。 */
function createHost(overrides: Partial<ServerOpsHost> = {}): ServerOpsHost {
  return {
    id: 'host-1',
    name: '生产 API',
    address: 'api.internal',
    port: 22,
    username: 'deploy',
    authMethod: 'password',
    tags: [],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

/** 创建可观察调用记录的连接服务依赖。 */
function createDependencies(
  results: Array<ServerOpsRuntimeConnectResult | Promise<ServerOpsRuntimeConnectResult>>,
  host = createHost(),
  initialTrustedKey?: { algorithm: string; fingerprint: string },
) {
  /** runtime 收到的真实连接请求。 */
  const connects: ServerOpsRuntimeConnectionInput[] = []
  /** runtime 收到的终端输入。 */
  const writes: string[] = []
  /** runtime 收到的断开请求。 */
  const disconnects: Array<{ hostId: string; connectionId: string }> = []
  /** runtime 收到的日志启动请求。 */
  const logStarts: Array<{ hostId: string; connectionId: string; streamId: string; command: string }> = []
  /** runtime 收到的日志停止请求。 */
  const logStops: Array<{ hostId: string; connectionId: string; streamId: string }> = []
  /** runtime 收到的日志 ACK。 */
  const logAcks: Array<{ hostId: string; connectionId: string; streamId: string; sequence: number }> = []
  /** 当前 Host Key 固定值。 */
  let trustedKey: { algorithm: string; fingerprint: string } | undefined = initialTrustedKey
  /** 当前短期或已解密凭据。 */
  let credential: ServerOpsResolvedCredential | undefined
  /** 被安全保存的凭据引用。 */
  let credentialRef: string | undefined = host.credentialRef
  /** 模拟公开主机资产是否仍存在。 */
  let hostExists = true
  /** runtime 输出监听器。 */
  let outputListener: ((event: ServerOpsTerminalOutputEvent) => void) | undefined
  /** runtime 退出监听器。 */
  let exitListener: ((event: ServerOpsTerminalExitEvent) => void) | undefined
  /** runtime 日志输出监听器。 */
  let logOutputListener: ((event: ServerOpsRuntimeLogOutputEvent) => void) | undefined
  /** runtime 日志退出监听器。 */
  let logExitListener: ((event: ServerOpsRuntimeLogExitEvent) => void) | undefined
  /** 连续生成 connection/candidate ID 的计数。 */
  let nextId = 0

  const service = new ServerOpsConnectionService({
    hosts: {
      get: (hostId) => hostExists && hostId === host.id ? { ...host } : undefined,
      setCredentialRef: (_hostId, ref) => { credentialRef = ref; return { ...host, credentialRef: ref } },
    },
    credentials: {
      setVolatile: (_hostId, value) => { credential = value },
      remember: (_hostId, value) => { credential = value; return 'credential-1' },
      resolve: () => credential,
      getCredentialRef: () => credentialRef,
    },
    trust: {
      get: () => trustedKey,
      check: (_host, observed) => !trustedKey
        ? { status: 'unknown', observed }
        : trustedKey.algorithm === observed.algorithm && trustedKey.fingerprint === observed.fingerprint
          ? { status: 'trusted', trusted: trustedKey }
          : { status: 'changed', trusted: trustedKey, observed },
      trust: (_host, key) => { trustedKey = key },
    },
    runtime: {
      connect: async (input) => { connects.push(input); return results.shift() ?? { status: 'connected', hostKey: trustedKey! } },
      exec: async () => ({ stdout: '', stderr: '', truncated: false }),
      startLog: async (hostId, connectionId, streamId, command) => { logStarts.push({ hostId, connectionId, streamId, command }) },
      stopLog: (hostId, connectionId, streamId) => { logStops.push({ hostId, connectionId, streamId }) },
      acknowledgeLog: (hostId, connectionId, streamId, sequence) => { logAcks.push({ hostId, connectionId, streamId, sequence }) },
      disconnect: (hostId, connectionId) => { disconnects.push({ hostId, connectionId }) },
      input: (_hostId, _connectionId, data) => { writes.push(data) },
      resize: () => undefined,
      acknowledgeOutput: () => undefined,
      onOutput: (listener) => { outputListener = listener; return () => { outputListener = undefined } },
      onExit: (listener) => { exitListener = listener; return () => { exitListener = undefined } },
      onLogOutput: (listener) => { logOutputListener = listener; return () => { logOutputListener = undefined } },
      onLogExit: (listener) => { logExitListener = listener; return () => { logExitListener = undefined } },
    },
    uuid: () => `id-${++nextId}`,
    resolveSshAgent: () => '/tmp/agent.sock',
    readPrivateKey: () => Buffer.from('private-key'),
  })

  return {
    service,
    connects,
    disconnects,
    logStarts,
    logStops,
    logAcks,
    writes,
    getTrustedKey: () => trustedKey,
    deleteHost: () => { hostExists = false },
    emitOutput: (event: ServerOpsTerminalOutputEvent) => outputListener?.(event),
    emitExit: (event: ServerOpsTerminalExitEvent) => exitListener?.(event),
    emitLogOutput: (event: ServerOpsRuntimeLogOutputEvent) => logOutputListener?.(event),
    emitLogExit: (event: ServerOpsRuntimeLogExitEvent) => logExitListener?.(event),
  }
}

/** 创建由测试显式决定完成时机的 Promise。 */
function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  /** 暴露给测试的完成函数。 */
  let resolvePromise: (value: T) => void = () => undefined
  /** 等待测试显式完成的 Promise。 */
  const promise = new Promise<T>((resolve) => { resolvePromise = resolve })
  return { promise, resolve: resolvePromise }
}

describe('服务器运维连接 Service', () => {
  test('两个并发连接只接受最后一次连接并释放过期 runtime', async () => {
    /** 两次 runtime 连接共用的可信 Host Key。 */
    const hostKey = { algorithm: 'ssh-ed25519', fingerprint: 'SHA256:concurrent' }
    /** 第一条连接保持在途，模拟比后发连接更晚返回。 */
    const firstResult = createDeferred<ServerOpsRuntimeConnectResult>()
    /** 第二条连接保持在途，允许测试控制完成顺序。 */
    const secondResult = createDeferred<ServerOpsRuntimeConnectResult>()
    const fixture = createDependencies([firstResult.promise, secondResult.promise], createHost(), hostKey)

    const firstConnect = fixture.service.connect({ hostId: 'host-1', cols: 80, rows: 24, credential: { kind: 'password', password: 'first', remember: false } })
    const secondConnect = fixture.service.connect({ hostId: 'host-1', cols: 100, rows: 30, credential: { kind: 'password', password: 'second', remember: false } })
    expect(fixture.disconnects).toContainEqual({ hostId: 'host-1', connectionId: 'id-1' })
    secondResult.resolve({ status: 'connected', hostKey })
    const secondState = await secondConnect
    firstResult.resolve({ status: 'connected', hostKey })
    const firstState = await firstConnect

    expect(secondState).toMatchObject({ phase: 'connected', connectionId: 'id-2' })
    expect(firstState).toMatchObject({ phase: 'connected', connectionId: 'id-2' })
    expect(fixture.service.getState('host-1')).toMatchObject({ phase: 'connected', connectionId: 'id-2' })
    expect(fixture.disconnects).toContainEqual({ hostId: 'host-1', connectionId: 'id-1' })
  })

  test('连接在途时主动断开会取消该连接且忽略迟到结果', async () => {
    /** runtime 连接共用的可信 Host Key。 */
    const hostKey = { algorithm: 'ssh-ed25519', fingerprint: 'SHA256:disconnecting' }
    /** 保持连接在途直到主动断开完成。 */
    const pendingResult = createDeferred<ServerOpsRuntimeConnectResult>()
    const fixture = createDependencies([pendingResult.promise], createHost(), hostKey)

    const connectPromise = fixture.service.connect({ hostId: 'host-1', cols: 80, rows: 24, credential: { kind: 'password', password: 'secret', remember: false } })
    const disconnected = fixture.service.disconnect('host-1')
    expect(fixture.disconnects).toContainEqual({ hostId: 'host-1', connectionId: 'id-1' })
    pendingResult.resolve({ status: 'connected', hostKey })
    const staleState = await connectPromise

    expect(disconnected).toEqual({ hostId: 'host-1', phase: 'disconnected' })
    expect(staleState).toEqual({ hostId: 'host-1', phase: 'disconnected' })
    expect(fixture.service.getState('host-1')).toEqual({ hostId: 'host-1', phase: 'disconnected' })
    expect(fixture.disconnects).toContainEqual({ hostId: 'host-1', connectionId: 'id-1' })
  })

  test('删除主机后走断开路径会阻止在途连接复活已删除资产', async () => {
    /** runtime 连接共用的可信 Host Key。 */
    const hostKey = { algorithm: 'ssh-ed25519', fingerprint: 'SHA256:deleted' }
    /** 保持连接在途，模拟资产删除与 runtime 返回交错。 */
    const pendingResult = createDeferred<ServerOpsRuntimeConnectResult>()
    const fixture = createDependencies([pendingResult.promise], createHost(), hostKey)

    const connectPromise = fixture.service.connect({ hostId: 'host-1', cols: 80, rows: 24, credential: { kind: 'password', password: 'secret', remember: false } })
    fixture.deleteHost()
    fixture.service.disconnect('host-1')
    pendingResult.resolve({ status: 'connected', hostKey })
    await connectPromise

    expect(fixture.service.getState('host-1')).toEqual({ hostId: 'host-1', phase: 'disconnected' })
    expect(fixture.disconnects).toContainEqual({ hostId: 'host-1', connectionId: 'id-1' })
  })

  test('只转发当前活跃连接的 output 和 exit 事件', async () => {
    /** 两次连接共用的可信 Host Key。 */
    const hostKey = { algorithm: 'ssh-ed25519', fingerprint: 'SHA256:events' }
    const fixture = createDependencies([
      { status: 'connected', hostKey },
      { status: 'connected', hostKey },
    ], createHost(), hostKey)
    /** Service 实际转发的终端输出。 */
    const outputs: ServerOpsTerminalOutputEvent[] = []
    /** Service 实际转发的终端退出。 */
    const exits: ServerOpsTerminalExitEvent[] = []
    fixture.service.onOutput((event) => outputs.push(event))
    fixture.service.onExit((event) => exits.push(event))

    const oldConnection = await fixture.service.connect({ hostId: 'host-1', cols: 80, rows: 24, credential: { kind: 'password', password: 'first', remember: false } })
    const currentConnection = await fixture.service.connect({ hostId: 'host-1', cols: 100, rows: 30, credential: { kind: 'password', password: 'second', remember: false } })
    fixture.emitOutput({ hostId: 'host-1', connectionId: oldConnection.connectionId!, sequence: 1, data: 'stale' })
    fixture.emitExit({ hostId: 'host-1', connectionId: oldConnection.connectionId!, exitCode: 0, message: 'stale exit' })
    fixture.emitOutput({ hostId: 'host-1', connectionId: currentConnection.connectionId!, sequence: 2, data: 'current' })

    expect(outputs).toEqual([{ hostId: 'host-1', connectionId: 'id-2', sequence: 2, data: 'current' }])
    expect(exits).toEqual([])
    expect(fixture.service.getState('host-1')).toMatchObject({ phase: 'connected', connectionId: 'id-2' })

    fixture.emitExit({ hostId: 'host-1', connectionId: currentConnection.connectionId!, exitCode: 0, message: 'current exit' })
    expect(exits).toEqual([{ hostId: 'host-1', connectionId: 'id-2', exitCode: 0, message: 'current exit' }])
    expect(fixture.service.getState('host-1')).toEqual({ hostId: 'host-1', phase: 'disconnected', message: 'current exit' })
  })

  test('释放 Service 会取消在途连接并阻止迟到结果恢复状态', async () => {
    /** runtime 连接共用的可信 Host Key。 */
    const hostKey = { algorithm: 'ssh-ed25519', fingerprint: 'SHA256:dispose' }
    /** 保持连接在途直到 Service 完成释放。 */
    const pendingResult = createDeferred<ServerOpsRuntimeConnectResult>()
    const fixture = createDependencies([pendingResult.promise], createHost(), hostKey)

    const connectPromise = fixture.service.connect({ hostId: 'host-1', cols: 80, rows: 24, credential: { kind: 'password', password: 'secret', remember: false } })
    fixture.service.dispose()
    expect(fixture.disconnects).toContainEqual({ hostId: 'host-1', connectionId: 'id-1' })
    pendingResult.resolve({ status: 'connected', hostKey })
    const staleState = await connectPromise

    expect(staleState).toEqual({ hostId: 'host-1', phase: 'disconnected' })
    expect(fixture.service.getState('host-1')).toEqual({ hostId: 'host-1', phase: 'disconnected' })
    expect(fixture.disconnects).toContainEqual({ hostId: 'host-1', connectionId: 'id-1' })
  })

  test('首次 Host Key 确认后使用 fresh 数据重新连接', async () => {
    /** 首次观测到的公开 Host Key。 */
    const hostKey = { algorithm: 'ssh-ed25519', fingerprint: 'SHA256:first' }
    /** 先拒绝未知 Host Key、确认后成功的依赖。 */
    const fixture = createDependencies([
      { status: 'host-key-rejected', observedHostKey: hostKey },
      { status: 'connected', hostKey },
    ])

    const pending = await fixture.service.connect({
      hostId: 'host-1', cols: 80, rows: 24,
      credential: { kind: 'password', password: 'password-canary', remember: false },
    })
    expect(pending.phase).toBe('host-key-required')
    expect(pending.candidate).toMatchObject(hostKey)
    expect(JSON.stringify(pending)).not.toContain('password-canary')

    const connected = await fixture.service.confirmHostKey({
      hostId: 'host-1', candidateId: pending.candidate!.candidateId, cols: 80, rows: 24,
    })
    expect(connected.phase).toBe('connected')
    expect(fixture.connects).toHaveLength(2)
    expect(fixture.connects[0]?.expectedHostKey).toBeUndefined()
    expect(fixture.connects[1]?.expectedHostKey).toEqual(hostKey)
    expect(fixture.getTrustedKey()).toEqual(hostKey)
  })

  test('Host Key 变化直接阻断且展示旧新指纹', async () => {
    /** 已固定的旧 Host Key。 */
    const previous = { algorithm: 'ssh-ed25519', fingerprint: 'SHA256:old' }
    /** 本次观测的新 Host Key。 */
    const observed = { algorithm: 'ssh-ed25519', fingerprint: 'SHA256:new' }
    /** 带已有固定值的主机。 */
    const host = createHost({ credentialRef: 'credential-1' })
    const states: ServerOpsConnectionState[] = []
    /** 带已有固定值且 runtime 返回变化指纹的 fixture。 */
    const changedFixture = createDependencies([{ status: 'host-key-rejected', observedHostKey: observed }], host, previous)
    changedFixture.service.onState((state) => states.push(state))
    const blocked = await changedFixture.service.connect({ hostId: host.id, cols: 80, rows: 24, credential: { kind: 'password', password: 'secret', remember: false } })

    expect(blocked).toMatchObject({ phase: 'blocked', hostKey: observed, previousHostKey: previous })
    expect(states.at(-1)?.phase).toBe('blocked')
  })

  test('记住密码绑定密文引用且终端输入校验连接归属', async () => {
    /** 已固定且 runtime 成功使用的 Host Key。 */
    const hostKey = { algorithm: 'ssh-ed25519', fingerprint: 'SHA256:first' }
    /** 连接成功的 fixture。 */
    const fixture = createDependencies([{ status: 'connected', hostKey }], createHost(), hostKey)

    const connected = await fixture.service.connect({
      hostId: 'host-1', cols: 100, rows: 30,
      credential: { kind: 'password', password: 'password-canary', remember: true },
    })
    expect(connected.phase).toBe('connected')
    expect(JSON.stringify(connected)).not.toContain('password-canary')

    fixture.service.writeTerminal({ hostId: 'host-1', connectionId: connected.connectionId!, data: 'uptime\r' })
    expect(fixture.writes).toEqual(['uptime\r'])
    expect(() => fixture.service.writeTerminal({ hostId: 'host-1', connectionId: 'wrong', data: 'whoami\r' }))
      .toThrow('SERVER_OPS_CONNECTION_NOT_ACTIVE')
  })

  test('私钥路径只在主进程解析，runtime 仅接收密钥内容与口令', async () => {
    /** 已固定且 runtime 成功使用的 Host Key。 */
    const hostKey = { algorithm: 'ssh-ed25519', fingerprint: 'SHA256:private-key' }
    /** 使用私钥认证的公开主机。 */
    const host = createHost({ authMethod: 'private-key' })
    /** 连接成功的私钥 fixture。 */
    const fixture = createDependencies([{ status: 'connected', hostKey }], host, hostKey)

    const connected = await fixture.service.connect({
      hostId: host.id,
      cols: 80,
      rows: 24,
      credential: { kind: 'private-key', keyPath: '/home/deploy/.ssh/id_ed25519', passphrase: 'passphrase-canary', remember: false },
    })

    expect(fixture.connects[0]?.authentication).toEqual({
      kind: 'private-key',
      privateKey: Buffer.from('private-key'),
      passphrase: 'passphrase-canary',
    })
    expect(JSON.stringify(connected)).not.toContain('/home/deploy/.ssh/id_ed25519')
    expect(JSON.stringify(connected)).not.toContain('passphrase-canary')
  })

  test('SSH Agent 连接只向 runtime 传递已解析的 Agent endpoint', async () => {
    /** 已固定且 runtime 成功使用的 Host Key。 */
    const hostKey = { algorithm: 'ssh-ed25519', fingerprint: 'SHA256:ssh-agent' }
    /** 使用 SSH Agent 的公开主机。 */
    const host = createHost({ authMethod: 'ssh-agent' })
    /** 连接成功的 SSH Agent fixture。 */
    const fixture = createDependencies([{ status: 'connected', hostKey }], host, hostKey)

    const connected = await fixture.service.connect({
      hostId: host.id,
      cols: 80,
      rows: 24,
      credential: { kind: 'ssh-agent' },
    })

    expect(connected.phase).toBe('connected')
    expect(fixture.connects[0]?.authentication).toEqual({ kind: 'ssh-agent', agent: '/tmp/agent.sock' })
  })

  test('exec 校验连接归属、命令长度和 timeout 边界', async () => {
    const fixture = createDependencies([{ status: 'connected', hostKey: { algorithm: 'ssh-ed25519', fingerprint: 'SHA256:test' } }])
    const connected = await fixture.service.connect({ hostId: 'host-1', cols: 80, rows: 24, credential: { kind: 'password', password: 'secret', remember: false } })
    expect(connected.phase).toBe('connected')
    await expect(fixture.service.exec('host-1', connected.connectionId!, 'printf ok', 1000)).resolves.toMatchObject({ truncated: false })
    await expect(fixture.service.exec('host-1', 'stale', 'printf ok', 1000)).rejects.toThrow('SERVER_OPS_CONNECTION_NOT_ACTIVE')
    await expect(fixture.service.exec('host-1', connected.connectionId!, 'uname\0-a', 1000)).rejects.toThrow('SERVER_OPS_EXEC_COMMAND_INVALID')
    await expect(fixture.service.exec('host-1', connected.connectionId!, 'x'.repeat(8193), 1000)).rejects.toThrow('SERVER_OPS_EXEC_COMMAND_INVALID')
    await expect(fixture.service.exec('host-1', connected.connectionId!, 'printf ok', 999)).rejects.toThrow('SERVER_OPS_EXEC_TIMEOUT_INVALID')
    await expect(fixture.service.exec('host-1', connected.connectionId!, 'printf ok', 120001)).rejects.toThrow('SERVER_OPS_EXEC_TIMEOUT_INVALID')
  })

  test('Given 活跃连接 When 读取并修改身份副本 Then 内部身份不受污染且重连递增代次', async () => {
    /** 两次连接共用的可信 Host Key。 */
    const hostKey = { algorithm: 'ssh-ed25519', fingerprint: 'SHA256:identity' }
    /** 可连续重连的连接服务。 */
    const fixture = createDependencies([
      { status: 'connected', hostKey },
      { status: 'connected', hostKey },
    ], createHost(), hostKey)

    await fixture.service.connect({ hostId: 'host-1', cols: 80, rows: 24, credential: { kind: 'password', password: 'first', remember: false } })
    /** 首次连接的公开身份副本。 */
    const firstIdentity = fixture.service.getActiveIdentity('host-1')
    firstIdentity.connectionId = 'polluted'
    firstIdentity.generation = 999

    expect(fixture.service.getActiveIdentity('host-1')).toEqual({ hostId: 'host-1', connectionId: 'id-1', generation: 1 })

    await fixture.service.connect({ hostId: 'host-1', cols: 100, rows: 30, credential: { kind: 'password', password: 'second', remember: false } })
    expect(fixture.service.getActiveIdentity('host-1')).toEqual({ hostId: 'host-1', connectionId: 'id-2', generation: 2 })
  })

  test('Given 无活跃连接 When 连接在途、断开或 runtime 退出 Then 身份读取稳定拒绝', async () => {
    /** runtime 连接共用的可信 Host Key。 */
    const hostKey = { algorithm: 'ssh-ed25519', fingerprint: 'SHA256:not-active' }
    /** 保持首次连接在途以覆盖 pending 状态。 */
    const pendingResult = createDeferred<ServerOpsRuntimeConnectResult>()
    /** 可观察全部非活跃阶段的连接服务。 */
    const fixture = createDependencies([pendingResult.promise], createHost(), hostKey)

    expect(() => fixture.service.getActiveIdentity('host-1')).toThrow('SERVER_OPS_CONNECTION_NOT_ACTIVE')
    /** 尚未完成的连接请求。 */
    const connecting = fixture.service.connect({ hostId: 'host-1', cols: 80, rows: 24, credential: { kind: 'password', password: 'secret', remember: false } })
    expect(() => fixture.service.getActiveIdentity('host-1')).toThrow('SERVER_OPS_CONNECTION_NOT_ACTIVE')

    pendingResult.resolve({ status: 'connected', hostKey })
    /** 已建立的公开连接状态。 */
    const connected = await connecting
    fixture.emitExit({ hostId: 'host-1', connectionId: connected.connectionId!, exitCode: 0, message: 'runtime exited' })
    expect(() => fixture.service.getActiveIdentity('host-1')).toThrow('SERVER_OPS_CONNECTION_NOT_ACTIVE')

    await fixture.service.connect({ hostId: 'host-1', cols: 80, rows: 24 })
    fixture.service.disconnect('host-1')
    expect(() => fixture.service.getActiveIdentity('host-1')).toThrow('SERVER_OPS_CONNECTION_NOT_ACTIVE')
  })

  test('Given 首个状态观察者抛错 When 连接成功 Then 连接事务不回滚且后续观察者仍收到状态', async () => {
    /** runtime 成功连接使用的可信 Host Key。 */
    const hostKey = { algorithm: 'ssh-ed25519', fingerprint: 'SHA256:listener-connected' }
    /** 可观察 listener 异常是否错误干扰连接所有权的 fixture。 */
    const fixture = createDependencies([{ status: 'connected', hostKey }], createHost(), hostKey)
    /** 后续观察者实际收到的状态。 */
    const observedStates: ServerOpsConnectionState[] = []
    fixture.service.onState((state) => {
      if (state.phase === 'connected') throw new Error('listener-secret')
    })
    fixture.service.onState((state) => observedStates.push(state))

    /** listener 异常期间完成的连接状态。 */
    const connected = await fixture.service.connect({
      hostId: 'host-1',
      cols: 80,
      rows: 24,
      credential: { kind: 'password', password: 'secret', remember: false },
    })

    expect(connected).toMatchObject({ hostId: 'host-1', connectionId: 'id-1', phase: 'connected' })
    expect(fixture.service.getActiveIdentity('host-1')).toEqual({ hostId: 'host-1', connectionId: 'id-1', generation: 1 })
    expect(fixture.disconnects).toEqual([])
    expect(observedStates.at(-1)).toMatchObject({ hostId: 'host-1', connectionId: 'id-1', phase: 'connected' })
  })

  test('Given 状态观察者抛错 When 主动断开或发布错误 Then 本地状态仍完整收口且后续观察者继续执行', async () => {
    /** 断开场景使用的可信 Host Key。 */
    const hostKey = { algorithm: 'ssh-ed25519', fingerprint: 'SHA256:listener-terminal' }
    /** 先建立真实连接，再安装会失败的状态观察者。 */
    const fixture = createDependencies([{ status: 'connected', hostKey }], createHost(), hostKey)
    await fixture.service.connect({
      hostId: 'host-1',
      cols: 80,
      rows: 24,
      credential: { kind: 'password', password: 'secret', remember: false },
    })
    /** 后续观察者收到的断开与错误状态。 */
    const observedStates: ServerOpsConnectionState[] = []
    fixture.service.onState(() => { throw new Error('listener-secret') })
    fixture.service.onState((state) => observedStates.push(state))

    expect(() => fixture.service.disconnect('host-1')).not.toThrow()
    expect(fixture.service.getState('host-1')).toEqual({ hostId: 'host-1', phase: 'disconnected' })
    expect(() => fixture.service.getActiveIdentity('host-1')).toThrow('SERVER_OPS_CONNECTION_NOT_ACTIVE')
    expect(observedStates.map((state) => state.phase)).toEqual(['disconnecting', 'disconnected'])

    fixture.deleteHost()
    /** 主机缺失时发布的稳定错误状态。 */
    const errorState = await fixture.service.connect({ hostId: 'host-1', cols: 80, rows: 24 })
    expect(errorState).toMatchObject({ hostId: 'host-1', phase: 'error', errorCode: 'SERVER_OPS_HOST_NOT_FOUND' })
    expect(fixture.service.getState('host-1')).toEqual(errorState)
    expect(observedStates.at(-1)).toEqual(errorState)
  })

  test('Given 当前连接身份 When 日志启停与 ACK Then runtime 只收到精确身份', async () => {
    const fixture = createDependencies([{ status: 'connected', hostKey: { algorithm: 'ssh-ed25519', fingerprint: 'SHA256:log' } }])
    await fixture.service.connect({ hostId: 'host-1', cols: 80, rows: 24, credential: { kind: 'password', password: 'secret', remember: false } })
    /** 当前连接的不可变身份快照。 */
    const identity = fixture.service.getActiveIdentity('host-1')

    await fixture.service.startLog(identity, 'stream-1', 'journalctl --follow')
    fixture.service.acknowledgeLog(identity, 'stream-1', 7)
    fixture.service.stopLog(identity, 'stream-1')

    expect(fixture.logStarts).toEqual([{ hostId: 'host-1', connectionId: 'id-1', streamId: 'stream-1', command: 'journalctl --follow' }])
    expect(fixture.logAcks).toEqual([{ hostId: 'host-1', connectionId: 'id-1', streamId: 'stream-1', sequence: 7 }])
    expect(fixture.logStops).toEqual([{ hostId: 'host-1', connectionId: 'id-1', streamId: 'stream-1' }])
  })

  test('Given 旧 generation When 重连后操作或收到事件 Then 不进入新连接', async () => {
    const hostKey = { algorithm: 'ssh-ed25519', fingerprint: 'SHA256:generation' }
    const fixture = createDependencies([{ status: 'connected', hostKey }, { status: 'connected', hostKey }], createHost(), hostKey)
    await fixture.service.connect({ hostId: 'host-1', cols: 80, rows: 24, credential: { kind: 'password', password: 'first', remember: false } })
    /** 重连前捕获的旧身份。 */
    const stale = fixture.service.getActiveIdentity('host-1')
    await fixture.service.connect({ hostId: 'host-1', cols: 80, rows: 24, credential: { kind: 'password', password: 'second', remember: false } })
    /** 当前日志订阅者观察的输出。 */
    const outputs: string[] = []
    fixture.service.onLogOutput(() => { throw new Error('listener-secret') })
    fixture.service.onLogOutput((event) => outputs.push(event.data))

    await expect(fixture.service.startLog(stale, 'stream-stale', 'journalctl --follow')).rejects.toThrow('SERVER_OPS_CONNECTION_NOT_ACTIVE')
    fixture.service.acknowledgeLog(stale, 'stream-stale', 0)
    fixture.service.stopLog(stale, 'stream-stale')
    fixture.emitLogOutput({ hostId: 'host-1', connectionId: 'id-1', streamId: 'stream-stale', sequence: 0, data: 'stale' })

    expect(fixture.logStarts).toEqual([])
    expect(fixture.logAcks).toEqual([])
    expect(fixture.logStops).toEqual([])
    expect(outputs).toEqual([])
  })
})
