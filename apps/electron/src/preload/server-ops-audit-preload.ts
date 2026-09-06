import { parseServerOpsAuditListResult, SERVER_OPS_IPC_CHANNELS } from '@proma/shared'
import type { ServerOpsAuditListInput, ServerOpsAuditListResult } from '@proma/shared'

/** Preload 审计调用所需的最小 invoke 签名。 */
export type ServerOpsAuditInvoke = (channel: string, input: ServerOpsAuditListInput) => Promise<unknown>

/** 调用审计 IPC 并在 Renderer 边界前严格解析公开返回合同。 */
export async function invokeServerOpsAuditList(
  invoke: ServerOpsAuditInvoke,
  input: ServerOpsAuditListInput,
): Promise<ServerOpsAuditListResult> {
  /** 主进程返回的未知值必须再次经过 preload fail-closed 校验。 */
  const result = await invoke(SERVER_OPS_IPC_CHANNELS.LIST_AUDIT, input)
  return parseServerOpsAuditListResult(result)
}
