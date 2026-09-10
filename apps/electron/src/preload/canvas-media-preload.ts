import { CANVAS_MEDIA_IPC_CHANNELS, parseCanvasMediaModuleChangedEvent } from '@proma/shared'
import type { CanvasMediaPreloadApi } from '@proma/shared'

/** 统一音视频模块的 IPC 桥接；事件先按共享合同解析。 */
export function createCanvasMediaPreloadApi(
  invoke: (channel: string, input?: unknown) => Promise<unknown>,
  listen: (channel: string, callback: (value: unknown) => void) => () => void,
): CanvasMediaPreloadApi {
  return {
    canvasMediaLoad: (input) => invoke(CANVAS_MEDIA_IPC_CHANNELS.LOAD, input) as ReturnType<CanvasMediaPreloadApi['canvasMediaLoad']>,
    canvasMediaReadConfig: (input) => invoke(CANVAS_MEDIA_IPC_CHANNELS.READ_CONFIG, input) as ReturnType<NonNullable<CanvasMediaPreloadApi['canvasMediaReadConfig']>>,
    canvasMediaCheckPreparation: (input) => invoke(CANVAS_MEDIA_IPC_CHANNELS.CHECK_PREPARATION, input) as ReturnType<NonNullable<CanvasMediaPreloadApi['canvasMediaCheckPreparation']>>,
    canvasMediaSave: (input) => invoke(CANVAS_MEDIA_IPC_CHANNELS.SAVE, input) as ReturnType<CanvasMediaPreloadApi['canvasMediaSave']>,
    canvasMediaRun: (input) => invoke(CANVAS_MEDIA_IPC_CHANNELS.RUN, input) as ReturnType<CanvasMediaPreloadApi['canvasMediaRun']>,
    canvasMediaCancel: (input) => invoke(CANVAS_MEDIA_IPC_CHANNELS.CANCEL, input) as ReturnType<CanvasMediaPreloadApi['canvasMediaCancel']>,
    canvasMediaAdopt: (input) => invoke(CANVAS_MEDIA_IPC_CHANNELS.ADOPT, input) as ReturnType<CanvasMediaPreloadApi['canvasMediaAdopt']>,
    canvasMediaReadPreview: (input) => invoke(CANVAS_MEDIA_IPC_CHANNELS.READ_PREVIEW, input) as ReturnType<CanvasMediaPreloadApi['canvasMediaReadPreview']>,
    canvasMediaReleasePreview: (input) => invoke(CANVAS_MEDIA_IPC_CHANNELS.RELEASE_PREVIEW, input) as Promise<void>,
    canvasMediaExportOutput: (input) => invoke(CANVAS_MEDIA_IPC_CHANNELS.EXPORT_OUTPUT, input) as ReturnType<CanvasMediaPreloadApi['canvasMediaExportOutput']>,
    onCanvasMediaChanged: (callback) => listen(CANVAS_MEDIA_IPC_CHANNELS.MODULE_CHANGED, (value) => {
      try { callback(parseCanvasMediaModuleChangedEvent(value)) } catch { /* 拒绝不符合四层合同的事件。 */ }
    }),
  }
}
