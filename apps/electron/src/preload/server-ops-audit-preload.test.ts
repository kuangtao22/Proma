import { describe, expect, test } from 'bun:test'
import { invokeServerOpsAuditList } from './server-ops-audit-preload'

describe('Server Ops 审计 preload 边界', () => {
  test('Given main 返回未知内部字段 When preload 接收 Then 严格拒绝而不转发 Renderer', async () => {
    /** 模拟被污染的 main IPC 返回值。 */
    const invoke = async (): Promise<unknown> => ({ records: [], internalPath: '/secret/audit.json' })

    await expect(invokeServerOpsAuditList(invoke, {})).rejects.toThrow('SERVER_OPS_AUDIT_LIST_RESULT_INVALID')
  })
})
