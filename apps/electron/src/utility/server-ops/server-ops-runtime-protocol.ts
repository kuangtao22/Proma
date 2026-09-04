import type { ServerOpsHostKey, ServerOpsTerminalExitEvent, ServerOpsTerminalOutputAck, ServerOpsTerminalOutputEvent } from '@proma/shared'

/** utility process 接收的 SSH 认证材料。 */
export type ServerOpsRuntimeAuthentication =
  | { kind: 'password'; password: string }
  | { kind: 'private-key'; privateKey: Uint8Array; passphrase?: string }
  | { kind: 'ssh-agent'; agent: string }

/** 主进程发往 runtime 的真实连接请求。 */
export interface ServerOpsRuntimeConnectRequest {
  requestId: string
  hostId: string
  connectionId: string
  address: string
  port: number
  username: string
  expectedHostKey?: ServerOpsHostKey
  authentication: ServerOpsRuntimeAuthentication
  cols: number
  rows: number
}

/** runtime 在认证前拒绝或成功打开 PTY 的结果。 */
export type ServerOpsRuntimeConnectResult =
  | { status: 'host-key-rejected'; observedHostKey: ServerOpsHostKey }
  | { status: 'connected'; hostKey: ServerOpsHostKey }

/** 主进程发往 SSH runtime 的内部消息。 */
export type ServerOpsRuntimeRequest =
  | { type: 'server-ops.connect'; input: ServerOpsRuntimeConnectRequest }
  | { type: 'server-ops.disconnect'; hostId: string; connectionId: string }
  | { type: 'server-ops.terminal-input'; hostId: string; connectionId: string; data: string }
  | { type: 'server-ops.terminal-resize'; hostId: string; connectionId: string; cols: number; rows: number }
  | { type: 'server-ops.terminal-ack'; input: ServerOpsTerminalOutputAck }
  | { type: 'server-ops.shutdown' }

/** SSH runtime 发回主进程的内部消息。 */
export type ServerOpsRuntimeMessage =
  | { type: 'server-ops.ready'; pid: number }
  | { type: 'server-ops.connect-result'; requestId: string; hostId: string; connectionId: string; result: ServerOpsRuntimeConnectResult }
  | { type: 'server-ops.error'; requestId?: string; hostId: string; connectionId: string; code: string; message: string }
  | { type: 'server-ops.terminal-output'; event: ServerOpsTerminalOutputEvent }
  | { type: 'server-ops.terminal-exit'; event: ServerOpsTerminalExitEvent }
  | { type: 'server-ops.stopped' }
