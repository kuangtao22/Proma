import { describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import type { IpcMainInvokeEvent } from 'electron'
import { CANVAS_MEDIA_IPC_CHANNELS as CHANNELS } from '@proma/shared'
import type { CanvasMediaOutputPreview, CanvasMediaTarget, MediaAssetRecord, MediaAssetRef } from '@proma/shared'
import { registerCanvasMediaIpcHandlers } from './canvas-media-ipc'

/** 固定媒体目标与公开资产，不包含任何路径输入。 */
const target: CanvasMediaTarget = { projectId: 'project', canvasId: 'canvas', nodeId: 'video', mediaModuleId: 'module', mediaKind: 'video' }
const asset: MediaAssetRef = { assetId: 'asset', revision: 1, hash: 'a'.repeat(64), mediaKind: 'video' }
const record: MediaAssetRecord = { id: 'asset', revision: 1, hash: asset.hash, filename: 'asset.mp4', byteSize: 10,
  mediaType: 'video/mp4', mediaKind: 'video', createdAt: 1,
  metadata: { width: 1, height: 1, durationMs: 1000, fps: 1, codec: 'test', hasAudio: false } }

/** 用事件窗口和实际 IPC 注册验证租约归属与异步销毁。 */
function fixture(afterOpen?: () => void) {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, input: unknown) => unknown>()
  const authorized = new Set([1, 2])
  let releases = 0
  let calls = 0
  const savedInputs: unknown[] = []
  const window = (id: number) => Object.assign(new EventEmitter(), {
    id, destroyed: false, received: [] as unknown[],
    isDestroyed() { return this.destroyed },
    send(_channel: string, value: unknown) { this.received.push(value) },
  })
  const first = window(1)
  const second = window(2)
  const registration = registerCanvasMediaIpcHandlers({
    ipc: { handle: (channel, handler) => { handlers.set(channel, handler) }, removeHandler: (channel) => { handlers.delete(channel) } },
    assertSender: (event) => { if (!authorized.has(event.sender.id)) throw new Error('DENIED') },
    createMediaAccess: () => ({ assetBaseUrl: 'proma-file://grant/', release: () => { releases += 1 } }),
    exportAsset: async () => ({ cancelled: true }),
    createService: (files) => ({
      readConfig: async () => {
        calls += 1
        afterOpen?.()
        return { schemaVersion: 1, contentId: 'module', mediaKind: 'video', revision: 0,
          createdAt: 1, updatedAt: 1, profile: null, inputs: [], outputs: [], adoptedOutputs: [] }
      },
      checkPreparation: async () => { calls += 1; afterOpen?.(); return { configRevision: 0, workflowBound: false, inputsReady: true, ready: false, issues: [{ code: 'CANVAS_MEDIA_SOURCE_REQUIRED', message: '尚未绑定工作流。' }] } },
      load: async () => { calls += 1; return { target, config: { schemaVersion: 1, contentId: 'module', mediaKind: 'video', revision: 0,
        createdAt: 1, updatedAt: 1, profile: null, inputs: [], outputs: [], adoptedOutputs: [] }, candidates: [], runs: [], assets: [] } },
      save: async (input) => {
        savedInputs.push(input)
        return { schemaVersion: 1, contentId: 'module', mediaKind: 'video', revision: 1,
          createdAt: 1, updatedAt: 2, profile: null, workflow: input.workflow ?? null,
          inputs: input.inputs, outputs: input.outputs, adoptedOutputs: [] }
      }, run: async () => { throw new Error('unused') },
      cancel: async () => { throw new Error('unused') }, adopt: async () => { throw new Error('unused') },
      exportOutput: async () => files.exportAsset(target, asset, record),
      readPreview: async (input) => {
        const preview = await files.openPreview(target, asset, record)
        afterOpen?.()
        return { candidateId: input.candidateId, outputKey: input.outputKey, outputOrder: input.outputOrder, asset: record, ...preview }
      },
    }),
  })
  const invoke = (sender: typeof first, channel: string, input: unknown) => Promise.resolve().then(() => (
    handlers.get(channel)!({ sender } as unknown as IpcMainInvokeEvent, input)
  ))
  const preview = () => invoke(first, CHANNELS.READ_PREVIEW, { ...target, candidateId: 'candidate', outputKey: 'main', outputOrder: 0 }) as Promise<CanvasMediaOutputPreview>
  return { first, second, registration, handlers, authorized, invoke, preview, savedInputs,
    releases: () => releases, calls: () => calls }
}

describe('Canvas 媒体 IPC', () => {
  test('Given 已授权来源 When 只读配置 Then 返回配置且不创建预览或保存', async () => {
    const f = fixture()
    expect(await f.invoke(f.first, CHANNELS.READ_CONFIG, target)).toMatchObject({ contentId: 'module', revision: 0 })
    expect(f.calls()).toBe(1)
    expect(f.savedInputs).toEqual([])
    expect(f.releases()).toBe(0)
    f.registration.dispose()
  })
  test('Given 来源配置读取期间撤权 When 返回 Then 拒绝迟到配置', async () => {
    const f = fixture(() => { f.authorized.delete(1) })
    await expect(f.invoke(f.first, CHANNELS.READ_CONFIG, target)).rejects.toThrow('DENIED')
    expect(f.calls()).toBe(1)
    f.registration.dispose()
  })
  test('Given 合法窗口 When 按需检查准备状态 Then 返回分阶段事实且不保存或创建预览', async () => {
    const f = fixture()
    expect(await f.invoke(f.first, CHANNELS.CHECK_PREPARATION, target)).toMatchObject({ workflowBound: false, inputsReady: true, ready: false })
    expect(f.savedInputs).toEqual([])
    expect(f.releases()).toBe(0)
    f.registration.dispose()
  })
  test('Given 检查前无权限或响应前窗口销毁 When 准备检查 Then 拒绝访问和迟到结果', async () => {
    const f = fixture(() => { f.first.destroyed = true })
    f.authorized.delete(1)
    await expect(f.invoke(f.first, CHANNELS.CHECK_PREPARATION, target)).rejects.toThrow('DENIED')
    expect(f.calls()).toBe(0)
    f.authorized.add(1)
    await expect(f.invoke(f.first, CHANNELS.CHECK_PREPARATION, { ...target, path: '/private' })).rejects.toThrow('CANVAS_MEDIA_TARGET_INVALID')
    await expect(f.invoke(f.first, CHANNELS.CHECK_PREPARATION, target)).rejects.toThrow('CANVAS_MEDIA_ACCESS_DENIED')
    f.registration.dispose()
  })
  test('Given 公共 workflow 保存 payload When IPC 解析 Then 精确保留版本与连接引用', async () => {
    const f = fixture()
    await f.invoke(f.first, CHANNELS.SAVE, {
      ...target,
      expectedConfigRevision: 0,
      profile: null,
      workflow: { workflowId: 'public-video', workflowRevision: 2, connectionId: 'gpu' },
      inputs: [{ key: 'prompt', kind: 'text', source: { type: 'literal', value: '海边日落' } }],
      outputs: [{ key: 'video', mediaKind: 'video', role: 'primary', order: 0 }],
    })
    expect(f.savedInputs[0]).toMatchObject({
      profile: null,
      workflow: { workflowId: 'public-video', workflowRevision: 2, connectionId: 'gpu' },
    })
    f.registration.dispose()
  })

  test('Given 非授权窗口或多余路径字段 When 读取 Then 在模块操作前拒绝', async () => {
    const f = fixture()
    f.authorized.delete(1)
    await expect(f.invoke(f.first, CHANNELS.LOAD, target)).rejects.toThrow('DENIED')
    f.authorized.add(1)
    await expect(f.invoke(f.first, CHANNELS.LOAD, { ...target, path: '/private' })).rejects.toThrow('CANVAS_MEDIA_TARGET_INVALID')
    expect(f.calls()).toBe(0)
    f.registration.dispose()
  })
  test('Given 两个窗口 When 释放预览与销毁 Then 只能释放自己的模块租约且清理幂等', async () => {
    const f = fixture()
    const preview = await f.preview()
    expect(preview.mediaUrl).toBe('proma-file://grant/asset.mp4')
    await expect(f.invoke(f.second, CHANNELS.RELEASE_PREVIEW, { ...target, mediaLeaseId: preview.mediaLeaseId })).rejects.toThrow('CANVAS_MEDIA_PREVIEW_ACCESS_DENIED')
    expect(f.releases()).toBe(0)
    f.first.destroyed = true
    f.first.emit('destroyed')
    expect(f.releases()).toBe(1)
    f.registration.dispose()
    expect(f.releases()).toBe(1)
    expect(f.handlers.size).toBe(0)
  })
  test('Given 预览返回前窗口关闭 When 异步完成 Then 撤回 URL 并拒绝迟到响应', async () => {
    const f = fixture(() => { f.first.destroyed = true; f.first.emit('destroyed') })
    await expect(f.preview()).rejects.toThrow('CANVAS_MEDIA_ACCESS_DENIED')
    expect(f.releases()).toBe(1)
    f.registration.dispose()
  })
  test('Given 模块变化 When 窗口撤权 Then 不广播并回收已有预览', async () => {
    const f = fixture()
    await f.invoke(f.first, CHANNELS.LOAD, target)
    await f.preview()
    f.registration.publishChanged({ target, revision: 2 })
    expect(f.first.received).toHaveLength(1)
    f.authorized.delete(1)
    f.registration.publishChanged({ target, revision: 3 })
    expect(f.first.received).toHaveLength(1)
    expect(f.releases()).toBe(1)
    f.registration.dispose()
  })
  test('Given 同画布超过128个媒体节点 When 最早节点创建新任务 Then 仍广播且其它未浏览画布不接收', async () => {
    const f = fixture()
    for (let index = 0; index < 130; index += 1) {
      await f.invoke(f.first, CHANNELS.LOAD, { ...target, nodeId: `video-${index}`, mediaModuleId: `module-${index}` })
    }
    f.registration.publishChanged({ target: { ...target, nodeId: 'video-0', mediaModuleId: 'module-0' }, revision: 1 })
    expect(f.first.received).toHaveLength(1)
    expect(f.second.received).toHaveLength(0)
    f.registration.publishChanged({ target: { ...target, canvasId: 'other-canvas' }, revision: 1 })
    f.registration.publishChanged({ target: { ...target, projectId: 'other-project' }, revision: 1 })
    expect(f.first.received).toHaveLength(1)
    f.registration.dispose()
  })
})
