/** 已解析且可立即清理的一次性配对信息。 */
export interface PairingLink {
  ticket: string
  cleanUrl: string
}

/** 浏览器配对链接读取所需的最小能力。 */
export interface PairingLinkBrowser {
  getHref: () => string
  replaceUrl: (cleanUrl: string) => void
}

/** 解析 URL fragment 中的一次性配对票据。 */
export function parsePairingLink(href: string): PairingLink | null {
  try {
    /** 使用标准 URL 解析 host、port 和不进入 HTTP 请求的 fragment。 */
    const url = new URL(href)
    /** 仅认可明确的移动端配对路由，普通 query 不参与认证。 */
    const fragment = url.hash.slice(1)
    const queryIndex = fragment.indexOf('?')
    if (queryIndex < 0 || fragment.slice(0, queryIndex) !== '/pair') return null

    /** fragment 内未经解码的查询字段。 */
    const rawParameters = fragment.slice(queryIndex + 1).split('&')
    /** 第一个 ticket 字段，避免重复参数造成解释分歧。 */
    const rawTicket = rawParameters
      .map(parameter => parameter.split('=', 2))
      .find(([key]) => key === 'ticket')?.[1]
    if (!rawTicket) return null

    /** 严格解码票据；坏百分号编码会抛错并被当作无效链接。 */
    const ticket = decodeURIComponent(rawTicket)
    if (!ticket) return null
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return { ticket, cleanUrl: `${url.origin}/` }
  } catch {
    return null
  }
}

/** 读取并立即从浏览器历史中清除一次性配对票据。 */
export function consumePairingLink(browser: PairingLinkBrowser): PairingLink | null {
  /** 当前地址只在局部变量中短暂存在，不写日志或持久化。 */
  const href = browser.getHref()
  /** 解析结果用于认证，但清理动作不依赖票据是否合法。 */
  const pairingLink = parsePairingLink(href)
  try {
    /** 清理任何 fragment，避免刷新、后退或能力降级时重复读取票据。 */
    const url = new URL(href)
    if (url.hash) {
      browser.replaceUrl(`${url.origin}/`)
    }
  } catch {
    // 无法解析的地址不执行历史写入。
  }
  return pairingLink
}

/** 根据 hello 已协商能力判断是否支持一次性票据配对。 */
export function supportsPairingTicket(payload: unknown): boolean {
  if (!isRecord(payload) || !Array.isArray(payload.capabilities)) return false
  if (!Number.isSafeInteger(payload.protocolVersion)
    || (payload.protocolVersion as number) < LAN_BRIDGE_MIN_PROTOCOL_VERSION
    || (payload.protocolVersion as number) > LAN_BRIDGE_MAX_PROTOCOL_VERSION) return false
  return payload.capabilities.some(capability => capability === 'pairing-ticket')
}

/** 将扫码配对错误转换为不泄漏凭据的用户提示。 */
export function getPairingFailureMessage(error: unknown): string {
  /** 只读取稳定错误码，绝不透传可能包含凭据的异常 message。 */
  const code = isRecord(error) && typeof error.code === 'string' ? error.code : ''
  switch (code) {
    case 'PAIRING_TICKET_EXPIRED':
      return '二维码已过期，请在电脑端刷新后重试'
    case 'PAIRING_TICKET_INVALID':
      return '二维码已使用或无效，请在电脑端刷新后重试'
    case 'RATE_LIMITED':
      return '尝试次数过多，请稍后再试或使用 PIN 码'
    case 'TIMEOUT':
      return '连接超时，请检查网络后使用 PIN 码重试'
    case 'CONNECTION_LOST':
    case 'NOT_CONNECTED':
    case 'SEND_FAILED':
      return '连接中断，请检查网络后使用 PIN 码重试'
    default:
      return '扫码配对失败，请使用 PIN 码连接'
  }
}

/** 判断未知值是否为可安全读取字段的普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
import {
  LAN_BRIDGE_MAX_PROTOCOL_VERSION,
  LAN_BRIDGE_MIN_PROTOCOL_VERSION,
} from '@proma/shared'
