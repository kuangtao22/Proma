import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WebSocket } from 'ws'
import type { LanBridgeResponse } from '@proma/shared'
import { createLanBridgeAuthService } from './lan-bridge-auth'
import type { LanBridgeAuthService } from './lan-bridge-auth'
import { LanBridgeDeviceStore } from './lan-bridge-device-store'
import { dispatch } from './lan-bridge-router'
import { LanBridgeSessionManager } from './lan-bridge-session'
import type { ClientConnection } from './lan-bridge-types'
import { registerLanBridgeHandlers } from './lan-bridge-handlers'
import type { LanBridgePromaAdapter } from './lan-bridge-proma-adapter-core'

/** 当前测试创建的临时目录。 */
const temporaryDirectories: string[] = []

/** 记录协议响应与关闭行为的测试 WebSocket。 */
class FakeWebSocket {
  readyState = 1
  readonly messages: LanBridgeResponse[] = []
  readonly closeCalls: Array<{ code: number; reason: string }> = []

  send(message: string): void {
    this.messages.push(JSON.parse(message) as LanBridgeResponse)
  }

  close(code: number, reason: string): void {
    this.closeCalls.push({ code, reason })
  }

  terminate(): void {}
}

/** 创建隔离认证服务和真实设备仓库。 */
function createAuthService(): LanBridgeAuthService {
  /** 当前用例独占的配置目录。 */
  const configDir = mkdtempSync(join(tmpdir(), 'proma-handler-auth-'))
  temporaryDirectories.push(configDir)
  /** 当前用例固定持有的设备仓库。 */
  const store = new LanBridgeDeviceStore(configDir, { uuid: () => 'device-1' })
  /** 当前用例的隔离认证服务。 */
  const service = createLanBridgeAuthService({ deviceStore: store })
  service.initialize()
  return service
}

/** 发送请求并返回最后一条协议响应。 */
async function request(
  client: ClientConnection,
  socket: FakeWebSocket,
  type: string,
  data: Record<string, unknown>,
): Promise<LanBridgeResponse> {
  await dispatch(client, type, data, `${type}-request`)
  /** 当前请求生成的最后一条响应。 */
  const response = socket.messages.at(-1)
  if (!response) throw new Error(`请求 ${type} 未生成响应`)
  return response
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('LAN Bridge 真实认证 handler 链路', () => {
  test('一次性票据 handler 签发设备 Token 并记录实际 deviceId', async () => {
    /** 当前用例的隔离认证服务。 */
    const authService = createAuthService()
    /** 当前用例的真实会话管理器。 */
    const manager = new LanBridgeSessionManager(10, { uuid: () => 'client-ticket' })
    registerLanBridgeHandlers({
      authService,
      promaAdapter: {} as unknown as LanBridgePromaAdapter,
      getSessionManager: () => manager,
    })
    /** 当前用例签发的一次性票据。 */
    const ticket = authService.createPairingTicket()
    /** 票据配对连接。 */
    const socket = new FakeWebSocket()
    /** 票据配对客户端。 */
    const client = manager.addClient(socket as unknown as WebSocket, '192.168.1.8')!

    /** 一次性票据 handler 响应。 */
    const response = await request(client, socket, 'auth.pairTicket', {
      ticket: ticket.value,
      deviceName: 'iPhone',
    })
    /** handler 签发的设备信息。 */
    const data = response.data as { token: string; deviceId: string }
    expect(response.ok).toBe(true)
    expect(client.deviceId).toBe(data.deviceId)
    expect(client.authToken).toBe(data.token)
  })

  test('PIN 签发后 verify、refresh 和受保护路由记录同一实际设备', async () => {
    /** 当前用例的隔离认证服务。 */
    const authService = createAuthService()
    /** 当前用例的真实会话管理器。 */
    let nextClientId = 0
    const manager = new LanBridgeSessionManager(10, { uuid: () => `client-${++nextClientId}` })
    registerLanBridgeHandlers({
      authService,
      promaAdapter: {} as unknown as LanBridgePromaAdapter,
      getSessionManager: () => manager,
    })
    /** PIN 配对连接。 */
    const pairSocket = new FakeWebSocket()
    /** PIN 配对客户端。 */
    const pairClient = manager.addClient(pairSocket as unknown as WebSocket, '192.168.1.8')!
    /** PIN 配对响应。 */
    const pairResponse = await request(pairClient, pairSocket, 'auth.pair', {
      pin: authService.getCurrentPin(),
      deviceName: 'iPhone',
    })
    /** PIN handler 签发的 Token 和设备 ID。 */
    const pairData = pairResponse.data as { token: string; deviceId: string }
    expect(pairResponse.ok).toBe(true)
    expect(pairClient.deviceId).toBe(pairData.deviceId)

    /** 验证 Token 的第二条连接。 */
    const verifySocket = new FakeWebSocket()
    /** 验证 Token 的第二个客户端。 */
    const verifyClient = manager.addClient(verifySocket as unknown as WebSocket, '192.168.1.8')!
    /** 结构化验证响应。 */
    const verifyResponse = await request(verifyClient, verifySocket, 'auth.verify', { token: pairData.token })
    expect(verifyResponse.data).toMatchObject({ valid: true, deviceId: pairData.deviceId })
    expect(verifyClient.deviceId).toBe(pairData.deviceId)

    /** 刷新 Token 的响应。 */
    const refreshResponse = await request(verifyClient, verifySocket, 'auth.refresh', { token: pairData.token })
    /** 刷新后仍属于同一设备的 Token。 */
    const refreshData = refreshResponse.data as { token: string; deviceId: string }
    expect(refreshData.deviceId).toBe(pairData.deviceId)
    expect(verifyClient.deviceId).toBe(pairData.deviceId)

    /** 不再显式携带 Token 的受保护订阅响应。 */
    const protectedResponse = await request(verifyClient, verifySocket, 'subscribe', { sessionId: 'session-1' })
    expect(protectedResponse).toMatchObject({ ok: true, data: { subscribed: 'session-1' } })
  })

  test('撤销后断开设备连接并保留 DEVICE_REVOKED 失败语义', async () => {
    /** 当前用例的隔离认证服务。 */
    const authService = createAuthService()
    /** 当前用例的真实会话管理器。 */
    const manager = new LanBridgeSessionManager(10, { uuid: () => 'client-1' })
    registerLanBridgeHandlers({
      authService,
      promaAdapter: {} as unknown as LanBridgePromaAdapter,
      getSessionManager: () => manager,
    })
    /** 被撤销设备的连接。 */
    const socket = new FakeWebSocket()
    /** 被撤销设备的客户端。 */
    const client = manager.addClient(socket as unknown as WebSocket, '192.168.1.8')!
    /** PIN 配对响应。 */
    const pairResponse = await request(client, socket, 'auth.pair', { pin: authService.getCurrentPin() })
    /** 即将被撤销的设备 Token。 */
    const pairData = pairResponse.data as { token: string; deviceId: string }

    authService.revokeDevice(pairData.deviceId, Date.now())
    manager.disconnectDevice(pairData.deviceId)

    expect(socket.closeCalls).toEqual([{ code: 1008, reason: 'Device revoked' }])
    /** 撤销后 Token 验证响应。 */
    const verifyResponse = await request(client, socket, 'auth.verify', { token: pairData.token })
    expect(verifyResponse.data).toEqual({ valid: false, errorCode: 'DEVICE_REVOKED' })
    /** 撤销后 Token 刷新响应。 */
    const refreshResponse = await request(client, socket, 'auth.refresh', { token: pairData.token })
    expect(refreshResponse).toMatchObject({ ok: false, errorCode: 'DEVICE_REVOKED' })
    /** 撤销后受保护请求响应。 */
    const protectedResponse = await request(client, socket, 'subscribe', { sessionId: 'session-2' })
    expect(protectedResponse).toMatchObject({ ok: false, errorCode: 'DEVICE_REVOKED' })
  })

  test('verify、refresh 和保护路由不折叠 TOKEN_INVALID 或 TOKEN_EXPIRED', async () => {
    /** 当前用例的隔离认证服务。 */
    const authService = createAuthService()
    /** 当前用例的真实会话管理器。 */
    const manager = new LanBridgeSessionManager(10, { uuid: () => 'client-errors' })
    registerLanBridgeHandlers({
      authService,
      promaAdapter: {} as unknown as LanBridgePromaAdapter,
      getSessionManager: () => manager,
    })
    /** 错误语义验证连接。 */
    const socket = new FakeWebSocket()
    /** 错误语义验证客户端。 */
    const client = manager.addClient(socket as unknown as WebSocket, '192.168.1.8')!
    /** 恰好超过 24 小时的真实签名 Token。 */
    const expiredToken = authService.generateToken(
      client.ip,
      'iPhone',
      Date.now() - 24 * 60 * 60 * 1_000,
    ).token

    expect((await request(client, socket, 'auth.verify', { token: 'invalid' })).data).toEqual({
      valid: false,
      errorCode: 'TOKEN_INVALID',
    })
    expect(await request(client, socket, 'auth.refresh', { token: 'invalid' })).toMatchObject({
      ok: false,
      errorCode: 'TOKEN_INVALID',
    })
    expect((await request(client, socket, 'auth.verify', { token: expiredToken })).data).toEqual({
      valid: false,
      errorCode: 'TOKEN_EXPIRED',
    })
    expect(await request(client, socket, 'auth.refresh', { token: expiredToken })).toMatchObject({
      ok: false,
      errorCode: 'TOKEN_EXPIRED',
    })
    expect(await request(client, socket, 'subscribe', { token: 'invalid', sessionId: 'session-3' }))
      .toMatchObject({ ok: false, errorCode: 'TOKEN_INVALID' })
  })
})
