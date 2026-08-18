import { describe, expect, test } from 'bun:test'
import { LAN_BRIDGE_IPC_CHANNELS } from '@proma/shared'
import type {
  LanBridgeConfig,
  LanBridgeDeviceDto,
  LanBridgeRuntimeState,
} from '@proma/shared'
import type { IpcMainInvokeEvent } from 'electron'
import {
  createLanBridgeIpcDependencies,
  registerLanBridgeIpcHandlers,
  type LanBridgeIpcDependencies,
  type LanBridgeIpcRegistrar,
  type LanBridgeIpcRuntimeDependencies,
} from './lan-bridge-ipc'
import type { AgentEventBus } from '../agent-event-bus'

/** 测试用 IPC handler 类型，用于直接验证注册后的转发行为。 */
type RecordedHandler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown

/** 创建记录型 IPC registrar，返回通道到 handler 列表的映射。 */
function createRecordingRegistrar(): {
  ipc: LanBridgeIpcRegistrar
  handlers: Map<string, RecordedHandler[]>
} {
  /** 保存每个通道的全部注册记录，用于发现重复注册。 */
  const handlers = new Map<string, RecordedHandler[]>()
  /** 模拟 Electron ipcMain，仅记录 handle 调用而不加载 Electron 运行时。 */
  const ipc: LanBridgeIpcRegistrar = {
    handle: (channel, handler) => {
      /** 获取通道已有的注册记录。 */
      const registered = handlers.get(channel) ?? []
      registered.push(handler)
      handlers.set(channel, registered)
    },
  }
  return { ipc, handlers }
}

/** 获取指定通道唯一注册的 handler，并在测试中明确约束唯一性。 */
function getOnlyHandler(
  handlers: Map<string, RecordedHandler[]>,
  channel: string,
): RecordedHandler {
  /** 当前通道的注册记录。 */
  const registered = handlers.get(channel)
  expect(registered).toHaveLength(1)
  return registered?.[0] as RecordedHandler
}

/** 创建覆盖全部当前命令的可注入依赖，默认返回稳定测试数据。 */
function createDependencies(overrides: Partial<LanBridgeIpcDependencies> = {}): LanBridgeIpcDependencies {
  /** 测试使用的默认 LAN 配置。 */
  const config: LanBridgeConfig = { enabled: false, port: 29888, maxConnections: 20 }
  /** 测试使用的默认运行状态。 */
  const state: LanBridgeRuntimeState = {
    status: 'stopped',
    pin: '123456',
    port: config.port,
    localIp: '127.0.0.1',
    connectedClients: [],
  }
  return {
    getConfig: () => config,
    updateConfig: () => config,
    getStatus: () => state,
    start: async () => undefined,
    stop: () => undefined,
    getPin: () => state.pin,
    refreshPin: () => state.pin,
    createPairingTicket: () => ({ value: 'ticket-value', expiresAt: 120_000 }),
    createQrCodeData: async () => 'data:image/png;base64,qr',
    listDevices: () => [],
    revokeDevice: () => undefined,
    ...overrides,
  }
}

describe('LAN Bridge IPC 注册', () => {
  test('Given 根组合点注入 AgentEventBus When 创建生产 IPC 依赖 Then start 使用同一实例', async () => {
    /** 用作对象身份断言的 EventBus。 */
    const agentEventBus = {} as AgentEventBus
    /** 记录 startLanBridge 实际收到的 EventBus。 */
    let receivedEventBus: AgentEventBus | undefined
    /** 不触碰 Electron 和真实持久化的运行时依赖。 */
    const runtime: LanBridgeIpcRuntimeDependencies = {
      getConfig: () => ({ enabled: false, port: 29888, maxConnections: 20 }),
      updateConfig: () => ({ enabled: false, port: 29888, maxConnections: 20 }),
      getStatus: () => ({
        status: 'stopped',
        pin: '123456',
        port: 29888,
        localIp: '127.0.0.1',
        connectedClients: [],
      }),
      startLanBridge: async (received) => {
        receivedEventBus = received
      },
      stop: () => undefined,
      getPin: () => '123456',
      refreshPin: () => '654321',
      createPairingTicket: () => ({ value: 'ticket', expiresAt: 120_000 }),
      createQrCodeData: async () => 'data:image/png;base64,qr',
      listDevices: () => [],
      revokeDevice: () => undefined,
    }

    /** 由根组合点创建的 IPC 业务依赖。 */
    const dependencies = createLanBridgeIpcDependencies(agentEventBus, runtime)
    await dependencies.start()

    expect(receivedEventBus).toBe(agentEventBus)
  })

  test('Given 当前十个命令 When 注册并逐一调用 handlers Then 各注册一次并原样转发', async () => {
    /** 各业务依赖的实际调用次数。 */
    const calls = {
      getConfig: 0,
      updateConfig: 0,
      getStatus: 0,
      start: 0,
      stop: 0,
      getPin: 0,
      refreshPin: 0,
      createPairingTicket: 0,
      createQrCodeData: 0,
      listDevices: 0,
      revokeDevice: 0,
    }
    /** GET_CONFIG 返回的同一配置对象。 */
    const config: LanBridgeConfig = { enabled: false, port: 29888, maxConnections: 20 }
    /** UPDATE_CONFIG 返回的同一配置对象。 */
    const updatedConfig: LanBridgeConfig = { enabled: true, port: 31000, maxConnections: 8 }
    /** GET_STATUS 返回的同一状态对象。 */
    const state: LanBridgeRuntimeState = {
      status: 'running',
      pin: '123456',
      port: updatedConfig.port,
      localIp: '192.168.1.8',
      connectedClients: [],
    }
    /** renderer 传入的局部配置。 */
    const updates: Partial<LanBridgeConfig> = { enabled: true, port: updatedConfig.port }
    /** 已配对设备安全元数据。 */
    const device: LanBridgeDeviceDto = {
      id: 'device-1',
      name: 'iPhone',
      createdAt: 10,
      lastSeenAt: 20,
      tokenVersion: 1,
    }
    /** 二维码库实际收到的 fragment-only 配对地址。 */
    let receivedPairingUrl = ''
    /** 撤销 facade 实际收到的设备 ID。 */
    let receivedDeviceId = ''
    /** 记录 UPDATE_CONFIG 依赖实际收到的唯一业务参数。 */
    let receivedUpdates: Partial<LanBridgeConfig> | undefined
    /** 记录本次注册产生的全部 handler。 */
    const { ipc, handlers } = createRecordingRegistrar()
    registerLanBridgeIpcHandlers(ipc, createDependencies({
      getConfig: () => {
        calls.getConfig += 1
        return config
      },
      updateConfig: (received) => {
        calls.updateConfig += 1
        receivedUpdates = received
        return updatedConfig
      },
      getStatus: () => {
        calls.getStatus += 1
        return state
      },
      start: async () => {
        calls.start += 1
      },
      stop: () => {
        calls.stop += 1
      },
      getPin: () => {
        calls.getPin += 1
        return '123456'
      },
      refreshPin: () => {
        calls.refreshPin += 1
        return '654321'
      },
      createPairingTicket: () => {
        calls.createPairingTicket += 1
        return { value: 'abc+/=', expiresAt: 120_000 }
      },
      createQrCodeData: async (pairingUrl) => {
        calls.createQrCodeData += 1
        receivedPairingUrl = pairingUrl
        return 'data:image/png;base64,pairing'
      },
      listDevices: (includeRevoked) => {
        calls.listDevices += 1
        expect(includeRevoked).toBe(false)
        return [device]
      },
      revokeDevice: (deviceId) => {
        calls.revokeDevice += 1
        receivedDeviceId = deviceId
        return device
      },
    }))
    /** 模拟 Electron invoke 事件，UPDATE_CONFIG 不应把它转发给业务依赖。 */
    const event = { sender: 'renderer-sentinel' } as unknown as IpcMainInvokeEvent
    /** 当前七个命令的调用参数与期望原值。 */
    const commandCases: Array<{
      channel: string
      args: unknown[]
      expected: unknown
    }> = [
      { channel: LAN_BRIDGE_IPC_CHANNELS.GET_CONFIG, args: [], expected: config },
      { channel: LAN_BRIDGE_IPC_CHANNELS.UPDATE_CONFIG, args: [updates], expected: updatedConfig },
      { channel: LAN_BRIDGE_IPC_CHANNELS.GET_STATUS, args: [], expected: state },
      { channel: LAN_BRIDGE_IPC_CHANNELS.START, args: [], expected: undefined },
      { channel: LAN_BRIDGE_IPC_CHANNELS.STOP, args: [], expected: undefined },
      { channel: LAN_BRIDGE_IPC_CHANNELS.GET_PIN, args: [], expected: '123456' },
      { channel: LAN_BRIDGE_IPC_CHANNELS.REFRESH_PIN, args: [], expected: '654321' },
      {
        channel: LAN_BRIDGE_IPC_CHANNELS.GET_PAIRING_QR,
        args: [],
        expected: { qrCodeData: 'data:image/png;base64,pairing', expiresAt: 120_000 },
      },
      {
        channel: LAN_BRIDGE_IPC_CHANNELS.LIST_DEVICES,
        args: [{ includeRevoked: false }],
        expected: { devices: [device] },
      },
      {
        channel: LAN_BRIDGE_IPC_CHANNELS.REVOKE_DEVICE,
        args: [{ deviceId: device.id }],
        expected: { revoked: true, device },
      },
    ]

    expect([...handlers.keys()]).toEqual(commandCases.map(({ channel }) => channel))
    for (const { channel, args, expected } of commandCases) {
      expect(handlers.get(channel)).toHaveLength(1)
      expect(await getOnlyHandler(handlers, channel)(event, ...args)).toEqual(expected)
    }
    expect(calls).toEqual({
      getConfig: 1,
      updateConfig: 1,
      getStatus: 2,
      start: 1,
      stop: 1,
      getPin: 1,
      refreshPin: 1,
      createPairingTicket: 1,
      createQrCodeData: 1,
      listDevices: 1,
      revokeDevice: 1,
    })
    expect(receivedUpdates).toBe(updates)
    expect(receivedPairingUrl).toBe('http://192.168.1.8:31000/#/pair?ticket=abc%2B%2F%3D')
    expect(receivedPairingUrl.split('#')[0]).not.toContain('ticket')
    expect(receivedDeviceId).toBe(device.id)
  })

  test('Given 没有可达非 loopback IPv4 When 获取二维码 Then 明确失败且不创建票据', async () => {
    /** 记录是否错误签发了无法使用的票据。 */
    let ticketCreated = false
    /** 当前用例注册的 IPC handlers。 */
    const { ipc, handlers } = createRecordingRegistrar()
    registerLanBridgeIpcHandlers(ipc, createDependencies({
      getStatus: () => ({
        status: 'running',
        pin: '123456',
        port: 29888,
        localIp: '127.0.0.1',
        connectedClients: [],
      }),
      createPairingTicket: () => {
        ticketCreated = true
        return { value: 'unused', expiresAt: 120_000 }
      },
    }))

    await expect(getOnlyHandler(handlers, LAN_BRIDGE_IPC_CHANNELS.GET_PAIRING_QR)(
      {} as IpcMainInvokeEvent,
    )).rejects.toThrow('没有可用的局域网 IPv4 地址')
    expect(ticketCreated).toBe(false)
  })

  test('Given 设备不存在或撤销写盘失败 When 撤销设备 Then IPC 不返回伪成功', async () => {
    /** 当前用例注册的 IPC handlers。 */
    const missing = createRecordingRegistrar()
    registerLanBridgeIpcHandlers(missing.ipc, createDependencies())
    await expect(getOnlyHandler(missing.handlers, LAN_BRIDGE_IPC_CHANNELS.REVOKE_DEVICE)(
      {} as IpcMainInvokeEvent,
      { deviceId: 'missing' },
    )).rejects.toThrow('设备不存在')

    /** 模拟 facade 在原子持久化阶段失败。 */
    const failed = createRecordingRegistrar()
    registerLanBridgeIpcHandlers(failed.ipc, createDependencies({
      revokeDevice: () => {
        throw new Error('write failed')
      },
    }))
    await expect(getOnlyHandler(failed.handlers, LAN_BRIDGE_IPC_CHANNELS.REVOKE_DEVICE)(
      {} as IpcMainInvokeEvent,
      { deviceId: 'device-1' },
    )).rejects.toThrow('write failed')
  })
})
