import { describe, expect, test } from 'bun:test'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { AgentCanvasBinding, CanvasDocument, CanvasImageCandidateBatch, CanvasMutation, CanvasNodeReference, CanvasRunNodesBatchSummary, CanvasSessionMeta, DesignJobRecord } from '@proma/shared'
import { createEmptyCanvasDocument } from '@proma/shared'
import {
  CANVAS_TOOL_NAMES,
  createCanvasToolRun,
  filterCanvasAgentToolsForMode,
  type CanvasToolProviderDependencies,
  type CanvasToolRunContext,
} from './canvas-tool-provider'

const target = { projectId: 'project-1', canvasId: 'canvas-1' }
const reference: CanvasNodeReference = { ...target, nodeId: 'doc-1', nodeType: 'document', nodeRevision: 3, title: '需求' }

/** 调用指定 Pi custom tool。 */
async function executeTool(
  tools: ToolDefinition[],
  name: string,
  args: Record<string, unknown>,
  toolCallId = 'tool-call-1',
  signal?: AbortSignal,
) {
  const tool = tools.find((candidate) => candidate.name === name)
  if (!tool) throw new Error(`工具不存在: ${name}`)
  return tool.execute(toolCallId, args as never, signal as never, undefined as never, undefined as never)
}

/** 构造可观察写入、执行与全项目扫描的窄依赖。 */
function createFixture(options: {
  conflictOnce?: boolean
  conflictAlways?: boolean
  noDefaultCanvas?: boolean
  createCanvasError?: Error
  runBatch?: CanvasRunNodesBatchSummary
  agentOutput?: string
  agentOutputAtPointer?: string
  unlinkBeforeWrite?: boolean
  unlinkBeforeAgentConfigValidation?: boolean
} = {}) {
  let document: CanvasDocument = {
    ...createEmptyCanvasDocument(target.projectId, target.canvasId, 1), revision: 3,
    nodes: [
      { id: 'agent-1', kind: 'agent', title: '策划', position: { x: -50, y: 0 }, agentSessionId: 'canvas-agent-session-1' },
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
  /** Canvas Agent 节点创建调用记录。 */
  const agentArtifactInputs: Array<Record<string, unknown>> = []
  /** 已授权本地图片导入调用记录。 */
  const importedImageInputs: Array<Record<string, unknown>> = []
  /** 文本产物更新调用记录。 */
  const textUpdateInputs: Array<Record<string, unknown>> = []
  /** 图片配置保存调用记录。 */
  const imageSaveInputs: Array<Record<string, unknown>> = []
  /** Canvas Agent 长期配置只记录允许的局部 patch。 */
  const agentConfigUpdateInputs: unknown[] = []
  /** 单节点执行只记录可信父运行身份和临时 Skills。 */
  const agentExecutionInputs: unknown[] = []
  /** 工作流执行只记录 Host 绑定后的父运行与审批参数。 */
  const workflowExecutionInputs: unknown[] = []
  /** 动态计划登记必须只消费 Host 创建结果。 */
  const successorRegistrationInputs: unknown[] = []
  /** 音视频工具调用记录用于验证所有路径委托统一 CanvasMediaService。 */
  const canvasMediaInputs: Array<{ operation: string; input: unknown }> = []
  /** 精确指针读取调用用于证明摘要不会漂移到后续运行。 */
  const agentOutputReadPointers: unknown[] = []
  /** 授权与关联调用计数用于证明工具执行时 fresh-read。 */
  let authorizeReadCalls = 0
  let requireLinkedCanvasCalls = 0
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
      authorizeRead: () => { authorizeReadCalls += 1 },
      getBinding: () => getBinding(),
      requireLinkedCanvas: (_context, canvasId) => {
        requireLinkedCanvasCalls += 1
        const binding = getBinding()
        if (!binding.linkedCanvasIds.includes(canvasId)) throw new Error('CANVAS_ACCESS_DENIED')
        requireNative(target.projectId, canvasId)
        return binding
      },
      runWrite: (_context, effect) => {
        if (options.unlinkBeforeWrite) linkedCanvasIds.splice(0)
        return effect()
      },
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
    agentOutputs: {
      read: async () => options.agentOutput ?? 'Agent 正式输出',
      readAtPointer: async (_target, pointer) => {
        agentOutputReadPointers.push(structuredClone(pointer))
        return options.agentOutputAtPointer ?? options.agentOutput ?? 'Agent 正式输出'
      },
    },
    agentConfigs: {
      load: async (input) => ({
        schemaVersion: 1 as const, ...input, revision: 4, instruction: '长期职责',
        skillNames: ['research'], channelId: 'channel-1', modelId: 'model-1', updatedAt: 1,
      }),
      update: async (input, validateAccess?: () => void) => {
        if (options.unlinkBeforeAgentConfigValidation) {
          linkedCanvasIds.splice(0)
          if (!validateAccess) throw new Error('CANVAS_AGENT_CONFIG_ACCESS_VALIDATOR_REQUIRED')
          validateAccess()
        }
        agentConfigUpdateInputs.push(structuredClone(input))
        return {
          schemaVersion: 1 as const,
          projectId: input.projectId,
          canvasId: input.canvasId,
          nodeId: input.nodeId,
          revision: input.expectedConfigRevision + 1,
          instruction: input.patch.instruction ?? '长期职责',
          skillNames: input.patch.skillNames ?? ['research'],
          channelId: input.patch.channelId === undefined ? 'channel-1' : input.patch.channelId,
          modelId: input.patch.modelId === undefined ? 'model-1' : input.patch.modelId,
          updatedAt: 2,
        }
      },
    },
    agentExecution: {
      execute: async (input) => {
        agentExecutionInputs.push(input)
        return {
          status: 'completed' as const,
          output: {
            target: input.target,
            revision: 4,
            pointer: {
              messageUuid: '33333333-3333-4333-8333-333333333333',
              contentSha256: 'a'.repeat(64),
              completedAt: 120,
            },
            downstreamNodeIds: ['doc-1', 'image-1'],
          },
        }
      },
    },
    workflowExecution: {
      execute: async (runContext, input, toolCallId, signal) => {
        workflowExecutionInputs.push({ runContext, input, toolCallId, signal })
        return {
          status: 'completed' as const,
          initialRevision: input.expectedRevision,
          finalRevision: input.expectedRevision + 1,
          nodes: input.startNodeIds.map((nodeId) => ({ nodeId, status: 'completed' as const, errorCode: null })),
          imageSummary: null,
          requiresReview: false as const,
          errorCode: null,
        }
      },
      resume: async () => { throw new Error('fixture resume unavailable') },
      cancel: async () => { throw new Error('fixture cancel unavailable') },
      get: async () => { throw new Error('fixture get unavailable') },
      list: async () => [],
      registerCreatedSuccessor: async (runContext, input) => {
        successorRegistrationInputs.push({ runContext, input })
        return { status: 'registered' as const, workflowRunId: 'workflow-1', workflowRunRevision: 2, reasonCode: null }
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
      createAgent: async (input) => {
        agentArtifactInputs.push(structuredClone(input) as unknown as Record<string, unknown>)
        return {
          canvasId: input.canvasId,
          nodeId: 'agent-created',
          revision: 4,
          sourceToolCallId: input.source.toolCallId,
        }
      },
    },
    importImage: async (input) => {
      importedImageInputs.push(structuredClone(input) as unknown as Record<string, unknown>)
      return {
        canvasId: input.canvasId,
        nodeId: 'image-imported',
        revision: 4,
        artifactType: 'image' as const,
        sourceToolCallId: input.source.toolCallId,
      }
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
          ...(input.mediaWorkflow ? { mediaWorkflow: structuredClone(input.mediaWorkflow) } : {}),
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
    imageRuns: {
      run: async (_context, _target, nodes, toolCallId) => {
        runInputs.push(nodes.map((node) => node.id))
        runToolCallIds.push(toolCallId)
        return {
          tasks: nodes.map((node) => node.kind === 'image'
            ? { nodeId: node.id, status: 'started' as const, taskId: `task-${node.id}` }
            : { nodeId: node.id, status: 'idle' as const }),
          ...(options.runBatch ? { batch: options.runBatch } : {}),
        }
      },
    },
    canvasMedia: {
      load: async (input) => {
        canvasMediaInputs.push({ operation: 'load', input: structuredClone(input) })
        return {
          target: input,
          config: {
            schemaVersion: 1 as const,
            contentId: input.mediaModuleId,
            mediaKind: input.mediaKind,
            revision: 2,
            createdAt: 1,
            updatedAt: 2,
            profile: { profileId: 'profile-1', profileRevision: 1 },
            inputs: [],
            outputs: [{ key: 'primary', mediaKind: input.mediaKind, role: 'primary' as const, order: 0 }],
            adoptedOutputs: [],
          },
          candidates: [],
          runs: [],
          assets: [],
        }
      },
      save: async (input) => {
        canvasMediaInputs.push({ operation: 'save', input: structuredClone(input) })
        return {
          schemaVersion: 1 as const,
          contentId: input.mediaModuleId,
          mediaKind: input.mediaKind,
          revision: input.expectedConfigRevision + 1,
          createdAt: 1,
          updatedAt: 3,
          profile: input.profile,
          inputs: input.inputs,
          outputs: input.outputs,
          adoptedOutputs: [],
        }
      },
      run: async (input, origin) => {
        canvasMediaInputs.push({ operation: 'run', input: structuredClone({ input, origin }) })
        return {
          id: `run-${input.nodeId}`,
          projectId: input.projectId,
          revision: 1,
          phase: 'queued' as const,
          profileId: 'profile-1',
          profileRevision: 1,
          createdAt: 1,
          updatedAt: 1,
          outputs: [],
          error: null,
          progress: { nodeId: '7', value: 1, max: 4 },
        }
      },
      attachCompletedRun: async (input, actor) => {
        canvasMediaInputs.push({ operation: 'attach', input: structuredClone({ input, actor }) })
        return {
          id: `candidate:${input.runId}`,
          operationId: 'attach-operation',
          runId: input.runId,
          sourceConfigRevision: input.expectedConfigRevision,
          profile: { profileId: 'profile-1', profileRevision: 1 },
          sourceRef: { kind: 'profile-version', profileId: 'profile-1', profileRevision: 1 },
          outputs: [{ key: 'primary', mediaKind: input.mediaKind, role: 'primary' as const, order: 0,
            asset: { assetId: 'attached-asset', revision: 1, hash: 'a'.repeat(64), mediaKind: input.mediaKind } }],
          createdAt: 3,
        }
      },
      cancel: async (input, runId) => {
        canvasMediaInputs.push({ operation: 'cancel', input: structuredClone({ input, runId }) })
        return {
          id: runId,
          projectId: input.projectId,
          revision: 2,
          phase: 'cancel-requested' as const,
          profileId: 'profile-1',
          profileRevision: 1,
          createdAt: 1,
          updatedAt: 2,
          outputs: [],
          error: null,
          progress: null,
        }
      },
      adopt: async (input) => {
        canvasMediaInputs.push({ operation: 'adopt', input: structuredClone(input) })
        return {
          schemaVersion: 1 as const,
          contentId: input.mediaModuleId,
          mediaKind: input.mediaKind,
          revision: input.expectedConfigRevision + 1,
          createdAt: 1,
          updatedAt: 3,
          profile: { profileId: 'profile-1', profileRevision: 1 },
          inputs: [],
          outputs: [{ key: 'primary', mediaKind: input.mediaKind, role: 'primary' as const, order: 0 }],
          adoptedOutputs: [],
        }
      },
    },
  }
  const context: CanvasToolRunContext = {
    projectId: target.projectId, sessionId: 'session-1', runStartedAt: 99,
    explicitReferences: [reference], permissionCeiling: 'execute',
  }
  return {
    dependencies, context, batchInputs, runInputs, runToolCallIds, artifactInputs,
    agentArtifactInputs, importedImageInputs,
    textUpdateInputs, imageSaveInputs,
    agentConfigUpdateInputs, agentExecutionInputs, workflowExecutionInputs, agentOutputReadPointers,
    successorRegistrationInputs,
    canvasMediaInputs,
    getAuthorizeReadCalls: () => authorizeReadCalls,
    getRequireLinkedCanvasCalls: () => requireLinkedCanvasCalls,
    getListCalls: () => listCalls,
    getThumbnailReadCalls: () => thumbnailReadCalls,
    getCreateCalls: () => createCalls,
    getLinkCalls: () => linkCalls,
  }
}

describe('普通 Agent Canvas Tool Provider', () => {
  test('Given 图片候选 When Agent 查询后采用 Then 使用精确指纹且不暴露素材路径', async () => {
    /** 仅当前画布的真实节点可被查询和采用。 */
    const fixture = createFixture()
    const batch: CanvasImageCandidateBatch = {
      schemaVersion: 1, ...target, batchId: 'batch-1', source: 'canvas-tool',
      sourceSessionId: 'session-1', sourceToolCallId: 'tool-1', status: 'ready',
      entries: [{ nodeId: 'image-1', imageModuleId: 'image-content-1', initialAdoptedAssetId: 'asset-1',
        initialConfigRevision: 1, jobId: 'job-1', candidateAssetId: 'secret-asset', status: 'candidate', error: null }],
      adoption: null, createdAt: 1, updatedAt: 2,
    }
    const adoptedHashes: Array<string | undefined> = []
    fixture.dependencies.imageCandidates = {
      load: async () => structuredClone(batch),
      adopt: async (_input, hash) => {
        adoptedHashes.push(hash)
        return { ...batch, status: 'adopted', adoption: { mode: 'all', adoptedNodeIds: ['image-1'],
          keptNodeIds: [], invalidatedDownstreamNodeIds: [], committedAt: 3 } }
      },
    }
    const run = createCanvasToolRun(fixture.dependencies, fixture.context)
    const queried = await executeTool(run.piCustomTools, 'canvas_get_image_candidates', { canvasId: 'canvas-1', batchId: 'batch-1' })
    const details = queried.details as { candidateHash: string }
    expect(details.candidateHash).toMatch(/^[a-f0-9]{64}$/)
    expect(JSON.stringify(queried)).not.toContain('secret-asset')
    const inspected = await executeTool(run.piCustomTools, 'canvas_get_image_candidates', {
      canvasId: 'canvas-1', batchId: 'batch-1', inspectNodeIds: ['image-1'],
    })
    expect(inspected.details).toMatchObject({ imageCount: 1, inspections: [{ nodeId: 'image-1', status: 'ready' }] })
    expect(inspected.content.filter((entry) => entry.type === 'image')).toHaveLength(1)
    await expect(executeTool(run.piCustomTools, 'canvas_get_image_candidates', {
      canvasId: 'canvas-1', batchId: 'batch-1', inspectNodeIds: ['image-1', 'image-1'],
    })).rejects.toThrow('CANVAS_IMAGE_BATCH_LIMIT')
    await expect(executeTool(run.piCustomTools, 'canvas_get_image_candidates', {
      canvasId: 'canvas-unlinked', batchId: 'batch-1',
    })).rejects.toThrow()
    const result = await executeTool(run.piCustomTools, 'canvas_adopt_image_candidates', {
      canvasId: 'canvas-1', batchId: 'batch-1', candidateHash: details.candidateHash, mode: 'all',
    })
    expect(result.details).toMatchObject({ status: 'adopted', adoptedNodeIds: ['image-1'] })
    expect(adoptedHashes).toEqual([details.candidateHash])
    const plan = createCanvasToolRun(fixture.dependencies, { ...fixture.context, permissionCeiling: 'plan' })
    await expect(executeTool(plan.piCustomTools, 'canvas_adopt_image_candidates', {
      canvasId: 'canvas-1', batchId: 'batch-1', candidateHash: details.candidateHash, mode: 'all',
    })).rejects.toThrow('CANVAS_EXECUTE_INTENT_REQUIRED')
    expect(adoptedHashes).toHaveLength(1)
    /** 文件读取期间发生候选替换时，不把旧缩略图与新指纹一起返回。 */
    const readThumbnail = fixture.dependencies.images.readThumbnail
    fixture.dependencies.images.readThumbnail = async (...args) => {
      batch.entries[0]!.candidateAssetId = 'replacement-asset'
      return readThumbnail(...args)
    }
    await expect(executeTool(run.piCustomTools, 'canvas_get_image_candidates', {
      canvasId: 'canvas-1', batchId: 'batch-1', inspectNodeIds: ['image-1'],
    })).rejects.toThrow('CANVAS_IMAGE_CANDIDATES_CHANGED')
  })

  test('Given 普通分析运行 When 获取上下文 Then 注入统一 Canvas 工具、Skill 路由与硬边界且不扫描全部画布', async () => {
    const fixture = createFixture()
    const run = createCanvasToolRun(fixture.dependencies, fixture.context)
    expect(run.piCustomTools.map((tool) => tool.name)).toEqual([
      'canvas_get_context',
      'canvas_manage',
      'canvas_list_nodes',
      'canvas_inspect_images',
      'canvas_read',
      'canvas_apply_changes',
      'canvas_create_agent',
      'canvas_import_image',
      'canvas_create_artifact',
      'canvas_create_media',
      'canvas_update_artifact',
      'canvas_update_image_config',
      'canvas_update_media_config',
      'canvas_inspect_media',
      'canvas_attach_media_run',
      'canvas_cancel_media_run',
      'canvas_adopt_media_candidate',
      'canvas_update_agent_config',
      'canvas_run_agent',
      'canvas_run_workflow',
      'canvas_get_workflow_run',
      'canvas_list_workflow_runs',
      'canvas_resume_workflow',
      'canvas_cancel_workflow',
      'canvas_run_nodes',
    ])
    expect(run.allowedToolNames).toEqual([...CANVAS_TOOL_NAMES])
    expect(run.allowedToolNamesMode).toBe('extend')
    expect(run.singleApprovalToolNames).toEqual([
      'canvas_run_nodes', 'canvas_run_workflow', 'canvas_resume_workflow',
      'canvas_cancel_workflow', 'canvas_cancel_media_run',
    ])
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
    expect(runNodesDescription).toContain('图片、音频或视频节点')
    expect(runNodesDescription).toContain('产生费用')
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

  test('Given 普通 Agent 要求调整图片画幅 When 更新图片配置 Then 保留未指定字段且不自动运行', async () => {
    const fixture = createFixture()
    const run = createCanvasToolRun(fixture.dependencies, fixture.context)

    const result = await executeTool(run.piCustomTools, 'canvas_update_image_config', {
      canvasId: 'canvas-1', nodeId: 'image-1', baseRevision: 3,
      expectedConfigRevision: 4, aspectRatio: '3:4',
    }, 'tool-image-config-1')

    expect(result.details).toMatchObject({
      nodeId: 'image-1', kind: 'image', configRevision: 5, requiresRun: true,
    })
    expect(fixture.imageSaveInputs[0]).toMatchObject({
      nodeId: 'image-1', imageModuleId: 'image-content-1',
      expectedConfigRevision: 4, prompt: '旧提示词', selectedModelProfileId: 'model-1',
      aspectRatio: '3:4', imageSize: '2K', contextMode: 'project',
    })
    expect(fixture.runInputs).toHaveLength(0)
  })

  test('Given 普通 Agent 未提供图片配置变更 When 更新图片配置 Then 在保存前明确拒绝', async () => {
    const fixture = createFixture()
    const run = createCanvasToolRun(fixture.dependencies, fixture.context)

    await expect(executeTool(run.piCustomTools, 'canvas_update_image_config', {
      canvasId: 'canvas-1', nodeId: 'image-1', baseRevision: 3, expectedConfigRevision: 4,
    }, 'tool-image-config-empty')).rejects.toThrow('CANVAS_IMAGE_CONFIG_PATCH_REQUIRED')
    expect(fixture.imageSaveInputs).toHaveLength(0)
  })

  test('Given Agent 选择公共图片工作流 When 更新图片配置 Then 清除 profile 并保存完整媒体输入', async () => {
    const fixture = createFixture()
    const run = createCanvasToolRun(fixture.dependencies, fixture.context)
    const mediaWorkflow = {
      workflowId: 'workflow-1', workflowRevision: 2, connectionId: 'connection-1',
      inputs: {
        promptText: { kind: 'scalar', value: '直接映射提示词' },
        reference: { kind: 'asset', asset: {
          assetId: 'asset-1', revision: 1, hash: 'a'.repeat(64), mediaKind: 'image',
        } },
      },
    } as const

    await executeTool(run.piCustomTools, 'canvas_update_image_config', {
      canvasId: 'canvas-1', nodeId: 'image-1', baseRevision: 3,
      expectedConfigRevision: 4, mediaWorkflow,
    }, 'tool-image-workflow-1')

    expect(fixture.imageSaveInputs[0]).toMatchObject({
      selectedModelProfileId: null,
      mediaWorkflow,
    })
    expect(fixture.runInputs).toHaveLength(0)
  })

  test('Given 普通 Agent 局部修改专业 Agent 配置 When 双 revision 匹配 Then 保留省略字段且不接受会话归属字段', async () => {
    const fixture = createFixture()
    const run = createCanvasToolRun(fixture.dependencies, fixture.context)
    const tool = run.piCustomTools.find((candidate) => candidate.name === 'canvas_update_agent_config')
    if (!tool) throw new Error('canvas_update_agent_config 未注册')

    const result = await executeTool(run.piCustomTools, tool.name, {
      canvasId: 'canvas-1', nodeId: 'agent-1', expectedGraphRevision: 3,
      expectedConfigRevision: 4,
      patch: { instruction: '只负责分镜', agentSessionId: 'attempted-nested-takeover' },
      agentSessionId: 'attempted-session-takeover',
    }, 'tool-agent-config-1')

    expect(result.details).toEqual({
      canvasId: 'canvas-1', nodeId: 'agent-1', graphRevision: 3, configRevision: 5,
      instruction: '只负责分镜', skillNames: ['research'], channelId: 'channel-1', modelId: 'model-1',
    })
    expect(fixture.agentConfigUpdateInputs).toEqual([{
      projectId: 'project-1', canvasId: 'canvas-1', nodeId: 'agent-1',
      expectedGraphRevision: 3, expectedConfigRevision: 4,
      patch: { instruction: '只负责分镜' },
    }])
    const schemaProperties = (tool.parameters as { properties?: Record<string, unknown> }).properties ?? {}
    expect(schemaProperties).not.toHaveProperty('agentSessionId')
    expect(fixture.getAuthorizeReadCalls()).toBe(1)
    expect(fixture.getRequireLinkedCanvasCalls()).toBe(1)
  })

  test('Given plan 权限上限 When 更新专业 Agent 长期配置 Then 在持久化前拒绝', async () => {
    const fixture = createFixture()
    const run = createCanvasToolRun(fixture.dependencies, {
      ...fixture.context, permissionCeiling: 'plan',
    })

    await expect(executeTool(run.piCustomTools, 'canvas_update_agent_config', {
      canvasId: 'canvas-1', nodeId: 'agent-1', expectedGraphRevision: 3,
      expectedConfigRevision: 4, patch: { instruction: '持久职责' },
    })).rejects.toThrow('CANVAS_EXECUTE_INTENT_REQUIRED')
    expect(fixture.agentConfigUpdateInputs).toHaveLength(0)
  })

  test('Given 配置更新排队期间画布已解绑 When 进入写临界区 Then 在持久化前重新拒绝', async () => {
    const fixture = createFixture({ unlinkBeforeAgentConfigValidation: true })
    const run = createCanvasToolRun(fixture.dependencies, fixture.context)

    await expect(executeTool(run.piCustomTools, 'canvas_update_agent_config', {
      canvasId: 'canvas-1', nodeId: 'agent-1', expectedGraphRevision: 3,
      expectedConfigRevision: 4, patch: { instruction: '不应保存' },
    })).rejects.toThrow('CANVAS_ACCESS_DENIED')
    expect(fixture.agentConfigUpdateInputs).toHaveLength(0)
  })

  test('Given 普通 Agent 显式执行单节点 When 子 Agent 完成 Then 等待终态并只返回正式指针、下游和有界摘要', async () => {
    const fixture = createFixture({ agentOutput: '输出'.repeat(3_000) })
    const run = createCanvasToolRun(fixture.dependencies, fixture.context)
    const controller = new AbortController()

    const result = await executeTool(run.piCustomTools, 'canvas_run_agent', {
      canvasId: 'canvas-1', nodeId: 'agent-1', expectedRevision: 3,
      instruction: '完成首页分镜', skillNames: ['storyboard', 'brand:review'],
    }, 'tool-agent-run-1', controller.signal)

    expect(Object.keys(result.details as Record<string, unknown>).sort()).toEqual([
      'downstreamNodeIds', 'nodeId', 'outputPointer', 'outputSummary', 'status',
    ])
    expect(result.details).toMatchObject({
      nodeId: 'agent-1', status: 'completed',
      outputPointer: { messageUuid: '33333333-3333-4333-8333-333333333333' },
      downstreamNodeIds: ['doc-1', 'image-1'],
    })
    expect((result.details as { outputSummary: string }).outputSummary.length).toBeLessThanOrEqual(4_096)
    expect(fixture.agentExecutionInputs).toEqual([{
      mode: 'parent-orchestrated',
      target: { projectId: 'project-1', canvasId: 'canvas-1', nodeId: 'agent-1' },
      parentSessionId: 'session-1', expectedGraphRevision: 3, instruction: '完成首页分镜',
      skillNames: ['storyboard', 'brand:review'], userMessageUuid: 'tool-agent-run-1',
      startedAt: 99, signal: controller.signal,
    }])
    expect(fixture.runInputs).toHaveLength(0)
    expect(fixture.batchInputs).toHaveLength(0)
    expect(fixture.getAuthorizeReadCalls()).toBe(1)
    expect(fixture.getRequireLinkedCanvasCalls()).toBe(1)
  })

  test('Given 本次执行返回旧指针后下一轮已提交 When 生成响应摘要 Then 只读取本次精确指针正文', async () => {
    const fixture = createFixture({
      agentOutput: '下一轮不应泄露的正文',
      agentOutputAtPointer: '本次正式正文',
    })
    const run = createCanvasToolRun(fixture.dependencies, fixture.context)

    const result = await executeTool(run.piCustomTools, 'canvas_run_agent', {
      canvasId: 'canvas-1', nodeId: 'agent-1', expectedRevision: 3,
      instruction: '完成本轮任务',
    }, 'tool-agent-run-race')

    expect(result.details).toMatchObject({
      outputPointer: {
        messageUuid: '33333333-3333-4333-8333-333333333333',
        contentSha256: 'a'.repeat(64),
        completedAt: 120,
      },
      outputSummary: '本次正式正文',
    })
    expect(fixture.agentOutputReadPointers).toEqual([{
      messageUuid: '33333333-3333-4333-8333-333333333333',
      contentSha256: 'a'.repeat(64),
      completedAt: 120,
    }])
  })

  test('Given 普通 Agent 明确运行工作流 When 工具执行 Then 只透传五个参数、父运行身份和取消信号', async () => {
    const fixture = createFixture()
    const run = createCanvasToolRun(fixture.dependencies, fixture.context)
    const controller = new AbortController()

    const result = await executeTool(run.piCustomTools, 'canvas_run_workflow', {
      canvasId: 'canvas-1', expectedRevision: 3, startNodeIds: ['agent-1'],
      goal: '生成小红书视频方案', maxImageRuns: 2,
    }, 'tool-workflow-1', controller.signal)

    expect(result.details).toMatchObject({
      status: 'completed', initialRevision: 3, finalRevision: 4,
      nodes: [{ nodeId: 'agent-1', status: 'completed', errorCode: null }],
    })
    expect(fixture.workflowExecutionInputs).toEqual([{
      runContext: fixture.context,
      input: {
        canvasId: 'canvas-1', expectedRevision: 3, startNodeIds: ['agent-1'],
        goal: '生成小红书视频方案', maxImageRuns: 2,
      },
      toolCallId: 'tool-workflow-1', signal: controller.signal,
    }])
    expect(fixture.getAuthorizeReadCalls()).toBe(1)
    expect(fixture.getRequireLinkedCanvasCalls()).toBe(1)
  })

  test('Given 持久工作流等待验收 When 查询、列出、恢复与取消 Then 全部委托统一工作流服务', async () => {
    const fixture = createFixture()
    const calls: string[] = []
    const durableRun = {
      id: 'workflow-1', revision: 4, status: 'waiting-review', rootNodeIds: ['agent-1'],
      budget: { maxMediaRuns: 4, consumedMediaRuns: 1, remainingMediaRuns: 3 }, updatedAt: 10,
    }
    fixture.dependencies.workflowExecution.get = async () => {
      calls.push('get')
      return durableRun as never
    }
    fixture.dependencies.workflowExecution.list = async () => {
      calls.push('list')
      return [durableRun as never]
    }
    const resumeInputs: unknown[] = []
    fixture.dependencies.workflowExecution.resume = async (_context, input) => {
      calls.push('resume')
      resumeInputs.push(input)
      return {
        status: 'completed', initialRevision: 3, finalRevision: 4, nodes: [],
        imageSummary: null, requiresReview: false, errorCode: null,
      }
    }
    fixture.dependencies.workflowExecution.cancel = async () => {
      calls.push('cancel')
      return { ...durableRun, status: 'cancelled' } as never
    }
    const run = createCanvasToolRun(fixture.dependencies, fixture.context)

    await executeTool(run.piCustomTools, 'canvas_get_workflow_run', { canvasId: 'canvas-1', runId: 'workflow-1' })
    const listed = await executeTool(run.piCustomTools, 'canvas_list_workflow_runs', { canvasId: 'canvas-1' })
    await executeTool(run.piCustomTools, 'canvas_resume_workflow', { canvasId: 'canvas-1', runId: 'workflow-1' })
    await executeTool(run.piCustomTools, 'canvas_resume_workflow', {
      canvasId: 'canvas-1', runId: 'workflow-1', expectedRunRevision: 4,
      resumeOperationId: 'extend-1', addDurationMs: 3_600_000, addMediaRuns: 4, retryNodeIds: ['image-1'],
      projectId: 'spoofed-project', owner: { sessionId: 'spoofed-session' },
    })
    expect(resumeInputs[1]).toEqual({
      ...target, runId: 'workflow-1', expectedRunRevision: 4, resumeOperationId: 'extend-1',
      addDurationMs: 3_600_000, addMediaRuns: 4, retryNodeIds: ['image-1'],
    })
    await executeTool(run.piCustomTools, 'canvas_cancel_workflow', {
      canvasId: 'canvas-1', runId: 'workflow-1', cancelIntent: 'explicit',
    })

    expect(calls).toEqual(['get', 'list', 'resume', 'resume', 'cancel'])
    expect(listed.details).toMatchObject({
      runs: [{ id: 'workflow-1', status: 'waiting-review', budget: { remainingMediaRuns: 3 } }],
    })
  })

  test('Given 正式输出包含多字节字符 When 生成响应摘要 Then 按 UTF-8 字节安全截断且不切断字符', async () => {
    const prefix = '中'.repeat(1_365)
    const fixture = createFixture({ agentOutputAtPointer: `${prefix}😀后续正文` })
    const run = createCanvasToolRun(fixture.dependencies, fixture.context)

    const result = await executeTool(run.piCustomTools, 'canvas_run_agent', {
      canvasId: 'canvas-1', nodeId: 'agent-1', expectedRevision: 3,
      instruction: '生成多字节正文',
    }, 'tool-agent-run-utf8-budget')
    const summary = (result.details as { outputSummary: string }).outputSummary

    expect(summary).toBe(prefix)
    expect(Buffer.byteLength(summary, 'utf8')).toBeLessThanOrEqual(4_096)
    expect(summary).not.toContain('\uFFFD')
  })

  test('Given plan 上限或非法目标 When 单 Agent 运行 Then 不启动执行服务', async () => {
    const fixture = createFixture()
    const planRun = createCanvasToolRun(fixture.dependencies, {
      ...fixture.context, permissionCeiling: 'plan',
    })
    await expect(executeTool(planRun.piCustomTools, 'canvas_run_agent', {
      canvasId: 'canvas-1', nodeId: 'agent-1', expectedRevision: 3, instruction: '执行',
    })).rejects.toThrow('CANVAS_RUN_REQUIRES_EXPLICIT_EXECUTE')

    const executeRun = createCanvasToolRun(fixture.dependencies, fixture.context)
    await expect(executeTool(executeRun.piCustomTools, 'canvas_run_agent', {
      canvasId: 'canvas-1', nodeId: 'image-1', expectedRevision: 3, instruction: '执行',
    })).rejects.toThrow('CANVAS_AGENT_NODE_REQUIRED')
    expect(fixture.agentExecutionInputs).toHaveLength(0)
  })

  test('Given 空白或超预算指令及非法临时 Skill When 单 Agent 运行 Then 在执行服务前拒绝', async () => {
    const fixture = createFixture()
    const run = createCanvasToolRun(fixture.dependencies, fixture.context)
    for (const input of [
      { instruction: '   ', skillNames: [] },
      { instruction: '中'.repeat(3_000), skillNames: [] },
      { instruction: '执行', skillNames: Array.from({ length: 17 }, (_, index) => `skill-${index}`) },
      { instruction: '执行', skillNames: ['../secret'] },
    ]) {
      await expect(executeTool(run.piCustomTools, 'canvas_run_agent', {
        canvasId: 'canvas-1', nodeId: 'agent-1', expectedRevision: 3, ...input,
      })).rejects.toThrow('CANVAS_AGENT_RUN_INPUT_INVALID')
    }
    expect(fixture.agentExecutionInputs).toHaveLength(0)
  })

  test('Given Canvas Agent 的可信执行模式和未来未知工具 When 构造工具 Then 两种模式按固定正向清单默认拒绝未知能力', () => {
    const fixture = createFixture()
    const ordinary = createCanvasToolRun(fixture.dependencies, fixture.context)
    const canvasAgentTarget = { projectId: 'project-1', canvasId: 'canvas-1', nodeId: 'agent-1' }
    const rendererManual = createCanvasToolRun(fixture.dependencies, {
      ...fixture.context, sessionId: 'canvas-agent-session-1', canvasAgentTarget,
      canvasAgentMode: 'renderer-manual',
    })
    const parentOrchestrated = createCanvasToolRun(fixture.dependencies, {
      ...fixture.context, sessionId: 'canvas-agent-session-1', canvasAgentTarget,
      canvasAgentMode: 'parent-orchestrated',
    })
    const rendererManualToolNames = [
      'canvas_get_context', 'canvas_list_nodes', 'canvas_inspect_images', 'canvas_read',
      'canvas_apply_changes', 'canvas_import_image', 'canvas_create_artifact',
      'canvas_create_media', 'canvas_update_artifact',
      ...(ordinary.allowedToolNames.includes('canvas_update_image_config') ? ['canvas_update_image_config'] : []),
      'canvas_update_media_config', 'canvas_inspect_media', 'canvas_cancel_media_run',
      'canvas_adopt_media_candidate', 'canvas_get_workflow_run', 'canvas_list_workflow_runs',
      'canvas_resume_workflow', 'canvas_cancel_workflow',
      'canvas_run_nodes',
    ]
    const parentOrchestratedToolNames = rendererManualToolNames.filter((name) => ![
      'canvas_cancel_media_run', 'canvas_resume_workflow', 'canvas_cancel_workflow', 'canvas_run_nodes',
    ].includes(name))
    /** 模拟未来给普通 Agent 新增的高权限工具，Canvas Agent 必须默认拒绝。 */
    const futurePrivilegedTool: ToolDefinition = {
      ...ordinary.piCustomTools[0]!,
      name: 'canvas_future_privileged',
    }
    const candidateTools = [...ordinary.piCustomTools, futurePrivilegedTool]

    expect(rendererManual.allowedToolNames).toEqual(rendererManualToolNames)
    expect(parentOrchestrated.allowedToolNames).toEqual(parentOrchestratedToolNames)
    expect(filterCanvasAgentToolsForMode(candidateTools, 'renderer-manual').map((tool) => tool.name))
      .toEqual(rendererManualToolNames)
    expect(filterCanvasAgentToolsForMode(candidateTools, 'parent-orchestrated').map((tool) => tool.name))
      .toEqual(parentOrchestratedToolNames)
    expect(parentOrchestrated.singleApprovalToolNames).toEqual([])
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

  test('Given 音视频节点已有运行 When read 与 inspect Then 只返回配置、候选和节点进度元数据', async () => {
    const fixture = createFixture()
    fixture.dependencies.documents.load = () => ({
      document: {
        ...createEmptyCanvasDocument(target.projectId, target.canvasId, 1),
        revision: 3,
        nodes: [{
          id: 'video-1', kind: 'video', title: '主片', position: { x: 0, y: 0 }, mediaModuleId: 'media-video-1',
        }],
      },
      writable: true,
      nodeIssues: [],
    })
    const originalLoad = fixture.dependencies.canvasMedia.load
    fixture.dependencies.canvasMedia.load = async (input) => ({
      ...(await originalLoad(input)),
      runs: [{
        id: 'run-video-1', projectId: 'project-1', revision: 4, phase: 'running',
        profileId: 'profile-1', profileRevision: 1, createdAt: 1, updatedAt: 4,
        outputs: [], error: null, progress: { nodeId: '42', value: 3, max: 8 },
      }],
    })
    const run = createCanvasToolRun(fixture.dependencies, fixture.context)

    const read = await executeTool(run.piCustomTools, 'canvas_read', {
      canvasId: 'canvas-1', nodeIds: ['video-1'],
    })
    const inspect = await executeTool(run.piCustomTools, 'canvas_inspect_media', {
      canvasId: 'canvas-1', nodeId: 'video-1',
    })

    expect(JSON.stringify(read.details)).toContain('"metadataOnly":true')
    expect(inspect.details).toMatchObject({
      metadataOnly: true,
      runs: [{ phase: 'running', progress: { nodeId: '42', value: 3, max: 8 } }],
    })
    expect(JSON.stringify(inspect.details)).not.toContain('mediaUrl')
    expect(JSON.stringify(inspect.details)).not.toContain('localPath')
  })

  test('Given Agent 创建并配置音频节点 When 调用媒体工具 Then 只经产物服务和 CanvasMediaService 提交', async () => {
    const fixture = createFixture()
    const run = createCanvasToolRun(fixture.dependencies, fixture.context)
    const created = await executeTool(run.piCustomTools, 'canvas_create_media', {
      canvasId: 'canvas-1', baseRevision: 3, mediaKind: 'audio', title: '旁白',
      sourceNodeId: 'doc-1', relation: 'depends-on',
    }, 'tool-create-audio')
    expect(created.details).toMatchObject({ mediaKind: 'audio', configRevision: 0, requiresConfiguration: true })
    expect(fixture.artifactInputs).toEqual([expect.objectContaining({
      artifactType: 'audio', content: '', sourceNodeId: 'doc-1', relation: 'depends-on',
    })])

    fixture.dependencies.documents.load = () => ({
      document: {
        ...createEmptyCanvasDocument(target.projectId, target.canvasId, 1), revision: 4,
        nodes: [{ id: 'audio-1', kind: 'audio', title: '旁白', position: { x: 0, y: 0 }, mediaModuleId: 'media-audio-1' }],
      },
      writable: true,
      nodeIssues: [],
    })
    const configured = await executeTool(run.piCustomTools, 'canvas_update_media_config', {
      canvasId: 'canvas-1', nodeId: 'audio-1', baseRevision: 4, expectedConfigRevision: 2,
      profile: { profileId: 'profile-1', profileRevision: 1 },
      inputs: [{ key: 'text', kind: 'text', source: { type: 'literal', value: '你好' } }],
      outputs: [{ key: 'primary', mediaKind: 'audio', role: 'primary', order: 0 }],
    })
    expect(configured.details).toMatchObject({ mediaKind: 'audio', configRevision: 3, requiresRun: true })
    expect(fixture.canvasMediaInputs.some((entry) => entry.operation === 'save')).toBe(true)
    await executeTool(run.piCustomTools, 'canvas_update_media_config', {
      canvasId: 'canvas-1', nodeId: 'audio-1', baseRevision: 4, expectedConfigRevision: 2,
      profile: null, inputs: [{ key: 'text', kind: 'text', source: { type: 'literal', value: '草稿旁白' } }],
      outputs: [{ key: 'primary', mediaKind: 'audio', role: 'primary', order: 0 }],
    })
    expect(fixture.canvasMediaInputs.at(-1)).toMatchObject({ operation: 'save', input: { profile: null } })
  })

  test('Given 父编排 child 创建产物 When 登记动态后继 Then 只传 Host 创建结果且登记失败保留创建事实', async () => {
    const fixture = createFixture()
    const context: CanvasToolRunContext = { ...fixture.context, canvasAgentMode: 'parent-orchestrated',
      canvasAgentTarget: { ...target, nodeId: 'agent-1' }, parentWorkflow: { runId: 'workflow-1', parentSessionId: 'parent-1' } }
    const run = createCanvasToolRun(fixture.dependencies, context)
    for (const [toolName, extra] of [
      ['canvas_create_media', { mediaKind: 'video' }],
      ['canvas_create_artifact', { artifactType: 'document', content: '# 交付' }],
      ['canvas_import_image', { localPath: '/authorized/reference.png' }],
    ] as const) {
      const result = await executeTool(run.piCustomTools, toolName, {
        canvasId: target.canvasId, baseRevision: 3, title: '新产物', ...extra,
      }, 'trusted-create-call')
      expect(result.details).toMatchObject({ workflowRegistration: { status: 'registered', workflowRunId: 'workflow-1' } })
    }
    expect(fixture.successorRegistrationInputs).toEqual([
      { runContext: context, input: { ...target, nodeId: 'artifact-created', sourceToolCallId: 'trusted-create-call' } },
      { runContext: context, input: { ...target, nodeId: 'artifact-created', sourceToolCallId: 'trusted-create-call' } },
      { runContext: context, input: { ...target, nodeId: 'image-imported', sourceToolCallId: 'trusted-create-call' } },
    ])
    fixture.dependencies.workflowExecution.registerCreatedSuccessor = async () => { throw new Error('DISK_ERROR_WITH_PRIVATE_PATH') }
    fixture.dependencies.workflowExecution.recordCreatedSuccessorRegistrationFailure = async () => ({
      status: 'blocked', workflowRunId: 'workflow-1', workflowRunRevision: 3,
      reasonCode: 'CANVAS_WORKFLOW_DYNAMIC_SUCCESSOR_REGISTRATION_FAILED',
    })
    const created = await executeTool(run.piCustomTools, 'canvas_create_media', {
      canvasId: target.canvasId, baseRevision: 3, title: '旁白', mediaKind: 'audio',
    })
    expect(created.details).toMatchObject({ nodeId: 'artifact-created', workflowRegistration: {
      status: 'blocked', workflowRunRevision: 3,
      reasonCode: 'CANVAS_WORKFLOW_DYNAMIC_SUCCESSOR_REGISTRATION_FAILED',
    } })
    expect(JSON.stringify(created)).not.toContain('PRIVATE_PATH')
  })

  test('Given 父工作流 child When 用结构批次创建未登记节点 Then 批次执行前拒绝', async () => {
    const fixture = createFixture()
    const run = createCanvasToolRun(fixture.dependencies, { ...fixture.context, canvasAgentMode: 'parent-orchestrated',
      canvasAgentTarget: { ...target, nodeId: 'agent-1' }, parentWorkflow: { runId: 'workflow-1', parentSessionId: 'parent-1' } })
    await expect(executeTool(run.piCustomTools, 'canvas_apply_changes', {
      canvasId: target.canvasId, baseRevision: 3,
      operations: [{ type: 'upsert-nodes', nodes: [{ id: 'unregistered', kind: 'image', title: '绕过',
        imageModuleId: 'unregistered-image', position: { x: 0, y: 0 } }] }],
    })).rejects.toThrow('CANVAS_WORKFLOW_SUCCESSOR_USE_CREATE_TOOL')
    expect(fixture.batchInputs).toEqual([])
  })

  test('Given 媒体候选与活动运行 When Agent 采用并取消 Then 两项操作都绑定权威节点模块身份', async () => {
    const fixture = createFixture()
    fixture.dependencies.documents.load = () => ({
      document: {
        ...createEmptyCanvasDocument(target.projectId, target.canvasId, 1), revision: 3,
        nodes: [{ id: 'audio-1', kind: 'audio', title: '旁白', position: { x: 0, y: 0 }, mediaModuleId: 'media-audio-1' }],
      },
      writable: true,
      nodeIssues: [],
    })
    const run = createCanvasToolRun(fixture.dependencies, fixture.context)

    await executeTool(run.piCustomTools, 'canvas_adopt_media_candidate', {
      canvasId: 'canvas-1', nodeId: 'audio-1', expectedConfigRevision: 2,
      candidateId: 'candidate-1', selectedKeys: ['primary'],
    })
    await executeTool(run.piCustomTools, 'canvas_cancel_media_run', {
      canvasId: 'canvas-1', nodeId: 'audio-1', runId: 'run-audio-1', cancelIntent: 'explicit',
    })

    expect(fixture.canvasMediaInputs.filter((entry) => ['adopt', 'cancel'].includes(entry.operation)))
      .toEqual([
        expect.objectContaining({ operation: 'adopt', input: expect.objectContaining({ mediaModuleId: 'media-audio-1' }) }),
        expect.objectContaining({ operation: 'cancel', input: expect.objectContaining({ input: expect.objectContaining({ mediaModuleId: 'media-audio-1' }) }) }),
      ])
  })

  test('Given 普通 Agent 已有成功独立 run When 显式挂接既有 AV 节点 Then Host 传入真实 actor 且不返回资产标识', async () => {
    const fixture = createFixture()
    fixture.dependencies.documents.load = () => ({
      document: {
        ...createEmptyCanvasDocument(target.projectId, target.canvasId, 1), revision: 3,
        nodes: [{ id: 'video-1', kind: 'video', title: '主片', position: { x: 0, y: 0 }, mediaModuleId: 'media-video-1' }],
      },
      writable: true,
      nodeIssues: [],
    })
    const run = createCanvasToolRun(fixture.dependencies, fixture.context)
    const result = await executeTool(run.piCustomTools, 'canvas_attach_media_run', {
      canvasId: 'canvas-1', nodeId: 'video-1', expectedConfigRevision: 2, runId: 'independent-run-1',
    })

    expect(fixture.canvasMediaInputs.at(-1)).toEqual({
      operation: 'attach',
      input: {
        input: { ...target, nodeId: 'video-1', mediaModuleId: 'media-video-1', mediaKind: 'video', expectedConfigRevision: 2, runId: 'independent-run-1' },
        actor: { sessionId: 'session-1', runStartedAt: 99, mode: 'project-agent' },
      },
    })
    expect(result.details).toMatchObject({ candidateId: 'candidate:independent-run-1', runId: 'independent-run-1', adopted: false })
    expect(JSON.stringify(result.details)).not.toContain('attached-asset')

    const parent = createCanvasToolRun(fixture.dependencies, {
      ...fixture.context,
      sessionId: 'canvas-agent-session-1',
      canvasAgentMode: 'parent-orchestrated',
      canvasAgentTarget: { ...target, nodeId: 'agent-1' },
    })
    expect(parent.allowedToolNames).not.toContain('canvas_attach_media_run')
    expect(parent.piCustomTools.some((tool) => tool.name === 'canvas_attach_media_run')).toBe(false)
  })

  test('Given 当前会话导入的音视频 When 回填画布 Then 绑定 Host 身份且工具重放复用 operationId', async () => {
    /** 模拟本地导入后的精确资产引用和可观察调用。 */
    const fixture = createFixture()
    const asset = { assetId: 'local-asset', revision: 1, hash: 'a'.repeat(64), mediaKind: 'video' as const }
    const calls: unknown[] = []
    fixture.dependencies.documents.load = () => ({
      document: { ...createEmptyCanvasDocument(target.projectId, target.canvasId, 1), revision: 3,
        nodes: [{ id: 'video-1', kind: 'video', title: '成片', position: { x: 0, y: 0 }, mediaModuleId: 'media-video-1' }] },
      writable: true, nodeIssues: [],
    })
    fixture.dependencies.canvasMedia.attachImportedAssets = async (input, actor) => {
      calls.push(structuredClone({ input, actor }))
      return { id: 'candidate:local-receipt', operationId: input.operationId, runId: 'local-receipt',
        sourceConfigRevision: input.expectedConfigRevision, createdAt: 1,
        source: { kind: 'local-import', operationId: input.operationId, sourceSessionId: actor.sessionId },
        outputs: [{ key: 'primary', mediaKind: 'video', role: 'primary', order: 0, asset }] }
    }
    const run = createCanvasToolRun(fixture.dependencies, fixture.context)
    const params = { canvasId: target.canvasId, nodeId: 'video-1', expectedConfigRevision: 2,
      outputs: [{ key: 'primary', asset }] }
    const result = await executeTool(run.piCustomTools, 'canvas_attach_media_assets', params, 'local-attach-call')
    await executeTool(run.piCustomTools, 'canvas_attach_media_assets', params, 'local-attach-call')
    expect(calls).toHaveLength(2)
    expect(calls[0]).toEqual(calls[1])
    expect(calls[0]).toEqual({ input: { ...target, nodeId: 'video-1', mediaModuleId: 'media-video-1',
      mediaKind: 'video', expectedConfigRevision: 2, operationId: expect.any(String), outputs: params.outputs },
    actor: { sessionId: 'session-1', runStartedAt: 99, mode: 'project-agent' } })
    expect(result.details).toMatchObject({ candidateId: 'candidate:local-receipt', sourceKind: 'local-import', adopted: false })
    expect(JSON.stringify(result.details)).not.toContain('local-asset')
    expect(fixture.runInputs).toEqual([])
    expect(fixture.canvasMediaInputs).toEqual([])

    await expect(executeTool(run.piCustomTools, 'canvas_attach_media_assets', {
      ...params, outputs: [{ key: 'primary', asset: { ...asset, hash: 'invalid' } }],
    })).rejects.toThrow('CANVAS_MEDIA_INPUT_INVALID')
    const plan = createCanvasToolRun(fixture.dependencies, { ...fixture.context, permissionCeiling: 'plan' })
    await expect(executeTool(plan.piCustomTools, 'canvas_attach_media_assets', params)).rejects.toThrow('CANVAS_EXECUTE_INTENT_REQUIRED')
    expect(calls).toHaveLength(2)

    const manual = createCanvasToolRun(fixture.dependencies, { ...fixture.context,
      canvasAgentTarget: { ...target, nodeId: 'agent-1' }, canvasAgentMode: 'renderer-manual' })
    expect(manual.allowedToolNames).toContain('canvas_attach_media_assets')
    const parent = createCanvasToolRun(fixture.dependencies, { ...fixture.context,
      canvasAgentTarget: { ...target, nodeId: 'agent-1' }, canvasAgentMode: 'parent-orchestrated' })
    expect(parent.allowedToolNames).not.toContain('canvas_attach_media_assets')
  })

  test('Given Agent 节点已有权威正式输出 When canvas_read Then 返回验证正文且统一受 32 KiB 预算约束', async () => {
    const fixture = createFixture({ agentOutput: '中'.repeat(40_000) })
    const run = createCanvasToolRun(fixture.dependencies, fixture.context)

    const result = await executeTool(run.piCustomTools, 'canvas_read', {
      canvasId: 'canvas-1', nodeIds: ['agent-1'],
    })
    const details = result.details as {
      nodes: Array<{ content: string; contentLength: number }>
      truncated: boolean
    }

    expect(details.nodes[0]?.contentLength).toBe(40_000)
    expect(details.nodes[0]?.content.length).toBeLessThan(40_000)
    expect(details.truncated).toBe(true)
    expect(JSON.stringify(details).length).toBeLessThanOrEqual(32_768)
  })

  test('Given 四类节点且 Agent 会话不可用 When canvas_read Then 每个条目公开当前派生能力且不可用节点没有 run', async () => {
    const fixture = createFixture()
    fixture.dependencies.documents.load = () => ({
      document: {
        ...createEmptyCanvasDocument(target.projectId, target.canvasId, 1), revision: 3,
        nodes: [
          { id: 'agent-1', kind: 'agent', title: '策划', position: { x: 0, y: 0 }, agentSessionId: 'canvas-agent-session-1' },
          { id: 'image-1', kind: 'image', title: '主视觉', position: { x: 50, y: 0 }, imageModuleId: 'image-content-1' },
          { id: 'doc-1', kind: 'document', title: '需求', position: { x: 100, y: 0 }, documentId: 'content-1', contentRevision: 2 },
          { id: 'web-1', kind: 'webview', title: '原型', position: { x: 150, y: 0 }, prototypeId: 'prototype-1', contentRevision: 1, devicePreset: 'desktop' },
        ],
      },
      writable: true,
      nodeIssues: [{ nodeId: 'agent-1', code: 'AGENT_SESSION_UNAVAILABLE', allowedActions: ['rebuild-agent-session', 'remove-node'] }],
    })
    const run = createCanvasToolRun(fixture.dependencies, fixture.context)

    const result = await executeTool(run.piCustomTools, 'canvas_read', {
      canvasId: 'canvas-1', nodeIds: ['agent-1', 'image-1', 'doc-1', 'web-1'],
    })
    const entries = (result.details as {
      nodes: Array<{ node: { id: string }; capabilities: string[] }>
    }).nodes

    expect(entries.map((entry) => [entry.node.id, entry.capabilities])).toEqual([
      ['agent-1', ['read', 'update-config']],
      ['image-1', ['read', 'update-config', 'run', 'review-required']],
      ['doc-1', ['read', 'update-content']],
      ['web-1', ['read', 'update-content']],
    ])
  })

  test('Given 调用方伪造 capability When 更新错误类型或旧版本产物 Then Host 仍拒绝类型与 revision', async () => {
    const fixture = createFixture()
    const run = createCanvasToolRun(fixture.dependencies, fixture.context)

    await expect(executeTool(run.piCustomTools, 'canvas_update_artifact', {
      canvasId: 'canvas-1', nodeId: 'agent-1', baseRevision: 3,
      expectedContentRevision: 1, content: '伪造正文', capabilities: ['update-content'],
    })).rejects.toThrow('CANVAS_ARTIFACT_TYPE_UNSUPPORTED')
    await expect(executeTool(run.piCustomTools, 'canvas_update_artifact', {
      canvasId: 'canvas-1', nodeId: 'doc-1', baseRevision: 2,
      expectedContentRevision: 2, content: '伪造正文', capabilities: ['update-content'],
    })).rejects.toThrow('CANVAS_ARTIFACT_REVISION_CONFLICT')
    expect(fixture.textUpdateInputs).toHaveLength(0)
  })

  test('Given 调用方缓存 apply capability When 批处理使用旧 revision Then Host 仍执行权威 revision 校验', async () => {
    const fixture = createFixture({ conflictAlways: true })
    const run = createCanvasToolRun(fixture.dependencies, fixture.context)

    await expect(executeTool(run.piCustomTools, 'canvas_apply_changes', {
      canvasId: 'canvas-1', baseRevision: 2,
      operations: [{ type: 'set-title', nodeId: 'doc-1', title: '新版需求' }],
      capabilities: ['update-content'],
    })).rejects.toThrow('CANVAS_REVISION_CONFLICT')
    expect(fixture.batchInputs).toHaveLength(1)
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

  test('Given 项目授权在运行后撤销 When 十五工具 fresh execute Then 全部在 Store、batch 与 run 前拒绝', async () => {
    const cases: Array<{ name: string; args: Record<string, unknown> }> = [
      { name: 'canvas_get_context', args: {} },
      { name: 'canvas_manage', args: { action: 'create' } },
      { name: 'canvas_read', args: { canvasId: 'canvas-1', nodeIds: ['doc-1'] } },
      { name: 'canvas_apply_changes', args: { canvasId: 'canvas-1', baseRevision: 3, operations: [{ type: 'set-viewport', viewport: { x: 0, y: 0, zoom: 1 } }] } },
      { name: 'canvas_create_agent', args: { canvasId: 'canvas-1', baseRevision: 3, title: '分镜 Agent' } },
      { name: 'canvas_import_image', args: { canvasId: 'canvas-1', baseRevision: 3, title: '角色三视图', localPath: 'reference.png' } },
      { name: 'canvas_create_artifact', args: { canvasId: 'canvas-1', baseRevision: 3, artifactType: 'webview', title: '原型', content: '<!doctype html><html></html>' } },
      { name: 'canvas_update_artifact', args: { canvasId: 'canvas-1', nodeId: 'web-1', baseRevision: 3, expectedContentRevision: 1, content: '<main>新版</main>' } },
      { name: 'canvas_update_image_config', args: { canvasId: 'canvas-1', nodeId: 'image-1', baseRevision: 3, expectedConfigRevision: 4, aspectRatio: '3:4' } },
      { name: 'canvas_update_agent_config', args: { canvasId: 'canvas-1', nodeId: 'agent-1', expectedGraphRevision: 3, expectedConfigRevision: 4, patch: { instruction: '职责' } } },
      { name: 'canvas_run_agent', args: { canvasId: 'canvas-1', nodeId: 'agent-1', expectedRevision: 3, instruction: '执行' } },
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

  test('Given Agent 有运行权限 When 尝试改写媒体模型范围 Then 拒绝自动扩大用户范围', async () => {
    const fixture = createFixture()
    const run = createCanvasToolRun(fixture.dependencies, fixture.context)
    await expect(executeTool(run.piCustomTools, 'canvas_apply_changes', { canvasId: 'canvas-1', baseRevision: 3,
      operations: [{ type: 'set-media-model-scope', scope: { mode: 'all-enabled' } }] })).rejects.toThrow('CANVAS_MEDIA_MODEL_SCOPE_USER_MANAGED')
    expect(fixture.batchInputs).toHaveLength(0)
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

  test('Given 普通 Agent 需要画布分工 When 创建 Canvas Agent Then 创建独立节点且不暴露内部会话身份', async () => {
    const fixture = createFixture()
    const run = createCanvasToolRun(fixture.dependencies, fixture.context)

    const result = await executeTool(run.piCustomTools, 'canvas_create_agent', {
      canvasId: 'canvas-1', baseRevision: 3, title: '分镜策划 Agent',
      sourceNodeId: 'doc-1', relation: 'depends-on',
    }, 'tool-agent-1')

    expect(result.details).toEqual({
      canvasId: 'canvas-1', nodeId: 'agent-created', revision: 4,
      sourceToolCallId: 'tool-agent-1',
    })
    expect(JSON.stringify(result.details)).not.toContain('sessionId')
    expect(fixture.agentArtifactInputs).toEqual([expect.objectContaining({
      projectId: 'project-1', canvasId: 'canvas-1', title: '分镜策划 Agent',
      sourceNodeId: 'doc-1', relation: 'depends-on',
      source: { sessionId: 'session-1', runStartedAt: 99, toolCallId: 'tool-agent-1' },
    })])
  })

  test('Given Agent 工作区已有参考图 When 导入 Canvas Then 创建已采用图片节点且不暴露素材身份', async () => {
    const fixture = createFixture()
    const run = createCanvasToolRun(fixture.dependencies, fixture.context)

    const result = await executeTool(run.piCustomTools, 'canvas_import_image', {
      canvasId: 'canvas-1', baseRevision: 3, title: 'IP 三视图',
      localPath: 'workspace-files/ip-turnaround.png', prompt: '角色一致性参考',
      sourceNodeId: 'doc-1', relation: 'reference',
    }, 'tool-import-1')

    expect(result.details).toEqual({
      canvasId: 'canvas-1', nodeId: 'image-imported', revision: 4,
      artifactType: 'image', sourceToolCallId: 'tool-import-1',
    })
    expect(JSON.stringify(result.details)).not.toContain('assetId')
    expect(fixture.importedImageInputs).toEqual([expect.objectContaining({
      projectId: 'project-1', canvasId: 'canvas-1', localPath: 'workspace-files/ip-turnaround.png',
      source: { sessionId: 'session-1', runStartedAt: 99, toolCallId: 'tool-import-1' },
    })])
  })

  test('Given plan 权限上限 When 创建 Canvas Agent 或导入图片 Then 在服务调用前拒绝', async () => {
    const fixture = createFixture()
    const run = createCanvasToolRun(fixture.dependencies, {
      ...fixture.context,
      permissionCeiling: 'plan',
    })

    await expect(executeTool(run.piCustomTools, 'canvas_create_agent', {
      canvasId: 'canvas-1', baseRevision: 3, title: '分镜 Agent',
    })).rejects.toThrow('CANVAS_EXECUTE_INTENT_REQUIRED')
    await expect(executeTool(run.piCustomTools, 'canvas_import_image', {
      canvasId: 'canvas-1', baseRevision: 3, title: '参考图', localPath: 'reference.png',
    })).rejects.toThrow('CANVAS_EXECUTE_INTENT_REQUIRED')
    expect(fixture.agentArtifactInputs).toEqual([])
    expect(fixture.importedImageInputs).toEqual([])
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

  test('Given 独立音视频节点 When run_nodes Then 使用权威模块身份委托统一媒体服务并返回进度任务 ID', async () => {
    const fixture = createFixture()
    fixture.dependencies.documents.load = () => ({
      document: {
        ...createEmptyCanvasDocument(target.projectId, target.canvasId, 1), revision: 3,
        nodes: [
          { id: 'audio-1', kind: 'audio', title: '旁白', position: { x: 0, y: 0 }, mediaModuleId: 'media-audio-1' },
          { id: 'video-1', kind: 'video', title: '主片', position: { x: 100, y: 0 }, mediaModuleId: 'media-video-1' },
        ],
      },
      writable: true,
      nodeIssues: [],
    })
    const run = createCanvasToolRun(fixture.dependencies, fixture.context)

    const result = await executeTool(run.piCustomTools, 'canvas_run_nodes', {
      canvasId: 'canvas-1', nodeIds: ['video-1', 'audio-1'],
    }, 'tool-media-run')

    expect(result.details).toMatchObject({
      tasks: [
        { nodeId: 'video-1', status: 'started', taskId: 'run-video-1' },
        { nodeId: 'audio-1', status: 'started', taskId: 'run-audio-1' },
      ],
    })
    expect(fixture.canvasMediaInputs.filter((entry) => entry.operation === 'run')).toHaveLength(2)
    expect(fixture.runInputs).toEqual([])
  })

  test('Given 所选媒体节点存在直接上下游 When run_nodes Then 在任何生成副作用前阻断下游', async () => {
    const fixture = createFixture()
    fixture.dependencies.documents.load = () => ({
      document: {
        ...createEmptyCanvasDocument(target.projectId, target.canvasId, 1), revision: 3,
        nodes: [
          { id: 'audio-1', kind: 'audio', title: '音轨', position: { x: 0, y: 0 }, mediaModuleId: 'media-audio-1' },
          { id: 'video-1', kind: 'video', title: '成片', position: { x: 100, y: 0 }, mediaModuleId: 'media-video-1' },
        ],
        edges: [{
          id: 'edge-media', sourceNodeId: 'audio-1', sourcePort: 'audio.asset',
          targetNodeId: 'video-1', targetPort: 'audio.reference', relation: 'depends-on',
        }],
      },
      writable: true,
      nodeIssues: [],
    })
    const run = createCanvasToolRun(fixture.dependencies, fixture.context)

    await expect(executeTool(run.piCustomTools, 'canvas_run_nodes', {
      canvasId: 'canvas-1', nodeIds: ['audio-1', 'video-1'],
    })).rejects.toThrow('SELECTED_UPSTREAM_REGENERATING')
    expect(fixture.canvasMediaInputs).toEqual([])
    expect(fixture.runInputs).toEqual([])
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
