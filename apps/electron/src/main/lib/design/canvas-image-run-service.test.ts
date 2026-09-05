import { describe, expect, test } from 'bun:test'
import type {
  CanvasImageCandidateBatch,
  CanvasImageModuleConfig,
  CanvasNode,
  CanvasTarget,
  CreateDesignJobInput,
  DesignJobRecord,
} from '@proma/shared'
import type { DesignJobChangedListener } from './design-job-manager'
import {
  createCanvasImageRunService,
  type CanvasImageBatchWaitInput,
} from './canvas-image-run-service'
import type { CanvasToolRunContext } from './canvas-tool-provider'

const target: CanvasTarget = { projectId: 'project-1', canvasId: 'canvas-1' }
const context: CanvasToolRunContext = {
  projectId: target.projectId,
  sessionId: 'session-1',
  runStartedAt: 99,
  explicitReferences: [],
  permissionCeiling: 'execute',
}

/** 创建图片节点，测试只改变稳定业务身份。 */
function createImageNode(id: string): Extract<CanvasNode, { kind: 'image' }> {
  return {
    id,
    kind: 'image',
    title: id,
    position: { x: 0, y: 0 },
    imageModuleId: `module-${id}`,
  }
}

/** 创建与目标图片模块精确绑定的配置。 */
function createConfig(node: Extract<CanvasNode, { kind: 'image' }>): CanvasImageModuleConfig {
  return {
    schemaVersion: 2,
    kind: 'image',
    contentId: node.imageModuleId,
    revision: 3,
    createdAt: 1,
    prompt: `prompt-${node.id}`,
    selectedModelProfileId: 'profile-1',
    aspectRatio: '1:1',
    imageSize: '1K',
    contextMode: 'none',
    adoptedAssetId: null,
    updatedAt: 1,
  }
}

/** 创建与候选批次和 Canvas 目标绑定的公开 Job。 */
function createJob(
  input: CreateDesignJobInput,
  id: string,
  status: DesignJobRecord['status'] = 'queued',
): DesignJobRecord {
  if (input.target?.kind !== 'canvas-image') throw new Error('测试图片目标无效')
  return {
    id,
    projectId: input.projectId,
    creativeTaskId: `creative-${id}`,
    attemptNumber: 1,
    action: input.action,
    status,
    prompt: input.prompt,
    originalRequest: input.prompt,
    contextMode: input.contextMode,
    target: input.target,
    canvasImageConfigRevision: input.canvasImageConfigRevision,
    candidateBatchId: input.candidateBatchId,
    imageModelSnapshot: {
      profileId: input.imageModelProfileId ?? 'profile-1',
      modelId: 'image-model-1',
      name: '测试模型',
      executor: 'nano-banana',
    },
    generationConstraints: input.generationConstraints,
    createdAt: 1,
    updatedAt: 1,
  }
}

interface HarnessOptions {
  preflight?: (input: CreateDesignJobInput) => Promise<void>
  createOnce?: (
    input: CreateDesignJobInput,
    jobId: string,
    jobs: Map<string, DesignJobRecord>,
  ) => Promise<{ job: DesignJobRecord; created: boolean }>
  run?: (jobId: string, jobs: Map<string, DesignJobRecord>) => Promise<void>
}

/** 构造完全内存化的服务依赖，并记录事务顺序与监听生命周期。 */
function createHarness(options: HarnessOptions = {}) {
  const calls: string[] = []
  const jobs = new Map<string, DesignJobRecord>()
  const batches = new Map<string, CanvasImageCandidateBatch>()
  const listeners = new Set<DesignJobChangedListener>()
  let leaseHeld = false
  const service = createCanvasImageRunService({
    serializer: {
      run: async (_target, effect) => {
        calls.push('serializer')
        return effect()
      },
    },
    guard: {
      runWorkspaceWrite: async (_projectId, effect) => {
        leaseHeld = true
        try {
          return await effect()
        } finally {
          leaseHeld = false
        }
      },
    },
    imageModules: {
      load: async (imageTarget) => {
        calls.push(`load:${imageTarget.nodeId}`)
        return createConfig(createImageNode(imageTarget.nodeId))
      },
    },
    imageJobs: {
      preflightCanvasImage: async (input) => {
        calls.push(`preflight:${input.target?.kind === 'canvas-image' ? input.target.nodeId : 'invalid'}`)
        await options.preflight?.(input)
      },
      createCanvasImageOnce: async (input, jobId) => {
        calls.push(`create:${input.target?.kind === 'canvas-image' ? input.target.nodeId : 'invalid'}`)
        if (options.createOnce) return options.createOnce(input, jobId, jobs)
        const existing = jobs.get(jobId)
        if (existing) return { job: existing, created: false }
        const job = createJob(input, jobId)
        jobs.set(jobId, job)
        return { job, created: true }
      },
      rollbackCanvasImageOnce: async (_projectId, jobId) => {
        calls.push(`rollback:${jobId}`)
        return jobs.delete(jobId)
      },
      run: async (jobId) => {
        calls.push(`run:${jobId}:${leaseHeld ? 'locked' : 'unlocked'}`)
        await options.run?.(jobId, jobs)
      },
      cancel: async (projectId, jobId) => {
        calls.push(`cancel:${jobId}`)
        const job = jobs.get(jobId)
        if (!job || job.projectId !== projectId) throw new Error('DESIGN_JOB_NOT_FOUND')
        const cancelled = { ...job, status: 'cancelled' as const }
        jobs.set(jobId, cancelled)
        return cancelled
      },
      getProjectJob: (projectId, jobId) => {
        const job = jobs.get(jobId)
        return job?.projectId === projectId ? job : undefined
      },
      onChanged: (listener) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    },
    candidateBatches: {
      createBatchLocked: async (input) => {
        calls.push('batch:create')
        const existing = batches.get(input.batchId)
        if (existing) return existing
        const batch: CanvasImageCandidateBatch = {
          schemaVersion: 1,
          projectId: input.projectId,
          canvasId: input.canvasId,
          batchId: input.batchId,
          source: input.source,
          sourceSessionId: input.sourceSessionId,
          sourceToolCallId: input.sourceToolCallId,
          status: 'running',
          entries: input.entries.map((entry) => ({
            ...entry,
            candidateAssetId: null,
            status: 'queued' as const,
            error: null,
          })),
          adoption: null,
          createdAt: 1,
          updatedAt: 1,
        }
        batches.set(input.batchId, batch)
        return batch
      },
      load: async (input) => {
        calls.push('batch:load')
        const batch = batches.get(input.batchId)
        if (!batch) throw new Error('CANVAS_IMAGE_BATCH_NOT_FOUND')
        return structuredClone(batch)
      },
    },
    getProjectReadOnlyReason: () => undefined,
  })
  return {
    service,
    calls,
    jobs,
    batches,
    listeners,
    emit(job: DesignJobRecord) {
      jobs.set(job.id, job)
      for (const listener of [...listeners]) listener({ job, revision: 1 })
    },
  }
}

describe('Canvas 图片统一运行服务', () => {
  test('Given 第二张图预检失败 When 批量运行 Then 全部预检完成前不创建 journal', async () => {
    const first = createImageNode('image-a')
    const second = createImageNode('image-b')
    const harness = createHarness({
      preflight: async (input) => {
        if (input.target?.kind === 'canvas-image' && input.target.nodeId === second.id) {
          throw new Error('PREFLIGHT_FAILED')
        }
      },
    })

    const result = await harness.service.run(context, target, [first, second], 'tool-1')

    expect(harness.calls.filter((call) => call.startsWith('create:'))).toHaveLength(0)
    expect(result.tasks).toEqual([
      { nodeId: first.id, status: 'blocked', error: 'CANVAS_BATCH_PREFLIGHT_BLOCKED' },
      { nodeId: second.id, status: 'failed', error: 'PREFLIGHT_FAILED' },
    ])
  })

  test('Given 相同父运行与工具调用 When 重放 Then 批次和任务 ID 稳定且不重复启动', async () => {
    const node = createImageNode('image-a')
    const harness = createHarness()

    const first = await harness.service.run(context, target, [node], 'tool-stable')
    const second = await harness.service.run(context, target, [node], 'tool-stable')

    expect(first.tasks[0]?.taskId).toMatch(/^agent-canvas-[a-f0-9]{64}$/)
    expect(second.tasks[0]?.taskId).toBe(first.tasks[0]?.taskId)
    expect(second.batch?.batchId).toBe(first.batch?.batchId)
    expect(harness.calls.filter((call) => call.startsWith('run:'))).toHaveLength(1)
  })

  test('Given 第二个 journal 创建失败 When 回滚 Then 只删除本轮新建 journal', async () => {
    const first = createImageNode('image-a')
    const second = createImageNode('image-b')
    const third = createImageNode('image-c')
    const harness = createHarness({
      createOnce: async (input, jobId, jobs) => {
        if (input.target?.kind !== 'canvas-image') throw new Error('测试图片目标无效')
        if (input.target.nodeId === first.id) {
          const existing = createJob(input, jobId)
          jobs.set(jobId, existing)
          return { job: existing, created: false }
        }
        if (input.target.nodeId === second.id) throw new Error('CREATE_FAILED')
        const job = createJob(input, jobId)
        jobs.set(jobId, job)
        return { job, created: true }
      },
    })

    const result = await harness.service.run(context, target, [first, second, third], 'tool-rollback')

    expect(harness.calls.filter((call) => call.startsWith('rollback:'))).toHaveLength(0)
    expect(result.tasks).toEqual([
      { nodeId: first.id, status: 'queued', taskId: expect.any(String) },
      { nodeId: second.id, status: 'failed', error: 'CREATE_FAILED' },
      { nodeId: third.id, status: 'blocked', error: 'CANVAS_BATCH_JOB_CREATION_BLOCKED' },
    ])
  })

  test('Given 全部 journal 已建立 When 启动任务 Then 先登记候选批次且锁外启动', async () => {
    const harness = createHarness()

    await harness.service.run(context, target, [createImageNode('image-a')], 'tool-order')

    expect(harness.calls.indexOf('batch:create')).toBeLessThan(
      harness.calls.findIndex((call) => call.startsWith('run:')),
    )
    expect(harness.calls.find((call) => call.startsWith('run:'))).toContain('unlocked')
  })

  test('Given 非图片节点 When 低层运行 Then 保持 idle 且不创建图片任务', async () => {
    const harness = createHarness()
    const node: CanvasNode = {
      id: 'document-1', kind: 'document', title: '文档', position: { x: 0, y: 0 },
      documentId: 'document-content-1', contentRevision: 0,
    }

    const result = await harness.service.run(context, target, [node], 'tool-idle')

    expect(result).toEqual({ tasks: [{ nodeId: node.id, status: 'idle' }] })
    expect(harness.calls).toHaveLength(0)
  })

  test('Given 已知批次 When 相关 Job 进入终态 Then 通过单次监听重读并返回无素材 ID 摘要', async () => {
    const node = createImageNode('image-a')
    const harness = createHarness()
    const started = await harness.service.run(context, target, [node], 'tool-wait')
    const taskId = started.tasks[0]?.taskId
    const batchId = started.batch?.batchId
    if (!taskId || !batchId) throw new Error('测试批次未创建')
    const batch = harness.batches.get(batchId)
    const job = harness.jobs.get(taskId)
    if (!batch || !job) throw new Error('测试任务未创建')
    const waitInput: CanvasImageBatchWaitInput = {
      ...target,
      batchId,
      taskIds: [taskId],
      signal: new AbortController().signal,
      deadlineAt: Date.now() + 5_000,
    }

    const waiting = harness.service.awaitBatch(waitInput)
    await Promise.resolve()
    harness.batches.set(batchId, {
      ...batch,
      status: 'ready',
      entries: batch.entries.map((entry) => ({ ...entry, status: 'candidate', candidateAssetId: 'asset-secret' })),
    })
    harness.emit({ ...job, status: 'succeeded', outputAssetId: 'asset-secret' })
    const summary = await waiting

    expect(summary).toEqual({
      batchId, status: 'ready', totalCount: 1, candidateCount: 1,
      failedCount: 0, runningCount: 0, requiresCanvasReview: true,
    })
    expect(JSON.stringify(summary)).not.toContain('asset')
    expect(harness.listeners.size).toBe(0)
  })

  test('Given Job 终态事件早于候选登记 When 下一微任务提交批次 Then 同一事件仍可唤醒终态重读', async () => {
    const node = createImageNode('image-a')
    const harness = createHarness()
    const started = await harness.service.run(context, target, [node], 'tool-event-order')
    const taskId = started.tasks[0]?.taskId
    const batchId = started.batch?.batchId
    if (!taskId || !batchId) throw new Error('测试批次未创建')
    const batch = harness.batches.get(batchId)
    const job = harness.jobs.get(taskId)
    if (!batch || !job) throw new Error('测试任务未创建')

    const waiting = harness.service.awaitBatch({
      ...target,
      batchId,
      taskIds: [taskId],
      signal: new AbortController().signal,
      deadlineAt: Date.now() + 200,
    })
    await Promise.resolve()
    harness.emit({ ...job, status: 'failed', error: 'IMAGE_FAILED' })
    await Promise.resolve()
    harness.batches.set(batchId, {
      ...batch,
      status: 'partial',
      entries: batch.entries.map((entry) => ({ ...entry, status: 'failed', error: 'IMAGE_FAILED' })),
    })

    await expect(waiting).resolves.toMatchObject({
      batchId,
      status: 'partial',
      runningCount: 0,
      failedCount: 1,
    })
  })

  test('Given 等待被中止 When 清理 Then 移除监听且只取消输入中仍属于批次的活跃任务', async () => {
    const node = createImageNode('image-a')
    const harness = createHarness()
    const started = await harness.service.run(context, target, [node], 'tool-abort')
    const taskId = started.tasks[0]?.taskId
    const batchId = started.batch?.batchId
    if (!taskId || !batchId) throw new Error('测试批次未创建')
    const foreignInput: CreateDesignJobInput = {
      projectId: target.projectId,
      target: { kind: 'canvas-image', canvasId: 'canvas-foreign', nodeId: 'foreign', imageModuleId: 'module-foreign' },
      action: 'generate', prompt: 'foreign', contextMode: 'none', imageModelProfileId: 'profile-1',
      generationConstraints: { aspectRatio: '1:1', imageSize: '1K' },
      canvasImageConfigRevision: 1, candidateBatchId: batchId,
    }
    harness.jobs.set('foreign-job', createJob(foreignInput, 'foreign-job', 'running'))
    const abortController = new AbortController()
    const waiting = harness.service.awaitBatch({
      ...target,
      batchId,
      taskIds: [taskId, 'foreign-job'],
      signal: abortController.signal,
      deadlineAt: Date.now() + 5_000,
    })
    await Promise.resolve()
    abortController.abort()

    await expect(waiting).rejects.toThrow('CANVAS_IMAGE_BATCH_WAIT_ABORTED')
    expect(harness.calls.filter((call) => call.startsWith('cancel:'))).toEqual([`cancel:${taskId}`])
    expect(harness.listeners.size).toBe(0)
  })

  test('Given 等待期限已过 When 进入服务 Then 不保留监听并取消本批活跃任务', async () => {
    const node = createImageNode('image-a')
    const harness = createHarness()
    const started = await harness.service.run(context, target, [node], 'tool-deadline')
    const taskId = started.tasks[0]?.taskId
    const batchId = started.batch?.batchId
    if (!taskId || !batchId) throw new Error('测试批次未创建')

    await expect(harness.service.awaitBatch({
      ...target,
      batchId,
      taskIds: [taskId],
      signal: new AbortController().signal,
      deadlineAt: Date.now() - 1,
    })).rejects.toThrow('CANVAS_IMAGE_BATCH_WAIT_DEADLINE')

    expect(harness.calls.filter((call) => call.startsWith('cancel:'))).toEqual([`cancel:${taskId}`])
    expect(harness.listeners.size).toBe(0)
  })
})
