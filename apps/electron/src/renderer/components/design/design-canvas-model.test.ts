import { describe, expect, test } from 'bun:test'
import { createEmptyDesignDocument } from '@proma/shared'
import type { DesignAsset, DesignCanvasNode, DesignJobRecord } from '@proma/shared'
import {
  createMoveNodesMutation,
  createViewportMutation,
  mergeDocumentFlowNodes,
  toFlowNodes,
} from './design-canvas-model'
import {
  getDesignCanvasInteractionConfig,
  getDesignCanvasViewportPolicy,
} from './DesignCanvas'

/** 创建包含敏感原图路径的素材，验证 Renderer 节点不会携带该路径。 */
function createAsset(): DesignAsset {
  return {
    id: 'asset-1',
    filename: '原始海报.png',
    relativePath: 'assets/private/original-source.png',
    thumbnailRelativePath: 'thumbnails/preview a.webp',
    mediaType: 'image/png',
    width: 1600,
    height: 1200,
    byteSize: 2048,
    sha256: 'sha256-secret',
    createdAt: 100,
  }
}

/** 创建指定业务类型的固定尺寸画布节点。 */
function createNode(overrides: Partial<DesignCanvasNode>): DesignCanvasNode {
  return {
    id: 'node-1',
    kind: 'asset',
    assetId: 'asset-1',
    position: { x: 24, y: 48 },
    width: 320,
    height: 240,
    zIndex: 3,
    ...overrides,
  }
}

describe('Design 画布节点映射', () => {
  test('Given 素材节点 When 映射到 XYFlow Then 只公开编码后的缩略图 URL 和展示字段', () => {
    /** 带素材节点的测试文档。 */
    const document = createEmptyDesignDocument('project-1', 100)
    document.assets = [createAsset()]
    document.nodes = [createNode({})]

    const nodes = toFlowNodes(document, { thumbnailBaseUrl: 'proma-file://thumbs/' })
    const serialized = JSON.stringify(nodes)

    expect(nodes[0]).toMatchObject({
      id: 'node-1',
      type: 'designAsset',
      position: { x: 24, y: 48 },
      width: 320,
      height: 240,
      selectable: true,
      draggable: true,
      connectable: false,
      data: {
        kind: 'asset',
        status: 'success',
        assetId: 'asset-1',
        title: '原始海报.png',
        pixelWidth: 1600,
        pixelHeight: 1200,
        previewUrl: 'proma-file://thumbs/preview%20a.webp',
      },
    })
    expect(serialized).not.toContain(document.assets[0]!.relativePath)
    expect(serialized).not.toContain(document.assets[0]!.thumbnailRelativePath)
    expect(serialized).not.toContain('sha256-secret')
  })

  test('Given 缺失素材和任务节点 When 映射 Then 使用稳定缺失态与任务排队态', () => {
    /** 不含素材记录、但同时存在素材与任务节点的测试文档。 */
    const document = createEmptyDesignDocument('project-1', 100)
    document.nodes = [
      createNode({ id: 'missing-node', assetId: 'missing-asset' }),
      createNode({ id: 'job-node', kind: 'job', assetId: undefined, jobId: 'job-1' }),
    ]

    const nodes = toFlowNodes(document, {
      thumbnailBaseUrl: 'proma-file://thumbs',
      writable: true,
      authoritativeRecoveryState: 'idle',
    })

    expect(nodes[0]?.data).toEqual({
      kind: 'asset',
      status: 'missing',
      assetId: 'missing-asset',
      title: '素材缺失',
    })
    expect(nodes[1]?.data).toEqual({
      kind: 'job',
      status: 'queued',
      projectId: 'project-1',
      jobId: 'job-1',
      writable: true,
      authoritativeRecoveryState: 'idle',
      title: '图片任务',
    })
  })

  test('Given 任务 journal 已失败或中断 When 映射任务节点 Then 展示真实状态与错误', () => {
    const document = createEmptyDesignDocument('project-1', 100)
    document.nodes = [
      createNode({ id: 'failed-node', kind: 'job', assetId: undefined, jobId: 'job-failed' }),
      createNode({ id: 'interrupted-node', kind: 'job', assetId: undefined, jobId: 'job-interrupted' }),
    ]
    /** 与节点 jobId 对应的主进程 journal 记录。 */
    const jobs: DesignJobRecord[] = [
      {
        id: 'job-failed', creativeTaskId: 'creative-failed', attemptNumber: 1,
        projectId: 'project-1', action: 'generate', status: 'failed',
        prompt: '生成海报', originalRequest: '生成海报', contextMode: 'none',
        error: '模型失败', createdAt: 1, updatedAt: 2,
      },
      {
        id: 'job-interrupted', creativeTaskId: 'creative-interrupted', attemptNumber: 1,
        projectId: 'project-1', action: 'edit', status: 'interrupted',
        prompt: '移除文字', originalRequest: '移除文字', contextMode: 'none',
        error: '应用退出，任务已中断', createdAt: 3, updatedAt: 4,
      },
    ]

    const nodes = toFlowNodes(document, { jobs })

    expect(nodes[0]?.data).toMatchObject({
      status: 'failed',
      error: '模型失败',
      projectId: 'project-1',
      jobId: 'job-failed',
    })
    expect(nodes[1]?.data).toMatchObject({
      status: 'interrupted',
      error: '应用退出，任务已中断',
      projectId: 'project-1',
      jobId: 'job-interrupted',
    })
  })

  test('Given 任务固化模型快照 When 映射任务节点 Then 展示实际配置名和模型 ID 且尺寸不变', () => {
    /** 保留非默认持久化尺寸的任务节点文档。 */
    const document = createEmptyDesignDocument('project-1', 100)
    document.nodes = [
      createNode({
        id: 'job-node',
        kind: 'job',
        assetId: undefined,
        jobId: 'job-1',
        width: 456,
        height: 321,
      }),
    ]
    /** 带固化模型快照的新格式任务记录。 */
    const jobs: DesignJobRecord[] = [{
      id: 'job-1',
      creativeTaskId: 'creative-1',
      attemptNumber: 1,
      projectId: 'project-1',
      action: 'generate',
      status: 'running',
      prompt: '生成海报',
      originalRequest: '生成海报',
      contextMode: 'none',
      imageModelSnapshot: {
        profileId: 'profile-b',
        name: '高质量模型',
        executor: 'nano-banana',
        modelId: 'gemini-pro-image',
      },
      createdAt: 1,
      updatedAt: 2,
    }]

    /** 映射后的 XYFlow 节点应只增加展示字段，不改持久化布局。 */
    const node = toFlowNodes(document, { jobs })[0]

    expect(node?.data.imageModelLabel).toBe('高质量模型 · gemini-pro-image')
    expect(node?.width).toBe(456)
    expect(node?.height).toBe(321)
  })

  test('Given 旧任务没有模型快照 When 映射任务节点 Then 保留旧状态展示且不伪造模型标签', () => {
    /** 模拟升级前已经存在的任务节点文档。 */
    const document = createEmptyDesignDocument('project-1', 100)
    document.nodes = [
      createNode({ id: 'legacy-job-node', kind: 'job', assetId: undefined, jobId: 'legacy-job' }),
    ]
    /** 旧 journal 合法缺少 imageModelSnapshot。 */
    const jobs: DesignJobRecord[] = [{
      id: 'legacy-job',
      creativeTaskId: 'legacy-job',
      attemptNumber: 1,
      projectId: 'project-1',
      action: 'generate',
      status: 'interrupted',
      prompt: '旧任务',
      originalRequest: '旧任务',
      contextMode: 'none',
      createdAt: 1,
      updatedAt: 2,
    }]

    /** 旧任务映射结果只能回退状态，不能猜测实际模型。 */
    const node = toFlowNodes(document, { jobs })[0]

    expect(node?.data.status).toBe('interrupted')
    expect(node?.data.imageModelLabel).toBeUndefined()
  })

  test('Given 选择或平移工具 When 读取画布配置 Then 只允许选择模式拖动节点', () => {
    expect(getDesignCanvasInteractionConfig('select', true)).toEqual({
      selectionOnDrag: true,
      panOnDrag: [1, 2],
      nodesDraggable: true,
    })
    expect(getDesignCanvasInteractionConfig('pan', true)).toEqual({
      selectionOnDrag: false,
      panOnDrag: true,
      nodesDraggable: false,
    })
    expect(getDesignCanvasInteractionConfig('select', false).nodesDraggable).toBe(false)
  })

  test('Given 拖动结束和视口移动结束 When 构造保存输入 Then 各生成一个受控 mutation', () => {
    /** 拖动结束时 XYFlow 返回的最终节点位置。 */
    const movedNodes = [
      { id: 'node-1', position: { x: 20, y: 30 } },
      { id: 'node-2', position: { x: 40, y: 50 } },
    ]

    expect(createMoveNodesMutation(movedNodes)).toEqual({
      type: 'move-nodes',
      positions: [
        { nodeId: 'node-1', position: { x: 20, y: 30 } },
        { nodeId: 'node-2', position: { x: 40, y: 50 } },
      ],
    })
    expect(createViewportMutation({ x: 12, y: 18, zoom: 1.25 })).toEqual({
      type: 'set-viewport',
      viewport: { x: 12, y: 18, zoom: 1.25 },
    })
  })

  test('Given 节点仍在拖动 When 保存响应更新 document Then 保留活动节点本地位置并同步其他节点', () => {
    /** 当前 XYFlow 内存包含尚未提交的拖动位置。 */
    const currentNodes = [
      { ...toFlowNodes(createDocumentWithNodes(), { thumbnailBaseUrl: 'proma-file://thumbs' })[0]!, position: { x: 90, y: 100 } },
      { ...toFlowNodes(createDocumentWithNodes(), { thumbnailBaseUrl: 'proma-file://thumbs' })[1]!, position: { x: 30, y: 40 } },
    ]
    /** 保存响应带回的新权威 document，其中非拖动节点已由外部更新。 */
    const updatedDocument = createDocumentWithNodes()
    updatedDocument.nodes[0]!.position = { x: 5, y: 6 }
    updatedDocument.nodes[1]!.position = { x: 70, y: 80 }
    const documentNodes = toFlowNodes(updatedDocument, { thumbnailBaseUrl: 'proma-file://thumbs' })

    const merged = mergeDocumentFlowNodes(currentNodes, documentNodes, new Set(['node-1']))

    expect(merged[0]?.position).toEqual({ x: 90, y: 100 })
    expect(merged[1]?.position).toEqual({ x: 70, y: 80 })
  })

  test('Given A 到 B 再回 A When 计算画布启动策略 Then 各项目恢复自己的持久视口', () => {
    /** 已保存项目 A 的持久视口。 */
    const projectA = createDocumentWithNodes('project-a')
    projectA.revision = 3
    projectA.viewport = { x: 11, y: 12, zoom: 1.1 }
    /** 已保存项目 B 的独立持久视口。 */
    const projectB = createDocumentWithNodes('project-b')
    projectB.revision = 7
    projectB.viewport = { x: 21, y: 22, zoom: 1.2 }

    const sequence = [projectA, projectB, projectA].map(getDesignCanvasViewportPolicy)

    expect(sequence).toEqual([
      { defaultViewport: projectA.viewport, fitView: false },
      { defaultViewport: projectB.viewport, fitView: false },
      { defaultViewport: projectA.viewport, fitView: false },
    ])
  })

  test('Given revision 为零且已有节点 When 计算画布启动策略 Then 首次 fitView 优先于默认视口', () => {
    /** revision 0 表示尚无用户保存过的持久视口，允许首次自动取景。 */
    const initialDocument = createDocumentWithNodes()
    initialDocument.viewport = { x: 99, y: 88, zoom: 2 }

    expect(getDesignCanvasViewportPolicy(initialDocument)).toEqual({
      defaultViewport: initialDocument.viewport,
      fitView: true,
    })
  })
})

/** 创建两个素材引用节点，供拖动合并和视口隔离测试复用。 */
function createDocumentWithNodes(projectId = 'project-1') {
  /** 固定时间的测试文档。 */
  const document = createEmptyDesignDocument(projectId, 100)
  document.nodes = [
    createNode({ id: 'node-1', position: { x: 10, y: 20 } }),
    createNode({ id: 'node-2', assetId: 'asset-2', position: { x: 30, y: 40 } }),
  ]
  return document
}
