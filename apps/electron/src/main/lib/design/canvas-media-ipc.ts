import { randomUUID } from 'node:crypto'
import type { IpcMainInvokeEvent, WebContents } from 'electron'
import {
  CANVAS_MEDIA_IPC_CHANNELS,
  parseAdoptCanvasMediaCandidateInput,
  parseCanvasMediaTarget,
  parseControlCanvasMediaRunInput,
  parseExportCanvasMediaOutputInput,
  parseReadCanvasMediaOutputPreviewInput,
  parseReleaseCanvasMediaPreviewInput,
  parseRunCanvasMediaModuleInput,
  parseSaveCanvasMediaModuleInput,
} from '@proma/shared'
import type { CanvasMediaModuleChangedEvent, CanvasMediaTarget, MediaAssetRecord, MediaAssetRef } from '@proma/shared'
import type { CanvasMediaService, CanvasMediaServiceDependencies } from './canvas-media-service'

/** IPC 只持有公开操作，不依赖服务的私有状态。 */
type CanvasMediaIpcService = Pick<CanvasMediaService, 'load' | 'readConfig' | 'checkPreparation' | 'save' | 'run' | 'cancel' | 'adopt' | 'readPreview' | 'exportOutput'>

/** 窗口只持有受管媒体的临时 URL，不能指定磁盘路径。 */
export interface CanvasMediaIpcOptions {
  ipc: {
    handle(channel: string, handler: (event: IpcMainInvokeEvent, input: unknown) => unknown): void
    removeHandler(channel: string): void
  }
  assertSender(event: IpcMainInvokeEvent, projectId: string): void
  createService(files: CanvasMediaServiceDependencies['hostFiles']): CanvasMediaIpcService
  createMediaAccess(projectId: string): { assetBaseUrl: string; release(): void }
  exportAsset(event: IpcMainInvokeEvent, target: CanvasMediaTarget, asset: MediaAssetRef, record: MediaAssetRecord): Promise<{ cancelled: boolean }>
  onAdopted?(target: CanvasMediaTarget): void | Promise<void>
}

/** 精确窗口/模块绑定防止其它画布撤销当前预览。 */
interface PreviewLease {
  sender: WebContents
  target: CanvasMediaTarget
  release(): void
}

/** 从命令中提取完整目标，排除候选或运行字段。 */
function targetKey(target: CanvasMediaTarget): string {
  return JSON.stringify([target.projectId, target.canvasId, target.nodeId, target.mediaModuleId, target.mediaKind])
}

/** 轻量变更按已浏览画布订阅，大图节点数不消耗额外订阅名额。 */
function canvasKey(target: CanvasMediaTarget): string {
  return JSON.stringify([target.projectId, target.canvasId])
}

/** 注册音视频模块命令，并在销毁、撤权和退出时清理预览。 */
export function registerCanvasMediaIpcHandlers(options: CanvasMediaIpcOptions): {
  dispose(): void
  publishChanged(event: CanvasMediaModuleChangedEvent): void
} {
  /** 订阅随 LOAD 建立，按窗口限制已浏览画布数量。 */
  const windows = new Map<WebContents, { event: IpcMainInvokeEvent; targets: Map<string, CanvasMediaTarget>; cleanup(): void }>()
  const leases = new Map<string, PreviewLease>()
  const channels: string[] = []
  let disposed = false

  /** 释放一项授权，幂等路径供窗口关闭和显式释放共用。 */
  const releaseLease = (id: string): void => {
    const lease = leases.get(id)
    if (!lease) return
    leases.delete(id)
    lease.release()
  }

  /** 每次操作重新验证窗口身份，异步完成后不可沿用已销毁窗口。 */
  const authorize = (event: IpcMainInvokeEvent, target: CanvasMediaTarget): void => {
    if (disposed || event.sender.isDestroyed()) throw new Error('CANVAS_MEDIA_ACCESS_DENIED')
    options.assertSender(event, target.projectId)
  }

  /** 保留有界画布订阅及唯一窗口销毁监听，预览仍绑定精确模块。 */
  const track = (event: IpcMainInvokeEvent, target: CanvasMediaTarget): void => {
    let state = windows.get(event.sender)
    if (!state) {
      if (windows.size >= 32) throw new Error('CANVAS_MEDIA_WINDOW_LIMIT')
      const cleanup = (): void => {
        windows.delete(event.sender)
        for (const [id, lease] of leases) if (lease.sender === event.sender) releaseLease(id)
      }
      state = { event, targets: new Map(), cleanup }
      windows.set(event.sender, state)
      event.sender.once('destroyed', cleanup)
    }
    state.event = event
    const key = canvasKey(target)
    state.targets.delete(key)
    state.targets.set(key, { ...target })
    if (state.targets.size > 128) {
      const oldest = state.targets.keys().next().value
      if (typeof oldest === 'string') state.targets.delete(oldest)
    }
  }

  /** 预览和导出回调绑定当前窗口，核心服务仍共用同一 Store 与 MediaRun。 */
  const serviceFor = (event: IpcMainInvokeEvent): CanvasMediaIpcService => options.createService({
    openPreview: async (target, _asset, record) => {
      authorize(event, target)
      if (leases.size >= 256 || [...leases.values()].filter((lease) => lease.sender === event.sender).length >= 32) {
        throw new Error('CANVAS_MEDIA_PREVIEW_LIMIT')
      }
      const access = options.createMediaAccess(target.projectId)
      try {
        authorize(event, target)
        track(event, target)
        const mediaLeaseId = randomUUID()
        leases.set(mediaLeaseId, { sender: event.sender, target: { ...target }, release: access.release })
        return { mediaLeaseId, mediaUrl: `${access.assetBaseUrl.replace(/\/$/, '')}/${encodeURIComponent(record.filename)}` }
      } catch (error) {
        access.release()
        throw error
      }
    },
    releasePreview: async (target, id) => {
      const lease = leases.get(id)
      if (!lease) return
      if (lease.sender !== event.sender || targetKey(lease.target) !== targetKey(target)) {
        throw new Error('CANVAS_MEDIA_PREVIEW_ACCESS_DENIED')
      }
      releaseLease(id)
    },
    exportAsset: async (target, asset, record) => {
      authorize(event, target)
      const result = await options.exportAsset(event, target, asset, record)
      authorize(event, target)
      return result
    },
  })

  /** 解析在磁盘访问之前完成，所有调用共享 fresh sender 校验。 */
  const handle = <T extends CanvasMediaTarget>(channel: string, parse: (input: unknown) => T,
    operation: (service: CanvasMediaIpcService, input: T, event: IpcMainInvokeEvent) => Promise<unknown>): void => {
    channels.push(channel)
    options.ipc.handle(channel, async (event, raw) => {
      const input = parse(raw)
      authorize(event, input)
      const result = await operation(serviceFor(event), input, event)
      authorize(event, input)
      return result
    })
  }
  handle(CANVAS_MEDIA_IPC_CHANNELS.LOAD, parseCanvasMediaTarget, async (service, input, event) => {
    const result = await service.load(input)
    authorize(event, input)
    track(event, input)
    return result
  })
  handle(CANVAS_MEDIA_IPC_CHANNELS.CHECK_PREPARATION, parseCanvasMediaTarget, (service, input) => service.checkPreparation(input))
  handle(CANVAS_MEDIA_IPC_CHANNELS.READ_CONFIG, parseCanvasMediaTarget, (service, input) => service.readConfig(input))
  handle(CANVAS_MEDIA_IPC_CHANNELS.SAVE, parseSaveCanvasMediaModuleInput, (service, input) => service.save(input))
  handle(CANVAS_MEDIA_IPC_CHANNELS.RUN, parseRunCanvasMediaModuleInput, (service, input) => (
    service.run(input, { canvasMedia: parseCanvasMediaTarget({
      projectId: input.projectId, canvasId: input.canvasId, nodeId: input.nodeId,
      mediaModuleId: input.mediaModuleId, mediaKind: input.mediaKind,
    }) })
  ))
  handle(CANVAS_MEDIA_IPC_CHANNELS.CANCEL, parseControlCanvasMediaRunInput, (service, input) => service.cancel(input, input.runId))
  handle(CANVAS_MEDIA_IPC_CHANNELS.ADOPT, parseAdoptCanvasMediaCandidateInput, async (service, input) => {
    const result = await service.adopt(input)
    try { await options.onAdopted?.(input) } catch { console.error('[Canvas 媒体] 采用已提交，工作流恢复通知暂未完成') }
    return result
  })
  handle(CANVAS_MEDIA_IPC_CHANNELS.READ_PREVIEW, parseReadCanvasMediaOutputPreviewInput, async (service, input, event) => {
    const preview = await service.readPreview(input)
    try { authorize(event, input) } catch (error) { releaseLease(preview.mediaLeaseId); throw error }
    return preview
  })
  handle(CANVAS_MEDIA_IPC_CHANNELS.RELEASE_PREVIEW, parseReleaseCanvasMediaPreviewInput, async (_service, input, event) => {
    /** 即使节点已删除，也允许原窗口回收自己持有的授权。 */
    const lease = leases.get(input.mediaLeaseId)
    if (!lease) return
    if (lease.sender !== event.sender || targetKey(lease.target) !== targetKey(input)) throw new Error('CANVAS_MEDIA_PREVIEW_ACCESS_DENIED')
    releaseLease(input.mediaLeaseId)
  })
  handle(CANVAS_MEDIA_IPC_CHANNELS.EXPORT_OUTPUT, parseExportCanvasMediaOutputInput, (service, input) => service.exportOutput(input))
  return {
    publishChanged: (change) => {
      for (const [sender, state] of windows) {
        if (!state.targets.has(canvasKey(change.target))) continue
        try {
          authorize(state.event, change.target)
          sender.send(CANVAS_MEDIA_IPC_CHANNELS.MODULE_CHANGED, change)
        } catch {
          for (const [id, lease] of leases) if (lease.sender === sender && lease.target.projectId === change.target.projectId) releaseLease(id)
          state.targets.delete(canvasKey(change.target))
        }
      }
    },
    dispose: () => {
      disposed = true
      for (const channel of channels) options.ipc.removeHandler(channel)
      for (const [sender, state] of windows) sender.removeListener('destroyed', state.cleanup)
      windows.clear()
      for (const id of leases.keys()) releaseLease(id)
    },
  }
}
