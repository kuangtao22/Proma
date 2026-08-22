import { describe, expect, test } from 'bun:test'
import { createEmptyDesignDocument } from '@proma/shared'
import type { CreateDesignJobInput, DesignAsset, DesignWorkspaceSnapshot } from '@proma/shared'
import { createStore, Provider } from 'jotai'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  createInitialDesignProjectState,
  designProjectStatesAtom,
  updateDesignProjectStateAtom,
} from '@/atoms/design-atoms'
import type { DesignAdapter } from '@/lib/design-adapter'
import {
  createDesignEditJobInput,
  createDesignGenerationJobInput,
  DesignInspectorStateView,
  serializeDesignGenerationPrompt,
  useDesignVersionRows,
} from './DesignInspector'
import { buildDesignVersionTree } from './design-version-tree'
import {
  getDesignAssetDeleteBlockReason,
  useDesignInspectorActions,
} from './use-design-inspector-actions'
import { createDesignWorkspaceController } from './use-design-workspace'

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
      onClearSelection={() => undefined}
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
    expect(html).toContain('AI 编辑仅支持画布素材节点')
    expect(html).not.toContain('编辑 poster.png')
  })

  test('Given 多选包含 job 节点 When 渲染 Then 分组入口禁用', () => {
    const snapshot = createSnapshot()
    snapshot.document.nodes.push({
      id: 'job-node', kind: 'job', jobId: 'job-1', position: { x: 30, y: 40 },
      width: 320, height: 240, zIndex: 1,
    })
    const html = renderInspector(['node-1', 'job-node'], snapshot)

    expect(html).toMatch(/创建分组[\s\S]*disabled=""|disabled=""[^>]*>创建分组/)
  })

  test('Given 单选 job 节点 When 渲染 AI 标签 Then 显示不可编辑且不降级为生成表单', () => {
    const snapshot = createSnapshot()
    snapshot.document.nodes = [{
      id: 'job-node', kind: 'job', jobId: 'job-1', position: { x: 30, y: 40 },
      width: 320, height: 240, zIndex: 1,
    }]
    const html = renderInspector(['job-node'], snapshot)

    expect(html).toContain('AI 编辑仅支持单个素材节点')
    expect(html).not.toContain('生成图片')
  })

  test('Given 仅右栏素材选中 When 渲染 Then 清除选择可用', () => {
    const snapshot = createSnapshot()
    snapshot.document.nodes = []
    const html = renderInspector([], snapshot, 'asset-1')

    expect(html).toMatch(/aria-label="清除选择"(?![^>]*disabled)/)
  })

  test('Given 只读项目 When 渲染 Then 禁用写操作但允许导出', () => {
    const html = renderInspector(['node-1'], createSnapshot(false))

    expect(html).toMatch(/aria-label="删除素材"[^>]*disabled=""/)
    expect(html).toMatch(/aria-label="导出素材"(?![^>]*disabled)/)
    expect(html).toMatch(/id="design-edit-prompt" disabled=""/)
    expect(html).toMatch(/type="submit" disabled=""[^>]*>[\s\S]*开始编辑/)
  })

  test('Given AI 编辑与生成选择器 When 渲染 Then Label 与 Trigger 通过 id 关联', () => {
    const generationHtml = renderInspector([])
    const editHtml = renderInspector(['node-1'])

    expect(generationHtml).toContain('for="design-aspect-ratio"')
    expect(generationHtml).toContain('id="design-aspect-ratio"')
    expect(generationHtml).toContain('for="design-image-size"')
    expect(generationHtml).toContain('id="design-image-size"')
    expect(editHtml).toContain('for="design-mask-annotation"')
    expect(editHtml).toContain('id="design-mask-annotation"')
  })
})

describe('Design Inspector 纯业务契约', () => {
  test('Given 版本输入未变化但 prompt 状态重渲染 When 读取版本行 Then 只构建一次版本树', () => {
    const assets = [createAsset()]
    /** 记录同一稳定输入实际执行建树的次数。 */
    let buildCount = 0
    const buildTree: typeof buildDesignVersionTree = (inputAssets, currentAssetId) => {
      buildCount += 1
      return buildDesignVersionTree(inputAssets, currentAssetId)
    }
    /** 组件自身更新无关 prompt，模拟 forceMount 隐藏版本页随表单输入重渲染。 */
    const Probe = (): React.ReactElement => {
      const [prompt, setPrompt] = React.useState('')
      const rows = useDesignVersionRows(assets, null, buildTree)
      if (!prompt) setPrompt('更新 prompt')
      return <span>{rows.length}</span>
    }

    renderToStaticMarkup(<Probe />)

    expect(buildCount).toBe(1)
  })

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

  test('Given 素材仍被节点引用 When 请求删除 Then 返回稳定阻断原因', () => {
    const snapshot = createSnapshot()
    expect(getDesignAssetDeleteBlockReason(snapshot.document, 'asset-1')).toBe(
      '请先从画布移除该素材的全部节点',
    )
    expect(getDesignAssetDeleteBlockReason(snapshot.document, 'unused')).toBeNull()
  })

  test('Given 主进程原子返回新素材与节点 When 执行导入 Then 采用权威快照且不产生待保存 mutation', async () => {
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
    importedDocument.nodes = [{
      id: 'node-imported', kind: 'asset', assetId: 'asset-1', position: { x: 0, y: 0 },
      width: 320, height: 240, zIndex: 0,
    }]
    /** 记录 Renderer 只提交受控 revision 和画布中心。 */
    const importInputs: Array<{ projectId: string; expectedRevision: number; viewportCenter: { x: number; y: number } }> = []
    const adapter: Pick<DesignAdapter, 'importAssets' | 'deleteAsset' | 'relinkAsset' | 'exportAsset'> = {
      importAssets: async (input) => {
        importInputs.push(input)
        return { document: importedDocument, writable: true }
      },
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
    expect(importInputs).toEqual([{ projectId: 'project-1', expectedRevision: 0, viewportCenter: { x: 0, y: 0 } }])
    expect(state.snapshot?.document.assets.map((asset) => asset.id)).toEqual(['asset-1'])
    expect(state.snapshot?.document.nodes.map((node) => node.id)).toEqual(['node-imported'])
    expect(state.selectedNodeIds).toEqual(['node-imported'])
    expect(state.pendingMutations).toEqual([])
    expect(state.history).toEqual([])
  })

  test('Given 权威恢复正在加载或失败 When 请求导入 Then 不读取旧 revision', async () => {
    const store = createStore()
    const snapshot = createSnapshot()
    /** 记录恢复阻断期间是否错误调用主进程导入。 */
    let importCount = 0
    const adapter: Pick<DesignAdapter, 'importAssets' | 'deleteAsset' | 'relinkAsset' | 'exportAsset'> = {
      importAssets: async () => { importCount += 1; return snapshot },
      deleteAsset: async () => snapshot.document,
      relinkAsset: async () => snapshot.document,
      exportAsset: async () => undefined,
    }
    let actions: ReturnType<typeof useDesignInspectorActions> | null = null
    const Probe = (): null => {
      actions = useDesignInspectorActions('project-1', adapter)
      return null
    }
    renderToStaticMarkup(<Provider store={store}><Probe /></Provider>)

    for (const authoritativeRecoveryState of ['loading', 'failed'] as const) {
      store.set(designProjectStatesAtom, new Map([['project-1', {
        ...createInitialDesignProjectState(),
        phase: 'ready',
        snapshot,
        authoritativeRecoveryState,
        saveState: 'saved',
      }]]))
      actions!.importAssets()
    }
    await Promise.resolve()

    expect(importCount).toBe(0)
  })

  test('Given 首次导入要求恢复 When 权威重载完成后再次导入 Then 回调接管恢复且导入可以重试', async () => {
    const store = createStore()
    const staleSnapshot = createSnapshot()
    /** 旧历史和选区用于证明 controller 完整替换恢复前基线。 */
    const historyEntry = {
      forward: [{ type: 'set-viewport' as const, viewport: { x: 1, y: 1, zoom: 1 } }],
      inverse: [{ type: 'set-viewport' as const, viewport: { x: 0, y: 0, zoom: 1 } }],
    }
    store.set(designProjectStatesAtom, new Map([['project-1', {
      ...createInitialDesignProjectState(),
      phase: 'ready',
      snapshot: staleSnapshot,
      selectedNodeIds: ['node-1'],
      inspectorAssetId: 'asset-1',
      history: [historyEntry],
      future: [historyEntry],
    }]]))
    /** 恢复后主进程重新签发的权威快照与媒体授权。 */
    const authoritativeSnapshot = createSnapshot()
    authoritativeSnapshot.document.revision = 1
    authoritativeSnapshot.assetBaseUrl = 'proma-file://new/assets/'
    authoritativeSnapshot.thumbnailBaseUrl = 'proma-file://new/thumbnails/'
    /** 第二次导入返回的权威素材与节点。 */
    const importedSnapshot = createSnapshot()
    importedSnapshot.document.revision = 2
    importedSnapshot.document.nodes[0] = { ...importedSnapshot.document.nodes[0]!, id: 'node-retried' }
    /** 记录恢复回调和导入重试次数。 */
    let importCount = 0
    let loadCount = 0
    const adapter: Pick<DesignAdapter, 'importAssets' | 'deleteAsset' | 'relinkAsset' | 'exportAsset'> = {
      importAssets: async () => {
        importCount += 1
        if (importCount === 1) throw new Error('DESIGN_RECOVERY_REQUIRED: recoveredFrom=backup')
        return importedSnapshot
      },
      deleteAsset: async () => importedSnapshot.document,
      relinkAsset: async () => importedSnapshot.document,
      exportAsset: async () => undefined,
    }
    /** 与页面一致的唯一工作区 controller，恢复回调不复制任何状态规则。 */
    const controller = createDesignWorkspaceController({
      projectId: 'project-1',
      adapter: {
        load: async () => { loadCount += 1; return authoritativeSnapshot },
        save: async () => authoritativeSnapshot.document,
        onChanged: () => () => undefined,
        releaseMediaAccess: async () => undefined,
      },
      getState: () => store.get(designProjectStatesAtom).get('project-1')
        ?? createInitialDesignProjectState(),
      updateState: (update) => store.set(updateDesignProjectStateAtom, { projectId: 'project-1', update }),
      scheduler: {
        setTimeout: () => 1,
        clearTimeout: () => undefined,
      },
      onReleaseError: () => undefined,
    })
    let actions: ReturnType<typeof useDesignInspectorActions> | null = null
    const Probe = (): null => {
      actions = useDesignInspectorActions('project-1', adapter, {
        onRecoveryRequired: controller.reloadAuthoritativeSnapshot,
      })
      return null
    }
    renderToStaticMarkup(<Provider store={store}><Probe /></Provider>)

    actions!.importAssets()
    await new Promise((resolve) => setTimeout(resolve, 0))
    const recoveredState = store.get(designProjectStatesAtom).get('project-1')!
    expect(loadCount).toBe(1)
    expect(importCount).toBe(1)
    expect(recoveredState.snapshot).toBe(authoritativeSnapshot)
    expect(recoveredState.snapshot?.assetBaseUrl).toBe('proma-file://new/assets/')
    expect(recoveredState.snapshot?.thumbnailBaseUrl).toBe('proma-file://new/thumbnails/')
    expect(recoveredState.selectedNodeIds).toEqual([])
    expect(recoveredState.inspectorAssetId).toBeNull()
    expect(recoveredState.history).toEqual([])
    expect(recoveredState.future).toEqual([])

    actions!.importAssets()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(importCount).toBe(2)
    expect(store.get(designProjectStatesAtom).get('project-1')?.snapshot?.document.nodes[0]?.id).toBe('node-retried')
  })

  test('Given 任一素材命令要求恢复 When action 收到错误 Then 四种命令调用同一权威恢复入口', async () => {
    const store = createStore()
    const snapshot = createSnapshot()
    snapshot.document.nodes = []
    store.set(designProjectStatesAtom, new Map([['project-1', {
      ...createInitialDesignProjectState(),
      phase: 'ready',
      snapshot,
    }]]))
    const recoveryError = new Error('DESIGN_RECOVERY_REQUIRED: recoveredFrom=backup')
    const adapter: Pick<DesignAdapter, 'importAssets' | 'deleteAsset' | 'relinkAsset' | 'exportAsset'> = {
      importAssets: async () => { throw recoveryError },
      deleteAsset: async () => { throw recoveryError },
      relinkAsset: async () => { throw recoveryError },
      exportAsset: async () => { throw recoveryError },
    }
    /** 记录四种素材命令是否统一交给同一个工作区 controller 入口。 */
    let recoveryCount = 0
    const reloadAuthoritativeSnapshot = (): void => { recoveryCount += 1 }
    let actions: ReturnType<typeof useDesignInspectorActions> | null = null
    const Probe = (): null => {
      actions = useDesignInspectorActions('project-1', adapter, {
        onRecoveryRequired: reloadAuthoritativeSnapshot,
      })
      return null
    }
    renderToStaticMarkup(<Provider store={store}><Probe /></Provider>)

    actions!.importAssets()
    actions!.deleteAsset('asset-1')
    actions!.relinkAsset('asset-1')
    actions!.exportAsset('asset-1')
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(recoveryCount).toBe(4)
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
