/** 单条入站 WS 消息允许的最大字节数，避免 ws 默认 100 MiB 缓冲。 */
export const LAN_BRIDGE_MAX_PAYLOAD_BYTES = 64 * 1_024

/** LAN Bridge WebSocketServer 使用的固定资源防护选项。 */
export const LAN_BRIDGE_WEBSOCKET_SERVER_OPTIONS = {
  noServer: true,
  maxPayload: LAN_BRIDGE_MAX_PAYLOAD_BYTES,
} as const
