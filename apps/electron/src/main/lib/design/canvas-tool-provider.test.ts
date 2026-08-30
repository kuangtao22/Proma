import { describe, expect, test } from 'bun:test'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { AgentCanvasBinding, CanvasDocument, CanvasMutation, CanvasNodeReference, CanvasSessionMeta } from '@proma/shared'
import { createEmptyCanvasDocument } from '@proma/shared'
import { CANVAS_TOOL_NAMES, createCanvasToolRun, type CanvasToolProviderDependencies, type CanvasToolRunContext } from './canvas-tool-provider'

const target = { projectId: 'project-1', canvasId: 'canvas-1' }
const reference: CanvasNodeReference = { ...target, nodeId: 'doc-1', nodeType: 'document', nodeRevision: 3, title: '需求' }

/** 调用指定 Pi custom tool。 */
async function executeTool(tools: ToolDefinition[], name: string, args: Record<string, unknown>, toolCallId = 'tool-call-1') {
  const tool = tools.find((candidate) => candidate.name === name)
  if (!tool) throw new Error(`工具不存在: ${name}`)
  return tool.execute(toolCallId, args as never, undefined as never, undefined as never, undefined as never)
}

/** 构造可观察写入、执行与全项目扫描的窄依赖。 */
function createFixture(options: {
  conflictOnce?: boolean
  conflictAlways?: boolean
  noDefaultCanvas?: boolean
  createCanvasError?: Error
} = {}) {
  let document: CanvasDocument = {
    ...createEmptyCanvasDocument(target.projectId, target.canvasId, 1), revision: 3,
    nodes: [
      { id: 'doc-1', kind: 'document', title: '需求', position: { x: 0, y: 0 }, documentId: 'content-1', contentRevision: 2 },
      { id: 'image-1', kind: 'image', title: '主视觉', position: { x: 100, y: 0 }, imageModuleId: 'image-content-1' },
    ],
    edges: [{ id: 'edge-1', sourceNodeId: 'doc-1', sourcePort: 'output', targetNodeId: 'image-1', targetPort: 'input' }],
  }
  const linkedCanvasIds = options.noDefaultCanvas ? [] : ['canvas-1', 'canvas-2']
  const createdSessions = new Map<string, CanvasSessionMeta>()
  let defaultCanvasId = options.noDefaultCanvas ? undefined : 'canvas-1'
  let lastActiveCanvasId = options.noDefaultCanvas ? undefined : 'canvas-2'
  let createCalls = 0
  let linkCalls = 0
  const batchInputs: Array<{ baseRevision: number; operations: unknown[]; sourceToolCallId: string }> = []
  const runInputs: string[][] = []
  const runToolCallIds: string[] = []
  let listCalls = 0
  /** 返回当前 fixture 的隔离关联事实。 */
  const getBinding = (): AgentCanvasBinding => ({
    projectId: target.projectId, sessionId: 'session-1', linkedCanvasIds: [...linkedCanvasIds],
    ...(defaultCanvasId ? { defaultCanvasId } : {}),
    ...(lastActiveCanvasId ? { lastActiveCanvasId } : {}), updatedAt: 1,
  })
  /** 复核测试 Canvas 是否仍属于目标项目。 */
  const requireNative = (projectId: string, canvasId: string): CanvasSessionMeta => {
    const created = createdSessions.get(canvasId)
    if (created) return created
    if (projectId !== target.projectId || !['canvas-1', 'canvas-2', 'created-canvas'].includes(canvasId)) {
      throw new Error('Canvas 会话不存在')
    }
    return { id: canvasId, projectId, title: canvasId, archived: false, createdAt: 1, updatedAt: 1 }
  }
  /** 模拟唯一 facade 的关联写入，并记录真实 mutation 次数。 */
  const link = (canvasId: string, makeDefault: boolean): AgentCanvasBinding => {
    linkCalls += 1
    if (!linkedCanvasIds.includes(canvasId)) linkedCanvasIds.push(canvasId)
    if (makeDefault) defaultCanvasId = canvasId
    lastActiveCanvasId = canvasId
    return getBinding()
  }
  const dependencies: CanvasToolProviderDependencies = {
    access: {
      authorizeRead: () => undefined,
      getBinding: () => getBinding(),
      requireLinkedCanvas: (_context, canvasId) => {
        const binding = getBinding()
        if (!binding.linkedCanvasIds.includes(canvasId)) throw new Error('CANVAS_ACCESS_DENIED')
        requireNative(target.projectId, canvasId)
        return binding
      },
      runWrite: (_context, effect) => effect(),
      createAndLink: (_context, input) => {
        createCalls += 1
        if (options.createCanvasError) throw options.createCanvasError
        const existing = createdSessions.get(input.canvasId)
        const session = existing ?? {
          id: input.canvasId, projectId: target.projectId, title: input.title ?? '新 Canvas',
          archived: false, createdAt: 1, updatedAt: 1,
        }
        if (!existing) createdSessions.set(input.canvasId, session)
        const current = getBinding()
        const alreadyLinked = current.linkedCanvasIds.includes(session.id)
        const binding = alreadyLinked && (!input.makeDefault || current.defaultCanvasId === session.id)
          ? current
          : link(session.id, input.makeDefault)
        return { session, binding }
      },
      link: (_context, canvasId, makeDefault) => {
        requireNative(target.projectId, canvasId)
        return link(canvasId, makeDefault)
      },
      unlink: (_context, canvasId) => {
        const nextCanvasIds = linkedCanvasIds.filter((id) => id !== canvasId)
        return {
          projectId: target.projectId, sessionId: 'session-1', linkedCanvasIds: nextCanvasIds,
          defaultCanvasId: 'canvas-1', lastActiveCanvasId: 'canvas-1', updatedAt: 2,
        }
      },
      setDefault: (_context, canvasId) => ({
        projectId: target.projectId, sessionId: 'session-1', linkedCanvasIds: [...linkedCanvasIds],
        defaultCanvasId: canvasId, lastActiveCanvasId: canvasId, updatedAt: 2,
      }),
    },
    documents: {
      load: () => ({ document: structuredClone(document), writable: true, nodeIssues: [] }),
      validateBatchOperations: (_target, expectedRevision, operations) => {
        if (expectedRevision !== document.revision) throw new Error('CANVAS_REVISION_CONFLICT')
        return structuredClone(operations) as CanvasMutation[]
      },
    },
    readNodeContent: async (_target, node) => node.kind === 'document' ? 'A'.repeat(40_000) : '',
    batch: { execute: async (input) => {
      batchInputs.push({ baseRevision: input.baseRevision, operations: input.operations, sourceToolCallId: input.sourceToolCallId })
      if (options.conflictAlways || (options.conflictOnce && batchInputs.length === 1)) {
        document = { ...document, revision: 4 }
        throw new Error('CANVAS_REVISION_CONFLICT')
      }
      document = { ...document, revision: input.baseRevision + 1 }
      return { document, operationId: `operation-${batchInputs.length}` }
    } },
    runNodes: async (_context, _target, nodes, toolCallId) => {
      runInputs.push(nodes.map((node) => node.id))
      runToolCallIds.push(toolCallId)
      return nodes.map((node) => node.kind === 'image'
        ? { nodeId: node.id, status: 'started' as const, taskId: `task-${node.id}` }
        : { nodeId: node.id, status: 'unsupported' as const, message: 'CANVAS_NODE_EXECUTOR_UNAVAILABLE' })
    },
  }
  const context: CanvasToolRunContext = {
    projectId: target.projectId, sessionId: 'session-1', runStartedAt: 99,
    explicitReferences: [reference], permissionCeiling: 'execute',
  }
  return {
    dependencies, context, batchInputs, runInputs, runToolCallIds,
    getListCalls: () => listCalls,
    getCreateCalls: () => createCalls,
    getLinkCalls: () => linkCalls,
  }
}

describe('普通 Agent Canvas Tool Provider', () => {
  test('Given 普通分析运行 When 获取上下文 Then 注入五工具且不扫描项目全部画布', async () => {
    const fixture = createFixture()
    const run = createCanvasToolRun(fixture.dependencies, fixture.context)
    expect(run.piCustomTools.map((tool) => tool.name)).toEqual([...CANVAS_TOOL_NAMES])
    expect(run.allowedToolNames).toEqual([...CANVAS_TOOL_NAMES])
    expect(run.allowedToolNamesMode).toBe('extend')
    expect(run.singleApprovalToolNames).toEqual(['canvas_run_nodes'])
    expect(run.systemPromptAppend).toContain('不要按“首页”或“设计”等关键词硬编码')
    const result = await executeTool(run.piCustomTools, 'canvas_get_context', {})
    expect(result.details).toMatchObject({ defaultCanvasId: 'canvas-1', activeCanvasId: 'canvas-2' })
    expect(JSON.stringify(result.details)).toContain('doc-1')
    expect(fixture.getListCalls()).toBe(0)
  })

  test('Given 只读分析 When 读取节点 Then 返回必要邻接、限制总字符并拒绝未关联画布', async () => {
    const fixture = createFixture()
    const run = createCanvasToolRun(fixture.dependencies, fixture.context)
    const result = await executeTool(run.piCustomTools, 'canvas_read', { canvasId: 'canvas-1', nodeIds: ['doc-1'], includeNeighbors: true })
    expect(result.details).toMatchObject({ canvasId: 'canvas-1', revision: 3, truncated: true })
    expect(JSON.stringify(result.details).length).toBeLessThan(40_000)
    await expect(executeTool(run.piCustomTools, 'canvas_read', { canvasId: 'foreign-canvas', nodeIds: ['doc-1'] })).rejects.toThrow('CANVAS_ACCESS_DENIED')
  })

  test('Given 高连接度节点 When 读取邻接 Then 节点和边共同受 32 节点预算约束', async () => {
    const fixture = createFixture()
    /** 构造一个中心节点连接 40 个邻居的权威文档。 */
    const neighborNodes = Array.from({ length: 40 }, (_, index) => ({
      id: `image-${index}`, kind: 'image' as const, title: `图片 ${index}`,
      position: { x: index, y: 0 }, imageModuleId: `module-${index}`,
    }))
    fixture.dependencies.documents.load = () => ({
      document: {
        ...createEmptyCanvasDocument(target.projectId, target.canvasId, 1), revision: 3,
        nodes: [
          { id: 'doc-1', kind: 'document', title: '中心', position: { x: 0, y: 0 }, documentId: 'content-1', contentRevision: 1 },
          ...neighborNodes,
        ],
        edges: neighborNodes.map((node, index) => ({
          id: `edge-${index}`, sourceNodeId: 'doc-1', sourcePort: 'output', targetNodeId: node.id, targetPort: 'input',
        })),
      },
      writable: true,
      nodeIssues: [],
    })
    const run = createCanvasToolRun(fixture.dependencies, fixture.context)
    const result = await executeTool(run.piCustomTools, 'canvas_read', {
      canvasId: 'canvas-1', nodeIds: ['doc-1'], includeNeighbors: true,
    })
    const details = result.details as { nodes: Array<{ node: { id: string } }>; edges: Array<{ sourceNodeId: string; targetNodeId: string }> }
    const returnedNodeIds = new Set(details.nodes.map((entry) => entry.node.id))
    expect(details.nodes.length).toBeLessThanOrEqual(32)
    expect(details.edges.every((edge) => returnedNodeIds.has(edge.sourceNodeId) && returnedNodeIds.has(edge.targetNodeId))).toBe(true)
  })

  test('Given 模型自报 explicitSelection When link 任意同项目 Canvas Then 不得扩大权威访问集合', async () => {
    const fixture = createFixture()
    const run = createCanvasToolRun(fixture.dependencies, { ...fixture.context, permissionCeiling: 'plan' })
    await expect(executeTool(run.piCustomTools, 'canvas_manage', { action: 'link', canvasId: 'created-canvas' })).rejects.toThrow('CANVAS_EXPLICIT_SELECTION_REQUIRED')
    await expect(executeTool(run.piCustomTools, 'canvas_manage', {
      action: 'link', canvasId: 'created-canvas', explicitSelection: true,
    })).rejects.toThrow('CANVAS_EXPLICIT_SELECTION_REQUIRED')
    const existing = await executeTool(run.piCustomTools, 'canvas_manage', { action: 'link', canvasId: 'canvas-1' })
    expect(existing.details).toMatchObject({ action: 'link', canvasId: 'canvas-1' })
  })

  test('Given execute Agent 无默认画布 When 同一 create tool call 跨 Provider 重放 Then 持久复用同一 Canvas 且只绑定一次', async () => {
    const fixture = createFixture({ noDefaultCanvas: true })
    const firstRun = createCanvasToolRun(fixture.dependencies, fixture.context)
    const first = await executeTool(firstRun.piCustomTools, 'canvas_manage', {
      action: 'create', title: '执行画布', makeDefault: true,
    }, 'tool-create-1')
    const replayRun = createCanvasToolRun(fixture.dependencies, fixture.context)
    const replay = await executeTool(replayRun.piCustomTools, 'canvas_manage', {
      action: 'create', title: '执行画布', makeDefault: true,
    }, 'tool-create-1')

    expect((first.details as { canvasId: string }).canvasId).toBe((replay.details as { canvasId: string }).canvasId)
    expect((first.details as { canvasId: string }).canvasId).toMatch(/^agent-canvas-[0-9a-f]{64}$/)
    expect(fixture.getCreateCalls()).toBe(2)
    expect(fixture.getLinkCalls()).toBe(1)
    expect(fixture.getListCalls()).toBe(0)
  })

  test('Given plan 或项目路径授权失效 When 创建 Canvas Then 禁止持久副作用且 fresh call fail closed', async () => {
    const planFixture = createFixture({ noDefaultCanvas: true })
    const plan = createCanvasToolRun(planFixture.dependencies, {
      ...planFixture.context, permissionCeiling: 'plan',
    })
    await expect(executeTool(plan.piCustomTools, 'canvas_manage', { action: 'create' }, 'tool-plan-create'))
      .rejects.toThrow('CANVAS_EXECUTE_INTENT_REQUIRED')
    expect(planFixture.getCreateCalls()).toBe(0)
    expect(planFixture.getLinkCalls()).toBe(0)

    const revoked = createFixture({ noDefaultCanvas: true, createCanvasError: new Error('项目路径不可访问') })
    for (const toolCallId of ['tool-revoked-1', 'tool-revoked-2']) {
      const run = createCanvasToolRun(revoked.dependencies, revoked.context)
      await expect(executeTool(run.piCustomTools, 'canvas_manage', { action: 'create' }, toolCallId))
        .rejects.toThrow('项目路径不可访问')
    }
    expect(revoked.getCreateCalls()).toBe(2)
    expect(revoked.getLinkCalls()).toBe(0)
  })

  test('Given 项目授权在运行后撤销 When 五工具 fresh execute Then 全部在 Store、batch 与 run 前拒绝', async () => {
    const cases: Array<{ name: string; args: Record<string, unknown> }> = [
      { name: 'canvas_get_context', args: {} },
      { name: 'canvas_manage', args: { action: 'create' } },
      { name: 'canvas_read', args: { canvasId: 'canvas-1', nodeIds: ['doc-1'] } },
      { name: 'canvas_apply_changes', args: { canvasId: 'canvas-1', baseRevision: 3, operations: [{ type: 'set-viewport', viewport: { x: 0, y: 0, zoom: 1 } }] } },
      { name: 'canvas_run_nodes', args: { canvasId: 'canvas-1', nodeIds: ['image-1'] } },
    ]
    for (const entry of cases) {
      const fixture = createFixture()
      const dependencies = {
        ...fixture.dependencies,
        access: {
          authorizeRead: () => { throw new Error('PROJECT_ACCESS_REVOKED') },
          getBinding: () => { throw new Error('STORE_MUST_NOT_RUN') },
          requireLinkedCanvas: () => { throw new Error('STORE_MUST_NOT_RUN') },
          runWrite: () => { throw new Error('WRITE_MUST_NOT_RUN') },
          createAndLink: () => { throw new Error('STORE_MUST_NOT_RUN') },
          link: () => { throw new Error('STORE_MUST_NOT_RUN') },
          unlink: () => { throw new Error('STORE_MUST_NOT_RUN') },
          setDefault: () => { throw new Error('STORE_MUST_NOT_RUN') },
        },
      } as CanvasToolProviderDependencies
      const run = createCanvasToolRun(dependencies, fixture.context)
      await expect(executeTool(run.piCustomTools, entry.name, entry.args, `revoked-${entry.name}`))
        .rejects.toThrow('PROJECT_ACCESS_REVOKED')
      expect(fixture.batchInputs).toEqual([])
      expect(fixture.runInputs).toEqual([])
      expect(fixture.getCreateCalls()).toBe(0)
    }
  })

  test('Given execute-capable 与 plan 权限上限 When apply_changes Then host 不解析消息且 plan 只允许新增 idle 结构', async () => {
    const fixture = createFixture()
    const executeCapable = createCanvasToolRun(fixture.dependencies, fixture.context)
    await expect(executeTool(executeCapable.piCustomTools, 'canvas_apply_changes', {
      canvasId: 'canvas-1', baseRevision: 3,
      operations: [{ type: 'set-viewport', viewport: { x: 1, y: 2, zoom: 1 } }],
    })).resolves.toMatchObject({ details: { revision: 4 } })

    const planFixture = createFixture()
    const plan = createCanvasToolRun(planFixture.dependencies, { ...planFixture.context, permissionCeiling: 'plan' })
    await expect(executeTool(plan.piCustomTools, 'canvas_apply_changes', {
      canvasId: 'canvas-1', baseRevision: 3,
      operations: [{ type: 'upsert-nodes', nodes: [{
        id: 'doc-new', kind: 'document', title: '计划', position: { x: 0, y: 0 }, documentId: 'content-new', contentRevision: 0,
      }] }],
    })).resolves.toMatchObject({ details: { revision: 4 } })
    await expect(executeTool(plan.piCustomTools, 'canvas_apply_changes', {
      canvasId: 'canvas-1', baseRevision: 4,
      operations: [{ type: 'set-viewport', viewport: { x: 1, y: 2, zoom: 1 } }],
    })).rejects.toThrow('CANVAS_EXECUTE_INTENT_REQUIRED')
  })

  test('Given 删除意图模糊或明确 When apply Then 模糊拒绝，明确返回 revision/task identity', async () => {
    const fixture = createFixture()
    const run = createCanvasToolRun(fixture.dependencies, fixture.context)
    const args = { canvasId: 'canvas-1', baseRevision: 3, operations: [{ type: 'remove-nodes', nodeIds: ['doc-1'] }] }
    await expect(executeTool(run.piCustomTools, 'canvas_apply_changes', args)).rejects.toThrow('CANVAS_DESTRUCTIVE_INTENT_REQUIRED')
    const result = await executeTool(run.piCustomTools, 'canvas_apply_changes', { ...args, destructiveIntent: 'explicit' }, 'task-tool-1')
    expect(fixture.batchInputs).toHaveLength(1)
    expect(result.details).toMatchObject({ revision: 4, operationId: 'operation-1', sourceToolCallId: 'task-tool-1' })
  })

  test('Given 首次 revision 冲突 When apply Then 权威重读后只重试一次', async () => {
    const fixture = createFixture({ conflictOnce: true })
    const run = createCanvasToolRun(fixture.dependencies, fixture.context)
    const result = await executeTool(run.piCustomTools, 'canvas_apply_changes', { canvasId: 'canvas-1', baseRevision: 3, operations: [{ type: 'set-viewport', viewport: { x: 1, y: 2, zoom: 1 } }] }, 'task-tool-conflict')
    expect(fixture.batchInputs.map((input) => input.baseRevision)).toEqual([3, 4])
    expect(result.details).toMatchObject({ revision: 5, sourceToolCallId: 'task-tool-conflict-retry' })
  })

  test('Given 最大长度 tool call ID When revision 冲突 Then 重试身份仍满足共享协议上限', async () => {
    const fixture = createFixture({ conflictOnce: true })
    const run = createCanvasToolRun(fixture.dependencies, fixture.context)
    const result = await executeTool(run.piCustomTools, 'canvas_apply_changes', {
      canvasId: 'canvas-1', baseRevision: 3,
      operations: [{ type: 'set-viewport', viewport: { x: 1, y: 2, zoom: 1 } }],
    }, 't'.repeat(128))
    expect((result.details as { sourceToolCallId: string }).sourceToolCallId.length).toBeLessThanOrEqual(128)
  })

  test('Given 两次 revision 冲突 When apply Then 恰好尝试两次并原样抛出第二次冲突', async () => {
    const fixture = createFixture({ conflictAlways: true })
    const run = createCanvasToolRun(fixture.dependencies, fixture.context)
    await expect(executeTool(run.piCustomTools, 'canvas_apply_changes', {
      canvasId: 'canvas-1', baseRevision: 3,
      operations: [{ type: 'set-viewport', viewport: { x: 1, y: 2, zoom: 1 } }],
    }, 'task-tool-conflict-twice')).rejects.toThrow('CANVAS_REVISION_CONFLICT')
    expect(fixture.batchInputs).toHaveLength(2)
  })

  test('Given upsert 覆盖现有节点 When apply Then 必须声明明确破坏性意图', async () => {
    const fixture = createFixture()
    const run = createCanvasToolRun(fixture.dependencies, fixture.context)
    const operations = [{
      type: 'upsert-nodes',
      nodes: [{ id: 'doc-1', kind: 'document', title: '覆盖需求', position: { x: 0, y: 0 }, documentId: 'content-1', contentRevision: 2 }],
    }]
    await expect(executeTool(run.piCustomTools, 'canvas_apply_changes', {
      canvasId: 'canvas-1', baseRevision: 3, operations,
    })).rejects.toThrow('CANVAS_DESTRUCTIVE_INTENT_REQUIRED')
    await expect(executeTool(run.piCustomTools, 'canvas_apply_changes', {
      canvasId: 'canvas-1', baseRevision: 3, operations, destructiveIntent: 'explicit',
    })).resolves.toMatchObject({ details: { revision: 4 } })
  })

  test('Given upsert 覆盖现有 edge When apply Then 必须声明明确破坏性意图', async () => {
    const fixture = createFixture()
    const run = createCanvasToolRun(fixture.dependencies, fixture.context)
    const operations = [{
      type: 'upsert-edges',
      edges: [{ id: 'edge-1', sourceNodeId: 'image-1', sourcePort: 'output', targetNodeId: 'doc-1', targetPort: 'input' }],
    }]
    await expect(executeTool(run.piCustomTools, 'canvas_apply_changes', {
      canvasId: 'canvas-1', baseRevision: 3, operations,
    })).rejects.toThrow('CANVAS_DESTRUCTIVE_INTENT_REQUIRED')
    await expect(executeTool(run.piCustomTools, 'canvas_apply_changes', {
      canvasId: 'canvas-1', baseRevision: 3, operations, destructiveIntent: 'explicit',
    })).resolves.toMatchObject({ details: { revision: 4 } })
  })

  test('Given plan 与 execute-capable 权限上限 When run_nodes Then 只有 execute-capable 调用执行器并传递完整幂等身份', async () => {
    const fixture = createFixture()
    const plan = createCanvasToolRun(fixture.dependencies, { ...fixture.context, permissionCeiling: 'plan' })
    await expect(executeTool(plan.piCustomTools, 'canvas_run_nodes', { canvasId: 'canvas-1', nodeIds: ['image-1'] })).rejects.toThrow('CANVAS_RUN_REQUIRES_EXPLICIT_EXECUTE')
    const executeCapable = createCanvasToolRun(fixture.dependencies, fixture.context)
    const result = await executeTool(executeCapable.piCustomTools, 'canvas_run_nodes', { canvasId: 'canvas-1', nodeIds: ['image-1'] }, 'tool-run-1')
    expect(fixture.runInputs).toEqual([['image-1']])
    expect(fixture.runToolCallIds).toEqual(['tool-run-1'])
    expect(result.details).toMatchObject({ revision: 3, tasks: [{ nodeId: 'image-1', taskId: 'task-image-1' }] })
  })

  test('Given plan 权限上限 When 声明 destructiveIntent Then 仍不得覆盖已有结构', async () => {
    const fixture = createFixture()
    const plan = createCanvasToolRun(fixture.dependencies, { ...fixture.context, permissionCeiling: 'plan' })
    await expect(executeTool(plan.piCustomTools, 'canvas_apply_changes', {
      canvasId: 'canvas-1', baseRevision: 3,
      operations: [{
        type: 'upsert-nodes',
        nodes: [{ id: 'doc-1', kind: 'document', title: '覆盖', position: { x: 0, y: 0 }, documentId: 'content-1', contentRevision: 2 }],
      }],
      destructiveIntent: 'explicit',
    })).rejects.toThrow('CANVAS_EXECUTE_INTENT_REQUIRED')
  })

  test('Given 重复节点与后置无效节点 When run_nodes Then 去重执行且任一无效时零副作用', async () => {
    const duplicateFixture = createFixture()
    const duplicateRun = createCanvasToolRun(duplicateFixture.dependencies, duplicateFixture.context)
    await executeTool(duplicateRun.piCustomTools, 'canvas_run_nodes', {
      canvasId: 'canvas-1', nodeIds: ['image-1', 'image-1'],
    })
    expect(duplicateFixture.runInputs).toEqual([['image-1']])

    const invalidFixture = createFixture()
    const invalidRun = createCanvasToolRun(invalidFixture.dependencies, invalidFixture.context)
    await expect(executeTool(invalidRun.piCustomTools, 'canvas_run_nodes', {
      canvasId: 'canvas-1', nodeIds: ['image-1', 'missing-later'],
    })).rejects.toThrow('CANVAS_NODE_NOT_FOUND')
    expect(invalidFixture.runInputs).toEqual([])
  })

  test('Given 多个有效节点 When run_nodes Then 单次交给批量运行边界且保留顺序', async () => {
    const fixture = createFixture()
    fixture.dependencies.documents.load = () => ({
      document: {
        ...createEmptyCanvasDocument(target.projectId, target.canvasId, 1), revision: 3,
        nodes: [
          { id: 'image-1', kind: 'image', title: '首图', position: { x: 0, y: 0 }, imageModuleId: 'module-1' },
          { id: 'image-2', kind: 'image', title: '次图', position: { x: 100, y: 0 }, imageModuleId: 'module-2' },
        ],
      },
      writable: true,
      nodeIssues: [],
    })
    const run = createCanvasToolRun(fixture.dependencies, fixture.context)

    await expect(executeTool(run.piCustomTools, 'canvas_run_nodes', {
      canvasId: 'canvas-1', nodeIds: ['image-1', 'image-2'],
    }, 'tool-batch-1')).resolves.toMatchObject({
      details: { tasks: [{ nodeId: 'image-1' }, { nodeId: 'image-2' }] },
    })
    expect(fixture.runInputs).toEqual([['image-1', 'image-2']])
    expect(fixture.runToolCallIds).toEqual(['tool-batch-1'])
  })

  test('Given webview 暂无执行器 When execute run_nodes Then 返回稳定 unsupported', async () => {
    const fixture = createFixture()
    fixture.dependencies.documents.load = () => ({
      document: {
        ...createEmptyCanvasDocument(target.projectId, target.canvasId, 1), revision: 3,
        nodes: [{ id: 'webview-1', kind: 'webview', title: '原型', position: { x: 0, y: 0 }, prototypeId: 'prototype-1', contentRevision: 1 }],
      },
      writable: true,
      nodeIssues: [],
    })
    const run = createCanvasToolRun(fixture.dependencies, fixture.context)
    const result = await executeTool(run.piCustomTools, 'canvas_run_nodes', { canvasId: 'canvas-1', nodeIds: ['webview-1'] })
    expect(result.details).toMatchObject({
      tasks: [{ nodeId: 'webview-1', status: 'unsupported', message: 'CANVAS_NODE_EXECUTOR_UNAVAILABLE' }],
    })
  })
})
