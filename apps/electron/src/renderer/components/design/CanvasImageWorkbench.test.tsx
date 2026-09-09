import { describe, expect, test } from 'bun:test'
import type {
  CanvasImageModuleSnapshot,
  DesignAsset,
  DesignJobRecord,
  ImageGenerationModelOption,
  MediaAssetRecord,
  MediaConnectionSummary,
  MediaWorkflowVersion,
} from '@proma/shared'
import { renderToStaticMarkup } from 'react-dom/server'
import type { CanvasImageModuleViewState } from '@/atoms/native-canvas-atoms'
import {
  buildCanvasImageMediaWorkflowChange,
  CanvasImageWorkbench,
  createCanvasImageWorkflowBaseline,
  resolveCanvasImageWorkflowConnection,
  selectCanvasImageWorkflowsForProject,
} from './CanvasImageWorkbench'
import { createCanvasMediaWorkflowDraft, resolveDelayedCanvasDefaultConnection } from './CanvasMediaWorkbench'

/** 创建 Canvas 生图工作台使用的模型选项。 */
function createModelOption(): ImageGenerationModelOption {
  return {
    profileId: 'profile-1',
    name: 'GPT Image 2',
    modelId: 'gpt-image-2',
    executor: 'openai-images',
    channelId: 'channel-1',
    available: true,
  }
}

/** 创建用于目录作用域测试的最小图片工作流。 */
function createWorkflowFixture(): MediaWorkflowVersion {
  return {
    id: 'workflow-1', name: '图片工作流', projectId: null, revision: 1,
    hash: 'a'.repeat(64), createdAt: 1,
    definition: {
      schemaVersion: 1,
      prompt: {},
      bindings: [],
      outputs: [{ key: 'image', nodeId: 'save', outputIndex: 0, mediaType: 'image' }],
    },
  }
}

/** 创建测试素材，路径仅用于验证媒体授权 URL 拼接。 */
function createAsset(id: string, sourceJobId: string): DesignAsset {
  return {
    id,
    filename: `${id}.png`,
    relativePath: `assets/${id}.png`,
    thumbnailRelativePath: `thumbnails/${id}.webp`,
    mediaType: 'image/png',
    width: 1_024,
    height: 1_024,
    byteSize: 4_096,
    sha256: `${id}-sha256`,
    sourceJobId,
    createdAt: 100,
  }
}

/** 创建绑定当前图片模块的任务记录。 */
function createJob(
  id: string,
  status: DesignJobRecord['status'],
  outputAssetId?: string,
): DesignJobRecord {
  return {
    id,
    creativeTaskId: `creative-${id}`,
    attemptNumber: 1,
    projectId: 'project-1',
    target: {
      kind: 'canvas-image',
      canvasId: 'canvas-1',
      nodeId: 'node-1',
      imageModuleId: 'module-1',
    },
    action: 'generate',
    status,
    prompt: '生成一版安静、清晰的项目首页',
    originalRequest: '生成一版安静、清晰的项目首页',
    contextMode: 'project',
    generationConstraints: { aspectRatio: '16:9', imageSize: '2K' },
    canvasInputReferences: [{
      nodeId: 'agent-1',
      kind: 'agent',
      revision: 3,
      summary: '首页面向内容创作者，主操作是创建项目。',
      summaryHash: 'summary-hash',
    }],
    imageModelSnapshot: createModelOption(),
    ...(outputAssetId ? { outputAssetId } : {}),
    createdAt: id === 'job-2' ? 200 : 100,
    updatedAt: id === 'job-2' ? 220 : 120,
  }
}

/** 创建已加载且包含两个成功版本的模块状态。 */
function createState(overrides: Partial<CanvasImageModuleViewState> = {}): CanvasImageModuleViewState {
  const jobs = [
    createJob('job-2', 'succeeded', 'asset-2'),
    createJob('job-1', 'succeeded', 'asset-1'),
  ]
  const snapshot: CanvasImageModuleSnapshot = {
    target: {
      projectId: 'project-1',
      canvasId: 'canvas-1',
      nodeId: 'node-1',
      imageModuleId: 'module-1',
    },
    mediaLeaseId: 'lease-module-1',
    config: {
      schemaVersion: 2,
      kind: 'image',
      contentId: 'module-1',
      revision: 4,
      createdAt: 1,
      updatedAt: 200,
      prompt: '生成一版安静、清晰的项目首页',
      selectedModelProfileId: 'profile-1',
      aspectRatio: '16:9',
      imageSize: '2K',
      contextMode: 'project',
      adoptedAssetId: 'asset-2',
    },
    jobs,
    assets: [createAsset('asset-2', 'job-2'), createAsset('asset-1', 'job-1')],
    imageVersions: [
      { jobId: 'job-2', assetId: 'asset-2', createdAt: 200 },
      { jobId: 'job-1', assetId: 'asset-1', createdAt: 100 },
    ],
    assetBaseUrl: 'proma-file://asset-token',
    thumbnailBaseUrl: 'proma-file://thumbnail-token',
  }
  return {
    snapshot,
    draft: {
      prompt: snapshot.config.prompt,
      selectedModelProfileId: snapshot.config.selectedModelProfileId,
      aspectRatio: snapshot.config.aspectRatio,
      imageSize: snapshot.config.imageSize,
      contextMode: snapshot.config.contextMode,
      dirty: false,
    },
    phase: 'ready',
    saveState: 'saved',
    error: null,
    previewAssetId: null,
    taskDetails: new Map(),
    ...overrides,
  }
}

/** 使用稳定空回调渲染纯工作台视图。 */
function renderWorkbench(
  state: CanvasImageModuleViewState,
  writable = true,
  options: {
    exportState?: 'idle' | 'exporting'
    exportError?: string | null
    adoptingAssetId?: string | null
    mediaProgressByJobId?: ReadonlyMap<string, { phase: 'running'; phaseLabel: string; nodeProgressLabel?: string }>
    imageModelOptions?: ImageGenerationModelOption[]
    mediaWorkflow?: CanvasImageModuleSnapshot['config']['mediaWorkflow']
    mediaWorkflows?: MediaWorkflowVersion[]
    mediaConnections?: MediaConnectionSummary[]
    mediaAssets?: MediaAssetRecord[]
  } = {},
): string {
  return renderToStaticMarkup(
    <CanvasImageWorkbench
      state={state}
      writable={writable}
      imageModelOptions={options.imageModelOptions ?? [createModelOption()]}
      imageModelLoadState="ready"
      mediaWorkflow={options.mediaWorkflow}
      mediaWorkflows={options.mediaWorkflows}
      mediaConnections={options.mediaConnections}
      mediaAssets={options.mediaAssets}
      onMediaWorkflowChange={() => undefined}
      onDraftChange={() => undefined}
      onGenerate={() => undefined}
      onCancel={() => undefined}
      onRetry={() => undefined}
      onPreviewAsset={() => undefined}
      onAdoptAsset={() => undefined}
      adoptingAssetId={options.adoptingAssetId ?? null}
      onExportAsset={() => undefined}
      exportState={options.exportState ?? 'idle'}
      exportError={options.exportError ?? null}
      onLoadTaskDetails={() => undefined}
      onConfigureModels={() => undefined}
      onRetryLoad={() => undefined}
      mediaProgressByJobId={options.mediaProgressByJobId}
    />,
  )
}

describe('Canvas 生图工作台', () => {
  test('Given 当前目录包含供应商名称 When 展示已选模型 Then 显示供应商和模型名称', () => {
    /** 展示必须来自当前模型目录，不使用历史任务快照。 */
    const option = { ...createModelOption(), channelName: 'GPT-传贝' }
    /** 使用真实工作台渲染验证已选标签。 */
    const html = renderWorkbench(createState(), true, { imageModelOptions: [option] })

    expect(html).toContain('GPT-传贝 · GPT Image 2')
    expect(html).not.toContain('GPT Image 2 · gpt-image-2</span>')
  })

  test('Given 当前 API 模型的供应商已不存在 When 展示已选模型 Then 明确标注供应商不可用', () => {
    /** 缺少供应商名称不能把模型名称冒充供应商。 */
    const html = renderWorkbench(createState(), true, {
      imageModelOptions: [{ ...createModelOption(), available: false, unavailableReason: '关联的模型配置已不存在' }],
    })

    expect(html).toContain('供应商不可用 · GPT Image 2')
    expect(html).toContain('关联的模型配置已不存在')
  })

  test('Given 新图片工作流有画布默认连接 When 初始化 Then 继承默认；已有连接始终优先', () => {
    expect(resolveCanvasImageWorkflowConnection(null, 'connection-default')).toBe('connection-default')
    expect(resolveCanvasImageWorkflowConnection({
      workflowId: 'workflow-1', workflowRevision: 1, connectionId: 'connection-saved', inputs: {},
    }, 'connection-default')).toBe('connection-saved')
  })

  test('Given 默认连接稍晚到达 When 图片工作流草稿仍空白干净 Then 跟随默认且不覆盖用户编辑', () => {
    expect(resolveDelayedCanvasDefaultConnection('', 'connection-late', false, false, false)).toBe('connection-late')
    expect(resolveDelayedCanvasDefaultConnection('connection-old-default', 'connection-new-default', false, false, false))
      .toBe('connection-new-default')
    expect(resolveDelayedCanvasDefaultConnection('connection-user', 'connection-new-default', false, false, true))
      .toBe('connection-user')
    expect(resolveDelayedCanvasDefaultConnection('connection-user', 'connection-new-default', false, true, false))
      .toBe('connection-user')
    expect(resolveDelayedCanvasDefaultConnection('connection-saved', 'connection-new-default', true, false, false))
      .toBe('connection-saved')
  })

  test('Given 公共、当前项目与其它项目工作流并存 When 图片节点列目录 Then 仅保留前两者', () => {
    const workflow = createWorkflowFixture()
    expect(selectCanvasImageWorkflowsForProject([
      workflow,
      { ...workflow, id: 'workflow-project', projectId: 'project-1' },
      { ...workflow, id: 'workflow-other', projectId: 'project-2' },
    ], 'project-1').map((item) => item.id)).toEqual(['workflow-1', 'workflow-project'])
  })

  test('Given 多字段工作流只完成首个字段 When 提升配置 Then 保留本地草稿且不覆盖外部基线', () => {
    const workflow: MediaWorkflowVersion = {
      id: 'workflow-multi', name: '多字段工作流', projectId: null, revision: 1,
      hash: 'c'.repeat(64), createdAt: 1,
      definition: {
        schemaVersion: 1,
        prompt: {
          first: { class_type: 'TextNode', inputs: { text: '' } },
          second: { class_type: 'TextNode', inputs: { text: '' } },
        },
        bindings: [
          { key: 'first', kind: 'text', nodeId: 'first', input: 'text', field: {
            classType: 'TextNode', valueKind: 'string', label: '第一字段', controlType: 'text', required: true,
          } },
          { key: 'second', kind: 'text', nodeId: 'second', input: 'text', field: {
            classType: 'TextNode', valueKind: 'string', label: '第二字段', controlType: 'text', required: true,
          } },
        ],
        outputs: [{ key: 'image', nodeId: 'save', outputIndex: 0, mediaType: 'image' }],
      },
    }
    const drafts = createCanvasMediaWorkflowDraft(workflow)
    /** 首字段已完成但第二字段仍为空，不能把空 inputs 提升到父配置。 */
    const partialDrafts = drafts.map((draft, index) => index === 0 ? { ...draft, value: '第一段' } : draft)
    expect(buildCanvasImageMediaWorkflowChange(workflow, partialDrafts, 'connection-1')).toEqual({
      workflowId: 'workflow-multi', workflowRevision: 1, connectionId: 'connection-1',
      inputs: { first: { kind: 'scalar', value: '第一段' } },
    })

    /** 等价父对象必须产生同一基线，避免普通重渲染清空本地未完成字段。 */
    const external = {
      workflowId: workflow.id,
      workflowRevision: workflow.revision,
      connectionId: 'connection-1',
      inputs: {
        first: { kind: 'scalar' as const, value: '旧第一段' },
        second: { kind: 'scalar' as const, value: '旧第二段' },
      },
    }
    expect(createCanvasImageWorkflowBaseline(external, [workflow])).toBe(
      createCanvasImageWorkflowBaseline(structuredClone(external), [structuredClone(workflow)]),
    )

    /** 两个必填字段完整后才生成可持久化配置。 */
    const completeDrafts = partialDrafts.map((draft, index) => index === 1 ? { ...draft, value: '第二段' } : draft)
    expect(buildCanvasImageMediaWorkflowChange(workflow, completeDrafts, 'connection-1')).toEqual({
      workflowId: workflow.id,
      workflowRevision: workflow.revision,
      connectionId: 'connection-1',
      inputs: {
        first: { kind: 'scalar', value: '第一段' },
        second: { kind: 'scalar', value: '第二段' },
      },
    })
  })

  test('Given 已保存图片工作流缺少字段 When 重建表单 Then 已清空字段保持为空而不回填模板默认值', () => {
    const workflow = createWorkflowFixture()
    workflow.definition.prompt.text = { class_type: 'TextNode', inputs: { text: '模板默认描述' } }
    workflow.definition.bindings = [{ key: 'prompt', kind: 'text', nodeId: 'text', input: 'text', field: {
      classType: 'TextNode', valueKind: 'string', label: '提示词', controlType: 'text', required: true,
    } }]
    const fresh = createCanvasMediaWorkflowDraft(workflow)
    const persisted = createCanvasMediaWorkflowDraft(workflow, {}, false)

    expect(fresh[0]?.value).toBe('模板默认描述')
    expect(persisted[0]?.value).toBe('')
  })

  test('Given 工作流分析错误已持久化 When 打开图片节点 Then 原位显示原因并禁止生成', () => {
    const current = createState()
    const state = {
      ...current,
      snapshot: current.snapshot ? {
        ...current.snapshot,
        config: { ...current.snapshot.config, preparation: {
          code: 'UI_SUBGRAPH_INPUT_MISMATCH', message: '节点 105 的输入数量不一致。',
        } },
      } : null,
    }
    const html = renderWorkbench(state)

    expect(html).toContain('待配置：节点 105 的输入数量不一致。')
    expect(html).toMatch(/<button(?=[^>]*disabled="")[^>]*>[^<]*(?:<svg[\s\S]*?<\/svg>)?生成图片<\/button>/u)
  })

  test('Given Comfy 模型仍选择 auto 尺寸 When 渲染配置 Then 禁止提交并明确要求固定尺寸', () => {
    const current = createState()
    const comfyOption: ImageGenerationModelOption = {
      profileId: 'profile-1', name: 'Comfy', modelId: 'workflow', executor: 'comfyui',
      mediaProfileId: 'preset', mediaProfileRevision: 1, connectionId: 'connection',
      workflowId: 'workflow', workflowRevision: 1, workflowHash: 'a'.repeat(64), available: true,
    }
    const html = renderWorkbench({
      ...current,
      draft: current.draft ? { ...current.draft, imageSize: 'auto' } : null,
    }, true, { imageModelOptions: [comfyOption] })

    expect(html).toContain('ComfyUI 工作流需要选择明确的图片尺寸')
    expect(html).toMatch(/<button(?=[^>]*disabled="")[^>]*>[^<]*(?:<svg[\s\S]*?<\/svg>)?生成图片<\/button>/u)
  })

  test('Given 活跃 Comfy 任务存在当前节点采样 When 渲染工作台 Then 明确展示阶段而不显示整体百分比', () => {
    const current = createState()
    const active = {
      ...createJob('job-comfy', 'running'),
      imageModelSnapshot: {
        profileId: 'media:preset:1', name: 'Comfy', modelId: 'workflow', executor: 'comfyui' as const,
        mediaProfileId: 'preset', mediaProfileRevision: 1, connectionId: 'connection',
        workflowId: 'workflow', workflowRevision: 1, workflowHash: 'a'.repeat(64),
      },
    }
    const html = renderWorkbench({
      ...current,
      snapshot: current.snapshot ? { ...current.snapshot, jobs: [active, ...current.snapshot.jobs] } : null,
    }, true, { mediaProgressByJobId: new Map([['job-comfy', {
      phase: 'running', phaseLabel: '运行中', nodeProgressLabel: '当前节点 sampler · 4/20',
    }]]) })

    expect(html).toContain('当前节点 sampler · 4/20')
    expect(html).not.toContain('20%')
  })

  test('Given 图片模块包含多个成功版本 When 渲染详情 Then 只展示统一历史版本入口', () => {
    const html = renderWorkbench(createState())

    expect(html).not.toContain('候选批次')
    expect(html).not.toContain('当前版本')
    expect(html).not.toContain('候选版本')
    expect(html).toContain('历史版本')
  })
  test('Given 当前采用素材存在 When 渲染与历史预览 Then 导出始终绑定当前采用素材', () => {
    const html = renderWorkbench(createState({ previewAssetId: 'asset-1' }))

    expect(html).toContain('导出当前图片')
    expect(html).toMatch(/<button[^>]*aria-label="导出当前图片"[^>]*>/u)
  })

  test('Given 采用素材缺失或正在导出 When 渲染 Then 导出按钮禁用', () => {
    const current = createState()
    const missingAssetHtml = renderWorkbench({
      ...current,
      snapshot: current.snapshot ? { ...current.snapshot, assets: [] } : null,
    })
    const exportingHtml = renderWorkbench(createState(), true, { exportState: 'exporting' })

    expect(missingAssetHtml).toMatch(/<button(?=[^>]*disabled="")(?=[^>]*aria-label="导出当前图片")[^>]*>/u)
    expect(exportingHtml).toContain('正在导出')
    expect(exportingHtml).toMatch(/<button(?=[^>]*disabled="")(?=[^>]*aria-label="导出当前图片")[^>]*>/u)
  })

  test('Given 保存错误与导出错误同时存在 When 渲染 Then 两类反馈互不覆盖', () => {
    const html = renderWorkbench(createState({ saveState: 'failed', error: '配置保存失败' }), true, {
      exportError: '图片导出失败',
    })

    expect(html).toContain('配置保存失败')
    expect(html).toContain('图片导出失败')
  })

  test('Given 创建图片任务被前置校验拒绝 When 配置仍已保存 Then 原位展示任务错误', () => {
    const html = renderWorkbench(createState({
      saveState: 'saved',
      error: '有引用连线尚未确认用途，请先在画布中确认后再生成。',
    }))

    expect(html).toContain('有引用连线尚未确认用途，请先在画布中确认后再生成。')
    expect(html).toMatch(/<button(?![^>]*disabled="")[^>]*>[^<]*(?:<svg[\s\S]*?<\/svg>)?生成图片<\/button>/u)
  })

  test('Given 图片模块已加载 When 渲染 Then 显示完整配置、当前版本和直接上游摘要', () => {
    const html = renderWorkbench(createState())

    for (const label of ['提示词', '生图模型', '项目上下文', '画面比例', '图片尺寸']) {
      expect(html).toContain(label)
    }
    expect(html).toContain('当前图片')
    expect(html).toContain('GPT Image 2 · gpt-image-2')
    expect(html).toContain('首页面向内容创作者，主操作是创建项目。')
    expect(html).toContain('proma-file://asset-token/asset-2.png')
    expect(html).toContain('proma-file://thumbnail-token/asset-2.webp')
    expect(html).not.toContain('/assets/asset-2.png')
    expect(html).not.toContain('/thumbnails/asset-2.webp')
  })

  test('Given 图片节点选择公共工作流 When 渲染 Then 显示连接、动态字段和项目素材', () => {
    const workflow: MediaWorkflowVersion = {
      id: 'workflow-1', name: '公共海报工作流', projectId: null, revision: 2,
      hash: 'a'.repeat(64), createdAt: 1,
      definition: {
        schemaVersion: 1,
        prompt: {
          text: { class_type: 'CLIPTextEncode', inputs: { text: '' } },
          image: { class_type: 'LoadImage', inputs: { image: '' } },
        },
        bindings: [
          { key: 'promptText', kind: 'text', nodeId: 'text', input: 'text', field: {
            classType: 'CLIPTextEncode', valueKind: 'string', label: '画面描述', controlType: 'text', required: true,
          } },
          { key: 'reference', kind: 'image', nodeId: 'image', input: 'image', loader: 'LoadImage', field: {
            classType: 'LoadImage', valueKind: 'string', label: '参考素材', controlType: 'image', required: true,
          } },
        ],
        outputs: [{ key: 'image', nodeId: 'save', outputIndex: 0, mediaType: 'image' }],
      },
    }
    const mediaAsset: MediaAssetRecord = {
      id: 'media-asset-1', revision: 1, hash: 'b'.repeat(64), filename: 'reference.png', byteSize: 10,
      mediaType: 'image/png', mediaKind: 'image', metadata: { width: 10, height: 10 }, createdAt: 1,
    }
    const html = renderWorkbench(createState(), true, {
      mediaWorkflow: {
        workflowId: workflow.id, workflowRevision: workflow.revision, connectionId: 'connection-1',
        inputs: {
          promptText: { kind: 'scalar', value: '安静的首页' },
          reference: { kind: 'asset', asset: { assetId: mediaAsset.id, revision: 1, hash: mediaAsset.hash, mediaKind: 'image' } },
        },
      },
      mediaWorkflows: [workflow],
      mediaConnections: [{
        id: 'connection-1', name: '本地 ComfyUI', driver: 'comfyui', enabled: true,
        revision: 1, instanceGeneration: 'generation-1', credentialConfigured: false,
      }],
      mediaAssets: [mediaAsset],
    })

    expect(html).toContain('ComfyUI 连接')
    expect(html).toContain('工作流')
    expect(html).toContain('画面描述')
    expect(html).toContain('参考素材')
    expect(html).toContain('安静的首页')
    expect(html).toContain('导入参考素材')
  })

  test('Given 配置内容超过工作台高度 When 渲染 Then 主操作位于配置滚动区之外', () => {
    const html = renderWorkbench(createState())

    expect(html).toContain('aria-label="生图主操作"')
    expect(html).toMatch(/<\/div><\/div><footer aria-label="生图主操作"/u)
    expect(html).toContain('aria-label="生图节点工作台内容"')
  })

  test('Given 运行中任务 When 渲染 Then 主操作为取消且不再显示生成按钮', () => {
    const current = createState()
    const running = createJob('job-running', 'running')
    const html = renderWorkbench({
      ...current,
      snapshot: current.snapshot ? { ...current.snapshot, jobs: [running, ...current.snapshot.jobs] } : null,
    })

    expect(html).toContain('取消生成')
    expect(html).not.toContain('>生成图片<')
    expect(html).toContain('正在整理生成上下文并生成图片。')
    expect(html).not.toContain('Agent 正在')
  })

  test('Given 最近任务失败 When 渲染 Then 显示错误并允许按当前配置生成和查看详情', () => {
    const current = createState()
    const failed = { ...createJob('job-failed', 'failed'), error: '模型服务暂时不可用' }
    const html = renderWorkbench({
      ...current,
      snapshot: current.snapshot ? { ...current.snapshot, jobs: [failed] } : null,
    })

    expect(html).toContain('模型服务暂时不可用')
    expect(html).toContain('按当前配置生成')
    expect(html).not.toContain('重试生成')
    expect(html).toContain('查看任务详情')
  })

  test('Given 旧任务失败且当前模型不可用 When 渲染 Then 生成仍受当前配置校验约束', () => {
    /** 旧失败不能绕过当前目录的模型可用性和生成按钮校验。 */
    const current = createState()
    const html = renderWorkbench({
      ...current,
      snapshot: current.snapshot ? { ...current.snapshot, jobs: [createJob('job-failed', 'failed')] } : null,
    }, true, { imageModelOptions: [{ ...createModelOption(), available: false }] })

    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>.*?<\/svg>按当前配置生成<\/button>/u)
    expect(html).not.toContain('重试生成')
  })

  test('Given 历史版本被预览 When 渲染 Then 原图切换且采用入口只在历史项内', () => {
    const html = renderWorkbench(createState({ previewAssetId: 'asset-1' }))

    expect(html).toContain('proma-file://asset-token/asset-1.png')
    expect(html).toContain('正在预览历史版本')
    expect(html).not.toContain('设为当前')
    expect(html).toContain('aria-label="设为默认"')
    expect(html).toContain('>默认</span>')
    expect(html).toContain('历史版本')
  })

  test('Given Canvas 只读 When 渲染非默认历史版本 Then 采用按钮保持可见但不可写', () => {
    const html = renderWorkbench(createState({ previewAssetId: 'asset-1' }), false)

    expect(html).toMatch(/<button(?=[^>]*disabled="")(?=[^>]*aria-label="设为默认")[^>]*>/u)
    expect(html).toContain('当前画布为只读状态')
  })

  test('Given 一个历史版本正在设为默认 When 渲染 Then 阻止并发采用并标记目标版本', () => {
    const html = renderWorkbench(createState({ previewAssetId: 'asset-1' }), true, {
      adoptingAssetId: 'asset-1',
    })

    expect(html).toMatch(/<button(?=[^>]*disabled="")(?=[^>]*aria-label="正在设为默认")[^>]*>/u)
    expect(html).toContain('animate-spin')
  })

  test('Given 主进程版本事实与任务素材分叉 When 渲染 Then 历史只消费 imageVersions', () => {
    const current = createState()
    if (!current.snapshot) throw new Error('测试图片快照必须存在')
    const html = renderWorkbench({
      ...current,
      snapshot: {
        ...current.snapshot,
        imageVersions: [{ jobId: 'job-1', assetId: 'asset-1', createdAt: 100 }],
      },
    })

    expect(html).toContain('proma-file://thumbnail-token/asset-1.webp')
    expect(html).not.toContain('proma-file://thumbnail-token/asset-2.webp')
  })

  test('Given 模块加载失败或只读 When 渲染 Then 保留局部恢复入口并禁用编辑', () => {
    const failedHtml = renderWorkbench(createState({ phase: 'error', error: '图片配置损坏' }))
    const readOnlyHtml = renderWorkbench(createState(), false)

    expect(failedHtml).toContain('图片配置损坏')
    expect(failedHtml).toContain('重新加载')
    expect(readOnlyHtml).toContain('当前画布为只读状态')
    expect(readOnlyHtml).toMatch(/<textarea[^>]*disabled=""/)
  })

  test('Given 配置发生 revision 冲突 When 渲染 Then 阻止生成并提供重新加载配置入口', () => {
    const html = renderWorkbench(createState({
      saveState: 'conflict',
      error: '配置已在其他窗口更新',
    }))

    expect(html).toContain('配置已在其他窗口更新')
    expect(html).toContain('重新加载配置')
    expect(html).toMatch(/<button(?=[^>]*disabled="")[^>]*>[^<]*(?:<svg[\s\S]*?<\/svg>)?生成图片<\/button>/)
  })
})
