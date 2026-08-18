import { LAN_BRIDGE_IPC_CHANNELS } from '@proma/shared'
import type { LanBridgeConfig, LanBridgeRuntimeState } from '@proma/shared'
import type { IpcMainInvokeEvent } from 'electron'
import type { AgentEventBus } from '../agent-event-bus'

/** LAN Bridge IPC handler 的最小签名，便于测试注入且不加载 Electron。 */
type LanBridgeIpcHandler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown

/** LAN Bridge 注册所需的最小 IPC 能力。 */
export interface LanBridgeIpcRegistrar {
  /** 按通道注册一个异步调用 handler。 */
  handle: (channel: string, handler: LanBridgeIpcHandler) => void
}

/** LAN Bridge IPC handler 使用的业务依赖。 */
export interface LanBridgeIpcDependencies {
  /** 获取当前 LAN Bridge 配置。 */
  getConfig: () => LanBridgeConfig
  /** 合并更新并返回 LAN Bridge 配置。 */
  updateConfig: (updates: Partial<LanBridgeConfig>) => LanBridgeConfig
  /** 获取当前 LAN Bridge 运行状态。 */
  getStatus: () => LanBridgeRuntimeState
  /** 使用当前 Agent 事件总线启动 LAN Bridge。 */
  start: () => Promise<void>
  /** 停止 LAN Bridge。 */
  stop: () => void
  /** 获取当前配对 PIN。 */
  getPin: () => string
  /** 刷新并返回配对 PIN。 */
  refreshPin: () => string
}

/** 在真实注册发生时惰性加载 LAN Bridge 业务模块，避免纯注入测试触发 Electron 依赖。 */
function createDefaultDependencies(): LanBridgeIpcDependencies {
  /** LAN Bridge 服务模块，仅在应用注册 IPC 时加载。 */
  const lanBridge = require('./lan-bridge') as Pick<
    typeof import('./lan-bridge'),
    'getConfig' | 'updateConfig' | 'getLanBridgeStatus' | 'startLanBridge' | 'stopLanBridge'
  >
  /** LAN Bridge 认证模块，仅在应用注册 IPC 时加载。 */
  const lanBridgeAuth = require('./lan-bridge-auth') as Pick<
    typeof import('./lan-bridge-auth'),
    'getCurrentPin' | 'refreshPin'
  >

  return {
    getConfig: lanBridge.getConfig,
    updateConfig: lanBridge.updateConfig,
    getStatus: lanBridge.getLanBridgeStatus,
    start: async () => {
      /** 当前 Agent 事件总线，保持原实现只在启动 LAN Bridge 时加载。 */
      const { agentEventBus } = require('../agent-service') as { agentEventBus: AgentEventBus }
      await lanBridge.startLanBridge(agentEventBus)
    },
    stop: lanBridge.stopLanBridge,
    getPin: lanBridgeAuth.getCurrentPin,
    refreshPin: lanBridgeAuth.refreshPin,
  }
}

/** 注册当前已实现的七个 LAN Bridge IPC 命令。 */
export function registerLanBridgeIpcHandlers(
  ipc: LanBridgeIpcRegistrar,
  dependencies?: LanBridgeIpcDependencies,
): void {
  /** 实际 handler 依赖；测试注入时不会加载 Electron 或 Agent 服务。 */
  const resolvedDependencies = dependencies ?? createDefaultDependencies()

  ipc.handle(LAN_BRIDGE_IPC_CHANNELS.GET_CONFIG, async () => resolvedDependencies.getConfig())
  ipc.handle(LAN_BRIDGE_IPC_CHANNELS.UPDATE_CONFIG, async (_event, updates) => (
    resolvedDependencies.updateConfig(updates as Partial<LanBridgeConfig>)
  ))
  ipc.handle(LAN_BRIDGE_IPC_CHANNELS.GET_STATUS, async () => resolvedDependencies.getStatus())
  ipc.handle(LAN_BRIDGE_IPC_CHANNELS.START, async () => {
    await resolvedDependencies.start()
  })
  ipc.handle(LAN_BRIDGE_IPC_CHANNELS.STOP, async () => resolvedDependencies.stop())
  ipc.handle(LAN_BRIDGE_IPC_CHANNELS.GET_PIN, async () => resolvedDependencies.getPin())
  ipc.handle(LAN_BRIDGE_IPC_CHANNELS.REFRESH_PIN, async () => resolvedDependencies.refreshPin())
}
