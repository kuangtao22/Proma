import { describe, expect, test } from 'bun:test'
import { DESIGN_IPC_CHANNELS, createEmptyDesignDocument } from '@proma/shared'
import type { DesignAsset, DesignCanvasDocument, DesignWorkspaceSnapshot } from '@proma/shared'
import type { IpcMainInvokeEvent, WebContents } from 'electron'
import { registerDesignIpcHandlers, type DesignIpcOptions } from './design-ipc'

/** 测试记录型 IPC handler。 */
type TestHandler = (event: IpcMainInvokeEvent, input?: unknown) => unknown

/** 创建最小可观察的 Design IPC 依赖。 */
function createFixture(): {
  handlers: Map<string, TestHandler>
  options: DesignIpcOptions
  senders: Array<WebContents & { sent: Array<{ channel: string; value: unknown }> }>
  guardProjects: string[]
  releases: number[]
  document: DesignCanvasDocument
} {
  /** 已注册 handler 索引。 */
  const handlers = new Map<string, TestHandler>()
  /** 写守卫收到的项目 ID。 */
  const guardProjects: string[] = []
  /** 各窗口媒体授权释放次数。 */
  const releases = [0, 0]
  /** 当前测试画布。 */
  let document = createEmptyDesignDocument('project-1', 10)
  /** 创建可记录广播的授权窗口。 */
  const senders = [1, 2].map((id, index) => ({
    id,
    sent: [] as Array<{ channel: string; value: unknown }>,
    isDestroyed: () => false,
    send(channel: string, value: unknown) {
      this.sent.push({ channel, value })
    },
  })) as Array<WebContents & { sent: Array<{ channel: string; value: unknown }> }>
  /** 素材导入返回值。 */
  const importedAsset: DesignAsset = {
    id: 'asset-1', filename: 'a.png', relativePath: 'assets/a.png',
    thumbnailRelativePath: 'thumbnails/a.webp', mediaType: 'image/png',
    width: 1, height: 1, byteSize: 68, sha256: 'a'.repeat(64), createdAt: 10,
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
      importAuthorizedFiles: async () => [importedAsset],
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
  }
  return { handlers, options, senders, guardProjects, releases, get document() { return document } }
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
})
