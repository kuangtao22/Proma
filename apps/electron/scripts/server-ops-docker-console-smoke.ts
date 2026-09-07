import { strict as assert } from 'node:assert'
import type { AddressInfo } from 'node:net'
import { Client, Server, utils } from 'ssh2'
import type { ClientChannel, Connection } from 'ssh2'
import type { ServerOpsAuditAppendInput } from '@proma/shared'
import type { ServerOpsRuntimeExecResult } from '../src/utility/server-ops/server-ops-runtime-protocol'
import {
  SERVER_OPS_DOCKER_CAPABILITY_COMMAND,
  SERVER_OPS_DOCKER_COMMAND_PREFIX,
  ServerOpsDockerService,
} from '../src/main/lib/server-ops/server-ops-docker-service'
import {
  SERVER_OPS_DOCKER_CONSOLE_COMMAND_PREFIX,
  ServerOpsConsoleRuntimeController,
} from '../src/utility/server-ops/server-ops-console-runtime'
import type {
  ServerOpsConsoleRuntimeChannel,
  ServerOpsConsoleRuntimeMessage,
} from '../src/utility/server-ops/server-ops-console-runtime'

/** smoke 使用的固定完整容器 ID。 */
const containerId = 'a'.repeat(64)
/** Console 必须提交的完整固定命令。 */
const consoleCommand = `${SERVER_OPS_DOCKER_CONSOLE_COMMAND_PREFIX} container exec -it -- ${containerId} /bin/sh`

/** 生成 Docker inspect 的最小合法响应。 */
function inspectOutput(): string {
  return JSON.stringify([{
    Id: containerId,
    Name: '/fixture',
    Created: '2026-09-07T00:00:00Z',
    Platform: 'linux',
    RestartCount: 0,
    Image: `sha256:${'b'.repeat(64)}`,
    Config: { Image: 'fixture:latest' },
    State: { Status: 'running', Running: true, ExitCode: 0 },
    NetworkSettings: { Ports: {} },
    Mounts: [],
  }])
}

/** 将真实 ssh2 exec channel 收敛为 DockerService 使用的结构化结果。 */
async function execSsh(client: Client, command: string, timeoutMs: number): Promise<ServerOpsRuntimeExecResult> {
  return await new Promise<ServerOpsRuntimeExecResult>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('SERVER_OPS_SMOKE_EXEC_TIMEOUT')), timeoutMs)
    client.exec(command, (error, channel) => {
      if (error) { clearTimeout(timeout); reject(error); return }
      let stdout = ''
      let stderr = ''
      channel.on('data', (data: Buffer) => { stdout += data.toString() })
      channel.stderr.on('data', (data: Buffer) => { stderr += data.toString() })
      channel.once('close', (code: number | undefined, signal: string | undefined) => {
        clearTimeout(timeout)
        resolve({ stdout, stderr, exitCode: code, ...(signal ? { signal } : {}), truncated: false })
      })
    })
  })
}

/** 将真实 ssh2 channel 适配为 Console controller 的最小接口。 */
function adaptConsoleChannel(channel: ClientChannel): ServerOpsConsoleRuntimeChannel {
  return {
    write: (data) => { channel.write(data) },
    setWindow: (rows, cols, height, width) => { channel.setWindow(rows, cols, height, width) },
    onData: (listener) => { channel.on('data', listener) },
    onStderrData: (listener) => { channel.stderr.on('data', listener) },
    onceExit: (listener) => { channel.once('exit', listener) },
    onceClose: (listener) => { channel.once('close', listener) },
    close: () => { channel.close() },
  }
}

/** 启动只响应固定 Docker 命令的回环 SSH 服务。 */
async function startFixture(): Promise<{
  port: number
  commands: string[]
  consoleInputs: string[]
  ptyRequests: () => number
  close(): Promise<void>
}> {
  const commands: string[] = []
  const consoleInputs: string[] = []
  const clients = new Set<Connection>()
  let ptyRequests = 0
  const server = new Server({ hostKeys: [utils.generateKeyPairSync('ed25519').private] }, (connection) => {
    clients.add(connection)
    connection.on('error', () => undefined)
    connection.once('close', () => clients.delete(connection))
    connection.on('authentication', (context) => {
      if (context.method === 'password' && context.username === 'fixture' && context.password === 'fixture-password') context.accept()
      else context.reject()
    })
    connection.on('ready', () => connection.on('session', (accept) => {
      const session = accept()
      session.on('pty', (acceptPty) => { ptyRequests += 1; acceptPty() })
      session.on('exec', (acceptExec, _rejectExec, info) => {
        const channel = acceptExec()
        commands.push(info.command)
        if (info.command === consoleCommand) {
          channel.write('fixture-console\r\n')
          channel.on('data', (data: Buffer) => {
            const input = data.toString()
            consoleInputs.push(input)
            if (input === 'exit\n') { channel.exit(0); channel.end(); return }
            channel.write(`echo:${input}`)
          })
          return
        }
        const stdout = info.command === SERVER_OPS_DOCKER_CAPABILITY_COMMAND
          ? `${JSON.stringify('27.1.1')}\n`
          : info.command.includes(' container inspect -- ')
            ? inspectOutput()
            : info.command.includes(' container restart --time 10 -- ')
              ? `${containerId}\n`
              : ''
        channel.exit(0)
        channel.end(stdout)
      })
    }))
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return {
    port: (server.address() as AddressInfo).port,
    commands,
    consoleInputs,
    ptyRequests: () => ptyRequests,
    close: () => new Promise<void>((resolve) => {
      for (const client of clients) client.end()
      server.close(() => resolve())
    }),
  }
}

/** 通过真实 localhost SSH exec 验证 Docker 写链与独立 Console PTY。 */
async function runSmoke(): Promise<void> {
  const fixture = await startFixture()
  const client = new Client()
  try {
    await new Promise<void>((resolve, reject) => {
      client.once('ready', resolve)
      client.once('error', reject)
      client.connect({ host: '127.0.0.1', port: fixture.port, username: 'fixture', password: 'fixture-password', hostVerifier: () => true })
    })
    const audit: ServerOpsAuditAppendInput[] = []
    const docker = new ServerOpsDockerService({
      getActiveIdentity: () => ({ hostId: 'host-1', connectionId: 'connection-1', generation: 1 }),
      exec: async (_hostId, _connectionId, command, timeoutMs) => await execSsh(client, command, timeoutMs),
      audit: { append: (input) => { audit.push(input) }, prepareForWrites: async () => undefined },
      uuid: (() => { let sequence = 0; return () => `smoke-${++sequence}` })(),
      now: () => 1_000,
    })
    const candidate = await docker.prepareAction(7, { hostId: 'host-1', containerId, action: 'restart' })
    const action = await docker.commitAction(7, { hostId: 'host-1', candidateId: candidate.candidateId })
    assert.equal(action.container?.running, true)
    assert.equal(audit.length, 2)
    assert.equal(fixture.commands.filter((command) => command.includes(' container restart ')).length, 1)
    console.log('[Server Ops Docker/Console smoke] Docker exec 已完成')

    const identity = { consoleId: 'console-1', hostId: 'host-1', connectionId: 'connection-1', containerId }
    let controller!: ServerOpsConsoleRuntimeController<ReturnType<typeof setTimeout>>
    const exited = Promise.withResolvers<void>()
    const messages: ServerOpsConsoleRuntimeMessage[] = []
    controller = new ServerOpsConsoleRuntimeController({
      execute: (command, options, callback) => {
        client.exec(command, { pty: options.pty }, (error, channel) => callback(error ?? undefined, channel ? adaptConsoleChannel(channel) : undefined))
      },
      post: (message) => {
        messages.push(message)
        if (message.type === 'server-ops.console-output') {
          controller.acknowledge({ ...identity, sequence: message.event.sequence })
          if (message.event.data.includes('fixture-console')) controller.write({ ...identity, data: 'whoami\n' })
          if (message.event.data.includes('echo:whoami')) controller.write({ ...identity, data: 'exit\n' })
        }
        if (message.type === 'server-ops.console-exit') exited.resolve()
      },
      setTimer: setTimeout,
      clearTimer: clearTimeout,
    })
    controller.start({ ...identity, cols: 80, rows: 24 })
    await Promise.race([
      exited.promise,
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('SERVER_OPS_SMOKE_CONSOLE_TIMEOUT')), 5_000)),
    ])
    assert.equal(fixture.commands.at(-1), consoleCommand)
    assert.equal(fixture.ptyRequests(), 1)
    assert.deepEqual(fixture.consoleInputs, ['whoami\n', 'exit\n'])
    assert.equal(messages.at(-1)?.type, 'server-ops.console-exit')
    docker.dispose()
    console.log('[Server Ops Docker/Console smoke] PASS: 真实 localhost ssh2 exec 完成 Docker 单次写与独立 PTY Console ACK/退出')
  } finally {
    client.destroy()
    await Promise.race([fixture.close(), new Promise<void>((resolve) => setTimeout(resolve, 500))])
  }
}

await runSmoke()
