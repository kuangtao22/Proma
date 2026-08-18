import { LAN_BRIDGE_IPC_CHANNELS } from '@proma/shared'
import type {
  LanBridgeConfig,
  LanBridgeGetPairingQrResponse,
  LanBridgeListDevicesRequest,
  LanBridgeListDevicesResponse,
  LanBridgeRevokeDeviceRequest,
  LanBridgeRevokeDeviceResponse,
  LanBridgeRuntimeState,
} from '@proma/shared'
import type { IpcRendererEvent } from 'electron'

/** LAN Bridge preload 暴露给 renderer 的稳定 API。 */
export interface LanBridgePreloadApi {
  /** 获取当前 LAN Bridge 配置。 */
  getLanBridgeConfig: () => Promise<LanBridgeConfig>
  /** 合并更新并返回 LAN Bridge 配置。 */
  updateLanBridgeConfig: (updates: Partial<LanBridgeConfig>) => Promise<LanBridgeConfig>
  /** 获取当前 LAN Bridge 运行状态。 */
  getLanBridgeStatus: () => Promise<LanBridgeRuntimeState>
  /** 启动 LAN Bridge。 */
  startLanBridge: () => Promise<void>
  /** 停止 LAN Bridge。 */
  stopLanBridge: () => Promise<void>
  /** 获取当前配对 PIN。 */
  getLanBridgePin: () => Promise<string>
  /** 刷新并返回配对 PIN。 */
  refreshLanBridgePin: () => Promise<string>
  /** 创建当前 LAN Bridge 的一次性扫码配对二维码。 */
  getLanBridgePairingQr: () => Promise<LanBridgeGetPairingQrResponse>
  /** 查询已配对设备，默认不包含已撤销设备。 */
  listLanBridgeDevices: (request?: LanBridgeListDevicesRequest) => Promise<LanBridgeListDevicesResponse>
  /** 撤销设备访问权并断开该设备的现有连接。 */
  revokeLanBridgeDevice: (request: LanBridgeRevokeDeviceRequest) => Promise<LanBridgeRevokeDeviceResponse>
  /** 订阅 LAN Bridge 状态变化，并返回取消订阅函数。 */
  onLanBridgeStatusChanged: (listener: (state: LanBridgeRuntimeState) => void) => () => void
}

/** LAN Bridge preload 工厂所需的最小 ipcRenderer 能力。 */
export interface LanBridgePreloadIpc {
  /** 调用主进程 IPC handler。 */
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
  /** 注册主进程事件 listener。 */
  on: (channel: string, listener: (event: IpcRendererEvent, ...args: unknown[]) => void) => void
  /** 移除先前注册的同一事件 listener。 */
  removeListener: (channel: string, listener: (event: IpcRendererEvent, ...args: unknown[]) => void) => void
}

/** 创建 LAN Bridge preload API，并为事件订阅提供精确的同 handler 清理。 */
export function createLanBridgePreloadApi(ipc: LanBridgePreloadIpc): LanBridgePreloadApi {
  return {
    getLanBridgeConfig: () => (
      ipc.invoke(LAN_BRIDGE_IPC_CHANNELS.GET_CONFIG) as Promise<LanBridgeConfig>
    ),
    updateLanBridgeConfig: (updates) => (
      ipc.invoke(LAN_BRIDGE_IPC_CHANNELS.UPDATE_CONFIG, updates) as Promise<LanBridgeConfig>
    ),
    getLanBridgeStatus: () => (
      ipc.invoke(LAN_BRIDGE_IPC_CHANNELS.GET_STATUS) as Promise<LanBridgeRuntimeState>
    ),
    startLanBridge: () => ipc.invoke(LAN_BRIDGE_IPC_CHANNELS.START) as Promise<void>,
    stopLanBridge: () => ipc.invoke(LAN_BRIDGE_IPC_CHANNELS.STOP) as Promise<void>,
    getLanBridgePin: () => ipc.invoke(LAN_BRIDGE_IPC_CHANNELS.GET_PIN) as Promise<string>,
    refreshLanBridgePin: () => ipc.invoke(LAN_BRIDGE_IPC_CHANNELS.REFRESH_PIN) as Promise<string>,
    getLanBridgePairingQr: () => (
      ipc.invoke(LAN_BRIDGE_IPC_CHANNELS.GET_PAIRING_QR) as Promise<LanBridgeGetPairingQrResponse>
    ),
    listLanBridgeDevices: (request = {}) => (
      ipc.invoke(LAN_BRIDGE_IPC_CHANNELS.LIST_DEVICES, request) as Promise<LanBridgeListDevicesResponse>
    ),
    revokeLanBridgeDevice: (request) => (
      ipc.invoke(LAN_BRIDGE_IPC_CHANNELS.REVOKE_DEVICE, request) as Promise<LanBridgeRevokeDeviceResponse>
    ),
    onLanBridgeStatusChanged: (listener) => {
      /** 转换 Electron 事件参数，只向 renderer listener 传递运行状态。 */
      const handler = (_event: IpcRendererEvent, state: unknown): void => {
        listener(state as LanBridgeRuntimeState)
      }
      ipc.on(LAN_BRIDGE_IPC_CHANNELS.STATUS_CHANGED, handler)
      return () => {
        ipc.removeListener(LAN_BRIDGE_IPC_CHANNELS.STATUS_CHANGED, handler)
      }
    },
  }
}
