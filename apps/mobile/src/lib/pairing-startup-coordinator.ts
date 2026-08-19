import { isRfc1918Ipv4 } from '@proma/shared'
import { getPairingFailureMessage, supportsPairingTicket } from './pairing-link'
import type { PairingLink } from './pairing-link'
import type { WebSocketSourceProtocol } from './ws-client'

/** 启动配对地址目标。 */
export interface PairingConnectionTarget {
  host: string
  port: string
  protocol: WebSocketSourceProtocol
}

/** 地址切换时由 App 执行的连接与 UI 状态动作。 */
export interface PairingConnectionActions {
  /** 使用当前 atoms 中的地址建立连接。 */
  connect: (host: string, port: string, protocol: WebSocketSourceProtocol) => void
  /** 自动配对被地址切换取消后解除 PIN 禁用态。 */
  onPairingCancelled: () => void
}

/** 自动票据配对的外部动作。 */
export interface TrustedDeviceAuthentication {
  /** 当前连接使用的短期访问令牌。 */
  token: string
  /** 当前浏览器安装的稳定设备标识。 */
  deviceId: string
  /** 自动续签访问令牌的长期设备凭证。 */
  deviceCredential: string
}

/** 自动票据配对的外部动作。 */
export interface PairingStartupCallbacks {
  /** 提交只可消费一次的配对票据并返回完整可信设备认证材料。 */
  requestPairTicket: (ticket: string) => Promise<TrustedDeviceAuthentication>
  /** 配对成功后交给应用保存认证状态。 */
  onAuthenticated: (authentication: TrustedDeviceAuthentication) => void
  /** 配对不可用或失败时回退到 PIN 流程。 */
  onFallback: (message: string) => void
}

/** 模块级一次性启动配对协调器。 */
export interface PairingStartupCoordinator {
  /** 判断是否仍有尚未提交的票据。 */
  hasPendingTicket: () => boolean
  /** 判断扫码连接目标是否仍待同步。 */
  hasInitialTarget: () => boolean
  /** 一次性取出扫码连接目标。 */
  takeInitialTarget: () => PairingConnectionTarget | null
  /** 根据服务端能力完成自动配对或触发 PIN 回退。 */
  handleConnected: (payload: unknown, callbacks: PairingStartupCallbacks) => Promise<void>
  /** 清除启动配对材料与进行中请求；返回是否取消了自动配对。 */
  cancel: () => boolean
}

/** 启动当前地址连接并返回供下一轮比较的目标。 */
export function startPairingConnection(
  coordinator: PairingStartupCoordinator,
  previousTarget: PairingConnectionTarget | null,
  target: PairingConnectionTarget,
  actions: PairingConnectionActions,
): PairingConnectionTarget {
  /** 只有地址实际改变才取消，兼容 StrictMode 对同一 effect 的重复挂载。 */
  const targetChanged = previousTarget !== null && (
    previousTarget.host !== target.host
    || previousTarget.port !== target.port
    || previousTarget.protocol !== target.protocol
  )
  if (targetChanged && coordinator.cancel()) {
    actions.onPairingCancelled()
  }
  actions.connect(target.host, target.port, target.protocol)
  return target
}

/** 创建只持有一次性 ticket/target 的启动协调器。 */
export function createPairingStartupCoordinator(link: PairingLink | null): PairingStartupCoordinator {
  /** 尚未同步进连接 atoms 的启动目标；只允许读取一次。 */
  let initialTarget = link ? parseConnectionTarget(link.cleanUrl) : null
  /** 只有目标属于受支持的私有 IPv4 时才保留一次性票据。 */
  let pendingTicket = initialTarget ? link?.ticket ?? null : null
  /** 当前请求编号；取消后置空以忽略迟到成功或失败。 */
  let activeRequestId: number | null = null
  /** 为每次真实票据请求分配单调递增编号。 */
  let nextRequestId = 0

  return {
    hasPendingTicket: () => pendingTicket !== null,
    hasInitialTarget: () => initialTarget !== null,
    takeInitialTarget: () => {
      /** 返回前清空 target，确保手工地址后续不被启动值覆盖。 */
      const target = initialTarget
      initialTarget = null
      return target
    },
    handleConnected: async (payload, callbacks) => {
      if (!pendingTicket) return
      if (!supportsPairingTicket(payload)) {
        pendingTicket = null
        callbacks.onFallback('当前电脑端不支持扫码配对，请使用 PIN 码连接')
        return
      }

      /** 先取走再请求，成功、失败、断线和重连都不能二次消费。 */
      const ticket = pendingTicket
      pendingTicket = null
      /** 标记当前唯一进行中的自动配对请求。 */
      const requestId = ++nextRequestId
      activeRequestId = requestId
      /** 服务端签发的认证结果。 */
      let result: TrustedDeviceAuthentication
      try {
        result = await callbacks.requestPairTicket(ticket)
      } catch (error) {
        if (activeRequestId !== requestId) return
        activeRequestId = null
        callbacks.onFallback(getPairingFailureMessage(error))
        return
      }
      if (activeRequestId !== requestId) return
      activeRequestId = null
      if (!result.token || !result.deviceId || !result.deviceCredential) {
        callbacks.onFallback('扫码配对响应无效，请使用 PIN 码连接')
        return
      }
      callbacks.onAuthenticated(result)
    },
    cancel: () => {
      /** pending ticket 或 in-flight 请求都代表 UI 仍处于自动配对态。 */
      const pairingWasActive = pendingTicket !== null || activeRequestId !== null
      pendingTicket = null
      initialTarget = null
      activeRequestId = null
      return pairingWasActive
    },
  }
}

/** 从已清理的 origin 根地址提取一次性启动连接目标。 */
function parseConnectionTarget(cleanUrl: string): PairingConnectionTarget | null {
  try {
    /** cleanUrl 已无凭据，只用于 host/port 同步。 */
    const url = new URL(cleanUrl)
    if (!isRfc1918Ipv4(url.hostname)) return null
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return {
      host: url.hostname,
      port: url.port || (url.protocol === 'https:' ? '443' : '80'),
      protocol: url.protocol,
    }
  } catch {
    return null
  }
}
