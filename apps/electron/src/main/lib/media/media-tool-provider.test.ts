import { describe, expect, test } from 'bun:test'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { ComfyObjectInfo, MediaAssetRecord, MediaAssetRef, MediaProjectCatalog, MediaRemoteDescriptor, MediaRunSnapshot, MediaWorkflowDefinition } from '@proma/shared'
import type { CanvasToolRunContext } from '../design/canvas-tool-provider'
import { createMediaToolRun, MEDIA_TOOL_NAMES, type MediaToolProviderDependencies } from './media-tool-provider'

const workflow: MediaWorkflowDefinition = {
  schemaVersion: 1,
  prompt: {
    '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'model.safetensors' } },
    '2': { class_type: 'SaveImage', inputs: { images: ['1', 0], filename_prefix: 'Proma' } },
  },
  bindings: [],
  outputs: [{ key: 'main', nodeId: '2', outputIndex: 0, mediaType: 'image' }],
}

const schema: ComfyObjectInfo = {
  CheckpointLoaderSimple: {
    input: { required: { ckpt_name: [['model.safetensors', 'secret-model.safetensors']] }, hidden: { api_key: 'secret' } },
    output: ['MODEL', 'CLIP', 'VAE'],
    category: 'loaders',
  },
  SaveImage: {
    input: { required: { images: ['IMAGE'], filename_prefix: ['STRING'] } },
    output: [], output_node: true, category: 'image',
  },
}

const context: CanvasToolRunContext = {
  projectId: 'project-1', sessionId: 'session-1', runStartedAt: 42,
  explicitReferences: [], permissionCeiling: 'execute',
}

/** 调用指定媒体工具，模拟 Pi runtime 传入稳定 toolCallId。 */
async function executeTool(tools: ToolDefinition[], name: string, input: Record<string, unknown>, toolCallId = 'call-1') {
  const tool = tools.find((item) => item.name === name)
  if (!tool) throw new Error(`工具不存在: ${name}`)
  return tool.execute(toolCallId, input as never, undefined as never, undefined as never, undefined as never)
}

/** 构造完整但可观察的媒体 Host 窄依赖。 */
function fixture(options: { largeResources?: boolean; withSources?: boolean; withLocalImport?: boolean; withAssetFile?: boolean } = {}) {
  let configRevision = 3
  let workflowRevision = 0
  let workflowId = 'draft'
  let profileRevision = 0
  const calls: Array<{ operation: string; runId?: string }> = []
  const prepared: string[] = []
  const publishedProjectIds: Array<string | null> = []
  const importedDescriptors: MediaRemoteDescriptor[] = []
  const importedLocalFiles: Array<{ path: string; mediaKind: 'image' | 'audio' | 'video' }> = []
  const resolvedAssetFiles: MediaAssetRef[] = []
  const modelScopes: Array<string | undefined> = []
  const catalog = (): MediaProjectCatalog => ({
    revision: configRevision,
    connections: [{ id: 'gpu', name: 'GPU', driver: 'comfyui', enabled: true, revision: 1, instanceGeneration: 'instance-1', credentialConfigured: true }],
    workflows: workflowRevision ? [{ id: workflowId, name: '草稿', projectId: 'project-1', revision: workflowRevision, hash: 'a'.repeat(64), createdAt: 1 }] : [],
    profiles: profileRevision ? [{ id: 'profile', name: '图片', revision: profileRevision, connectionId: 'gpu', workflowId: 'draft', workflowRevision, mediaKind: 'image', projectId: 'project-1', enabled: true, createdAt: 1 }] : [],
  })
  const snapshot = (id: string, phase: MediaRunSnapshot['phase'] = 'prepared'): MediaRunSnapshot => ({
    id, projectId: 'project-1', revision: phase === 'prepared' ? 0 : 1, phase,
    profileId: 'profile', profileRevision: 1, createdAt: 1, updatedAt: 1,
    outputs: [], error: null, progress: null,
  })
  const dependencies: MediaToolProviderDependencies = {
    authorize: (_runContext, operation, runId) => { calls.push({ operation, ...(runId ? { runId } : {}) }) },
    configuration: {
      listProject: () => catalog(),
      read: () => ({ schemaVersion: 1, ...catalog(), connections: [], workflows: workflowRevision ? [{ ...catalog().workflows[0]!, definition: workflow }] : [] }),
      getWorkflow: () => ({ ...catalog().workflows[0]!, definition: workflow }),
      saveWorkflow: (input, expectedRevision) => {
        expect(expectedRevision).toBe(configRevision)
        publishedProjectIds.push((input as { projectId: string | null }).projectId)
        workflowId = (input as { id: string }).id; workflowRevision += 1; configRevision += 1
        return { schemaVersion: 1, revision: configRevision, connections: [], workflows: [{ ...catalog().workflows[0]!, definition: workflow }], profiles: [] }
      },
      saveProfile: (input, expectedRevision) => {
        expect(expectedRevision).toBe(configRevision)
        expect((input as { projectId: string }).projectId).toBe('project-1')
        profileRevision += 1; configRevision += 1
        return { schemaVersion: 1, revision: configRevision, connections: [], workflows: [{ ...catalog().workflows[0]!, definition: workflow }], profiles: catalog().profiles }
      },
      resolveProfile: () => ({
        profile: catalog().profiles[0]!, workflow: { ...catalog().workflows[0]!, definition: workflow },
        connection: { id: 'gpu', name: 'GPU', driver: 'comfyui', baseUrl: 'http://127.0.0.1:8188', enabled: true, projectIds: ['project-1'], auth: { kind: 'none' }, revision: 1, instanceGeneration: 'instance-1', updatedAt: 1 }, headers: {},
      }),
    },
    resources: {
      getSchema: async () => schema,
      list: async (input) => ({
        connectionId: input.connectionId, instanceGeneration: 'instance-1', remoteUser: 'user-1',
        snapshotId: 'snapshot', checkedAt: 1, capability: 'available',
        source: input.kind === 'workflows' ? 'user-data' : input.kind === 'assets' ? 'assets-api' : 'object-info',
        total: options.largeResources ? 1000 : 1, nextOffset: options.largeResources ? 100 : null,
        items: Array.from({ length: options.largeResources ? 100 : 1 }, (_, index) => ({
          id: `Node${index}`, name: `节点${index}${'x'.repeat(options.largeResources ? 1000 : 0)}`, category: 'test', supported: true,
          support: input.kind === 'nodes' ? 'supported' as const : 'unknown' as const,
          source: input.kind === 'workflows' ? 'user-data' as const : input.kind === 'assets' ? 'assets-api' as const : 'object-info' as const,
          ...(input.kind === 'workflows' ? { descriptor: {
            connectionId: input.connectionId, instanceGeneration: 'instance-1', remoteUser: 'user-1',
            source: 'user-data' as const, id: `workflow-${index}.json`, workflowPath: `workflow-${index}.json`,
          } } : {}),
          ...(input.kind === 'assets' ? { descriptor: {
            connectionId: input.connectionId, instanceGeneration: 'instance-1', remoteUser: 'user-1',
            source: 'assets-api' as const, id: `asset-${index}`, assetId: `asset-${index}`,
          }, metadata: { mimeType: 'image/png', size: 3 } } : {}),
          ...(input.kind === 'nodes' ? { schema: schema.SaveImage } : {}),
        })),
      }),
      readWorkflow: async (descriptor) => ({ descriptor: structuredClone(descriptor), format: 'api' as const,
        definition: workflow.prompt as unknown as import('@proma/shared').JsonObject }),
      readRemoteAsset: async (descriptor) => ({ descriptor: structuredClone(descriptor), bytes: new Uint8Array([1, 2, 3]), contentType: 'image/png' }),
    },
    listAssets: async () => [{ asset: { assetId: 'asset-1', revision: 1, hash: 'b'.repeat(64), mediaKind: 'image' }, roles: ['source'], width: 1024, height: 1024 }],
    runs: {
      prepare: async (input, origin) => {
        expect(input.projectId).toBe('project-1')
        expect(origin?.actor).toEqual({ sessionId: 'session-1', runStartedAt: 42, mode: 'project-agent' })
        prepared.push(input.operationId)
        return snapshot(`run-${input.operationId}`)
      },
      prepareDraft: async (input, origin) => {
        expect(input.projectId).toBe('project-1')
        expect(origin?.actor?.sessionId).toBe(context.sessionId)
        prepared.push(input.operationId)
        return { ...snapshot(`run-${input.operationId}`), sourceRef: {
          kind: 'project-draft-revision', workflowId: input.workflowId, workflowRevision: input.workflowRevision,
          connectionId: input.connectionId, mediaKind: input.mediaKind,
        }, profileId: undefined, profileRevision: undefined }
      },
      get: (_projectId, runId) => snapshot(runId, 'running'),
      getOrigin: () => ({ actor: { sessionId: 'session-1', runStartedAt: 42, mode: 'project-agent' as const } }),
      cancel: async (_projectId, runId) => snapshot(runId, 'cancel-requested'),
    },
    supervisor: {
      start: (_projectId, runId) => snapshot(runId, 'prepared'),
      watch: () => undefined,
      wait: async (_projectId, runId) => snapshot(runId, 'succeeded'),
    },
    registerRemoteAsset: async (_resourceContext, input) => {
      importedDescriptors.push(structuredClone(input.descriptor))
      expect(input.bytes).toEqual(new Uint8Array([1, 2, 3]))
      return { assetId: 'remote-import', revision: 1, hash: 'd'.repeat(64), mediaKind: 'image' }
    },
    listModels: async (_modelContext, canvasId) => {
      modelScopes.push(canvasId)
      return [
        { executor: 'nano-banana', profileId: 'api-model', name: 'API 模型', modelId: 'model-1', mediaKind: 'image' as const, available: true },
        { executor: 'comfyui' as const, profileId: 'legacy-comfy', name: '旧预设', modelId: 'comfy-1',
          mediaKind: 'image' as const,
          mediaProfileId: 'legacy', mediaProfileRevision: 1, connectionId: 'gpu', workflowId: 'draft', workflowRevision: 1,
          workflowHash: 'a'.repeat(64), available: true },
      ]
    },
    ...(options.withSources ? {
      listSources: async () => [{ sourceRef: 'opaque:1', name: '附件', mediaKind: 'image' as const }],
      importAssets: async (_sourceContext: CanvasToolRunContext, sourceRefs: string[]): Promise<MediaAssetRef[]> => sourceRefs.map((sourceRef) => ({ assetId: `imported-${sourceRef.length}`, revision: 1, hash: 'c'.repeat(64), mediaKind: 'image' })),
    } : {}),
    ...(options.withLocalImport ? {
      importLocalFile: async (_sourceContext: CanvasToolRunContext, input: { path: string; mediaKind: 'image' | 'audio' | 'video' }): Promise<MediaAssetRef> => {
        importedLocalFiles.push(structuredClone(input))
        return { assetId: 'imported-local', revision: 1, hash: 'e'.repeat(64), mediaKind: input.mediaKind }
      },
    } : {}),
    ...(options.withAssetFile ? {
      getAssetFile: async (_assetContext: CanvasToolRunContext, asset: MediaAssetRef) => {
        resolvedAssetFiles.push(structuredClone(asset))
        /** 测试 Host 固定返回图片公开记录，验证工具不自行拼装路径或元数据。 */
        const record: MediaAssetRecord = {
          id: asset.assetId, revision: 1, hash: asset.hash, mediaKind: 'image',
          filename: 'asset-1.png', byteSize: 8, mediaType: 'image/png', createdAt: 1,
          metadata: { width: 100, height: 80 },
        }
        return {
          path: '/projects/demo/.proma/design/assets/asset-1.png',
          asset: structuredClone(asset),
          record,
        }
      },
    } : {}),
  }
  return { dependencies, calls, prepared, publishedProjectIds, importedDescriptors, importedLocalFiles, resolvedAssetFiles, modelScopes }
}

describe('媒体 Agent 工具提供器', () => {
  test('Given 项目草稿已保存 When 列出 Proma workflow 目录 Then 返回 I/O 摘要且不隐式选择首项', async () => {
    const f = fixture()
    const run = createMediaToolRun(f.dependencies, context)
    await executeTool(run.piCustomTools, 'media_save_workflow_draft', {
      id: 'draft', name: '草稿', expectedConfigRevision: 3, expectedWorkflowRevision: 0, definition: workflow,
    })
    const result = await executeTool(run.piCustomTools, 'media_list_workflows', { offset: 0, limit: 10 })
    expect(result.details).toMatchObject({
      selectedWorkflow: null,
      workflows: [{ id: 'draft', revision: 1, projectId: 'project-1',
        inputs: [], outputs: [{ key: 'main', mediaType: 'image' }] }],
    })
  })

  test('Given 远端 workflow 与 asset 已发现 When Agent 读取和导入 Then 保留精确 descriptor 且发现本身无副作用', async () => {
    const f = fixture()
    const run = createMediaToolRun(f.dependencies, context)
    const workflows = await executeTool(run.piCustomTools, 'media_list_resources', { connectionId: 'gpu', kind: 'workflows', offset: 0, limit: 10 })
    const workflowItem = (workflows.details as { items: Array<{ descriptor: MediaRemoteDescriptor }> }).items[0]!
    expect(workflows.details).toMatchObject({ capability: 'available', source: 'user-data', nextOffset: null })
    expect(workflowItem).toMatchObject({ descriptor: { instanceGeneration: 'instance-1', remoteUser: 'user-1', workflowPath: 'workflow-0.json' } })
    const workflowSummary = (workflowItem as unknown as { workflow: {
      format: string; executable: boolean; validationStatus: string; inputs: unknown[]; outputs: unknown[]
    } }).workflow
    expect(workflowSummary.format).toBe('api')
    expect(workflowSummary).toMatchObject({ executable: false, validationStatus: 'unverified' })
    expect(workflowSummary.inputs).toContainEqual(expect.objectContaining({ nodeId: '1', input: 'ckpt_name', valueKind: 'string' }))
    expect(workflowSummary.outputs).toEqual([{ nodeId: '2', mediaType: 'image' }])
    expect(f.importedDescriptors).toEqual([])

    const read = await executeTool(run.piCustomTools, 'media_read_remote_workflow', { descriptor: workflowItem.descriptor })
    expect(read.details).toMatchObject({ descriptor: workflowItem.descriptor, format: 'api' })

    const assets = await executeTool(run.piCustomTools, 'media_list_resources', { connectionId: 'gpu', kind: 'assets', offset: 0, limit: 10 })
    const assetItem = (assets.details as { items: Array<{ descriptor: MediaRemoteDescriptor }> }).items[0]!
    await executeTool(run.piCustomTools, 'media_import_remote_asset', { descriptor: assetItem.descriptor, maxBytes: 1024 })
    expect(f.importedDescriptors).toEqual([assetItem.descriptor])
  })

  test('Given Agent 明确发布公共 workflow When 有执行权限 Then 保存 projectId null；缺少意图或父编排越权均拒绝', async () => {
    const f = fixture()
    const run = createMediaToolRun(f.dependencies, context)
    await expect(executeTool(run.piCustomTools, 'media_publish_workflow', {
      id: 'public-flow', name: '公共图', expectedConfigRevision: 3, expectedWorkflowRevision: 0,
      publishIntent: 'implicit', definition: workflow,
    })).rejects.toThrow()
    await executeTool(run.piCustomTools, 'media_publish_workflow', {
      id: 'public-flow', name: '公共图', expectedConfigRevision: 3, expectedWorkflowRevision: 0,
      publishIntent: 'explicit', definition: workflow,
    })
    expect(f.publishedProjectIds).toEqual([null])

    const parent = createMediaToolRun(fixture().dependencies, { ...context, canvasAgentMode: 'parent-orchestrated' })
    expect(parent.allowedToolNames).not.toContain('media_publish_workflow')
  })

  test('Given 普通 Agent 与 Canvas Agent When 查询 API 模型 Then Host 接收权威 canvas scope 且不混入旧 Comfy profile', async () => {
    const f = fixture()
    const ordinary = createMediaToolRun(f.dependencies, context)
    const ordinaryModels = await executeTool(ordinary.piCustomTools, 'media_list_api_models', { canvasId: 'canvas-ordinary' })
    expect(ordinaryModels.details).toMatchObject({ models: [{ profileId: 'api-model', executor: 'nano-banana', mediaKind: 'image' }], selectedModelId: null })
    const canvas = createMediaToolRun(f.dependencies, { ...context,
      canvasAgentTarget: { projectId: 'project-1', canvasId: 'canvas-1', nodeId: 'agent-1' } })
    await executeTool(canvas.piCustomTools, 'media_list_api_models', {})
    expect(f.modelScopes).toEqual(['canvas-ordinary', 'canvas-1'])

    const parent = createMediaToolRun(f.dependencies, { ...context, canvasAgentMode: 'parent-orchestrated',
      canvasAgentTarget: { projectId: 'project-1', canvasId: 'canvas-parent', nodeId: 'agent-child' } })
    expect(parent.allowedToolNames).not.toContain('media_publish_workflow')
    await expect(executeTool(parent.piCustomTools, 'media_list_api_models', { canvasId: 'canvas-other' }))
      .rejects.toThrow('MEDIA_MODEL_SCOPE_INVALID')
    expect(f.modelScopes).toEqual(['canvas-ordinary', 'canvas-1'])
  })

  test('Given 普通交互 Agent When 注入工具 Then 形成草稿、预设、准备与执行闭环且身份来自 Host', async () => {
    const f = fixture()
    const run = createMediaToolRun(f.dependencies, context)
    expect(run.allowedToolNames).toEqual([...MEDIA_TOOL_NAMES])
    expect(run.singleApprovalToolNames).toEqual(['media_execute_run', 'media_cancel_run'])
    const saved = await executeTool(run.piCustomTools, 'media_save_workflow_draft', { id: 'draft', name: '草稿', expectedConfigRevision: 3, expectedWorkflowRevision: 0, definition: workflow })
    expect(saved.details).toMatchObject({ id: 'draft', revision: 1 })
    const profile = await executeTool(run.piCustomTools, 'media_save_profile', { id: 'profile', name: '图片', connectionId: 'gpu', workflowId: 'draft', workflowRevision: 1, mediaKind: 'image', enabled: true, expectedConfigRevision: 4 })
    expect(profile.details).toMatchObject({ id: 'profile', revision: 1 })
    const prepared = await executeTool(run.piCustomTools, 'media_prepare_run', { operationId: 'untrusted', profileId: 'profile', profileRevision: 1, inputs: {} })
    const runId = (prepared.details as MediaRunSnapshot).id
    expect(runId).toMatch(/^run-[a-f0-9]{64}$/)
    expect(prepared.details).toMatchObject({ phase: 'prepared' })
    const executed = await executeTool(run.piCustomTools, 'media_execute_run', { runId, expectedRevision: 0 })
    expect(executed.details).toMatchObject({ id: runId })
    expect(f.calls.map((item) => item.operation)).toEqual(['draft', 'draft', 'publish', 'publish', 'prepare', 'prepare', 'execute', 'execute'])
  })

  test('Given plan 与父编排运行 When 发现或事后调用执行工具 Then schema 与执行器都拒绝', async () => {
    const f = fixture()
    const mutable = { ...context }
    const ordinary = createMediaToolRun(f.dependencies, mutable)
    mutable.permissionCeiling = 'plan'
    await expect(executeTool(ordinary.piCustomTools, 'media_execute_run', { runId: 'run-op', expectedRevision: 0 })).rejects.toThrow('MEDIA_EXECUTE_INTENT_REQUIRED')
    const plan = createMediaToolRun(f.dependencies, { ...context, permissionCeiling: 'plan' })
    expect(plan.allowedToolNames).not.toContain('media_execute_run')
    expect(plan.allowedToolNames).not.toContain('media_cancel_run')
    const parent = createMediaToolRun(f.dependencies, { ...context, canvasAgentMode: 'parent-orchestrated', canvasAgentTarget: { projectId: 'project-1', canvasId: 'canvas-1', nodeId: 'node-1' } })
    expect(parent.allowedToolNames).not.toContain('media_execute_run')
    expect(parent.allowedToolNames).not.toContain('media_cancel_run')
    expect(parent.allowedToolNames).not.toContain('media_save_profile')
    mutable.permissionCeiling = 'execute'
    mutable.canvasAgentMode = 'parent-orchestrated'
    await expect(executeTool(ordinary.piCustomTools, 'media_save_profile', {})).rejects.toThrow('MEDIA_PUBLISH_NOT_AUTHORIZED')
  })

  test('Given parent workflow Canvas Agent When 准备直接媒体下游 Then Host 注入真实父身份且不调用普通 prepare', async () => {
    const f = fixture()
    const captured: Array<{ context: CanvasToolRunContext; targetNodeId: string; origin: unknown }> = []
    f.dependencies.prepareParentRun = async (runContext, input, origin) => {
      captured.push({ context: runContext, targetNodeId: input.targetNodeId, origin })
      return {
        id: 'a'.repeat(48), projectId: 'project-1', revision: 0, phase: 'prepared', profileId: 'profile', profileRevision: 1,
        createdAt: 1, updatedAt: 1, outputs: [], error: null, progress: null,
      }
    }
    const parentContext: CanvasToolRunContext = {
      ...context, sessionId: 'child-session', canvasAgentMode: 'parent-orchestrated',
      canvasAgentTarget: { projectId: 'project-1', canvasId: 'canvas-1', nodeId: 'agent-child' },
      parentWorkflow: { runId: 'b'.repeat(48), parentSessionId: 'parent-session' },
    }
    const run = createMediaToolRun(f.dependencies, parentContext)
    await executeTool(run.piCustomTools, 'media_prepare_run', {
      profileId: 'profile', profileRevision: 1, inputs: {}, targetNodeId: 'video-target',
    })
    expect(f.prepared).toEqual([])
    expect(captured).toEqual([{
      context: parentContext, targetNodeId: 'video-target',
      origin: { actor: { sessionId: 'child-session', runStartedAt: 42, mode: 'parent-orchestrated', canvasId: 'canvas-1', nodeId: 'agent-child' } },
    }])

    const missingParent = createMediaToolRun(f.dependencies, { ...parentContext, parentWorkflow: undefined })
    await expect(executeTool(missingParent.piCustomTools, 'media_prepare_run', {
      profileId: 'profile', profileRevision: 1, inputs: {}, targetNodeId: 'video-target',
    })).rejects.toThrow('MEDIA_PARENT_HANDOFF_REQUIRED')
  })

  test('Given parent child 保存项目草稿 When 用返回 ID 继续修订并准备 Then 不重复添加 branch 前缀', async () => {
    const f = fixture()
    const parentContext: CanvasToolRunContext = { ...context, sessionId: 'child-session', canvasAgentMode: 'parent-orchestrated',
      canvasAgentTarget: { projectId: 'project-1', canvasId: 'canvas-1', nodeId: 'agent-child' },
      parentWorkflow: { runId: 'b'.repeat(48), parentSessionId: 'parent-session' } }
    const run = createMediaToolRun(f.dependencies, parentContext)
    const first = await executeTool(run.piCustomTools, 'media_save_workflow_draft', {
      id: 'shot', name: '草稿', expectedConfigRevision: 3, expectedWorkflowRevision: 0, definition: workflow,
    })
    const firstId = (first.details as { id: string }).id
    const second = await executeTool(run.piCustomTools, 'media_save_workflow_draft', {
      id: firstId, name: '草稿2', expectedConfigRevision: 4, expectedWorkflowRevision: 1, definition: workflow,
    })
    expect((second.details as { id: string }).id).toBe(firstId)
    expect(firstId.match(/branch-/g)).toHaveLength(1)
  })

  test('Given 同轮已准备八个不同运行 When 第九次准备与重放 Then 新运行拒绝而重放不双扣', async () => {
    const f = fixture()
    const run = createMediaToolRun(f.dependencies, context)
    for (let index = 0; index < 8; index += 1) await executeTool(run.piCustomTools, 'media_prepare_run', { profileId: 'profile', profileRevision: 1, inputs: {} }, `call-${index}`)
    await expect(executeTool(run.piCustomTools, 'media_prepare_run', { profileId: 'profile', profileRevision: 1, inputs: {} }, 'call-8')).rejects.toThrow('MEDIA_RUN_BUDGET_EXCEEDED')
    await executeTool(run.piCustomTools, 'media_prepare_run', { profileId: 'profile', profileRevision: 1, inputs: {} }, 'call-0')
    expect(f.prepared).toHaveLength(9)
    expect(f.prepared[0]).toBe(f.prepared[8])
    expect(new Set(f.prepared).size).toBe(8)
  })

  test('Given 资源目录携带完整 schema 与超大名称 When Agent 分页查询 Then 仅返回摘要且响应保持完整 JSON 与 32KiB 上限', async () => {
    const f = fixture({ largeResources: true })
    const run = createMediaToolRun(f.dependencies, context)
    const result = await executeTool(run.piCustomTools, 'media_list_resources', { connectionId: 'gpu', kind: 'nodes', offset: 0, limit: 100 })
    const text = result.content[0]?.type === 'text' ? result.content[0].text : ''
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(32 * 1024)
    expect(() => JSON.parse(text)).not.toThrow()
    expect(JSON.stringify(result.details)).not.toContain('api_key')
    expect(result.details).toMatchObject({ truncated: true })
    const page = result.details as { items: unknown[]; nextOffset: number }
    expect(page.nextOffset).toBe(page.items.length)
    expect(page.nextOffset).toBeLessThan(100)
  })

  test('Given 完整定义或原始 API prompt When 分页检查 Then 都返回节点摘要且不回显整图', async () => {
    const f = fixture()
    const run = createMediaToolRun(f.dependencies, context)
    const full = await executeTool(run.piCustomTools, 'media_inspect_workflow', { connectionId: 'gpu', definition: workflow, offset: 0, limit: 1 })
    expect(full.details).toMatchObject({ totalNodes: 2, nextOffset: 1 })
    expect(JSON.stringify(full.details)).not.toContain('filename_prefix')
    const raw = await executeTool(run.piCustomTools, 'media_inspect_workflow', { connectionId: 'gpu', prompt: workflow.prompt, offset: 1, limit: 1 })
    expect(raw.details).toMatchObject({ totalNodes: 2, nextOffset: null })
  })

  test('Given 运行归属其它主体或取消缺少明确意图 When 执行敏感动作 Then 拒绝', async () => {
    const f = fixture()
    f.dependencies.runs.getOrigin = () => ({ actor: { sessionId: 'other', runStartedAt: 42, mode: 'project-agent' } })
    const run = createMediaToolRun(f.dependencies, context)
    await expect(executeTool(run.piCustomTools, 'media_execute_run', { runId: 'run-op', expectedRevision: 0 })).rejects.toThrow('MEDIA_RUN_NOT_OWNED')
    await expect(executeTool(run.piCustomTools, 'media_cancel_run', { runId: 'run-op', cancelIntent: 'implicit' })).rejects.toThrow()
  })

  test('Given 同一会话下一轮 When 查询既有运行 Then 可恢复原任务但其它会话不能访问', async () => {
    const f = fixture()
    const nextTurn = createMediaToolRun(f.dependencies, { ...context, runStartedAt: 84 })
    expect((await executeTool(nextTurn.piCustomTools, 'media_get_run', { runId: 'prior-run' })).details).toMatchObject({ id: 'prior-run' })
    const other = createMediaToolRun(f.dependencies, { ...context, sessionId: 'session-2' })
    await expect(executeTool(other.piCustomTools, 'media_get_run', { runId: 'prior-run' })).rejects.toThrow('MEDIA_RUN_NOT_OWNED')
  })

  test('Given 无现成工作流 When 按已发现节点读 schema Then 返回安全标量选项但隐藏 Loader 素材枚举', async () => {
    const f = fixture()
    f.dependencies.resources.getSchema = async () => ({
      KSampler: { input: { required: { sampler_name: [['euler', 'dpmpp_2m']], steps: ['INT', { default: 20, min: 1, max: 100 }] } }, output: ['LATENT'] },
      LoadImage: { input: { required: { image: [['private-input.png'], { image_upload: true, default: 'private-input.png' }] } }, output: ['IMAGE'] },
    })
    const run = createMediaToolRun(f.dependencies, context)
    const response = await executeTool(run.piCustomTools, 'media_get_node_schema', { connectionId: 'gpu', classTypes: ['KSampler', 'LoadImage'] })
    expect(JSON.stringify(response.details)).toContain('dpmpp_2m')
    expect(JSON.stringify(response.details)).toContain('"min":1')
    expect(JSON.stringify(response.details)).not.toContain('private-input.png')
  })

  test('Given 核心节点已安装但 schema 无法验证 When Agent 读取节点摘要 Then 明确标记为不支持', async () => {
    const f = fixture()
    f.dependencies.resources.getSchema = async () => ({
      LoadImage: { input: { required: {} }, output: [], unsupported: true },
    })
    const run = createMediaToolRun(f.dependencies, context)

    const response = await executeTool(run.piCustomTools, 'media_get_node_schema', {
      connectionId: 'gpu', classTypes: ['LoadImage'],
    })

    expect(response.details).toEqual({
      nodes: [{ classType: 'LoadImage', category: '', inputs: [], outputs: [], supported: false, unsupported: true }],
    })
  })

  test('Given Host 提供附件来源适配器 When 注入工具 Then 仅此时暴露 opaque 导入入口', async () => {
    const absent = createMediaToolRun(fixture().dependencies, context)
    expect(absent.allowedToolNames).not.toContain('media_list_sources')
    const present = createMediaToolRun(fixture({ withSources: true }).dependencies, context)
    expect(present.allowedToolNames).toContain('media_list_sources')
    const sources = await executeTool(present.piCustomTools, 'media_list_sources', {})
    expect(sources.details).toEqual({ sources: [{ sourceRef: 'opaque:1', name: '附件', mediaKind: 'image' }], truncated: false })
    const imported = await executeTool(present.piCustomTools, 'media_import_assets', { sourceRefs: ['opaque:1'] })
    expect(imported.details).toMatchObject({ assets: [{ assetId: 'imported-8' }] })
  })

  test('Given Host 提供本地文件导入 When 普通 Agent 明确指定媒体文件 Then 双重授权后返回统一资产引用', async () => {
    const f = fixture({ withLocalImport: true })
    const run = createMediaToolRun(f.dependencies, context)
    expect(run.allowedToolNames).toContain('media_import_local_file')

    const result = await executeTool(run.piCustomTools, 'media_import_local_file', {
      path: 'outputs/final.mp4', mediaKind: 'video',
    })

    expect(result.details).toEqual({ asset: {
      assetId: 'imported-local', revision: 1, hash: 'e'.repeat(64), mediaKind: 'video',
    }, truncated: false })
    expect(f.importedLocalFiles).toEqual([{ path: 'outputs/final.mp4', mediaKind: 'video' }])
    expect(f.calls.slice(-2)).toEqual([{ operation: 'prepare' }, { operation: 'prepare' }])
  })

  test('Given 普通或 Canvas Agent 持有可信资产引用 When 获取文件 Then 只读返回 Host 验证后的路径和元数据', async () => {
    const f = fixture({ withAssetFile: true })
    const modes = [
      context,
      { ...context, permissionCeiling: 'plan' as const },
      { ...context, canvasAgentMode: 'renderer-manual' as const,
        canvasAgentTarget: { projectId: 'project-1', canvasId: 'canvas-1', nodeId: 'node-1' } },
    ]
    for (const mode of modes) {
      const run = createMediaToolRun(f.dependencies, mode)
      expect(run.allowedToolNames).toContain('media_get_asset_file')
      const result = await executeTool(run.piCustomTools, 'media_get_asset_file', {
        asset: { assetId: 'asset-1', revision: 1, hash: 'b'.repeat(64), mediaKind: 'image' },
      })
      expect(result.details).toMatchObject({ file: {
        path: '/projects/demo/.proma/design/assets/asset-1.png',
        asset: { assetId: 'asset-1', revision: 1, mediaKind: 'image' },
        record: { filename: 'asset-1.png', byteSize: 8, mediaType: 'image/png' },
      } })
    }
    expect(f.resolvedAssetFiles).toHaveLength(3)

    const absent = createMediaToolRun(fixture().dependencies, context)
    const parent = createMediaToolRun(f.dependencies, { ...context, canvasAgentMode: 'parent-orchestrated',
      canvasAgentTarget: { projectId: 'project-1', canvasId: 'canvas-1', nodeId: 'node-1' } })
    expect(absent.allowedToolNames).not.toContain('media_get_asset_file')
    expect(parent.allowedToolNames).not.toContain('media_get_asset_file')

    /** 工具发现后上下文被降为父编排模式时，执行边界仍必须拒绝路径解析。 */
    const mutableContext: CanvasToolRunContext = { ...context }
    const discovered = createMediaToolRun(f.dependencies, mutableContext)
    mutableContext.canvasAgentMode = 'parent-orchestrated'
    await expect(executeTool(discovered.piCustomTools, 'media_get_asset_file', {
      asset: { assetId: 'asset-1', revision: 1, hash: 'b'.repeat(64), mediaKind: 'image' },
    })).rejects.toThrow('MEDIA_ASSET_FILE_NOT_AUTHORIZED')
  })

  test('Given plan 或父编排 Agent When 发现本地文件导入 Then schema 不暴露该写入能力', () => {
    const f = fixture({ withLocalImport: true })
    const plan = createMediaToolRun(f.dependencies, { ...context, permissionCeiling: 'plan' })
    const parent = createMediaToolRun(f.dependencies, { ...context, canvasAgentMode: 'parent-orchestrated',
      canvasAgentTarget: { projectId: 'project-1', canvasId: 'canvas-1', nodeId: 'node-1' } })

    expect(plan.allowedToolNames).not.toContain('media_import_local_file')
    expect(parent.allowedToolNames).not.toContain('media_import_local_file')
  })
})
