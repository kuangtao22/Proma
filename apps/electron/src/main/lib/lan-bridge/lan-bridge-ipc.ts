import { LAN_BRIDGE_IPC_CHANNELS } from '@proma/shared'
import { isIPv4 } from 'node:net'
import type {
  LanBridgeConfig,
  LanBridgeDeviceDto,
  LanBridgeGetPairingQrResponse,
  LanBridgeListDevicesRequest,
  LanBridgeListDevicesResponse,
  LanBridgeRevokeDeviceRequest,
  LanBridgeRevokeDeviceResponse,
  LanBridgeRuntimeState,
} from '@proma/shared'
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
  /** 使用进程级唯一认证服务创建一次性配对票据。 */
  createPairingTicket: () => { value: string; expiresAt: number }
  /** 将 fragment-only 配对地址编码为二维码 data URL。 */
  createQrCodeData: (pairingUrl: string) => Promise<string>
  /** 列出进程级唯一设备仓库中的安全元数据。 */
  listDevices: (includeRevoked?: boolean) => LanBridgeDeviceDto[]
  /** 原子撤销设备，并在持久化提交后断开当前连接。 */
  revokeDevice: (deviceId: string) => LanBridgeDeviceDto | undefined
}

/** 在真实注册发生时惰性加载 LAN Bridge 业务模块，避免纯注入测试触发 Electron 依赖。 */
function createDefaultDependencies(): LanBridgeIpcDependencies {
  /** LAN Bridge 服务模块，仅在应用注册 IPC 时加载。 */
  const lanBridge = require('./lan-bridge') as Pick<
    typeof import('./lan-bridge'),
    | 'getConfig'
    | 'updateConfig'
    | 'getLanBridgeStatus'
    | 'startLanBridge'
    | 'stopLanBridge'
    | 'createLanBridgePairingTicket'
    | 'listLanBridgeDevices'
    | 'revokeLanBridgeDevice'
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
    createPairingTicket: lanBridge.createLanBridgePairingTicket,
    createQrCodeData: async (pairingUrl) => {
      /** 延迟加载已有二维码依赖，避免无配对请求时增加启动路径工作量。 */
      const QRCode = (await import('qrcode')).default
      return QRCode.toDataURL(pairingUrl, { width: 240, margin: 1, errorCorrectionLevel: 'M' })
    },
    listDevices: lanBridge.listLanBridgeDevices,
    revokeDevice: lanBridge.revokeLanBridgeDevice,
  }
}

/** 注册当前十个 LAN Bridge IPC 命令。 */
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
  ipc.handle(LAN_BRIDGE_IPC_CHANNELS.GET_PAIRING_QR, async (): Promise<LanBridgeGetPairingQrResponse> => {
    /** 当前运行状态提供实际监听端口和已筛选的局域网地址。 */
    const state = resolvedDependencies.getStatus()
    if (state.status !== 'running') throw new Error('LAN Bridge 尚未运行')
    if (!isReachableIpv4(state.localIp)) throw new Error('没有可用的局域网 IPv4 地址')

    /** 只在地址可用后签发票据，避免生成无法消费的临时凭据。 */
    const pairingTicket = resolvedDependencies.createPairingTicket()
    /** 票据仅存在 fragment 中，不会进入 HTTP 请求、服务日志或浏览器 query。 */
    const pairingUrl = `http://${state.localIp}:${state.port}/#/pair?ticket=${encodeURIComponent(pairingTicket.value)}`
    return {
      qrCodeData: await resolvedDependencies.createQrCodeData(pairingUrl),
      expiresAt: pairingTicket.expiresAt,
    }
  })
  ipc.handle(LAN_BRIDGE_IPC_CHANNELS.LIST_DEVICES, async (_event, request): Promise<LanBridgeListDevicesResponse> => {
    /** renderer 可省略请求对象，默认只返回仍有效的设备。 */
    const input = (request ?? {}) as LanBridgeListDevicesRequest
    return { devices: resolvedDependencies.listDevices(input.includeRevoked === true) }
  })
  ipc.handle(LAN_BRIDGE_IPC_CHANNELS.REVOKE_DEVICE, async (_event, request): Promise<LanBridgeRevokeDeviceResponse> => {
    /** 撤销请求必须包含非空设备 ID。 */
    const input = request as LanBridgeRevokeDeviceRequest | undefined
    if (!input || typeof input.deviceId !== 'string' || !input.deviceId.trim()) {
      throw new Error('设备 ID 无效')
    }
    /** facade 内先原子持久化再断开；异常必须原样使 IPC 失败。 */
    const device = resolvedDependencies.revokeDevice(input.deviceId)
    if (!device) throw new Error('设备不存在')
    return { revoked: true, device }
  })
}

/** 判断状态地址是否为可供其他局域网设备访问的非 loopback IPv4。 */
function isReachableIpv4(address: string): boolean {
  if (!isIPv4(address)) return false
  if (address === '0.0.0.0') return false
  return !address.startsWith('127.')
}
