import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CanvasWorkflowRunNode } from '@proma/shared'
import {
  createCanvasWorkflowRunId,
  createCanvasWorkflowRunStore,
  type CreateCanvasWorkflowRunInput,
} from './canvas-workflow-run-store'

const temporaryRoots: string[] = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** 创建隔离的持久运行 Store 与固定输入。 */
function createFixture() {
  const root = mkdtempSync(join(tmpdir(), 'proma-workflow-runs-'))
  temporaryRoots.push(root)
  const transactionsDir = join(root, 'transactions')
  mkdirSync(transactionsDir, { recursive: true })
  const nodes: CanvasWorkflowRunNode[] = [{
    nodeId: 'agent-root', kind: 'agent', identityHash: 'a'.repeat(64),
    plannedArtifactHash: null, mediaConfigRevision: null, inputBindings: [], dependencyNodeIds: [],
    status: 'ready', errorCode: null, execution: null,
    completedArtifactHash: null, completedAt: null,
  }]
  const input: CreateCanvasWorkflowRunInput = {
    projectId: 'project-1', canvasId: 'canvas-1', operationId: 'operation-1',
    owner: { sessionId: 'session-1', runStartedAt: 10 }, initialCanvasRevision: 3,
    rootNodeIds: ['agent-root'], goal: '完成画布生产', nodes,
    maxMediaRuns: 2, consumedMediaRuns: 0, autoResumeAfterAdoption: false,
  }
  const createStore = (now = () => 20) => createCanvasWorkflowRunStore({
    pathResolver: { resolveCanvas: () => ({ transactionsDir }) as never },
    runWorkspaceWrite: (_projectId, effect) => effect(),
    now,
  })
  return { root, transactionsDir, input, createStore }
}

describe('Canvas Workflow Run Store', () => {
  test('Given 相同 operation 重放 When 已有进度 Then 返回稳定 run 且不覆盖进度', () => {
    const fixture = createFixture()
    const store = fixture.createStore()
    const created = store.create(fixture.input)
    const changed = structuredClone(created)
    changed.nodes[0] = {
      ...changed.nodes[0]!, status: 'completed',
      execution: { kind: 'agent', operationId: 'child-1' },
      completedArtifactHash: 'b'.repeat(64), completedAt: 21,
    }
    store.save(changed, 0)

    const replayed = store.create(fixture.input)
    expect(replayed.id).toBe(createCanvasWorkflowRunId('project-1', 'canvas-1', 'operation-1'))
    expect(replayed.revision).toBe(1)
    expect(replayed.nodes[0]?.status).toBe('completed')
  })

  test('Given 旧格式 run 已存在 When 精确 owner 重放 Then 继续复用原 runId', () => {
    const fixture = createFixture()
    const store = fixture.createStore()
    const created = store.create(fixture.input)

    const replayed = store.create(fixture.input)

    expect(created.id).toBe(createCanvasWorkflowRunId('project-1', 'canvas-1', 'operation-1'))
    expect(replayed.id).toBe(created.id)
    expect(store.findByOperation(fixture.input, fixture.input.operationId, fixture.input.owner)?.id)
      .toBe(created.id)
  })

  test('Given 旧格式 operation 已属于其他 owner When 新父运行创建 Then 使用独立 owner runId', () => {
    const fixture = createFixture()
    const store = fixture.createStore()
    const legacy = store.create(fixture.input)
    const nextInput = {
      ...fixture.input,
      owner: { sessionId: 'session-2', runStartedAt: 30 },
    }

    const created = store.create(nextInput)
    const replayed = store.create(nextInput)

    expect(created.id).not.toBe(legacy.id)
    expect(created.id).toBe(createCanvasWorkflowRunId(
      nextInput.projectId,
      nextInput.canvasId,
      nextInput.operationId,
      nextInput.owner,
    ))
    expect(replayed.id).toBe(created.id)
    expect(store.findByOperation(nextInput, nextInput.operationId, nextInput.owner)?.id).toBe(created.id)
    expect(store.get(fixture.input, legacy.id).owner).toEqual(fixture.input.owner)
  })

  test('Given 两个保存者读取相同 revision When 依次提交 Then 第二个收到 CAS 冲突', () => {
    const fixture = createFixture()
    const store = fixture.createStore()
    const first = store.create(fixture.input)
    const stale = structuredClone(first)
    first.observedCanvasRevision = 4
    store.save(first, 0)

    expect(() => store.save(stale, 0)).toThrow('CANVAS_WORKFLOW_RUN_CONFLICT')
  })

  test('Given 相同 operation 绑定不同固定计划 When 创建 Then 拒绝覆盖原授权事实', () => {
    const fixture = createFixture()
    const store = fixture.createStore()
    store.create(fixture.input)

    expect(() => store.create({ ...fixture.input, goal: '另一个生产目标' }))
      .toThrow('CANVAS_WORKFLOW_OPERATION_CONFLICT')
  })

  test('Given 保存值修改首次节点身份 When CAS 保存 Then 拒绝篡改不可变计划', () => {
    const fixture = createFixture()
    const store = fixture.createStore()
    const created = store.create(fixture.input)
    created.nodes[0]!.identityHash = 'c'.repeat(64)

    expect(() => store.save(created, 0)).toThrow('CANVAS_WORKFLOW_RUN_IMMUTABLE')
  })

  test('Given 单 Canvas 超过 512 条历史 When 分页枚举 Then 全部可达且顺序稳定', () => {
    const fixture = createFixture()
    let tick = 100
    const store = fixture.createStore(() => tick += 1)
    for (let index = 0; index < 513; index += 1) {
      store.create({ ...fixture.input, operationId: `operation-${index}` })
    }

    const first = store.listPage(fixture.input, { limit: 256 })
    const second = store.listPage(fixture.input, { limit: 256, cursor: first.nextCursor ?? undefined })
    const third = store.listPage(fixture.input, { limit: 256, cursor: second.nextCursor ?? undefined })
    const ids = [...first.runs, ...second.runs, ...third.runs].map((run) => run.id)

    expect(ids).toHaveLength(513)
    expect(new Set(ids).size).toBe(513)
    expect(third.nextCursor).toBeNull()
  })

  test('Given 其他 Agent 有超过单页上限的较新运行 When 按 owner 分页 Then 过滤后仍可完整翻页', () => {
    const fixture = createFixture()
    let tick = 100
    const store = fixture.createStore(() => tick += 1)
    const firstOwnRun = store.create(fixture.input)
    const secondOwnRun = store.create({ ...fixture.input, operationId: 'operation-own-2' })
    for (let index = 0; index < 257; index += 1) {
      store.create({
        ...fixture.input,
        operationId: `operation-other-${index}`,
        owner: { sessionId: 'session-other', runStartedAt: 20 },
      })
    }

    const firstPage = store.listPage(fixture.input, { limit: 1, ownerSessionId: 'session-1' })
    const secondPage = store.listPage(fixture.input, {
      limit: 1,
      ownerSessionId: 'session-1',
      cursor: firstPage.nextCursor ?? undefined,
    })

    expect(firstPage.runs.map((run) => run.id)).toEqual([secondOwnRun.id])
    expect(firstPage.nextCursor).not.toBeNull()
    expect(secondPage.runs.map((run) => run.id)).toEqual([firstOwnRun.id])
    expect(secondPage.nextCursor).toBeNull()
  })

  test('Given journal 是符号链接 When 读取 Then 拒绝跟随到工作区外', () => {
    const fixture = createFixture()
    const store = fixture.createStore()
    const created = store.create(fixture.input)
    const path = join(fixture.transactionsDir, 'workflow-runs', `workflow-run-${created.id}.json`)
    rmSync(path)
    const external = join(fixture.root, 'external.json')
    writeFileSync(external, JSON.stringify(created))
    symlinkSync(external, path)

    expect(() => store.get(fixture.input, created.id)).toThrow('CANVAS_WORKFLOW_RUN_PATH_INVALID')
  })

  test('Given 一个进程持有推进租约 When 第二个推进者竞争 Then 只能取得一次', () => {
    const fixture = createFixture()
    const store = fixture.createStore()
    const created = store.create(fixture.input)
    const release = store.acquireLease(fixture.input, created.id)

    expect(release).toBeFunction()
    expect(store.acquireLease(fixture.input, created.id)).toBeNull()
    release?.()
    const reacquired = store.acquireLease(fixture.input, created.id)
    expect(reacquired).toBeFunction()
    reacquired?.()
  })
})
