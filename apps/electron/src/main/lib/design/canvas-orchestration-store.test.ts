import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CanvasOrchestrationRecord } from '@proma/shared'
import { createCanvasOrchestrationStore } from './canvas-orchestration-store'
import { createDesignPathResolver } from './design-paths'

/** 每个测试使用独立的项目根，避免锁文件和记录互相影响。 */
let root = ''

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'proma-canvas-orchestration-store-')) })
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

/** 创建只包含编排存储所需路径和写守卫的隔离夹具。 */
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
  const store = createCanvasOrchestrationStore({
    pathResolver,
    runWorkspaceWrite: (requestedProjectId, effect) => {
      writes.push(requestedProjectId)
      return effect()
    },
  })
  return { projectId, canvasId, pathResolver, store, writes }
}

/** 构造可持久化的最小编排记录。 */
function orchestrationRecord(
  requestId: string,
  canvasId = 'canvas-one',
  ownerSessionId = 'session-one',
): CanvasOrchestrationRecord {
  return {
    schemaVersion: 1,
    id: `orchestration-${requestId}`,
    revision: 1,
    projectId: 'project-one',
    canvasId,
    ownerSessionId,
    request: {
      requestId,
      goal: `完成 ${requestId}`,
      intent: 'design',
      constraints: [],
      referenceNodeIds: [],
      deliverables: [{ id: 'plan', title: '方案', kind: 'document', criteria: ['内容完整'] }],
    },
    coordinatorNodeId: null,
    coordinatorSessionId: null,
    status: 'planning',
    steps: [],
    summary: '',
    runStartedAt: null,
    createdAt: 10,
    updatedAt: 10,
  }
}

describe('Canvas 编排记录存储', () => {
  test('Given 无现有委托 When 创建并重启读取 Then 从Canvas固定文件恢复同一记录', () => {
    const fixture = createFixture()
    const record = orchestrationRecord('request-one')

    expect(fixture.store.create(record)).toEqual(record)
    const restarted = createCanvasOrchestrationStore({
      pathResolver: fixture.pathResolver,
      runWorkspaceWrite: (_projectId, effect) => effect(),
    })
    expect(restarted.get({ projectId: fixture.projectId, canvasId: fixture.canvasId })).toEqual(record)
    expect(fixture.writes).toEqual([fixture.projectId])
  })

  test('Given 同一request、owner和原始需求已创建 When 精确重放 Then 复用旧记录且不推进revision', () => {
    const fixture = createFixture()
    const record = orchestrationRecord('request-one')
    const created = fixture.store.create(record)

    expect(fixture.store.create({ ...record, summary: '调用方不可信的新摘要' })).toEqual(created)
    expect(fixture.store.get({ projectId: fixture.projectId, canvasId: fixture.canvasId })?.revision).toBe(1)
    expect(fixture.writes).toEqual([fixture.projectId, fixture.projectId])
  })

  test('Given 相同requestId但owner或原始需求不同 When 创建 Then 拒绝把冲突请求当作重放', () => {
    const fixture = createFixture()
    const record = orchestrationRecord('request-one')
    fixture.store.create(record)

    expect(() => fixture.store.create({ ...record, ownerSessionId: 'session-two' }))
      .toThrow('CANVAS_ORCHESTRATION_REQUEST_CONFLICT')
    expect(() => fixture.store.create({ ...record, request: { ...record.request, goal: '另一个目标' } }))
      .toThrow('CANVAS_ORCHESTRATION_REQUEST_CONFLICT')
  })

  test('Given 当前委托尚未终态 When 创建不同委托 Then 拒绝并保留当前记录', () => {
    const fixture = createFixture()
    const first = fixture.store.create(orchestrationRecord('request-one'))

    expect(() => fixture.store.create(orchestrationRecord('request-two')))
      .toThrow('CANVAS_ORCHESTRATION_ACTIVE_EXISTS')
    expect(fixture.store.get({ projectId: fixture.projectId, canvasId: fixture.canvasId })).toEqual(first)
  })

  test('Given 两个存储实例竞争同一Canvas When 先后创建不同委托 Then 锁内重读只保留赢家', () => {
    const fixture = createFixture()
    const competingStore = createCanvasOrchestrationStore({
      pathResolver: fixture.pathResolver,
      runWorkspaceWrite: (_projectId, effect) => effect(),
    })
    const winner = fixture.store.create(orchestrationRecord('request-winner'))

    expect(() => competingStore.create(orchestrationRecord('request-loser')))
      .toThrow('CANVAS_ORCHESTRATION_ACTIVE_EXISTS')
    expect(competingStore.get({ projectId: fixture.projectId, canvasId: fixture.canvasId })).toEqual(winner)
  })

  test('Given 当前委托已经终态 When 创建新委托 Then 归档旧记录并分配单调递增revision', () => {
    const fixture = createFixture()
    const target = { projectId: fixture.projectId, canvasId: fixture.canvasId }
    const first = fixture.store.create(orchestrationRecord('request-one'))
    const completed = fixture.store.save(target, first.revision, {
      ...first, revision: first.revision + 1, status: 'completed', updatedAt: 20,
    })
    const second = fixture.store.create(orchestrationRecord('request-two'))

    expect(second.revision).toBe(completed.revision + 1)
    expect(second.request.requestId).toBe('request-two')
    expect(fixture.store.create(orchestrationRecord('request-one'))).toEqual(completed)
    expect(fixture.store.get(target)).toEqual(second)
  })

  test('Given 连续完成超过16个委托 When 创建下一委托 Then 当前记录可用且历史保持有界', () => {
    const fixture = createFixture()
    const target = { projectId: fixture.projectId, canvasId: fixture.canvasId }
    let current = fixture.store.create(orchestrationRecord('request-0'))
    for (let index = 1; index <= 18; index += 1) {
      current = fixture.store.save(target, current.revision, {
        ...current, revision: current.revision + 1, status: 'completed', updatedAt: 10 + index,
      })
      current = fixture.store.create(orchestrationRecord(`request-${index}`))
    }

    expect(current.request.requestId).toBe('request-18')
    expect(() => fixture.store.create(orchestrationRecord('request-1')))
      .toThrow('CANVAS_ORCHESTRATION_ACTIVE_EXISTS')
    expect(fixture.store.create(orchestrationRecord('request-17')).request.requestId).toBe('request-17')
  })

  test('Given 已保存记录 When 使用旧revision或修改不可变委托事实保存 Then CAS与事实校验拒绝', () => {
    const fixture = createFixture()
    const target = { projectId: fixture.projectId, canvasId: fixture.canvasId }
    const created = fixture.store.create(orchestrationRecord('request-one'))

    expect(() => fixture.store.save(target, 0, { ...created, revision: 1 }))
      .toThrow('CANVAS_ORCHESTRATION_STORE_CONFLICT')
    expect(() => fixture.store.save(target, created.revision, {
      ...created, revision: created.revision + 1, request: { ...created.request, goal: '降低原目标' },
    })).toThrow('CANVAS_ORCHESTRATION_IMMUTABLE_FACTS_CHANGED')
    expect(fixture.store.get(target)).toEqual(created)
  })

  test('Given 合法下一状态 When 保存 Then 只推进一版并保留原委托事实', () => {
    const fixture = createFixture()
    const target = { projectId: fixture.projectId, canvasId: fixture.canvasId }
    const created = fixture.store.create(orchestrationRecord('request-one'))
    const saved = fixture.store.save(target, created.revision, {
      ...created,
      revision: created.revision + 1,
      status: 'running',
      summary: '已进入执行。',
      runStartedAt: 20,
      updatedAt: 20,
    })

    expect(saved).toMatchObject({ revision: 2, status: 'running', summary: '已进入执行。' })
    expect(fixture.store.get(target)).toEqual(saved)
  })

  test('Given Host预算已有消耗 When 保存 Then 不允许提高上限、降低消耗或删除预算', () => {
    const fixture = createFixture()
    const target = { projectId: fixture.projectId, canvasId: fixture.canvasId }
    const created = fixture.store.create({
      ...orchestrationRecord('request-budget'),
      budget: { maxAgentRuns: 32, agentRunsUsed: 4, maxMediaRuns: 16, mediaRunsUsed: 2 },
    })

    expect(() => fixture.store.save(target, created.revision, {
      ...created, revision: created.revision + 1,
      budget: { ...created.budget!, maxAgentRuns: 64 }, updatedAt: 20,
    })).toThrow('CANVAS_ORCHESTRATION_BUDGET_REGRESSION')
    expect(() => fixture.store.save(target, created.revision, {
      ...created, revision: created.revision + 1,
      budget: { ...created.budget!, agentRunsUsed: 3 }, updatedAt: 20,
    })).toThrow('CANVAS_ORCHESTRATION_BUDGET_REGRESSION')
    const { budget: _removedBudget, ...withoutBudget } = created
    expect(() => fixture.store.save(target, created.revision, {
      ...withoutBudget, revision: created.revision + 1, updatedAt: 20,
    })).toThrow('CANVAS_ORCHESTRATION_BUDGET_REGRESSION')
  })

  test('Given 已持久化媒体预留回执 When 保存预算 Then 旧回执不可删除改写且新回执只能追加', () => {
    const fixture = createFixture()
    const target = { projectId: fixture.projectId, canvasId: fixture.canvasId }
    const created = fixture.store.create({
      ...orchestrationRecord('request-media-reservations'),
      budget: {
        maxAgentRuns: 32,
        agentRunsUsed: 1,
        maxMediaRuns: 16,
        mediaRunsUsed: 3,
        mediaReservations: [
          { operationId: 'media-operation-1', count: 1 },
          { operationId: 'media-operation-2', count: 2 },
        ],
      },
    })

    expect(() => fixture.store.save(target, created.revision, {
      ...created,
      revision: created.revision + 1,
      budget: { ...created.budget!, mediaReservations: [{ operationId: 'media-operation-1', count: 1 }] },
      updatedAt: 20,
    })).toThrow('CANVAS_ORCHESTRATION_BUDGET_REGRESSION')
    expect(() => fixture.store.save(target, created.revision, {
      ...created,
      revision: created.revision + 1,
      budget: {
        ...created.budget!,
        mediaReservations: [
          { operationId: 'media-operation-1', count: 2 },
          { operationId: 'media-operation-2', count: 1 },
        ],
      },
      updatedAt: 20,
    })).toThrow('CANVAS_ORCHESTRATION_BUDGET_REGRESSION')
    const appended = fixture.store.save(target, created.revision, {
      ...created,
      revision: created.revision + 1,
      budget: {
        ...created.budget!,
        mediaRunsUsed: 4,
        mediaReservations: [...created.budget!.mediaReservations!, { operationId: 'media-operation-3', count: 1 }],
      },
      updatedAt: 20,
    })
    expect(appended.budget?.mediaReservations).toHaveLength(3)
  })

  test('Given 已持久化后续校正 When 保存 Then 旧校正不可删除改写或重排且只允许推进状态与追加', () => {
    const fixture = createFixture()
    const target = { projectId: fixture.projectId, canvasId: fixture.canvasId }
    const created = fixture.store.create({
      ...orchestrationRecord('request-follow-up'),
      followUps: [{ id: 'correction-1', instruction: '重新读取正式正文', decisionId: 'decision-1', status: 'pending', createdAt: 10 }],
    })

    expect(() => fixture.store.save(target, created.revision, {
      ...created, revision: created.revision + 1, followUps: [], updatedAt: 20,
    })).toThrow('CANVAS_ORCHESTRATION_FOLLOW_UP_REGRESSION')
    expect(() => fixture.store.save(target, created.revision, {
      ...created, revision: created.revision + 1,
      followUps: [{ ...created.followUps![0]!, instruction: '偷换要求' }], updatedAt: 20,
    })).toThrow('CANVAS_ORCHESTRATION_FOLLOW_UP_REGRESSION')
    // 已登记答案关联必须保留，不能删除或挪到另一个问题上。
    for (const decisionId of [undefined, 'decision-2']) {
      // 构造字段真正缺失的旧格式，避免以 undefined 触发解析层拒绝而漏测存储约束。
      const { decisionId: _previousDecisionId, ...previousAnswer } = created.followUps![0]!
      expect(() => fixture.store.save(target, created.revision, {
        ...created, revision: created.revision + 1,
        followUps: [{ ...previousAnswer, ...(decisionId ? { decisionId } : {}) }], updatedAt: 20,
      })).toThrow('CANVAS_ORCHESTRATION_FOLLOW_UP_REGRESSION')
    }
    const started = fixture.store.save(target, created.revision, {
      ...created, revision: created.revision + 1,
      followUps: [{ ...created.followUps![0]!, status: 'started', startedAt: 20, userMessageUuid: 'a'.repeat(64) }],
      runStartedAt: 20, status: 'running', updatedAt: 20,
    })
    expect(started.followUps?.[0]?.status).toBe('started')
    expect(() => fixture.store.save(target, started.revision, {
      ...started, revision: started.revision + 1,
      followUps: [{ ...started.followUps![0]!, status: 'delivered' }, {
        id: 'correction-2', instruction: '伪造替代关系', supersedesId: 'correction-1', status: 'pending', createdAt: 21,
      }], updatedAt: 21,
    })).toThrow('CANVAS_ORCHESTRATION_RECORD_INVALID')
    expect(() => fixture.store.save(target, started.revision, {
      ...started, revision: started.revision + 1,
      followUps: [{ ...started.followUps![0]!, status: 'abandoned' }], updatedAt: 21,
    })).toThrow('CANVAS_ORCHESTRATION_RECORD_INVALID')
    const superseded = fixture.store.save(target, started.revision, {
      ...started, revision: started.revision + 1,
      followUps: [{ ...started.followUps![0]!, status: 'abandoned' }, {
        id: 'correction-2', instruction: '明确替代旧尝试', supersedesId: 'correction-1', status: 'pending', createdAt: 21,
      }], updatedAt: 21,
    })
    expect(superseded.followUps?.map(item => item.status)).toEqual(['abandoned', 'pending'])
  })

  test('Given 同一项目有两个Canvas When 创建与保存 Then 记录隔离且保存拒绝跨作用域', () => {
    const fixture = createFixture()
    const target = { projectId: fixture.projectId, canvasId: fixture.canvasId }
    const secondCanvasId = 'canvas-two'
    mkdirSync(fixture.pathResolver.resolveCanvas(fixture.projectId, secondCanvasId).canvasRoot, { recursive: true })

    const second = fixture.store.create(orchestrationRecord('request-two', secondCanvasId))
    expect(fixture.store.get(target)).toBeNull()
    expect(fixture.store.get({ projectId: fixture.projectId, canvasId: secondCanvasId })).toEqual(second)
    const created = fixture.store.create(orchestrationRecord('request-one'))
    expect(() => fixture.store.save(target, created.revision, { ...created, projectId: 'project-two', revision: 2 }))
      .toThrow('CANVAS_ORCHESTRATION_STORE_SCOPE_MISMATCH')
  })

  test('Given 固定记录文件损坏或被替换为符号链接 When 读取 Then no-follow拒绝不可信内容', () => {
    const fixture = createFixture()
    const target = { projectId: fixture.projectId, canvasId: fixture.canvasId }
    const canvasRoot = fixture.pathResolver.resolveCanvas(fixture.projectId, fixture.canvasId).canvasRoot
    const file = join(canvasRoot, 'orchestration.json')
    writeFileSync(file, '{"bad":true}', 'utf8')
    expect(() => fixture.store.get(target)).toThrow('CANVAS_ORCHESTRATION_STORE_INVALID')

    rmSync(file)
    const outside = join(root, 'outside.json')
    writeFileSync(outside, '{}', 'utf8')
    symlinkSync(outside, file)
    expect(() => fixture.store.get(target)).toThrow('CANVAS_ORCHESTRATION_STORE_PATH_INVALID')
    expect(lstatSync(file).isSymbolicLink()).toBe(true)
  })

  test('Given 当前记录超过512KiB When 保存 Then 拒绝且磁盘revision不前进', () => {
    const fixture = createFixture()
    const target = { projectId: fixture.projectId, canvasId: fixture.canvasId }
    const created = fixture.store.create(orchestrationRecord('request-one'))
    const largeStep = {
      id: 'large-step', title: '大步骤', role: '策划', instruction: '内'.repeat(32_768),
      dependsOn: [], inputNodeIds: [], outputNodeIds: [], agentNodeId: null,
      criteria: Array.from({ length: 32 }, (_unused, index) => `${index}:`.padEnd(4_096, '据')),
      status: 'planned' as const, note: '注'.repeat(16_384),
    }

    expect(() => fixture.store.save(target, created.revision, {
      ...created,
      revision: created.revision + 1,
      steps: Array.from({ length: 64 }, (_unused, index) => ({ ...largeStep, id: `large-step-${index}` })),
      updatedAt: 20,
    })).toThrow('CANVAS_ORCHESTRATION_RECORD_SIZE_LIMIT')
    expect(fixture.store.get(target)).toEqual(created)
  })

  test('Given 工作区写守卫拒绝写入 When 保存 Then 磁盘记录与revision保持原值', () => {
    const fixture = createFixture()
    const target = { projectId: fixture.projectId, canvasId: fixture.canvasId }
    const created = fixture.store.create(orchestrationRecord('request-one'))
    const rejectedStore = createCanvasOrchestrationStore({
      pathResolver: fixture.pathResolver,
      runWorkspaceWrite: () => { throw new Error('WORKSPACE_WRITE_REJECTED') },
    })

    expect(() => rejectedStore.save(target, created.revision, {
      ...created, revision: created.revision + 1, status: 'running', runStartedAt: 20, updatedAt: 20,
    })).toThrow('WORKSPACE_WRITE_REJECTED')
    expect(fixture.store.get(target)).toEqual(created)
  })
})
