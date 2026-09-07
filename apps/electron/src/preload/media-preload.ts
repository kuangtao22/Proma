import { MEDIA_IPC_CHANNELS } from '@proma/shared'
import type { MediaPreloadApi } from '@proma/shared'

/** Renderer 只能通过结构化 IPC 访问媒体配置和运行投影。 */
export function createMediaPreloadApi(invoke: (channel: string, input?: unknown) => Promise<unknown>, listen: (channel: string, callback: (value: unknown) => void) => () => void): MediaPreloadApi {
  return {
    mediaGetSettings: () => invoke(MEDIA_IPC_CHANNELS.GET_SETTINGS) as ReturnType<MediaPreloadApi['mediaGetSettings']>,
    mediaSaveConnection: (input, expectedRevision) => invoke(MEDIA_IPC_CHANNELS.SAVE_CONNECTION, { input, expectedRevision }) as ReturnType<MediaPreloadApi['mediaSaveConnection']>,
    mediaSaveWorkflow: (input, expectedRevision) => invoke(MEDIA_IPC_CHANNELS.SAVE_WORKFLOW, { input, expectedRevision }) as ReturnType<MediaPreloadApi['mediaSaveWorkflow']>,
    mediaSaveProfile: (input, expectedRevision) => invoke(MEDIA_IPC_CHANNELS.SAVE_PROFILE, { input, expectedRevision }) as ReturnType<MediaPreloadApi['mediaSaveProfile']>,
    mediaProbeConnection: (connectionId, projectId) => invoke(MEDIA_IPC_CHANNELS.PROBE_CONNECTION, { connectionId, projectId }) as ReturnType<MediaPreloadApi['mediaProbeConnection']>,
    mediaListResources: (input) => invoke(MEDIA_IPC_CHANNELS.LIST_RESOURCES, input) as ReturnType<MediaPreloadApi['mediaListResources']>,
    mediaArchiveConfiguration: (input, expectedRevision) => invoke(MEDIA_IPC_CHANNELS.ARCHIVE_CONFIGURATION, { input, expectedRevision }) as ReturnType<MediaPreloadApi['mediaArchiveConfiguration']>,
    mediaReadRemoteWorkflow: (descriptor) => invoke(MEDIA_IPC_CHANNELS.READ_REMOTE_WORKFLOW, descriptor) as ReturnType<MediaPreloadApi['mediaReadRemoteWorkflow']>,
    mediaReadRemoteAsset: (descriptor) => invoke(MEDIA_IPC_CHANNELS.READ_REMOTE_ASSET, descriptor) as ReturnType<MediaPreloadApi['mediaReadRemoteAsset']>,
    mediaImportLocalAsset: (projectId, mediaKind) => invoke(MEDIA_IPC_CHANNELS.IMPORT_LOCAL_ASSET, { projectId, mediaKind }) as ReturnType<MediaPreloadApi['mediaImportLocalAsset']>,
    mediaListAssets: (projectId) => invoke(MEDIA_IPC_CHANNELS.LIST_ASSETS, { projectId }) as ReturnType<MediaPreloadApi['mediaListAssets']>,
    mediaGetRun: (projectId, runId) => invoke(MEDIA_IPC_CHANNELS.GET_RUN, { projectId, runId }) as ReturnType<MediaPreloadApi['mediaGetRun']>,
    mediaGetJobRun: (projectId, jobId) => invoke(MEDIA_IPC_CHANNELS.GET_JOB_RUN, { projectId, jobId }) as ReturnType<MediaPreloadApi['mediaGetJobRun']>,
    mediaWatchProject: (projectId) => invoke(MEDIA_IPC_CHANNELS.WATCH_PROJECT, { projectId }) as Promise<void>,
    mediaUnwatchProject: (projectId) => invoke(MEDIA_IPC_CHANNELS.UNWATCH_PROJECT, { projectId }) as Promise<void>,
    onMediaRunChanged: (callback) => listen(MEDIA_IPC_CHANNELS.RUN_CHANGED, (value) => callback(value as Parameters<typeof callback>[0])),
  }
}
