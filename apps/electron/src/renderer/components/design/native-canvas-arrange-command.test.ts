import { describe, expect, mock, test } from 'bun:test'
import { createEmptyCanvasDocument } from '@proma/shared'
import type { CanvasDocument, CanvasMutation } from '@proma/shared'
import {
  createNativeCanvasRelatedArrangeNodeIds,
  createNativeCanvasArrangeCommand,
  getNativeCanvasArrangeErrorMessage,
} from './native-canvas-arrange-command'

/** 构造可手工完成的 Promise，用于锁定异步布局期间的竞态。 */
function createDeferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

/** 创建带单节点的固定文档，便于比较 revision 与对象代次。 */
function createDocument(revision = 1): CanvasDocument {
  const document = createEmptyCanvasDocument('project-1', 'canvas-1', 1)
  document.revision = revision
  document.nodes = [{
    id: 'node-1', kind: 'agent', title: 'Agent', agentSessionId: 'session-1',
    position: { x: 0, y: 0 },
  }]
  return document
}

/** 测试统一使用一条真实位置变化。 */
const MOVE_MUTATION: Extract<CanvasMutation, { type: 'move-nodes' }> = {
  type: 'move-nodes', positions: [{ nodeId: 'node-1', position: { x: 100, y: 200 } }],
}

/** 创建可变上下文与调用记录，模拟 Workspace 和 Worker 边界。 */
function createHarness() {
  const deferred = createDeferred<Extract<CanvasMutation, { type: 'move-nodes' }>>()
  let document = createDocument()
  let workspaceKey = 'workspace-1'
  let permissionWritable = true
  let blockedNodeIds = new Set<string>()
  let locked = false
  let calculationSignal: AbortSignal | null = null
  const save = mock(async () => createDocument(2))
  const onSuccess = mock(() => undefined)
  const onFailure = mock(() => undefined)
  const command = createNativeCanvasArrangeCommand({
    target: { projectId: 'project-1', canvasId: 'canvas-1' },
    createOperationId: () => 'arrange-1',
    getCurrentContext: () => ({ workspaceKey, document, permissionWritable, blockedNodeIds }),
    beginOperation: () => {
      if (locked) return false
      locked = true
      return true
    },
    endOperation: () => { locked = false },
    calculate: async (_input, signal) => {
      calculationSignal = signal
      return deferred.promise
    },
    save,
    onSuccess,
    onFailure,
  })
  return {
    command, deferred, save, onSuccess, onFailure,
    get locked() { return locked },
    get calculationSignal() { return calculationSignal },
    replaceDocument(next: CanvasDocument) { document = next },
    switchWorkspace() { workspaceKey = 'workspace-2' },
    setPermissionWritable(next: boolean) { permissionWritable = next },
    blockNode(nodeId: string) { blockedNodeIds = new Set([nodeId]) },
  }
}

describe('Native Canvas 异步整理命令', () => {
  test('Given 选中视频节点有多类真实输入 When 解析相关整理范围 Then 只纳入一跳非关联来源并保持文档顺序', () => {
    const document = createEmptyCanvasDocument('project-1', 'canvas-1', 1)
    document.nodes = [
      { id: 'master', kind: 'image', title: '共享母版', imageModuleId: 'image-master', position: { x: 0, y: 0 } },
      { id: 'frame', kind: 'image', title: '首帧', imageModuleId: 'image-frame', position: { x: 0, y: 0 } },
      { id: 'prompt', kind: 'document', title: '动态提示词', documentId: 'document-1', contentRevision: 1, position: { x: 0, y: 0 } },
      { id: 'video', kind: 'video', title: '镜头视频', mediaModuleId: 'video-1', position: { x: 0, y: 0 } },
      { id: 'downstream', kind: 'audio', title: '配音', mediaModuleId: 'audio-1', position: { x: 0, y: 0 } },
    ]
    document.edges = [
      { id: 'master-frame', sourceNodeId: 'master', sourcePort: 'image.asset', targetNodeId: 'frame', targetPort: 'image.reference', relation: 'depends-on' },
      { id: 'frame-video', sourceNodeId: 'frame', sourcePort: 'image.asset', targetNodeId: 'video', targetPort: 'context.image', relation: 'depends-on' },
      { id: 'prompt-video', sourceNodeId: 'prompt', sourcePort: 'document.markdown', targetNodeId: 'video', targetPort: 'context.text', relation: 'reference' },
      { id: 'master-video-association', sourceNodeId: 'master', sourcePort: 'unbound', targetNodeId: 'video', targetPort: 'unbound', relation: 'association' },
      { id: 'video-downstream', sourceNodeId: 'video', sourcePort: 'video.asset', targetNodeId: 'downstream', targetPort: 'context.video', relation: 'derives' },
    ]

    expect(createNativeCanvasRelatedArrangeNodeIds(document, ['video', 'video', 'missing']))
      .toEqual(['frame', 'prompt', 'video'])
  })

  test('Given 选中普通节点和图片媒体节点 When 解析相关整理范围 Then 保留选区且只扩展媒体节点直接来源', () => {
    const document = createEmptyCanvasDocument('project-1', 'canvas-1', 1)
    document.nodes = [
      { id: 'agent', kind: 'agent', title: 'Agent', agentSessionId: 'session-1', position: { x: 0, y: 0 } },
      { id: 'source', kind: 'document', title: '文案', documentId: 'document-1', contentRevision: 1, position: { x: 0, y: 0 } },
      { id: 'image', kind: 'image', title: '成图', imageModuleId: 'image-1', position: { x: 0, y: 0 } },
    ]
    document.edges = [
      { id: 'source-agent', sourceNodeId: 'source', sourcePort: 'document.markdown', targetNodeId: 'agent', targetPort: 'context.text', relation: 'depends-on' },
      { id: 'source-image', sourceNodeId: 'source', sourcePort: 'document.markdown', targetNodeId: 'image', targetPort: 'context.text', relation: 'depends-on' },
    ]

    expect(createNativeCanvasRelatedArrangeNodeIds(document, ['agent', 'image']))
      .toEqual(['agent', 'source', 'image'])
  })

  test.each([
    [new Error('CANVAS_LAYOUT_TOO_LARGE'), '节点过多，请选择部分节点分批整理。'],
    [Object.assign(new Error('Canvas 智能整理超时'), { name: 'TimeoutError' }), '智能整理超过 8 秒，请缩小选区后重试。'],
    [new Error('worker failed'), '整理布局失败，原位置已保留。'],
  ])('Given 布局失败 When 映射错误提示 Then 返回对应的可操作文案', (error, message) => {
    expect(getNativeCanvasArrangeErrorMessage(error)).toBe(message)
  })

  test.each([
    ['切换 Workspace', (harness: ReturnType<typeof createHarness>) => harness.switchWorkspace()],
    ['revision 改变', (harness: ReturnType<typeof createHarness>) => harness.replaceDocument(createDocument(2))],
    ['同 revision 重新 LOAD', (harness: ReturnType<typeof createHarness>) => harness.replaceDocument(createDocument(1))],
    ['权限变为只读', (harness: ReturnType<typeof createHarness>) => harness.setPermissionWritable(false)],
  ])('Given 布局计算未完成 When %s Then 丢弃结果且 finally 释放结构锁', async (_name, change) => {
    const harness = createHarness()
    const execution = harness.command.execute({
      scopeNodeIds: ['node-1'], blockedNodeIds: new Set(), nodeSizesById: new Map(),
    })
    expect(harness.locked).toBe(true)
    change(harness)
    harness.deferred.resolve(MOVE_MUTATION)
    expect(await execution).toBe('stale')
    expect(harness.save).not.toHaveBeenCalled()
    expect(harness.locked).toBe(false)
  })

  test.each(['running', 'waiting-approval'] as const)(
    'Given 布局计算未完成 When 节点开始 %s Then 不提交该节点位置',
    async () => {
      const harness = createHarness()
      const execution = harness.command.execute({
        scopeNodeIds: ['node-1'], blockedNodeIds: new Set(), nodeSizesById: new Map(),
      })
      harness.blockNode('node-1')
      harness.deferred.resolve(MOVE_MUTATION)
      expect(await execution).toBe('stale')
      expect(harness.save).not.toHaveBeenCalled()
      expect(harness.locked).toBe(false)
    },
  )

  test('Given 布局计算未完成 When Workspace 卸载 Then 中止 Worker 且不提交', async () => {
    const harness = createHarness()
    const execution = harness.command.execute({
      scopeNodeIds: ['node-1'], blockedNodeIds: new Set(), nodeSizesById: new Map(),
    })
    harness.command.dispose()
    expect(harness.calculationSignal?.aborted).toBe(true)
    harness.deferred.resolve(MOVE_MUTATION)
    expect(await execution).toBe('aborted')
    expect(harness.save).not.toHaveBeenCalled()
    expect(harness.locked).toBe(false)
  })

  test('Given 权限暂时失效 When 取消当前整理并恢复权限 Then 后续仍可重新整理', async () => {
    const harness = createHarness()
    const first = harness.command.execute({
      scopeNodeIds: ['node-1'], blockedNodeIds: new Set(), nodeSizesById: new Map(),
    })
    harness.command.cancel()
    expect(harness.calculationSignal?.aborted).toBe(true)
    harness.deferred.resolve(MOVE_MUTATION)
    expect(await first).toBe('aborted')
    expect(harness.locked).toBe(false)

    const second = harness.command.execute({
      scopeNodeIds: ['node-1'], blockedNodeIds: new Set(), nodeSizesById: new Map(),
    })
    expect(await second).toBe('committed')
    expect(harness.save).toHaveBeenCalledTimes(1)
  })

  test('Given 保存尚未返回 When 同 revision 重新 LOAD Then 保存成功但不用迟到结果覆盖当前状态', async () => {
    const harness = createHarness()
    /** 分别控制 SAVE 完成和确认 SAVE 已经开始，避免依赖微任务轮数。 */
    const saveDeferred = createDeferred<CanvasDocument>()
    const saveStarted = createDeferred<void>()
    harness.save.mockImplementationOnce(async () => {
      saveStarted.resolve()
      return saveDeferred.promise
    })
    const execution = harness.command.execute({
      scopeNodeIds: ['node-1'], blockedNodeIds: new Set(), nodeSizesById: new Map(),
    })
    harness.deferred.resolve(MOVE_MUTATION)
    await saveStarted.promise
    expect(harness.save).toHaveBeenCalledTimes(1)
    harness.replaceDocument(createDocument(1))
    saveDeferred.resolve(createDocument(2))
    expect(await execution).toBe('committed')
    expect(harness.onSuccess).not.toHaveBeenCalled()
    expect(harness.locked).toBe(false)
  })

  test('Given 一次整理正在计算 When 重复启动 Then 第二次 busy 且不创建第二个 Worker', async () => {
    const harness = createHarness()
    const first = harness.command.execute({
      scopeNodeIds: ['node-1'], blockedNodeIds: new Set(), nodeSizesById: new Map(),
    })
    const second = harness.command.execute({
      scopeNodeIds: ['node-1'], blockedNodeIds: new Set(), nodeSizesById: new Map(),
    })
    expect(await second).toBe('busy')
    harness.deferred.resolve(MOVE_MUTATION)
    expect(await first).toBe('committed')
    expect(harness.save).toHaveBeenCalledTimes(1)
    expect(harness.onSuccess).toHaveBeenCalledTimes(1)
    expect(harness.locked).toBe(false)
  })

  test('Given 保存失败 When 整理结束 Then 保留失败并在 finally 释放结构锁', async () => {
    const harness = createHarness()
    harness.save.mockImplementationOnce(async () => { throw new Error('disk full') })
    const execution = harness.command.execute({
      scopeNodeIds: ['node-1'], blockedNodeIds: new Set(), nodeSizesById: new Map(),
    })
    harness.deferred.resolve(MOVE_MUTATION)
    expect(await execution).toBe('failed')
    expect(harness.onSuccess).not.toHaveBeenCalled()
    expect(harness.onFailure).toHaveBeenCalledTimes(1)
    expect(harness.locked).toBe(false)
  })
})
