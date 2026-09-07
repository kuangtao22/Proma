import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CanvasWorkflowRun, CanvasWorkflowRunNode } from '@proma/shared'
import {
  CANVAS_WORKFLOW_MAX_DURATION_MS,
  CANVAS_WORKFLOW_MAX_MEDIA_RUNS,
} from '@proma/shared'
import {
  createCanvasWorkflowRunId,
  createCanvasWorkflowRunStore,
  type CreateCanvasWorkflowRunInput,
} from './canvas-workflow-run-store'

const temporaryRoots: string[] = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** 创建测试使用的实际 Canvas transactions 目录。 */
function createFixture(): {
  root: string
  transactionsDir: string
  input: CreateCanvasWorkflowRunInput
  createStore: (
    now?: () => number,
    onChanged?: (run: CanvasWorkflowRun) => void,
  ) => ReturnType<typeof createCanvasWorkflowRunStore>
} {
  const root = mkdtempSync(join(tmpdir(), 'proma-workflow-runs-'))
  temporaryRoots.push(root)
  const transactionsDir = join(root, 'canvas', 'transactions')
  mkdirSync(transactionsDir, { recursive: true })
  const nodes: CanvasWorkflowRunNode[] = [
    {
      nodeId: 'agent-root',
      kind: 'agent',
      identityHash: 'a'.repeat(64),
      plannedArtifactHash: null,
      mediaConfigRevision: null,
      inputBindings: [],
      dependencyNodeIds: [],
      status: 'ready',
      errorCode: null,
      execution: null,
      completedArtifactHash: null,
      completedAt: null,
    },
    {
      nodeId: 'image-result',
      kind: 'image',
      identityHash: 'b'.repeat(64),
      plannedArtifactHash: null,
      mediaConfigRevision: null,
      inputBindings: [],
      dependencyNodeIds: ['agent-root'],
      status: 'ready',
      errorCode: null,
      execution: null,
      completedArtifactHash: null,
      completedAt: null,
    },
    {
      nodeId: 'video-result',
      kind: 'video',
      identityHash: 'd'.repeat(64),
      plannedArtifactHash: null,
      mediaConfigRevision: 3,
      inputBindings: [{
        targetInputKey: 'prompt', requiredKind: 'text', sourceNodeId: null,
        sourceOutputKey: null, sourceArtifactHash: null, resolvedValueHash: null,
      }],
      dependencyNodeIds: ['agent-root'],
      status: 'blocked',
      errorCode: 'CANVAS_WORKFLOW_DEPENDENCY_PENDING',
      execution: null,
      completedArtifactHash: null,
      completedAt: null,
    },
  ]
  const input: CreateCanvasWorkflowRunInput = {
    projectId: 'project-1',
    canvasId: 'canvas-1',
    operationId: 'tool-call-1',
    owner: { sessionId: 'session-1', runStartedAt: 10 },
    initialCanvasRevision: 3,
    rootNodeIds: ['agent-root'],
    goal: '生成一张主视觉',
    nodes,
    maxMediaRuns: 2,
    consumedMediaRuns: 0,
    autoResumeAfterAdoption: false,
  }
  return {
    root,
    transactionsDir,
    input,
    createStore: (now = () => 20, onChanged) => createCanvasWorkflowRunStore({
      pathResolver: {
        resolveCanvas: () => ({ transactionsDir }) as ReturnType<import('./design-paths').DesignPathResolver['resolveCanvas']>,
      },
      runWorkspaceWrite: (_projectId, effect) => effect(),
      onChanged,
      now,
    }),
  }
}

describe('Canvas Workflow Run Store', () => {
  test('Given 相同 operation 重放 When 已有运行继续推进 Then 返回同一持久运行且不覆盖进度', () => {
    const fixture = createFixture()
    const store = fixture.createStore()
    const created = store.create(fixture.input)
    const changed = structuredClone(created)
    changed.nodes[0]!.status = 'completed'
    changed.nodes[0]!.execution = { kind: 'agent', operationId: 'agent-operation-1' }
    changed.nodes[0]!.completedArtifactHash = 'c'.repeat(64)
    changed.nodes[0]!.completedAt = 21
    const saved = store.save(changed, created.revision)

    const replayed = store.create(fixture.input)

    expect(replayed.id).toBe(createCanvasWorkflowRunId('project-1', 'canvas-1', 'tool-call-1'))
    expect(replayed.revision).toBe(1)
    expect(replayed.nodes[0]?.status).toBe('completed')
    expect(store.findByOperation(fixture.input, fixture.input.operationId)?.id).toBe(created.id)
  })

  test('Given 相同 operation 绑定不同固定计划 When 创建 Then 拒绝覆盖原授权范围', () => {
    const fixture = createFixture()
    const store = fixture.createStore()
    store.create(fixture.input)

    expect(() => store.create({
      ...fixture.input,
      goal: '另一个目标',
    })).toThrow('CANVAS_WORKFLOW_OPERATION_CONFLICT')
  })

  test('Given 两个保存者读取相同 revision When 依次提交 Then 第二个收到 CAS 冲突', () => {
    const fixture = createFixture()
    const store = fixture.createStore()
    const first = store.create(fixture.input)
    const stale = structuredClone(first)
    first.nodes[0]!.status = 'completed'
    first.nodes[0]!.execution = { kind: 'agent', operationId: 'agent-operation-1' }
    first.nodes[0]!.completedArtifactHash = 'c'.repeat(64)
    first.nodes[0]!.completedAt = 21
    store.save(first, 0)

    expect(() => store.save(stale, 0)).toThrow('CANVAS_WORKFLOW_RUN_CONFLICT')
  })

  test('Given 到期工作流扩额并重试权威失败节点 When 相同恢复 operation 重放 Then 只扩额一次且保留旧执行身份', () => {
    const fixture = createFixture()
    const store = fixture.createStore()
    const created = store.create(fixture.input)
    created.status = 'waiting-budget'
    created.budget.remainingDurationMs = 0
    created.budget.activeStartedAt = null
    created.nodes[1]!.status = 'failed'
    created.nodes[1]!.errorCode = 'CANVAS_IMAGE_RUN_FAILED'
    created.nodes[1]!.execution = {
      kind: 'image', operationId: 'old-image-operation', batchId: 'batch-1', taskId: 'task-1',
    }
    created.nodes[1]!.retryDisposition = 'terminal-failed'
    const expired = store.save(created, created.revision)

    const input = {
      projectId: fixture.input.projectId,
      canvasId: fixture.input.canvasId,
      runId: expired.id,
      expectedRevision: expired.revision,
      operationId: 'resume-operation-1',
      addDurationMs: 60_000,
      addMediaRuns: 1,
      retryNodeIds: ['image-result'],
    }
    const amended = store.amendForResume(input)
    const replayed = store.amendForResume(input)

    expect(amended.status).toBe('running')
    expect(amended.budget).toMatchObject({
      maxDurationMs: 16 * 60_000,
      remainingDurationMs: 60_000,
      maxMediaRuns: 3,
      remainingMediaRuns: 3,
    })
    expect(amended.nodes[1]).toMatchObject({
      status: 'ready', errorCode: null, execution: null, retryDisposition: 'none',
      executionHistory: [{
        kind: 'image', operationId: 'old-image-operation', batchId: 'batch-1', taskId: 'task-1',
      }],
    })
    expect(replayed.revision).toBe(amended.revision)
    expect(replayed.budget).toEqual(amended.budget)
    expect(replayed.resumeAmendments).toHaveLength(1)
    expect(CANVAS_WORKFLOW_MAX_DURATION_MS).toBe(7 * 24 * 60 * 60_000)
    expect(CANVAS_WORKFLOW_MAX_MEDIA_RUNS).toBe(256)
  })

  test('Given 付费节点只有 operationId 而没有远端任务标识 When 请求重试 Then fail closed 且不改变 journal', () => {
    const fixture = createFixture()
    const store = fixture.createStore()
    const created = store.create(fixture.input)
    created.nodes[1]!.status = 'failed'
    created.nodes[1]!.errorCode = 'CANVAS_IMAGE_RUN_FAILED'
    created.nodes[1]!.execution = {
      kind: 'image', operationId: 'unknown-image-operation', batchId: null, taskId: null,
    }
    created.nodes[1]!.retryDisposition = 'submission-unknown'
    const failed = store.save(created, created.revision)

    expect(() => store.amendForResume({
      projectId: fixture.input.projectId,
      canvasId: fixture.input.canvasId,
      runId: failed.id,
      expectedRevision: failed.revision,
      operationId: 'resume-operation-unknown',
      addDurationMs: 0,
      addMediaRuns: 1,
      retryNodeIds: ['image-result'],
    })).toThrow('CANVAS_WORKFLOW_RETRY_SUBMISSION_UNKNOWN')
    expect(store.get(fixture.input, failed.id).revision).toBe(failed.revision)
  })

  test('Given 恢复 amendment 已提交 When 普通保存尝试删除重放记录或旧执行身份 Then 拒绝破坏幂等事实', () => {
    const fixture = createFixture()
    const store = fixture.createStore()
    const created = store.create(fixture.input)
    created.nodes[0]!.status = 'failed'
    created.nodes[0]!.errorCode = 'CANVAS_AGENT_RUN_FAILED'
    created.nodes[0]!.execution = { kind: 'agent', operationId: 'old-agent-operation' }
    const failed = store.save(created, created.revision)
    const amended = store.amendForResume({
      projectId: fixture.input.projectId, canvasId: fixture.input.canvasId, runId: failed.id,
      expectedRevision: failed.revision, operationId: 'resume-agent-operation',
      addDurationMs: 1, addMediaRuns: 0, retryNodeIds: ['agent-root'],
    })
    const erasedAmendment = structuredClone(amended)
    erasedAmendment.resumeAmendments = []
    expect(() => store.save(erasedAmendment, amended.revision))
      .toThrow('CANVAS_WORKFLOW_RUN_RESUME_HISTORY_IMMUTABLE')
    const erasedExecution = structuredClone(amended)
    erasedExecution.nodes[0]!.executionHistory = []
    expect(() => store.save(erasedExecution, amended.revision))
      .toThrow('CANVAS_WORKFLOW_RUN_EXECUTION_HISTORY_IMMUTABLE')
  })

  test('Given 已消耗预算与权威失败判定 When 普通保存回补额度或改写判定 Then 必须经专用恢复入口', () => {
    const fixture = createFixture()
    const store = fixture.createStore()
    const created = store.create(fixture.input)
    created.budget.consumedMediaRuns = 1
    created.budget.remainingMediaRuns = 1
    created.budget.remainingDurationMs -= 100
    created.nodes[1]!.status = 'failed'
    created.nodes[1]!.errorCode = 'CANVAS_IMAGE_RUN_FAILED'
    created.nodes[1]!.execution = {
      kind: 'image', operationId: 'image-operation', batchId: 'batch-1', taskId: 'task-1',
    }
    created.nodes[1]!.retryDisposition = 'terminal-failed'
    const current = store.save(created, created.revision)
    const replenishedMedia = structuredClone(current)
    replenishedMedia.budget.consumedMediaRuns = 0
    replenishedMedia.budget.remainingMediaRuns = 2
    expect(() => store.save(replenishedMedia, current.revision))
      .toThrow('CANVAS_WORKFLOW_RUN_BUDGET_IMMUTABLE')
    const replenishedDuration = structuredClone(current)
    replenishedDuration.budget.remainingDurationMs += 1
    expect(() => store.save(replenishedDuration, current.revision))
      .toThrow('CANVAS_WORKFLOW_RUN_BUDGET_IMMUTABLE')
    const rewrittenRetry = structuredClone(current)
    rewrittenRetry.nodes[1]!.retryDisposition = 'submission-unknown'
    expect(() => store.save(rewrittenRetry, current.revision))
      .toThrow('CANVAS_WORKFLOW_RUN_RETRY_FACT_IMMUTABLE')
    const shiftedClock = structuredClone(current)
    shiftedClock.budget.activeStartedAt = 9_999_999
    expect(() => store.save(shiftedClock, current.revision))
      .toThrow('CANVAS_WORKFLOW_RUN_BUDGET_CLOCK_INVALID')
  })

  test('Given 未知图片提交用原 operation 补齐回执 When 调度器保存 Then 只允许权威收敛且拒绝替换执行身份', () => {
    const fixture = createFixture()
    const store = fixture.createStore()
    const created = store.create(fixture.input)
    created.nodes[1]!.status = 'failed'
    created.nodes[1]!.errorCode = 'CANVAS_IMAGE_SUBMISSION_RESPONSE_LOST'
    created.nodes[1]!.execution = {
      kind: 'image', operationId: 'image-operation', batchId: null, taskId: null,
    }
    created.nodes[1]!.retryDisposition = 'submission-unknown'
    const current = store.save(created, created.revision)
    const recovered = structuredClone(current)
    recovered.nodes[1]!.status = 'waiting-adoption'
    recovered.nodes[1]!.errorCode = null
    recovered.nodes[1]!.execution = {
      kind: 'image', operationId: 'image-operation', batchId: 'batch-1', taskId: 'task-1',
    }
    recovered.nodes[1]!.retryDisposition = 'none'

    const saved = store.saveExecutionProgress(recovered, current.revision)
    expect(saved.nodes[1]).toMatchObject({
      status: 'waiting-adoption', retryDisposition: 'none',
      execution: { operationId: 'image-operation', batchId: 'batch-1', taskId: 'task-1' },
      executionHistory: [],
    })

    const secondFixture = createFixture()
    const secondStore = secondFixture.createStore()
    const secondCreated = secondStore.create(secondFixture.input)
    secondCreated.nodes[1]!.status = 'failed'
    secondCreated.nodes[1]!.errorCode = 'CANVAS_IMAGE_SUBMISSION_RESPONSE_LOST'
    secondCreated.nodes[1]!.execution = {
      kind: 'image', operationId: 'image-operation', batchId: null, taskId: null,
    }
    secondCreated.nodes[1]!.retryDisposition = 'submission-unknown'
    const secondCurrent = secondStore.save(secondCreated, secondCreated.revision)
    const forged = structuredClone(secondCurrent)
    forged.nodes[1]!.status = 'waiting-adoption'
    forged.nodes[1]!.errorCode = null
    forged.nodes[1]!.execution = {
      kind: 'image', operationId: 'different-operation', batchId: 'batch-2', taskId: 'task-2',
    }
    forged.nodes[1]!.retryDisposition = 'none'
    expect(() => secondStore.saveExecutionProgress(forged, secondCurrent.revision))
      .toThrow('CANVAS_WORKFLOW_RUN_RETRY_FACT_IMMUTABLE')
  })

  test('Given journal 含未知字段、循环依赖或符号链接 When 读取 Then 全部 fail closed', () => {
    const fixture = createFixture()
    const store = fixture.createStore()
    const created = store.create(fixture.input)
    const path = join(
      fixture.transactionsDir,
      'workflow-runs',
      `workflow-run-${created.id}.json`,
    )
    writeFileSync(path, JSON.stringify({ ...created, secretPath: '/tmp/private' }))
    expect(() => store.get(fixture.input, created.id)).toThrow('CANVAS_WORKFLOW_RUN_INVALID')

    const cyclic = {
      ...created,
      nodes: created.nodes.map((node) => ({
        ...node,
        dependencyNodeIds: node.nodeId === 'agent-root' ? ['image-result'] : ['agent-root'],
      })),
    }
    writeFileSync(path, JSON.stringify(cyclic))
    expect(() => store.get(fixture.input, created.id)).toThrow('CANVAS_WORKFLOW_RUN_INVALID')

    rmSync(path)
    const external = join(fixture.root, 'external.json')
    writeFileSync(external, JSON.stringify(created))
    symlinkSync(external, path)
    expect(() => store.get(fixture.input, created.id)).toThrow()
  })

  test('Given 单 Canvas 超过有界历史数量 When 枚举 Then 在读取内容前拒绝扫描', () => {
    const fixture = createFixture()
    const store = fixture.createStore()
    store.create(fixture.input)
    const directory = join(fixture.transactionsDir, 'workflow-runs')
    for (let index = 0; index < 512; index += 1) {
      const id = index.toString(16).padStart(48, '0')
      writeFileSync(join(directory, `workflow-run-${id}.json`), '{}')
    }

    expect(() => store.list(fixture.input)).toThrow('CANVAS_WORKFLOW_RUN_LIST_LIMIT_EXCEEDED')
  })

  test('Given 保存值修改首次计划身份 When CAS 保存 Then 拒绝篡改不可变授权事实', () => {
    const fixture = createFixture()
    const store = fixture.createStore()
    const created = store.create(fixture.input)
    created.nodes[0]!.identityHash = 'c'.repeat(64)

    expect(() => store.save(created, 0)).toThrow('CANVAS_WORKFLOW_RUN_IMMUTABLE')
  })

  test('Given planner 验证一个动态后继 When 专用 CAS 保存并重放原 operation Then 追加事实跨重启保留', () => {
    const fixture = createFixture()
    const store = fixture.createStore()
    const created = store.create(fixture.input)
    const amended = structuredClone(created)
    amended.observedCanvasRevision = 4
    amended.nodes.push({
      nodeId: 'dynamic-document', kind: 'document', identityHash: 'e'.repeat(64),
      plannedArtifactHash: 'f'.repeat(64), mediaConfigRevision: null, inputBindings: [],
      dependencyNodeIds: ['agent-root'], status: 'satisfied', errorCode: null,
      execution: null, completedArtifactHash: null, completedAt: null,
    })

    expect(() => store.save(amended, created.revision)).toThrow('CANVAS_WORKFLOW_RUN_IMMUTABLE')
    const saved = store.saveDynamicSuccessorAmendment(amended, created.revision)
    const replayed = store.create(fixture.input)

    expect(saved.nodes.map((node) => node.nodeId)).toContain('dynamic-document')
    expect(replayed.nodes.map((node) => node.nodeId)).toContain('dynamic-document')
    expect(replayed.revision).toBe(saved.revision)
  })

  test('Given 动态登记改写旧节点或引用未登记依赖 When 专用 CAS 保存 Then 拒绝扩权', () => {
    const cases: Array<(run: CanvasWorkflowRun) => void> = [
      (run) => { run.nodes[0]!.status = 'completed' },
      (run) => { run.nodes.at(-1)!.dependencyNodeIds = ['unregistered-node'] },
    ]
    for (const mutate of cases) {
      const fixture = createFixture()
      const store = fixture.createStore()
      const created = store.create(fixture.input)
      const amended = structuredClone(created)
      amended.observedCanvasRevision = 4
      amended.nodes.push({
        nodeId: 'dynamic-image', kind: 'image', identityHash: 'e'.repeat(64),
        plannedArtifactHash: null, mediaConfigRevision: null, inputBindings: [],
        dependencyNodeIds: ['agent-root'], status: 'ready', errorCode: null,
        execution: null, completedArtifactHash: null, completedAt: null,
      })
      mutate(amended)

      expect(() => store.saveDynamicSuccessorAmendment(amended, created.revision))
        .toThrow('CANVAS_WORKFLOW_DYNAMIC_SUCCESSOR_AMENDMENT_INVALID')
    }
  })

  test('Given 精确动态后继登记失败 When 专用 CAS 保存 Then 只允许追加 blocked 节点并标记 partial', () => {
    const fixture = createFixture()
    const store = fixture.createStore()
    const created = store.create(fixture.input)
    const amended = structuredClone(created)
    amended.status = 'partial'
    amended.observedCanvasRevision = 4
    amended.nodes.push({
      nodeId: 'dynamic-blocked', kind: 'document', identityHash: 'e'.repeat(64),
      plannedArtifactHash: null, mediaConfigRevision: null, inputBindings: [],
      dependencyNodeIds: ['agent-root'], status: 'blocked',
      errorCode: 'CANVAS_WORKFLOW_DYNAMIC_SUCCESSOR_NOT_BOUND', execution: null,
      completedArtifactHash: null, completedAt: null,
    })

    const saved = store.saveDynamicSuccessorAmendment(amended, created.revision)
    expect(saved.status).toBe('partial')
    expect(saved.nodes.at(-1)).toMatchObject({ nodeId: 'dynamic-blocked', status: 'blocked' })

    const invalidFixture = createFixture()
    const invalidStore = invalidFixture.createStore()
    const invalidCreated = invalidStore.create(invalidFixture.input)
    const invalid = structuredClone(invalidCreated)
    invalid.status = 'partial'
    invalid.observedCanvasRevision = 4
    invalid.nodes.push({ ...amended.nodes.at(-1)!, status: 'ready', errorCode: null })
    expect(() => invalidStore.saveDynamicSuccessorAmendment(invalid, invalidCreated.revision))
      .toThrow('CANVAS_WORKFLOW_DYNAMIC_SUCCESSOR_AMENDMENT_INVALID')
  })

  test('Given 已完成 Agent 的直接媒体下游尚未执行 When handoff 固化新配置 Then 专用 CAS 允许且普通 save 仍拒绝', () => {
    const fixture = createFixture()
    const store = fixture.createStore()
    const created = store.create(fixture.input)
    created.nodes[0]!.status = 'completed'
    created.nodes[0]!.execution = { kind: 'agent', operationId: 'agent-operation-1' }
    created.nodes[0]!.completedArtifactHash = 'c'.repeat(64)
    created.nodes[0]!.completedAt = 21
    const completed = store.save(created, 0)
    const amended = structuredClone(completed)
    amended.nodes[2]!.mediaConfigRevision = 4
    amended.nodes[2]!.inputBindings = [{
      targetInputKey: 'prompt', requiredKind: 'text', sourceNodeId: null,
      sourceOutputKey: null, sourceArtifactHash: null, resolvedValueHash: 'e'.repeat(64),
    }]
    amended.nodes[2]!.status = 'ready'
    amended.nodes[2]!.errorCode = null

    expect(() => store.save(amended, completed.revision)).toThrow('CANVAS_WORKFLOW_RUN_IMMUTABLE')
    const saved = store.savePreparedMediaAmendment(amended, completed.revision)
    expect(saved.nodes[2]).toMatchObject({ mediaConfigRevision: 4, status: 'ready' })
    expect(store.get(fixture.input, saved.id).nodes[2]?.inputBindings[0]?.resolvedValueHash).toBe('e'.repeat(64))
  })

  test('Given handoff 尝试修改非媒体事实、绑定计划外来源或释放未完成 child 下游 When 专用 CAS Then 拒绝扩权', () => {
    const cases: Array<(run: CanvasWorkflowRun) => void> = [
      (run) => { run.nodes[2]!.identityHash = 'f'.repeat(64) },
      (run) => {
        run.nodes[2]!.inputBindings[0]!.sourceNodeId = 'image-result'
        run.nodes[2]!.inputBindings[0]!.sourceOutputKey = 'image.asset'
        run.nodes[2]!.inputBindings[0]!.sourceArtifactHash = 'f'.repeat(64)
      },
      () => undefined,
    ]
    for (let index = 0; index < cases.length; index += 1) {
      const fixture = createFixture()
      const store = fixture.createStore()
      const created = store.create(fixture.input)
      if (index < 2) {
        created.nodes[0]!.status = 'completed'
        created.nodes[0]!.execution = { kind: 'agent', operationId: 'agent-operation-1' }
        created.nodes[0]!.completedArtifactHash = 'c'.repeat(64)
        created.nodes[0]!.completedAt = 21
      }
      const current = index < 2 ? store.save(created, 0) : created
      const amended = structuredClone(current)
      amended.nodes[2]!.mediaConfigRevision = 4
      amended.nodes[2]!.inputBindings[0]!.resolvedValueHash = 'e'.repeat(64)
      amended.nodes[2]!.status = 'ready'
      amended.nodes[2]!.errorCode = null
      cases[index]!(amended)
      expect(() => store.savePreparedMediaAmendment(amended, current.revision))
        .toThrow('CANVAS_WORKFLOW_MEDIA_AMENDMENT_INVALID')
    }
  })

  test('Given journal 创建和更新成功 When 通知 coordinator Then 锁外发送隔离副本且观察者异常不反转提交', () => {
    const fixture = createFixture()
    const changes: CanvasWorkflowRun[] = []
    const store = fixture.createStore(() => 20, (run) => {
      changes.push(run)
      run.goal = '观察者篡改副本'
      if (run.revision === 1) throw new Error('COORDINATOR_NOTIFY_FAILED')
    })

    const created = store.create(fixture.input)
    const update = structuredClone(created)
    update.status = 'waiting-review'
    const saved = store.save(update, created.revision)

    expect(changes.map((run) => run.revision)).toEqual([0, 1])
    expect(created.goal).toBe('生成一张主视觉')
    expect(saved.status).toBe('waiting-review')
    expect(store.get(fixture.input, saved.id).goal).toBe('生成一张主视觉')
  })
})
