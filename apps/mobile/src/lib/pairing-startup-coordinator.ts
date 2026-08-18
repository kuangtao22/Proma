import { getPairingFailureMessage, supportsPairingTicket } from './pairing-link'
import type { PairingLink } from './pairing-link'

/** 启动配对地址目标。 */
export interface PairingConnectionTarget {
  host: string
  port: string
}

/** 自动票据配对的外部动作。 */
export interface PairingStartupCallbacks {
  /** 提交只可消费一次的配对票据并返回认证 Token。 */
  requestPairTicket: (ticket: string) => Promise<{ token: string }>
  /** 配对成功后交给应用保存认证状态。 */
  onAuthenticated: (token: string) => void
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
  /** 清除尚未消费的启动配对材料。 */
  cancel: () => void
}

/** 创建只持有一次性 ticket/target 的启动协调器。 */
export function createPairingStartupCoordinator(link: PairingLink | null): PairingStartupCoordinator {
  /** 尚未提交的一次性票据；发请求前即清空，禁止重连重放。 */
  let pendingTicket = link?.ticket ?? null
  /** 尚未同步进连接 atoms 的启动目标；只允许读取一次。 */
  let initialTarget = link ? parseConnectionTarget(link.cleanUrl) : null

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
      try {
        /** 服务端签发的认证结果。 */
        const result = await callbacks.requestPairTicket(ticket)
        if (!result.token) {
          callbacks.onFallback('扫码配对响应无效，请使用 PIN 码连接')
          return
        }
        callbacks.onAuthenticated(result.token)
      } catch (error) {
        callbacks.onFallback(getPairingFailureMessage(error))
      }
    },
    cancel: () => {
      pendingTicket = null
      initialTarget = null
    },
  }
}

/** 从已清理的 origin 根地址提取一次性启动连接目标。 */
function parseConnectionTarget(cleanUrl: string): PairingConnectionTarget | null {
  try {
    /** cleanUrl 已无凭据，只用于 host/port 同步。 */
    const url = new URL(cleanUrl)
    return {
      host: url.hostname,
      port: url.port || (url.protocol === 'https:' ? '443' : '80'),
    }
  } catch {
    return null
  }
}
