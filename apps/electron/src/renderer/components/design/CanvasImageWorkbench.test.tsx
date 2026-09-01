import { describe, expect, test } from 'bun:test'
import type {
  CanvasImageCandidateBatch,
  CanvasImageCandidateBatchSummary,
  CanvasImageModuleSnapshot,
  DesignAsset,
  DesignJobRecord,
  ImageGenerationModelOption,
} from '@proma/shared'
import { renderToStaticMarkup } from 'react-dom/server'
import type { CanvasImageModuleViewState } from '@/atoms/native-canvas-atoms'
import { CanvasImageWorkbench } from './CanvasImageWorkbench'
import type { CanvasImageCandidateBatchWorkbenchProps } from './CanvasImageWorkbench'

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
    candidateBatch?: CanvasImageCandidateBatchWorkbenchProps
  } = {},
): string {
  return renderToStaticMarkup(
    <CanvasImageWorkbench
      state={state}
      writable={writable}
      imageModelOptions={[createModelOption()]}
      imageModelLoadState="ready"
      onDraftChange={() => undefined}
      onGenerate={() => undefined}
      onCancel={() => undefined}
      onRetry={() => undefined}
      onPreviewAsset={() => undefined}
      onAdoptAsset={() => undefined}
      onExportAsset={() => undefined}
      exportState={options.exportState ?? 'idle'}
      exportError={options.exportError ?? null}
      onLoadTaskDetails={() => undefined}
      onConfigureModels={() => undefined}
      onRetryLoad={() => undefined}
      candidateBatch={options.candidateBatch}
    />,
  )
}

/** 创建当前节点拥有候选版本的单节点批次。 */
function createCandidateBatch(): CanvasImageCandidateBatch {
  return {
    schemaVersion: 1, batchId: 'batch-1', projectId: 'project-1', canvasId: 'canvas-1',
    source: 'single', sourceSessionId: null, sourceToolCallId: null, status: 'ready',
    entries: [{ nodeId: 'node-1', imageModuleId: 'module-1', initialAdoptedAssetId: 'asset-1', initialConfigRevision: 1, jobId: 'job-2', candidateAssetId: 'asset-2', status: 'candidate', error: null }],
    adoption: null, createdAt: 100, updatedAt: 200,
  }
}

/** 创建工作台候选批次区域使用的轻量摘要和命令。 */
function createCandidateWorkbenchProps(): CanvasImageCandidateBatchWorkbenchProps {
  const batch = createCandidateBatch()
  const summary: CanvasImageCandidateBatchSummary = {
    batchId: batch.batchId, projectId: batch.projectId, canvasId: batch.canvasId,
    entries: batch.entries.map((entry) => ({ nodeId: entry.nodeId, status: entry.status })),
    status: batch.status, totalCount: 1, candidateCount: 1, failedCount: 0, runningCount: 0,
    updatedAt: batch.updatedAt,
  }
  return {
    summary,
    state: { phase: 'ready', batch, error: null, operation: 'idle' },
    onLoad: () => undefined,
    onContinue: () => undefined,
    onAdopt: () => undefined,
    onAbandon: () => undefined,
  }
}

describe('Canvas 生图工作台', () => {
  test('Given 当前节点存在候选版本 When 渲染详情 Then 候选验收区与正式历史并存', () => {
    const html = renderWorkbench(createState(), true, { candidateBatch: createCandidateWorkbenchProps() })

    expect(html).toContain('候选批次')
    expect(html).toContain('当前版本')
    expect(html).toContain('候选版本')
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

  test('Given 配置内容超过工作台高度 When 渲染 Then 主操作固定在底部且工作台保持可滚动', () => {
    const html = renderWorkbench(createState())

    expect(html).toContain('aria-label="生图主操作"')
    expect(html).toMatch(/aria-label="生图主操作"[^>]*class="[^"]*sticky[^"]*bottom-0/u)
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
  })

  test('Given 最近任务失败 When 渲染 Then 显示清洗错误、重试和详情入口', () => {
    const current = createState()
    const failed = { ...createJob('job-failed', 'failed'), error: '模型服务暂时不可用' }
    const html = renderWorkbench({
      ...current,
      snapshot: current.snapshot ? { ...current.snapshot, jobs: [failed] } : null,
    })

    expect(html).toContain('模型服务暂时不可用')
    expect(html).toContain('重试生成')
    expect(html).toContain('查看任务详情')
  })

  test('Given 历史版本被预览 When 渲染 Then 原图切换但不会伪装成当前版本', () => {
    const html = renderWorkbench(createState({ previewAssetId: 'asset-1' }))

    expect(html).toContain('proma-file://asset-token/asset-1.png')
    expect(html).toContain('正在预览历史版本')
    expect(html).toContain('设为当前')
    expect(html).toContain('历史版本')
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
