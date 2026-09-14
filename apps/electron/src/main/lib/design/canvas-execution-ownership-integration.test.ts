import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createEmptyCanvasDocument } from '@proma/shared'
import type { CanvasOrchestrationRequest, CanvasTarget } from '@proma/shared'
import { createCanvasExecutionOwnership } from './canvas-execution-ownership'
import { createCanvasOrchestrationStore } from './canvas-orchestration-store'
import { createCanvasOrchestrationRuntime } from './canvas-orchestration-runtime'
import { createCanvasWorkflowExecutionService } from './canvas-workflow-execution-service'
import { createCanvasWorkflowPlanSnapshot } from './canvas-workflow-planner'
import { createCanvasWorkflowRunStore } from './canvas-workflow-run-store'
import type { CanvasPaths } from './design-paths'

/** 全部持久化写入临时根，Agent 只记录执行次数，不使用真实会话或模型。 */
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

/** 真实两种 Store、准入器与调度服务组合，外部模型和内容读取是受控边界。 */
function fixture() {
  const canvasRoot = mkdtempSync(join(tmpdir(), 'proma-execution-integration-'))
  roots.push(canvasRoot)
  const transactionsDir = join(canvasRoot, 'transactions')
  mkdirSync(transactionsDir)
  const target = { projectId: 'project', canvasId: 'canvas' }
  const pathResolver = { resolveCanvas: () => ({ canvasRoot, transactionsDir }) as CanvasPaths }
  const runWorkspaceWrite = <T>(_projectId: string, effect: () => T): T => effect()
  const document = createEmptyCanvasDocument(target.projectId, target.canvasId, 1)
  document.nodes.push({ id: 'legacy-agent', title: '旧方案', kind: 'agent', position: { x: 0, y: 0 }, agentSessionId: 'legacy-session' })
  const workflowStore = createCanvasWorkflowRunStore({ pathResolver, runWorkspaceWrite })
  const orchestrationStore = createCanvasOrchestrationStore({ pathResolver, runWorkspaceWrite })
  const ownership = createCanvasExecutionOwnership({ pathResolver, runWorkspaceWrite,
    getOrchestration: orchestrationStore.get, listWorkflows: workflowStore.list })
  const context = { ...target, sessionId: 'owner', runStartedAt: 1, explicitReferences: [], permissionCeiling: 'execute' as const }
  const input = { canvasId: target.canvasId, expectedRevision: document.revision, startNodeIds: ['legacy-agent'], goal: '旧设计', maxImageRuns: 0 }
  const request: CanvasOrchestrationRequest = { requestId: 'request', goal: '新设计', intent: 'design', constraints: [], referenceNodeIds: [],
    deliverables: [{ id: 'design', title: '设计', kind: 'agent', criteria: ['符合需求'] }] }
  let coordinatorCreates = 0
  let coordinatorStarts = 0
  let legacyStarts = 0
  let loadDocument = async (_target: CanvasTarget) => document
  const orchestration = createCanvasOrchestrationRuntime({
    store: orchestrationStore, executionOwnership: ownership,
    access: { authorizeRead: () => undefined, requireLinkedCanvas: () => ({ ...target, sessionId: 'owner',
      linkedCanvasIds: ['canvas'], defaultCanvasId: 'canvas', lastActiveCanvasId: 'canvas', updatedAt: 1 }),
    runWrite: (_context, effect) => effect() },
    documents: { load: () => ({ document }) },
    artifacts: { resolveCreated: () => null, createAgent: async creation => {
      coordinatorCreates++
      const nodeId = `coordinator-${coordinatorCreates}`
      document.nodes.push({ id: nodeId, title: creation.title, kind: 'agent', position: { x: 100, y: 0 }, agentSessionId: `session-${nodeId}` })
      document.revision++
      return { ...target, artifactType: 'agent', nodeId, revision: document.revision, sourceToolCallId: creation.source.toolCallId }
    } },
    execution: { execute: async () => { coordinatorStarts++; return { status: 'completed' } } },
    evidence: {} as Parameters<typeof createCanvasOrchestrationRuntime>[0]['evidence'],
    getAgentMessages: () => [], isAgentBusy: () => false, createRun: () => undefined, onChanged: () => undefined,
  })
  const legacy = createCanvasWorkflowExecutionService({
    executionOwnership: ownership, workflowRuns: workflowStore,
    load: target => loadDocument(target), validateAccess: () => undefined, isAgentBusy: () => false,
    agentExecution: { execute: async () => { legacyStarts++; return { status: 'errored' } } },
    imageRuns: { run: async () => { throw new Error('UNEXPECTED_IMAGE') }, awaitBatch: async () => { throw new Error('UNEXPECTED_IMAGE') }, cancelTasks: async () => undefined },
  })
  /** 模拟升级前已经存在的旧持久运行，允许验证冲突情况下的只读与取消出口。 */
  const seedLegacyRun = () => {
    const snapshot = createCanvasWorkflowPlanSnapshot(document, input)
    return workflowStore.create({ ...target, operationId: 'legacy-operation', owner: { sessionId: 'owner', runStartedAt: 1 },
      initialCanvasRevision: document.revision, rootNodeIds: snapshot.rootNodeIds, goal: input.goal, nodes: snapshot.nodes,
      maxMediaRuns: 0, consumedMediaRuns: 0, autoResumeAfterAdoption: true })
  }
  return { target, context, input, request, document, ownership, orchestrationStore, workflowStore, orchestration, legacy, seedLegacyRun,
    counts: () => ({ coordinatorCreates, coordinatorStarts, legacyStarts }),
    setLoad: (load: typeof loadDocument) => { loadDocument = load } }
}

describe('新旧 Canvas 调度生产组合准入', () => {
  test('Given 存量运行尚未终结 When 普通Agent提交新委托 Then 不创建委托或协调节点', async () => {
    const f = fixture()
    f.seedLegacyRun()
    await expect(f.orchestration.delegate(f.context, f.request)).rejects.toThrow('CANVAS_WORKFLOW_OWNS_EXECUTION')
    expect(f.orchestrationStore.get(f.target)).toBeNull()
    expect(f.counts()).toEqual({ coordinatorCreates: 0, coordinatorStarts: 0, legacyStarts: 0 })
  })
  test('Given 新委托正在等待 When 显式运行旧工作流 Then 零登记零模型启动', async () => {
    const f = fixture()
    await f.orchestration.delegate(f.context, f.request)
    await expect(f.legacy.execute(f.context, { ...f.input, expectedRevision: f.document.revision }, 'legacy-start'))
      .rejects.toThrow('CANVAS_ORCHESTRATION_OWNS_EXECUTION')
    expect(f.workflowStore.list(f.target)).toEqual([])
    expect(f.counts().legacyStarts).toBe(0)
  })
  test('Given 升级前双运行记录冲突 When 自动或显式恢复旧任务 Then 不改旧预算但查询与取消仍可用', async () => {
    const f = fixture()
    await f.orchestration.delegate(f.context, f.request)
    const old = f.seedLegacyRun()
    for (const automatic of [true, false]) {
      await expect(f.legacy.resume(f.context, { ...f.target, runId: old.id }, undefined, { automatic }))
        .rejects.toThrow('CANVAS_ORCHESTRATION_OWNS_EXECUTION')
    }
    expect(f.counts().legacyStarts).toBe(0)
    expect((await f.legacy.get(f.context, { ...f.target, runId: old.id })).revision).toBe(old.revision)
    expect((await f.legacy.list(f.context, f.target.canvasId)).length).toBe(1)
    expect((await f.legacy.cancel(f.context, { ...f.target, runId: old.id })).status).toBe('cancelled')
  })
  test('Given 旧工作流异步读取期间新委托接管 When 读取返回 Then 拒绝旧登记和后续执行', async () => {
    const f = fixture()
    let started!: () => void
    let release!: () => void
    const loading = new Promise<void>(resolve => { started = resolve })
    const ready = new Promise<void>(resolve => { release = resolve })
    f.setLoad(async () => { started(); await ready; return f.document })
    const running = f.legacy.execute(f.context, f.input, 'legacy-race')
    await loading
    await f.orchestration.delegate(f.context, f.request)
    /** 使用同一文档基线，避免普通revision冲突掩盖准入缺口。 */
    f.input.expectedRevision = f.document.revision
    release()
    await expect(running).rejects.toThrow('CANVAS_ORCHESTRATION_OWNS_EXECUTION')
    expect(f.workflowStore.list(f.target)).toEqual([])
    expect(f.counts().legacyStarts).toBe(0)
  })
  test('Given 旧运行已取消 When 创建新委托 Then 正常启动且旧记录保留', async () => {
    const f = fixture()
    const old = f.seedLegacyRun()
    await f.legacy.cancel(f.context, { ...f.target, runId: old.id })
    expect((await f.orchestration.delegate(f.context, f.request)).status).toBe('waiting')
    expect(f.counts().coordinatorStarts).toBe(1)
    expect(f.workflowStore.get(f.target, old.id).status).toBe('cancelled')
  })
})
