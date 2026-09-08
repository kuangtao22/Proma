import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { ComfyObjectInfo, JsonObject, MediaAssetRef, MediaRemoteDescriptor, MediaRunSnapshot } from '@proma/shared'
import type { CanvasToolRunContext } from '../design/canvas-tool-provider'
import { createCanvasMediaWorkflowDraft } from '../../../renderer/components/design/CanvasMediaWorkbench'
import { MediaConfigStore } from './media-config-store'
import { MediaResourceService } from './media-resource-service'
import { MediaRunService } from './media-run-service'
import { createMediaToolRun, type MediaToolProviderDependencies } from './media-tool-provider'

/** 每个集成用例使用独立配置、快照和运行目录。 */
const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

/** 真实 UI 工作流对应的 ComfyUI 节点 schema。 */
const objectInfo: ComfyObjectInfo = {
  LoadImage: {
    input: { required: { image: [['existing.png'], { image_upload: true }] } },
    output: ['IMAGE', 'MASK'],
    output_name: ['IMAGE', 'MASK'],
  },
  ImageScale: {
    input: { required: {
      image: ['IMAGE'],
      upscale_method: [['nearest-exact', 'lanczos']],
      width: ['INT', { min: 1, max: 8192, step: 1 }],
      height: ['INT', { min: 1, max: 8192, step: 1 }],
      crop: [['disabled', 'center']],
    } },
    output: ['IMAGE'],
  },
  SaveImage: {
    input: { required: { images: ['IMAGE'], filename_prefix: ['STRING'] } },
    output: [],
    output_node: true,
  },
}

/** 从真实结构的 UI 图覆盖 Loader、处理节点和输出节点转换。 */
const remoteUiWorkflow: JsonObject = {
  nodes: [
    { id: 1, type: 'LoadImage', title: '参考图', pos: [10, 20], inputs: [],
      outputs: [{ name: 'IMAGE', type: 'IMAGE', links: [10] }], widgets_values: ['private/source.png'] },
    { id: 2, type: 'ImageScale', title: '缩放', pos: [220, 20],
      inputs: [{ name: 'image', type: 'IMAGE', link: 10 }],
      outputs: [{ name: 'IMAGE', type: 'IMAGE', links: [11] }],
      widgets_values: ['lanczos', 1024, 768, 'disabled'] },
    { id: 3, type: 'SaveImage', title: '成片', pos: [430, 20],
      inputs: [{ name: 'images', type: 'IMAGE', link: 11 }], outputs: [], widgets_values: ['remote/private'] },
  ],
  links: [[10, 1, 0, 2, 0, 'IMAGE'], [11, 2, 0, 3, 0, 'IMAGE']],
}

/** 模拟 Pi runtime 调用工具，并保留稳定 toolCallId 参与 operation 身份。 */
async function executeTool(
  tools: ToolDefinition[],
  name: string,
  input: Record<string, unknown>,
  toolCallId: string,
) {
  /** 当前调用对应的工具定义。 */
  const tool = tools.find((candidate) => candidate.name === name)
  if (!tool) throw new Error(`工具不存在: ${name}`)
  return tool.execute(toolCallId, input as never, undefined as never, undefined as never, undefined as never)
}

describe('远端工作流发现、导入与准备集成', () => {
  test('Given 画布绑定连接和真实 UI 工作流 When 发现并导入 Then 画布必须经卡片准备且独立任务仍可固定资产与实例', async () => {
    /** 隔离的真实 MediaConfigStore 数据根。 */
    const root = mkdtempSync(join(tmpdir(), 'proma-remote-workflow-integration-'))
    temporaryDirectories.push(root)
    /** 真实配置服务保存全局连接和后续项目草稿。 */
    const configuration = new MediaConfigStore(root)
    configuration.saveConnection({
      id: 'gpu', name: '画布 GPU', driver: 'comfyui', baseUrl: 'http://127.0.0.1:8188',
      enabled: true, auth: { kind: 'none' },
    }, 0)
    /** 保存后固定的新任务连接代次。 */
    const instanceGeneration = configuration.read().connections[0]!.instanceGeneration

    /** 记录远端目录、正文、schema、上传和提交调用次数。 */
    const calls = { directories: 0, goodBodies: 0, badBodies: 0, schemas: 0, uploads: 0, submits: 0 }
    /** 发现服务使用的内存 ComfyUI 客户端。 */
    const resourceClient = {
      objectInfo: async () => { calls.schemas += 1; return objectInfo },
      listModelFolders: async () => [],
      listModels: async () => [],
      listUserWorkflows: async () => {
        calls.directories += 1
        return [
          { path: 'good.json', size: 1024, modified: 20, created: 10 },
          { path: 'broken.json', size: 12, modified: 20, created: 10 },
        ]
      },
      readUserWorkflow: async (path: string) => {
        if (path === 'broken.json') {
          calls.badBodies += 1
          throw new Error('单文件损坏')
        }
        calls.goodBodies += 1
        return structuredClone(remoteUiWorkflow)
      },
    }
    /** 真实资源服务负责快照复用、描述符校验和 UI 图读取。 */
    const resources = new MediaResourceService({
      resolveConnection: (connectionId, projectId) => configuration.resolveConnection(connectionId, projectId),
      createClient: () => resourceClient,
    })

    /** 本地真实 PNG 签名字节及其不可变素材引用。 */
    const assetBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
    /** prepare 阶段必须读取并复核的当前项目资产。 */
    const asset: MediaAssetRef = {
      assetId: 'asset-1', revision: 1,
      hash: createHash('sha256').update(assetBytes).digest('hex'), mediaKind: 'image',
    }
    /** prepare 使用的 ComfyUI 客户端；上传和提交均是越界探针。 */
    const runClient = {
      objectInfo: async () => objectInfo,
      uploadImage: async () => { calls.uploads += 1; throw new Error('prepare 不应上传') },
      submitPrompt: async () => { calls.submits += 1; throw new Error('prepare 不应提交') },
      getQueue: async () => null,
      getHistory: async () => null,
      getOutput: async () => ({ bytes: new Uint8Array(), contentType: null }),
      cancelPrompt: async () => undefined,
    }
    /** 真实运行服务执行 prepareDraft 的持久化和静态校验。 */
    const runs = new MediaRunService({
      configuration,
      getRunsDirectory: (projectId) => join(root, 'runs', projectId),
      authorize: () => undefined,
      readAsset: async (projectId, reference) => {
        expect(projectId).toBe('project-1')
        expect(reference).toEqual(asset)
        return assetBytes
      },
      registerOutput: async () => asset,
      createClient: () => runClient,
    })

    /** 普通 Agent 的可信项目上下文，画布 ID 由每个工具参数显式指定。 */
    const context: CanvasToolRunContext = {
      projectId: 'project-1', sessionId: 'session-1', runStartedAt: 42,
      explicitReferences: [], permissionCeiling: 'execute',
    }
    /** 工具依赖保留真实配置、资源和运行服务，只模拟未触发的监督器边界。 */
    const dependencies: MediaToolProviderDependencies = {
      configuration,
      resources,
      runs,
      supervisor: {
        start: () => { throw new Error('不应执行') },
        watch: () => undefined,
        wait: async () => { throw new Error('不应等待') },
      },
      authorize: () => undefined,
      listAssets: async () => [],
      registerRemoteAsset: async () => asset,
      listModels: async () => [],
      getCanvasConnection: (_runContext, canvasId) => canvasId === 'canvas-1' ? 'gpu' : null,
    }
    /** 当前轮媒体工具集合。 */
    const toolRun = createMediaToolRun(dependencies, context)

    /** 首次发现省略 connectionId，仅依赖可信画布绑定。 */
    const firstDiscovery = await executeTool(toolRun.piCustomTools, 'media_discover_workflows', {
      canvasId: 'canvas-1', mediaKind: 'image', inputKinds: ['image'], limit: 6,
    }, 'discover-1')
    /** 发现结果同时保留可导入项与单文件失败项。 */
    const firstItems = (firstDiscovery.details as { items: Array<{
      name: string
      canImport: boolean
      contentHash?: string
      descriptor?: MediaRemoteDescriptor
      issues: Array<{ code: string }>
    }> }).items
    /** 唯一可导入的真实 UI 工作流候选。 */
    const candidate = firstItems.find((item) => item.name === 'good.json')!
    expect(firstDiscovery.details).toMatchObject({ connectionId: 'gpu', instanceGeneration })
    expect(candidate).toMatchObject({ canImport: true, descriptor: { workflowPath: 'good.json' } })
    expect(firstItems.find((item) => item.name === 'broken.json')).toMatchObject({
      canImport: false, issues: [{ code: 'REMOTE_WORKFLOW_READ_FAILED' }],
    })

    /** 第二次发现应复用目录、schema 和合法正文快照。 */
    const secondDiscovery = await executeTool(toolRun.piCustomTools, 'media_discover_workflows', {
      canvasId: 'canvas-1', mediaKind: 'image', inputKinds: ['image'], limit: 6,
    }, 'discover-2')
    expect((secondDiscovery.details as { items: unknown[] }).items).toHaveLength(2)
    expect(calls).toMatchObject({ directories: 1, goodBodies: 1, schemas: 1, uploads: 0, submits: 0 })

    /** 导入使用发现时的完整 descriptor 与内容 hash。 */
    const imported = await executeTool(toolRun.piCustomTools, 'media_import_remote_workflow', {
      descriptor: candidate.descriptor,
      expectedContentHash: candidate.contentHash,
      id: 'remote-image-draft', name: '远端图片草稿',
      expectedConfigRevision: 1, expectedWorkflowRevision: 0,
    }, 'import-1')
    expect(imported.details).toMatchObject({
      imported: true, id: 'remote-image-draft', revision: 1, projectId: 'project-1', connectionId: 'gpu',
    })

    /** 真实配置中刚导入的当前项目不可变工作流。 */
    const savedWorkflow = configuration.getWorkflow('remote-image-draft', 1, 'project-1')
    /** Renderer 画布草稿转换结果，证明每个分析绑定都带可消费字段合同。 */
    const canvasDrafts = createCanvasMediaWorkflowDraft(savedWorkflow, {
      '1.image': { kind: 'asset', asset },
    })
    expect(canvasDrafts).toHaveLength(savedWorkflow.definition.bindings.length)
    expect(savedWorkflow.definition.bindings.every((binding) => binding.field !== undefined)).toBeTrue()
    expect(canvasDrafts.find((draft) => draft.key === '1.image')).toMatchObject({
      kind: 'image', controlType: 'image', asset,
    })

    /** 面向画布的本轮不能跳过节点配置直接创建独立运行。 */
    await expect(executeTool(toolRun.piCustomTools, 'media_prepare_run', {
      canvasId: 'canvas-1', workflowId: 'remote-image-draft', workflowRevision: 1,
      mediaKind: 'image', inputs: { '1.image': { kind: 'asset', asset } },
    }, 'prepare-canvas')).rejects.toThrow('MEDIA_CANVAS_TARGET_USE_CANVAS_TOOLS')
    /** 独立会话没有 Canvas 目标，仍可显式使用固定连接准备同一项目工作流。 */
    const standalone = createMediaToolRun(dependencies, { ...context, sessionId: 'standalone-session' })
    const prepared = await executeTool(standalone.piCustomTools, 'media_prepare_run', {
      connectionId: 'gpu', workflowId: 'remote-image-draft', workflowRevision: 1,
      mediaKind: 'image', inputs: { '1.image': { kind: 'asset', asset } },
    }, 'prepare-standalone')
    /** 真实 prepareDraft 返回的持久运行快照。 */
    const snapshot = prepared.details as MediaRunSnapshot
    expect(snapshot).toMatchObject({
      projectId: 'project-1', phase: 'prepared',
      sourceRef: {
        kind: 'project-draft-revision', workflowId: 'remote-image-draft', workflowRevision: 1,
        connectionId: 'gpu', mediaKind: 'image',
      },
    })
    expect(snapshot.revision).toBeGreaterThan(0)
    /** 真实运行服务写入的内部 manifest，用于验证公开快照未暴露的冻结事实。 */
    const manifest = JSON.parse(readFileSync(join(root, 'runs', 'project-1', `${snapshot.id}.json`), 'utf8')) as {
      instanceGeneration: string
      inputs: Record<string, unknown>
    }
    expect(manifest.instanceGeneration).toBe(instanceGeneration)
    expect(manifest.inputs).toMatchObject({ '1.image': { kind: 'asset', asset } })
    expect(calls.uploads).toBe(0)
    expect(calls.submits).toBe(0)
  })
})
