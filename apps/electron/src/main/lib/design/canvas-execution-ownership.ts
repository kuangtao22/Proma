import { lstatSync } from 'node:fs'
import { join } from 'node:path'
import type { CanvasOrchestrationRecord, CanvasTarget, CanvasWorkflowRun } from '@proma/shared'
import { acquireMediaFileLock } from '../media/media-file-lock'
import type { DesignPathResolver } from './design-paths'
import { isSafeDesignStableId } from './design-paths'

/** 业务编排和存量 DAG 使用不同执行器，但共享同画布的调度准入。 */
export type CanvasExecutionKind = 'orchestration' | 'workflow'

/** 准入只依赖现有持久记录，不复制运行状态或维护第二份租约文件。 */
export interface CanvasExecutionOwnershipDependencies {
  pathResolver: Pick<DesignPathResolver, 'resolveCanvas'>
  getOrchestration: (target: CanvasTarget) => CanvasOrchestrationRecord | null
  listWorkflows: (target: CanvasTarget) => CanvasWorkflowRun[]
  runWorkspaceWrite: <T>(projectId: string, effect: () => T) => T
}

/** 检查与登记必须在同一个同步临界区内，不得把异步准备工作放进锁。 */
export interface CanvasExecutionOwnership {
  run: <T>(target: CanvasTarget, kind: CanvasExecutionKind, register: () => T) => T
}

/** 跨进程短锁只覆盖检查及持久创建；等待、模型运行和媒体执行不持有该锁。 */
export function createCanvasExecutionOwnership(dependencies: CanvasExecutionOwnershipDependencies): CanvasExecutionOwnership {
  return {
    run: (target, kind, register) => dependencies.runWorkspaceWrite(target.projectId, () => {
      if (!isSafeDesignStableId(target.projectId) || !isSafeDesignStableId(target.canvasId)) {
        throw new Error('CANVAS_EXECUTION_TARGET_INVALID')
      }
      /** 固定根路径经过 Host 解析，符号链接不能成为准入文件的写入目标。 */
      const canvasRoot = dependencies.pathResolver.resolveCanvas(target.projectId, target.canvasId).canvasRoot
      const rootState = lstatSync(canvasRoot)
      if (!rootState.isDirectory() || rootState.isSymbolicLink()) throw new Error('CANVAS_EXECUTION_PATH_INVALID')
      /** 短锁让两个进程不能同时检查为空后各自创建一套调度记录。 */
      let release: () => void
      try {
        release = acquireMediaFileLock(join(canvasRoot, 'execution-admission.lock'))
      } catch (error) {
        if (error instanceof Error && error.message === 'MEDIA_FILE_BUSY') throw new Error('CANVAS_EXECUTION_BUSY')
        throw error
      }
      try {
        if (kind === 'workflow') {
          const record = dependencies.getOrchestration(target)
          if (record && record.status !== 'completed' && record.status !== 'cancelled') {
            throw new Error('CANVAS_ORCHESTRATION_OWNS_EXECUTION')
          }
        } else if (dependencies.listWorkflows(target).some(run => run.status !== 'completed' && run.status !== 'cancelled')) {
          throw new Error('CANVAS_WORKFLOW_OWNS_EXECUTION')
        }
        return register()
      } finally {
        release()
      }
    }),
  }
}
