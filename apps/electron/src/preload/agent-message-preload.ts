import type { AgentMessageInvokeResult } from '@proma/shared'

/** 将主进程安全信封恢复为 Renderer 熟悉的 Promise 成功/拒绝语义。 */
export async function unwrapAgentMessageInvokeResult<T>(
  resultPromise: Promise<AgentMessageInvokeResult<T>>,
): Promise<T> {
  const result = await resultPromise
  if (result.ok) return result.value
  throw Object.assign(new Error(result.error.message), { code: result.error.code })
}
