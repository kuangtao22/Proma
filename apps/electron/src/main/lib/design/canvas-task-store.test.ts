import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { lstatSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCanvasTaskContract } from './canvas-task-contract'
import type { CanvasTaskState } from './canvas-task-contract'
import { createCanvasTaskStore } from './canvas-task-store'
import { createDesignPathResolver } from './design-paths'

/** 每个测试独占的项目与配置根。 */
let root = ''

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'proma-canvas-task-store-')) })
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

/** 创建只覆盖任务存储所需路径与工作区写守卫的隔离夹具。 */
function createFixture() {
  const projectId = 'project-one'
  const canvasId = 'canvas-one'
  const pathResolver = createDesignPathResolver({
    getWorkspace: (requestedProjectId) => requestedProjectId === projectId ? {
      id: projectId, name: '项目', slug: projectId,
      projectRootPath: join(root, projectId), createdAt: 1, updatedAt: 1,
    } : undefined,
    getProjectFilesPath: (workspaceSlug) => join(root, workspaceSlug),
    getConfigDir: () => join(root, '.config'),
  })
  mkdirSync(pathResolver.resolveCanvas(projectId, canvasId).canvasRoot, { recursive: true })
  const writes: string[] = []
  const store = createCanvasTaskStore({
    pathResolver,
    runWorkspaceWrite: (projectId, effect) => {
      writes.push(projectId)
      return effect()
    },
  })
  return { root, projectId, canvasId, pathResolver, store, writes }
}

/** 构造可落盘的最小工作中合同状态。 */
function workingState(taskId: string, canvasId = 'canvas') {
  const task = createCanvasTaskContract({ required: true, taskId, verify: async () => true })
  task.start(canvasId, [{ id: 'answer', description: '返回结论', validation: 'response' }])
  return task.exportState()
}

/** 构造接近单任务合法上限的状态，用于验证归档字节预算。 */
function largeWorkingState(taskId: string, canvasId: string): CanvasTaskState {
  const state = workingState(taskId, canvasId)
  return {
    ...state,
    submissions: Array.from({ length: 32 }, (_unused, index) => ({
      id: `submission-${index}`,
      text: `${index}:`.padEnd(16_384, '内'),
    })),
  }
}

/** 构造超过存储预算但仍符合合同数组与字段上限的活动状态。 */
function oversizedActiveState(taskId: string, canvasId: string): CanvasTaskState {
  const state = workingState(taskId, canvasId)
  return {
    ...state,
    operationReceipts: Array.from({ length: 256 }, (_unused, index) => ({
      status: 'completed' as const,
      operationId: `operation-${index}`,
      sourceToolCallId: `tool-${index}`,
      startedAt: index,
      taskId,
      canvasId,
      kind: 'updated' as const,
      nodeId: `node-${index}`,
      nodeKind: 'document' as const,
      before: {
        canvasId, nodeId: `node-${index}`, nodeKind: 'document' as const,
        validation: 'content' as const, identity: `${index}:`.padEnd(4_096, '前'),
      },
      after: {
        canvasId, nodeId: `node-${index}`, nodeKind: 'document' as const,
        validation: 'content' as const, identity: `${index}:`.padEnd(4_096, '后'),
      },
    })),
  }
}

describe('Canvas 任务状态存储', () => {
  test('Given 任务已保存 When 进程重启后读取 Then 恢复同一会话与Canvas的活动任务', () => {
    const fixture = createFixture()
    const target = { projectId: fixture.projectId, canvasId: fixture.canvasId, sessionId: 'session-one' }
    const saved = fixture.store.save(target, 0, workingState('task-one', fixture.canvasId))
    const restarted = createCanvasTaskStore({
      pathResolver: fixture.pathResolver,
      runWorkspaceWrite: (_projectId, effect) => effect(),
    })

    expect(saved.revision).toBe(1)
    expect(restarted.getActive(target)).toMatchObject({ revision: 1, state: { taskId: 'task-one', phase: 'working' } })
    expect(fixture.writes).toEqual([fixture.projectId])
  })

  test('Given 已有未完成任务 When 以旧revision保存另一任务 Then 不覆盖且并发CAS失败', () => {
    const fixture = createFixture()
    const target = { projectId: fixture.projectId, canvasId: fixture.canvasId, sessionId: 'session-one' }
    fixture.store.save(target, 0, workingState('task-one', fixture.canvasId))

    expect(() => fixture.store.save(target, 0, workingState('task-one', fixture.canvasId)))
      .toThrow('CANVAS_TASK_STORE_CONFLICT')
    expect(() => fixture.store.save(target, 1, workingState('task-two', fixture.canvasId)))
      .toThrow('CANVAS_TASK_ACTIVE_EXISTS')
    expect(fixture.store.getActive(target)?.state.taskId).toBe('task-one')
  })

  test('Given 显式归档活动任务 When 新任务保存 Then 保留历史且允许新任务', () => {
    const fixture = createFixture()
    const target = { projectId: fixture.projectId, canvasId: fixture.canvasId, sessionId: 'session-one' }
    fixture.store.save(target, 0, workingState('task-one', fixture.canvasId))
    const archived = fixture.store.archive(target, 1, 'task-one')
    const next = fixture.store.save(target, archived.revision, workingState('task-two', fixture.canvasId))

    expect(next.state.taskId).toBe('task-two')
    expect(fixture.store.get(target)).toMatchObject({
      revision: 3,
      active: { taskId: 'task-two' },
      archived: [{ taskId: 'task-one' }],
    })
  })

  test('Given 大归档逐步接近文件上限 When 持续保存和归档 Then 只淘汰最旧归档并保留最新任务', () => {
    const fixture = createFixture()
    const target = { projectId: fixture.projectId, canvasId: fixture.canvasId, sessionId: 'session-large-history' }
    let revision = 0

    for (let index = 0; index < 8; index += 1) {
      const taskId = `task-${index}`
      revision = fixture.store.save(target, revision, largeWorkingState(taskId, fixture.canvasId)).revision
      revision = fixture.store.archive(target, revision, taskId).revision
    }

    const snapshot = fixture.store.get(target)
    const file = join(fixture.pathResolver.resolveCanvas(fixture.projectId, fixture.canvasId).canvasRoot, 'task-state', 'task-session-large-history.json')
    expect(snapshot.revision).toBe(16)
    expect(snapshot.active).toBeNull()
    expect(snapshot.archived.at(-1)?.taskId).toBe('task-7')
    expect(snapshot.archived.length).toBeLessThan(8)
    expect(snapshot.archived.map((state) => state.taskId)).toEqual(
      Array.from({ length: snapshot.archived.length }, (_unused, index) => `task-${8 - snapshot.archived.length + index}`),
    )
    expect(statSync(file).size).toBeLessThanOrEqual(2 * 1024 * 1024)
  })

  test('Given 活动任务自身超过文件上限 When 保存 Then 明确拒绝且保持原活动任务与revision', () => {
    const fixture = createFixture()
    const target = { projectId: fixture.projectId, canvasId: fixture.canvasId, sessionId: 'session-active-limit' }
    fixture.store.save(target, 0, workingState('task-active', fixture.canvasId))

    expect(() => fixture.store.save(
      target,
      1,
      oversizedActiveState('task-active', fixture.canvasId),
    )).toThrow('CANVAS_TASK_STORE_SIZE_LIMIT')

    expect(fixture.store.get(target)).toMatchObject({
      revision: 1,
      active: { taskId: 'task-active', operationReceipts: [] },
      archived: [],
    })
  })

  test('Given 相同会话属于不同Canvas When 分别保存 Then 状态严格隔离', () => {
    const fixture = createFixture()
    const first = { projectId: fixture.projectId, canvasId: fixture.canvasId, sessionId: 'session-one' }
    const secondCanvasId = 'canvas-two'
    mkdirSync(fixture.pathResolver.resolveCanvas(fixture.projectId, secondCanvasId).canvasRoot, { recursive: true })
    const second = { projectId: fixture.projectId, canvasId: secondCanvasId, sessionId: 'session-one' }
    fixture.store.save(first, 0, workingState('task-one', fixture.canvasId))
    fixture.store.save(second, 0, workingState('task-two', secondCanvasId))

    expect(fixture.store.getActive(first)?.state.taskId).toBe('task-one')
    expect(fixture.store.getActive(second)?.state.taskId).toBe('task-two')
  })

  test('Given 任务目录被替换为符号链接 When 保存 Then 拒绝越过Canvas范围', () => {
    const fixture = createFixture()
    const target = { projectId: fixture.projectId, canvasId: fixture.canvasId, sessionId: 'session-one' }
    const canvasRoot = fixture.pathResolver.resolveCanvas(fixture.projectId, fixture.canvasId).canvasRoot
    mkdirSync(canvasRoot, { recursive: true })
    const outside = join(fixture.root, 'outside')
    mkdirSync(outside)
    symlinkSync(outside, join(canvasRoot, 'task-state'))

    expect(() => fixture.store.save(target, 0, workingState('task-one', fixture.canvasId)))
      .toThrow('CANVAS_TASK_STORE_PATH_INVALID')
    expect(lstatSync(join(canvasRoot, 'task-state')).isSymbolicLink()).toBe(true)
  })

  test('Given 任务目录是悬空符号链接 When 读取 Then 不把攻击路径当作空状态', () => {
    const fixture = createFixture()
    const target = { projectId: fixture.projectId, canvasId: fixture.canvasId, sessionId: 'session-one' }
    const canvasRoot = fixture.pathResolver.resolveCanvas(fixture.projectId, fixture.canvasId).canvasRoot
    symlinkSync(join(fixture.root, 'missing-target'), join(canvasRoot, 'task-state'))

    expect(() => fixture.store.get(target)).toThrow('CANVAS_TASK_STORE_PATH_INVALID')
  })
})
