import { describe, expect, test } from 'bun:test'
import { DESIGN_IPC_CHANNELS, createEmptyDesignDocument } from '@proma/shared'
import type { DesignAsset, DesignCanvasDocument, DesignWorkspaceSnapshot } from '@proma/shared'
import type { IpcMainInvokeEvent, WebContents } from 'electron'
import type { DesignAssetImportBatch } from './design-asset-service'
import { registerDesignIpcHandlers, type DesignIpcOptions } from './design-ipc'

/** 测试记录型 IPC handler。 */
type TestHandler = (event: IpcMainInvokeEvent, input?: unknown) => unknown

/** 可主动触发 destroyed 的测试窗口。 */
interface TestSender extends WebContents {
  sent: Array<{ channel: string; value: unknown }>
  destroyForTest: () => void
}

/** 创建最小可观察的 Design IPC 依赖。 */
function createFixture(): {
  handlers: Map<string, TestHandler>
  options: DesignIpcOptions
  senders: TestSender[]
  guardProjects: string[]
  releases: number[]
  importCommits: string[]
  importRollbacks: string[]
  document: DesignCanvasDocument
} {
  /** 已注册 handler 索引。 */
  const handlers = new Map<string, TestHandler>()
  /** 写守卫收到的项目 ID。 */
  const guardProjects: string[] = []
  /** 各窗口媒体授权释放次数。 */
  const releases = [0, 0]
  /** 已确认元数据提交的导入批次。 */
  const importCommits: string[] = []
  /** 元数据失败后回滚的导入批次。 */
  const importRollbacks: string[] = []
  /** 当前测试画布。 */
  let document = createEmptyDesignDocument('project-1', 10)
  /** 创建可记录广播的授权窗口。 */
  const senders = [1, 2].map((id) => {
    /** 当前测试窗口登记的 destroyed 回调。 */
    const destroyedListeners = new Set<() => void>()
    /** 当前测试窗口收到的广播。 */
    const sent: Array<{ channel: string; value: unknown }> = []
    return {
      id,
      sent,
      isDestroyed: () => false,
      send(channel: string, value: unknown) {
        sent.push({ channel, value })
      },
      once(event: string, listener: () => void) {
        if (event === 'destroyed') destroyedListeners.add(listener)
        return this
      },
      removeListener(event: string, listener: () => void) {
        if (event === 'destroyed') destroyedListeners.delete(listener)
        return this
      },
      destroyForTest() {
        for (const listener of [...destroyedListeners]) listener()
        destroyedListeners.clear()
      },
    } as unknown as TestSender
  })
  /** 素材导入返回值。 */
  const importedAsset: DesignAsset = {
    id: 'asset-1', filename: 'a.png', relativePath: 'assets/a.png',
    thumbnailRelativePath: 'thumbnails/a.webp', mediaType: 'image/png',
    width: 1, height: 1, byteSize: 68, sha256: 'a'.repeat(64), createdAt: 10,
  }
  /** 创建带精确提交/回滚句柄的素材批次。 */
  const createImportedBatch = (): DesignAssetImportBatch => {
    const batch = [importedAsset] as DesignAssetImportBatch
    batch.commit = () => { importCommits.push(importedAsset.id) }
    batch.rollback = () => { importRollbacks.push(importedAsset.id) }
    return batch
  }
  /** 可注入的完整 IPC 选项。 */
  const options: DesignIpcOptions = {
    ipc: {
      handle: (channel, handler) => handlers.set(channel, handler),
      removeHandler: (channel) => handlers.delete(channel),
    },
    listAuthorizedWebContents: () => senders,
    guard: {
      runWorkspaceWrite: (projectId, effect) => {
        guardProjects.push(projectId)
        return effect()
      },
    },
    store: {
      load: (): DesignWorkspaceSnapshot => ({ document, writable: true }),
      mutate: (_projectId, _revision, mutations) => {
        if (mutations[0]?.type === 'upsert-assets') document = { ...document, revision: document.revision + 1, assets: mutations[0].assets }
        else document = { ...document, revision: document.revision + 1 }
        return document
      },
    },
    assets: {
      importAuthorizedFiles: async () => createImportedBatch(),
      deleteAsset: () => ({ ...document, revision: document.revision + 1 }),
      relinkAsset: async () => ({ ...document, revision: document.revision + 1 }),
      exportAsset: async () => undefined,
      createMediaAccess: () => {
        /** 本次授权归属按创建顺序对应窗口。 */
        const index = releases[0] === 0 ? 0 : 1
        return {
          assetBaseUrl: `proma-file://assets-${index}`,
          thumbnailBaseUrl: `proma-file://thumbs-${index}`,
          release: () => { releases[index] = (releases[index] ?? 0) + 1 },
        }
      },
    },
    pickImageFiles: async () => ['/trusted/a.png'],
    pickRelinkImageFile: async () => '/trusted/relinked.png',
    pickExportPath: async () => '/trusted/export.png',
    getProjectReadOnlyReason: () => undefined,
  }
  return {
    handlers,
    options,
    senders,
    guardProjects,
    releases,
    importCommits,
    importRollbacks,
    get document() { return document },
  }
}

/** 调用必定存在的测试 handler。 */
function invoke(handlers: Map<string, TestHandler>, channel: string, sender: WebContents, input?: unknown): Promise<unknown> {
  const handler = handlers.get(channel)
  if (!handler) throw new Error(`handler 未注册: ${channel}`)
  return Promise.resolve(handler({ sender } as IpcMainInvokeEvent, input))
}

describe('Design IPC', () => {
  test('Given 未授权窗口和恶意 mutation When 调用 Then 在任何业务副作用前拒绝', async () => {
    const fixture = createFixture()
    registerDesignIpcHandlers(fixture.options)
    const unauthorized = { id: 99 } as WebContents

    await expect(invoke(fixture.handlers, DESIGN_IPC_CHANNELS.LOAD, unauthorized, { projectId: 'project-1' }))
      .rejects.toThrow('未授权窗口')
    await expect(invoke(fixture.handlers, DESIGN_IPC_CHANNELS.SAVE_MUTATIONS, fixture.senders[0]!, {
      projectId: 'project-1', expectedRevision: 0, mutations: [{ type: 'upsert-assets', assets: [] }],
    })).rejects.toThrow('不允许通过画布保存修改素材')
    expect(fixture.guardProjects).toEqual([])

    fixture.options.store.load = () => ({
      document: fixture.document,
      writable: false,
      readOnlyReason: '项目离线，只能查看缓存',
    })
    const readOnly = await invoke(
      fixture.handlers,
      DESIGN_IPC_CHANNELS.LOAD,
      fixture.senders[0]!,
      { projectId: 'project-1' },
    ) as DesignWorkspaceSnapshot
    expect(readOnly).toMatchObject({ writable: false, readOnlyReason: '项目离线，只能查看缓存' })
    expect(readOnly.assetBaseUrl).toBeUndefined()
  })

  test('Given 两个授权窗口加载同一项目 When 保存和导入 Then 受守卫保护、素材入库且广播包含发起者', async () => {
    const fixture = createFixture()
    registerDesignIpcHandlers(fixture.options)
    await invoke(fixture.handlers, DESIGN_IPC_CHANNELS.LOAD, fixture.senders[0]!, { projectId: 'project-1' })
    await invoke(fixture.handlers, DESIGN_IPC_CHANNELS.LOAD, fixture.senders[1]!, { projectId: 'project-1' })

    await invoke(fixture.handlers, DESIGN_IPC_CHANNELS.SAVE_MUTATIONS, fixture.senders[0]!, {
      projectId: 'project-1', expectedRevision: 0,
      mutations: [{ type: 'set-viewport', viewport: { x: 10, y: 20, zoom: 1 } }],
    })
    const imported = await invoke(fixture.handlers, DESIGN_IPC_CHANNELS.IMPORT_ASSETS, fixture.senders[0]!, { projectId: 'project-1' }) as DesignWorkspaceSnapshot

    await invoke(fixture.handlers, DESIGN_IPC_CHANNELS.RELINK_ASSET, fixture.senders[0]!, {
      projectId: 'project-1', assetId: 'asset-1', expectedRevision: imported.document.revision,
    })
    await invoke(fixture.handlers, DESIGN_IPC_CHANNELS.DELETE_ASSET, fixture.senders[0]!, {
      projectId: 'project-1', assetId: 'asset-1', expectedRevision: imported.document.revision,
    })

    expect(fixture.guardProjects).toEqual(['project-1', 'project-1', 'project-1', 'project-1'])
    expect(imported.document.assets.map((asset) => asset.id)).toEqual(['asset-1'])
    expect(fixture.importCommits).toEqual(['asset-1'])
    expect(fixture.importRollbacks).toEqual([])
    expect(fixture.senders.every((sender) => sender.sent.length === 4)).toBe(true)
    expect(fixture.senders[0]?.sent[0]?.channel).toBe(DESIGN_IPC_CHANNELS.CHANGED)
  })

  test('Given sender 重复加载和释放 When 切换授权 Then 只释放该 sender 且 relink 不接受路径', async () => {
    const fixture = createFixture()
    registerDesignIpcHandlers(fixture.options)
    await invoke(fixture.handlers, DESIGN_IPC_CHANNELS.LOAD, fixture.senders[0]!, { projectId: 'project-1' })
    await invoke(fixture.handlers, DESIGN_IPC_CHANNELS.LOAD, fixture.senders[0]!, { projectId: 'project-1' })
    expect(fixture.releases[0]).toBe(1)

    await expect(invoke(fixture.handlers, DESIGN_IPC_CHANNELS.RELINK_ASSET, fixture.senders[0]!, {
      projectId: 'project-1', assetId: 'asset-1', expectedRevision: 0, sourcePath: '/renderer/path.png',
    })).rejects.toThrow('请求结构无效')
    await expect(invoke(fixture.handlers, DESIGN_IPC_CHANNELS.RELEASE_MEDIA_ACCESS, fixture.senders[0]!, 'proma-file://assets-0'))
      .rejects.toThrow('请求结构无效')
    await invoke(fixture.handlers, DESIGN_IPC_CHANNELS.RELEASE_MEDIA_ACCESS, fixture.senders[0]!)
    expect(fixture.releases).toEqual([1, 1])
  })

  test('Given 已加载媒体授权 When 导入素材 Then 返回快照保留同一组媒体 URL', async () => {
    const fixture = createFixture()
    registerDesignIpcHandlers(fixture.options)
    const loaded = await invoke(
      fixture.handlers,
      DESIGN_IPC_CHANNELS.LOAD,
      fixture.senders[0]!,
      { projectId: 'project-1' },
    ) as DesignWorkspaceSnapshot

    const imported = await invoke(
      fixture.handlers,
      DESIGN_IPC_CHANNELS.IMPORT_ASSETS,
      fixture.senders[0]!,
      { projectId: 'project-1' },
    ) as DesignWorkspaceSnapshot

    expect(imported.assetBaseUrl).toBe(loaded.assetBaseUrl)
    expect(imported.thumbnailBaseUrl).toBe(loaded.thumbnailBaseUrl)
  })

  test('Given 窗口持有媒体授权 When 窗口销毁或模块释放 Then 撤销授权并移除 handler', async () => {
    const fixture = createFixture()
    const registration = registerDesignIpcHandlers(fixture.options)
    await invoke(fixture.handlers, DESIGN_IPC_CHANNELS.LOAD, fixture.senders[0]!, { projectId: 'project-1' })
    fixture.senders[0]!.destroyForTest()
    expect(fixture.releases[0]).toBe(1)

    await invoke(fixture.handlers, DESIGN_IPC_CHANNELS.LOAD, fixture.senders[1]!, { projectId: 'project-1' })
    registration.dispose()
    expect(fixture.releases[1]).toBe(1)
    expect(fixture.handlers.size).toBe(0)
  })

  test('Given Renderer 伪造任务节点 When 保存 Then 在写守卫前拒绝', async () => {
    const fixture = createFixture()
    registerDesignIpcHandlers(fixture.options)

    await expect(invoke(fixture.handlers, DESIGN_IPC_CHANNELS.SAVE_MUTATIONS, fixture.senders[0]!, {
      projectId: 'project-1',
      expectedRevision: 0,
      mutations: [{
        type: 'upsert-nodes',
        nodes: [{
          id: 'job-node-1',
          kind: 'job',
          jobId: 'forged-job-1',
          position: { x: 0, y: 0 },
          width: 320,
          height: 240,
          zIndex: 1,
        }],
      }],
    })).rejects.toThrow('不允许通过画布保存创建任务节点')
    expect(fixture.guardProjects).toEqual([])
  })

  test('Given 项目离线或迁移中 When 加载 Then 返回空只读快照且不触碰项目目录', async () => {
    const fixture = createFixture()
    /** 记录生产 store 是否被错误调用。 */
    let storeLoaded = false
    fixture.options.getProjectReadOnlyReason = () => '项目路径不可访问，设计工作区已切换为只读'
    fixture.options.store.load = () => {
      storeLoaded = true
      throw new Error('离线项目不应读取或创建目录')
    }
    registerDesignIpcHandlers(fixture.options)

    const snapshot = await invoke(
      fixture.handlers,
      DESIGN_IPC_CHANNELS.LOAD,
      fixture.senders[0]!,
      { projectId: 'project-1' },
    ) as DesignWorkspaceSnapshot

    expect(snapshot.writable).toBe(false)
    expect(snapshot.readOnlyReason).toBe('项目路径不可访问，设计工作区已切换为只读')
    expect(snapshot.document.projectId).toBe('project-1')
    expect(storeLoaded).toBe(false)
  })

  test('Given 在线期间已保存新 revision When 项目随后离线 Then 只读快照保留最新内存版本', async () => {
    const fixture = createFixture()
    registerDesignIpcHandlers(fixture.options)
    await invoke(fixture.handlers, DESIGN_IPC_CHANNELS.LOAD, fixture.senders[0]!, { projectId: 'project-1' })
    await invoke(fixture.handlers, DESIGN_IPC_CHANNELS.SAVE_MUTATIONS, fixture.senders[0]!, {
      projectId: 'project-1',
      expectedRevision: 0,
      mutations: [{ type: 'set-viewport', viewport: { x: 12, y: 24, zoom: 1.25 } }],
    })
    fixture.options.getProjectReadOnlyReason = () => '项目路径不可访问，设计工作区已切换为只读'

    const snapshot = await invoke(
      fixture.handlers,
      DESIGN_IPC_CHANNELS.LOAD,
      fixture.senders[0]!,
      { projectId: 'project-1' },
    ) as DesignWorkspaceSnapshot

    expect(snapshot.document.revision).toBe(1)
  })

  test('Given 素材已 promotion 但元数据提交失败 When 导入结束 Then 精确回滚本批次', async () => {
    const fixture = createFixture()
    fixture.options.store.mutate = () => {
      throw new Error('metadata commit failed')
    }
    registerDesignIpcHandlers(fixture.options)

    await expect(invoke(
      fixture.handlers,
      DESIGN_IPC_CHANNELS.IMPORT_ASSETS,
      fixture.senders[0]!,
      { projectId: 'project-1' },
    )).rejects.toThrow('metadata commit failed')
    expect(fixture.importCommits).toEqual([])
    expect(fixture.importRollbacks).toEqual(['asset-1'])
  })
})
