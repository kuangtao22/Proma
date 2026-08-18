import { describe, expect, test } from 'bun:test'
import { LAN_BRIDGE_IPC_CHANNELS } from '@proma/shared'
import type { LanBridgeConfig, LanBridgeRuntimeState } from '@proma/shared'
import type { IpcRendererEvent } from 'electron'
import {
  createLanBridgePreloadApi,
  type LanBridgePreloadIpc,
} from './lan-bridge-preload'

/** 测试用 renderer 事件 listener 类型。 */
type RecordedListener = (event: IpcRendererEvent, ...args: unknown[]) => void

/** 创建记录型 preload IPC，不依赖或 mock Electron 运行时。 */
function createRecordingIpc(
  results: Map<string, unknown> = new Map(),
): {
  ipc: LanBridgePreloadIpc
  invokes: Array<{ channel: string; args: unknown[] }>
  added: Array<{ channel: string; listener: RecordedListener }>
  removed: Array<{ channel: string; listener: RecordedListener }>
} {
  /** 保存全部 invoke 调用。 */
  const invokes: Array<{ channel: string; args: unknown[] }> = []
  /** 保存全部 listener 注册。 */
  const added: Array<{ channel: string; listener: RecordedListener }> = []
  /** 保存全部 listener 移除。 */
  const removed: Array<{ channel: string; listener: RecordedListener }> = []
  /** 测试使用的最小 ipcRenderer 替身。 */
  const ipc: LanBridgePreloadIpc = {
    invoke: async (channel, ...args) => {
      invokes.push({ channel, args })
      return results.get(channel)
    },
    on: (channel, listener) => {
      added.push({ channel, listener })
    },
    removeListener: (channel, listener) => {
      removed.push({ channel, listener })
    },
  }
  return { ipc, invokes, added, removed }
}

describe('LAN Bridge preload API', () => {
  test('Given 七个 invoke API When 逐一调用 Then 使用正确通道参数并返回原值', async () => {
    /** 配置查询返回的同一对象。 */
    const config: LanBridgeConfig = { enabled: false, port: 29888, maxConnections: 20 }
    /** 配置更新返回的同一对象。 */
    const updatedConfig: LanBridgeConfig = { enabled: true, port: 31000, maxConnections: 8 }
    /** 状态查询返回的同一对象。 */
    const state: LanBridgeRuntimeState = {
      status: 'running',
      pin: '123456',
      port: updatedConfig.port,
      localIp: '192.168.1.8',
      connectedClients: [],
    }
    /** 按通道配置 IPC 返回值。 */
    const results = new Map<string, unknown>([
      [LAN_BRIDGE_IPC_CHANNELS.GET_CONFIG, config],
      [LAN_BRIDGE_IPC_CHANNELS.UPDATE_CONFIG, updatedConfig],
      [LAN_BRIDGE_IPC_CHANNELS.GET_STATUS, state],
      [LAN_BRIDGE_IPC_CHANNELS.START, undefined],
      [LAN_BRIDGE_IPC_CHANNELS.STOP, undefined],
      [LAN_BRIDGE_IPC_CHANNELS.GET_PIN, '123456'],
      [LAN_BRIDGE_IPC_CHANNELS.REFRESH_PIN, '654321'],
    ])
    /** 记录 preload API 产生的 IPC 调用。 */
    const { ipc, invokes } = createRecordingIpc(results)
    /** 被测 preload API。 */
    const api = createLanBridgePreloadApi(ipc)
    /** renderer 传入的配置更新。 */
    const updates: Partial<LanBridgeConfig> = { enabled: true, port: updatedConfig.port }

    expect(await api.getLanBridgeConfig()).toBe(config)
    expect(await api.updateLanBridgeConfig(updates)).toBe(updatedConfig)
    expect(await api.getLanBridgeStatus()).toBe(state)
    expect(await api.startLanBridge()).toBeUndefined()
    expect(await api.stopLanBridge()).toBeUndefined()
    expect(await api.getLanBridgePin()).toBe('123456')
    expect(await api.refreshLanBridgePin()).toBe('654321')
    expect(invokes).toEqual([
      { channel: LAN_BRIDGE_IPC_CHANNELS.GET_CONFIG, args: [] },
      { channel: LAN_BRIDGE_IPC_CHANNELS.UPDATE_CONFIG, args: [updates] },
      { channel: LAN_BRIDGE_IPC_CHANNELS.GET_STATUS, args: [] },
      { channel: LAN_BRIDGE_IPC_CHANNELS.START, args: [] },
      { channel: LAN_BRIDGE_IPC_CHANNELS.STOP, args: [] },
      { channel: LAN_BRIDGE_IPC_CHANNELS.GET_PIN, args: [] },
      { channel: LAN_BRIDGE_IPC_CHANNELS.REFRESH_PIN, args: [] },
    ])
  })

  test('Given 状态订阅 When 触发并取消 Then 传递状态且使用同一 handler 引用移除', () => {
    /** 记录 listener 的注册与移除。 */
    const { ipc, added, removed } = createRecordingIpc()
    /** 被测 preload API。 */
    const api = createLanBridgePreloadApi(ipc)
    /** listener 实际收到的状态。 */
    const received: LanBridgeRuntimeState[] = []
    /** 模拟主进程推送的运行状态。 */
    const state: LanBridgeRuntimeState = {
      status: 'running',
      pin: '123456',
      port: 29888,
      localIp: '192.168.1.8',
      connectedClients: [],
    }

    /** 取消当前状态订阅的函数。 */
    const unsubscribe = api.onLanBridgeStatusChanged((nextState) => received.push(nextState))
    expect(added).toHaveLength(1)
    expect(added[0]?.channel).toBe(LAN_BRIDGE_IPC_CHANNELS.STATUS_CHANGED)
    added[0]?.listener({} as IpcRendererEvent, state)
    expect(received).toEqual([state])

    unsubscribe()
    expect(removed).toHaveLength(1)
    expect(removed[0]?.channel).toBe(LAN_BRIDGE_IPC_CHANNELS.STATUS_CHANGED)
    expect(removed[0]?.listener).toBe(added[0]?.listener)
  })

  test('Given 两个状态订阅 When 分别取消 Then 每个订阅拥有并移除自己的 handler', () => {
    /** 记录 listener 的注册与移除。 */
    const { ipc, added, removed } = createRecordingIpc()
    /** 被测 preload API。 */
    const api = createLanBridgePreloadApi(ipc)

    /** 取消第一个状态订阅的函数。 */
    const unsubscribeFirst = api.onLanBridgeStatusChanged(() => undefined)
    /** 取消第二个状态订阅的函数。 */
    const unsubscribeSecond = api.onLanBridgeStatusChanged(() => undefined)
    expect(added).toHaveLength(2)
    /** 第一个订阅注册的 handler。 */
    const firstListener = added[0]?.listener
    /** 第二个订阅注册的 handler。 */
    const secondListener = added[1]?.listener
    if (!firstListener || !secondListener) {
      throw new Error('状态订阅未注册完整')
    }
    expect(firstListener).not.toBe(secondListener)

    unsubscribeFirst()
    unsubscribeSecond()
    expect(removed.map(({ listener }) => listener)).toEqual([
      firstListener,
      secondListener,
    ])
  })
})
