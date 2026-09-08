import { describe, expect, test } from 'bun:test'
import type { CanvasImageMediaWorkflow, MediaAssetRef, MediaWorkflowDefinition, MediaWorkflowVersion } from '@proma/shared'
import { createMediaImageCatalog } from './media-image-catalog'
import type { MediaConfigStore } from './media-config-store'

/** 创建只包含单图片输出的固定工作流，覆盖画布图片目录的作用域判断。 */
function workflow(projectId: string | null): MediaWorkflowVersion {
  /** 测试使用的最小可执行图片定义。 */
  const definition: MediaWorkflowDefinition = {
    schemaVersion: 1,
    prompt: { save: { class_type: 'SaveImage', inputs: {} } },
    bindings: [],
    outputs: [{ key: 'image', nodeId: 'save', outputIndex: 0, mediaType: 'image' }],
  }
  return {
    id: 'workflow-1', name: '项目图片草稿', projectId, revision: 3,
    hash: 'a'.repeat(64), definition, createdAt: 1,
  }
}

/** 构造画布已保存的完整工作流选择。 */
const selection: CanvasImageMediaWorkflow = {
  workflowId: 'workflow-1', workflowRevision: 3, connectionId: 'connection-1', inputs: {},
}

/** 构造图片目录依赖，并允许测试精确控制返回工作流的项目归属。 */
function catalog(workflowProjectId: string | null) {
  /** 仅实现当前测试会调用的媒体配置读取面。 */
  const configuration = {
    getWorkflow: () => workflow(workflowProjectId),
    resolveConnection: () => ({ connection: { id: 'connection-1', instanceGeneration: 'generation-1' }, headers: {} }),
    resolveConnectionVersion: () => ({ connection: { id: 'connection-1', instanceGeneration: 'generation-1' }, headers: {} }),
  } as unknown as MediaConfigStore
  return createMediaImageCatalog(configuration)
}

/** 构造含必填图片和受范围约束数值的图片工作流。 */
function boundWorkflow(): MediaWorkflowVersion {
  const definition: MediaWorkflowDefinition = {
    schemaVersion: 1,
    prompt: {
      load: { class_type: 'LoadImage', inputs: { image: '' } },
      scale: { class_type: 'ImageScale', inputs: { width: 8 } },
      save: { class_type: 'SaveImage', inputs: {} },
    },
    bindings: [
      { key: 'load.image', kind: 'image', loader: 'LoadImage', nodeId: 'load', input: 'image', field: {
        classType: 'LoadImage', valueKind: 'string', label: '图片', controlType: 'image', required: true,
      } },
      { key: 'scale.width', kind: 'number', nodeId: 'scale', input: 'width', field: {
        classType: 'ImageScale', valueKind: 'number', label: '宽度', controlType: 'width', required: true, min: 8, max: 32, step: 8,
      } },
    ],
    outputs: [{ key: 'image', nodeId: 'save', outputIndex: 0, mediaType: 'image' }],
  }
  return { id: 'workflow-1', name: '图片草稿', projectId: 'project-1', revision: 3, hash: 'a'.repeat(64), definition, createdAt: 1 }
}

/** 使用绑定工作流构造目录，专门验证快照前的本地输入合同。 */
function boundCatalog(selected = boundWorkflow()) {
  const configuration = {
    getWorkflow: () => selected,
    resolveConnection: () => ({ connection: { id: 'connection-1', instanceGeneration: 'generation-1' }, headers: {} }),
    resolveConnectionVersion: () => ({ connection: { id: 'connection-1', instanceGeneration: 'generation-1' }, headers: {} }),
  } as unknown as MediaConfigStore
  return createMediaImageCatalog(configuration)
}

/** 返回固定项目资产，不触发素材读取或远端上传。 */
function imageAsset(): MediaAssetRef {
  return { assetId: 'asset-1', revision: 1, hash: 'b'.repeat(64), mediaKind: 'image' }
}

describe('media image catalog', () => {
  test('Given 当前项目不可变工作流草稿 When 创建并复核图片快照 Then 无需发布为公共工作流', () => {
    /** 当前项目草稿生成的固定快照。 */
    const snapshot = catalog('project-1').resolveAvailableWorkflowSnapshot('project-1', selection)
    expect(snapshot).toMatchObject({
      source: 'workflow', workflowId: 'workflow-1', workflowRevision: 3,
      workflowHash: 'a'.repeat(64), connectionId: 'connection-1', instanceGeneration: 'generation-1',
    })
    expect(() => catalog('project-1').assertSnapshotAvailable('project-1', snapshot)).not.toThrow()
  })

  test('Given 其他项目工作流草稿 When 图片节点尝试使用 Then 保持项目隔离', () => {
    expect(() => catalog('project-2').resolveAvailableWorkflowSnapshot('project-1', selection))
      .toThrow('MEDIA_IMAGE_WORKFLOW_MUST_BE_PUBLIC')
  })

  test('Given 图片工作流缺少必填素材 When 创建快照 Then 在创建 Job 前抛出可信中文错误', () => {
    const incomplete = { ...selection, inputs: { 'scale.width': { kind: 'scalar' as const, value: 8 } } }
    expect(() => boundCatalog().resolveAvailableWorkflowSnapshot('project-1', incomplete))
      .toThrow('MEDIA_WORKFLOW_INVALID:INPUT_REQUIRED@load.image:缺少必填输入')
  })

  test('Given 输入完整且符合字段合同 When 创建快照 Then 保留固定输入', () => {
    const inputs = {
      'load.image': { kind: 'asset' as const, asset: imageAsset() },
      'scale.width': { kind: 'scalar' as const, value: 16 },
    }
    const snapshot = boundCatalog().resolveAvailableWorkflowSnapshot('project-1', { ...selection, inputs })
    expect(snapshot.inputs).toEqual(inputs)
  })

  test('Given 未知输入或非法字段值 When 创建快照 Then 返回对应的可信定位错误', () => {
    const validInputs = {
      'load.image': { kind: 'asset' as const, asset: imageAsset() },
      'scale.width': { kind: 'scalar' as const, value: 16 },
    }
    expect(() => boundCatalog().resolveAvailableWorkflowSnapshot('project-1', {
      ...selection, inputs: { ...validInputs, ignored: { kind: 'scalar', value: true } },
    })).toThrow('MEDIA_WORKFLOW_INVALID:INPUT_UNKNOWN:输入不在节点接口中')
    expect(() => boundCatalog().resolveAvailableWorkflowSnapshot('project-1', {
      ...selection, inputs: { ...validInputs, 'scale.width': { kind: 'scalar', value: 14 } },
    })).toThrow('MEDIA_WORKFLOW_INVALID:INPUT_RANGE_INVALID@scale.width:数值超出服务器允许范围')
  })

  test('Given 可选数值缺省但工作流默认值违反步长 When 创建快照 Then 在 Job 前明确阻断', () => {
    /** 省略可选项仍会使用固定图的默认值，因此也必须校验默认值。 */
    const selected = boundWorkflow()
    selected.definition.bindings[1]!.field!.required = false
    selected.definition.prompt.scale!.inputs.width = 14
    const inputs = { 'load.image': { kind: 'asset' as const, asset: imageAsset() } }
    expect(() => boundCatalog(selected).resolveAvailableWorkflowSnapshot('project-1', { ...selection, inputs }))
      .toThrow('MEDIA_WORKFLOW_INVALID:INPUT_RANGE_INVALID@scale.width')
    selected.definition.prompt.scale!.inputs.width = 16
    expect(() => boundCatalog(selected).resolveAvailableWorkflowSnapshot('project-1', { ...selection, inputs })).not.toThrow()
  })

  test('Given 必填文本为空或类型错误 When 创建图片快照 Then 返回必填或类型错误而非数值越界', () => {
    /** 最小文本工作流隔离字段错误码映射，避免被其它缺失输入提前短路。 */
    const selected = workflow(null)
    selected.definition.prompt.text = { class_type: 'TextNode', inputs: { text: '默认提示词' } }
    selected.definition.bindings = [{
      key: 'prompt', kind: 'text', nodeId: 'text', input: 'text',
      field: { classType: 'TextNode', valueKind: 'string', label: '提示词', controlType: 'text', required: true },
    }]
    for (const value of ['', ' \n\t ']) {
      expect(() => boundCatalog(selected).resolveAvailableWorkflowSnapshot('project-1', {
        ...selection, inputs: { prompt: { kind: 'scalar', value } },
      })).toThrow('MEDIA_WORKFLOW_INVALID:INPUT_REQUIRED@text.text:缺少必填输入')
    }
    expect(() => boundCatalog(selected).resolveAvailableWorkflowSnapshot('project-1', {
      ...selection, inputs: { prompt: { kind: 'scalar', value: 42 } },
    })).toThrow('MEDIA_WORKFLOW_INVALID:INPUT_TYPE_INVALID@text.text')
  })
})
