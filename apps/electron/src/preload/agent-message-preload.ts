import type { AgentMessageInvokeResult } from '@proma/shared'

/** Preload 调用 Agent 消息 IPC 所需的最小 ipcRenderer 表面。 */
export interface AgentMessageIpcInvoker {
  invoke: (channel: string, input: unknown) => Promise<unknown>
}

/** 将主进程安全信封恢复为 Renderer 熟悉的 Promise 成功/拒绝语义。 */
export async function unwrapAgentMessageInvokeResult<T>(
  resultPromise: Promise<AgentMessageInvokeResult<T>>,
): Promise<T> {
  const result = await resultPromise
  if (result.ok) return result.value
  throw Object.assign(new Error(result.error.message), { code: result.error.code })
}

/** 调用真实 Agent 消息通道并恢复 Renderer 熟悉的 Promise 语义。 */
export function invokeAgentMessage<T>(
  ipcRenderer: AgentMessageIpcInvoker,
  channel: string,
  input: unknown,
): Promise<T> {
  return unwrapAgentMessageInvokeResult(
    ipcRenderer.invoke(channel, input) as Promise<AgentMessageInvokeResult<T>>,
  )
}
