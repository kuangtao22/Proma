import { describe, expect, test } from 'bun:test'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { AgentCanvasBinding, CanvasDocument, CanvasMutation, CanvasNodeReference, CanvasRunNodesBatchSummary, CanvasSessionMeta, DesignJobRecord } from '@proma/shared'
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
  runBatch?: CanvasRunNodesBatchSummary
} = {}) {
  let document: CanvasDocument = {
    ...createEmptyCanvasDocument(target.projectId, target.canvasId, 1), revision: 3,
    nodes: [
      { id: 'doc-1', kind: 'document', title: '需求', position: { x: 0, y: 0 }, documentId: 'content-1', contentRevision: 2 },
      { id: 'web-1', kind: 'webview', title: '原型', position: { x: 50, y: 0 }, prototypeId: 'prototype-1', contentRevision: 1, devicePreset: 'desktop' },
      { id: 'image-1', kind: 'image', title: '主视觉', position: { x: 100, y: 0 }, imageModuleId: 'image-content-1', adoptedAssetId: 'asset-1' },
    ],
    edges: [{ id: 'edge-1', sourceNodeId: 'doc-1', sourcePort: 'output', targetNodeId: 'image-1', targetPort: 'input', relation: 'reference' }],
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
  const artifactInputs: Array<Record<string, unknown>> = []
  /** 文本产物更新调用记录。 */
  const textUpdateInputs: Array<Record<string, unknown>> = []
  /** 图片配置保存调用记录。 */
  const imageSaveInputs: Array<Record<string, unknown>> = []
  let listCalls = 0
  let thumbnailReadCalls = 0
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
    artifacts: {
      create: async (input) => {
        artifactInputs.push(structuredClone(input) as unknown as Record<string, unknown>)
        return {
          canvasId: input.canvasId,
          nodeId: 'artifact-created',
          revision: 4,
          artifactType: input.artifactType,
          sourceToolCallId: input.source.toolCallId,
        }
      },
    },
    textArtifacts: {
      read: async (input) => ({
        target: input,
        revision: {
          kind: input.kind, contentId: input.contentId, revision: input.contentRevision,
          parentRevision: input.contentRevision - 1, contentHash: 'a'.repeat(64),
          createdBy: { type: 'user' as const }, createdAt: 1,
        },
        content: input.kind === 'document' ? '# 需求正文' : '<main>旧版</main>',
      }),
      listVersions: async (input) => [1, 2].map((revision) => ({
        kind: input.kind, contentId: input.contentId, revision, parentRevision: revision - 1,
        contentHash: 'a'.repeat(64), createdBy: { type: 'user' as const }, createdAt: revision,
      })),
      update: async (input) => {
        textUpdateInputs.push(structuredClone(input) as unknown as Record<string, unknown>)
        /** 更新后的文本节点保持同一节点 ID。 */
        const node = document.nodes.find((candidate) => candidate.id === input.nodeId)!
        const nextNode = { ...node, contentRevision: input.expectedContentRevision + 1 }
        document = {
          ...document,
          revision: document.revision + 1,
          nodes: document.nodes.map((candidate) => candidate.id === node.id ? nextNode : candidate) as CanvasDocument['nodes'],
        }
        return {
          snapshot: { document: structuredClone(document), writable: true as const, nodeIssues: [] },
          artifact: {
            target: { ...input, contentRevision: input.expectedContentRevision + 1 },
            revision: {
              kind: input.kind, contentId: input.contentId,
              revision: input.expectedContentRevision + 1,
              parentRevision: input.expectedContentRevision,
              contentHash: 'b'.repeat(64), createdBy: { type: 'agent' as const, sessionId: 'session-1', toolCallId: 'tool-update-1' }, createdAt: 2,
            },
            content: input.content,
          },
        }
      },
    },
    images: {
      loadConfig: async () => ({
        schemaVersion: 2 as const, kind: 'image' as const, contentId: 'image-content-1', revision: 4,
        createdAt: 1, updatedAt: 2, prompt: '旧提示词', selectedModelProfileId: 'model-1',
        aspectRatio: '16:9' as const, imageSize: '2K' as const, contextMode: 'project' as const,
        adoptedAssetId: 'asset-1',
      }),
      load: async () => ({
        target: { ...target, nodeId: 'image-1', imageModuleId: 'image-content-1' },
        mediaLeaseId: 'lease-1',
        config: {
          schemaVersion: 2 as const, kind: 'image' as const, contentId: 'image-content-1', revision: 4,
          createdAt: 1, updatedAt: 2, prompt: '旧提示词', selectedModelProfileId: 'model-1',
          aspectRatio: '16:9' as const, imageSize: '2K' as const, contextMode: 'project' as const,
          adoptedAssetId: 'asset-1',
        },
        jobs: [], assets: [], assetBaseUrl: 'proma://asset/', thumbnailBaseUrl: 'proma://thumb/',
      }),
      save: async (input) => {
        imageSaveInputs.push(structuredClone(input) as unknown as Record<string, unknown>)
        return {
          schemaVersion: 2 as const, kind: 'image' as const, contentId: input.imageModuleId,
          revision: input.expectedConfigRevision + 1, createdAt: 1, updatedAt: 3,
          prompt: input.prompt, selectedModelProfileId: input.selectedModelProfileId,
          aspectRatio: input.aspectRatio, imageSize: input.imageSize, contextMode: input.contextMode,
          adoptedAssetId: 'asset-1',
        }
      },
      readThumbnail: async () => {
        thumbnailReadCalls += 1
        return {
          bytes: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lwqSmQAAAABJRU5ErkJggg==', 'base64'),
          mediaType: 'image/png' as const,
        }
      },
    },
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
      return {
        tasks: nodes.map((node) => node.kind === 'image'
          ? { nodeId: node.id, status: 'started' as const, taskId: `task-${node.id}` }
          : { nodeId: node.id, status: 'idle' as const }),
        ...(options.runBatch ? { batch: options.runBatch } : {}),
      }
    },
  }
  const context: CanvasToolRunContext = {
    projectId: target.projectId, sessionId: 'session-1', runStartedAt: 99,
    explicitReferences: [reference], permissionCeiling: 'execute',
  }
  return {
    dependencies, context, batchInputs, runInputs, runToolCallIds, artifactInputs,
    textUpdateInputs, imageSaveInputs,
    getListCalls: () => listCalls,
    getThumbnailReadCalls: () => thumbnailReadCalls,
    getCreateCalls: () => createCalls,
    getLinkCalls: () => linkCalls,
  }
}

describe('普通 Agent Canvas Tool Provider', () => {
  test('Given 普通分析运行 When 获取上下文 Then 注入九工具、Canvas Skill 路由与硬边界且不扫描全部画布', async () => {
    const fixture = createFixture()
    const run = createCanvasToolRun(fixture.dependencies, fixture.context)
    expect(run.piCustomTools.map((tool) => tool.name)).toEqual([
      'canvas_get_context',
      'canvas_manage',
      'canvas_list_nodes',
      'canvas_inspect_images',
      'canvas_read',
      'canvas_apply_changes',
      'canvas_create_artifact',
      'canvas_update_artifact',
      'canvas_run_nodes',
    ])
    expect(run.allowedToolNames).toEqual([...CANVAS_TOOL_NAMES])
    expect(run.allowedToolNamesMode).toBe('extend')
    expect(run.singleApprovalToolNames).toEqual(['canvas_run_nodes'])
    expect(run.systemPromptAppend).toContain('不要按“首页”或“设计”等关键词硬编码')
    expect(run.systemPromptAppend).toContain('先读取并遵循 `canvas-production` Skill')
    expect(run.systemPromptAppend).toContain('Skill 不可用')
    expect(run.systemPromptAppend).toContain('只询问一次')
    expect(run.systemPromptAppend).toContain('不要要求用户另建已经存在的画布')
    expect(run.systemPromptAppend).toContain('WebView 创建成功后即可直接预览')
    expect(run.systemPromptAppend).toContain('不得为 WebView 调用 canvas_run_nodes')
    expect(run.systemPromptAppend).toContain('图片仅在用户明确要求立即生成时')
    expect(run.systemPromptAppend).toContain('destructiveIntent=explicit')
    expect(run.piCustomTools.find((tool) => tool.name === 'canvas_create_artifact')?.description)
      .toContain('文档')
    const runNodesDescription = run.piCustomTools.find((tool) => tool.name === 'canvas_run_nodes')?.description ?? ''
    expect(runNodesDescription).toContain('生图节点')
    expect(runNodesDescription).toContain('模型费用')
    expect(runNodesDescription).not.toContain('WebView')
    const result = await executeTool(run.piCustomTools, 'canvas_get_context', {})
    expect(result.details).toMatchObject({ defaultCanvasId: 'canvas-1', activeCanvasId: 'canvas-2' })
    expect(JSON.stringify(result.details)).toContain('doc-1')
    expect(fixture.getListCalls()).toBe(0)
  })

  test('Given 已关联画布含多种节点 When 分页枚举图片 Then 只返回图片摘要且不泄露素材身份', async () => {
    const fixture = createFixture()
    const run = createCanvasToolRun(fixture.dependencies, fixture.context)

    const result = await executeTool(run.piCustomTools, 'canvas_list_nodes', {
      canvasId: 'canvas-1', kind: 'image', limit: 1,
    })

    expect(result.details).toMatchObject({
      canvasId: 'canvas-1', revision: 3, hasMore: false,
      nodes: [{ nodeId: 'image-1', kind: 'image', title: '主视觉', configRevision: 4, hasAdoptedAsset: true }],
    })
    expect(JSON.stringify(result.details)).not.toContain('asset-1')
  })

  test('Given 有当前采用图片 When 按权威 revision 检查 Then 返回节点身份文本和紧邻图片块', async () => {
    const fixture = createFixture()
    const run = createCanvasToolRun(fixture.dependencies, fixture.context)

    const result = await executeTool(run.piCustomTools, 'canvas_inspect_images', {
      canvasId: 'canvas-1', nodeIds: ['image-1', 'image-1'], expectedRevision: 3,
    })

    expect(result.content.map((block) => block.type)).toEqual(['text', 'image'])
    expect(result.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('image-1') })
    expect(result.details).toMatchObject({
      canvasId: 'canvas-1', revision: 3,
      inspections: [{ nodeId: 'image-1', title: '主视觉', status: 'ready' }],
    })
    expect(JSON.stringify(result.details)).not.toContain('asset-1')
    expect(fixture.getThumbnailReadCalls()).toBe(1)
  })

  test('Given 枚举后画布 revision 改变 When 检查图片 Then 拒绝读取任何缩略图', async () => {
    const fixture = createFixture()
    const run = createCanvasToolRun(fixture.dependencies, fixture.context)

    await expect(executeTool(run.piCustomTools, 'canvas_inspect_images', {
      canvasId: 'canvas-1', nodeIds: ['image-1'], expectedRevision: 2,
    })).rejects.toThrow('CANVAS_REVISION_CONFLICT')
    expect(fixture.getThumbnailReadCalls()).toBe(0)
  })

  test('Given 分页游标生成后画布变化 When 继续枚举 Then 明确 revision 冲突', async () => {
    const fixture = createFixture()
    let revision = 3
    const baseDocument = fixture.dependencies.documents.load(target).document
    fixture.dependencies.documents.load = () => ({
      document: {
        ...baseDocument,
        revision,
        nodes: [
          ...baseDocument.nodes,
          { id: 'image-2', kind: 'image', title: '次视觉', position: { x: 150, y: 0 }, imageModuleId: 'image-content-2', adoptedAssetId: 'asset-1' },
        ],
      },
      writable: true,
      nodeIssues: [],
    })
    const run = createCanvasToolRun(fixture.dependencies, fixture.context)
    const firstPage = await executeTool(run.piCustomTools, 'canvas_list_nodes', {
      canvasId: 'canvas-1', kind: 'image', limit: 1,
    })
    const cursor = (firstPage.details as { nextCursor: string }).nextCursor
    revision = 4

    await expect(executeTool(run.piCustomTools, 'canvas_list_nodes', {
      canvasId: 'canvas-1', kind: 'image', limit: 1, cursor,
    })).rejects.toThrow('CANVAS_REVISION_CONFLICT')
  })

  test('Given 节点与配置采用身份不一致或缩略图损坏 When 检查 Then fail closed 且不返回图片', async () => {
    const fixture = createFixture()
    const baseDocument = fixture.dependencies.documents.load(target).document
    fixture.dependencies.documents.load = () => ({
      document: {
        ...baseDocument,
        nodes: baseDocument.nodes.map((node) => node.id === 'image-1'
          ? { ...node, adoptedAssetId: 'asset-other' }
          : node) as CanvasDocument['nodes'],
      },
      writable: true,
      nodeIssues: [],
    })
    let run = createCanvasToolRun(fixture.dependencies, fixture.context)
    let result = await executeTool(run.piCustomTools, 'canvas_inspect_images', {
      canvasId: 'canvas-1', nodeIds: ['image-1'], expectedRevision: 3,
    })
    expect(result.content.map((block) => block.type)).toEqual(['text'])
    expect(result.details).toMatchObject({ inspections: [{ status: 'adopted-asset-mismatch' }] })
    expect(fixture.getThumbnailReadCalls()).toBe(0)

    fixture.dependencies.documents.load = () => ({ document: baseDocument, writable: true, nodeIssues: [] })
    fixture.dependencies.images.readThumbnail = async () => ({
      bytes: Buffer.from('not-an-image'), mediaType: 'image/png',
    })
    run = createCanvasToolRun(fixture.dependencies, fixture.context)
    result = await executeTool(run.piCustomTools, 'canvas_inspect_images', {
      canvasId: 'canvas-1', nodeIds: ['image-1'], expectedRevision: 3,
    })
    expect(result.content.map((block) => block.type)).toEqual(['text'])
    expect(result.details).toMatchObject({ inspections: [{ status: 'image-unavailable' }] })
  })

  test('Given Agent 更新已有 WebView When 调用 canvas_update_artifact Then 节点 ID 不变且 revision 增加', async () => {
    const fixture = createFixture()
    const run = createCanvasToolRun(fixture.dependencies, fixture.context)

    const result = await executeTool(run.piCustomTools, 'canvas_update_artifact', {
      canvasId: 'canvas-1', nodeId: 'web-1', baseRevision: 3,
      expectedContentRevision: 1, content: '<!doctype html><h1>新版</h1>',
    }, 'tool-update-1')

    expect(result.details).toMatchObject({ nodeId: 'web-1', kind: 'webview', contentRevision: 2 })
    expect(fixture.textUpdateInputs[0]).toMatchObject({
      nodeId: 'web-1', kind: 'webview', contentId: 'prototype-1',
    })
  })

  test('Given Agent 更新图片 prompt When 调用 update Then 保留配置且不自动运行', async () => {
    const fixture = createFixture()
    const run = createCanvasToolRun(fixture.dependencies, fixture.context)

    const result = await executeTool(run.piCustomTools, 'canvas_update_artifact', {
      canvasId: 'canvas-1', nodeId: 'image-1', baseRevision: 3,
      expectedContentRevision: 4, content: '新的首页视觉提示词',
    }, 'tool-image-update-1')

    expect(result.details).toMatchObject({ nodeId: 'image-1', kind: 'image', contentRevision: 5, requiresRun: true })
    expect(fixture.imageSaveInputs[0]).toMatchObject({
      imageModuleId: 'image-content-1', prompt: '新的首页视觉提示词',
      selectedModelProfileId: 'model-1', aspectRatio: '16:9', imageSize: '2K', contextMode: 'project',
    })
    expect(fixture.runInputs).toHaveLength(0)
  })

  test('Given 文本与图片节点 When canvas_read Then 返回当前版本和可用历史', async () => {
    const fixture = createFixture()
    const run = createCanvasToolRun(fixture.dependencies, fixture.context)

    const result = await executeTool(run.piCustomTools, 'canvas_read', {
      canvasId: 'canvas-1', nodeIds: ['web-1', 'image-1'],
    })
    const details = result.details as { nodes: Array<{ artifact?: Record<string, unknown> }> }

    expect(details.nodes[0]?.artifact).toMatchObject({
      nodeId: 'web-1', kind: 'webview', currentRevision: 1, availableRevisions: [1, 2],
    })
    expect((result.details as { nodes: Array<{ content: string }> }).nodes[0]?.content).toBe('<main>旧版</main>')
    expect(details.nodes[1]?.artifact).toMatchObject({
      nodeId: 'image-1', kind: 'image', currentRevision: 4, adoptedAssetId: 'asset-1',
    })
  })

  test('Given 只读分析 When 读取节点 Then 返回必要邻接、限制总字符并拒绝未关联画布', async () => {
    const fixture = createFixture()
    fixture.dependencies.textArtifacts.read = async (input) => ({
      target: input,
      revision: {
        kind: input.kind, contentId: input.contentId, revision: input.contentRevision,
        parentRevision: input.contentRevision - 1, contentHash: 'a'.repeat(64),
        createdBy: { type: 'user' as const }, createdAt: 1,
      },
      content: 'A'.repeat(40_000),
    })
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
          id: `edge-${index}`, sourceNodeId: 'doc-1', sourcePort: 'output', targetNodeId: node.id, targetPort: 'input', relation: 'association',
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

  test('Given 31 个图片节点各有 1024 条任务且末尾为文档 When 读取 Then 完整响应受 32K 预算且保留末尾 revision 摘要', async () => {
    const fixture = createFixture()
    /** 末尾文档用于证明前序图片历史耗尽预算后仍保留 revision 语义。 */
    const imageNodes = Array.from({ length: 31 }, (_, index) => ({
      id: `image-${index}`, kind: 'image' as const, title: `图片节点 ${index}`,
      position: { x: index * 10, y: 0 }, imageModuleId: `module-${index}`,
    }))
    fixture.dependencies.documents.load = () => ({
      document: {
        ...createEmptyCanvasDocument(target.projectId, target.canvasId, 1), revision: 9,
        nodes: [
          ...imageNodes,
          { id: 'doc-last', kind: 'document', title: '末尾需求', position: { x: 320, y: 0 }, documentId: 'content-last', contentRevision: 7 },
        ],
      },
      writable: true,
      nodeIssues: [],
    })
    fixture.dependencies.images.load = async (imageTarget) => ({
      target: imageTarget,
      mediaLeaseId: 'unused',
      config: {
        schemaVersion: 2, kind: 'image', contentId: imageTarget.imageModuleId, revision: 8,
        createdAt: 1, updatedAt: 2, prompt: 'P'.repeat(4_000), selectedModelProfileId: 'model-1',
        aspectRatio: '16:9', imageSize: '2K', contextMode: 'project', adoptedAssetId: null,
      },
      jobs: Array.from({ length: 1_024 }, (_, index): DesignJobRecord => ({
        id: `job-${imageTarget.nodeId}-${index}-${'x'.repeat(64)}`,
        creativeTaskId: `task-${index}`, attemptNumber: 1, projectId: imageTarget.projectId,
        action: 'generate', status: 'succeeded', prompt: 'prompt', originalRequest: 'request',
        contextMode: 'project', canvasImageConfigRevision: index + 1,
        outputAssetId: `asset-${index}-${'y'.repeat(64)}`, createdAt: index, updatedAt: index,
      })),
      assets: [], assetBaseUrl: '', thumbnailBaseUrl: '',
    })
    const run = createCanvasToolRun(fixture.dependencies, fixture.context)
    const result = await executeTool(run.piCustomTools, 'canvas_read', {
      canvasId: 'canvas-1',
      nodeIds: [...imageNodes.map((node) => node.id), 'doc-last'],
    })
    const details = result.details as {
      truncated: boolean
      nodes: Array<{ node: { id: string }; artifact?: { currentRevision?: number } }>
    }

    expect(JSON.stringify(details).length).toBeLessThanOrEqual(32_768)
    const transmitted = result.content[0]
    if (transmitted?.type !== 'text') throw new Error('canvas_read 未返回文本内容')
    expect(transmitted.text.length).toBeLessThanOrEqual(32_768)
    expect(details.truncated).toBe(true)
    expect(details.nodes.at(-1)).toMatchObject({
      node: { id: 'doc-last' }, artifact: { currentRevision: 7 },
    })
    expect(fixture.runInputs).toHaveLength(0)
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

  test('Given 项目授权在运行后撤销 When 九工具 fresh execute Then 全部在 Store、batch 与 run 前拒绝', async () => {
    const cases: Array<{ name: string; args: Record<string, unknown> }> = [
      { name: 'canvas_get_context', args: {} },
      { name: 'canvas_manage', args: { action: 'create' } },
      { name: 'canvas_read', args: { canvasId: 'canvas-1', nodeIds: ['doc-1'] } },
      { name: 'canvas_apply_changes', args: { canvasId: 'canvas-1', baseRevision: 3, operations: [{ type: 'set-viewport', viewport: { x: 0, y: 0, zoom: 1 } }] } },
      { name: 'canvas_create_artifact', args: { canvasId: 'canvas-1', baseRevision: 3, artifactType: 'webview', title: '原型', content: '<!doctype html><html></html>' } },
      { name: 'canvas_update_artifact', args: { canvasId: 'canvas-1', nodeId: 'web-1', baseRevision: 3, expectedContentRevision: 1, content: '<main>新版</main>' } },
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
      edges: [{ id: 'edge-1', sourceNodeId: 'image-1', sourcePort: 'output', targetNodeId: 'doc-1', targetPort: 'input', relation: 'association' }],
    }]
    await expect(executeTool(run.piCustomTools, 'canvas_apply_changes', {
      canvasId: 'canvas-1', baseRevision: 3, operations,
    })).rejects.toThrow('CANVAS_DESTRUCTIVE_INTENT_REQUIRED')
    await expect(executeTool(run.piCustomTools, 'canvas_apply_changes', {
      canvasId: 'canvas-1', baseRevision: 3, operations, destructiveIntent: 'explicit',
    })).resolves.toMatchObject({ details: { revision: 4 } })
  })

  test('Given plan 与 execute-capable 权限上限 When run_nodes Then 只有 execute-capable 调用执行器并传递完整幂等身份', async () => {
    const fixture = createFixture({
      runBatch: {
        batchId: 'agent-canvas-batch-stable', status: 'running', totalCount: 1,
        candidateCount: 0, failedCount: 0, runningCount: 1, requiresCanvasReview: true,
      },
    })
    const plan = createCanvasToolRun(fixture.dependencies, { ...fixture.context, permissionCeiling: 'plan' })
    await expect(executeTool(plan.piCustomTools, 'canvas_run_nodes', { canvasId: 'canvas-1', nodeIds: ['image-1'] })).rejects.toThrow('CANVAS_RUN_REQUIRES_EXPLICIT_EXECUTE')
    const executeCapable = createCanvasToolRun(fixture.dependencies, fixture.context)
    const result = await executeTool(executeCapable.piCustomTools, 'canvas_run_nodes', { canvasId: 'canvas-1', nodeIds: ['image-1'] }, 'tool-run-1')
    expect(fixture.runInputs).toEqual([['image-1']])
    expect(fixture.runToolCallIds).toEqual(['tool-run-1'])
    expect(result.details).toMatchObject({
      canvasId: 'canvas-1', revision: 3,
      tasks: [{ nodeId: 'image-1', taskId: 'task-image-1' }],
      batch: {
        batchId: 'agent-canvas-batch-stable', status: 'running', totalCount: 1,
        candidateCount: 0, failedCount: 0, runningCount: 1, requiresCanvasReview: true,
      },
    })
    const serialized = JSON.stringify(result.details)
    expect(serialized).not.toContain('assetId')
    expect(serialized).not.toContain('已替换')
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

  test('Given execute 权限和已关联画布 When 创建产物 Then 传递受控内容与完整 Agent 来源身份', async () => {
    const fixture = createFixture()
    const run = createCanvasToolRun(fixture.dependencies, fixture.context)
    const result = await executeTool(run.piCustomTools, 'canvas_create_artifact', {
      canvasId: 'canvas-1',
      baseRevision: 3,
      artifactType: 'webview',
      devicePreset: 'mobile',
      title: '首页原型',
      content: '<!doctype html><html><body>首页</body></html>',
      sourceNodeId: 'doc-1',
    }, 'tool-artifact-1')

    expect(result.details).toEqual({
      canvasId: 'canvas-1',
      nodeId: 'artifact-created',
      revision: 4,
      artifactType: 'webview',
      sourceToolCallId: 'tool-artifact-1',
    })
    expect(fixture.artifactInputs).toEqual([expect.objectContaining({
      projectId: 'project-1',
      canvasId: 'canvas-1',
      devicePreset: 'mobile',
      source: { sessionId: 'session-1', runStartedAt: 99, toolCallId: 'tool-artifact-1' },
    })])
  })

  test('Given plan 权限或未关联画布 When 创建产物 Then 在原子服务前拒绝', async () => {
    const planFixture = createFixture()
    const plan = createCanvasToolRun(planFixture.dependencies, {
      ...planFixture.context,
      permissionCeiling: 'plan',
    })
    await expect(executeTool(plan.piCustomTools, 'canvas_create_artifact', {
      canvasId: 'canvas-1', baseRevision: 3, artifactType: 'image', title: '设计稿', content: '首页视觉',
    })).rejects.toThrow('CANVAS_EXECUTE_INTENT_REQUIRED')
    expect(planFixture.artifactInputs).toEqual([])

    const executeFixture = createFixture()
    const executeRun = createCanvasToolRun(executeFixture.dependencies, executeFixture.context)
    await expect(executeTool(executeRun.piCustomTools, 'canvas_create_artifact', {
      canvasId: 'foreign-canvas', baseRevision: 3, artifactType: 'webview', title: '原型', content: '<html></html>',
    })).rejects.toThrow('CANVAS_ACCESS_DENIED')
    expect(executeFixture.artifactInputs).toEqual([])
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

  test('Given webview 内容已提交 When execute run_nodes Then 返回稳定 idle 而非 unsupported', async () => {
    const fixture = createFixture()
    fixture.dependencies.documents.load = () => ({
      document: {
        ...createEmptyCanvasDocument(target.projectId, target.canvasId, 1), revision: 3,
        nodes: [{ id: 'webview-1', kind: 'webview', title: '原型', position: { x: 0, y: 0 }, prototypeId: 'prototype-1', contentRevision: 1, devicePreset: 'desktop' }],
      },
      writable: true,
      nodeIssues: [],
    })
    const run = createCanvasToolRun(fixture.dependencies, fixture.context)
    const result = await executeTool(run.piCustomTools, 'canvas_run_nodes', { canvasId: 'canvas-1', nodeIds: ['webview-1'] })
    expect(result.details).toMatchObject({
      tasks: [{ nodeId: 'webview-1', status: 'idle' }],
    })
    expect(result.details).not.toHaveProperty('batch')
  })
})
