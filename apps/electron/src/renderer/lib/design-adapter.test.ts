import { describe, expect, test } from 'bun:test'
import { createEmptyDesignDocument } from '@proma/shared'
import type { SaveDesignMutationsInput } from '@proma/shared'
import { createDesignAdapter, type PartialDesignApi } from './design-adapter'

describe('Design renderer adapter', () => {
  test('Given preload 拒绝加载 When adapter 调用 Then 保留稳定错误供 UI 展示', async () => {
    const adapter = createDesignAdapter({
      loadDesignWorkspace: async () => { throw new Error('项目离线，只能查看缓存') },
    } as PartialDesignApi)
    await expect(adapter.load('project-1')).rejects.toThrow('项目离线，只能查看缓存')
  })

  test('Given 注入完整 preload API When 调用 Then adapter 不改写参数与返回值', async () => {
    const document = createEmptyDesignDocument('project-1', 10)
    const snapshot = { document, writable: true }
    /** preload 实际收到的保存参数。 */
    let receivedInput: SaveDesignMutationsInput | undefined
    /** 模型 API 收到的原始参数，验证 adapter 不做业务改写。 */
    const modelInputs: unknown[] = []
    /** 公开模型目录返回对象。 */
    const catalog = { profiles: [], channelOptions: [], inheritedFromLegacyConfig: false, credentialsConfigured: true }
    /** 项目模型选择返回对象。 */
    const selection = { projectId: 'project-1', options: [], selectedProfileId: 'profile-flash' }
    /** 任务详情和展开后的 trace 返回对象。 */
    const taskDetails = { creativeTaskId: 'creative-1', currentJobId: 'job-1', attempts: [], traceState: 'ready' as const }
    const taskTrace = { ...taskDetails, trace: [] }
    /** 两类订阅释放函数必须原样返回。 */
    const releaseProfiles = (): void => undefined
    const releaseSelection = (): void => undefined
    const api: PartialDesignApi = {
      listImageModelProfiles: async () => catalog,
      saveImageModelProfiles: async (input) => { modelInputs.push(input); return catalog },
      getImageModelSelection: async (projectId) => { modelInputs.push(projectId); return selection },
      setImageModelSelection: async (input) => { modelInputs.push(input); return selection },
      onImageModelProfilesChanged: () => releaseProfiles,
      onImageModelSelectionChanged: () => releaseSelection,
      loadDesignWorkspace: async () => snapshot,
      saveDesignMutations: async (input) => { receivedInput = input; return document },
      releaseDesignMediaAccess: async () => undefined,
      onDesignChanged: () => () => undefined,
      getDesignTaskDetails: async () => taskDetails,
      getDesignTaskTrace: async () => taskTrace,
    }
    const adapter = createDesignAdapter(api)
    expect(await adapter.load('project-1')).toBe(snapshot)
    const input = { projectId: 'project-1', expectedRevision: 1, mutations: [] }
    expect(await adapter.save(input)).toBe(document)
    expect(receivedInput).toBe(input)
    /** 保存输入与选择输入使用同一对象引用透传。 */
    const saveProfilesInput = { profiles: [] }
    const setSelectionInput = { projectId: 'project-1', imageModelProfileId: 'profile-flash' }
    expect(await adapter.listImageModelProfiles()).toBe(catalog)
    expect(await adapter.saveImageModelProfiles(saveProfilesInput)).toBe(catalog)
    expect(await adapter.getImageModelSelection('project-1')).toBe(selection)
    expect(await adapter.setImageModelSelection(setSelectionInput)).toBe(selection)
    const taskInput = { projectId: 'project-1', jobId: 'job-1' }
    expect(await adapter.getTaskDetails(taskInput)).toBe(taskDetails)
    expect(await adapter.getTaskTrace(taskInput)).toBe(taskTrace)
    expect(modelInputs).toEqual([saveProfilesInput, 'project-1', setSelectionInput])
    expect(adapter.onImageModelProfilesChanged(() => undefined)).toBe(releaseProfiles)
    expect(adapter.onImageModelSelectionChanged(() => undefined)).toBe(releaseSelection)
    await expect(adapter.releaseMediaAccess()).resolves.toBeUndefined()
  })
})
