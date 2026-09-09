import { describe, expect, test } from 'bun:test'
import type { DesignJobChangedEvent } from './design-job-manager'
import { waitForCanvasImageTaskTerminal } from './canvas-task-waiter'
import type { DesignJobRecord } from '@proma/shared'

const target = {
  projectId: 'project-1', canvasId: 'canvas-1', nodeId: 'node-1',
  imageModuleId: 'module-1', jobId: 'job-1',
}

/** 创建满足精确 Canvas 身份的最小任务记录。 */
function createJob(status: DesignJobRecord['status'], overrides: Partial<DesignJobRecord> = {}): DesignJobRecord {
  return {
    id: target.jobId, creativeTaskId: 'task-1', attemptNumber: 1, projectId: target.projectId,
    target: { kind: 'canvas-image', canvasId: target.canvasId, nodeId: target.nodeId, imageModuleId: target.imageModuleId },
    action: 'generate', status, prompt: '生成图片', originalRequest: '生成图片', contextMode: 'none',
    createdAt: 1, updatedAt: 1, ...overrides,
  }
}

/** 创建可观察监听器释放情况的内存事件源。 */
function createSource(initial: DesignJobRecord) {
  let current = initial
  const listeners = new Set<(event: DesignJobChangedEvent) => void>()
  return {
    get listenerCount() { return listeners.size },
    read: () => current,
    subscribe(listener: (event: DesignJobChangedEvent) => void) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    emit(job: DesignJobRecord) {
      current = job
      for (const listener of [...listeners]) listener({ job, revision: 1 })
    },
  }
}

describe('Canvas 图片任务有界等待', () => {
  test('Given 订阅后复读时任务已终态 When 等待 Then 立即返回并释放监听器', async () => {
    const source = createSource(createJob('succeeded'))

    const result = await waitForCanvasImageTaskTerminal(target, 30_000, {
      readCurrent: source.read,
      subscribe: source.subscribe,
    })

    expect(result).toEqual({ outcome: 'terminal', status: 'succeeded' })
    expect(source.listenerCount).toBe(0)
  })

  test('Given 其他任务先完成 When 等待精确任务 Then 忽略外部事件直到目标终态', async () => {
    const source = createSource(createJob('running'))
    const waiting = waitForCanvasImageTaskTerminal(target, 1_000, {
      readCurrent: source.read,
      subscribe: source.subscribe,
    })
    source.emit(createJob('failed', { id: 'job-other' }))
    expect(source.listenerCount).toBe(1)
    source.emit(createJob('succeeded'))

    await expect(waiting).resolves.toEqual({ outcome: 'terminal', status: 'succeeded' })
    expect(source.listenerCount).toBe(0)
  })

  test('Given 图片服务超过旧 30 秒才完成 When 等待 60 秒窗口 Then 返回成功而不是误报超时', async () => {
    const source = createSource(createJob('running'))
    const waiting = waitForCanvasImageTaskTerminal(target, 60, {
      readCurrent: source.read,
      subscribe: source.subscribe,
    })
    setTimeout(() => { source.emit(createJob('succeeded')) }, 35)

    await expect(waiting).resolves.toEqual({ outcome: 'terminal', status: 'succeeded' })
    expect(source.listenerCount).toBe(0)
  })

  test('Given 目标持续运行或调用被取消 When 等待结束 Then 超时与取消都释放监听器', async () => {
    const timeoutSource = createSource(createJob('running'))
    await expect(waitForCanvasImageTaskTerminal(target, 5, {
      readCurrent: timeoutSource.read,
      subscribe: timeoutSource.subscribe,
    })).resolves.toEqual({ outcome: 'timeout', status: 'running' })
    expect(timeoutSource.listenerCount).toBe(0)

    const abortSource = createSource(createJob('running'))
    const controller = new AbortController()
    const aborted = waitForCanvasImageTaskTerminal(target, 30_000, {
      readCurrent: abortSource.read,
      subscribe: abortSource.subscribe,
      signal: controller.signal,
    })
    controller.abort()
    await expect(aborted).rejects.toThrow('CANVAS_OPERATION_CANCELLED')
    expect(abortSource.listenerCount).toBe(0)
  })

  test('Given 复读失败或任务消失 When 等待 Then 保留固定错误并释放监听器', async () => {
    const failedSource = createSource(createJob('running'))
    let failedReads = 0
    await expect(waitForCanvasImageTaskTerminal(target, 5, {
      readCurrent: () => {
        failedReads += 1
        if (failedReads === 1) return createJob('running')
        throw new Error('CANVAS_TASK_READ_FAILED')
      },
      subscribe: failedSource.subscribe,
    })).rejects.toThrow('CANVAS_TASK_READ_FAILED')
    expect(failedSource.listenerCount).toBe(0)

    const missingSource = createSource(createJob('running'))
    let missingReads = 0
    await expect(waitForCanvasImageTaskTerminal(target, 5, {
      readCurrent: () => {
        missingReads += 1
        return missingReads === 1 ? createJob('running') : undefined
      },
      subscribe: missingSource.subscribe,
    })).rejects.toThrow('CANVAS_TASK_IDENTITY_MISMATCH')
    expect(missingSource.listenerCount).toBe(0)
  })
})
