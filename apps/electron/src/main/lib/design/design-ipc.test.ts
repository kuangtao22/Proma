import { describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { DESIGN_IPC_CHANNELS, createEmptyDesignDocument } from '@proma/shared'
import type {
  DesignAsset,
  DesignCanvasDocument,
  DesignJobRecord,
  DesignMutation,
  DesignWorkspaceSnapshot,
} from '@proma/shared'
import type { IpcMainInvokeEvent, WebContents } from 'electron'
import sharp from 'sharp'
import { DesignAssetService } from './design-asset-service'
import type { DesignAssetImportBatch } from './design-asset-service'
import { registerDesignIpcHandlers, type DesignIpcOptions } from './design-ipc'
import type { DesignJobChangedEvent } from './design-job-manager'
import { createDesignPathResolver } from './design-paths'
import { applyDesignMutations, createDesignStore } from './design-store'
import type { DesignStore } from './design-store'

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
  mutationBatches: DesignMutation[][]
  document: DesignCanvasDocument
  getStoreReadCount: () => number
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
  /** store 收到的 mutation 批次，用于验证事务边界。 */
  const mutationBatches: DesignMutation[][] = []
  /** 当前测试画布。 */
  let document = createEmptyDesignDocument('project-1', 10)
  /** 模拟 store 每次公开加载或 mutation 内部加载权威文档的次数。 */
  let storeReadCount = 0
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
      load: (): DesignWorkspaceSnapshot => {
        storeReadCount += 1
        return { document, writable: true }
      },
      requireStableAuthoritativeDocument: () => {
        storeReadCount += 1
        return document
      },
      mutate: (_projectId, _revision, mutations, validateCurrent) => {
        storeReadCount += 1
        validateCurrent?.(document)
        mutationBatches.push(mutations)
        document = {
          ...applyDesignMutations(document, mutations),
          revision: document.revision + 1,
        }
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
    jobs: {
      create: () => createJobRecord('job-default'),
      run: async () => undefined,
      cancel: async () => createJobRecord('job-default'),
      retry: () => createJobRecord('job-retry'),
      list: () => [],
      reconcilePendingTerminals: () => [],
      onChanged: () => () => undefined,
    },
    sessionBridge: {
      prepareAssetForSession: () => {
        throw new Error('测试未配置 Design 会话素材准备')
      },
      importAgentImage: async () => {
        throw new Error('测试未配置 Agent 图片导入')
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
    mutationBatches,
    get document() { return document },
    getStoreReadCount: () => storeReadCount,
  }
}

/** 调用必定存在的测试 handler。 */
function invoke(handlers: Map<string, TestHandler>, channel: string, sender: WebContents, input?: unknown): Promise<unknown> {
  const handler = handlers.get(channel)
  if (!handler) throw new Error(`handler 未注册: ${channel}`)
  return Promise.resolve(handler({ sender } as IpcMainInvokeEvent, input))
}

describe('Design IPC', () => {
  test('Given 授权窗口 When 创建、取消、重试和列出任务 Then 写操作受 guard 保护且运行不阻塞 invoke', async () => {
    const fixture = createFixture()
    const job = createJobRecord('job-1')
    const retried = createJobRecord('job-2')
    /** 记录 handler 对 Manager 的调用顺序。 */
    const calls: string[] = []
    /** 捕获 manager 状态变化监听器以验证 job 广播。 */
    let onChanged: ((event: DesignJobChangedEvent) => void) | undefined
    Object.assign(fixture.options, {
      jobs: {
        create: () => { calls.push('create'); return job },
        run: async (jobId: string) => { calls.push(`run:${jobId}`) },
        cancel: async (_projectId: string, jobId: string) => { calls.push(`cancel:${jobId}`); return job },
        retry: (_projectId: string, jobId: string) => { calls.push(`retry:${jobId}`); return retried },
        list: () => { calls.push('list'); return [job, retried] },
        onChanged: (listener: (event: DesignJobChangedEvent) => void) => {
          onChanged = listener
          return () => undefined
        },
      },
    })
    registerDesignIpcHandlers(fixture.options)

    const created = await invoke(
      fixture.handlers,
      DESIGN_IPC_CHANNELS.CREATE_JOB,
      fixture.senders[0]!,
      { projectId: 'project-1', action: 'generate', prompt: '生成', position: { x: 1, y: 2 } },
    )
    const cancelled = await invoke(
      fixture.handlers,
      DESIGN_IPC_CHANNELS.CANCEL_JOB,
      fixture.senders[0]!,
      { projectId: 'project-1', jobId: 'job-1' },
    )
    const retryResult = await invoke(
      fixture.handlers,
      DESIGN_IPC_CHANNELS.RETRY_JOB,
      fixture.senders[0]!,
      { projectId: 'project-1', jobId: 'job-1' },
    )
    const listed = await invoke(
      fixture.handlers,
      DESIGN_IPC_CHANNELS.LIST_JOBS,
      fixture.senders[0]!,
      { projectId: 'project-1' },
    )
    await Promise.resolve()
    onChanged?.({ job: retried, revision: 42 })

    expect(created).toBe(job)
    expect(cancelled).toBe(job)
    expect(retryResult).toBe(retried)
    expect(listed).toEqual([job, retried])
    expect(fixture.guardProjects).toEqual(['project-1', 'project-1', 'project-1'])
    expect(calls).toEqual([
      'create', 'run:job-1', 'cancel:job-1', 'retry:job-1', 'run:job-2', 'list',
    ])
    expect(fixture.senders[0]?.sent.at(-1)?.value).toMatchObject({
      projectId: 'project-1', cause: 'job', revision: 42,
    })
  })

  test('Given Design 与会话双向传递 When 调用 IPC Then prepare 只读且 import 受写守卫并广播素材 revision', async () => {
    const fixture = createFixture()
    /** 记录桥方法调用，确认 IPC 不绕过主进程归属服务。 */
    const bridgeCalls: string[] = []
    Object.assign(fixture.options, {
      sessionBridge: {
        prepareAssetForSession: (input: { sessionId: string }) => {
          bridgeCalls.push(`prepare:${input.sessionId}`)
          return {
            sessionId: input.sessionId,
            path: '/project/.proma/design/assets/a.png',
            name: 'a.png',
            isDirectory: false as const,
            scope: 'project' as const,
          }
        },
        importAgentImage: async (input: { sessionId: string }) => {
          bridgeCalls.push(`import:${input.sessionId}`)
          /** 模拟 bridge 已提交的新权威 revision。 */
          const importedDocument = { ...fixture.document, revision: 7 }
          return { document: importedDocument, writable: true }
        },
      },
    })
    registerDesignIpcHandlers(fixture.options)

    const prepared = await invoke(
      fixture.handlers,
      DESIGN_IPC_CHANNELS.PREPARE_ASSET_FOR_SESSION,
      fixture.senders[0]!,
      { projectId: 'project-1', assetId: 'asset-1', sessionId: 'session-1' },
    )
    const imported = await invoke(
      fixture.handlers,
      DESIGN_IPC_CHANNELS.IMPORT_AGENT_IMAGE,
      fixture.senders[0]!,
      {
        projectId: 'project-1', sessionId: 'session-1', localPath: 'session-1/a.png',
        position: { x: 10, y: 20 },
      },
    ) as DesignWorkspaceSnapshot

    expect(prepared).toMatchObject({ sessionId: 'session-1', scope: 'project' })
    expect(imported.document.revision).toBe(7)
    expect(bridgeCalls).toEqual(['prepare:session-1', 'import:session-1'])
    expect(fixture.guardProjects).toEqual(['project-1'])
    expect(fixture.senders[0]?.sent.at(-1)?.value).toEqual({
      projectId: 'project-1', revision: 7, cause: 'asset',
    })
  })

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
    const imported = await invoke(fixture.handlers, DESIGN_IPC_CHANNELS.IMPORT_ASSETS, fixture.senders[0]!, {
      projectId: 'project-1', expectedRevision: 1, viewportCenter: { x: 100, y: 200 },
    }) as DesignWorkspaceSnapshot

    await invoke(fixture.handlers, DESIGN_IPC_CHANNELS.RELINK_ASSET, fixture.senders[0]!, {
      projectId: 'project-1', assetId: 'asset-1', expectedRevision: imported.document.revision,
    })
    await invoke(fixture.handlers, DESIGN_IPC_CHANNELS.DELETE_ASSET, fixture.senders[0]!, {
      projectId: 'project-1', assetId: 'asset-1', expectedRevision: imported.document.revision,
    })

    expect(fixture.guardProjects).toEqual(['project-1', 'project-1', 'project-1', 'project-1'])
    expect(imported.document.assets.map((asset) => asset.id)).toEqual(['asset-1'])
    expect(imported.document.nodes).toMatchObject([{
      kind: 'asset', assetId: 'asset-1', position: { x: 100, y: 200 }, width: 320, height: 240,
    }])
    expect(fixture.mutationBatches[1]?.map((mutation) => mutation.type)).toEqual([
      'upsert-assets',
      'upsert-nodes',
    ])
    expect(fixture.importCommits).toEqual(['asset-1'])
    expect(fixture.importRollbacks).toEqual([])
    expect(fixture.senders.every((sender) => sender.sent.length === 4)).toBe(true)
    expect(fixture.senders[0]?.sent[0]?.channel).toBe(DESIGN_IPC_CHANNELS.CHANGED)
  })

  test('Given 单次 Renderer 保存 When store 执行策略和 mutation Then 只读取一次权威文档', async () => {
    const fixture = createFixture()
    registerDesignIpcHandlers(fixture.options)

    await invoke(fixture.handlers, DESIGN_IPC_CHANNELS.SAVE_MUTATIONS, fixture.senders[0]!, {
      projectId: 'project-1',
      expectedRevision: 0,
      mutations: [{ type: 'set-viewport', viewport: { x: 1, y: 2, zoom: 1 } }],
    })

    expect(fixture.getStoreReadCount()).toBe(1)
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
      { projectId: 'project-1', expectedRevision: 0, viewportCenter: { x: 10, y: 20 } },
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

  test('Given 权威文档已有 job When Renderer 删除覆盖或改写分组 Then 写守卫内拒绝且 store 无副作用', async () => {
    const fixture = createFixture()
    /** 权威 job 节点及分组只能由任务生命周期维护。 */
    const authoritative = createEmptyDesignDocument('project-1', 10)
    authoritative.nodes = [{
      id: 'job-node-1',
      kind: 'job',
      jobId: 'job-1',
      groupId: 'job-group',
      position: { x: 0, y: 0 },
      width: 320,
      height: 240,
      zIndex: 1,
    }]
    authoritative.groups = [{ id: 'job-group', name: '任务组', nodeIds: ['job-node-1'] }]
    /** 每次攻击只能进入一次 store 权威读取。 */
    let authoritativeReadCount = 0
    /** mutate 调用次数用于证明拒绝发生在任何存储写副作用前。 */
    let mutateCount = 0
    fixture.options.store.load = () => {
      throw new Error('SAVE 不应在 IPC 预读权威文档')
    }
    fixture.options.store.mutate = (_projectId, _revision, _mutations, validateCurrent) => {
      authoritativeReadCount += 1
      validateCurrent?.(authoritative)
      mutateCount += 1
      return authoritative
    }
    registerDesignIpcHandlers(fixture.options)
    /** 每一项都通过形状校验，但违反当前权威 job 所有权。 */
    const attacks = [
      [{ type: 'remove-nodes', nodeIds: ['job-node-1'] }],
      [{ type: 'patch-nodes', removeIds: ['job-node-1'], upserts: [] }],
      [{
        type: 'patch-nodes',
        removeIds: [],
        upserts: [{
          entity: {
            id: 'job-node-1', kind: 'asset', assetId: 'asset-1',
            position: { x: 1, y: 1 }, width: 320, height: 240, zIndex: 1,
          },
          index: 0,
        }],
      }],
      [{
        type: 'upsert-nodes',
        nodes: [{
          id: 'job-node-1', kind: 'asset', assetId: 'asset-1',
          position: { x: 1, y: 1 }, width: 320, height: 240, zIndex: 1,
        }],
      }],
      [{
        type: 'patch-groups',
        removeIds: ['job-group'],
        upserts: [],
      }],
      [{
        type: 'patch-groups',
        removeIds: [],
        upserts: [{ entity: { id: 'job-group', name: '覆盖组', nodeIds: [] }, index: 0 }],
      }],
      [{
        type: 'upsert-groups',
        groups: [{ id: 'other-group', name: '越权组', nodeIds: ['job-node-1'] }],
      }],
    ]

    for (const mutations of attacks) {
      await expect(invoke(fixture.handlers, DESIGN_IPC_CHANNELS.SAVE_MUTATIONS, fixture.senders[0]!, {
        projectId: 'project-1',
        expectedRevision: 0,
        mutations,
      })).rejects.toThrow('任务节点')
    }
    expect(fixture.guardProjects).toEqual(Array.from({ length: attacks.length }, () => 'project-1'))
    expect(authoritativeReadCount).toBe(attacks.length)
    expect(mutateCount).toBe(0)
    expect(authoritative.revision).toBe(0)
    expect(fixture.senders.every((sender) => sender.sent.length === 0)).toBe(true)
  })

  test('Given store mutation 单次读取发生恢复 When 保存 Then 要求 Renderer reload 且不进入写入', async () => {
    const fixture = createFixture()
    /** IPC 不得预读并消费恢复标志，恢复错误必须来自 store mutation 临界路径。 */
    let mutationAttemptCount = 0
    fixture.options.store.load = () => {
      throw new Error('SAVE 不应在 IPC 预读权威文档')
    }
    fixture.options.store.mutate = () => {
      mutationAttemptCount += 1
      throw new Error('DESIGN_RECOVERY_REQUIRED: recoveredFrom=backup')
    }
    registerDesignIpcHandlers(fixture.options)

    await expect(invoke(fixture.handlers, DESIGN_IPC_CHANNELS.SAVE_MUTATIONS, fixture.senders[0]!, {
      projectId: 'project-1',
      expectedRevision: 0,
      mutations: [{ type: 'set-viewport', viewport: { x: 1, y: 1, zoom: 1 } }],
    })).rejects.toThrow('DESIGN_RECOVERY_REQUIRED')
    expect(fixture.guardProjects).toEqual(['project-1'])
    expect(mutationAttemptCount).toBe(1)
    expect(fixture.senders.every((sender) => sender.sent.length === 0)).toBe(true)
  })

  test('Given 局部有序 patch When IPC 校验 Then 接受合法索引并拒绝负索引和任务节点', async () => {
    const fixture = createFixture()
    registerDesignIpcHandlers(fixture.options)
    /** 合法素材节点 patch 应进入写守卫。 */
    await invoke(fixture.handlers, DESIGN_IPC_CHANNELS.SAVE_MUTATIONS, fixture.senders[0]!, {
      projectId: 'project-1',
      expectedRevision: 0,
      mutations: [{
        type: 'patch-nodes',
        removeIds: [],
        upserts: [{
          entity: {
            id: 'asset-node-1',
            kind: 'asset',
            assetId: 'asset-1',
            position: { x: 0, y: 0 },
            width: 320,
            height: 240,
            zIndex: 1,
          },
          index: 0,
        }],
      }],
    })
    expect(fixture.guardProjects).toEqual(['project-1'])

    /** 负索引必须在写守卫前被结构校验拒绝。 */
    await expect(invoke(fixture.handlers, DESIGN_IPC_CHANNELS.SAVE_MUTATIONS, fixture.senders[0]!, {
      projectId: 'project-1',
      expectedRevision: 1,
      mutations: [{
        type: 'patch-annotations',
        removeIds: [],
        upserts: [{
          entity: {
            id: 'annotation-1',
            kind: 'arrow',
            from: { x: 0, y: 0 },
            to: { x: 10, y: 10 },
            color: '#000000',
            width: 12,
            createdAt: 10,
          },
          index: -1,
        }],
      }],
    })).rejects.toThrow('Design 请求结构无效')

    /** patch 同样不能绕过任务节点所有权边界。 */
    await expect(invoke(fixture.handlers, DESIGN_IPC_CHANNELS.SAVE_MUTATIONS, fixture.senders[0]!, {
      projectId: 'project-1',
      expectedRevision: 1,
      mutations: [{
        type: 'patch-nodes',
        removeIds: [],
        upserts: [{
          entity: {
            id: 'job-node-1',
            kind: 'job',
            jobId: 'forged-job-1',
            position: { x: 0, y: 0 },
            width: 320,
            height: 240,
            zIndex: 1,
          },
          index: 0,
        }],
      }],
    })).rejects.toThrow('不允许通过画布保存创建任务节点')
    expect(fixture.guardProjects).toEqual(['project-1'])
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

  test('Given terminal pending 首次恢复未完成 When Renderer 显式加载权威画布 Then 同进程触发任务二次对账', async () => {
    const fixture = createFixture()
    const reconciledProjects: string[] = []
    fixture.options.jobs.reconcilePendingTerminals = (projectId) => {
      reconciledProjects.push(projectId)
      return []
    }
    registerDesignIpcHandlers(fixture.options)

    await invoke(
      fixture.handlers,
      DESIGN_IPC_CHANNELS.LOAD,
      fixture.senders[0]!,
      { projectId: 'project-1' },
    )

    expect(reconciledProjects).toEqual(['project-1'])
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
      { projectId: 'project-1', expectedRevision: 0, viewportCenter: { x: 10, y: 20 } },
    )).rejects.toThrow('metadata commit failed')
    expect(fixture.importCommits).toEqual([])
    expect(fixture.importRollbacks).toEqual(['asset-1'])
    expect(fixture.document.assets).toEqual([])
    expect(fixture.document.nodes).toEqual([])
  })

  test('Given Renderer 尝试夹带素材元数据 When 导入 Then 在文件选择前拒绝', async () => {
    const fixture = createFixture()
    /** 记录系统文件选择器是否被越权输入触发。 */
    let pickerCalled = false
    fixture.options.pickImageFiles = async () => {
      pickerCalled = true
      return []
    }
    registerDesignIpcHandlers(fixture.options)

    await expect(invoke(
      fixture.handlers,
      DESIGN_IPC_CHANNELS.IMPORT_ASSETS,
      fixture.senders[0]!,
      {
        projectId: 'project-1',
        expectedRevision: 0,
        viewportCenter: { x: 10, y: 20 },
        assets: [{ relativePath: '/forged/path.png' }],
      },
    )).rejects.toThrow('Design 请求结构无效')
    expect(pickerCalled).toBe(false)
    expect(fixture.guardProjects).toEqual([])
  })

  test('Given tmp 或 backup 恢复候选 When 导入、重新定位或导出 Then 在系统选择器前要求先重载', async () => {
    for (const recoverySource of ['tmp', 'backup'] as const) {
      const projectRoot = mkdtempSync(join(tmpdir(), `proma-design-import-${recoverySource}-`))
      const configRoot = mkdtempSync(join(tmpdir(), `proma-design-config-${recoverySource}-`))
      try {
        const pathResolver = createDesignPathResolver({
          getWorkspace: () => ({
            id: 'project-1', name: '项目', slug: 'stable-slug', projectRootPath: projectRoot,
            createdAt: 1, updatedAt: 1,
          }),
          getProjectFilesPath: () => projectRoot,
          getConfigDir: () => configRoot,
        })
        const store = createDesignStore({ pathResolver, now: () => 100 })
        const persisted = store.mutate('project-1', 0, [{
          type: 'set-viewport', viewport: { x: 10, y: 20, zoom: 1 },
        }])
        const canvasPath = pathResolver.resolve('project-1').canvasPath
        if (recoverySource === 'tmp') {
          renameSync(canvasPath, `${canvasPath}.tmp`)
        } else {
          writeFileSync(`${canvasPath}.bak`, readFileSync(canvasPath))
          writeFileSync(canvasPath, '{ broken', 'utf8')
        }
        const fixture = createFixture()
        /** 选择器和素材服务都不得在恢复提示前运行。 */
        let pickerCalls = 0
        let relinkPickerCalls = 0
        let exportPickerCalls = 0
        let stagingCalls = 0
        fixture.options.store = store
        fixture.options.pickImageFiles = async () => {
          pickerCalls += 1
          return ['/trusted/a.png']
        }
        fixture.options.pickRelinkImageFile = async () => {
          relinkPickerCalls += 1
          return '/trusted/relink.png'
        }
        fixture.options.pickExportPath = async () => {
          exportPickerCalls += 1
          return '/trusted/export.png'
        }
        fixture.options.assets.importAuthorizedFiles = async () => {
          stagingCalls += 1
          throw new Error('恢复状态下不应创建 staging')
        }
        registerDesignIpcHandlers(fixture.options)

        await expect(invoke(
          fixture.handlers,
          DESIGN_IPC_CHANNELS.IMPORT_ASSETS,
          fixture.senders[0]!,
          { projectId: 'project-1', expectedRevision: persisted.revision, viewportCenter: { x: 10, y: 20 } },
        )).rejects.toThrow(`DESIGN_RECOVERY_REQUIRED: recoveredFrom=${recoverySource}`)
        const afterRecovery = store.load('project-1').document
        expect(pickerCalls).toBe(0)
        expect(stagingCalls).toBe(0)
        expect(afterRecovery.assets).toEqual([])
        expect(afterRecovery.nodes).toEqual([])

        /** 每个命令都重新制造首次恢复，证明对应选择器不会抢先消费用户交互。 */
        if (recoverySource === 'tmp') {
          renameSync(canvasPath, `${canvasPath}.tmp`)
        } else {
          writeFileSync(`${canvasPath}.bak`, readFileSync(canvasPath))
          writeFileSync(canvasPath, '{ broken', 'utf8')
        }
        await expect(invoke(
          fixture.handlers,
          DESIGN_IPC_CHANNELS.RELINK_ASSET,
          fixture.senders[0]!,
          { projectId: 'project-1', assetId: 'asset-1', expectedRevision: persisted.revision },
        )).rejects.toThrow(`DESIGN_RECOVERY_REQUIRED: recoveredFrom=${recoverySource}`)
        store.load('project-1')

        if (recoverySource === 'tmp') {
          renameSync(canvasPath, `${canvasPath}.tmp`)
        } else {
          writeFileSync(`${canvasPath}.bak`, readFileSync(canvasPath))
          writeFileSync(canvasPath, '{ broken', 'utf8')
        }
        await expect(invoke(
          fixture.handlers,
          DESIGN_IPC_CHANNELS.EXPORT_ASSET,
          fixture.senders[0]!,
          { projectId: 'project-1', assetId: 'asset-1' },
        )).rejects.toThrow(`DESIGN_RECOVERY_REQUIRED: recoveredFrom=${recoverySource}`)
        expect(relinkPickerCalls).toBe(0)
        expect(exportPickerCalls).toBe(0)
      } finally {
        rmSync(projectRoot, { recursive: true, force: true })
        rmSync(configRoot, { recursive: true, force: true })
      }
    }
  })

  test('Given canvas 已落盘但 durability 报错 When 实际导入 handler 回滚 Then 重启按磁盘引用恢复', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'proma-design-ipc-project-'))
    const configRoot = mkdtempSync(join(tmpdir(), 'proma-design-ipc-config-'))
    const sourceRoot = mkdtempSync(join(tmpdir(), 'proma-design-ipc-source-'))
    try {
      const sourcePath = join(sourceRoot, 'import.png')
      await sharp({
        create: {
          width: 2,
          height: 2,
          channels: 4,
          background: { r: 255, g: 0, b: 0, alpha: 1 },
        },
      }).png().toFile(sourcePath)
      const pathResolver = createDesignPathResolver({
        getWorkspace: () => ({
          id: 'project-1',
          name: '项目',
          slug: 'stable-slug',
          projectRootPath: projectRoot,
          createdAt: 1,
          updatedAt: 1,
        }),
        getProjectFilesPath: () => projectRoot,
        getConfigDir: () => configRoot,
      })
      const realStore = createDesignStore({ pathResolver, now: () => 100 })
      realStore.load('project-1')
      /** 真实提交新 revision 后模拟目录 durability 同步报错。 */
      const durabilityStore: DesignStore = {
        load: (projectId) => realStore.load(projectId),
        requireStableAuthoritativeDocument: (projectId) => (
          realStore.requireStableAuthoritativeDocument(projectId)
        ),
        mutate: (projectId, expectedRevision, mutations) => {
          realStore.mutate(projectId, expectedRevision, mutations)
          throw new Error('目录 durability 同步失败')
        },
      }
      const createService = (runtimeId: string): DesignAssetService => new DesignAssetService({
        pathResolver,
        store: durabilityStore,
        runtimeId,
        runWorkspaceWrite: (_projectId, effect) => effect(),
        registerDirectoryPath: (directoryPath) => `proma-file://${basename(directoryPath)}`,
        registerRetainedDirectoryPaths: (directoryPaths) => directoryPaths
          .map((directoryPath) => `proma-file://${basename(directoryPath)}`),
        revokePathUrl: () => {},
        warn: () => {},
      })
      const fixture = createFixture()
      const oldRuntimeService = createService('runtime-before-crash')
      fixture.options.store = durabilityStore
      fixture.options.assets = oldRuntimeService
      fixture.options.pickImageFiles = async () => [sourcePath]
      registerDesignIpcHandlers(fixture.options)

      await expect(invoke(
        fixture.handlers,
        DESIGN_IPC_CHANNELS.IMPORT_ASSETS,
        fixture.senders[0]!,
        { projectId: 'project-1', expectedRevision: 0, viewportCenter: { x: 10, y: 20 } },
      )).rejects.toThrow('目录 durability 同步失败')

      const persistedAsset = realStore.load('project-1').document.assets[0]
      const persistedNode = realStore.load('project-1').document.nodes[0]
      expect(persistedAsset).toBeDefined()
      expect(persistedNode).toMatchObject({ kind: 'asset', assetId: persistedAsset!.id })
      const paths = pathResolver.resolve('project-1')
      expect(existsSync(join(paths.designRoot, persistedAsset!.relativePath))).toBe(true)
      expect(existsSync(join(paths.cacheRoot, persistedAsset!.thumbnailRelativePath))).toBe(true)
      expect(readdirSync(join(paths.jobsDir, 'promotions'))).toHaveLength(1)

      const restartedService = createService('runtime-after-crash')
      restartedService.recoverPromotionJournals('project-1')

      expect(existsSync(join(paths.designRoot, persistedAsset!.relativePath))).toBe(true)
      expect(existsSync(join(paths.cacheRoot, persistedAsset!.thumbnailRelativePath))).toBe(true)
      expect(readdirSync(join(paths.jobsDir, 'promotions'))).toEqual([])
    } finally {
      rmSync(projectRoot, { recursive: true, force: true })
      rmSync(configRoot, { recursive: true, force: true })
      rmSync(sourceRoot, { recursive: true, force: true })
    }
  })
})

/** 创建 IPC 任务替身。 */
function createJobRecord(id: string): DesignJobRecord {
  return {
    id,
    projectId: 'project-1',
    action: 'generate',
    status: 'queued',
    prompt: '生成',
    createdAt: 1,
    updatedAt: 1,
  }
}
