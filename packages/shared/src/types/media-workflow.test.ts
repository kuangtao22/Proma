import { describe, expect, test } from 'bun:test'
import {
  COMFY_OBJECT_INFO_MAX_CLASSES,
  parseComfyObjectCatalog,
  parseComfyObjectInfo,
  parseComfyPrompt,
  parseMediaWorkflowDefinition,
} from './media-workflow'

test('Given V3 输出类型模板 When 解析并重读 object_info Then 保留精确模板且拒绝长度不一致', () => {
  /** 输出必须携带对应输入模板身份，不能从显示类型猜测。 */
  const raw = { Resize: { input: { required: { image: ['COMFY_MATCHTYPE_V3', {
    template: { template_id: 'media', allowed_types: 'IMAGE,MASK' },
  }] } }, output: ['COMFY_MATCHTYPE_V3', 'INT'], output_matchtypes: ['media', null] } }
  const parsed = parseComfyObjectInfo(raw)
  expect(parsed.Resize?.output_matchtypes).toEqual(['media', null])
  expect(parseComfyObjectInfo(parsed)).toEqual(parsed)
  expect(() => parseComfyObjectInfo({ Resize: { ...raw.Resize, output_matchtypes: ['media'] } }))
    .toThrow('COMFY_OBJECT_INFO_INVALID')
})

test('Given 官方输入序列元数据 When 解析并重读 object_info Then 保持顺序且拒绝重复或未知结构', () => {
  const raw = {
    WidgetNode: {
      input: { required: { prompt: ['STRING'] }, optional: { enabled: ['BOOLEAN'] } },
      output: ['IMAGE'],
      input_order: { required: ['prompt'], optional: ['enabled'] },
    },
  }
  const parsed = parseComfyObjectInfo(raw)
  expect(parsed.WidgetNode?.input_order).toEqual({ required: ['prompt'], optional: ['enabled'], hidden: [] })
  expect(parseComfyObjectInfo(parsed)).toEqual(parsed)
  expect(() => parseComfyObjectInfo({ WidgetNode: { ...raw.WidgetNode, input_order: { required: ['prompt', 'prompt'], optional: [] } } }))
    .toThrow('COMFY_OBJECT_INFO_INVALID')
  expect(() => parseComfyObjectInfo({ WidgetNode: { ...raw.WidgetNode, input_order: { required: ['missing'], optional: [] } } }))
    .toThrow('COMFY_OBJECT_INFO_INVALID')
})

test('Given 真实 V3 节点的空输出模板和隐藏输入顺序 When 解析 Then 不误标为不兼容', () => {
  const parsed = parseComfyObjectInfo({
    PrimitiveInt: { input: { required: { value: ['INT'] } }, output: ['INT'], output_matchtypes: null,
      input_order: { required: ['value'] } },
    SaveVideo: { input: { required: { video: ['VIDEO'] }, hidden: { prompt: 'PROMPT' } }, output: ['VIDEO'],
      output_matchtypes: null, input_order: { required: ['video'], hidden: ['prompt'] } },
  })
  expect(parsed.PrimitiveInt?.input_order).toEqual({ required: ['value'], optional: [], hidden: [] })
  expect(parsed.SaveVideo?.input_order?.hidden).toEqual(['prompt'])
  expect(parsed.PrimitiveInt?.output_matchtypes).toBeUndefined()
  expect(parseComfyObjectInfo(parsed)).toEqual(parsed)
})

describe('ComfyUI shared protocol parsers', () => {
  test('Given 节点目录达到统一容量边界 When 目录与严格解析 Then 接受边界并对超限返回专用错误', () => {
    /** 构造真实 object_info 的最小节点形状，隔离验证目录条目容量合同。 */
    const createObjectInfo = (count: number) => Object.fromEntries(
      Array.from({ length: count }, (_, index) => [`Node-${index}`, {
        input: { required: { image: ['IMAGE'] } },
        output: ['IMAGE'],
        output_name: ['IMAGE'],
        category: 'image/process',
      }]),
    )
    const boundary = createObjectInfo(COMFY_OBJECT_INFO_MAX_CLASSES)

    expect(Object.keys(parseComfyObjectCatalog(boundary))).toHaveLength(COMFY_OBJECT_INFO_MAX_CLASSES)
    expect(Object.keys(parseComfyObjectInfo(boundary))).toHaveLength(COMFY_OBJECT_INFO_MAX_CLASSES)

    const oversized = createObjectInfo(COMFY_OBJECT_INFO_MAX_CLASSES + 1)
    expect(() => parseComfyObjectCatalog(oversized)).toThrow('COMFY_OBJECT_INFO_SIZE_LIMIT')
    expect(() => parseComfyObjectInfo(oversized)).toThrow('COMFY_OBJECT_INFO_SIZE_LIMIT')
  })

  test('Given 合法 API 图 When 解析 Then 保留节点链接与元数据', () => {
    expect(parseComfyPrompt({
      '3': { class_type: 'KSampler', inputs: { seed: 1, model: ['4', 0] }, _meta: { title: '采样器' } },
      '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'model.safetensors' } },
    })).toEqual({
      '3': { class_type: 'KSampler', inputs: { seed: 1, model: ['4', 0] }, _meta: { title: '采样器' } },
      '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'model.safetensors' } },
    })
  })

  test('Given UI 工作流或超量图 When 解析 Then 在本地拒绝', () => {
    expect(() => parseComfyPrompt({ nodes: [], links: [] })).toThrow('COMFY_PROMPT_INVALID')
    const oversized = Object.fromEntries(Array.from({ length: 513 }, (_, index) => [String(index), {
      class_type: 'Node', inputs: {},
    }]))
    expect(() => parseComfyPrompt(oversized)).toThrow('COMFY_PROMPT_LIMIT_EXCEEDED')

    const oversizedInputs = Object.fromEntries(Array.from({ length: 17 }, (_, nodeIndex) => [String(nodeIndex), {
      class_type: 'Node',
      inputs: Object.fromEntries(Array.from({ length: 121 }, (_, inputIndex) => [`input-${inputIndex}`, inputIndex])),
    }]))
    expect(() => parseComfyPrompt(oversizedInputs)).toThrow('COMFY_PROMPT_LIMIT_EXCEEDED')
  })

  test('Given object_info When 解析 Then 接受 Comfy 必填、枚举和输出 schema', () => {
    const parsed = parseComfyObjectInfo({
      LoadImage: {
        input: { required: { image: [['a.png', 'b.png'], { image_upload: true }] }, optional: {} },
        output: ['IMAGE', 'MASK'],
        output_name: ['IMAGE', 'MASK'],
        output_is_list: [false, false],
        input_is_list: false,
        output_node: false,
        category: 'image',
        display_name: 'Load Image',
        description: 'Loads an image',
        hidden: { node_id: 'UNIQUE_ID' },
      },
    })
    expect(parsed.LoadImage?.input.required.image).toEqual([['a.png', 'b.png'], { image_upload: true }])
    expect(parsed.LoadImage?.output).toEqual(['IMAGE', 'MASK'])
    expect(parsed.LoadImage).toEqual(expect.objectContaining({
      output_is_list: [false, false],
      input_is_list: false,
      output_node: false,
      category: 'image',
      display_name: 'Load Image',
      description: 'Loads an image',
      hidden: { node_id: 'UNIQUE_ID' },
    }))
  })

  test('Given 带空格的官方节点名和动态输入 schema When 解析 Then 保留可发现能力', () => {
    const parsed = parseComfyObjectInfo({
      'Video Slice': {
        input: {
          required: {
            format: ['COMFY_DYNAMICCOMBO_V3', {
              options: [{ key: 'mp4', inputs: { required: { codec: [['auto', 'h264']] } } }],
            }],
          },
        },
        output: ['VIDEO'],
      },
    })
    expect(parsed['Video Slice']?.input.required.format).toEqual(['COMFY_DYNAMICCOMBO_V3', {
      options: [{ key: 'mp4', inputs: { required: { codec: [['auto', 'h264']] } } }],
    }])
  })

  test('Given ComfyUI 0.30 可空展示元数据 When 解析 Then 归一为空缺或非列表', () => {
    const parsed = parseComfyObjectInfo({
      LatentMath: {
        input: { required: {} },
        output: ['LATENT'],
        output_is_list: [null],
        display_name: null,
        description: null,
        category: null,
      },
    })

    expect(parsed.LatentMath).toEqual({
      input: { required: {} },
      output: ['LATENT'],
      output_is_list: [false],
    })
  })

  test('Given ComfyUI 0.30 官方 is_input_list When 解析 Then 归一内部字段并拒绝冲突声明', () => {
    expect(parseComfyObjectInfo({
      BatchNode: {
        input: { required: {} },
        output: [],
        is_input_list: true,
      },
    }).BatchNode?.input_is_list).toBe(true)

    expect(() => parseComfyObjectInfo({
      AmbiguousBatchNode: {
        input: { required: {} },
        output: [],
        is_input_list: true,
        input_is_list: false,
      },
    })).toThrow('COMFY_OBJECT_INFO_INVALID')
  })

  test('Given 动态选择器使用展示标签 When 解析 Then 接受空格与标点但拒绝控制字符', () => {
    const parsed = parseComfyObjectInfo({
      Encoder: {
        input: {
          required: {
            mode: ['COMFY_DYNAMICCOMBO_V3', {
              options: [
                { key: 'scale dimensions', inputs: { required: {} } },
                { key: 'Opus 5 (HQ)', inputs: { required: {} } },
              ],
            }],
          },
        },
        output: [],
      },
    })
    expect(parsed.Encoder?.input.required.mode?.[0]).toBe('COMFY_DYNAMICCOMBO_V3')

    expect(() => parseComfyObjectInfo({
      Encoder: {
        input: {
          required: {
            mode: ['COMFY_DYNAMICCOMBO_V3', {
              options: [{ key: 'unsafe\nlabel', inputs: { required: {} } }],
            }],
          },
        },
        output: [],
      },
    })).toThrow('COMFY_OBJECT_INFO_INVALID')
  })

  test('Given V3 单选 COMBO When 解析 Then 转为枚举且不在参数中重复暴露资源列表', () => {
    const parsed = parseComfyObjectInfo({
      LoadAudio: {
        input: {
          required: {
            audio: ['COMBO', {
              multiselect: false,
              options: ['voice-a.wav', 'voice-b.wav'],
              audio_upload: true,
            }],
          },
        },
        output: ['AUDIO'],
      },
      MultiSelect: {
        input: {
          required: {
            files: ['COMBO', {
              multiselect: true,
              options: ['one.png', 'two.png'],
            }],
          },
        },
        output: [],
      },
      DefaultSingleSelect: {
        input: { required: { mode: ['COMBO', { options: ['fast', 'quality'] }] } },
        output: [],
      },
    })

    expect(parsed.LoadAudio?.input.required.audio).toEqual([
      ['voice-a.wav', 'voice-b.wav'],
      { multiselect: false, audio_upload: true },
    ])
    expect(parsed.MultiSelect?.input.required.files).toEqual(['COMBO', { multiselect: true }])
    expect(parsed.DefaultSingleSelect?.input.required.mode).toEqual([['fast', 'quality'], {}])
    expect(() => parseComfyObjectInfo({
      InvalidSelect: {
        input: { required: { mode: ['COMBO', { multiselect: 'sometimes', options: ['fast'] }] } },
        output: [],
      },
    })).toThrow('COMFY_OBJECT_INFO_INVALID')
  })

  test('Given VHS 格式元数据包含 MIME 键 When parse object_info Then 保留可执行节点 schema', () => {
    const parsed = parseComfyObjectInfo({ VHS_VideoCombine: {
      input: { required: {
        images: ['IMAGE'], format: [['video/h264-mp4'], {
          formats: { 'video/h264-mp4': [['pix_fmt', ['yuv420p'], { default: 'yuv420p' }]] },
        }],
      }, optional: {}, hidden: {} },
      input_order: { required: ['images', 'format'], optional: [], hidden: [] },
      output: ['VHS_FILENAMES'], output_node: true,
    } })
    expect(parsed.VHS_VideoCombine?.unsupported).toBeUndefined()
    expect(parsed.VHS_VideoCombine?.input.required.format?.[1]).toEqual({
      formats: { 'video/h264-mp4': [['pix_fmt', ['yuv420p'], { default: 'yuv420p' }]] },
    })
  })

  test('Given 动态分支嵌套 V3 COMBO When 重复解析 Then 递归归一且结果幂等', () => {
    const parsed = parseComfyObjectInfo({
      SaveMedia: {
        input: {
          required: {
            format: ['COMFY_DYNAMICCOMBO_V3', {
              options: [{
                key: 'container',
                inputs: {
                  required: {
                    audio: ['COMBO', { multiselect: false, options: ['voice.wav'], audio_upload: true }],
                    codec: ['COMFY_DYNAMICCOMBO_V3', {
                      options: [{
                        key: 'video codec',
                        inputs: { required: { profile: ['COMBO', { options: ['main', 'high'] }] } },
                      }],
                    }],
                  },
                },
              }],
            }],
          },
        },
        output: ['VIDEO'],
      },
    })

    expect(parsed.SaveMedia?.input.required.format).toEqual(['COMFY_DYNAMICCOMBO_V3', {
      options: [{
        key: 'container',
        inputs: {
          required: {
            audio: [['voice.wav'], { multiselect: false, audio_upload: true }],
            codec: ['COMFY_DYNAMICCOMBO_V3', {
              options: [{
                key: 'video codec',
                inputs: { required: { profile: [['main', 'high'], {}] } },
              }],
            }],
          },
        },
      }],
    }])
    expect(parseComfyObjectInfo(parsed)).toEqual(parsed)
  })

  test('Given object_info 含不兼容自定义节点 When 解析目录 Then 保留可发现条目并明确禁止执行', () => {
    const parsed = parseComfyObjectCatalog({
      SupportedNode: {
        input: { required: { text: ['STRING'] } },
        output: ['STRING'],
      },
      CustomNode: {
        input: { required: { 'wild input*': ['STRING'] } },
        output: [['IMAGE', 'MASK']],
        display_name: 'Custom output node',
        category: 'custom/media',
        description: '不应复制到 fallback',
      },
    })

    expect(parsed.SupportedNode?.unsupported).toBeUndefined()
    expect(parsed.CustomNode).toEqual({
      input: { required: {} },
      output: [],
      unsupported: true,
      display_name: 'Custom output node',
      category: 'custom/media',
    })
    expect(parseComfyObjectInfo(parsed)).toEqual(parsed)
    expect(() => parseComfyObjectInfo({
      InvalidMarker: {
        input: { required: {} },
        output: [],
        unsupported: false,
      },
    })).toThrow('COMFY_OBJECT_INFO_INVALID')
  })

  test('Given 目录根或节点身份不安全 When 解析目录 Then 不使用 fallback 绕过边界', () => {
    expect(() => parseComfyObjectCatalog(null)).toThrow('COMFY_OBJECT_INFO_INVALID')
    const slashCatalog = parseComfyObjectCatalog({ 'Custom/Node': { input: {}, output: [] } })
    expect(slashCatalog['Custom/Node']?.unsupported).toBe(true)
    expect(parseComfyObjectInfo(slashCatalog)).toEqual(slashCatalog)
    expect(() => parseComfyObjectCatalog(JSON.parse('{"constructor":{"input":{},"output":[]}}'))).toThrow('COMFY_OBJECT_INFO_INVALID')
    expect(() => parseComfyObjectCatalog({ 'Unsafe\nNode': { input: {}, output: [] } })).toThrow('COMFY_OBJECT_INFO_INVALID')
    expect(() => parseComfyObjectCatalog({ Node: null })).toThrow('COMFY_OBJECT_INFO_INVALID')
    expect(() => parseComfyObjectCatalog(Object.fromEntries(
      Array.from({ length: COMFY_OBJECT_INFO_MAX_CLASSES + 1 }, (_, index) => [`Node-${index}`, { input: {}, output: [] }]),
    ))).toThrow('COMFY_OBJECT_INFO_SIZE_LIMIT')
  })

  test('Given 动态输入含原型键或路径式字段 When 解析 Then 继续拒绝不安全 schema', () => {
    const unsafe = JSON.parse('{"SaveVideo":{"input":{"required":{"format":["COMFY_DYNAMICCOMBO_V3",{"options":[{"key":"mp4","inputs":{"required":{"__proto__":["STRING"]}}}]}]}},"output":[]}}')
    expect(() => parseComfyObjectInfo(unsafe)).toThrow('COMFY_OBJECT_INFO_INVALID')
    expect(() => parseComfyObjectInfo({
      SaveVideo: {
        input: { required: { format: ['COMFY_DYNAMICCOMBO_V3', { options: [{ key: 'mp4', inputs: { required: { '../codec': ['STRING'] } } }] }] } },
        output: [],
      },
    })).toThrow('COMFY_OBJECT_INFO_INVALID')
  })

  test('Given 原型污染键 When 解析 Then 拒绝', () => {
    const prompt = JSON.parse('{"constructor":{"class_type":"Node","inputs":{}}}')
    expect(() => parseComfyPrompt(prompt)).toThrow('COMFY_PROMPT_INVALID')
  })

  test('Given 合法工作流定义 When 解析 Then 仅允许声明式绑定和输出选择器', () => {
    expect(parseMediaWorkflowDefinition({
      schemaVersion: 1,
      prompt: { '1': { class_type: 'LoadImage', inputs: { image: 'placeholder.png' } } },
      bindings: [{ key: 'source', kind: 'image', nodeId: '1', input: 'image', loader: 'LoadImage' }],
      outputs: [{ key: 'result', nodeId: '1', outputIndex: 0, mediaType: 'image' }],
    })).toEqual(expect.objectContaining({ schemaVersion: 1 }))

    expect(() => parseMediaWorkflowDefinition({
      schemaVersion: 1,
      prompt: { '1': { class_type: 'CustomLoader', inputs: {} } },
      bindings: [{ key: 'source', kind: 'image', nodeId: '1', input: 'path', loader: 'CustomLoader', script: 'return input' }],
      outputs: [{ key: 'result', nodeId: '1', outputIndex: 0, mediaType: 'image' }],
    })).toThrow('MEDIA_WORKFLOW_INVALID')
  })

  test('Given 带真实字段元数据的工作流 When 解析 Then 保留新合同且兼容旧绑定', () => {
    const parsed = parseMediaWorkflowDefinition({
      schemaVersion: 1,
      prompt: { '1': { class_type: 'KSampler', inputs: { seed: 7, prompt: 'sunrise' } } },
      bindings: [
        {
          key: 'seed', kind: 'number', nodeId: '1', input: 'seed',
          field: { classType: 'KSampler', valueKind: 'number', label: 'Seed', controlType: 'seed', required: true, min: 0, max: 100, step: 1 },
        },
        { key: 'legacy', kind: 'text', nodeId: '1', input: 'prompt' },
      ],
      outputs: [],
    })

    expect(parsed.bindings[0]?.field).toEqual(expect.objectContaining({ controlType: 'seed', min: 0, step: 1 }))
    expect(parsed.bindings[1]).toEqual({ key: 'legacy', kind: 'text', nodeId: '1', input: 'prompt' })
  })

  test('Given field 指向变化节点、复杂值或非法数字约束 When 解析 Then 阻断保存', () => {
    const base = {
      schemaVersion: 1,
      prompt: { '1': { class_type: 'KSampler', inputs: { seed: 7 } } },
      outputs: [],
    }
    expect(() => parseMediaWorkflowDefinition({
      ...base,
      bindings: [{
        key: 'seed', kind: 'number', nodeId: '1', input: 'seed',
        field: { classType: 'OtherSampler', valueKind: 'number', label: 'Seed', controlType: 'seed', required: true, min: 0, step: 1 },
      }],
    })).toThrow('MEDIA_WORKFLOW_FIELD_INVALID')
    expect(() => parseMediaWorkflowDefinition({
      ...base,
      bindings: [{
        key: 'seed', kind: 'number', nodeId: '1', input: 'seed',
        field: { classType: 'KSampler', valueKind: 'number', label: 'Seed', controlType: 'seed', required: true, min: -1, step: 0.5 },
      }],
    })).toThrow('MEDIA_WORKFLOW_FIELD_INVALID')
  })

  test('Given 重复绑定 key 或 target When 解析 Then 阻断歧义配置', () => {
    const base = {
      schemaVersion: 1,
      prompt: { '1': { class_type: 'LoadImage', inputs: { image: 'placeholder.png' } } },
      outputs: [{ key: 'result', nodeId: '1', outputIndex: 0, mediaType: 'image' }],
    }
    expect(() => parseMediaWorkflowDefinition({
      ...base,
      bindings: [
        { key: 'source', kind: 'image', nodeId: '1', input: 'image', loader: 'LoadImage' },
        { key: 'source', kind: 'text', nodeId: '1', input: 'other' },
      ],
    })).toThrow('MEDIA_WORKFLOW_BINDING_DUPLICATE')
    expect(() => parseMediaWorkflowDefinition({
      ...base,
      bindings: [
        { key: 'source-a', kind: 'image', nodeId: '1', input: 'image', loader: 'LoadImage' },
        { key: 'source-b', kind: 'image', nodeId: '1', input: 'image', loader: 'LoadImage' },
      ],
    })).toThrow('MEDIA_WORKFLOW_BINDING_DUPLICATE')
  })

  test('Given 音视频 loader 绑定和输出 When 解析 Then 保留精确媒体合同', () => {
    expect(parseMediaWorkflowDefinition({
      schemaVersion: 1,
      prompt: {
        '1': { class_type: 'LoadAudio', inputs: {} },
        '2': { class_type: 'LoadVideo', inputs: {} },
      },
      bindings: [
        { key: 'audio', kind: 'audio', nodeId: '1', input: 'audio', loader: 'LoadAudio' },
        { key: 'video', kind: 'video', nodeId: '2', input: 'file', loader: 'LoadVideo' },
      ],
      outputs: [
        { key: 'audio-result', nodeId: '3', outputIndex: 2, mediaType: 'audio' },
        { key: 'video-result', nodeId: '4', outputIndex: 1, mediaType: 'video' },
      ],
    })).toEqual(expect.objectContaining({ schemaVersion: 1 }))

    expect(() => parseMediaWorkflowDefinition({
      schemaVersion: 1,
      prompt: { '1': { class_type: 'LoadAudio', inputs: {} } },
      bindings: [{ key: 'audio', kind: 'audio', nodeId: '1', input: 'audio', loader: 'LoadVideo' }],
      outputs: [{ key: 'result', nodeId: '1', outputIndex: 0, mediaType: 'audio' }],
    })).toThrow('MEDIA_WORKFLOW_INVALID')
  })

  test('Given 重复 output key When 解析 Then 阻断角色歧义；同一远端产物可声明多个角色', () => {
    const base = {
      schemaVersion: 1,
      prompt: {
        '1': { class_type: 'SaveImage', inputs: { images: ['2', 0], filename_prefix: 'Proma' } },
        '2': { class_type: 'LoadImage', inputs: { image: 'placeholder.png' } },
      },
      bindings: [{ key: 'source', kind: 'image', nodeId: '2', input: 'image', loader: 'LoadImage' }],
    }
    expect(() => parseMediaWorkflowDefinition({
      ...base,
      outputs: [
        { key: 'result', nodeId: '1', outputIndex: 0, mediaType: 'image' },
        { key: 'result', nodeId: '2', outputIndex: 0, mediaType: 'image' },
      ],
    })).toThrow('MEDIA_WORKFLOW_OUTPUT_DUPLICATE')
    expect(parseMediaWorkflowDefinition({
      ...base,
      outputs: [
        { key: 'result-a', nodeId: '1', outputIndex: 0, mediaType: 'image' },
        { key: 'result-b', nodeId: '1', outputIndex: 0, mediaType: 'image' },
      ],
    }).outputs).toHaveLength(2)
  })
})
