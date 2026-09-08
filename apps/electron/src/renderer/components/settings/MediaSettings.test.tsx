import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { MediaRemoteDescriptor, MediaRemoteWorkflow, MediaResourcePage, MediaResourceQuery, MediaWorkflowDefinition, MediaWorkflowVersion } from '@proma/shared'
import * as mediaSettingsModule from './MediaSettings'

interface ExpectedMediaSettingsModule {
  formatMediaError: (error: unknown) => string
  buildSaveMediaConnectionInput: (draft: {
    id: string
    name: string
    baseUrl: string
    enabled: boolean
    authKind: 'none' | 'bearer' | 'header'
    headerName: string
    credential: string
    credentialConfigured: boolean
    comfyUser: string
  }) => Record<string, unknown>
  buildSaveMediaWorkflowInput: (draft: {
    id: string
    name: string
    definitionText: string
  }) => { id: string; name: string; projectId: null; definition: MediaWorkflowDefinition }
  changeMediaResourceFilters: (
    state: { connectionId: string; kind: 'nodes' | 'models' | 'workflows' | 'assets'; query: string; folder: string; offset: number },
    patch: Partial<{ connectionId: string; kind: 'nodes' | 'models' | 'workflows' | 'assets'; query: string; folder: string }>,
  ) => { resourceState: { connectionId: string; kind: 'nodes' | 'models' | 'workflows' | 'assets'; query: string; folder: string; offset: number }; resourcePage: null; selectedResourceId: null }
  hasMediaConnectionIdentityChanged: (
    baseline: { baseUrl: string; authKind: string; headerName: string; credential: string; comfyUser: string },
    draft: { baseUrl: string; authKind: string; headerName: string; credential: string; comfyUser: string },
  ) => boolean
  createPublicWorkflowCopyInput: (workflow: MediaWorkflowVersion, id: string) => {
    id: string
    name: string
    projectId: null
    definition: MediaWorkflowDefinition
  }
  createRemoteWorkflowDraft: (remote: MediaRemoteWorkflow, name: string, id: string) => {
    id: string
    name: string
    definition: MediaWorkflowDefinition
    invalidated: false
  }
  RemoteWorkflowContent: (props: { remote: MediaRemoteWorkflow; onImport: () => void }) => React.ReactElement
  MediaSettingsTabsView: (props: { activeTab: 'models' | 'connections' | 'workflows'; onTabChange: (tab: 'models' | 'connections' | 'workflows') => void }) => React.ReactElement
  parseMediaWorkflowImportText: (text: string) => MediaWorkflowDefinition
  isCurrentMediaResourceRequest: (requestRevision: number, currentRevision: number) => boolean
  createMediaResourceQuery: (
    state: { connectionId: string; kind: 'nodes' | 'models' | 'workflows' | 'assets'; query: string; folder: string; offset: number },
    refresh: boolean,
    offset?: number,
  ) => MediaResourceQuery
  getMediaResourceAutoLoadDelay: (query: string) => number
  getMediaResourceModelFolders: (page: MediaResourcePage | null) => string[]
  getMediaResourcePageStatus: (page: MediaResourcePage | null, kind: 'nodes' | 'models' | 'workflows' | 'assets') => { sourceLabel: string; timeLabel: string } | null
  getMediaResourceCapabilityMessage: (page: MediaResourcePage | null, kind: 'nodes' | 'models' | 'workflows' | 'assets') => string | null
  retainMediaResourcePageAfterFailure: <T extends MediaResourcePage>(page: T | null, error: unknown) => { page: T | null; error: string }
  replaceMediaAssetPreview: (
    current: { url: string; contentType: string } | null,
    descriptor: MediaRemoteDescriptor,
    dependencies: {
      read: (descriptor: MediaRemoteDescriptor) => Promise<{ bytes: Uint8Array; contentType: string }>
      createUrl: (bytes: Uint8Array, contentType: string) => string
      revokeUrl: (url: string) => void
    },
  ) => Promise<{ preview: { url: string; contentType: string } | null; error: string | null }>
  releaseMediaAssetPreview: (preview: { url: string; contentType: string } | null, revokeUrl: (url: string) => void) => void
  resolveEditedMediaConnection: (
    connections: Array<{ id: string; name: string }>,
    baseline: { id: string } | null,
  ) => { id: string; name: string } | undefined
}

/** 通过期望合同访问模块，让 RED 失败聚焦缺少的行为。 */
function getExpectedModule(): ExpectedMediaSettingsModule {
  return mediaSettingsModule as unknown as ExpectedMediaSettingsModule
}

/** 创建公共复制测试使用的私有工作流。 */
function createPrivateWorkflow(): MediaWorkflowVersion {
  return {
    id: 'private-workflow',
    name: '项目视频流程',
    projectId: 'project-1',
    revision: 3,
    hash: 'hash-1',
    createdAt: 1,
    definition: {
      schemaVersion: 1,
      prompt: {
        '1': { class_type: 'LoadImage', inputs: { image: 'private/source.png' } },
        '2': { class_type: 'CLIPTextEncode', inputs: { text: '保留的默认提示词' } },
      },
      bindings: [
        { key: 'source', kind: 'image', nodeId: '1', input: 'image', loader: 'LoadImage' },
        { key: 'prompt', kind: 'text', nodeId: '2', input: 'text' },
      ],
      outputs: [{ key: 'result', nodeId: '2', outputIndex: 0, mediaType: 'image' }],
    },
  }
}

describe('MediaSettings 已确认交互合同', () => {
  test('Given 远端工作流详情读取失败 When Renderer 展示错误 Then 提供可操作的同步重试提示', () => {
    const { formatMediaError } = getExpectedModule()
    expect(formatMediaError(new Error('MEDIA_REMOTE_WORKFLOW_READ_FAILED')))
      .toContain('重新同步工作流列表后重试')
  })

  test('Given 新连接 When 保存 Then 不要求项目授权并保留可选 Comfy 用户名', () => {
    const { buildSaveMediaConnectionInput } = getExpectedModule()
    expect(buildSaveMediaConnectionInput({
      id: 'connection-1', name: ' Local Comfy ', baseUrl: 'http://127.0.0.1:8188', enabled: true,
      authKind: 'none', headerName: '', credential: '', credentialConfigured: false, comfyUser: ' studio-user ',
    })).toEqual({
      id: 'connection-1', name: 'Local Comfy', driver: 'comfyui', baseUrl: 'http://127.0.0.1:8188',
      enabled: true, auth: { kind: 'none' }, comfyUser: 'studio-user',
    })
  })

  test('Given 已配置 bearer 连接 When 秘密留空保存 Then 省略 credential 以保留原密钥', () => {
    const { buildSaveMediaConnectionInput } = getExpectedModule()
    expect(buildSaveMediaConnectionInput({
      id: 'connection-1', name: 'Remote', baseUrl: 'https://comfy.example', enabled: true,
      authKind: 'bearer', headerName: '', credential: '', credentialConfigured: true, comfyUser: '',
    })).not.toHaveProperty('credential')
  })

  test('Given 地址、认证或 Comfy 用户变化 When 浏览旧资源 Then 必须立即失效', () => {
    const { hasMediaConnectionIdentityChanged } = getExpectedModule()
    const baseline = { baseUrl: 'http://127.0.0.1:8188', authKind: 'none', headerName: '', credential: '', comfyUser: '' }
    expect(hasMediaConnectionIdentityChanged(baseline, { ...baseline, baseUrl: 'http://127.0.0.1:8288' })).toBeTrue()
    expect(hasMediaConnectionIdentityChanged(baseline, { ...baseline, comfyUser: 'alice' })).toBeTrue()
    expect(hasMediaConnectionIdentityChanged(baseline, { ...baseline })).toBeFalse()
  })

  test('Given 工作流草稿 When 保存 Then 只能创建公共版本且没有隐式 profile', () => {
    const { buildSaveMediaWorkflowInput } = getExpectedModule()
    const definitionText = JSON.stringify({
      schemaVersion: 1,
      prompt: { '1': { class_type: 'SaveImage', inputs: {} } },
      bindings: [],
      outputs: [{ key: 'result', nodeId: '1', outputIndex: 0, mediaType: 'image' }],
    })
    const input = buildSaveMediaWorkflowInput({ id: 'workflow-1', name: '公共出图', definitionText })
    expect(input.projectId).toBeNull()
    expect(input).not.toHaveProperty('profile')
  })

  test('Given 输出选择器引用不存在的节点 When 保存 Then 阻止发布无效公共版本', () => {
    const { buildSaveMediaWorkflowInput } = getExpectedModule()
    const definitionText = JSON.stringify({
      schemaVersion: 1,
      prompt: { '1': { class_type: 'SaveImage', inputs: {} } },
      bindings: [],
      outputs: [{ key: 'result', nodeId: 'missing', outputIndex: 0, mediaType: 'image' }],
    })
    expect(() => buildSaveMediaWorkflowInput({ id: 'workflow-1', name: '错误输出', definitionText }))
      .toThrow('输出节点不存在')
  })

  test('Given 项目私有历史 When 复制为公共版本 Then 换新 ID 并清空媒体文件名', () => {
    const { createPublicWorkflowCopyInput } = getExpectedModule()
    const input = createPublicWorkflowCopyInput(createPrivateWorkflow(), 'public-copy')
    expect(input.id).toBe('public-copy')
    expect(input.projectId).toBeNull()
    expect(input.definition.prompt['1']?.inputs.image).toBe('')
    expect(input.definition.prompt['2']?.inputs.text).toBe('保留的默认提示词')
  })

  test('Given 远端工作流 descriptor When 读取正文 Then 只有 API JSON 可进入未发布公共草稿', () => {
    const { createRemoteWorkflowDraft } = getExpectedModule()
    const descriptor = {
      connectionId: 'connection-1', instanceGeneration: 'generation-1', remoteUser: 'alice',
      source: 'user-data' as const, id: 'workflow-1', workflowPath: 'workflows/api.json',
    }
    const draft = createRemoteWorkflowDraft({
      descriptor,
      format: 'api',
      definition: { '1': { class_type: 'SaveImage', inputs: {} } },
    }, '远端流程', 'public-workflow')
    expect(draft.id).toBe('public-workflow')
    expect(draft.invalidated).toBeFalse()
    expect(draft.definition.outputs).toEqual([])
    expect(() => createRemoteWorkflowDraft({ descriptor, format: 'ui', definition: {} }, 'UI 图', 'ui-copy'))
      .toThrow('UI 工作流不能直接执行')
  })

  test('Given ComfyUI UI 工作流 When 打开详情 Then 使用只读代码编辑器且不触发导入', () => {
    /** 详情必须保留执行器不识别的 UI 字段。 */
    const { RemoteWorkflowContent } = getExpectedModule()
    /** 包含节点、连线及自定义尾部数据的远端正文。 */
    const remote: MediaRemoteWorkflow = {
      descriptor: { connectionId: 'connection-1', instanceGeneration: 'generation-1', remoteUser: '', source: 'user-data', id: 'ui', workflowPath: 'ui.json' },
      format: 'ui',
      definition: {
        nodes: [{ id: 1, type: 'LoadImage', widgets_values: ['source.png'] }, { id: 2, type: 'SaveImage' }],
        links: [[1, 1, 0, 2, 0, 'IMAGE']],
        extra: { lastField: '完整的末尾内容' },
      },
    }
    /** 渲染本身不得进入创建草稿流程。 */
    const html = renderToStaticMarkup(<RemoteWorkflowContent remote={remote} onImport={() => { throw new Error('不应自动导入') }} />)
    expect(html).toContain('ComfyUI UI 格式')
    expect(html).toContain('data-json-code-editor')
    expect(html).toContain('aria-label="完整工作流 JSON"')
    expect(html).not.toContain('<pre')
    expect(html).toContain('aria-label="复制完整工作流 JSON"')
    expect(html).toContain('仅预览')
    expect(html).not.toContain('role="alert"')
    expect(html).not.toContain('导入公共草稿')
  })

  test('Given API 工作流 When 打开详情 Then 提供代码编辑器和独立导入入口', () => {
    /** API 正文可以预览，也可以由用户显式导入。 */
    const { RemoteWorkflowContent } = getExpectedModule()
    /** API 图保留提示词与节点输入。 */
    const remote: MediaRemoteWorkflow = {
      descriptor: { connectionId: 'connection-1', instanceGeneration: 'generation-1', remoteUser: '', source: 'user-data', id: 'api', workflowPath: 'api.json' },
      format: 'api',
      definition: { '1': { class_type: 'CLIPTextEncode', inputs: { text: '完整提示词' } } },
    }
    /** 首次渲染不能隐式创建草稿。 */
    const html = renderToStaticMarkup(<RemoteWorkflowContent remote={remote} onImport={() => { throw new Error('不应自动导入') }} />)
    expect(html).toContain('ComfyUI API 格式')
    expect(html).toContain('data-json-code-editor')
    expect(html).toContain('导入公共草稿')
  })

  test('Given UI 工作流已可靠转换 When 打开详情 Then 显示分析状态、可定位错误并允许导入转换定义', () => {
    const { RemoteWorkflowContent, createRemoteWorkflowDraft } = getExpectedModule()
    const remote = {
      descriptor: { connectionId: 'connection-1', instanceGeneration: 'generation-1', remoteUser: '', source: 'user-data' as const, id: 'ui', workflowPath: 'ui.json' },
      format: 'ui' as const,
      definition: { nodes: [{ id: 1, type: 'SaveImage' }], links: [] },
      analysis: {
        format: 'ui' as const,
        convertible: true,
        definition: {
          schemaVersion: 1 as const,
          prompt: { '1': { class_type: 'SaveImage', inputs: {} } },
          bindings: [],
          outputs: [{ key: 'result', nodeId: '1', outputIndex: 0, mediaType: 'image' as const }],
        },
        issues: [{ code: 'TEST_WARNING', nodeId: '1', input: 'images', message: '可定位原因' }],
        nodes: [], inputs: [], outputs: [],
      },
    } as unknown as MediaRemoteWorkflow
    const html = renderToStaticMarkup(<RemoteWorkflowContent remote={remote} onImport={() => undefined} />)
    expect(html).toContain('已转换并通过校验')
    expect(html).toContain('TEST_WARNING')
    expect(html).toContain('节点 1')
    expect(html).toContain('字段 images')
    expect(html).toContain('导入公共草稿')
    const draft = createRemoteWorkflowDraft(remote, 'UI 流程', 'ui-copy')
    expect(draft.definition.prompt['1']?.class_type).toBe('SaveImage')
  })

  test('Given 远端工作流不可转换 When 打开详情 Then 展示阻塞问题且不提供导入入口', () => {
    const { RemoteWorkflowContent } = getExpectedModule()
    const remote = {
      descriptor: { connectionId: 'connection-1', instanceGeneration: 'generation-1', remoteUser: '', source: 'user-data' as const, id: 'blocked', workflowPath: 'blocked.json' },
      format: 'ui' as const,
      definition: { nodes: [], links: [] },
      analysis: {
        format: 'ui' as const, convertible: false, definition: null,
        issues: [{ code: 'UI_SUBGRAPH_UNSUPPORTED', message: '包含暂不支持的子图' }],
        nodes: [], inputs: [], outputs: [],
      },
    } as unknown as MediaRemoteWorkflow
    const html = renderToStaticMarkup(<RemoteWorkflowContent remote={remote} onImport={() => undefined} />)
    expect(html).toContain('暂不可导入')
    expect(html).toContain('UI_SUBGRAPH_UNSUPPORTED')
    expect(html).toContain('包含暂不支持的子图')
    expect(html).not.toContain('导入公共草稿')
  })

  test('Given 未识别格式及包含 HTML 的正文 When 预览 Then 仍显示原始内容并按文本转义', () => {
    /** 预览不依赖可执行格式，也不能将正文作为 HTML 注入。 */
    const { RemoteWorkflowContent } = getExpectedModule()
    /** 未识别对象中的文本保持只读。 */
    const remote: MediaRemoteWorkflow = {
      descriptor: { connectionId: 'connection-1', instanceGeneration: 'generation-1', remoteUser: '', source: 'user-data', id: 'unknown', workflowPath: 'unknown.json' },
      format: 'unknown',
      definition: { custom: '<script>alert(1)</script>' },
    }
    /** HTML 转义后的静态预览。 */
    const html = renderToStaticMarkup(<RemoteWorkflowContent remote={remote} onImport={() => undefined} />)
    expect(html).toContain('未识别格式')
    expect(html).toContain('data-json-code-editor')
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('导入公共草稿')
  })

  test('Given 已显示资源页 When 切换四类资源或连接 Then 清空旧页并回到第一页', () => {
    const { changeMediaResourceFilters } = getExpectedModule()
    const transition = changeMediaResourceFilters({
      connectionId: 'connection-1', kind: 'nodes', query: '', folder: '', offset: 50,
    }, { connectionId: 'connection-2', kind: 'assets' })
    expect(transition.resourceState).toEqual({
      connectionId: 'connection-2', kind: 'assets', query: '', folder: '', offset: 0,
    })
    expect(transition.resourcePage).toBeNull()
    expect(transition.selectedResourceId).toBeNull()
  })

  test('Given 旧资源请求迟到 When 查询代次已变化 Then 不能覆盖当前结果', () => {
    const { isCurrentMediaResourceRequest } = getExpectedModule()
    expect(isCurrentMediaResourceRequest(3, 4)).toBeFalse()
    expect(isCurrentMediaResourceRequest(4, 4)).toBeTrue()
  })

  test('Given 首次进入、切换页签或筛选 When 自动读取 Then 只查询本地快照并防抖搜索', () => {
    const { createMediaResourceQuery, getMediaResourceAutoLoadDelay } = getExpectedModule()
    const state = { connectionId: 'connection-1', kind: 'models' as const, query: ' flux ', folder: 'checkpoints', offset: 50 }
    expect(createMediaResourceQuery(state, false, 0)).toEqual({
      connectionId: 'connection-1', kind: 'models', query: 'flux', folder: 'checkpoints',
      offset: 0, limit: 50, refresh: false,
    })
    expect(getMediaResourceAutoLoadDelay('')).toBe(0)
    expect(getMediaResourceAutoLoadDelay('flux')).toBe(300)
  })

  test('Given 用户点击同步按钮 When 请求资源 Then 只有该请求携带 refresh 标记', () => {
    const { createMediaResourceQuery } = getExpectedModule()
    const state = { connectionId: 'connection-1', kind: 'nodes' as const, query: '', folder: '', offset: 0 }
    expect(createMediaResourceQuery(state, false).refresh).toBeFalse()
    expect(createMediaResourceQuery(state, true).refresh).toBeTrue()
  })

  test('Given 模型快照已返回目录 When 尚未测试连接 Then 目录直接来自快照元数据', () => {
    const { getMediaResourceModelFolders } = getExpectedModule()
    const page = {
      connectionId: 'connection-1', snapshotId: 'snapshot-1', checkedAt: 1,
      total: 0, nextOffset: null, items: [], modelFolders: ['checkpoints', 'vae'],
    }
    expect(getMediaResourceModelFolders(page)).toEqual(['checkpoints', 'vae'])
    expect(getMediaResourceModelFolders(null)).toEqual([])
  })

  test('Given 资源页来源不同 When 展示状态 Then 资源库显示实时查询，模型降级保留可用列表', () => {
    const { getMediaResourcePageStatus, getMediaResourceCapabilityMessage } = getExpectedModule()
    const page: MediaResourcePage = {
      connectionId: 'connection-1', snapshotId: 'snapshot-1', checkedAt: 1,
      total: 0, nextOffset: null, items: [], source: 'loader-schema', capability: 'unsupported',
    }
    expect(getMediaResourcePageStatus(page, 'assets')).toEqual({ sourceLabel: '远端资源', timeLabel: '查询时间' })
    expect(getMediaResourcePageStatus(page, 'models')).toEqual({ sourceLabel: '本地快照', timeLabel: '上次同步' })
    expect(getMediaResourceCapabilityMessage(page, 'models')).toContain('兼容模型列表')
    expect(getMediaResourceCapabilityMessage({ ...page, capability: 'disabled', source: 'models-api' }, 'models')).toContain('未启用')
  })

  test('Given 同步远端失败且旧快照可用 When 展示结果 Then 保留旧列表并单独报告错误', () => {
    const { retainMediaResourcePageAfterFailure } = getExpectedModule()
    const page: MediaResourcePage = {
      connectionId: 'connection-1', snapshotId: 'snapshot-1', checkedAt: 1,
      total: 1, nextOffset: null, items: [{ id: 'node-1', name: 'KSampler', category: 'sampling', supported: true }],
    }
    const result = retainMediaResourcePageAfterFailure(page, new Error('远端离线'))
    expect(result.page).toBe(page)
    expect(result.error).toBe('远端离线')
  })

  test('Given 媒体设置页 When 渲染 Then 展示三个平级页签且不展示预设页', () => {
    const { MediaSettingsTabsView } = getExpectedModule()
    const html = renderToStaticMarkup(<MediaSettingsTabsView activeTab="models" onTabChange={() => undefined} />)
    expect(html).toContain('媒体模型')
    expect(html).toContain('服务连接')
    expect(html).toContain('公共工作流')
    expect(html).not.toContain('媒体预设')
  })

  test('Given UI graph、无效 JSON 或超限文本 When 导入 Then 返回明确错误', () => {
    const { parseMediaWorkflowImportText } = getExpectedModule()
    expect(() => parseMediaWorkflowImportText('{"nodes":[],"links":[]}')).toThrow('不支持 ComfyUI UI 工作流')
    expect(() => parseMediaWorkflowImportText('{')).toThrow('JSON')
    expect(() => parseMediaWorkflowImportText(' '.repeat(2 * 1024 * 1024 + 1))).toThrow('2 MiB')
  })

  test('Given 用户显式预览远端素材 When 替换、失败或离开 Then 只读取目标并回收 Object URL', async () => {
    const { replaceMediaAssetPreview, releaseMediaAssetPreview } = getExpectedModule()
    const descriptor: MediaRemoteDescriptor = {
      connectionId: 'connection-1', instanceGeneration: 'generation-1', remoteUser: 'alice',
      source: 'assets-api', id: 'asset-1', assetId: 'asset-1',
    }
    /** 记录实际读取身份，证明预览不会扫描或下载整个资源页。 */
    const reads: string[] = []
    /** 记录 URL 生命周期。 */
    const revoked: string[] = []
    let created = 0
    const dependencies = {
      read: async (target: MediaRemoteDescriptor) => { reads.push(target.id); return { bytes: new Uint8Array([1, 2, 3]), contentType: 'image/png' } },
      createUrl: (_bytes: Uint8Array, contentType: string) => `blob:${contentType}:${++created}`,
      revokeUrl: (url: string) => { revoked.push(url) },
    }
    const first = await replaceMediaAssetPreview(null, descriptor, dependencies)
    expect(reads).toEqual(['asset-1'])
    expect(first).toEqual({ preview: { url: 'blob:image/png:1', contentType: 'image/png' }, error: null })

    const second = await replaceMediaAssetPreview(first.preview, descriptor, dependencies)
    expect(revoked).toEqual(['blob:image/png:1'])
    releaseMediaAssetPreview(second.preview, dependencies.revokeUrl)
    expect(revoked).toEqual(['blob:image/png:1', 'blob:image/png:2'])

    const failed = await replaceMediaAssetPreview(
      { url: 'blob:stale', contentType: 'image/png' },
      descriptor,
      { ...dependencies, read: async () => { throw new Error('远端素材不可用') } },
    )
    expect(revoked).toContain('blob:stale')
    expect(failed.preview).toBeNull()
    expect(failed.error).toContain('远端素材不可用')
  })

  test('Given 编辑连接 A 且目录还有连接 B When 展示资源区 Then 只绑定 A，新建草稿要求先保存', () => {
    const { resolveEditedMediaConnection } = getExpectedModule()
    const connections = [{ id: 'connection-a', name: 'A' }, { id: 'connection-b', name: 'B' }]
    expect(resolveEditedMediaConnection(connections, { id: 'connection-a' })).toEqual(connections[0])
    expect(resolveEditedMediaConnection(connections, null)).toBeUndefined()
  })
})
