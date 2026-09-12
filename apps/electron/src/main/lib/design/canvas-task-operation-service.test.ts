import { describe, expect, test } from 'bun:test'
import type { CanvasWorkflowRun, DesignJobRecord, DesignTraceEntry } from '@proma/shared'
import { createImageJobId } from './canvas-image-run-service'
import {
  createCanvasTaskOperationService,
  type CanvasTaskReference,
} from './canvas-task-operation-service'
import type { RetryCanvasImageCandidateJobInput } from './canvas-image-candidate-batch-service'

const reference: CanvasTaskReference = {
  projectId: 'project-1',
  canvasId: 'canvas-1',
  nodeId: 'node-1',
  imageModuleId: 'image-module-1',
  jobId: 'job-1',
}

/** 构造精确归属同一图片模块的公开 Job。 */
function createJob(overrides: Partial<DesignJobRecord> = {}): DesignJobRecord {
  return {
    id: 'job-1', creativeTaskId: 'task-1', attemptNumber: 1, projectId: 'project-1',
    target: { kind: 'canvas-image', canvasId: 'canvas-1', nodeId: 'node-1', imageModuleId: 'image-module-1' },
    action: 'generate', status: 'failed', prompt: '原始请求', originalRequest: '原始请求', contextMode: 'auto',
    candidateBatchId: 'batch-1', finalImagePrompt: '最终提示词', designSummary: '执行摘要',
    imageModelSnapshot: { profileId: 'profile-1', name: 'GPT Image 2', modelId: 'gpt-image-2', executor: 'openai-images', channelId: 'channel-1' },
    createdAt: 1, updatedAt: 2, completedAt: 2, error: '供应商失败', traceState: 'ready',
    ...overrides,
  }
}

/** 构造最小持久工作流记录，明确每个图片执行身份都由原 owner 固定。 */
function createWorkflowRun(overrides: Partial<CanvasWorkflowRun> = {}): CanvasWorkflowRun {
  return {
    schemaVersion: 1,
    id: 'a'.repeat(48),
    revision: 1,
    projectId: 'project-1',
    canvasId: 'canvas-1',
    operationId: 'workflow-operation',
    owner: { sessionId: 'workflow-session', runStartedAt: 10 },
    status: 'completed',
    initialCanvasRevision: 1,
    observedCanvasRevision: 1,
    rootNodeIds: ['node-1'],
    goal: '工作流图片生成',
    nodes: [{
      nodeId: 'node-1', kind: 'image', identityHash: 'b'.repeat(64), plannedArtifactHash: null,
      mediaConfigRevision: null, inputBindings: [], dependencyNodeIds: [], status: 'failed',
      errorCode: 'CANVAS_IMAGE_RUN_FAILED',
      execution: { kind: 'image', operationId: 'workflow-image-operation', batchId: 'batch-workflow', taskId: 'job-1' },
      executionHistory: [], retryDisposition: 'terminal-failed', completedArtifactHash: null, completedAt: null,
    }],
    budget: {
      maxMediaRuns: 1, consumedMediaRuns: 1, remainingMediaRuns: 0,
      maxDurationMs: 1000, remainingDurationMs: 0, activeStartedAt: null,
    },
    autoResumeAfterAdoption: false,
    cancelRequestedAt: null,
    cancelledAt: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

/** 创建可观察任务读写次数的服务夹具。 */
function createFixture(
  initialJobs: DesignJobRecord[] = [createJob()],
  options: {
    failCandidateBatchSaveOnce?: boolean
    traceEntries?: DesignTraceEntry[]
    workflowRuns?: CanvasWorkflowRun[]
  } = {},
) {
  const jobs = [...initialJobs]
  let traceReadCount = 0
  let retryCount = 0
  let legacyRunCount = 0
  let cancelCount = 0
  /** 模拟候选批次当前指向的 Job ID。 */
  const candidateEntryJobIds = new Set(initialJobs.filter((job) => job.candidateBatchId).map((job) => job.id))
  /** 捕获候选重试的完整固化身份。 */
  const retryInputs: RetryCanvasImageCandidateJobInput[] = []
  let failCandidateBatchSaveOnce = options.failCandidateBatchSaveOnce === true
  const traceEntries = options.traceEntries
    ?? [{ timestamp: 1, type: 'error' as const, title: '执行失败', content: '公开错误' }]
  const service = createCanvasTaskOperationService({
    jobs: {
      getProjectJob: (projectId, jobId) => jobs.find((job) => job.projectId === projectId && job.id === jobId),
      listCanvasImageJobs: (target) => jobs.filter((job) => {
        const jobTarget = job.target
        return job.projectId === target.projectId && jobTarget?.kind === 'canvas-image'
          && jobTarget.canvasId === target.canvasId && jobTarget.nodeId === target.nodeId
          && jobTarget.imageModuleId === target.imageModuleId
      }),
      cancel: async (projectId, jobId) => {
        cancelCount += 1
        const job = jobs.find((candidate) => candidate.projectId === projectId && candidate.id === jobId)
        if (!job) throw new Error('任务不存在')
        return job
      },
      retry: (_projectId, jobId) => {
        const original = jobs.find((job) => job.id === jobId)
        if (!original) throw new Error('任务不存在')
        const existing = jobs.find((job) => job.creativeTaskId === original.creativeTaskId
          && job.attemptNumber === original.attemptNumber + 1)
        if (existing) return existing
        retryCount += 1
        const replacement = createJob({
          id: `job-${original.attemptNumber + 1}`, attemptNumber: original.attemptNumber + 1,
          status: 'queued', completedAt: undefined, error: undefined,
          createdAt: original.createdAt + 1, updatedAt: original.updatedAt + 1,
        })
        jobs.push(replacement)
        return replacement
      },
      run: async () => { legacyRunCount += 1 },
    },
    candidateBatches: {
      retryJobLocked: async (input) => {
        retryInputs.push(structuredClone(input))
        if (!candidateEntryJobIds.has(input.jobId)) {
          throw new Error('CANVAS_IMAGE_BATCH_JOB_NOT_FOUND')
        }
        const original = jobs.find((job) => job.id === input.jobId)
        if (!original) throw new Error('任务不存在')
        const existing = jobs.find((job) => job.creativeTaskId === original.creativeTaskId
          && job.attemptNumber === original.attemptNumber + 1)
        const replacement = existing ?? createJob({
          id: `job-${original.attemptNumber + 1}`, attemptNumber: original.attemptNumber + 1,
          status: 'queued', completedAt: undefined, error: undefined,
          createdAt: original.createdAt + 1, updatedAt: original.updatedAt + 1,
        })
        if (!existing) {
          retryCount += 1
          jobs.push(replacement)
        }
        if (failCandidateBatchSaveOnce) {
          failCandidateBatchSaveOnce = false
          throw new Error('TEST_BATCH_SAVE_FAILED')
        }
        candidateEntryJobIds.delete(input.jobId)
        candidateEntryJobIds.add(replacement.id)
        return replacement.id
      },
    },
    traceStore: {
      readPage: (_projectId, _jobId, options) => {
        traceReadCount += 1
        const offset = options.cursor === undefined ? 0 : Number(options.cursor)
        /** 测试替身复刻 Store 的最终条目预算和逐条 cursor 语义。 */
        const entries: DesignTraceEntry[] = []
        let bytes = 2
        let index = offset
        for (; index < traceEntries.length && entries.length < options.limit; index += 1) {
          const rawEntry = traceEntries[index]!
          const entry = options.transformEntry?.(rawEntry) ?? rawEntry
          const entryBytes = Buffer.byteLength(JSON.stringify(entry), 'utf8') + 1
          if (entries.length > 0 && bytes + entryBytes > options.maxBytes) break
          entries.push(entry)
          bytes += entryBytes
        }
        return {
          entries,
          ...(index < traceEntries.length ? { nextCursor: String(index) } : {}),
          truncated: index < traceEntries.length,
          omittedEntryCount: 0,
        }
      },
    },
    ...(options.workflowRuns ? {
      workflowRuns: { list: () => structuredClone(options.workflowRuns!) },
    } : {}),
  })
  return {
    service,
    jobs,
    retryInputs,
    get traceReadCount() { return traceReadCount },
    get retryCount() { return retryCount },
    get legacyRunCount() { return legacyRunCount },
    get cancelCount() { return cancelCount },
  }
}

describe('CanvasTaskOperationService', () => {
  test('Given 精确任务引用 When 默认读取详情 Then 返回脱敏模型与尝试且不读取 trace', async () => {
    const fixture = createFixture()

    const details = await fixture.service.getTaskLocked(reference)

    expect(details).toMatchObject({
      jobId: 'job-1', status: 'failed', attemptNumber: 1,
      traceState: 'ready',
      model: { name: 'GPT Image 2', modelId: 'gpt-image-2', executor: 'openai-images' },
      finalImagePrompt: '最终提示词', designSummary: '执行摘要', error: '供应商失败',
      attempts: [{ jobId: 'job-1', attemptNumber: 1, status: 'failed' }],
    })
    expect(details.model).not.toHaveProperty('channelId')
    expect(details.logs).toBeUndefined()
    expect(fixture.traceReadCount).toBe(0)
  })

  test('Given ComfyUI 图片任务 When 读取详情 Then 仅公开模型名称、标识和执行器', async () => {
    const fixture = createFixture([createJob({
      imageModelSnapshot: {
        profileId: 'media:preset-1:1', name: 'Comfy 海报', modelId: 'workflow-1@1', executor: 'comfyui',
        mediaProfileId: 'preset-1', mediaProfileRevision: 1, connectionId: 'connection-1',
        workflowId: 'workflow-1', workflowRevision: 1, workflowHash: 'a'.repeat(64),
      },
    })])

    const details = await fixture.service.getTaskLocked(reference)

    expect(details.model).toEqual({ name: 'Comfy 海报', modelId: 'workflow-1@1', executor: 'comfyui' })
    expect(details.model).not.toHaveProperty('connectionId')
    expect(details.model).not.toHaveProperty('workflowId')
    expect(details.model).not.toHaveProperty('mediaProfileId')
  })

  test('Given 请求日志和超过 50 次尝试 When 读取详情 Then 日志按需读取且响应保持在 64KiB', async () => {
    const attempts = Array.from({ length: 70 }, (_, index) => createJob({
      id: `job-${index + 1}`, attemptNumber: index + 1, createdAt: index + 1,
      finalImagePrompt: 'p'.repeat(4_000), designSummary: 's'.repeat(4_000),
      error: `第 ${index + 1} 次失败：${'错误'.repeat(10_000)}`,
    }))
    const fixture = createFixture(attempts)

    const details = await fixture.service.getTaskLocked({ ...reference, logs: { limit: 99 } })

    expect(details.attempts).toHaveLength(50)
    expect(details.attemptsTruncated).toBe(true)
    expect(details.attemptsNextCursor).toBe('50')
    expect(details.logs?.entries).toHaveLength(1)
    expect(fixture.traceReadCount).toBe(1)
    expect(Buffer.byteLength(JSON.stringify(details), 'utf8')).toBeLessThanOrEqual(64 * 1024)
  })

  test('Given 大详情字段与多页大日志 When 沿 nextCursor 读取 Then 所有日志无遗漏且每页不超预算', async () => {
    const attempts = Array.from({ length: 50 }, (_, index) => createJob({
      id: `job-${index + 1}`, attemptNumber: index + 1, createdAt: index + 1,
      finalImagePrompt: 'p'.repeat(8_000), designSummary: 's'.repeat(8_000),
      error: `失败 ${index + 1}：${'错'.repeat(4_000)}`,
    }))
    const traceEntries = Array.from({ length: 24 }, (_, index): DesignTraceEntry => ({
      timestamp: index,
      type: 'status',
      title: `日志 ${index}`,
      content: `公开内容 ${index} ${'x'.repeat(4_000)}`,
    }))
    const fixture = createFixture(attempts, { traceEntries })
    const titles: string[] = []
    let cursor: string | undefined

    do {
      const details = await fixture.service.getTaskLocked({
        ...reference,
        attemptLimit: 50,
        logs: { cursor, limit: 50 },
      })
      titles.push(...(details.logs?.entries.map((entry) => entry.title) ?? []))
      cursor = details.logs?.nextCursor
      expect(Buffer.byteLength(JSON.stringify(details), 'utf8')).toBeLessThanOrEqual(64 * 1024)
    } while (cursor !== undefined)

    expect(titles).toEqual(traceEntries.map((entry) => entry.title))
  })

  test('Given attemptLimit 在领域边界 When 读取尝试页 Then 仅接受 1 到 50 的整数', async () => {
    const attempts = Array.from({ length: 12 }, (_, index) => createJob({
      id: `job-${index + 1}`, attemptNumber: index + 1, createdAt: index + 1,
    }))
    const fixture = createFixture(attempts)

    const details = await fixture.service.getTaskLocked({ ...reference, attemptLimit: 7 })

    expect(details.attempts).toHaveLength(7)
    expect(details.attemptsNextCursor).toBe('7')
    await expect(fixture.service.getTaskLocked({ ...reference, attemptLimit: 0 }))
      .rejects.toThrow('CANVAS_TASK_ATTEMPT_LIMIT_INVALID')
    await expect(fixture.service.getTaskLocked({ ...reference, attemptLimit: 51 }))
      .rejects.toThrow('CANVAS_TASK_ATTEMPT_LIMIT_INVALID')
    await expect(fixture.service.getTaskLocked({ ...reference, attemptLimit: 1.5 }))
      .rejects.toThrow('CANVAS_TASK_ATTEMPT_LIMIT_INVALID')
  })

  test('Given trace Store 返回额外内部字段 When 读取详情 Then 仅公开白名单并脱敏文本', async () => {
    const traceEntry = {
      timestamp: 1,
      type: 'error',
      title: '读取 /Users/private/provider.log 失败',
      content: 'apiKey=secret-value',
      toolName: 'tool-/private/tmp/internal',
      absolutePath: '/Users/private/output.png',
      credentials: { token: 'secret-token' },
    } as DesignTraceEntry
    const fixture = createFixture([createJob()], { traceEntries: [traceEntry] })

    const details = await fixture.service.getTaskLocked({ ...reference, logs: { limit: 10 } })
    const serialized = JSON.stringify(details.logs)

    expect(details.logs?.entries[0]).toEqual({
      timestamp: 1,
      type: 'error',
      title: '读取 [路径已隐藏] 失败',
      content: 'apiKey=[已隐藏]',
      toolName: 'tool-[路径已隐藏]',
    })
    expect(serialized).not.toContain('absolutePath')
    expect(serialized).not.toContain('credentials')
    expect(serialized).not.toContain('secret-token')
  })

  test('Given 旧 journal 的公开文本异常大且含本机路径 When 读取详情 Then 脱敏并显式截断', async () => {
    const fixture = createFixture([createJob({
      finalImagePrompt: `/Users/private/reference.png ${'提示'.repeat(100_000)}`,
      error: 'apiKey=secret-value /private/tmp/provider.log',
    })])

    const details = await fixture.service.getTaskLocked(reference)

    expect(details.finalImagePrompt).not.toContain('/Users/private')
    expect(details.finalImagePrompt).toEndWith('[已截断]')
    expect(details.error).not.toContain('secret-value')
    expect(details.error).not.toContain('/private/tmp')
    expect(Buffer.byteLength(JSON.stringify(details), 'utf8')).toBeLessThanOrEqual(64 * 1024)
  })

  test('Given jobId 属于另一节点 When 查询取消或重试 Then 精确身份校验拒绝越权', async () => {
    const fixture = createFixture()
    const forged = { ...reference, nodeId: 'node-other' }

    await expect(fixture.service.getTaskLocked(forged)).rejects.toThrow('CANVAS_TASK_IDENTITY_MISMATCH')
    await expect(fixture.service.cancelTaskLocked(forged)).rejects.toThrow('CANVAS_TASK_IDENTITY_MISMATCH')
    await expect(fixture.service.retryTaskLocked({ ...forged, operationId: 'operation-1' }))
      .rejects.toThrow('CANVAS_TASK_IDENTITY_MISMATCH')
    expect(fixture.cancelCount).toBe(0)
    expect(fixture.retryCount).toBe(0)
  })

  test('Given 已终态任务 When 重复取消 Then 返回真实终态且不声称供应商已确认取消', async () => {
    const fixture = createFixture()

    const first = await fixture.service.cancelTaskLocked(reference)
    const second = await fixture.service.cancelTaskLocked(reference)

    expect(first).toEqual({ jobId: 'job-1', status: 'failed', stopRequested: false, remoteCancellation: 'unconfirmed' })
    expect(second).toEqual(first)
    expect(fixture.cancelCount).toBe(2)
  })

  test('Given 重试响应丢失 When 相同 operation 重放 Then 返回同 replacement 且不重复付费', async () => {
    const fixture = createFixture()

    const first = await fixture.service.retryTaskLocked({ ...reference, operationId: 'operation-1' })
    const replay = await fixture.service.retryTaskLocked({ ...reference, operationId: 'operation-1' })

    expect(first).toEqual({ operationId: 'operation-1', originalJobId: 'job-1', replacementJobId: 'job-2', created: true })
    expect(replay).toEqual({ operationId: 'operation-1', originalJobId: 'job-1', replacementJobId: 'job-2', created: false })
    expect(fixture.retryCount).toBe(1)
    expect(fixture.jobs[1]?.imageModelSnapshot).toEqual(fixture.jobs[0]?.imageModelSnapshot)
    expect(fixture.jobs[1]?.finalImagePrompt).toBe(fixture.jobs[0]?.finalImagePrompt)
  })

  test('Given replacement journal 已创建但批次保存失败 When 重放 Then 补完原批次且不重复创建付费任务', async () => {
    const fixture = createFixture([createJob()], { failCandidateBatchSaveOnce: true })

    await expect(fixture.service.retryTaskLocked({ ...reference, operationId: 'operation-1' }))
      .rejects.toThrow('TEST_BATCH_SAVE_FAILED')
    const replay = await fixture.service.retryTaskLocked({ ...reference, operationId: 'operation-1' })

    expect(replay.replacementJobId).toBe('job-2')
    expect(fixture.retryCount).toBe(1)
    expect(fixture.retryInputs).toHaveLength(2)
  })

  test('Given 已存在 replacement 的模型、正式引用或提示词合同漂移 When 重放旧任务 Then 拒绝复用异常快照', async () => {
    const original = createJob({
      canvasInputReferences: [{
        nodeId: 'source-1', kind: 'image', revision: 3,
        summary: '正式图片', summaryHash: 'a'.repeat(64), assetId: 'asset-1',
        sourcePort: 'image.asset', targetPort: 'image.reference',
      }],
    })
    const changedModel = createFixture([original, createJob({
      id: 'job-2', attemptNumber: 2, createdAt: 2,
      imageModelSnapshot: { ...original.imageModelSnapshot!, modelId: 'other-model' },
    })])
    const changedReference = createFixture([original, createJob({
      id: 'job-2', attemptNumber: 2, createdAt: 2,
      canvasInputReferences: [{
        ...original.canvasInputReferences![0]!,
        assetId: 'asset-other',
      }],
    })])
    const frozenPromptOriginal = createJob({ imagePromptContract: 'frozen-config-v1' })
    const changedPromptContract = createFixture([frozenPromptOriginal, createJob({
      id: 'job-2', attemptNumber: 2, createdAt: 2,
    })])

    await expect(changedModel.service.retryTaskLocked({ ...reference, operationId: 'operation-model' }))
      .rejects.toThrow('CANVAS_TASK_RETRY_SNAPSHOT_MISMATCH')
    await expect(changedReference.service.retryTaskLocked({ ...reference, operationId: 'operation-reference' }))
      .rejects.toThrow('CANVAS_TASK_RETRY_SNAPSHOT_MISMATCH')
    await expect(changedPromptContract.service.retryTaskLocked({ ...reference, operationId: 'operation-prompt-contract' }))
      .rejects.toThrow('CANVAS_TASK_RETRY_SNAPSHOT_MISMATCH')
    expect(changedModel.retryCount).toBe(0)
    expect(changedReference.retryCount).toBe(0)
    expect(changedPromptContract.retryCount).toBe(0)
  })

  test('Given replacement 之后再次失败 When 用户引用新 attempt 重试 Then 创建下一 attempt', async () => {
    const fixture = createFixture()
    await fixture.service.retryTaskLocked({ ...reference, operationId: 'operation-1' })
    fixture.jobs[1] = { ...fixture.jobs[1]!, status: 'failed', error: '再次失败' }

    const second = await fixture.service.retryTaskLocked({
      ...reference, jobId: 'job-2', operationId: 'operation-2',
    })

    expect(second).toEqual({ operationId: 'operation-2', originalJobId: 'job-2', replacementJobId: 'job-3', created: true })
    expect(fixture.retryCount).toBe(2)
  })

  test('Given UUID 单图旧批次文件缺失 When 重试 Then 从原任务固化事实传入恢复基线', async () => {
    const batchId = '11111111-1111-4111-8111-111111111111'
    const fixture = createFixture([createJob({
      candidateBatchId: batchId,
      canvasImageConfigRevision: 7,
      sourceAssetId: 'asset-before',
    })])

    await fixture.service.retryTaskLocked({ ...reference, operationId: 'operation-1' })

    expect(fixture.retryInputs[0]).toMatchObject({
      batchId,
      singleBatchRecovery: {
        nodeId: 'node-1', imageModuleId: 'image-module-1',
        initialAdoptedAssetId: 'asset-before', initialConfigRevision: 7,
      },
    })
  })

  test('Given 母版与目标旧采用不同 When 重试恢复批次 Then 使用目标采用基线', async () => {
    const fixture = createFixture([createJob({ candidateBatchId: '11111111-1111-4111-8111-111111111111',
      canvasImageConfigRevision: 7, sourceAssetId: 'asset-master', canvasImageInitialAdoptedAssetId: null })])
    await fixture.service.retryTaskLocked({ ...reference, operationId: 'operation-1' })
    expect(fixture.retryInputs[0]).toMatchObject({ singleBatchRecovery: { initialAdoptedAssetId: null } })
  })

  test('Given 旧任务缺少候选批次 When 重试 Then 复用 Manager 原快照重试并后台启动', async () => {
    const legacy = createFixture([createJob({ candidateBatchId: undefined })])

    const result = await legacy.service.retryTaskLocked({ ...reference, operationId: 'operation-legacy' })

    expect(result.replacementJobId).toBe('job-2')
    expect(legacy.retryCount).toBe(1)
    await Promise.resolve()
    expect(legacy.legacyRunCount).toBe(1)
  })

  test('Given 任一状态的工作流已记录当前图片任务 When 独立重试 Then 拒绝绕过原工作流预算', async () => {
    const statuses: CanvasWorkflowRun['status'][] = [
      'running', 'waiting-review', 'waiting-budget', 'completed', 'partial', 'failed', 'cancelled',
    ]

    for (const status of statuses) {
      const fixture = createFixture([createJob()], {
        workflowRuns: [createWorkflowRun({ status })],
      })

      await expect(fixture.service.retryTaskLocked({ ...reference, operationId: `independent-${status}` }))
        .rejects.toThrow('CANVAS_WORKFLOW_TASK_RETRY_REQUIRES_RESUME')
      expect(fixture.retryCount).toBe(0)
    }
  })

  test('Given 工作流历史 attempt 或未知提交可证明图片归属 When 独立重试 Then 拒绝同一创作链', async () => {
    const original = createJob({ id: 'job-workflow-original', attemptNumber: 1 })
    const retry = createJob({ id: 'job-1', attemptNumber: 2 })
    const historyRun = createWorkflowRun({ nodes: [{
      ...createWorkflowRun().nodes[0]!,
      execution: { kind: 'image', operationId: 'workflow-current', batchId: 'batch-current', taskId: 'job-current' },
      executionHistory: [{
        kind: 'image', operationId: 'workflow-original', batchId: 'batch-original', taskId: original.id,
      }],
    }] })
    const historyFixture = createFixture([original, retry], { workflowRuns: [historyRun] })
    await expect(historyFixture.service.retryTaskLocked({ ...reference, operationId: 'independent-history' }))
      .rejects.toThrow('CANVAS_WORKFLOW_TASK_RETRY_REQUIRES_RESUME')
    expect(historyFixture.retryCount).toBe(0)

    const owner = { sessionId: 'workflow-unknown-session', runStartedAt: 23 }
    const unknownJobId = createImageJobId(owner, 'workflow-unknown-operation', 'canvas-1', 'node-1')
    const unknownRun = createWorkflowRun({
      owner,
      nodes: [{
        ...createWorkflowRun().nodes[0]!,
        execution: { kind: 'image', operationId: 'workflow-unknown-operation', batchId: null, taskId: null },
      }],
    })
    const unknownFixture = createFixture([createJob({ id: unknownJobId })], { workflowRuns: [unknownRun] })
    await expect(unknownFixture.service.retryTaskLocked({ ...reference, jobId: unknownJobId, operationId: 'independent-unknown' }))
      .rejects.toThrow('CANVAS_WORKFLOW_TASK_RETRY_REQUIRES_RESUME')
    expect(unknownFixture.retryCount).toBe(0)
  })

  test('Given 原任务缺少模型快照 When 重试 Then 在付费提交前明确失败', async () => {
    const noModel = createFixture([createJob({ imageModelSnapshot: undefined })])

    await expect(noModel.service.retryTaskLocked({ ...reference, operationId: 'operation-1' }))
      .rejects.toThrow('CANVAS_TASK_RETRY_SNAPSHOT_UNAVAILABLE')
    expect(noModel.retryCount).toBe(0)
  })
})
