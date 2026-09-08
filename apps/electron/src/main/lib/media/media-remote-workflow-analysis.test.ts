import { describe, expect, test } from 'bun:test'
import type { ComfyObjectInfo, MediaRemoteWorkflow } from '@proma/shared'
import { parseMediaWorkflowDefinition } from '@proma/shared'
import { compileComfyWorkflow, validateComfyWorkflow } from './comfyui-workflow'
import { analyzeRemoteWorkflow, getRemoteWorkflowClassTypes } from './media-remote-workflow-analysis'

/** 测试使用的远端工作流身份。 */
const descriptor: MediaRemoteWorkflow['descriptor'] = {
  connectionId: 'connection-1',
  instanceGeneration: 'generation-1',
  remoteUser: 'alice',
  source: 'user-data',
  id: 'workflow-1',
  workflowPath: 'workflows/example.json',
}

/** 覆盖 Loader、基础参数、采样器和输出节点的最小实时 schema。 */
const objectInfo: ComfyObjectInfo = {
  LoadImage: {
    input: { required: { image: ['STRING', { image_upload: true }] } },
    output: ['IMAGE', 'MASK'],
    output_name: ['IMAGE', 'MASK'],
  },
  ImageScale: {
    input: {
      required: {
        image: ['IMAGE'],
        upscale_method: [['nearest-exact', 'lanczos']],
        width: ['INT', { min: 1, max: 8192, step: 1 }],
        height: ['INT', { min: 1, max: 8192, step: 1 }],
        crop: [['disabled', 'center']],
      },
    },
    output: ['IMAGE'],
  },
  KSampler: {
    input: { required: { seed: ['INT', { min: 0, max: 999, step: 1, control_after_generate: true }] } },
    output: ['IMAGE'],
  },
  SaveImage: {
    input: { required: { images: ['IMAGE'], filename_prefix: ['STRING'] } },
    output: [],
    output_node: true,
  },
}

/** 构造只改变格式和正文的远端工作流。 */
function remote(format: MediaRemoteWorkflow['format'], definition: MediaRemoteWorkflow['definition']): MediaRemoteWorkflow {
  return { descriptor, format, definition }
}

describe('远端 ComfyUI 工作流分析', () => {
  test('Given PrimitiveFloat 把单控件值序列化为标量 When schema 能唯一证明该控件 Then 还原为单元素 widget 数组', () => {
    const schema: ComfyObjectInfo = { ...objectInfo,
      PrimitiveFloat: { input: { required: { value: ['FLOAT'] } }, output: ['FLOAT'] },
      FloatToImage: { input: { required: { value: ['FLOAT'] } }, output: ['IMAGE'] },
    }
    const result = analyzeRemoteWorkflow(remote('ui', { nodes: [
      { id: 132, type: 'PrimitiveFloat', inputs: [{ name: 'value', type: 'FLOAT', widget: { name: 'value' }, link: null }],
        outputs: [{ name: 'FLOAT', type: 'FLOAT', links: [10] }], widgets_values: 4 },
      { id: 2, type: 'FloatToImage', inputs: [{ name: 'value', type: 'FLOAT', link: 10 }],
        outputs: [{ name: 'IMAGE', type: 'IMAGE', links: [11] }], widgets_values: [] },
      { id: 3, type: 'SaveImage', inputs: [{ name: 'images', type: 'IMAGE', link: 11 }], outputs: [], widgets_values: ['Proma'] },
    ], links: [[10, 132, 0, 2, 0, 'FLOAT'], [11, 2, 0, 3, 0, 'IMAGE']] }), schema)
    expect(result.convertible).toBeTrue()
    expect(result.definition?.prompt['132']?.inputs.value).toBe(4)
  })

  test('Given 标量 widgets_values 对应多个或未知控件 When 分析 Then 保持不可转换', () => {
    const schema: ComfyObjectInfo = { ...objectInfo,
      PrimitivePair: { input: { required: { first: ['FLOAT'], second: ['FLOAT'] } }, output: ['FLOAT'] },
    }
    const result = analyzeRemoteWorkflow(remote('ui', {
      nodes: [{ id: 1, type: 'PrimitivePair', inputs: [], outputs: [], widgets_values: 4 }],
      links: [],
    }), schema)
    expect(result.convertible).toBeFalse()
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'UI_WIDGET_INVALID', nodeId: '1' }))
  })

  test('Given UI 连线源端未声明输出或未登记该边 When 分析 Then 拒绝矛盾的源端声明', () => {
    for (const outputs of [[], [{ name: 'IMAGE', type: 'IMAGE', links: [] }]]) {
      const result = analyzeRemoteWorkflow(remote('ui', { nodes: [
        { id: 1, type: 'LoadImage', outputs, widgets_values: ['private.png'] },
        { id: 2, type: 'SaveImage', inputs: [{ name: 'images', link: 10 }], widgets_values: ['Proma'] },
      ], links: [[10, 1, 0, 2, 0, 'IMAGE']] }), objectInfo)
      expect(result.convertible).toBeFalse()
      expect(result.issues).toContainEqual(expect.objectContaining({ code: 'UI_LINK_INVALID', nodeId: '1' }))
    }
  })

  test('Given 子图实例提供明确参数和边界 When 分析 Then 使用内部节点 schema 并将实例值写入可编译定义', () => {
    const schema: ComfyObjectInfo = { ...objectInfo,
      Resize: { input: { required: { image: ['IMAGE'], width: ['INT'], height: ['INT'] } }, output: ['IMAGE'] },
    }
    const workflow = remote('ui', {
      nodes: [
        { id: 1, type: 'LoadImage', inputs: [], outputs: [{ name: 'IMAGE', type: 'IMAGE', links: [10] }], widgets_values: ['private.png'] },
        { id: 100, type: 'subgraph-resize', inputs: [{ name: 'image', link: 10 }, { name: 'width', widget: { name: 'width' }, link: null }],
          outputs: [{ name: 'IMAGE', type: 'IMAGE', links: [11] }], widgets_values: [1024] },
        { id: 200, type: 'SaveImage', inputs: [{ name: 'images', link: 11 }], widgets_values: ['Proma'] },
      ], links: [[10, 1, 0, 100, 0, 'IMAGE'], [11, 100, 0, 200, 0, 'IMAGE']],
      definitions: { subgraphs: [{ id: 'subgraph-resize', inputNode: { id: -10 }, outputNode: { id: -20 },
        inputs: [{ id: 'image', name: 'image', type: 'IMAGE', linkIds: [101] }, { id: 'width', name: 'width', type: 'INT', linkIds: [102] }],
        outputs: [{ id: 'out', name: 'IMAGE', type: 'IMAGE', linkIds: [103] }],
        nodes: [{ id: 2, type: 'Resize', inputs: [{ name: 'image', link: 101 }, { name: 'width', widget: { name: 'width' }, link: 102 }],
          outputs: [{ name: 'IMAGE', type: 'IMAGE', links: [103] }], widgets_values: [640, 480] }],
        links: [[101, -10, 0, 2, 0, 'IMAGE'], [102, -10, 1, 2, 1, 'INT'], [103, 2, 0, -20, 0, 'IMAGE']],
      }] },
    })
    expect(getRemoteWorkflowClassTypes(workflow)).toEqual(['LoadImage', 'SaveImage', 'Resize'])
    const result = analyzeRemoteWorkflow(workflow, schema)
    expect(result.issues).toEqual([])
    expect(result.definition?.prompt['100::2']?.inputs).toEqual({ image: ['1', 0], width: 1024, height: 480 })
    expect(compileComfyWorkflow(result.definition!, {
      '1.image': { kind: 'image', upload: { name: 'uploaded.png', subfolder: '', type: 'input' } },
    }, schema).prompt['200']?.inputs.images).toEqual(['100::2', 0])
  })

  test('Given schema 属性顺序与 input_order 不同 When 还原 UI 控件 Then 使用显式顺序且宽高不会交换', () => {
    const schema: ComfyObjectInfo = { ...objectInfo,
      Dimensions: { input: { required: { height: ['INT'], width: ['INT'] } },
        input_order: { required: ['width', 'height'], optional: [], hidden: [] }, output: ['IMAGE'] },
    }
    const result = analyzeRemoteWorkflow(remote('ui', { nodes: [
      { id: 1, type: 'Dimensions', widgets_values: [1920, 1080] },
      { id: 2, type: 'SaveImage', inputs: [{ name: 'images', link: 1 }], widgets_values: ['Proma'] },
    ], links: [[1, 1, 0, 2, 0, 'IMAGE']] }), schema)
    expect(result.issues).toEqual([])
    expect(result.definition?.prompt['1']?.inputs).toEqual({ width: 1920, height: 1080 })
  })

  test('Given 上传按钮、备注和已连线控件 When 转换已安装处理节点 Then 仅保留执行输入且后续控件不移位', () => {
    /** 节点无需本地名单即可按已安装的基础输入合同校验。 */
    const schema: ComfyObjectInfo = { ...objectInfo,
      PrimitiveInt: { input: { required: { value: ['INT', { control_after_generate: 'fixed' }] } }, output: ['INT'] },
      InstalledResize: { input: { required: { image: ['IMAGE'], width: ['INT'], height: ['INT'] } }, output: ['IMAGE'] },
    }
    const result = analyzeRemoteWorkflow(remote('ui', {
      nodes: [
        { id: 1, type: 'LoadImage', inputs: [{ name: 'image', widget: { name: 'image' }, link: null },
          { name: 'upload', type: 'IMAGEUPLOAD', widget: { name: 'upload' }, link: null }], widgets_values: ['private.png', 'image'] },
        { id: 2, type: 'PrimitiveInt', inputs: [], widgets_values: [1024, 'fixed'] },
        { id: 3, type: 'InstalledResize', inputs: [{ name: 'image', link: 1 },
          { name: 'width', widget: { name: 'width' }, link: 2 }], widgets_values: [640, 480] },
        { id: 4, type: 'SaveImage', inputs: [{ name: 'images', link: 3 }], widgets_values: ['Proma'] },
        { id: 5, type: 'MarkdownNote', inputs: [], outputs: [], widgets_values: ['仅用于说明'] },
      ],
      links: [[1, 1, 0, 3, 0, 'IMAGE'], [2, 2, 0, 3, 1, 'INT'], [3, 3, 0, 4, 0, 'IMAGE']],
    }), schema)
    expect(result.issues).toEqual([])
    expect(result.definition?.prompt['3']?.inputs).toEqual({ image: ['1', 0], width: ['2', 0], height: 480 })
    expect(result.definition?.prompt['1']?.inputs).toEqual({ image: '' })
    expect(result.definition?.prompt['5']).toBeUndefined()
  })

  test('Given V3 动态分支包含已连线 widget When 转换 Then 保留分支顺序并校验联合类型', () => {
    /** 动态选择器后的控件仍按选定分支的深度优先顺序序列化。 */
    const schema: ComfyObjectInfo = { ...objectInfo,
      PrimitiveInt: { input: { required: { value: ['INT'] } }, output: ['INT'] },
      DynamicResize: { input: { required: { image: ['IMAGE'], mode: ['COMFY_DYNAMICCOMBO_V3', {
        options: [{ key: 'dimensions', inputs: { required: { width: ['INT'], height: ['INT'] } } }],
      }], rate: ['FLOAT,INT', { widgetType: 'FLOAT' }] } }, output: ['IMAGE'] },
    }
    const result = analyzeRemoteWorkflow(remote('ui', { nodes: [
      { id: 1, type: 'LoadImage', inputs: [], widgets_values: ['private.png'] },
      { id: 2, type: 'PrimitiveInt', inputs: [], widgets_values: [1024] },
      { id: 3, type: 'DynamicResize', inputs: [{ name: 'image', link: 1 },
        { name: 'mode.width', widget: { name: 'mode.width' }, link: 2 }], widgets_values: ['dimensions', 640, 480, 25] },
      { id: 4, type: 'SaveImage', inputs: [{ name: 'images', link: 3 }], widgets_values: ['Proma'] },
    ], links: [[1, 1, 0, 3, 0, 'IMAGE'], [2, 2, 0, 3, 1, 'INT'], [3, 3, 0, 4, 0, 'IMAGE']] }), schema)
    expect(result.issues).toEqual([])
    expect(result.definition?.prompt['3']?.inputs).toEqual({ image: ['1', 0], mode: 'dimensions',
      'mode.width': ['2', 0], 'mode.height': 480, rate: 25 })
    expect(compileComfyWorkflow(result.definition!, {
      '1.image': { kind: 'image', upload: { name: 'uploaded.png', subfolder: '', type: 'input' } },
      '3.mode.height': { kind: 'number', value: 720 },
      '3.rate': { kind: 'number', value: 24.5 },
    }, schema).prompt['3']?.inputs).toMatchObject({ 'mode.height': 720, rate: 24.5 })
  })

  test('Given 种子 schema 使用 uint64 上限 When 创建可编辑字段 Then 按客户端可精确表示的整数范围保存', () => {
    const schema: ComfyObjectInfo = { ...objectInfo,
      KSampler: { input: { required: { seed: ['INT', { min: 0, max: 2 ** 64, control_after_generate: true }] } }, output: ['IMAGE'] },
    }
    const result = analyzeRemoteWorkflow(remote('api', {
      '1': { class_type: 'KSampler', inputs: { seed: 42 } },
      '2': { class_type: 'SaveImage', inputs: { images: ['1', 0], filename_prefix: 'Proma' } },
    }), schema)
    expect(result.issues).toEqual([])
    expect(result.definition?.bindings[0]?.field?.max).toBe(Number.MAX_SAFE_INTEGER)
  })

  test('Given API 或 UI 图 When 提取节点类型 Then 有界去重且保持首次出现顺序', () => {
    expect(getRemoteWorkflowClassTypes(remote('api', {
      '1': { class_type: 'LoadImage', inputs: {} },
      '2': { class_type: 'LoadImage', inputs: {} },
      '3': { class_type: 'SaveImage', inputs: {} },
    }))).toEqual(['LoadImage', 'SaveImage'])
    expect(getRemoteWorkflowClassTypes(remote('ui', {
      nodes: [{ id: 1, type: 'KSampler' }, { id: 2, type: 'SaveImage' }],
      links: [],
    }))).toEqual(['KSampler', 'SaveImage'])
    expect(getRemoteWorkflowClassTypes(remote('unknown', { custom: true }))).toEqual([])
  })

  test('Given API 图含远端 Loader 常量和标量 When 分析 Then 清除资源常量并生成可保存定义', () => {
    const result = analyzeRemoteWorkflow(remote('api', {
      '1': { class_type: 'LoadImage', inputs: { image: 'private/source.png' }, _meta: { title: '首帧输入' } },
      '2': { class_type: 'ImageScale', inputs: { image: ['1', 0], upscale_method: 'lanczos', width: 1024, height: 768, crop: 'disabled' } },
      '3': { class_type: 'SaveImage', inputs: { images: ['2', 0], filename_prefix: '../unsafe' }, _meta: { title: '最终画面' } },
    }), objectInfo)

    expect(result.convertible).toBeTrue()
    expect(result.definition?.prompt['1']?.inputs).toEqual({ image: '' })
    expect(result.definition?.prompt['3']?.inputs.filename_prefix).toBe('Proma')
    expect(result.definition?.bindings).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: '1.image', kind: 'image', nodeId: '1', input: 'image', loader: 'LoadImage' }),
      expect.objectContaining({ key: '2.width', kind: 'number', field: expect.objectContaining({ controlType: 'width', required: false, min: 1, max: 8192 }) }),
      expect.objectContaining({ key: '2.height', kind: 'number', field: expect.objectContaining({ controlType: 'height', required: false }) }),
    ]))
    expect(result.definition?.bindings.some((binding) => binding.input === 'upscale_method')).toBeFalse()
    expect(result.outputs).toContainEqual(expect.objectContaining({ nodeId: '3', title: '最终画面', mediaType: 'image', historyKey: 'images' }))
    expect(result.nodes[0]).toEqual(expect.objectContaining({ nodeId: '1', title: '首帧输入', supported: true }))
    /** 返回给登记流程的定义必须再次通过公共持久化与执行合同。 */
    const parsed = parseMediaWorkflowDefinition(result.definition)
    expect(validateComfyWorkflow(parsed, objectInfo)).toEqual({ valid: true, issues: [], truncated: false })
    expect(parsed.bindings.every((binding) => binding.field !== undefined)).toBeTrue()
  })

  test('Given UI 图含真实节点位置和多条 links When 分析 Then 按槽位转为 API 图', () => {
    const result = analyzeRemoteWorkflow(remote('ui', {
      nodes: [
        { id: 1, type: 'LoadImage', title: '参考首帧', pos: [12, 34], inputs: [], outputs: [{ name: 'IMAGE', type: 'IMAGE', links: [10] }], widgets_values: ['private.png'] },
        { id: 2, type: 'ImageScale', title: '缩放尾帧', pos: [220, 34], inputs: [{ name: 'image', type: 'IMAGE', link: 10 }], outputs: [{ name: 'IMAGE', type: 'IMAGE', links: [11] }], widgets_values: ['lanczos', 640, 480, 'disabled'] },
        { id: 3, type: 'SaveImage', pos: [430, 34], inputs: [{ name: 'images', type: 'IMAGE', link: 11 }], outputs: [], widgets_values: ['movie/final'] },
      ],
      links: [[10, 1, 0, 2, 0, 'IMAGE'], [11, 2, 0, 3, 0, 'IMAGE']],
    }), objectInfo)

    expect(result.convertible).toBeTrue()
    expect(result.definition?.prompt['2']?.inputs.image).toEqual(['1', 0])
    expect(result.definition?.prompt['3']?.inputs.images).toEqual(['2', 0])
    expect(result.nodes[1]).toEqual(expect.objectContaining({ nodeId: '2', title: '缩放尾帧', position: { x: 220, y: 34 }, linkedInputCount: 1 }))
    expect(result.inputs).toContainEqual(expect.objectContaining({ nodeId: '2', input: 'image', linked: true, editable: false }))
  })

  test('Given seed 控件附带 control_after_generate When 转换 Then 忽略控制值且保留种子绑定', () => {
    const result = analyzeRemoteWorkflow(remote('ui', {
      nodes: [
        { id: 1, type: 'KSampler', inputs: [], outputs: [{ name: 'IMAGE', type: 'IMAGE', links: [1] }], widgets_values: [42, 'randomize'] },
        { id: 2, type: 'SaveImage', inputs: [{ name: 'images', type: 'IMAGE', link: 1 }], outputs: [], widgets_values: ['Proma'] },
      ],
      links: [[1, 1, 0, 2, 0, 'IMAGE']],
    }), objectInfo)

    expect(result.convertible).toBeTrue()
    expect(result.definition?.prompt['1']?.inputs.seed).toBe(42)
    expect(result.definition?.bindings).toContainEqual(expect.objectContaining({ key: '1.seed', field: expect.objectContaining({ controlType: 'seed' }) }))
    expect(result.issues.some((issue) => issue.code === 'UI_WIDGET_UNMAPPED')).toBeFalse()
  })

  test('Given 未知节点或额外 widget When 分析 Then 保留摘要但不伪称可执行', () => {
    const unknown = analyzeRemoteWorkflow(remote('ui', {
      nodes: [{
        id: 7, type: 'CustomMagic', title: '第三方补帧', pos: [1, 2],
        inputs: [{ name: 'source_frame', type: 'IMAGE', link: null }],
        outputs: [{ name: 'frames', type: 'IMAGE', links: null }],
        widgets_values: ['script'],
      }],
      links: [],
    }), { ...objectInfo, CustomMagic: { input: { required: {} }, output: [], unsupported: true } })
    expect(unknown.convertible).toBeFalse()
    expect(unknown.definition).toBeNull()
    expect(unknown.nodes).toContainEqual(expect.objectContaining({ nodeId: '7', title: '第三方补帧', outputTypes: ['IMAGE'], supported: false }))
    expect(unknown.inputs).toContainEqual(expect.objectContaining({ nodeId: '7', input: 'source_frame', valueKind: 'unknown', editable: false }))
    expect(unknown.issues).toContainEqual(expect.objectContaining({ code: 'NODE_INTERFACE_UNSUPPORTED', nodeId: '7' }))

    const extraWidget = analyzeRemoteWorkflow(remote('ui', {
      nodes: [{ id: 1, type: 'KSampler', inputs: [], outputs: [], widgets_values: [1, 'fixed', 'custom-widget'] }],
      links: [],
    }), objectInfo)
    expect(extraWidget.convertible).toBeFalse()
    expect(extraWidget.issues).toContainEqual(expect.objectContaining({ code: 'UI_WIDGET_UNMAPPED', nodeId: '1' }))
  })

  test('Given mute、bypass 或子图 UI 语义 When 分析 Then 明确阻止转换', () => {
    const muted = analyzeRemoteWorkflow(remote('ui', {
      nodes: [{ id: 1, type: 'KSampler', mode: 2, inputs: [], outputs: [], widgets_values: [1, 'fixed'] }],
      links: [],
    }), objectInfo)
    expect(muted.issues).toContainEqual(expect.objectContaining({ code: 'UI_NODE_MODE_UNSUPPORTED', nodeId: '1' }))
    expect(muted.convertible).toBeFalse()

    const subgraph = analyzeRemoteWorkflow(remote('ui', { nodes: [], links: [], definitions: { subgraphs: [{}] } }), objectInfo)
    expect(subgraph.issues).toContainEqual(expect.objectContaining({ code: 'UI_SUBGRAPH_DEFINITION_INVALID' }))
  })

  test('Given 非法引用或重复节点 ID When 分析 Then 返回有界结构问题而不是抛错', () => {
    const invalidLink = analyzeRemoteWorkflow(remote('ui', {
      nodes: [
        { id: 1, type: 'KSampler', inputs: [], outputs: [], widgets_values: [1, 'fixed'] },
        { id: 1, type: 'SaveImage', inputs: [{ name: 'images', type: 'IMAGE', link: 99 }], outputs: [], widgets_values: ['Proma'] },
      ],
      links: [[99, 404, 0, 1, 0, 'IMAGE']],
    }), objectInfo)
    expect(invalidLink.convertible).toBeFalse()
    expect(invalidLink.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'UI_NODE_ID_DUPLICATE', nodeId: '1' }),
      expect.objectContaining({ code: 'UI_LINK_INVALID' }),
    ]))

    const ambiguousInputs = analyzeRemoteWorkflow(remote('ui', {
      nodes: [
        { id: 1, type: 'KSampler', inputs: [], outputs: [{ name: 'IMAGE', type: 'IMAGE', links: [10] }], widgets_values: [1, 'fixed'] },
        { id: 2, type: 'SaveImage', inputs: [
          { name: 'mystery', type: 'IMAGE', link: 10 },
          { name: 'mystery', type: 'IMAGE', link: null },
        ], outputs: [], widgets_values: ['Proma'] },
      ],
      links: [[10, 1, 0, 2, 0, 'IMAGE']],
    }), objectInfo)
    expect(ambiguousInputs.convertible).toBeFalse()
    expect(ambiguousInputs.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'UI_INPUT_DUPLICATE', nodeId: '2', input: 'mystery' }),
      expect.objectContaining({ code: 'UI_INPUT_UNKNOWN', nodeId: '2', input: 'mystery' }),
    ]))

    const linkedWidgetPlaceholder = analyzeRemoteWorkflow(remote('ui', {
      nodes: [
        { id: 1, type: 'KSampler', inputs: [], outputs: [{ name: 'IMAGE', type: 'IMAGE', links: [10] }], widgets_values: [1, 'fixed'] },
        { id: 2, type: 'KSampler', inputs: [{ name: 'seed', type: 'INT', link: 10 }], outputs: [], widgets_values: [77, 'fixed'] },
      ],
      links: [[10, 1, 0, 2, 0, 'INT']],
    }), objectInfo)
    expect(linkedWidgetPlaceholder.convertible).toBeFalse()
    expect(linkedWidgetPlaceholder.issues).toContainEqual(expect.objectContaining({ code: 'UI_WIDGET_UNMAPPED', nodeId: '2' }))
  })

  test('Given API 图含已安装安全处理节点 When 分析 Then 沿用现有校验器且不额外收紧', () => {
    const schema: ComfyObjectInfo = {
      ...objectInfo,
      InstalledCustom: { input: { required: { image: ['IMAGE'], prompt: ['STRING'] } }, output: ['IMAGE'] },
    }
    const result = analyzeRemoteWorkflow(remote('api', {
      '1': { class_type: 'LoadImage', inputs: { image: 'private.png' }, _meta: { title: '首帧输入' } },
      '2': { class_type: 'InstalledCustom', inputs: { image: ['1', 0], prompt: '保留给 Agent 识别的提示词' }, _meta: { title: '风格化首帧' } },
      '3': { class_type: 'SaveImage', inputs: { images: ['2', 0], filename_prefix: 'Proma' } },
    }), schema)

    expect(result.convertible).toBeTrue()
    expect(result.definition?.prompt['2']?.inputs.prompt).toBe('保留给 Agent 识别的提示词')
    expect(result.inputs).toContainEqual(expect.objectContaining({ nodeId: '2', input: 'prompt', valueKind: 'string' }))
    expect(result.nodes).toContainEqual(expect.objectContaining({ nodeId: '2', title: '风格化首帧', outputTypes: ['IMAGE'], supported: true, coreContract: false }))
    expect(result.issues).toEqual([])
  })

  test('Given API 图含未知输出副作用节点 When 分析 Then 保留摘要并按现有校验阻止执行', () => {
    const schema: ComfyObjectInfo = {
      ...objectInfo,
      InstalledOutput: { input: { required: { prompt: ['STRING'] } }, output: [], output_node: true },
    }
    const result = analyzeRemoteWorkflow(remote('api', {
      '1': { class_type: 'InstalledOutput', inputs: { prompt: '不可自动执行' }, _meta: { title: '第三方发布节点' } },
    }), schema)

    expect(result.convertible).toBeFalse()
    expect(result.definition).toBeNull()
    expect(result.nodes).toContainEqual(expect.objectContaining({ nodeId: '1', title: '第三方发布节点', supported: true, coreContract: false }))
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'NODE_CLASS_UNSAFE', nodeId: '1' }))
  })

  test('Given 未知格式 When 分析 Then 返回问题与空摘要', () => {
    const result = analyzeRemoteWorkflow(remote('unknown', { custom: true }), objectInfo)
    expect(result).toEqual(expect.objectContaining({ format: 'unknown', convertible: false, definition: null, nodes: [], inputs: [], outputs: [] }))
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'REMOTE_WORKFLOW_FORMAT_UNSUPPORTED' }))
  })
})
