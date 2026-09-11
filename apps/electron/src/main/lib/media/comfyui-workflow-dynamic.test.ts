import { describe, expect, test } from 'bun:test'
import type { ComfyObjectInfo, JsonObject, MediaWorkflowDefinition } from '@proma/shared'
import { compileComfyWorkflow, expandComfyNodeInputs, validateComfyWorkflow } from './comfyui-workflow'

/** 官方 SaveVideo 的 codec 动态分支；普通 crf 字段仍必须随所选分支校验。 */
const codec: [string, JsonObject] = ['COMFY_DYNAMICCOMBO_V3', { options: [
  { key: 'auto', inputs: { required: {} } },
  { key: 'h264', inputs: { required: {
    encoding: ['COMFY_DYNAMICCOMBO_V3', { options: [
      { key: 'passthrough', inputs: { required: {} } },
      { key: 're-encode', inputs: { required: { crf: ['INT', { min: 0, max: 51 }] } } },
    ] }],
  } } },
] }]

/** 当前官方接口同时保留隐藏控件的旧顶层 codec；它不是内部 hidden 注入参数。 */
const objectInfo: ComfyObjectInfo = {
  VideoSource: { input: { required: {} }, output: ['VIDEO'] },
  SaveVideo: { input: {
    required: { video: ['VIDEO'], filename_prefix: ['STRING'], format: ['COMFY_DYNAMICCOMBO_V3', {
      options: [{ key: 'mp4', inputs: { required: { codec } } }],
    }] },
    optional: { codec: [codec[0], { ...codec[1], hidden: true }] },
  }, output: [], output_node: true },
}

/** 根据保存字段构造最小视频图，返回值可直接走预检和出站编译。 */
function definition(inputs: JsonObject): MediaWorkflowDefinition {
  return { schemaVersion: 1, prompt: {
    source: { class_type: 'VideoSource', inputs: {} },
    save: { class_type: 'SaveVideo', inputs: { video: ['source', 0], filename_prefix: 'video/Proma', ...inputs } },
  }, bindings: [], outputs: [{ key: 'video', nodeId: 'save', outputIndex: 0, mediaType: 'video' }] }
}

describe('ComfyUI V3 动态选择器兼容', () => {
  /** 旧参数、缺省参数和当前参数均由官方服务接受。 */
  const compatibleInputs: JsonObject[] = [{ format: 'mp4', codec: 'auto' }, { format: 'mp4' }, { format: 'mp4', 'format.codec': 'auto' }]
  for (const inputs of compatibleInputs) {
    test(`Given 官方允许的保存字段 ${JSON.stringify(inputs)} When 校验并编译 Then 原样保留且不强制未激活动态字段`, () => {
      /** 工作流和原副本用于验证不发生隐式迁移。 */
      const workflow = definition(inputs)
      const original = structuredClone(workflow)
      expect(validateComfyWorkflow(workflow, objectInfo)).toEqual({ valid: true, issues: [], truncated: false })
      expect(compileComfyWorkflow(workflow, {}, objectInfo).prompt).toEqual(workflow.prompt)
      expect(workflow).toEqual(original)
    })
  }

  test('Given 已选中嵌套编码分支 When 普通必填参数缺失或超范围 Then 仍精确拒绝', () => {
    /** 普通 crf 与动态选择器不同，分支一旦激活就必须存在。 */
    const workflow = definition({ format: 'mp4', 'format.codec': 'h264', 'format.codec.encoding': 're-encode' })
    expect(validateComfyWorkflow(workflow, objectInfo).issues).toContainEqual(expect.objectContaining({
      code: 'INPUT_REQUIRED', input: 'format.codec.encoding.crf',
    }))
    workflow.prompt.save!.inputs['format.codec.encoding.crf'] = 99
    expect(validateComfyWorkflow(workflow, objectInfo).issues).toContainEqual(expect.objectContaining({
      code: 'INPUT_RANGE_INVALID', input: 'format.codec.encoding.crf',
    }))
    workflow.prompt.save!.inputs['format.codec.encoding.crf'] = 23
    expect(validateComfyWorkflow(workflow, objectInfo).valid).toBe(true)
  })

  test('Given 顶层必填动态选择器缺失 When 校验 Then 保持入口参数完整性', () => {
    // 服务端仅跳过预检不代表 execute 有缺省实参；SaveVideo 仍要求顶层 format。
    expect(validateComfyWorkflow(definition({ codec: 'auto' }), objectInfo).issues).toContainEqual(expect.objectContaining({
      code: 'INPUT_REQUIRED', input: 'format',
    }))
  })

  test('Given 错误分支或悬空子字段 When 校验 Then 不因兼容旧模板而接受无效输入', () => {
    /** 未声明的选择值与没有父选择器的子参数仍属非法输入。 */
    const invalidInputs: JsonObject[] = [
      { format: 'unknown' }, { format: 'mp4', codec: 'unknown' },
      { format: 'mp4', 'format.codec': 'unknown' },
      { format: 'mp4', 'format.codec.encoding': 're-encode' },
      { format: 'mp4', 'format.codec': 'auto', 'format.codec.encoding.crf': 23 },
    ]
    for (const inputs of invalidInputs) {
      expect(validateComfyWorkflow(definition(inputs), objectInfo).valid).toBe(false)
    }
  })

  test('Given 控件尚未读入动态值 When UI 导入查询声明顺序 Then 仍保留动态控件的位置与必填声明', () => {
    /** UI 使用声明顺序迭代读取 widgets_values，不能随执行期 required 集合一起删除控件。 */
    const declarations = expandComfyNodeInputs(objectInfo.SaveVideo!, { format: 'mp4' }).ordered
    expect(declarations.map(({ name, required }) => ({ name, required }))).toEqual([
      { name: 'video', required: true }, { name: 'filename_prefix', required: true },
      { name: 'format', required: true }, { name: 'format.codec', required: true }, { name: 'codec', required: false },
    ])
  })
})
