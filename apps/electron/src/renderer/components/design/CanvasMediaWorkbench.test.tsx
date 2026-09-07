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
import {
  CanvasMediaPreviewLeaseOwner,
  CanvasMediaDraftLoadGuard,
  CanvasMediaWorkbench,
  buildCanvasMediaWorkflowValues,
  createCanvasMediaWorkflowDraft,
  createCanvasMediaWorkflowSelection,
  createCanvasMediaWorkflowSelectionDraft,
  getCanvasMediaDisplayRun,
  getCanvasMediaAdoptionKeys,
  getCanvasMediaErrorMessage,
  releaseCanvasMediaPreview,
  replaceCanvasMediaPreview,
  resolveCanvasMediaWorkflow,
  saveAndRunCanvasMedia,
  validateCanvasMediaWorkflowDrafts,
  type CanvasMediaWorkbenchAdapter,
} from './CanvasMediaWorkbench'

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
  test('Given 工作台首次渲染 When 异步快照尚未返回 Then 显示加载态', () => {
    const html = renderToStaticMarkup(
      <CanvasMediaWorkbench target={target} writable adapter={createAdapter()} />,
    )
    expect(html).toContain('加载媒体模块')
    expect(getCanvasMediaErrorMessage(new Error('模块损坏'), '媒体模块加载失败。')).toBe('模块损坏')
    expect(getCanvasMediaErrorMessage('unknown', '媒体模块加载失败。')).toBe('媒体模块加载失败。')
  })

  test('Given 用户选择公共工作流 When 创建草稿 Then 标量从 prompt 初始化且媒体保持空选', () => {
    const draft = createCanvasMediaWorkflowSelectionDraft(
      target,
      createWorkflow(),
    )

    expect(draft.inputs).toEqual([
      {
        key: 'prompt', kind: 'text', label: '提示词', controlType: 'text', required: true,
        sourceType: 'literal', value: '默认提示词', asset: null, nodeId: '', outputKey: 'agent.text',
      },
      {
        key: 'source', kind: 'image', label: '参考图', controlType: 'image', required: true,
        sourceType: 'literal', value: '', asset: null, nodeId: '', outputKey: 'image.asset',
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

  test('Given 草稿已修改且后台模块事件返回 When LOAD 完成 Then 刷新快照但不覆盖草稿', () => {
    const guard = new CanvasMediaDraftLoadGuard()
    const initial = guard.begin()
    expect(guard.accept(initial, false)).toEqual({ accepted: true, replaceDraft: true })
    guard.markDirty()
    const refresh = guard.begin()
    expect(guard.accept(refresh, true)).toEqual({ accepted: true, replaceDraft: false })
    guard.markClean()
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
