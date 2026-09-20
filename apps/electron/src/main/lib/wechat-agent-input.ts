/** 仅写入模型输入的微信来源说明，不写入会话展示原文。 */
export const WECHAT_AGENT_SOURCE_MARKER = '（消息通过微信 Bot 发送）'

/** 接收原始微信文本，返回追加来源的模型副本；重复处理时不追加第二个标记。 */
export function appendWeChatAgentSourceMarker(message: string): string {
  /** 只裁掉末尾空白，避免重复派发时误判已有来源标记。 */
  const trimmed = message.trimEnd()
  return trimmed.endsWith(WECHAT_AGENT_SOURCE_MARKER)
    ? trimmed
    : `${trimmed}\n\n${WECHAT_AGENT_SOURCE_MARKER}`
}
