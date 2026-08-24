import { describe, expect, test } from 'bun:test'
import { DESIGN_IPC_CHANNELS } from '@proma/shared'
import type { IpcRendererEvent } from 'electron'
import { createDesignPreloadApi, type DesignPreloadIpc } from './design-preload'

/** 创建记录型 renderer IPC。 */
function createRecordingIpc() {
  /** 全部 invoke 调用。 */
  const invokes: Array<{ channel: string; args: unknown[] }> = []
  /** 注册的事件 handler。 */
  const added: Array<{ channel: string; listener: (event: IpcRendererEvent, value: unknown) => void }> = []
  /** 移除的事件 handler。 */
  const removed: typeof added = []
  /** preload 所需最小 IPC。 */
  const ipc: DesignPreloadIpc = {
    invoke: async (channel, ...args) => { invokes.push({ channel, args }); return channel },
    on: (channel, listener) => added.push({ channel, listener }),
    removeListener: (channel, listener) => removed.push({ channel, listener }),
  }
  return { ipc, invokes, added, removed }
}

describe('Design preload', () => {
  test('Given 固定 API When 逐一调用 Then 只透传对应 Design 通道和结构化参数', async () => {
    const recorded = createRecordingIpc()
    const api = createDesignPreloadApi(recorded.ipc)
    const calls: Array<[() => Promise<unknown>, string, unknown[]]> = [
      [() => api.listImageModelProfiles(), DESIGN_IPC_CHANNELS.LIST_IMAGE_MODEL_PROFILES, []],
      [() => api.saveImageModelProfiles({ profiles: [] }), DESIGN_IPC_CHANNELS.SAVE_IMAGE_MODEL_PROFILES, [{ profiles: [] }]],
      [() => api.getImageModelSelection('p1'), DESIGN_IPC_CHANNELS.GET_IMAGE_MODEL_SELECTION, [{ projectId: 'p1' }]],
      [() => api.setImageModelSelection({ projectId: 'p1', imageModelProfileId: 'profile-flash' }), DESIGN_IPC_CHANNELS.SET_IMAGE_MODEL_SELECTION, [{ projectId: 'p1', imageModelProfileId: 'profile-flash' }]],
      [() => api.loadDesignWorkspace('p1'), DESIGN_IPC_CHANNELS.LOAD, [{ projectId: 'p1' }]],
      [() => api.saveDesignMutations({ projectId: 'p1', expectedRevision: 0, mutations: [] }), DESIGN_IPC_CHANNELS.SAVE_MUTATIONS, [{ projectId: 'p1', expectedRevision: 0, mutations: [] }]],
      [() => api.importDesignAssets({ projectId: 'p1', expectedRevision: 3, viewportCenter: { x: 10, y: 20 } }), DESIGN_IPC_CHANNELS.IMPORT_ASSETS, [{ projectId: 'p1', expectedRevision: 3, viewportCenter: { x: 10, y: 20 } }]],
      [() => api.deleteDesignAsset({ projectId: 'p1', assetId: 'a1', expectedRevision: 0 }), DESIGN_IPC_CHANNELS.DELETE_ASSET, [{ projectId: 'p1', assetId: 'a1', expectedRevision: 0 }]],
      [() => api.relinkDesignAsset({ projectId: 'p1', assetId: 'a1', expectedRevision: 0 }), DESIGN_IPC_CHANNELS.RELINK_ASSET, [{ projectId: 'p1', assetId: 'a1', expectedRevision: 0 }]],
      [() => api.exportDesignAsset({ projectId: 'p1', assetId: 'a1' }), DESIGN_IPC_CHANNELS.EXPORT_ASSET, [{ projectId: 'p1', assetId: 'a1' }]],
      [() => api.createDesignJob({ projectId: 'p1', action: 'generate', prompt: 'x', imageModelProfileId: 'profile-flash', position: { x: 0, y: 0 } }), DESIGN_IPC_CHANNELS.CREATE_JOB, [{ projectId: 'p1', action: 'generate', prompt: 'x', imageModelProfileId: 'profile-flash', position: { x: 0, y: 0 } }]],
      [() => api.cancelDesignJob({ projectId: 'p1', jobId: 'j1' }), DESIGN_IPC_CHANNELS.CANCEL_JOB, [{ projectId: 'p1', jobId: 'j1' }]],
      [() => api.retryDesignJob({ projectId: 'p1', jobId: 'j1' }), DESIGN_IPC_CHANNELS.RETRY_JOB, [{ projectId: 'p1', jobId: 'j1' }]],
      [() => api.deleteDesignJob({ projectId: 'p1', jobId: 'j1' }), DESIGN_IPC_CHANNELS.DELETE_JOB, [{ projectId: 'p1', jobId: 'j1' }]],
      [() => api.listDesignJobs('p1'), DESIGN_IPC_CHANNELS.LIST_JOBS, [{ projectId: 'p1' }]],
      [() => api.getDesignTaskDetails({ projectId: 'p1', jobId: 'j1' }), DESIGN_IPC_CHANNELS.GET_TASK_DETAILS, [{ projectId: 'p1', jobId: 'j1' }]],
      [() => api.getDesignTaskTrace({ projectId: 'p1', jobId: 'j1' }), DESIGN_IPC_CHANNELS.GET_TASK_TRACE, [{ projectId: 'p1', jobId: 'j1' }]],
      [() => api.prepareDesignAssetForSession({ projectId: 'p1', assetId: 'a1', sessionId: 's1' }), DESIGN_IPC_CHANNELS.PREPARE_ASSET_FOR_SESSION, [{ projectId: 'p1', assetId: 'a1', sessionId: 's1' }]],
      [() => api.importAgentImageToDesign({ projectId: 'p1', sessionId: 's1', localPath: '/x.png', position: { x: 0, y: 0 } }), DESIGN_IPC_CHANNELS.IMPORT_AGENT_IMAGE, [{ projectId: 'p1', sessionId: 's1', localPath: '/x.png', position: { x: 0, y: 0 } }]],
      [() => api.releaseDesignMediaAccess(), DESIGN_IPC_CHANNELS.RELEASE_MEDIA_ACCESS, []],
    ]
    for (const [call] of calls) await call()
    expect(recorded.invokes).toEqual(calls.map(([, channel, args]) => ({ channel, args })))
  })

  test('Given change 订阅 When 推送并取消 Then 使用同一个 listener 引用', () => {
    const recorded = createRecordingIpc()
    const api = createDesignPreloadApi(recorded.ipc)
    const received: unknown[] = []
    const release = api.onDesignChanged((change) => received.push(change))
    const change = { projectId: 'p1', revision: 2, cause: 'canvas' as const }
    recorded.added[0]?.listener({} as IpcRendererEvent, change)
    release()
    expect(received).toEqual([change])
    expect(recorded.removed[0]?.listener).toBe(recorded.added[0]?.listener)
  })

  test('Given 两类模型变化订阅 When 推送并取消 Then 隐藏 Electron event 且同引用解绑', () => {
    const recorded = createRecordingIpc()
    const api = createDesignPreloadApi(recorded.ipc)
    /** 收集 profile 无 payload 通知次数。 */
    let profileChanges = 0
    /** 收集项目选择业务事件。 */
    const selectionChanges: unknown[] = []
    const releaseProfiles = api.onImageModelProfilesChanged(() => { profileChanges += 1 })
    const releaseSelection = api.onImageModelSelectionChanged((event) => selectionChanges.push(event))
    recorded.added[0]?.listener({} as IpcRendererEvent, undefined)
    recorded.added[1]?.listener({} as IpcRendererEvent, { projectId: 'p1' })
    releaseProfiles()
    releaseSelection()

    expect(profileChanges).toBe(1)
    expect(selectionChanges).toEqual([{ projectId: 'p1' }])
    expect(recorded.removed[0]?.listener).toBe(recorded.added[0]?.listener)
    expect(recorded.removed[1]?.listener).toBe(recorded.added[1]?.listener)
  })
})
