import { describe, expect, test } from 'bun:test'
import { createEmptyCanvasDocument } from '@proma/shared'
import { createCanvasAgentReconciliation } from './canvas-agent-reconciliation'

describe('Canvas Agent 查询与启动恢复边界', () => {
  test.each(['batch', 'agent', 'prepare', 'success'] as const)(
    'Given 图恢复已提交 When %s 阶段结束 Then 解锁后保留 publication 再返回真实结果', async (stage) => {
      /** 可观察锁状态与顺序，防止失败恢复通知仍处于写 lease 内。 */
      let locked = false
      const order: string[] = []
      const target = { projectId: 'project-1', canvasId: 'canvas-1' }
      const document = { ...createEmptyCanvasDocument(target.projectId, target.canvasId, 1), revision: 6 }
      const publication = { document, source: { sessionId: 'session-1', runStartedAt: 1, toolCallId: 'tool-1' } }
      const failure = new Error('ARCHIVE_FAILED')
      const reconcile = createCanvasAgentReconciliation({
        runExclusive: async (_target, effect) => {
          locked = true
          try { return await effect() } finally { locked = false; order.push('unlock') }
        },
        loadSnapshot: () => ({ document, writable: true, nodeIssues: [] }),
        reconcileBatch: async () => {
          if (stage === 'batch') throw Object.assign(new Error('reconciliation'), {
            name: 'CanvasBatchReconciliationError', causeError: failure, publications: [publication],
          })
          return { document, operationId: 'operation-1', publications: [publication] }
        },
        reconcileAgent: async () => {
          if (stage === 'agent') throw failure
          return { snapshot: { document, writable: true, nodeIssues: [] }, documentChanged: true }
        },
        publish: () => { expect(locked).toBe(false); order.push('publish') },
      })
      const pending = reconcile(target, () => {
        expect(locked).toBe(true)
        if (stage === 'prepare') throw failure
        return 'reserved'
      })
      if (stage === 'success') expect(await pending).toBe('reserved')
      else await expect(pending).rejects.toBe(failure)
      expect(order).toEqual(['unlock', 'publish'])
    },
  )

  test.each(['batch-load', 'agent-load'] as const)(
    'Given %s 首次消费低 revision 恢复 When Agent 对账发布 Then recovery 原因优先且只发布一次',
    async (stage) => {
      const target = { projectId: 'project-1', canvasId: 'canvas-1' }
      const recovered = { ...createEmptyCanvasDocument(target.projectId, target.canvasId, 1), revision: 2 }
      const publications: Array<{ revision: number; cause: string }> = []
      let firstLoad = true
      const reconcile = createCanvasAgentReconciliation({
        runExclusive: async (_target, effect) => effect(),
        loadSnapshot: () => {
          if (stage === 'batch-load' && firstLoad) {
            firstLoad = false
            return { document: recovered, writable: true, nodeIssues: [], recoveredFrom: 'backup' }
          }
          return { document: recovered, writable: true, nodeIssues: [] }
        },
        reconcileBatch: async () => ({
          document: recovered,
          operationId: 'operation-1',
          publications: [{ document: recovered, source: { sessionId: 'session-1', runStartedAt: 1, toolCallId: 'tool-1' } }],
        }),
        reconcileAgent: async () => ({
          snapshot: {
            document: recovered, writable: true, nodeIssues: [],
            ...(stage === 'agent-load' ? { recoveredFrom: 'tmp' as const } : {}),
          },
          documentChanged: true,
        }),
        publish: (_target, publication) => {
          publications.push({ revision: publication.document.revision, cause: publication.cause })
        },
      })

      await expect(reconcile(target, (snapshot) => snapshot.document.revision)).resolves.toBe(2)
      expect(publications).toEqual([{ revision: 2, cause: 'recovery' }])
    },
  )
})
