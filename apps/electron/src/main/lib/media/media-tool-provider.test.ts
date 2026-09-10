import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { ComfyObjectInfo, MediaAssetRecord, MediaAssetRef, MediaProjectCatalog, MediaRemoteDescriptor, MediaRunSnapshot, MediaWorkflowDefinition, MediaWorkflowVersion } from '@proma/shared'
import type { CanvasToolRunContext } from '../design/canvas-tool-provider'
import { createMediaToolRun, MEDIA_TOOL_NAMES, type MediaToolProviderDependencies } from './media-tool-provider'
import { MediaWorkflowValidationError } from './media-workflow-error'

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
  /** 自动接入只保存内部快照，独立观察其与用户模板写入的区别。 */
  const cachedWorkflows: MediaWorkflowVersion[] = []
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
      cacheRemoteWorkflow: (input) => {
        /** 模拟 Host 已规范化的稳定快照回执，持久化去重另由真实 Store 测试覆盖。 */
        const cached: MediaWorkflowVersion = { id: 'remote-snapshot', name: input.name, projectId: input.projectId,
          revision: 1, hash: 'f'.repeat(64), createdAt: 1, definition: input.definition,
          remoteSource: { descriptor: input.descriptor, contentHash: input.contentHash } }
        cachedWorkflows.push(cached)
        return cached
      },
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
  return { dependencies, calls, prepared, publishedProjectIds, importedDescriptors, importedLocalFiles, resolvedAssetFiles, modelScopes, cachedWorkflows }
}

describe('媒体 Agent 工具提供器', () => {
  test('Given 用户切换生成授权 When 同一 Agent 再次调用 Then 仅媒体与画布运行工具读取最新策略', () => {
    /** 同轮修改设置，验证工具策略不是启动时的旧快照。 */
    const f = fixture()
    const read = f.dependencies.configuration.read
    let authorizationMode: 'ask' | 'automatic' = 'ask'
    f.dependencies.configuration.read = () => ({ ...read(), authorizationMode })
    const run = createMediaToolRun(f.dependencies, context)
    expect(run.toolApprovalPolicy?.getMode('media_execute_run')).toBe('ask')
    authorizationMode = 'automatic'
    for (const name of ['media_execute_run', 'media_cancel_run', 'canvas_run_nodes', 'canvas_run_workflow', 'canvas_resume_workflow', 'canvas_retry_task']) {
      expect(run.toolApprovalPolicy?.getMode(name)).toBe('automatic')
    }
    expect(run.toolApprovalPolicy?.getMode('server_exec')).toBe('ask')
    expect(createMediaToolRun(f.dependencies, { ...context, permissionCeiling: 'plan' }).toolApprovalPolicy?.getMode('media_execute_run')).toBe('ask')
    authorizationMode = 'ask'
    expect(run.toolApprovalPolicy?.getMode('media_execute_run')).toBe('ask')
  })

  test('Given 自主模式且远端完整目录无匹配 When 发现结束 Then 允许根据真实资源新建而不再要求对话确认', async () => {
    /** 空目录是真实无匹配，筛选结果仍不能授予自动新建。 */
    const f = fixture()
    const read = f.dependencies.configuration.read
    f.dependencies.configuration.read = () => ({ ...read(), authorizationMode: 'automatic' })
    f.dependencies.resources.list = async (input) => ({ connectionId: input.connectionId, instanceGeneration: 'instance-1',
      remoteUser: 'user-1', source: 'user-data', snapshotId: 'empty', checkedAt: 1, capability: 'available',
      total: 0, nextOffset: null, items: [] })
    const run = createMediaToolRun(f.dependencies, context)
    const result = await executeTool(run.piCustomTools, 'media_discover_workflows', { connectionId: 'gpu', mediaKind: 'video' })
    expect(result.details).toMatchObject({ authorizationMode: 'automatic', discovery: {
      status: 'no-match', requiresUserConfirmation: false, canCreateWorkflowAutomatically: true,
    } })
    const filtered = await executeTool(run.piCustomTools, 'media_discover_workflows', { connectionId: 'gpu', mediaKind: 'video', query: 'video' })
    expect(filtered.details).toMatchObject({ discovery: { status: 'incomplete', canCreateWorkflowAutomatically: false } })
    expect(f.publishedProjectIds).toEqual([])
  })

  test('Given 自主模式工作流保存 When 模式在节点读取期间被收回 Then 保存前重新检查并拒绝', async () => {
    /** 模拟跨网络等待期间用户撤回自动授权，不允许旧策略继续写入。 */
    const f = fixture()
    const read = f.dependencies.configuration.read
    let authorizationMode: 'ask' | 'automatic' = 'automatic'
    /** 确认已进入异步服务器读取后撤回，而非入口提前拒绝。 */
    let schemaRead = false
    f.dependencies.configuration.read = () => ({ ...read(), authorizationMode })
    f.dependencies.resources.getSchema = async () => {
      schemaRead = true
      authorizationMode = 'ask'
      return schema
    }
    const run = createMediaToolRun(f.dependencies, context)
    await expect(executeTool(run.piCustomTools, 'media_save_local_workflow', {
      id: 'local', name: '本地模板', connectionId: 'gpu', definition: workflow, creationIntent: 'automatic-policy',
      expectedConfigRevision: 3, expectedWorkflowRevision: 0,
    })).rejects.toThrow('MEDIA_WORKFLOW_CREATION_CONFIRMATION_REQUIRED')
    expect(schemaRead).toBe(true)
    expect(f.publishedProjectIds).toEqual([])
  })

  test('Given 服务器已有可用工作流 When 直接使用 Then Host 创建执行快照且无需模板 ID 或发布', async () => {
    /** 完整的远端图和节点接口，确保接入经过真实分析器。 */
    const f = fixture()
    f.dependencies.resources.getSchema = async () => ({
      LoadImage: { input: { required: { image: [['source.png']] } }, output: ['IMAGE', 'MASK'] },
      SaveImage: schema.SaveImage!,
    })
    f.dependencies.resources.readWorkflow = async (descriptor) => ({ descriptor, format: 'api', definition: {
      '1': { class_type: 'LoadImage', inputs: { image: 'source.png' } },
      '2': { class_type: 'SaveImage', inputs: { images: ['1', 0], filename_prefix: 'Proma' } },
    } })
    /** 用户只选择远端身份与发现时的内容版本。 */
    const run = createMediaToolRun(f.dependencies, context)
    const found = await executeTool(run.piCustomTools, 'media_discover_workflows', { connectionId: 'gpu', mediaKind: 'image', inputKinds: ['image'] })
    const candidate = (found.details as { items: Array<{ descriptor: MediaRemoteDescriptor; contentHash: string }> }).items[0]!
    const used = await executeTool(run.piCustomTools, 'media_use_remote_workflow', candidate)
    expect(used.details).toMatchObject({ id: 'remote-snapshot', revision: 1, connectionId: 'gpu', source: 'comfyui-server' })
    expect(f.cachedWorkflows).toHaveLength(1)
    expect(f.cachedWorkflows[0]?.definition.prompt['1']?.inputs.image).toBe('')
    expect(f.publishedProjectIds).toEqual([])
    expect(f.prepared).toEqual([])
    await expect(executeTool(run.piCustomTools, 'media_use_remote_workflow', { ...candidate, contentHash: '0'.repeat(64) }))
      .rejects.toThrow('MEDIA_REMOTE_WORKFLOW_CHANGED')
    expect(f.cachedWorkflows).toHaveLength(1)
  })

  test('Given 未过滤的远端目录确认无匹配 When 发现结束 Then 提醒征求生成许可且不自动保存', async () => {
    const f = fixture()
    f.dependencies.resources.list = async (input) => ({ connectionId: input.connectionId, instanceGeneration: 'instance-1',
      remoteUser: 'user-1', source: 'user-data', snapshotId: 'empty', checkedAt: 1, capability: 'available',
      total: 0, nextOffset: null, items: [] })
    const run = createMediaToolRun(f.dependencies, context)
    const result = await executeTool(run.piCustomTools, 'media_discover_workflows', { connectionId: 'gpu', mediaKind: 'video' })
    expect(result.details).toMatchObject({ discovery: { status: 'no-match', requiresUserConfirmation: true } })
    expect(JSON.stringify(result.details)).toContain('是否根据当前服务器已有的模型和节点生成工作流')
    expect(f.publishedProjectIds).toEqual([])
    const filtered = await executeTool(run.piCustomTools, 'media_discover_workflows', { connectionId: 'gpu', mediaKind: 'video', query: 'minimax' })
    expect(filtered.details).toMatchObject({ discovery: { status: 'incomplete', requiresUserConfirmation: false } })
  })

  test('Given 分页未完成或目录失败 When 没有候选 Then 不把未知结果当作无匹配', async () => {
    const f = fixture()
    /** 返回可观察的两页空结果；第二页失败不能提供新建许可。 */
    f.dependencies.resources.list = async (input) => ({ connectionId: input.connectionId, instanceGeneration: 'instance-1',
      remoteUser: 'user-1', source: 'user-data', snapshotId: 'partial', checkedAt: 1,
      capability: input.offset ? 'failed' : 'available', total: 2, nextOffset: input.offset ? null : 1, items: [] })
    const run = createMediaToolRun(f.dependencies, context)
    const first = await executeTool(run.piCustomTools, 'media_discover_workflows', { connectionId: 'gpu', mediaKind: 'video', limit: 1 })
    expect(first.details).toMatchObject({ discovery: { status: 'incomplete', requiresUserConfirmation: false } })
    const last = await executeTool(run.piCustomTools, 'media_discover_workflows', { connectionId: 'gpu', mediaKind: 'video', limit: 1, offset: 1 })
    expect(last.details).toMatchObject({ discovery: { status: 'unavailable', requiresUserConfirmation: false } })
  })

  test('Given 用户未同意新建 When 保存本地工作流 Then 在读取服务器或写入前拒绝', async () => {
    const f = fixture()
    const run = createMediaToolRun(f.dependencies, context)
    await expect(executeTool(run.piCustomTools, 'media_save_local_workflow', {
      id: 'local', name: '本地模板', connectionId: 'gpu', definition: workflow,
      expectedConfigRevision: 3, expectedWorkflowRevision: 0,
    })).rejects.toThrow('MEDIA_WORKFLOW_CREATION_CONFIRMATION_REQUIRED')
    expect(f.publishedProjectIds).toEqual([])
  })

  test('Given 历史草稿工具被用来新建工作流 When 没有用户确认 Then 普通与父编排调用都不能绕过确认', async () => {
    for (const canvasAgentMode of [undefined, 'parent-orchestrated'] as const) {
      const f = fixture()
      const run = createMediaToolRun(f.dependencies, { ...context, canvasAgentMode })
      await expect(executeTool(run.piCustomTools, 'media_save_workflow_draft', {
        id: 'legacy', name: '项目旧流程', expectedConfigRevision: 3, expectedWorkflowRevision: 0, definition: workflow,
      })).rejects.toThrow('MEDIA_WORKFLOW_CREATION_CONFIRMATION_REQUIRED')
      expect(f.publishedProjectIds).toEqual([])
    }
  })

  test('Given 连续两页均不匹配 When 完成全部页检查 Then 才允许提示用户确认新建', async () => {
    const f = fixture()
    /** 原资源页只生成稳定描述符，测试按页替换目录总数与游标。 */
    const listPage = f.dependencies.resources.list
    f.dependencies.resources.list = async (input) => ({ ...await listPage(input), total: 2, nextOffset: input.offset ? null : 1 })
    f.dependencies.resources.getSchema = async () => ({
      LoadImage: { input: { required: { image: [['source.png']] } }, output: ['IMAGE', 'MASK'] }, SaveImage: schema.SaveImage!,
    })
    f.dependencies.resources.readWorkflow = async (descriptor) => ({ descriptor, format: 'api', definition: {
      '1': { class_type: 'LoadImage', inputs: { image: 'source.png' } },
      '2': { class_type: 'SaveImage', inputs: { images: ['1', 0], filename_prefix: 'Proma' } },
    } })
    const run = createMediaToolRun(f.dependencies, context)
    const first = await executeTool(run.piCustomTools, 'media_discover_workflows', { connectionId: 'gpu', mediaKind: 'video', limit: 1 })
    expect(first.details).toMatchObject({ discovery: { status: 'incomplete' }, nextOffset: 1 })
    const last = await executeTool(run.piCustomTools, 'media_discover_workflows', { connectionId: 'gpu', mediaKind: 'video', limit: 1, offset: 1 })
    expect(last.details).toMatchObject({ discovery: { status: 'no-match', requiresUserConfirmation: true }, nextOffset: null })

    /** 响应字节预算截短末页时，尚未交给 Agent 的条目不能算作已完成检查。 */
    f.dependencies.resources.list = async (input) => {
      const page = await listPage(input)
      return { ...page, total: 2, nextOffset: null, items: [
        { ...page.items[0]!, name: 'a'.repeat(18000) }, { ...page.items[0]!, name: 'b'.repeat(18000) },
      ] }
    }
    const bounded = await executeTool(run.piCustomTools, 'media_discover_workflows', { connectionId: 'gpu', mediaKind: 'video' })
    expect(bounded.details).toMatchObject({ discovery: { status: 'incomplete', requiresUserConfirmation: false }, nextOffset: 1 })
  })

  test('Given 用户同意新建但节点连线类型不匹配 When 保存本地工作流 Then 暴露校验原因且不写入', async () => {
    const f = fixture()
    const run = createMediaToolRun(f.dependencies, context)
    await expect(executeTool(run.piCustomTools, 'media_save_local_workflow', {
      id: 'local', name: '本地模板', connectionId: 'gpu', definition: workflow, creationIntent: 'user-confirmed',
      expectedConfigRevision: 3, expectedWorkflowRevision: 0,
    })).rejects.toThrow('LINK_TYPE_INVALID')
    expect(f.publishedProjectIds).toEqual([])
  })

  test('Given 生成图引用服务器没有的模型或节点 When 确认保存 Then 拒绝虚构资源并返回可定位原因', async () => {
    for (const missing of ['model', 'node'] as const) {
      /** 两类缺失分别验证服务器枚举和节点存在性，均不得落盘。 */
      const f = fixture()
      const definition = structuredClone(workflow)
      if (missing === 'model') definition.prompt['1']!.inputs.ckpt_name = 'not-installed.safetensors'
      else definition.prompt['1']!.class_type = 'NotInstalledNode'
      const run = createMediaToolRun(f.dependencies, context)
      await expect(executeTool(run.piCustomTools, 'media_save_local_workflow', {
        id: 'local', name: '本地模板', connectionId: 'gpu', definition, creationIntent: 'user-confirmed',
        expectedConfigRevision: 3, expectedWorkflowRevision: 0,
      })).rejects.toThrow(missing === 'model' ? 'INPUT_ENUM_INVALID@1.ckpt_name' : 'NODE_CLASS_UNKNOWN@1')
      expect(f.publishedProjectIds).toEqual([])
    }
  })

  test.each(['user-confirmed', 'automatic-policy'] as const)('Given 新建已通过 %s 授权且图匹配服务器接口 When 保存本地工作流 Then 创建模板而不提交生成', async (creationIntent) => {
    const f = fixture()
    /** 自主策略来自可信配置，不能只靠 Agent 参数提升权限。 */
    const read = f.dependencies.configuration.read
    if (creationIntent === 'automatic-policy') f.dependencies.configuration.read = () => ({ ...read(), authorizationMode: 'automatic' })
    f.dependencies.resources.getSchema = async () => ({
      LoadImage: { input: { required: { image: [['source.png']] } }, output: ['IMAGE', 'MASK'] },
      SaveImage: schema.SaveImage!,
    })
    /** 使用明确上传槽，模板不携带服务器素材文件名。 */
    const definition: MediaWorkflowDefinition = { schemaVersion: 1, prompt: {
      '1': { class_type: 'LoadImage', inputs: { image: '' } },
      '2': { class_type: 'SaveImage', inputs: { images: ['1', 0], filename_prefix: 'Proma' } },
    }, bindings: [{ key: 'source', nodeId: '1', input: 'image', kind: 'image', loader: 'LoadImage' }],
    outputs: [{ key: 'main', nodeId: '2', outputIndex: 0, mediaType: 'image' }] }
    const run = createMediaToolRun(f.dependencies, context)
    const saved = await executeTool(run.piCustomTools, 'media_save_local_workflow', {
      id: 'local', name: '本地模板', connectionId: 'gpu', definition, creationIntent,
      expectedConfigRevision: 3, expectedWorkflowRevision: 0,
    })
    expect(saved.details).toMatchObject({ source: 'local-template', saved: true })
    expect(f.publishedProjectIds).toEqual([null])
    expect(f.prepared).toEqual([])
    expect(createMediaToolRun(f.dependencies, { ...context, permissionCeiling: 'plan' }).allowedToolNames).not.toContain('media_save_local_workflow')
  })

  test('Given 历史会话仍调用远端导入 When 接入已有工作流 Then 复用内部快照而不再创建项目草稿', async () => {
    const f = fixture()
    f.dependencies.getCanvasConnection = () => 'gpu'
    /** 使用有效图片连线，验证整个导入链经过真实结构校验。 */
    const prompt = {
      '1': { class_type: 'LoadImage', inputs: { image: 'old-server-file.png' } },
      '2': { class_type: 'SaveImage', inputs: { images: ['1', 0], filename_prefix: 'old/prefix' } },
    }
    f.dependencies.resources.getSchema = async () => ({
      LoadImage: { input: { required: { image: [['old-server-file.png'], { image_upload: true }] } }, output: ['IMAGE', 'MASK'] },
      SaveImage: schema.SaveImage!,
    })
    f.dependencies.resources.readWorkflow = async (descriptor) => ({ descriptor, format: 'api', definition: prompt as unknown as import('@proma/shared').JsonObject })
    const run = createMediaToolRun(f.dependencies, context)
    const discovered = await executeTool(run.piCustomTools, 'media_discover_workflows', { canvasId: 'canvas-1', mediaKind: 'image', inputKinds: ['image'] })
    const candidate = (discovered.details as { items: Array<{ descriptor: MediaRemoteDescriptor; contentHash: string }> }).items[0]!
    expect(discovered.details).toMatchObject({ connectionId: 'gpu', items: [{ canImport: true, match: { matchesOutput: true, matchesInputs: true } }] })
    expect(candidate.contentHash).toBe(createHash('sha256').update(JSON.stringify(prompt)).digest('hex'))
    expect(f.publishedProjectIds).toEqual([])
    const imported = await executeTool(run.piCustomTools, 'media_import_remote_workflow', {
      descriptor: candidate.descriptor, expectedContentHash: candidate.contentHash,
      id: 'remote-draft', name: '远端图片流程', expectedConfigRevision: 3, expectedWorkflowRevision: 0,
    })
    expect(imported.details).toMatchObject({ id: 'remote-snapshot', revision: 1, source: 'comfyui-server', connectionId: 'gpu' })
    expect(f.publishedProjectIds).toEqual([])
    expect(f.cachedWorkflows).toHaveLength(1)
    expect(f.prepared).toEqual([])
    const mismatched = await executeTool(run.piCustomTools, 'media_discover_workflows', { connectionId: 'gpu', mediaKind: 'video', inputKinds: ['image', 'image'] })
    expect(mismatched.details).toMatchObject({ items: [{ match: { matchesOutput: false, matchesInputs: false } }] })
    await expect(executeTool(run.piCustomTools, 'media_import_remote_workflow', {
      descriptor: candidate.descriptor, expectedContentHash: '0'.repeat(64),
      id: 'remote-draft', name: '远端图片流程', expectedConfigRevision: 4, expectedWorkflowRevision: 1,
    })).rejects.toThrow('MEDIA_REMOTE_WORKFLOW_CHANGED')
    expect(f.cachedWorkflows).toHaveLength(1)
  })

  test('Given 远端目录单个文件无法读取 When 分页发现 Then 保留失败条目与后续游标且不扫描整库', async () => {
    const f = fixture()
    /** 记录请求页宽，避免发现功能默认加载整个目录。 */
    const list = f.dependencies.resources.list
    const requestedLimits: number[] = []
    f.dependencies.resources.list = async (input) => {
      requestedLimits.push(input.limit!)
      return { ...await list(input), total: 12, nextOffset: 1 }
    }
    f.dependencies.resources.readWorkflow = async () => { throw new Error('read failure') }
    const run = createMediaToolRun(f.dependencies, context)
    const result = await executeTool(run.piCustomTools, 'media_discover_workflows', { connectionId: 'gpu', mediaKind: 'video', limit: 1 })
    expect(result.details).toMatchObject({ nextOffset: 1, total: 12, items: [{ canImport: false, issues: [{ code: 'REMOTE_WORKFLOW_READ_FAILED' }] }] })
    expect(requestedLimits).toEqual([1])
    expect(f.publishedProjectIds).toEqual([])
  })

  test('Given 调用方绕过工具参数 schema When 请求越界页宽 Then 在读取远端目录前拒绝', async () => {
    const f = fixture()
    /** 记录目录读取，证明无效页宽不会扩大实际网络与解析负载。 */
    let reads = 0
    const list = f.dependencies.resources.list
    f.dependencies.resources.list = async (input) => { reads += 1; return list(input) }
    const run = createMediaToolRun(f.dependencies, context)
    for (const limit of [0, 7, 100, 1.5]) {
      await expect(executeTool(run.piCustomTools, 'media_discover_workflows', {
        connectionId: 'gpu', mediaKind: 'image', limit,
      })).rejects.toThrow('MEDIA_DISCOVERY_PAGE_INVALID')
    }
    expect(reads).toBe(0)
  })

  test('Given 合法工作流包含长节点身份和多输入输出 When 使用服务器工作流 Then 成功回执保留版本且不超过预算', async () => {
    const f = fixture()
    /** 达到合法字段边界的静态第三方节点，复现完整元数据超出 32 KiB。 */
    const classType = 'C'.repeat(256)
    const input = 'i'.repeat(80)
    const prompt: import('@proma/shared').ComfyPrompt = {}
    for (let index = 0; index < 24; index += 1) {
      const nodeId = 'n'.repeat(168) + String(index).padStart(2, '0')
      prompt[nodeId] = { class_type: classType, inputs: { [input]: 'value' } }
    }
    for (let index = 0; index < 16; index += 1) {
      const nodeId = 's'.repeat(246) + String(index).padStart(2, '0')
      prompt[nodeId] = { class_type: 'SaveImage', inputs: { images: ['n'.repeat(168) + '00', 0], filename_prefix: 'Proma' } }
    }
    f.dependencies.resources.getSchema = async () => ({
      [classType]: { input: { required: { [input]: ['STRING'] } }, output: ['IMAGE'] },
      SaveImage: schema.SaveImage!,
    })
    f.dependencies.resources.readWorkflow = async (descriptor) => ({ descriptor, format: 'api', definition: prompt as unknown as import('@proma/shared').JsonObject })
    const run = createMediaToolRun(f.dependencies, context)
    const result = await executeTool(run.piCustomTools, 'media_import_remote_workflow', {
      descriptor: { connectionId: 'gpu', instanceGeneration: 'instance-1', remoteUser: 'user-1', source: 'user-data', id: 'large.json', workflowPath: 'large.json' },
      expectedContentHash: createHash('sha256').update(JSON.stringify(prompt)).digest('hex'),
      id: 'large-draft', name: '大型工作流', expectedConfigRevision: 3, expectedWorkflowRevision: 0,
    })
    expect(result.details).toMatchObject({ source: 'comfyui-server', id: 'remote-snapshot', revision: 1, connectionId: 'gpu' })
    expect(Buffer.byteLength(JSON.stringify(result.details), 'utf8')).toBeLessThanOrEqual(32 * 1024)
    expect(f.publishedProjectIds).toEqual([])
    expect(f.prepared).toEqual([])
  })

  test('Given 远端 API 大图正文超过预算 When 逐页精读 Then 可读完所有节点与连线且不保存或执行', async () => {
    const f = fixture()
    /** 长默认文本使整图超限，但每个节点和输入仍合法可分析。 */
    const prompt: import('@proma/shared').ComfyPrompt = {}
    for (let index = 0; index < 40; index += 1) {
      prompt[String(index)] = { class_type: 'InstalledCustom', inputs: { text: 'x'.repeat(1000) } }
    }
    prompt.output = { class_type: 'SaveImage', inputs: { images: ['39', 0], filename_prefix: 'Proma' } }
    f.dependencies.resources.getSchema = async () => ({
      InstalledCustom: { input: { required: { text: ['STRING'] } }, output: ['IMAGE'] },
      SaveImage: schema.SaveImage!,
    })
    f.dependencies.resources.readWorkflow = async (descriptor) => ({ descriptor, format: 'api', definition: prompt as unknown as import('@proma/shared').JsonObject })
    const descriptor: MediaRemoteDescriptor = { connectionId: 'gpu', instanceGeneration: 'instance-1', remoteUser: 'user-1', source: 'user-data', id: 'large.json', workflowPath: 'large.json' }
    const run = createMediaToolRun(f.dependencies, context)
    /** 模拟 Agent 沿真实游标读取全部节点，首调不传分页也应自动降为可继续精读的摘要。 */
    const nodeIds: string[] = []
    let offset: number | null = 0
    do {
      const result = await executeTool(run.piCustomTools, 'media_read_remote_workflow', {
        descriptor, ...(offset === 0 ? {} : { section: 'nodes', offset, limit: 8 }),
      })
      expect(Buffer.byteLength(JSON.stringify(result.details), 'utf8')).toBeLessThanOrEqual(32 * 1024)
      const page = result.details as { section: string; items: Array<{ nodeId: string }>; nextOffset: number | null }
      expect(page.section).toBe('nodes')
      nodeIds.push(...page.items.map((item) => item.nodeId))
      offset = page.nextOffset
    } while (offset !== null)
    expect(nodeIds).toEqual(Object.keys(prompt))
    const inputs = await executeTool(run.piCustomTools, 'media_read_remote_workflow', { descriptor, section: 'inputs', offset: 40, limit: 8 })
    expect(inputs.details).toMatchObject({ section: 'inputs', items: [
      { nodeId: 'output', input: 'images', source: { nodeId: '39', outputIndex: 0 } },
      { nodeId: 'output', input: 'filename_prefix' },
    ], nextOffset: null })
    expect(f.publishedProjectIds).toEqual([])
    expect(f.prepared).toEqual([])
  })

  test('Given 工作流存在转换问题 When Agent 分页读取 issues Then 可读完安全定位且显式导入抛出真实工具错误', async () => {
    const f = fixture()
    /** 未安装节点会产生可定位分析问题，远端异常正文不得进入工具错误。 */
    const prompt = {
      'secret-node': { class_type: 'MissingNode', inputs: { token: 'Bearer should-not-leak' } },
    }
    f.dependencies.resources.getSchema = async () => ({})
    f.dependencies.resources.readWorkflow = async (descriptor) => ({
      descriptor,
      format: 'api',
      definition: prompt as unknown as import('@proma/shared').JsonObject,
    })
    const descriptor: MediaRemoteDescriptor = {
      connectionId: 'gpu', instanceGeneration: 'instance-1', remoteUser: 'user-1',
      source: 'user-data', id: 'blocked.json', workflowPath: 'blocked.json',
    }
    const run = createMediaToolRun(f.dependencies, context)
    const issues = await executeTool(run.piCustomTools, 'media_read_remote_workflow', {
      descriptor, section: 'issues', offset: 0, limit: 1,
    })
    expect(issues.details).toMatchObject({
      section: 'issues',
      canImport: false,
      items: [{ code: 'NODE_CLASS_UNKNOWN', nodeId: 'secret-node' }],
    })
    expect(JSON.stringify(issues.details)).not.toContain('Bearer should-not-leak')
    let importError = ''
    try {
      await executeTool(run.piCustomTools, 'media_import_remote_workflow', {
        descriptor,
        expectedContentHash: createHash('sha256').update(JSON.stringify(prompt)).digest('hex'),
        id: 'blocked-draft', name: '不可导入流程', expectedConfigRevision: 3, expectedWorkflowRevision: 0,
      })
      throw new Error('EXPECTED_REMOTE_WORKFLOW_IMPORT_FAILURE')
    } catch (error) {
      importError = error instanceof Error ? error.message : ''
    }
    expect(importError).toContain('MEDIA_REMOTE_WORKFLOW_NOT_IMPORTABLE:NODE_CLASS_UNKNOWN@secret-node:目标服务器未安装该节点')
    expect(importError).toContain('media_read_remote_workflow(section=issues)')
    expect(importError).not.toContain('Bearer should-not-leak')
    expect(f.publishedProjectIds).toEqual([])
  })

  test('Given 运行预检返回可信校验错误 When 工具包装 Then 保留中文定位且不透传原始异常正文', async () => {
    const f = fixture()
    /** 模拟运行服务真实 validator 产生的错误，message 故意包含不可公开内容。 */
    f.dependencies.runs.prepare = async () => {
      throw new MediaWorkflowValidationError([{
        code: 'INPUT_REQUIRED', nodeId: 'node-1', input: 'token', message: 'Bearer should-not-leak',
      }])
    }
    const run = createMediaToolRun(f.dependencies, context)

    let prepareError = ''
    try {
      await executeTool(run.piCustomTools, 'media_prepare_run', {
        profileId: 'profile', profileRevision: 1, inputs: {},
      })
      throw new Error('EXPECTED_WORKFLOW_VALIDATION_FAILURE')
    } catch (error) {
      prepareError = error instanceof Error ? error.message : ''
    }
    expect(prepareError).toContain('MEDIA_WORKFLOW_INVALID:INPUT_REQUIRED@node-1.token:缺少必填输入')
    expect(prepareError).not.toContain('Bearer should-not-leak')
  })

  test('Given 画布绑定服务器 When 查询目录后直接准备生成 Then 返回绑定但要求先配置节点卡片', async () => {
    /** 模拟用户切换画布默认服务器，旧运行仍保存原始来源。 */
    let selectedConnection: string | null = 'gpu'
    const f = fixture()
    f.dependencies.getCanvasConnection = (_current, canvasId) => {
      expect(canvasId).toBe('canvas-1')
      return selectedConnection
    }
    const run = createMediaToolRun(f.dependencies, { ...context,
      canvasAgentTarget: { projectId: 'project-1', canvasId: 'canvas-1', nodeId: 'node-1' } })
    const catalog = await executeTool(run.piCustomTools, 'media_list_workflows', {})
    expect(catalog.details).toMatchObject({ canvasId: 'canvas-1', selectedConnection: { id: 'gpu' }, connectionStatus: 'available' })
    await expect(executeTool(run.piCustomTools, 'media_prepare_run', {
      workflowId: 'draft', workflowRevision: 1, mediaKind: 'image', inputs: {},
    })).rejects.toThrow('MEDIA_CANVAS_TARGET_USE_CANVAS_TOOLS')
    selectedConnection = null
    await expect(executeTool(run.piCustomTools, 'media_prepare_run', {
      workflowId: 'draft', workflowRevision: 1, mediaKind: 'image', inputs: {},
    }, 'call-2')).rejects.toThrow('MEDIA_CANVAS_TARGET_USE_CANVAS_TOOLS')
    expect(f.prepared).toHaveLength(0)
  })

  test('Given 普通 Agent 已读取画布工作流、节点或模型 When 省略 canvasId 准备生成 Then 仍要求使用原画布卡片', async () => {
    /** 每种读取都在独立工具轮次验证，避免前一个读取掩盖遗漏的作用域标记。 */
    const reads: Array<{ name: string; input: Record<string, unknown> }> = [
      { name: 'media_inspect_workflow', input: { definition: workflow } },
      { name: 'media_get_node_schema', input: { classTypes: ['SaveImage'] } },
      { name: 'media_list_api_models', input: {} },
    ]
    for (const read of reads) {
      const f = fixture()
      f.dependencies.getCanvasConnection = () => 'gpu'
      const run = createMediaToolRun(f.dependencies, context)
      await executeTool(run.piCustomTools, read.name, { ...read.input, canvasId: 'canvas-1' })
      await expect(executeTool(run.piCustomTools, 'media_prepare_run', {
        profileId: 'profile', profileRevision: 1, inputs: {},
      })).rejects.toThrow('MEDIA_CANVAS_TARGET_USE_CANVAS_TOOLS')
      expect(f.prepared).toHaveLength(0)
    }
  })

  test('Given 普通 Agent 明确面向画布生成 When prepare 传入画布或本轮引用画布 Then 不建立独立媒体运行', async () => {
    /** 显式画布参数和消息中的权威引用都必须经过节点配置入口。 */
    const f = fixture()
    const ordinary = createMediaToolRun(f.dependencies, context)
    await expect(executeTool(ordinary.piCustomTools, 'media_prepare_run', {
      profileId: 'profile', profileRevision: 1, canvasId: 'canvas-1', inputs: {},
    })).rejects.toThrow('MEDIA_CANVAS_TARGET_USE_CANVAS_TOOLS')
    const referenced = createMediaToolRun(f.dependencies, { ...context,
      explicitReferences: [{ projectId: 'project-1', canvasId: 'canvas-1', nodeId: 'video-1',
        nodeType: 'video', nodeRevision: 1, title: '镜头' }],
    })
    await expect(executeTool(referenced.piCustomTools, 'media_prepare_run', {
      profileId: 'profile', profileRevision: 1, inputs: {},
    })).rejects.toThrow('MEDIA_CANVAS_TARGET_USE_CANVAS_TOOLS')
    await executeTool(ordinary.piCustomTools, 'media_list_workflows', { canvasId: 'canvas-1' })
    await expect(executeTool(ordinary.piCustomTools, 'media_prepare_run', {
      workflowId: 'draft', workflowRevision: 1, connectionId: 'gpu', mediaKind: 'video', inputs: {},
    })).rejects.toThrow('MEDIA_CANVAS_TARGET_USE_CANVAS_TOOLS')
    expect(f.prepared).toHaveLength(0)
  })

  test('Given 未绑定或失效服务器 When 自动查询资源 Then 不回退到第一台服务器且保留明确状态', async () => {
    const f = fixture()
    f.dependencies.getCanvasConnection = () => 'deleted-gpu'
    const run = createMediaToolRun(f.dependencies, context)
    expect((await executeTool(run.piCustomTools, 'media_list_workflows', { canvasId: 'canvas-1' })).details)
      .toMatchObject({ connectionStatus: 'unavailable', selectedConnection: { id: 'deleted-gpu' } })
    await expect(executeTool(run.piCustomTools, 'media_list_resources', { canvasId: 'canvas-1', kind: 'workflows' }))
      .rejects.toThrow('MEDIA_CONNECTION_UNAVAILABLE')
    f.dependencies.getCanvasConnection = () => null
    await expect(executeTool(run.piCustomTools, 'media_list_resources', { canvasId: 'canvas-1', kind: 'workflows' }))
      .rejects.toThrow('MEDIA_CANVAS_CONNECTION_REQUIRED')
    const explicit = await executeTool(run.piCustomTools, 'media_list_resources', { canvasId: 'canvas-1', connectionId: 'gpu', kind: 'nodes' })
    expect(explicit.details).toMatchObject({ connectionId: 'gpu' })
  })

  test('Given 固定画布的 Agent When 传入另一画布 Then 拒绝读取它的默认连接', async () => {
    const f = fixture()
    f.dependencies.getCanvasConnection = () => 'gpu'
    const run = createMediaToolRun(f.dependencies, { ...context,
      canvasAgentTarget: { projectId: 'project-1', canvasId: 'canvas-1', nodeId: 'node-1' } })
    await expect(executeTool(run.piCustomTools, 'media_list_workflows', { canvasId: 'canvas-2' }))
      .rejects.toThrow('MEDIA_CANVAS_TARGET_MISMATCH')
  })

  test('Given 项目草稿已保存 When 列出 Proma workflow 目录 Then 返回 I/O 摘要且不隐式选择首项', async () => {
    const f = fixture()
    const run = createMediaToolRun(f.dependencies, context)
    await executeTool(run.piCustomTools, 'media_save_workflow_draft', {
      id: 'draft', name: '草稿', expectedConfigRevision: 3, expectedWorkflowRevision: 0, definition: workflow, creationIntent: 'user-confirmed',
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
    const saved = await executeTool(run.piCustomTools, 'media_save_workflow_draft', { id: 'draft', name: '草稿', expectedConfigRevision: 3, expectedWorkflowRevision: 0, definition: workflow, creationIntent: 'user-confirmed' })
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
      id: 'shot', name: '草稿', expectedConfigRevision: 3, expectedWorkflowRevision: 0, definition: workflow, creationIntent: 'user-confirmed',
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

  test('Given LTX 节点 schema 已解析但没有本地执行合同 When Agent 读取节点摘要 Then 区分已发现与可执行', async () => {
    const f = fixture()
    f.dependencies.resources.getSchema = async () => ({
      LTXVPreprocess: { input: { required: { image: ['IMAGE'], img_compression: ['INT'] } }, output: ['IMAGE'] },
    })
    const run = createMediaToolRun(f.dependencies, context)
    const response = await executeTool(run.piCustomTools, 'media_get_node_schema', { connectionId: 'gpu', classTypes: ['LTXVPreprocess'] })
    expect(response.details).toEqual({ nodes: [{ classType: 'LTXVPreprocess', category: '', inputs: [
      { name: 'image', required: true, type: 'IMAGE' }, { name: 'img_compression', required: true, type: 'INT' },
    ], outputs: ['IMAGE'], supported: false, support: 'unknown', schemaAvailable: true }] })
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
