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
  results: ServerOpsRuntimeConnectResult[],
  host = createHost(),
  initialTrustedKey?: { algorithm: string; fingerprint: string },
) {
  /** runtime 收到的真实连接请求。 */
  const connects: ServerOpsRuntimeConnectionInput[] = []
  /** runtime 收到的终端输入。 */
  const writes: string[] = []
  /** 当前 Host Key 固定值。 */
  let trustedKey: { algorithm: string; fingerprint: string } | undefined = initialTrustedKey
  /** 当前短期或已解密凭据。 */
  let credential: ServerOpsResolvedCredential | undefined
  /** 被安全保存的凭据引用。 */
  let credentialRef: string | undefined = host.credentialRef
  /** runtime 输出监听器。 */
  let outputListener: ((event: ServerOpsTerminalOutputEvent) => void) | undefined
  /** runtime 退出监听器。 */
  let exitListener: ((event: ServerOpsTerminalExitEvent) => void) | undefined
  /** 连续生成 connection/candidate ID 的计数。 */
  let nextId = 0

  const service = new ServerOpsConnectionService({
    hosts: {
      get: (hostId) => hostId === host.id ? { ...host } : undefined,
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
      disconnect: () => undefined,
      input: (_hostId, _connectionId, data) => { writes.push(data) },
      resize: () => undefined,
      acknowledgeOutput: () => undefined,
      onOutput: (listener) => { outputListener = listener; return () => { outputListener = undefined } },
      onExit: (listener) => { exitListener = listener; return () => { exitListener = undefined } },
    },
    uuid: () => `id-${++nextId}`,
    resolveSshAgent: () => '/tmp/agent.sock',
    readPrivateKey: () => Buffer.from('private-key'),
  })

  return { service, connects, writes, getTrustedKey: () => trustedKey, emitOutput: (event: ServerOpsTerminalOutputEvent) => outputListener?.(event), emitExit: (event: ServerOpsTerminalExitEvent) => exitListener?.(event) }
}

describe('服务器运维连接 Service', () => {
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
})
