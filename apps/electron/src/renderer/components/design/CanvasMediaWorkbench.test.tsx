import { describe, expect, test } from 'bun:test'
import type {
  CanvasMediaModuleSnapshot,
  CanvasMediaOutputPreview,
  CanvasMediaTarget,
  MediaProfile,
  MediaInputValue,
  MediaRunSnapshot,
  MediaSettingsSnapshot,
  MediaWorkflowVersion,
} from '@proma/shared'
import { renderToStaticMarkup } from 'react-dom/server'
import * as React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import {
  CanvasMediaPreviewLeaseOwner,
  CanvasMediaPreviewAutoloadGuard,
  CanvasMediaDraftLoadGuard,
  CanvasMediaWorkflowForm,
  CanvasMediaWorkbench,
  buildCanvasMediaUnboundInputs,
  buildPartialInputs,
  buildCanvasMediaWorkflowValues,
  createInputDrafts,
  createCanvasMediaWorkflowDraft,
  createCanvasMediaWorkflowSelection,
  createCanvasMediaWorkflowSelectionDraft,
  getCanvasMediaDisplayRun,
  getCanvasMediaAdoptionKeys,
  getCanvasMediaErrorMessage,
  releaseCanvasMediaPreview,
  replaceCanvasMediaPreview,
  resolveCanvasMediaDefaultPreview,
  resolveDelayedCanvasDefaultConnection,
  resolveCanvasMediaWorkflow,
  resolveCanvasMediaWorkflowConnection,
  selectCanvasMediaWorkflowsForProject,
  saveAndRunCanvasMedia,
  useDelayedCanvasDefaultConnection,
  validateCanvasMediaWorkflowDrafts,
  type CanvasMediaWorkbenchAdapter,
} from './CanvasMediaWorkbench'

interface MinimalEventTarget {
  addEventListener: () => void
  removeEventListener: () => void
}

/** 创建只运行 Effect 的最小 React 宿主，验证默认连接延迟更新。 */
function createHookRoot(): {
  render: (node: React.ReactElement) => void
  unmount: () => void
  restore: () => void
} {
  /** React DOM 所需的最小事件目标。 */
  const eventTarget: MinimalEventTarget = { addEventListener: () => undefined, removeEventListener: () => undefined }
  class FakeHtmlIFrameElement {}
  /** Hook 测试不生成 DOM，仅提供 React DOM 初始化要求的宿主字段。 */
  const fakeWindow = { ...eventTarget, event: undefined, HTMLIFrameElement: FakeHtmlIFrameElement }
  const fakeDocument = {
    ...eventTarget,
    nodeType: 9,
    defaultView: fakeWindow,
    activeElement: null,
    body: null,
    documentElement: { namespaceURI: 'http://www.w3.org/1999/xhtml' },
  }
  const container = {
    ...eventTarget,
    nodeType: 1,
    tagName: 'DIV',
    namespaceURI: 'http://www.w3.org/1999/xhtml',
    ownerDocument: fakeDocument,
  }
  /** 保存测试前全局对象，卸载后完整恢复。 */
  const globals = globalThis as unknown as { window?: unknown; document?: unknown; IS_REACT_ACT_ENVIRONMENT?: boolean }
  const previousWindow = globals.window
  const previousDocument = globals.document
  const previousActEnvironment = globals.IS_REACT_ACT_ENVIRONMENT
  globals.window = fakeWindow
  globals.document = fakeDocument
  globals.IS_REACT_ACT_ENVIRONMENT = true
  /** 当前测试使用的 React 根。 */
  const root = createRoot(container as unknown as Element)
  return {
    render: (node) => { root.render(node) },
    unmount: () => { root.unmount() },
    restore: () => {
      globals.window = previousWindow
      globals.document = previousDocument
      globals.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
    },
  }
}

/** 通过真实 Effect 暴露空草稿当前继承的连接。 */
function DelayedDefaultConnectionProbe({
  defaultConnectionId,
  dirty = false,
  onValue,
}: {
  defaultConnectionId: string | null
  dirty?: boolean
  onValue: (connectionId: string) => void
}): null {
  /** Probe 内部连接状态与真实工作台保持同一初始化方式。 */
  const [connectionId, setConnectionId] = React.useState('')
  useDelayedCanvasDefaultConnection(connectionId, defaultConnectionId, false, false, dirty, setConnectionId)
  React.useEffect(() => onValue(connectionId), [connectionId, onValue])
  return null
}

/** 测试使用的完整视频节点目标。 */
const target: CanvasMediaTarget = {
  projectId: 'project-1', canvasId: 'canvas-1', nodeId: 'video-1',
  mediaModuleId: 'media-1', mediaKind: 'video',
}

/** 创建固定视频工作流及成组音画输出。 */
function createWorkflow(): MediaWorkflowVersion {
  return {
    id: 'workflow-1', name: '短片', projectId: null, revision: 2,
    hash: 'a'.repeat(64), createdAt: 1,
    definition: {
      schemaVersion: 1,
      prompt: {
        '1': { class_type: 'TextNode', inputs: { text: '默认提示词' } },
        '2': { class_type: 'LoadImage', inputs: { image: '' } },
      },
      bindings: [
        { key: 'prompt', kind: 'text', nodeId: '1', input: 'text', field: {
          classType: 'TextNode', valueKind: 'string', label: '提示词', controlType: 'text', required: true,
        } },
        { key: 'source', kind: 'image', nodeId: '2', input: 'image', loader: 'LoadImage', field: {
          classType: 'LoadImage', valueKind: 'string', label: '参考图', controlType: 'image', required: true,
        } },
      ],
      outputs: [
        { key: 'video', nodeId: '3', outputIndex: 0, mediaType: 'video' },
        { key: 'audio', nodeId: '3', outputIndex: 1, mediaType: 'audio' },
      ],
    },
  }
}

/** 创建指向固定工作流版本的视频预设。 */
function createProfile(): MediaProfile {
  return {
    id: 'profile-1', name: '视频预设', revision: 4, connectionId: 'connection-1',
    workflowId: 'workflow-1', workflowRevision: 2, mediaKind: 'video',
    projectId: target.projectId, enabled: true, createdAt: 1,
  }
}

/** 创建包含一个图片输入素材和成组候选的媒体快照。 */
function createSnapshot(): CanvasMediaModuleSnapshot {
  return {
    target,
    config: {
      schemaVersion: 1, contentId: target.mediaModuleId, mediaKind: 'video', revision: 3,
      createdAt: 1, updatedAt: 3, profile: null, inputs: [], outputs: [], adoptedOutputs: [],
    },
    candidates: [{
      id: 'candidate-1', operationId: 'operation-1', runId: 'run-1', sourceConfigRevision: 3,
      sourceRef: { kind: 'profile-version', profileId: 'profile-1', profileRevision: 4 },
      profile: { profileId: 'profile-1', profileRevision: 4 }, createdAt: 4,
      outputs: [
        {
          key: 'video', mediaKind: 'video', role: 'primary', order: 0, bundle: 'take-1',
          asset: { assetId: 'video-1', revision: 1, hash: 'b'.repeat(64), mediaKind: 'video' },
        },
        {
          key: 'audio', mediaKind: 'audio', role: 'auxiliary', order: 1, bundle: 'take-1',
          asset: { assetId: 'audio-1', revision: 1, hash: 'c'.repeat(64), mediaKind: 'audio' },
        },
      ],
    }],
    runs: [],
    assets: [{
      id: 'image-1', revision: 1, hash: 'd'.repeat(64), filename: 'source.png',
      byteSize: 1, mediaType: 'image/png', mediaKind: 'image', createdAt: 1,
      metadata: { width: 10, height: 10 },
    }],
  }
}

/** 创建运行命令返回的最小公开快照。 */
function createRun(): MediaRunSnapshot {
  return {
    id: 'run-1', projectId: target.projectId, revision: 0, phase: 'prepared',
    profileId: 'profile-1', profileRevision: 4, createdAt: 1, updatedAt: 1,
    outputs: [], error: null, progress: null,
  }
}

/** 创建可供首屏 SSR 的完整空操作 Adapter。 */
function createAdapter(snapshot = createSnapshot()): CanvasMediaWorkbenchAdapter {
  const settings: MediaSettingsSnapshot = {
    schemaVersion: 1, revision: 1, connections: [],
    workflows: [createWorkflow()], profiles: [createProfile()],
  }
  return {
    canvasMediaLoad: async () => snapshot,
    canvasMediaSave: async () => snapshot.config,
    canvasMediaRun: async () => createRun(),
    canvasMediaCancel: async () => createRun(),
    canvasMediaAdopt: async () => snapshot.config,
    canvasMediaReadPreview: async () => { throw new Error('测试未提供预览') },
    canvasMediaReleasePreview: async () => undefined,
    canvasMediaExportOutput: async () => ({ cancelled: false }),
    onCanvasMediaChanged: () => () => undefined,
    mediaGetSettings: async () => settings,
    mediaWatchProject: async () => undefined,
    mediaUnwatchProject: async () => undefined,
    onMediaRunChanged: () => () => undefined,
  }
}

describe('CanvasMediaWorkbench', () => {
  test('Given 未绑定工作流的草稿同时包含直接值和节点来源 When 保存输入 Then 保留类型化直接值且不伪造工作流字段', () => {
    /** 无模板也必须保留已填文本、数字、布尔和媒体引用。 */
    const config = createSnapshot().config
    config.workflow = null
    config.profile = null
    config.inputs = [
      { key: 'prompt', kind: 'text', source: { type: 'literal', value: '动态词' } },
      { key: 'seed', kind: 'number', source: { type: 'literal', value: 42 } },
      { key: 'flag', kind: 'boolean', source: { type: 'literal', value: false } },
      { key: 'frame', kind: 'image', source: { type: 'literal', value: { assetId: 'frame', revision: 1, hash: 'a'.repeat(64), mediaKind: 'image' } } },
      { key: 'end', kind: 'image', source: { type: 'canvas-output', nodeId: 'tail', outputKey: 'image.asset' } },
    ]
    expect(buildCanvasMediaUnboundInputs(createInputDrafts(config, undefined))).toEqual(config.inputs)
  })
  test('Given 新音视频配置有画布默认连接 When 建立草稿 Then 继承默认且不覆盖已保存连接', () => {
    expect(resolveCanvasMediaWorkflowConnection(null, 'connection-default')).toBe('connection-default')
    expect(resolveCanvasMediaWorkflowConnection('connection-saved', 'connection-default')).toBe('connection-saved')
  })

  test('Given 默认连接稍晚到达 When 音视频草稿仍空白干净 Then 跟随默认；已有选择或编辑时保持当前值', () => {
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

  test('Given 工作台先以空默认挂载 When 默认异步变化且草稿随后标脏 Then Effect 只更新干净阶段', async () => {
    /** 记录真实 Effect 提交后的连接变化。 */
    const values: string[] = []
    /** Probe 每次连接真实改变后写入记录。 */
    const onValue = (connectionId: string): void => { values.push(connectionId) }
    /** 当前测试使用的无 DOM 子节点 React 宿主。 */
    const host = createHookRoot()
    try {
      await act(async () => { host.render(<DelayedDefaultConnectionProbe defaultConnectionId={null} onValue={onValue} />) })
      await act(async () => { host.render(<DelayedDefaultConnectionProbe defaultConnectionId="connection-late" onValue={onValue} />) })
      await act(async () => { host.render(<DelayedDefaultConnectionProbe defaultConnectionId="connection-new" onValue={onValue} />) })
      await act(async () => { host.render(<DelayedDefaultConnectionProbe defaultConnectionId="connection-ignored" dirty onValue={onValue} />) })
      expect(values).toEqual(['', 'connection-late', 'connection-new'])
    } finally {
      act(() => { host.unmount() })
      host.restore()
    }
  })

  test('Given 公共、当前项目与其它项目工作流并存 When 音视频节点列目录 Then 不泄漏其它项目草稿', () => {
    const workflow = createWorkflow()
    expect(selectCanvasMediaWorkflowsForProject([
      workflow,
      { ...workflow, id: 'workflow-project', projectId: target.projectId },
      { ...workflow, id: 'workflow-other', projectId: 'project-2' },
    ], target.projectId).map((item) => item.id)).toEqual(['workflow-1', 'workflow-project'])
  })

  test('Given 工作台首次渲染 When 异步快照尚未返回 Then 显示加载态', () => {
    const html = renderToStaticMarkup(
      <CanvasMediaWorkbench target={target} writable adapter={createAdapter()} />,
    )
    expect(html).toContain('加载媒体模块')
    expect(getCanvasMediaErrorMessage(new Error('模块损坏'), '媒体模块加载失败。')).toBe('模块损坏')
    expect(getCanvasMediaErrorMessage('unknown', '媒体模块加载失败。')).toBe('媒体模块加载失败。')
  })

  test('Given 文件仍被其它操作占用 When 详情显示本地或 IPC 错误 Then 说明可重试原因并保留错误码', () => {
    expect(getCanvasMediaErrorMessage(new Error('MEDIA_FILE_BUSY'), '加载失败。'))
      .toBe('媒体数据正在被其他操作使用，请稍后重试。（MEDIA_FILE_BUSY）')
    expect(getCanvasMediaErrorMessage(new Error("Error invoking remote method 'canvas-media:load': Error: MEDIA_FILE_BUSY"), '加载失败。'))
      .toBe('媒体数据正在被其他操作使用，请稍后重试。（MEDIA_FILE_BUSY）')
    expect(getCanvasMediaErrorMessage(new Error(''), '媒体模块加载失败。')).toBe('媒体模块加载失败。')
  })

  test('Given 补线遇到并发或运行态阻挡 When 展示错误 Then 提供具体恢复动作', () => {
    expect(getCanvasMediaErrorMessage(new Error('CANVAS_MEDIA_CONNECT_BLOCKED'), '失败'))
      .toContain('等待相关节点运行或审批结束')
    expect(getCanvasMediaErrorMessage(new Error("Error invoking remote method 'canvas:save': Error: CANVAS_REVISION_CONFLICT"), '失败'))
      .toContain('重新打开详情')
    expect(getCanvasMediaErrorMessage(new Error('CANVAS_MEDIA_CONFIG_CONFLICT'), '失败'))
      .toContain('输入配置已变化')
  })

  test('Given 用户选择公共工作流 When 创建草稿 Then 标量从 prompt 初始化且媒体保持空选', () => {
    const draft = createCanvasMediaWorkflowSelectionDraft(
      target,
      createWorkflow(),
    )

    expect(draft.inputs).toEqual([
      {
        key: 'prompt', kind: 'text', label: '提示词', controlType: 'text', required: true,
        sourceType: 'literal', value: '默认提示词', asset: null,
        bindingNodeId: '1', bindingInput: 'text', sourceNodeId: '', outputKey: 'agent.text',
      },
      {
        key: 'source', kind: 'image', label: '参考图', controlType: 'image', required: true,
        sourceType: 'literal', value: '', asset: null,
        bindingNodeId: '2', bindingInput: 'image', sourceNodeId: '', outputKey: 'image.asset',
      },
    ])
    expect(draft.outputs).toEqual([
      { key: 'video', mediaKind: 'video', role: 'primary', order: 0 },
      { key: 'audio', mediaKind: 'audio', role: 'auxiliary', order: 1 },
    ])
  })

  test('Given 同 ID 存在多个 workflow revision When 显式选择新版本 Then 精确保留并解析该 revision', () => {
    const oldWorkflow = { ...createWorkflow(), revision: 1, name: '旧工作流' }
    const currentWorkflow = createWorkflow()
    const selection = createCanvasMediaWorkflowSelection(currentWorkflow)

    expect(selection).toBe('workflow-1:2')
    expect(resolveCanvasMediaWorkflow([oldWorkflow, currentWorkflow], selection)).toEqual(currentWorkflow)
  })

  test('Given field 约束和显式素材 When 构造 typed values Then 校验数字并保留不可变资产引用', () => {
    const workflow = createWorkflow()
    const asset = createSnapshot().assets[0]!
    const values: Record<string, MediaInputValue> = {
      source: { kind: 'asset', asset: { assetId: asset.id, revision: asset.revision, hash: asset.hash, mediaKind: asset.mediaKind } },
    }
    const drafts = createCanvasMediaWorkflowDraft(workflow, values)
    expect(buildCanvasMediaWorkflowValues(workflow, drafts)).toEqual({
      values: {
        prompt: { kind: 'scalar', value: '默认提示词' },
        source: values.source!,
      },
      error: null,
    })
  })

  test('Given 必填媒体仍为空 When 保存前校验 Then 明确要求用户选择素材', () => {
    const workflow = createWorkflow()
    const drafts = createCanvasMediaWorkflowDraft(workflow)
    expect(validateCanvasMediaWorkflowDrafts(workflow, drafts)).toBe('输入 参考图 需要选择素材。')
  })

  test('Given 只保存已知字段和完整 Canvas 来源 When 重新加载 Then 保留值且缺失字段为空', () => {
    const workflow = createWorkflow()
    const drafts = createCanvasMediaWorkflowDraft(workflow)
    const partialDrafts = drafts.map((draft) => draft.key === 'source'
      ? { ...draft, sourceType: 'canvas-output' as const, sourceNodeId: 'image-node-7', outputKey: 'image.asset' }
      : { ...draft, value: '用户提示词' })
    const inputs = buildPartialInputs(workflow, partialDrafts)
    expect(inputs).toEqual([
      { key: 'prompt', kind: 'text', source: { type: 'literal', value: '用户提示词' } },
      { key: 'source', kind: 'image', source: { type: 'canvas-output', nodeId: 'image-node-7', outputKey: 'image.asset' } },
    ])

    const config = { ...createSnapshot().config, workflow: {
      workflowId: workflow.id, workflowRevision: workflow.revision, connectionId: 'connection-1',
    }, inputs: inputs.slice(0, 1) }
    const reloaded = createInputDrafts(config, workflow)
    expect(reloaded[0]?.value).toBe('用户提示词')
    expect(reloaded[1]).toMatchObject({ value: '', asset: null, bindingNodeId: '2', bindingInput: 'image' })
  })

  test('Given 基础字段和多个生成参数 When 渲染表单 Then 使用一个高级折叠组并显示真实绑定位置', () => {
    const workflow = createWorkflow()
    workflow.definition.prompt['4'] = { class_type: 'KSampler', inputs: { seed: 1, steps: 20 } }
    workflow.definition.bindings.push(
      { key: 'seed', kind: 'number', nodeId: '4', input: 'seed', field: {
        classType: 'KSampler', valueKind: 'number', label: '种子', controlType: 'seed', required: true,
      } },
      { key: 'steps', kind: 'number', nodeId: '4', input: 'steps', field: {
        classType: 'KSampler', valueKind: 'number', label: '步数', controlType: 'number', required: true,
      } },
    )
    const html = renderToStaticMarkup(<CanvasMediaWorkflowForm
      inputs={createCanvasMediaWorkflowDraft(workflow)} assets={[]} writable busy={false} onInputChange={() => undefined}
    />)
    expect(html.match(/<details/g)?.length).toBe(1)
    expect(html).toContain('高级参数')
    expect(html).toContain('节点 1 · text')
    expect(html).toContain('节点 4 · seed')
    expect(html).toContain('待选择素材。')
  })

  test('Given 草稿已修改且后台模块事件返回 When LOAD 完成 Then 刷新快照但不覆盖草稿', () => {
    const guard = new CanvasMediaDraftLoadGuard()
    const initial = guard.begin()
    expect(guard.accept(initial, false)).toEqual({ accepted: true, replaceDraft: true })
    guard.markDirty()
    expect(guard.isDirty()).toBeTrue()
    const refresh = guard.begin()
    expect(guard.accept(refresh, true)).toEqual({ accepted: true, replaceDraft: false })
    guard.markClean()
    expect(guard.isDirty()).toBeFalse()
    const saved = guard.begin()
    expect(guard.accept(saved, true)).toEqual({ accepted: true, replaceDraft: true })
  })

  test('Given 旧目标 LOAD 仍在途 When 切换目标并完成新 LOAD Then 旧响应不能提交', () => {
    const guard = new CanvasMediaDraftLoadGuard()
    const oldTargetLoad = guard.begin()
    guard.invalidate()
    const newTargetLoad = guard.begin()

    expect(guard.accept(oldTargetLoad, false).accepted).toBeFalse()
    expect(guard.accept(newTargetLoad, false)).toEqual({ accepted: true, replaceDraft: true })
  })

  test('Given 活跃运行与较新的终态并存 When 投影工作台状态 Then 优先展示真实活跃阶段和节点计数', () => {
    const active = createRun()
    const newestTerminal = { ...createRun(), id: 'run-2', revision: 3, updatedAt: 9, phase: 'succeeded' as const }
    expect(getCanvasMediaDisplayRun([newestTerminal, active])).toEqual(active)
  })

  test('Given 用户点击运行 When 保存成功 Then 使用新 revision 串行启动', async () => {
    const calls: string[] = []
    const saved = { ...createSnapshot().config, revision: 8 }

    await saveAndRunCanvasMedia(
      target,
      'operation-8',
      async () => { calls.push('save'); return saved },
      async (input) => { calls.push(`run:${input.expectedConfigRevision}:${input.operationId}`); return createRun() },
    )

    expect(calls).toEqual(['save', 'run:8:operation-8'])
  })

  test('Given 已有候选预览 When 切换并卸载 Then 每个 lease 都先释放且只释放一次', async () => {
    const calls: string[] = []
    const oldPreview: CanvasMediaOutputPreview = {
      candidateId: 'candidate-old', outputKey: 'video', outputOrder: 0,
      asset: {
        id: 'video-old', revision: 1, hash: 'e'.repeat(64), filename: 'old.mp4',
        byteSize: 1, mediaType: 'video/mp4', mediaKind: 'video', createdAt: 1,
        metadata: { width: 10, height: 10, durationMs: 10, fps: 24, codec: 'h264', hasAudio: true },
      },
      mediaLeaseId: 'lease-old', mediaUrl: 'proma-media://lease-old/output',
    }
    const nextPreview = { ...oldPreview, candidateId: 'candidate-1', mediaLeaseId: 'lease-next' }
    const adapter = {
      canvasMediaReleasePreview: async (input: Parameters<CanvasMediaWorkbenchAdapter['canvasMediaReleasePreview']>[0]) => {
        calls.push(`release:${input.mediaLeaseId}`)
      },
      canvasMediaReadPreview: async () => { calls.push('read'); return nextPreview },
    }

    const opened = await replaceCanvasMediaPreview(adapter, target, oldPreview, {
      ...target, candidateId: 'candidate-1', outputKey: 'video', outputOrder: 0,
    })
    await releaseCanvasMediaPreview(adapter, target, opened)

    expect(calls).toEqual(['release:lease-old', 'read', 'release:lease-next'])
  })

  test('Given 两次预览读取交错完成 When 较早请求最后返回 Then 仅保留最后一次选择并释放过期 lease', async () => {
    const shown: Array<string | null> = []
    const released: string[] = []
    const resolvers: Array<(preview: CanvasMediaOutputPreview) => void> = []
    const owner = new CanvasMediaPreviewLeaseOwner({
      canvasMediaReleasePreview: async (input) => { released.push(input.mediaLeaseId) },
      canvasMediaReadPreview: () => new Promise((resolve) => { resolvers.push(resolve) }),
    }, target, (preview) => { shown.push(preview?.mediaLeaseId ?? null) })
    const basePreview: CanvasMediaOutputPreview = {
      candidateId: 'candidate-1', outputKey: 'video', outputOrder: 0,
      asset: {
        id: 'video-1', revision: 1, hash: 'e'.repeat(64), filename: 'video.mp4',
        byteSize: 1, mediaType: 'video/mp4', mediaKind: 'video', createdAt: 1,
        metadata: { width: 10, height: 10, durationMs: 10, fps: 24, codec: 'h264', hasAudio: true },
      },
      mediaLeaseId: 'lease-a', mediaUrl: 'proma-media://lease-a/output',
    }

    const first = owner.replace({ ...target, candidateId: 'candidate-1', outputKey: 'video', outputOrder: 0 })
    const second = owner.replace({ ...target, candidateId: 'candidate-1', outputKey: 'audio', outputOrder: 1 })
    /** 两次 replace 都先等待空 lease 释放，推进微任务后读取 resolver 才已登记。 */
    await Promise.resolve()
    resolvers[1]!({ ...basePreview, outputKey: 'audio', outputOrder: 1, mediaLeaseId: 'lease-b' })
    await second
    resolvers[0]!(basePreview)
    await first

    expect(shown).toEqual([null, null, 'lease-b'])
    expect(released).toEqual(['lease-a'])
    await owner.release()
    expect(released).toEqual(['lease-a', 'lease-b'])
  })

  test('Given 视频尚未显式采用 When 快照含多份主输出 Then 默认选择最早候选及最小输出顺序', () => {
    const snapshot = createSnapshot()
    snapshot.candidates = [
      {
        ...snapshot.candidates[0]!, id: 'candidate-later', createdAt: 8,
        outputs: [
          { ...snapshot.candidates[0]!.outputs[0]!, key: 'video-2', order: 2 },
          { ...snapshot.candidates[0]!.outputs[0]!, key: 'video-1', order: 1 },
        ],
      },
      {
        ...snapshot.candidates[0]!, id: 'candidate-first', createdAt: 3,
        outputs: [
          { ...snapshot.candidates[0]!.outputs[0]!, key: 'video-b', order: 4 },
          { ...snapshot.candidates[0]!.outputs[0]!, key: 'video-a', order: 0 },
        ],
      },
      {
        ...snapshot.candidates[0]!, id: 'candidate-same-time', createdAt: 3,
        outputs: [{ ...snapshot.candidates[0]!.outputs[0]!, key: 'video-c', order: 0 }],
      },
    ]

    expect(resolveCanvasMediaDefaultPreview(snapshot)).toEqual({
      candidateId: 'candidate-first', outputKey: 'video-a', outputOrder: 0,
    })
  })

  test('Given 视频已有正式主输出 When 解析默认预览 Then 已采用项优先于最早候选且音频不自动预览', () => {
    const snapshot = createSnapshot()
    const adoptedCandidate = {
      ...snapshot.candidates[0]!, id: 'candidate-adopted', createdAt: 20,
      outputs: [{ ...snapshot.candidates[0]!.outputs[0]!, key: 'final-video', order: 5 }],
    }
    snapshot.candidates.push(adoptedCandidate)
    snapshot.config.adoptedOutputs = [{
      ...adoptedCandidate.outputs[0]!, candidateId: adoptedCandidate.id, runId: adoptedCandidate.runId,
    }]

    expect(resolveCanvasMediaDefaultPreview(snapshot)).toEqual({
      candidateId: 'candidate-adopted', outputKey: 'final-video', outputOrder: 5,
    })
    expect(resolveCanvasMediaDefaultPreview({ ...snapshot, target: { ...snapshot.target, mediaKind: 'audio' } })).toBeNull()
  })

  test('Given 默认预览读取失败或用户手动选中 When 普通快照刷新 Then 不重复读取也不抢回；目标切换后可重新初始化', () => {
    const guard = new CanvasMediaPreviewAutoloadGuard()
    const first = { candidateId: 'candidate-1', outputKey: 'video', outputOrder: 0 }
    const adopted = { candidateId: 'candidate-2', outputKey: 'video', outputOrder: 0 }

    expect(guard.claim('project-1/canvas-1/video-1', first)).toBeTrue()
    expect(guard.claim('project-1/canvas-1/video-1', first)).toBeFalse()
    guard.markManual('project-1/canvas-1/video-1')
    expect(guard.claim('project-1/canvas-1/video-1', adopted)).toBeFalse()
    expect(guard.claim('project-1/canvas-1/video-2', first)).toBeTrue()
    guard.resetForTarget('project-1/canvas-1/video-empty')
    guard.resetForTarget('project-1/canvas-1/video-1')
    expect(guard.claim('project-1/canvas-1/video-1', first)).toBeTrue()
  })

  test('Given 预览仍在读取 When 工作台释放 owner Then 读取完成后自动释放新 lease', async () => {
    const shown: Array<string | null> = []
    const released: string[] = []
    let resolvePreview: ((preview: CanvasMediaOutputPreview) => void) | undefined
    const owner = new CanvasMediaPreviewLeaseOwner({
      canvasMediaReleasePreview: async (input) => { released.push(input.mediaLeaseId) },
      canvasMediaReadPreview: () => new Promise((resolve) => { resolvePreview = resolve }),
    }, target, (preview) => { shown.push(preview?.mediaLeaseId ?? null) })
    const pending = owner.replace({ ...target, candidateId: 'candidate-1', outputKey: 'video', outputOrder: 0 })
    await owner.release()
    resolvePreview!({
      candidateId: 'candidate-1', outputKey: 'video', outputOrder: 0,
      asset: {
        id: 'video-1', revision: 1, hash: 'e'.repeat(64), filename: 'video.mp4',
        byteSize: 1, mediaType: 'video/mp4', mediaKind: 'video', createdAt: 1,
        metadata: { width: 10, height: 10, durationMs: 10, fps: 24, codec: 'h264', hasAudio: true },
      },
      mediaLeaseId: 'lease-after-unmount', mediaUrl: 'proma-media://lease-after-unmount/output',
    })
    await pending

    expect(shown).toEqual([null, null])
    expect(released).toEqual(['lease-after-unmount'])
  })

  test('Given 候选输出属于 bundle When 采用任一输出 Then 提交同组全部 key', () => {
    const candidate = createSnapshot().candidates[0]!
    expect(getCanvasMediaAdoptionKeys(candidate, 'audio')).toEqual(['video', 'audio'])
    expect(getCanvasMediaAdoptionKeys(candidate, 'missing')).toEqual([])
  })
})
