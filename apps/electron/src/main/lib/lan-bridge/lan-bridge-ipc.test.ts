import { describe, expect, test } from 'bun:test'
import { LAN_BRIDGE_IPC_CHANNELS } from '@proma/shared'
import type { LanBridgeConfig, LanBridgeRuntimeState } from '@proma/shared'
import type { IpcMainInvokeEvent } from 'electron'
import {
  registerLanBridgeIpcHandlers,
  type LanBridgeIpcDependencies,
  type LanBridgeIpcRegistrar,
} from './lan-bridge-ipc'

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
    ...overrides,
  }
}

describe('LAN Bridge IPC 注册', () => {
  test('Given 当前七个命令 When 注册并逐一调用 handlers Then 各注册一次并原样转发', async () => {
    /** 各业务依赖的实际调用次数。 */
    const calls = {
      getConfig: 0,
      updateConfig: 0,
      getStatus: 0,
      start: 0,
      stop: 0,
      getPin: 0,
      refreshPin: 0,
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
    ]

    expect([...handlers.keys()]).toEqual(commandCases.map(({ channel }) => channel))
    for (const { channel, args, expected } of commandCases) {
      expect(handlers.get(channel)).toHaveLength(1)
      expect(await getOnlyHandler(handlers, channel)(event, ...args)).toBe(expected)
    }
    expect(calls).toEqual({
      getConfig: 1,
      updateConfig: 1,
      getStatus: 1,
      start: 1,
      stop: 1,
      getPin: 1,
      refreshPin: 1,
    })
    expect(receivedUpdates).toBe(updates)
    expect(handlers.has(LAN_BRIDGE_IPC_CHANNELS.GET_PAIRING_QR)).toBe(false)
    expect(handlers.has(LAN_BRIDGE_IPC_CHANNELS.LIST_DEVICES)).toBe(false)
    expect(handlers.has(LAN_BRIDGE_IPC_CHANNELS.REVOKE_DEVICE)).toBe(false)
  })
})
