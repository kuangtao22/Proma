import { describe, expect, mock, test } from 'bun:test'
import type {
  CanvasDocument,
  CanvasEdge,
  CanvasMediaModuleConfig,
  CanvasMediaPreparationStatus,
  CanvasMediaTarget,
} from '@proma/shared'
import { connectCanvasMediaInputs, type ConnectCanvasMediaInputsInput } from './canvas-media-connect-command'

/** 测试目标始终引用同一视频节点与媒体模块。 */
const TARGET: CanvasMediaTarget = {
  projectId: 'project-1', canvasId: 'canvas-1', nodeId: 'video', mediaModuleId: 'video-module', mediaKind: 'video',
}

/** 创建含两个同源图片输入的已保存配置。 */
function createConfig(revision = 4): CanvasMediaModuleConfig {
  return {
    schemaVersion: 1,
    contentId: 'video-module',
    mediaKind: 'video',
    revision,
    createdAt: 1,
    updatedAt: 1,
    profile: null,
    workflow: null,
    inputs: ['first', 'last'].map((key) => ({
      key,
      kind: 'image' as const,
      source: { type: 'canvas-output' as const, nodeId: 'image', outputKey: 'image.asset' },
    })),
    outputs: [],
    adoptedOutputs: [],
  }
}

/** 创建只含补线所需身份与几何的权威图。 */
function createDocument(edges: CanvasEdge[] = [], revision = 3): CanvasDocument {
  return {
    schemaVersion: 4,
    projectId: 'project-1',
    canvasId: 'canvas-1',
    revision,
    viewport: { x: 0, y: 0, zoom: 1 },
    createdAt: 1,
    updatedAt: 1,
    nodes: [
      { id: 'image', kind: 'image', title: '首帧', imageModuleId: 'image-module', position: { x: 0, y: 0 } },
      { id: 'video', kind: 'video', title: '视频', mediaModuleId: 'video-module', position: { x: 500, y: 0 } },
    ],
    edges,
  }
}

/** 创建可变权威上下文和调用记录，覆盖结构锁与两个异步边界。 */
function createHarness(document = createDocument(), config = createConfig()) {
  let workspaceKey = 'workspace-1'
  let currentDocument = document
  let permissionWritable = true
  let blockedNodeIds = new Set<string>()
  let locked = false
  let idIndex = 0
  let preparation: CanvasMediaPreparationStatus = {
    configRevision: config.revision,
    workflowBound: false,
    inputsReady: false,
    ready: false,
    issues: [{ code: 'WORKFLOW_BINDING_PENDING', message: '待绑定工作流。' }],
  }
  let afterPreparation: (() => void) | null = null
  const checkPreparation = mock(async () => {
    afterPreparation?.()
    return preparation
  })
  const save = mock(async (_input: Parameters<ConnectCanvasMediaInputsInput['save']>[0]) => ({ ...currentDocument, revision: currentDocument.revision + 1 }))
  const onSuccess = mock(() => undefined)
  const input = {
    target: TARGET,
    config,
    createOperationId: () => `operation-${++idIndex}`,
    getCurrentContext: () => ({ workspaceKey, document: currentDocument, permissionWritable, blockedNodeIds }),
    beginOperation: () => {
      if (locked) return false
      locked = true
      return true
    },
    endOperation: () => { locked = false },
    checkPreparation,
    save,
    onSuccess,
  }
  return {
    input,
    checkPreparation,
    save,
    onSuccess,
    get locked() { return locked },
    setPreparationRevision(revision: number) { preparation = { ...preparation, configRevision: revision } },
    afterCheck(callback: () => void) { afterPreparation = callback },
    replaceDocument(next: CanvasDocument) { currentDocument = next },
    block(...nodeIds: string[]) { blockedNodeIds = new Set(nodeIds) },
    switchWorkspace() { workspaceKey = 'workspace-2' },
    setPermissionWritable(next: boolean) { permissionWritable = next },
  }
}

describe('Canvas 媒体输入补线命令', () => {
  test('Given 配置来自另一模块但revision相同 When 补线 Then 身份校验拒绝且零写入', async () => {
    const harness = createHarness(createDocument(), { ...createConfig(), contentId: 'other-module' })
    await expect(connectCanvasMediaInputs(harness.input)).rejects.toThrow('CANVAS_MEDIA_TARGET_INVALID')
    expect(harness.save).not.toHaveBeenCalled()
  })
  test('Given 两个输入复用同一来源且存在错误旧边 When 补线 Then 只追加一条精确依赖且不删除旧边', async () => {
    const wrongEdge: CanvasEdge = {
      id: 'wrong-edge', sourceNodeId: 'image', sourcePort: 'image.asset', targetNodeId: 'video', targetPort: 'context.text', relation: 'depends-on',
    }
    const harness = createHarness(createDocument([wrongEdge]))

    await connectCanvasMediaInputs(harness.input)

    expect(harness.save).toHaveBeenCalledTimes(1)
    expect(harness.save.mock.calls[0]?.[0]).toEqual({
      projectId: 'project-1',
      canvasId: 'canvas-1',
      expectedRevision: 3,
      mutations: [{
        type: 'upsert-edges',
        edges: [{
          id: 'operation-2', sourceNodeId: 'image', sourcePort: 'image.asset',
          targetNodeId: 'video', targetPort: 'context.image', relation: 'depends-on',
        }],
      }],
    })
    expect(harness.onSuccess).toHaveBeenCalledTimes(1)
    expect(harness.locked).toBeFalse()
  })

  test('Given 输入依赖已经接通 When 重复补线 Then 幂等且不启动结构操作', async () => {
    const harness = createHarness(createDocument([{
      id: 'existing', sourceNodeId: 'image', sourcePort: 'image.asset', targetNodeId: 'video', targetPort: 'context.image', relation: 'reference',
    }]))

    await connectCanvasMediaInputs(harness.input)

    expect(harness.checkPreparation).not.toHaveBeenCalled()
    expect(harness.save).not.toHaveBeenCalled()
    expect(harness.locked).toBeFalse()
  })

  test.each([
    ['图文档变更', (harness: ReturnType<typeof createHarness>) => harness.replaceDocument(createDocument([], 4))],
    ['写权限失效', (harness: ReturnType<typeof createHarness>) => harness.setPermissionWritable(false)],
  ])('Given 准备状态检查在途 When %s Then 拒绝迟到结果且零保存', async (_name, change) => {
    const harness = createHarness()
    harness.afterCheck(() => change(harness))

    await expect(connectCanvasMediaInputs(harness.input)).rejects.toThrow('CANVAS_MEDIA_CONNECT_STALE')
    expect(harness.save).not.toHaveBeenCalled()
    expect(harness.locked).toBeFalse()
  })

  test('Given 保存后的配置 revision 已改变 When 补线 Then 不用旧输入写图', async () => {
    const harness = createHarness()
    harness.setPreparationRevision(5)

    await expect(connectCanvasMediaInputs(harness.input)).rejects.toThrow('CANVAS_MEDIA_CONFIG_CONFLICT')
    expect(harness.save).not.toHaveBeenCalled()
    expect(harness.locked).toBeFalse()
  })

  test.each(['video', 'image'])('Given 目标或来源节点处于运行审批态 When 补线 Then 拒绝修改 %s', async (nodeId) => {
    const harness = createHarness()
    harness.block(nodeId)

    await expect(connectCanvasMediaInputs(harness.input)).rejects.toThrow('CANVAS_MEDIA_CONNECT_BLOCKED')
    expect(harness.checkPreparation).not.toHaveBeenCalled()
    expect(harness.save).not.toHaveBeenCalled()
    expect(harness.locked).toBeFalse()
  })

  test('Given 准备状态检查在途 When 来源节点开始运行 Then 复验活动态并保持零保存', async () => {
    const harness = createHarness()
    harness.afterCheck(() => harness.block('image'))

    await expect(connectCanvasMediaInputs(harness.input)).rejects.toThrow('CANVAS_MEDIA_CONNECT_BLOCKED')
    expect(harness.save).not.toHaveBeenCalled()
    expect(harness.locked).toBeFalse()
  })

  test.each([
    { ...TARGET, canvasId: 'other-canvas' },
    { ...TARGET, mediaModuleId: 'other-module' },
  ])('Given 目标画布或模块身份失效 When 补线 Then 在加锁前拒绝目标', async (target) => {
    const harness = createHarness()

    await expect(connectCanvasMediaInputs({ ...harness.input, target })).rejects.toThrow('CANVAS_MEDIA_TARGET_INVALID')
    expect(harness.checkPreparation).not.toHaveBeenCalled()
    expect(harness.save).not.toHaveBeenCalled()
    expect(harness.locked).toBeFalse()
  })

  test('Given 图保存失败 When 补线结束 Then 传播失败并在 finally 释放结构锁', async () => {
    const harness = createHarness()
    harness.save.mockImplementationOnce(async () => { throw new Error('disk full') })

    await expect(connectCanvasMediaInputs(harness.input)).rejects.toThrow('disk full')
    expect(harness.onSuccess).not.toHaveBeenCalled()
    expect(harness.locked).toBeFalse()
  })

  test('Given 保存完成时工作台已切换 When 返回新文档 Then 丢弃失效回调但保留成功保存', async () => {
    const harness = createHarness()
    harness.save.mockImplementationOnce(async () => {
      harness.switchWorkspace()
      return createDocument([], 4)
    })

    await connectCanvasMediaInputs(harness.input)

    expect(harness.save).toHaveBeenCalledTimes(1)
    expect(harness.onSuccess).not.toHaveBeenCalled()
    expect(harness.locked).toBeFalse()
  })
})
