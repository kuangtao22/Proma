import { describe, expect, test } from 'bun:test'
import { createEmptyDesignDocument } from '@proma/shared'
import type { CreateDesignJobInput, DesignAsset, DesignWorkspaceSnapshot } from '@proma/shared'
import { createStore, Provider } from 'jotai'
import { renderToStaticMarkup } from 'react-dom/server'
import { createInitialDesignProjectState, designProjectStatesAtom } from '@/atoms/design-atoms'
import type { DesignAdapter } from '@/lib/design-adapter'
import {
  createDesignEditJobInput,
  createDesignGenerationJobInput,
  createImportedDesignMutations,
  DesignInspectorStateView,
  serializeDesignGenerationPrompt,
} from './DesignInspector'
import {
  getDesignAssetDeleteBlockReason,
  useDesignInspectorActions,
} from './use-design-inspector-actions'

/** 创建 Inspector 测试素材。 */
function createAsset(overrides: Partial<DesignAsset> = {}): DesignAsset {
  return {
    id: 'asset-1',
    filename: 'poster.png',
    relativePath: 'assets/poster.png',
    thumbnailRelativePath: 'thumbnails/poster.png',
    mediaType: 'image/png',
    width: 1200,
    height: 800,
    byteSize: 2048,
    sha256: 'hash',
    createdAt: 1,
    ...overrides,
  }
}

/** 创建带一张素材和一个节点的 Inspector 快照。 */
function createSnapshot(writable = true): DesignWorkspaceSnapshot {
  const document = createEmptyDesignDocument('project-1', 10)
  document.assets = [createAsset()]
  document.nodes = [{
    id: 'node-1',
    kind: 'asset',
    assetId: 'asset-1',
    position: { x: 10, y: 20 },
    width: 320,
    height: 240,
    zIndex: 0,
  }]
  return { document, writable, thumbnailBaseUrl: 'proma-file://thumbs' }
}

/** 渲染指定选区下的 Inspector 纯状态视图。 */
function renderInspector(
  selectedNodeIds: string[],
  snapshot = createSnapshot(),
  inspectorAssetId: string | null = null,
): string {
  return renderToStaticMarkup(
    <DesignInspectorStateView
      state={{
        ...createInitialDesignProjectState(),
        phase: 'ready',
        snapshot,
        selectedNodeIds,
        inspectorAssetId,
      }}
      onTabChange={() => undefined}
      onImportAssets={() => undefined}
      onDeleteAsset={() => undefined}
      onRelinkAsset={() => undefined}
      onExportAsset={() => undefined}
      onGroupSelection={() => undefined}
      onSelectAsset={() => undefined}
      onCreateJob={(_input: CreateDesignJobInput) => undefined}
    />,
  )
}

describe('Design Inspector 状态', () => {
  test('Given 空选区 When 渲染素材与 AI 标签 Then 显示项目素材和生成表单', () => {
    const html = renderInspector([])

    expect(html).toContain('素材')
    expect(html).toContain('AI 编辑')
    expect(html).toContain('版本')
    expect(html).toContain('项目素材')
    expect(html).toContain('生成图片')
    expect(html).toContain('画面比例')
    expect(html).toContain('图片尺寸')
  })

  test('Given 单选素材节点 When 渲染 Then 显示文件、尺寸、来源和素材命令', () => {
    const html = renderInspector(['node-1'])

    expect(html).toContain('poster.png')
    expect(html).toContain('1200 × 800')
    expect(html).toContain('本地导入')
    expect(html).toContain('aria-label="导出素材"')
    expect(html).toContain('aria-label="删除素材"')
  })

  test('Given 多选素材节点 When 渲染 Then 显示数量和分组入口', () => {
    const snapshot = createSnapshot()
    snapshot.document.assets.push(createAsset({ id: 'asset-2', filename: 'second.png' }))
    snapshot.document.nodes.push({
      id: 'node-2',
      kind: 'asset',
      assetId: 'asset-2',
      position: { x: 40, y: 50 },
      width: 320,
      height: 240,
      zIndex: 1,
    })
    const html = renderInspector(['node-1', 'node-2'], snapshot)

    expect(html).toContain('已选择 2 项')
    expect(html).toContain('创建分组')
  })

  test('Given 节点引用缺失素材 When 渲染 Then 提供重新定位入口', () => {
    const snapshot = createSnapshot()
    snapshot.document.nodes[0] = { ...snapshot.document.nodes[0]!, assetId: 'missing-asset' }
    const html = renderInspector(['node-1'], snapshot)

    expect(html).toContain('素材缺失')
    expect(html).toContain('重新定位')
  })

  test('Given 素材没有画布节点 When 从素材列表选择 Then 仍显示详情与删除入口', () => {
    const snapshot = createSnapshot()
    snapshot.document.nodes = []
    const html = renderInspector([], snapshot, 'asset-1')

    expect(html).toContain('poster.png')
    expect(html).toContain('aria-label="删除素材"')
  })

  test('Given 只读项目 When 渲染 Then 禁用写操作但允许导出', () => {
    const html = renderInspector(['node-1'], createSnapshot(false))

    expect(html).toMatch(/aria-label="删除素材"[^>]*disabled=""/)
    expect(html).toMatch(/aria-label="导出素材"(?![^>]*disabled)/)
    expect(html).toMatch(/id="design-edit-prompt" disabled=""/)
    expect(html).toMatch(/type="submit" disabled=""[^>]*>[\s\S]*开始编辑/)
  })
})

describe('Design Inspector 纯业务契约', () => {
  test('Given 生成约束 When 序列化 prompt Then 产出机器可读比例和尺寸', () => {
    expect(serializeDesignGenerationPrompt('生成海报', '16:9', '2K')).toBe(
      '生成海报\n\n[PROMA_DESIGN_CONSTRAINTS]\n{"aspectRatio":"16:9","imageSize":"2K"}',
    )
  })

  test('Given 生成与编辑表单 When 输出任务 Then 只使用现有共享字段并保留可选蒙版', () => {
    expect(createDesignGenerationJobInput('project-1', ' 生成海报 ', '3:4', '4K', { x: 5, y: 6 })).toEqual({
      projectId: 'project-1',
      action: 'generate',
      prompt: '生成海报\n\n[PROMA_DESIGN_CONSTRAINTS]\n{"aspectRatio":"3:4","imageSize":"4K"}',
      position: { x: 5, y: 6 },
    })
    expect(createDesignEditJobInput('project-1', ' 去掉文字 ', 'asset-1', 'mask-1', { x: 7, y: 8 })).toEqual({
      projectId: 'project-1',
      action: 'edit',
      prompt: '去掉文字',
      sourceAssetId: 'asset-1',
      maskAnnotationId: 'mask-1',
      position: { x: 7, y: 8 },
    })
  })

  test('Given 两个导入素材 When 创建 mutation Then 素材与节点同批且节点从中心按 24px 偏移', () => {
    const document = createEmptyDesignDocument('project-1', 10)
    const assets = [createAsset({ id: 'asset-1' }), createAsset({ id: 'asset-2' })]
    let nextId = 0
    const mutations = createImportedDesignMutations(
      document,
      assets,
      { x: 100, y: 200 },
      () => `node-${++nextId}`,
    )

    expect(mutations[0]).toEqual({ type: 'upsert-assets', assets })
    expect(mutations[1]).toMatchObject({
      type: 'upsert-nodes',
      nodes: [
        { id: 'node-1', assetId: 'asset-1', position: { x: 100, y: 200 } },
        { id: 'node-2', assetId: 'asset-2', position: { x: 124, y: 224 } },
      ],
    })
  })

  test('Given 素材仍被节点引用 When 请求删除 Then 返回稳定阻断原因', () => {
    const snapshot = createSnapshot()
    expect(getDesignAssetDeleteBlockReason(snapshot.document, 'asset-1')).toBe(
      '请先从画布移除该素材的全部节点',
    )
    expect(getDesignAssetDeleteBlockReason(snapshot.document, 'unused')).toBeNull()
  })

  test('Given 主进程导入返回新素材 When 执行导入 Then 只把节点 mutation 加入待保存队列', async () => {
    const store = createStore()
    const initialDocument = createEmptyDesignDocument('project-1', 10)
    store.set(designProjectStatesAtom, new Map([['project-1', {
      ...createInitialDesignProjectState(),
      phase: 'ready',
      snapshot: { document: initialDocument, writable: true },
    }]]))
    /** 主进程已经提交素材 revision 的导入返回。 */
    const importedDocument = createEmptyDesignDocument('project-1', 20)
    importedDocument.revision = 1
    importedDocument.assets = [createAsset()]
    const adapter: Pick<DesignAdapter, 'importAssets' | 'deleteAsset' | 'relinkAsset' | 'exportAsset'> = {
      importAssets: async () => ({ document: importedDocument, writable: true }),
      deleteAsset: async () => importedDocument,
      relinkAsset: async () => importedDocument,
      exportAsset: async () => undefined,
    }
    /** 从 hook 捕获真实命令，随后在静态渲染外调用。 */
    let actions: ReturnType<typeof useDesignInspectorActions> | null = null
    const Probe = (): null => {
      actions = useDesignInspectorActions('project-1', adapter)
      return null
    }
    renderToStaticMarkup(<Provider store={store}><Probe /></Provider>)

    actions!.importAssets()
    await new Promise((resolve) => setTimeout(resolve, 0))

    const state = store.get(designProjectStatesAtom).get('project-1')!
    expect(state.snapshot?.document.assets.map((asset) => asset.id)).toEqual(['asset-1'])
    expect(state.snapshot?.document.nodes).toHaveLength(1)
    expect(state.pendingMutations).toHaveLength(1)
    expect(state.pendingMutations[0]?.type).toBe('upsert-nodes')
  })

  test('Given 素材没有节点引用 When 删除或重新定位 Then 调用 adapter 并使用当前 revision', async () => {
    const store = createStore()
    const snapshot = createSnapshot()
    snapshot.document.nodes = []
    store.set(designProjectStatesAtom, new Map([['project-1', {
      ...createInitialDesignProjectState(),
      phase: 'ready',
      snapshot,
    }]]))
    /** 记录写命令输入，验证没有把路径带出主进程选择器。 */
    const calls: Array<{ command: string; expectedRevision: number }> = []
    const adapter: Pick<DesignAdapter, 'importAssets' | 'deleteAsset' | 'relinkAsset' | 'exportAsset'> = {
      importAssets: async () => snapshot,
      deleteAsset: async (input) => { calls.push({ command: 'delete', expectedRevision: input.expectedRevision }); return snapshot.document },
      relinkAsset: async (input) => { calls.push({ command: 'relink', expectedRevision: input.expectedRevision }); return snapshot.document },
      exportAsset: async () => undefined,
    }
    let actions: ReturnType<typeof useDesignInspectorActions> | null = null
    const Probe = (): null => {
      actions = useDesignInspectorActions('project-1', adapter)
      return null
    }
    renderToStaticMarkup(<Provider store={store}><Probe /></Provider>)

    actions!.selectAsset('asset-1')
    expect(store.get(designProjectStatesAtom).get('project-1')?.inspectorAssetId).toBe('asset-1')
    actions!.deleteAsset('asset-1')
    actions!.relinkAsset('asset-1')
    await Promise.resolve()

    expect(calls).toEqual([
      { command: 'delete', expectedRevision: 0 },
      { command: 'relink', expectedRevision: 0 },
    ])
  })

  test('Given 只读项目 When 请求导出 Then 仍调用 adapter 且不调用写命令', async () => {
    const store = createStore()
    store.set(designProjectStatesAtom, new Map([['project-1', {
      ...createInitialDesignProjectState(),
      phase: 'ready',
      snapshot: createSnapshot(false),
    }]]))
    /** 记录素材 adapter 的实际命令。 */
    const calls: string[] = []
    const adapter: Pick<DesignAdapter, 'importAssets' | 'deleteAsset' | 'relinkAsset' | 'exportAsset'> = {
      importAssets: async () => createSnapshot(false),
      deleteAsset: async () => { calls.push('delete'); return createSnapshot(false).document },
      relinkAsset: async () => { calls.push('relink'); return createSnapshot(false).document },
      exportAsset: async () => { calls.push('export') },
    }
    let actions: ReturnType<typeof useDesignInspectorActions> | null = null
    const Probe = (): null => {
      actions = useDesignInspectorActions('project-1', adapter)
      return null
    }
    renderToStaticMarkup(<Provider store={store}><Probe /></Provider>)

    actions!.deleteAsset('asset-1')
    actions!.relinkAsset('asset-1')
    actions!.exportAsset('asset-1')
    actions!.selectAsset('asset-1')
    await Promise.resolve()

    expect(calls).toEqual(['export'])
    expect(store.get(designProjectStatesAtom).get('project-1')?.selectedNodeIds).toEqual(['node-1'])
  })
})
