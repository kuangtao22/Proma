import { describe, expect, spyOn, test } from 'bun:test'
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
  start?: (jobId: string, jobs: Map<string, DesignJobRecord>) => Promise<void>
  cancel?: (projectId: string, jobId: string, jobs: Map<string, DesignJobRecord>) => Promise<void>
  createBatch?: () => Promise<void>
  loadBatch?: (callCount: number) => Promise<void>
}

/** 构造完全内存化的服务依赖，并记录事务顺序与监听生命周期。 */
function createHarness(options: HarnessOptions = {}) {
  const calls: string[] = []
  const jobs = new Map<string, DesignJobRecord>()
  const batches = new Map<string, CanvasImageCandidateBatch>()
  const listeners = new Set<DesignJobChangedListener>()
  /** 候选批次变化监听器模拟权威 JSON 保存完成后的 ack。 */
  const batchListeners = new Set<(event: CanvasTarget & { batchId: string; jobId: string }) => void>()
  let leaseHeld = false
  let batchLoadCount = 0
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
      start: async (jobId) => {
        calls.push(`start:${jobId}:${leaseHeld ? 'locked' : 'unlocked'}`)
        await options.start?.(jobId, jobs)
      },
      cancel: async (projectId, jobId) => {
        calls.push(`cancel:${jobId}`)
        const job = jobs.get(jobId)
        if (!job || job.projectId !== projectId) throw new Error('DESIGN_JOB_NOT_FOUND')
        await options.cancel?.(projectId, jobId, jobs)
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
        await options.createBatch?.()
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
        batchLoadCount += 1
        await options.loadBatch?.(batchLoadCount)
        /** 模拟生产 exact-key parser，禁止等待或取消字段穿透候选服务。 */
        const keys = Object.keys(input).sort()
        if (JSON.stringify(keys) !== JSON.stringify(['batchId', 'canvasId', 'projectId'])) {
          throw new Error('CANVAS_IMAGE_CANDIDATE_BATCH_INPUT_INVALID')
        }
        const batch = batches.get(input.batchId)
        if (!batch) throw new Error('CANVAS_IMAGE_BATCH_NOT_FOUND')
        return structuredClone(batch)
      },
      onChanged: (listener: (event: CanvasTarget & { batchId: string; jobId: string }) => void) => {
        batchListeners.add(listener)
        return () => { batchListeners.delete(listener) }
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
    batchListeners,
    emit(job: DesignJobRecord) {
      jobs.set(job.id, job)
      for (const listener of [...listeners]) listener({ job, revision: 1 })
    },
    emitBatchChange(batchId: string, jobId: string) {
      for (const listener of [...batchListeners]) listener({ ...target, batchId, jobId })
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
    expect(harness.calls.filter((call) => call.startsWith('start:'))).toHaveLength(1)
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
      harness.calls.findIndex((call) => call.startsWith('start:')),
    )
    expect(harness.calls.find((call) => call.startsWith('start:'))).toContain('unlocked')
  })

  test('Given Job 完成 Promise 长时间运行 When 批次启动已确认 Then 立即返回 owned task IDs', async () => {
    const harness = createHarness()

    const result = await harness.service.run(context, target, [createImageNode('image-a')], 'tool-start-ack')

    expect(result.tasks).toEqual([{
      nodeId: 'image-a',
      status: 'started',
      taskId: expect.stringMatching(/^agent-canvas-[a-f0-9]{64}$/),
    }])
    expect(harness.calls.filter((call) => call.startsWith('start:'))).toHaveLength(1)
  })

  test.each([
    ['abort', 'CANVAS_IMAGE_RUN_ABORTED'],
    ['deadline', 'CANVAS_IMAGE_RUN_DEADLINE'],
  ] as const)('Given 创建阶段延迟且发生 %s When 返回 owned IDs Then 不启动任务并清理 active journal', async (reason, code) => {
    const batchCreation = Promise.withResolvers<void>()
    const abortController = new AbortController()
    const harness = createHarness({ createBatch: async () => batchCreation.promise })
    const running = harness.service.run(
      context,
      target,
      [createImageNode('image-a')],
      `tool-create-${reason}`,
      {
        signal: abortController.signal,
        deadlineAt: reason === 'deadline' ? Date.now() + 10 : Date.now() + 5_000,
      },
    )
    while (!harness.calls.includes('batch:create')) await Promise.resolve()
    if (reason === 'abort') abortController.abort()
    else await Bun.sleep(15)
    batchCreation.resolve()

    await expect(running).rejects.toThrow(code)
    expect(harness.calls.filter((call) => call.startsWith('start:'))).toHaveLength(0)
    expect(harness.calls.filter((call) => call.startsWith('cancel:'))).toHaveLength(1)
  })

  test('Given start 已确认但批次加载延迟 When 期间中止 Then 精确取消 owned jobs 并保留主错误', async () => {
    const batchLoad = Promise.withResolvers<void>()
    const abortController = new AbortController()
    const harness = createHarness({
      loadBatch: async (callCount) => {
        if (callCount === 1) await batchLoad.promise
      },
    })
    const running = harness.service.run(
      context,
      target,
      [createImageNode('image-a')],
      'tool-load-abort',
      { signal: abortController.signal, deadlineAt: Date.now() + 5_000 },
    )
    while (!harness.calls.includes('batch:load')) await Promise.resolve()
    abortController.abort()

    await expect(running).rejects.toThrow('CANVAS_IMAGE_RUN_ABORTED')
    const taskId = [...harness.jobs.keys()][0]
    expect(harness.calls.filter((call) => call.startsWith('cancel:'))).toEqual([`cancel:${taskId}`])
    batchLoad.resolve()
  })

  test('Given start ack 被期限阻塞 When 已拥有批次任务 Then 精确取消并保留期限错误', async () => {
    const startAck = Promise.withResolvers<void>()
    const harness = createHarness({ start: async () => startAck.promise })

    try {
      await expect(harness.service.run(
        context,
        target,
        [createImageNode('image-a')],
        'tool-start-deadline',
        { signal: new AbortController().signal, deadlineAt: Date.now() + 10 },
      )).rejects.toThrow('CANVAS_IMAGE_RUN_DEADLINE')
      const taskId = [...harness.jobs.keys()][0]
      expect(taskId).toBeDefined()
      expect(harness.calls.filter((call) => call.startsWith('cancel:'))).toEqual([`cancel:${taskId}`])
    } finally {
      startAck.resolve()
    }
  })

  test('Given start ack 等待被中止且取消与日志都失败 When 收口 Then 保留稳定中止错误', async () => {
    const startAck = Promise.withResolvers<void>()
    const abortController = new AbortController()
    const harness = createHarness({
      start: async () => startAck.promise,
      cancel: async () => { throw new Error('credential=secret') },
    })
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {
      throw new Error('LOGGER_FAILED')
    })
    const running = harness.service.run(
      context,
      target,
      [createImageNode('image-a')],
      'tool-start-abort',
      { signal: abortController.signal, deadlineAt: Date.now() + 5_000 },
    )
    await Promise.resolve()
    abortController.abort()

    try {
      await expect(running).rejects.toThrow('CANVAS_IMAGE_RUN_ABORTED')
      expect(errorSpy).toHaveBeenCalledWith('[CanvasImageDiagnostics] CANVAS_IMAGE_RUN_CANCEL_CLEANUP_FAILED')
      expect(JSON.stringify(errorSpy.mock.calls)).not.toContain('credential=secret')
    } finally {
      startAck.resolve()
      errorSpy.mockRestore()
    }
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
      entries: [{ nodeId: node.id, taskId, status: 'candidate' }],
    })
    expect(JSON.stringify(summary)).not.toContain('asset')
    expect(harness.listeners.size).toBe(0)
    expect(harness.batchListeners.size).toBe(0)
  })

  test('Given 混合成功失败批次 When 等待终态 Then 返回稳定排序且脱敏的逐节点状态', async () => {
    const nodes = [createImageNode('image-b'), createImageNode('image-a')]
    const harness = createHarness()
    const started = await harness.service.run(context, target, nodes, 'tool-mixed-terminal')
    const batchId = started.batch?.batchId
    const taskIds = started.tasks.flatMap((task) => task.taskId ? [task.taskId] : [])
    if (!batchId || taskIds.length !== 2) throw new Error('测试批次未创建')
    const batch = harness.batches.get(batchId)
    if (!batch) throw new Error('测试候选批次未创建')
    const waiting = harness.service.awaitBatch({
      ...target,
      batchId,
      taskIds,
      signal: new AbortController().signal,
      deadlineAt: Date.now() + 5_000,
    })
    await Promise.resolve()
    harness.batches.set(batchId, {
      ...batch,
      status: 'partial',
      entries: batch.entries.map((entry, index) => index === 0
        ? { ...entry, status: 'candidate', candidateAssetId: 'asset-secret' }
        : { ...entry, status: 'failed', error: 'credential=secret' }),
    })
    harness.emitBatchChange(batchId, taskIds[0]!)

    const summary = await waiting
    const expectedEntries = batch.entries.map((entry, index) => ({
      nodeId: entry.nodeId,
      taskId: entry.jobId,
      status: index === 0 ? 'candidate' as const : 'failed' as const,
    })).sort((left, right) => left.taskId.localeCompare(right.taskId) || left.nodeId.localeCompare(right.nodeId))
    expect(summary.entries).toEqual(expectedEntries)
    expect(summary).toMatchObject({ candidateCount: 1, failedCount: 1, runningCount: 0 })
    expect(JSON.stringify(summary)).not.toContain('asset-secret')
    expect(JSON.stringify(summary)).not.toContain('credential=secret')
  })

  test('Given adopted 与 kept 混合终态 When 汇总 Then aggregate 与逐节点规范状态一致', async () => {
    const nodes = [createImageNode('image-adopted'), createImageNode('image-kept')]
    const harness = createHarness()
    const started = await harness.service.run(context, target, nodes, 'tool-normalized-terminal')
    const batchId = started.batch?.batchId
    const taskIds = started.tasks.flatMap((task) => task.taskId ? [task.taskId] : [])
    if (!batchId || taskIds.length !== 2) throw new Error('测试批次未创建')
    const batch = harness.batches.get(batchId)
    if (!batch) throw new Error('测试候选批次未创建')
    harness.batches.set(batchId, {
      ...batch,
      status: 'adopted',
      entries: batch.entries.map((entry, index) => ({
        ...entry,
        status: index === 0 ? 'adopted' as const : 'kept' as const,
      })),
    })

    const summary = await harness.service.awaitBatch({
      ...target,
      batchId,
      taskIds,
      signal: new AbortController().signal,
      deadlineAt: Date.now() + 5_000,
    })

    expect(summary).toMatchObject({ candidateCount: 1, failedCount: 1, runningCount: 0 })
    expect(summary.entries.map((entry) => entry.status).sort()).toEqual(['candidate', 'invalid'])
  })

  test('Given Job 终态事件早于候选登记 When 跨多个 macrotask 后批次发出 ack Then 等待完成且不超时', async () => {
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
      deadlineAt: Date.now() + 1_000,
    })
    await Promise.resolve()
    harness.emit({ ...job, status: 'failed', error: 'IMAGE_FAILED' })
    await new Promise<void>((resolve) => {
      setTimeout(() => {
        setTimeout(() => {
          harness.batches.set(batchId, {
            ...batch,
            status: 'partial',
            entries: batch.entries.map((entry) => ({ ...entry, status: 'failed', error: 'IMAGE_FAILED' })),
          })
          harness.emitBatchChange(batchId, taskId)
          resolve()
        }, 0)
      }, 0)
    })

    await expect(waiting).resolves.toMatchObject({
      batchId,
      status: 'partial',
      runningCount: 0,
      failedCount: 1,
    })
  })

  test('Given 等待被中止且取消清理失败 When 清理 Then 保留中止主错误并移除两类监听', async () => {
    const node = createImageNode('image-a')
    const harness = createHarness({
      cancel: async () => { throw new Error('CANCEL_SECRET') },
    })
    const started = await harness.service.run(context, target, [node], 'tool-abort')
    const taskId = started.tasks[0]?.taskId
    const batchId = started.batch?.batchId
    if (!taskId || !batchId) throw new Error('测试批次未创建')
    const foreignInput: CreateDesignJobInput = {
      projectId: target.projectId,
      target: { kind: 'canvas-image', canvasId: 'canvas-foreign', nodeId: 'foreign', imageModuleId: 'module-foreign' },
      action: 'generate', prompt: 'foreign', contextMode: 'none', imageModelProfileId: 'profile-1',
      generationConstraints: { aspectRatio: '1:1', imageSize: '1K' },
      canvasImageConfigRevision: 1, candidateBatchId: 'foreign-batch',
    }
    harness.jobs.set('foreign-job', createJob(foreignInput, 'foreign-job', 'running'))
    const abortController = new AbortController()
    const waiting = harness.service.awaitBatch({
      ...target,
      batchId,
      taskIds: [taskId],
      signal: abortController.signal,
      deadlineAt: Date.now() + 5_000,
    })
    await Promise.resolve()
    /** 隔离预期清理日志，并验证不会记录底层取消异常正文。 */
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {
      throw new Error('LOGGER_FAILED')
    })
    abortController.abort()

    try {
      await expect(waiting).rejects.toThrow('CANVAS_IMAGE_BATCH_WAIT_ABORTED')
      expect(harness.calls.filter((call) => call.startsWith('cancel:'))).toEqual([`cancel:${taskId}`])
      expect(harness.jobs.get(taskId)?.status).toBe('queued')
      expect(harness.jobs.get('foreign-job')?.status).toBe('running')
      expect(harness.listeners.size).toBe(0)
      expect(harness.batchListeners.size).toBe(0)
      expect(errorSpy).toHaveBeenCalledWith('[CanvasImageDiagnostics] CANVAS_IMAGE_BATCH_CANCEL_CLEANUP_FAILED')
    } finally {
      errorSpy.mockRestore()
    }
  })

  test('Given 直接取消请求跨越 Canvas、批次或批次任务集合 When 校验所有权 Then 全部拒绝且零取消', async () => {
    const node = createImageNode('image-a')
    const harness = createHarness()
    const started = await harness.service.run(context, target, [node], 'tool-cancel-ownership')
    const taskId = started.tasks[0]?.taskId
    const batchId = started.batch?.batchId
    if (!taskId || !batchId) throw new Error('测试批次未创建')
    const ownedBatch = harness.batches.get(batchId)
    if (!ownedBatch) throw new Error('测试候选批次未创建')
    /** 真实存在的另一批次复用 taskId，必须由 Job candidateBatchId 复核拒绝。 */
    harness.batches.set('batch-foreign', { ...structuredClone(ownedBatch), batchId: 'batch-foreign' })
    await expect(harness.service.cancelTasks({
      ...target, canvasId: 'canvas-foreign', batchId, taskIds: [taskId],
    }))
      .rejects.toThrow('CANVAS_IMAGE_BATCH_WAIT_OWNERSHIP_INVALID')
    await expect(harness.service.cancelTasks({ ...target, batchId: 'batch-foreign', taskIds: [taskId] }))
      .rejects.toThrow('CANVAS_IMAGE_BATCH_WAIT_OWNERSHIP_INVALID')
    await expect(harness.service.cancelTasks({
      ...target, batchId, taskIds: [taskId, 'task-outside-batch'],
    }))
      .rejects.toThrow('CANVAS_IMAGE_BATCH_WAIT_OWNERSHIP_INVALID')
    expect(harness.calls.filter((call) => call.startsWith('cancel:'))).toEqual([])
  })

  test('Given 合法批次包含活跃与终态任务 When 直接取消 Then 只取消 owned active IDs', async () => {
    const first = createImageNode('image-a')
    const second = createImageNode('image-b')
    const harness = createHarness()
    const started = await harness.service.run(context, target, [first, second], 'tool-cancel-active')
    const taskIds = started.tasks.flatMap((task) => task.taskId ? [task.taskId] : [])
    const batchId = started.batch?.batchId
    if (taskIds.length !== 2 || !batchId) throw new Error('测试批次未创建')
    const completed = harness.jobs.get(taskIds[1]!)
    if (!completed) throw new Error('测试任务未创建')
    harness.jobs.set(completed.id, { ...completed, status: 'succeeded', outputAssetId: 'asset-completed' })
    await harness.service.cancelTasks({ ...target, batchId, taskIds })

    expect(harness.calls.filter((call) => call.startsWith('cancel:'))).toEqual([`cancel:${taskIds[0]}`])
    expect(harness.jobs.get(taskIds[1]!)?.status).toBe('succeeded')
  })

  test('Given 批次有两个活跃任务且首个取消失败 When 直接取消 Then 仍尝试后续任务并返回稳定汇总失败', async () => {
    /** 取消调用序号用于稳定制造首项失败。 */
    let cancelAttempt = 0
    const harness = createHarness({
      cancel: async () => {
        cancelAttempt += 1
        if (cancelAttempt === 1) throw new Error('CANCEL_SECRET')
      },
    })
    const started = await harness.service.run(
      context,
      target,
      [createImageNode('image-a'), createImageNode('image-b')],
      'tool-cancel-all-settled',
    )
    const taskIds = started.tasks.flatMap((task) => task.taskId ? [task.taskId] : [])
    const batchId = started.batch?.batchId
    if (taskIds.length !== 2 || !batchId) throw new Error('测试批次未创建')

    await expect(harness.service.cancelTasks({ ...target, batchId, taskIds }))
      .rejects.toThrow('CANVAS_IMAGE_TASK_CANCEL_FAILED')

    expect(harness.calls.filter((call) => call.startsWith('cancel:'))).toEqual([
      `cancel:${taskIds[0]}`,
      `cancel:${taskIds[1]}`,
    ])
    expect(harness.jobs.get(taskIds[0]!)?.status).toBe('queued')
    expect(harness.jobs.get(taskIds[1]!)?.status).toBe('cancelled')
  })

  test('Given 等待期限已过且取消清理失败 When 进入服务 Then 保留期限主错误并移除两类监听', async () => {
    const node = createImageNode('image-a')
    const harness = createHarness({
      cancel: async () => { throw new Error('CANCEL_SECRET') },
    })
    const started = await harness.service.run(context, target, [node], 'tool-deadline')
    const taskId = started.tasks[0]?.taskId
    const batchId = started.batch?.batchId
    if (!taskId || !batchId) throw new Error('测试批次未创建')
    /** 隔离预期清理日志，并验证 deadline 路径使用同一稳定诊断。 */
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {
      throw new Error('LOGGER_FAILED')
    })

    try {
      await expect(harness.service.awaitBatch({
        ...target,
        batchId,
        taskIds: [taskId],
        signal: new AbortController().signal,
        deadlineAt: Date.now() - 1,
      })).rejects.toThrow('CANVAS_IMAGE_BATCH_WAIT_DEADLINE')

      expect(harness.calls.filter((call) => call.startsWith('cancel:'))).toEqual([`cancel:${taskId}`])
      expect(harness.jobs.get(taskId)?.status).toBe('queued')
      expect(harness.listeners.size).toBe(0)
      expect(harness.batchListeners.size).toBe(0)
      expect(errorSpy).toHaveBeenCalledWith('[CanvasImageDiagnostics] CANVAS_IMAGE_BATCH_CANCEL_CLEANUP_FAILED')
    } finally {
      errorSpy.mockRestore()
    }
  })
})
