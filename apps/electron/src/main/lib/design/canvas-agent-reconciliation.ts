import type { CanvasChangeEvent, CanvasTarget, CanvasWorkspaceSnapshot } from '@proma/shared'
import type { CanvasAgentNodeCreationService } from './canvas-agent-node-creation'
import type { CanvasBatchPublication, CanvasBatchReconciliationResult } from './canvas-agent-batch-operation'
import { unwrapCanvasBatchReconciliationError } from './canvas-agent-batch-operation'

/** Agent 查询和启动共用的图恢复边界，运行本身不持有写锁。 */
export interface CanvasAgentReconciliationDependencies {
  runExclusive: <T>(target: CanvasTarget, effect: () => Promise<T>) => Promise<T>
  loadSnapshot: (target: CanvasTarget) => CanvasWorkspaceSnapshot
  reconcileBatch: (target: CanvasTarget) => Promise<CanvasBatchReconciliationResult>
  reconcileAgent: CanvasAgentNodeCreationService['reconcile']
  publish: (target: CanvasTarget, publication: CanvasAgentReconciliationPublication) => void
}

/** Agent 对账锁外发布的最小事实，恢复事件必须保留非单调 revision 语义。 */
export interface CanvasAgentReconciliationPublication
  extends Pick<CanvasBatchPublication, 'document'>, Partial<Pick<CanvasBatchPublication, 'source'>> {
  cause: Extract<CanvasChangeEvent['cause'], 'graph' | 'recovery'>
}

/**
 * 创建统一恢复入口，始终先释放写锁、发布已提交事实，再返回结果或错误。
 * @param dependencies 原有串行器、写守卫、恢复服务及广播。
 * @returns 在权威快照上同步预留启动状态的泛型函数。
 */
export function createCanvasAgentReconciliation(dependencies: CanvasAgentReconciliationDependencies) {
  return async <T>(target: CanvasTarget, effect: (snapshot: CanvasWorkspaceSnapshot) => T): Promise<T> => {
    /** 逐阶段保留事实，后续对账或准入失败不会清空前面已提交的结果。 */
    const publications: CanvasAgentReconciliationPublication[] = []
    const outcome = await dependencies.runExclusive(target, async () => {
      try {
        /** batch 扫描也会 LOAD 并消费 tmp/backup，必须由统一入口先捕获恢复身份。 */
        const initialSnapshot = dependencies.loadSnapshot(target)
        if (initialSnapshot.recoveredFrom) {
          publications.push({ document: initialSnapshot.document, cause: 'recovery' })
        }
        publications.push(...(await dependencies.reconcileBatch(target)).publications.map((publication) => ({
          ...publication,
          cause: 'graph' as const,
        })))
        const agent = await dependencies.reconcileAgent(target)
        if (agent.snapshot.recoveredFrom) {
          publications.push({ document: agent.snapshot.document, cause: 'recovery' })
        } else if (agent.documentChanged) {
          publications.push({ document: agent.snapshot.document, cause: 'graph' })
        }
        if (agent.error) throw agent.error
        return { ok: true as const, value: effect(agent.snapshot) }
      } catch (error) {
        const failure = unwrapCanvasBatchReconciliationError(error)
        publications.push(...failure.publications.map((publication) => ({
          ...publication,
          cause: 'graph' as const,
        })))
        return { ok: false as const, error: failure.error }
      }
    })
    /** 同一 revision 只发布一次；单窗口错误由 publish 适配器隔离。 */
    const pendingByRevision = new Map<number, CanvasAgentReconciliationPublication>()
    for (const publication of publications) {
      const previous = pendingByRevision.get(publication.document.revision)
      if (!previous || publication.cause === 'recovery') {
        pendingByRevision.set(publication.document.revision, publication)
      }
    }
    for (const publication of pendingByRevision.values()) {
      dependencies.publish(target, publication)
    }
    if (!outcome.ok) throw outcome.error
    return outcome.value
  }
}
