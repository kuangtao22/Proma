import { describe, expect, test } from 'bun:test'
import {
  applyCanvasMutations,
  createEmptyCanvasDocument,
} from '@proma/shared'
import type {
  CanvasDocument,
  CanvasMutation,
  CanvasNode,
  CanvasOrchestrationRecord,
  CanvasOrchestrationRequest,
  CanvasOrchestrationStep,
  CanvasTarget,
} from '@proma/shared'
import type {
  StableDirectoryNativeRequest,
  StableDirectoryNativeResult,
  StableDirectoryOpenedRoot,
} from '../stable-directory-native-host'
import { createCanvasArtifactCreationService } from './canvas-artifact-creation'
import { createCanvasArtifactRevisionStore } from './canvas-artifact-revision-store'
import { createCanvasNodeContentStore } from './canvas-node-content-store'
import { createCanvasOrchestrationService } from './canvas-orchestration-service'
import type {
  CanvasOrchestrationBranchAccess,
  CanvasOrchestrationServiceDependencies,
} from './canvas-orchestration-service'
import { readCanvasOrchestrationNodeIdentity } from './canvas-orchestration-runtime'
import { createCanvasTaskEvidence, resolveCanvasTaskEvidence } from './canvas-task-evidence'
import type { CanvasTaskEvidenceDependencies } from './canvas-task-evidence'
import { EMPTY_WEBVIEW_HTML } from './canvas-text-artifact-content'
import { createCanvasTextArtifactService } from './canvas-text-artifact-service'
import type { CanvasTextArtifactGraphWriter } from './canvas-text-artifact-service'

/** 测试只写隔离内存目录，目标身份保持稳定以验证服务重建。 */
const target: CanvasTarget = { projectId: 'project-initial', canvasId: 'canvas-initial' }

/** 内存相对目录协议中的单个 entry 文件集合。 */
interface MemoryEntryFiles {
  [fileName: string]: string
}

/** 创建 NodeContentStore 与 RevisionStore 共用的窄内存 native 协议。 */
function createMemoryNativeProtocol() {
  /** childName -> entryId -> files，模拟 Canvas 根下的受管子目录。 */
  const directories = new Map<string, Map<string, MemoryEntryFiles>>()
  /** 获取或创建固定子目录投影。 */
  const directory = (childName: string): Map<string, MemoryEntryFiles> => {
    const existing = directories.get(childName)
    if (existing) return existing
    const created = new Map<string, MemoryEntryFiles>()
    directories.set(childName, created)
    return created
  }
  /** 只实现本组合测试触发的 list/read/write 相对协议。 */
  const run = async (
    request: StableDirectoryNativeRequest,
    authorize: (roots: readonly StableDirectoryOpenedRoot[]) => boolean | Promise<boolean>,
  ): Promise<StableDirectoryNativeResult> => {
    const authorized = await authorize([{
      requestedPath: '/canvas', canonicalPath: '/canvas', isDirectory: true, volume: '1', fileId: '2',
    }])
    if (!authorized) throw new Error('CANVAS_DIRECTORY_SCOPE_CHANGED')
    const entries = directory(request.childName ?? '')
    if (request.mode === 'canvas-content-list') {
      return { roots: [], entries: [...entries.keys()].sort().map((name) => ({
        rootIndex: 0, name, path: '', isDirectory: true,
      })) }
    }
    const files = request.entryId ? entries.get(request.entryId) : undefined
    if (request.mode === 'canvas-content-read') {
      const content = request.fileName ? files?.[request.fileName] : undefined
      return { roots: [], entries: [], readOutcome: content === undefined
        ? { status: 'missing' }
        : { status: 'ok', content, size: Buffer.byteLength(content), volume: '1', fileId: '3' } }
    }
    if (request.mode === 'canvas-content-write' && request.entryId && request.fileName) {
      const writable = files ?? {}
      writable[request.fileName] = request.content ?? ''
      entries.set(request.entryId, writable)
      return { roots: [], entries: [], writeOutcome: { commitVisible: true, durabilityUncertain: false } }
    }
    throw new Error(`TEST_NATIVE_MODE_UNSUPPORTED:${request.mode}`)
  }
  return {
    directories,
    run,
    /** 精确删除正文文件，用于模拟已提交目录的缺失。 */
    removeFile: (childName: string, entryId: string, fileName: string): void => {
      directory(childName).get(entryId) && delete directory(childName).get(entryId)![fileName]
    },
    /** 精确替换正文文件，用于模拟可读但不再构成交付的内容损坏。 */
    replaceFile: (childName: string, entryId: string, fileName: string, content: string): void => {
      const files = directory(childName).get(entryId)
      if (!files) throw new Error('TEST_ENTRY_MISSING')
      files[fileName] = content
    },
  }
}

/** 构造真实内容、版本、文本读取、产物创建与编排登记的组合夹具。 */
function createFixture(kind: 'document' | 'webview', content: string) {
  /** 当前权威 Canvas 由受控 batch 提交，内容与版本仍使用生产 Store。 */
  let document: CanvasDocument = createEmptyCanvasDocument(target.projectId, target.canvasId, 1)
  /** 编排记录使用进程内 CAS，测试重点是 registerOutput 的真实身份读取。 */
  let record: CanvasOrchestrationRecord | null = null
  const protocol = createMemoryNativeProtocol()
  /** 文档能力只允许同一内存 Canvas 根下的固定子目录。 */
  const contentStoreDependency = {
    loadWithDirectoryCapability: () => ({
      snapshot: { document: structuredClone(document), writable: true as const, nodeIssues: [] },
      openSingleChildDirectory: (childName: string) => ({
        path: `/canvas/${childName}`, rootPath: '/canvas', assertValid: () => undefined,
        authorizeOpenedRoots: (roots: readonly StableDirectoryOpenedRoot[]) => (
          roots.length === 1 && roots[0]?.requestedPath === '/canvas'
        ),
      }),
    }),
  }
  /** 只读测试不进入 TextArtifactService 图写方法。 */
  const graph: CanvasTextArtifactGraphWriter = {
    commit: async () => { throw new Error('TEST_GRAPH_WRITE_UNEXPECTED') },
    commitLocked: async () => { throw new Error('TEST_GRAPH_WRITE_UNEXPECTED') },
    findReplayLocked: async () => null,
  }
  /** 每次调用都重建三层服务，模拟主进程重启后从同一受管目录恢复。 */
  const createTextStack = () => {
    const nodeContentStore = createCanvasNodeContentStore({
      store: contentStoreDependency,
      runStableDirectoryNative: protocol.run,
      now: () => 100,
    })
    const revisionStore = createCanvasArtifactRevisionStore({
      store: contentStoreDependency,
      nodeContentStore,
      runStableDirectoryNative: protocol.run,
      now: () => 100,
    })
    const textArtifacts = createCanvasTextArtifactService({
      documents: { load: () => ({ document: structuredClone(document), writable: true, nodeIssues: [] }) },
      revisions: revisionStore,
      graph,
    })
    return { nodeContentStore, revisionStore, textArtifacts }
  }
  const initialStack = createTextStack()
  const artifacts = createCanvasArtifactCreationService({
    documents: {
      load: () => ({ document: structuredClone(document), writable: true, nodeIssues: [] }),
      validateBatchOperations: (_canvasTarget, expectedRevision, operations) => {
        if (expectedRevision !== document.revision) throw new Error('CANVAS_REVISION_CONFLICT')
        return operations as CanvasMutation[]
      },
    },
    content: initialStack.nodeContentStore,
    batch: {
      execute: async (input) => {
        if (input.baseRevision !== document.revision) throw new Error('CANVAS_REVISION_CONFLICT')
        document = {
          ...applyCanvasMutations(document, input.operations as unknown as CanvasMutation[]),
          revision: document.revision + 1,
          updatedAt: document.updatedAt + 1,
        }
        return { document: structuredClone(document), operationId: input.sourceToolCallId }
      },
    },
  })
  /** 文本节点走真实服务；编排收口读取 specialist 配置时使用不连接模型的固定身份。 */
  const createEvidence = (textArtifacts: ReturnType<typeof createTextStack>['textArtifacts']) => ({
    textArtifacts,
    agentConfigs: { load: async () => ({ revision: 1 }) },
    agentOutputs: {
      read: async () => '',
      readAtPointer: async () => '',
    },
  }) as unknown as CanvasTaskEvidenceDependencies
  const evidence = createEvidence(initialStack.textArtifacts)
  /** 当前专业分支创建的真实正文节点和登记结果。 */
  let createdNode: CanvasNode | undefined
  let registeredRecord: CanvasOrchestrationRecord | undefined
  let service: ReturnType<typeof createCanvasOrchestrationService>
  const sourceToolCallId = `create-${kind}`
  const dependencies: CanvasOrchestrationServiceDependencies = {
    store: {
      get: () => record ? structuredClone(record) : null,
      create: (value) => { record = structuredClone(value); return structuredClone(record) },
      save: (_canvasTarget, expectedRevision, value) => {
        if (record?.revision !== expectedRevision) throw new Error('CANVAS_ORCHESTRATION_CONFLICT')
        record = structuredClone(value)
        return structuredClone(record)
      },
    },
    authorizeOwner: () => undefined,
    loadCanvas: () => structuredClone(document),
    createAgent: async (_current, step) => {
      const nodeId = step ? `specialist-${step.id}` : 'coordinator'
      const agentSessionId = `session-${nodeId}`
      document.nodes.push({ id: nodeId, kind: 'agent', title: nodeId, position: { x: 0, y: 0 }, agentSessionId })
      document.revision += 1
      return { ...target, nodeId }
    },
    executeCoordinator: async (current) => {
      const actor = { ...target, sessionId: current.coordinatorSessionId!, orchestrationId: current.id, runStartedAt: current.runStartedAt! }
      const planned = await service.updatePlan(actor, current.revision, [{
        id: 'create', title: '创建初始产物', role: '设计师', instruction: '创建可复读正文',
        dependsOn: [], inputNodeIds: [], outputNodeIds: [], agentNodeId: null,
        criteria: ['正文非空'], status: 'planned', note: '',
      }])
      await service.dispatch(actor, planned.revision, 'create')
      return { status: 'completed' }
    },
    executeSpecialist: async (_current, _step, _signal, access) => {
      const specialist = document.nodes.find((node) => node.id === access.target.nodeId)
      if (specialist?.kind !== 'agent') throw new Error('TEST_SPECIALIST_MISSING')
      const created = await artifacts.create({
        ...target, baseRevision: document.revision, artifactType: kind,
        title: kind === 'document' ? '初始文档' : '初始原型', content,
        source: { sessionId: specialist.agentSessionId, runStartedAt: access.startedAt, toolCallId: sourceToolCallId },
      })
      createdNode = document.nodes.find((node) => node.id === created.nodeId)
      registeredRecord = await service.registerOutput(access, created.nodeId, sourceToolCallId)
      return { status: 'completed' }
    },
    recoverSpecialist: async () => 'missing',
    /** 本组合夹具不运行续行校正，精确恢复与忙状态均显式为空。 */
    recoverCoordinator: async () => 'missing',
    isCoordinatorBusy: () => false,
    assertOutputOwnership: (access, nodeId, toolCallId) => {
      const specialist = document.nodes.find((node) => node.id === access.target.nodeId)
      if (specialist?.kind !== 'agent') throw new Error('TEST_SPECIALIST_MISSING')
      const resolved = artifacts.resolveCreated({
        ...target, artifactType: kind,
        source: { sessionId: specialist.agentSessionId, runStartedAt: access.startedAt, toolCallId },
      })
      if (resolved?.nodeId !== nodeId) throw new Error('CANVAS_ORCHESTRATION_OUTPUT_OWNERSHIP_INVALID')
    },
    readNodeIdentity: (canvasTarget, nodeId) => readCanvasOrchestrationNodeIdentity({
      documents: { load: () => ({ document: structuredClone(document) }) }, evidence,
    }, canvasTarget, nodeId),
    verifyDelivery: async () => false,
    onChanged: () => undefined,
    now: (() => { let value = 200; return () => ++value })(),
  }
  service = createCanvasOrchestrationService(dependencies)
  const request: CanvasOrchestrationRequest = {
    requestId: `initial-${kind}`, goal: '创建初始正文产物', intent: 'design', constraints: [], referenceNodeIds: [],
    deliverables: [{ id: 'artifact', title: '初始产物', kind, criteria: ['正文非空'] }],
  }
  return {
    protocol,
    request,
    service,
    evidence,
    createEvidence,
    createTextStack,
    getDocument: () => structuredClone(document),
    getCreatedNode: () => createdNode,
    getRegisteredRecord: () => registeredRecord,
  }
}

/** 执行一次真实专业分支创建与 registerOutput 登记。 */
async function createAndRegister(fixture: ReturnType<typeof createFixture>): Promise<void> {
  await fixture.service.delegate({ ...target, sessionId: 'owner' }, fixture.request)
}

describe('Canvas 初始正文产物证据组合', () => {
  test.each([
    ['document', '# 可复读的初始文档'],
    ['webview', '<!doctype html><html><body><main>可操作原型</main></body></html>'],
  ] as const)('Given %s 在创建时已有正文 When revision 0 登记并重启复读 Then 身份稳定且不制造 revision 1', async (kind, content) => {
    const fixture = createFixture(kind, content)

    await createAndRegister(fixture)

    const node = fixture.getCreatedNode()
    expect(node).toBeDefined()
    expect(node?.kind === 'document' || node?.kind === 'webview' ? node.contentRevision : -1).toBe(0)
    expect(fixture.getRegisteredRecord()?.steps[0]?.outputNodeIds).toContain(node!.id)
    const beforeRestart = fixture.getRegisteredRecord()!.steps[0]!.outputVersions![0]!.identity
    const restarted = fixture.createTextStack()
    const restartedEvidence = fixture.createEvidence(restarted.textArtifacts)
    const afterRestart = await readCanvasOrchestrationNodeIdentity({
      documents: { load: () => ({ document: fixture.getDocument() }) }, evidence: restartedEvidence,
    }, target, node!.id)

    expect(afterRestart).toBe(beforeRestart)
    expect(fixture.protocol.directories.get('revisions')?.size ?? 0).toBe(0)
  })

  test.each([
    ['document', ''],
    ['webview', EMPTY_WEBVIEW_HTML],
  ] as const)('Given %s 只有默认空正文 When 专业分支登记初始产物 Then 拒绝空交付', async (kind, content) => {
    const fixture = createFixture(kind, content)

    await expect(createAndRegister(fixture)).rejects.toThrow('CANVAS_ORCHESTRATION_OUTPUT_UNAVAILABLE')
    expect(fixture.getCreatedNode()).toBeDefined()
  })

  test.each([
    ['missing', undefined],
    ['corrupt', '   '],
  ] as const)('Given 已创建文档的初始正文%s When 重新解析证据 Then 不签发交付身份', async (scenario, replacement) => {
    const fixture = createFixture('document', '# 初始正文')
    await createAndRegister(fixture)
    const node = fixture.getCreatedNode()
    if (node?.kind !== 'document') throw new Error('TEST_DOCUMENT_MISSING')
    if (scenario === 'missing') fixture.protocol.removeFile('nodes', node.documentId, 'content.md')
    else fixture.protocol.replaceFile('nodes', node.documentId, 'content.md', replacement!)
    const restarted = fixture.createTextStack()
    const proof = createCanvasTaskEvidence(target.canvasId, node, 'content', null)

    if (scenario === 'missing') {
      await expect(resolveCanvasTaskEvidence(
        fixture.createEvidence(restarted.textArtifacts),
        target.projectId,
        node,
        proof,
      )).rejects.toThrow('CANVAS_CONTENT_CORRUPT')
    } else {
      expect(await resolveCanvasTaskEvidence(
        fixture.createEvidence(restarted.textArtifacts),
        target.projectId,
        node,
        proof,
      )).toBeUndefined()
    }
  })

  test('Given 已登记的初始正文 When 底层正文改变后重启复读 Then 旧版本证据身份失效', async () => {
    /** 模拟外部改动，验证编排比对的身份包含真实正文而不只取 revision 0。 */
    const fixture = createFixture('document', '# 原制作方案')
    await createAndRegister(fixture)
    const node = fixture.getCreatedNode()
    if (node?.kind !== 'document') throw new Error('TEST_DOCUMENT_MISSING')
    const registeredIdentity = fixture.getRegisteredRecord()!.steps[0]!.outputVersions![0]!.identity
    fixture.protocol.replaceFile('nodes', node.documentId, 'content.md', '# 已改变的制作方案')
    const restarted = fixture.createTextStack()
    const currentIdentity = await readCanvasOrchestrationNodeIdentity({
      documents: { load: () => ({ document: fixture.getDocument() }) },
      evidence: fixture.createEvidence(restarted.textArtifacts),
    }, target, node.id)
    expect(currentIdentity).not.toBe(registeredIdentity)
  })
})
