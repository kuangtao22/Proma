/** iLink 可省略成功状态；显式返回的状态仍须严格校验。 */
interface WeChatSendResponse {
  /** iLink 主状态码，缺失表示服务端未显式返回。 */
  ret?: unknown
  /** iLink 错误码，不能因 ret 为零而忽略。 */
  errcode?: unknown
}

/** 读取指定状态字段；缺失返回 undefined，非整数状态抛出脱敏错误。 */
function readOptionalStatusCode(response: WeChatSendResponse, field: 'ret' | 'errcode'): number | undefined {
  /** 服务端原始状态值，未经验证不能当作成功。 */
  const value = response[field]
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw new Error(`微信 iLink sendmessage 返回了无效 ${field}`)
  }
  return value
}

/** 校验发送回执；接受空成功对象，显式失败或非法形状抛错，不透出服务端正文。 */
export function assertWeChatSendSucceeded(response: unknown): void {
  if (!response || typeof response !== 'object' || Array.isArray(response)) {
    throw new Error('微信 iLink sendmessage 返回了无效响应')
  }
  /** 仅在确认对象形状后读取已知状态字段。 */
  const typed = response as WeChatSendResponse
  /** 主状态和错误状态须各自验证，任一非零均失败。 */
  const ret = readOptionalStatusCode(typed, 'ret')
  /** 独立错误码可能在 ret 为零时说明发送失败。 */
  const errcode = readOptionalStatusCode(typed, 'errcode')
  if (ret !== undefined && ret !== 0) throw new Error(`微信 iLink sendmessage 失败: ret=${ret}`)
  if (errcode !== undefined && errcode !== 0) throw new Error(`微信 iLink sendmessage 失败: errcode=${errcode}`)
}
