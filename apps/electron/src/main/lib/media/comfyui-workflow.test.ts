import { describe, expect, test } from 'bun:test'
import type { ComfyObjectInfo, MediaWorkflowDefinition } from '../../../../../../packages/shared/src/types/media-workflow'
import { COMFY_CORE_NODE_CONTRACTS, compileComfyWorkflow, parseComfyApiWorkflow, validateComfyWorkflow } from './comfyui-workflow'

const objectInfo: ComfyObjectInfo = {
  LoadImage: {
    input: { required: { image: ['STRING', { image_upload: true }] }, optional: {}, hidden: { prompt: 'PROMPT' } },
    output: ['IMAGE', 'MASK'],
    output_name: ['IMAGE', 'MASK'],
    output_is_list: [false, false],
  },
  SaveImage: {
    input: { required: { images: ['IMAGE'], filename_prefix: ['STRING'] }, optional: {} },
    output: [],
    output_node: true,
  },
  CheckpointLoaderSimple: {
    input: { required: { ckpt_name: [['base.safetensors']] }, optional: {} },
    output: ['MODEL', 'CLIP', 'VAE'],
    output_is_list: [false, false, false],
  },
  CLIPTextEncode: {
    input: { required: { text: ['STRING'], clip: ['CLIP'] }, optional: {} },
    output: ['CONDITIONING'],
    output_is_list: [false],
  },
  KSampler: {
    input: {
      required: {
        text: ['STRING'],
        seed: ['INT', { min: 0, max: 1_000 }],
        enabled: ['BOOLEAN'],
      },
      optional: {},
    },
    output: ['IMAGE'],
    output_is_list: [false],
  },
}

const definition: MediaWorkflowDefinition = {
  schemaVersion: 1,
  prompt: {
    '1': { class_type: 'LoadImage', inputs: { image: 'placeholder.png' } },
    '2': { class_type: 'SaveImage', inputs: { images: ['1', 0], filename_prefix: 'Proma' } },
  },
  bindings: [{ key: 'source', kind: 'image', nodeId: '1', input: 'image', loader: 'LoadImage' }],
  outputs: [{ key: 'result', nodeId: '2', outputIndex: 0, mediaType: 'image' }],
}

describe('ComfyUI static workflow', () => {
  test('Given 已知节点含尚未适配的 V3 多选参数 When 校验 Then 不因命中核心合同而放行', () => {
    /** 未归一为枚举的 COMBO 表示当前无法处理的选择语义。 */
    const multiselect: ComfyObjectInfo = { ...objectInfo,
      KSampler: { ...objectInfo.KSampler!, input: { required: { ...objectInfo.KSampler!.input.required,
        text: ['COMBO', { multiselect: true }],
      } } },
    }
    const validation = validateComfyWorkflow({ schemaVersion: 1,
      prompt: {
        '1': { class_type: 'KSampler', inputs: { text: 'selection', seed: 1, enabled: true } },
        '2': { class_type: 'SaveImage', inputs: { images: ['1', 0], filename_prefix: 'Proma' } },
      }, bindings: [], outputs: definition.outputs,
    }, multiselect)
    expect(validation.valid).toBe(false)
    expect(validation.issues).toContainEqual(expect.objectContaining({ code: 'NODE_INTERFACE_UNSUPPORTED', nodeId: '1', input: 'text' }))
    /** 动态分支展开后的多选参数必须遵守同一阻断规则。 */
    const nested: ComfyObjectInfo = { ...multiselect,
      KSampler: { ...objectInfo.KSampler!, input: { required: { ...objectInfo.KSampler!.input.required,
        text: ['COMFY_DYNAMICCOMBO_V3', { options: [{ key: 'selected', inputs: {
          required: { mode: ['COMBO', { multiselect: true }] },
        } }] }],
      } } },
    }
    const nestedValidation = validateComfyWorkflow({ schemaVersion: 1,
      prompt: {
        '1': { class_type: 'KSampler', inputs: { text: 'selected', 'text.mode': { arbitrary: 'value' }, seed: 1, enabled: true } },
        '2': { class_type: 'SaveImage', inputs: { images: ['1', 0], filename_prefix: 'Proma' } },
      }, bindings: [], outputs: definition.outputs,
    }, nested)
    expect(nestedValidation.valid).toBe(false)
    expect(nestedValidation.issues).toContainEqual(expect.objectContaining({ code: 'NODE_INTERFACE_UNSUPPORTED', nodeId: '1', input: 'text.mode' }))
  })

  test('Given 可发现但 schema 不兼容的节点 When 校验 Then 即使没有输入也禁止执行', () => {
    /** 没有输入的占位 schema 不能被当成一个已验证的处理器。 */
    const incompatible = {
      ...objectInfo,
      CustomEnum: { input: { required: {} }, output: [], unsupported: true as const },
    }
    const validation = validateComfyWorkflow({ ...definition,
      prompt: { ...definition.prompt, '4': { class_type: 'CustomEnum', inputs: {} } },
    }, incompatible)
    expect(validation.valid).toBe(false)
    expect(validation.issues).toContainEqual(expect.objectContaining({ code: 'NODE_INTERFACE_UNSUPPORTED', nodeId: '4' }))
  })

  test('Given API 图 When 解析 Then 保留链接；Given UI 图 Then 拒绝', () => {
    expect(parseComfyApiWorkflow(definition.prompt)['2']?.inputs.images).toEqual(['1', 0])
    expect(() => parseComfyApiWorkflow({ nodes: [], links: [] })).toThrow('COMFY_UI_WORKFLOW_UNSUPPORTED')
  })

  test('Given 已上传图片回执 When 编译 Then 写入远端字符串而不是本地 descriptor', () => {
    const result = compileComfyWorkflow(definition, {
      source: { kind: 'image', upload: { name: 'renamed.png', subfolder: 'proma', type: 'input' } },
    }, objectInfo)
    expect(result.prompt['1']?.inputs.image).toBe('proma/renamed.png')
    expect(result.prompt['2']?.inputs.images).toEqual(['1', 0])
  })

  test('Given 未上传图片或错误 loader When 编译 Then 明确拒绝', () => {
    expect(() => compileComfyWorkflow(definition, {
      source: { kind: 'image', descriptor: { path: '/tmp/local.png' } },
    }, objectInfo)).toThrow('MEDIA_BINDING_UPLOAD_REQUIRED')

    expect(() => compileComfyWorkflow({
      ...definition,
      bindings: [{ key: 'audio', kind: 'audio', nodeId: '1', input: 'image', loader: 'LoadAudio' }],
    }, { audio: { kind: 'audio', upload: { name: 'a.wav', subfolder: '', type: 'input' } } }, objectInfo))
      .toThrow('MEDIA_BINDING_UNSUPPORTED')

    expect(() => compileComfyWorkflow(definition, {
      source: { kind: 'image', upload: { name: 'existing.png', subfolder: '', type: 'output' } },
    }, objectInfo)).toThrow('MEDIA_BINDING_UPLOAD_INVALID')
  })

  test('Given 音频与视频上传回执 When 编译 Then 精确填入各自 loader 输入', () => {
    const mediaInfo: ComfyObjectInfo = {
      LoadAudio: {
        input: { required: { audio: [['placeholder.wav'], { audio_upload: true }] } },
        output: ['AUDIO'],
      },
      LoadVideo: {
        input: { required: { file: [['placeholder.mp4'], { video_upload: true }] } },
        output: ['VIDEO'],
      },
    }
    const mediaDefinition: MediaWorkflowDefinition = {
      schemaVersion: 1,
      prompt: {
        '1': { class_type: 'LoadAudio', inputs: { audio: 'placeholder.wav' } },
        '2': { class_type: 'LoadVideo', inputs: { file: 'placeholder.mp4' } },
      },
      bindings: [
        { key: 'audio', kind: 'audio', nodeId: '1', input: 'audio', loader: 'LoadAudio' },
        { key: 'video', kind: 'video', nodeId: '2', input: 'file', loader: 'LoadVideo' },
      ],
      outputs: [],
    }
    const result = compileComfyWorkflow(mediaDefinition, {
      audio: { kind: 'audio', upload: { name: 'voice.wav', subfolder: 'proma/audio', type: 'input' } },
      video: { kind: 'video', upload: { name: 'clip.mp4', subfolder: 'proma/video', type: 'input' } },
    }, mediaInfo)
    expect(result.prompt['1']?.inputs.audio).toBe('proma/audio/voice.wav')
    expect(result.prompt['2']?.inputs.file).toBe('proma/video/clip.mp4')
  })

  test('Given loader 上传标记与绑定媒体不一致 When 编译 Then 拒绝伪造回执字段', () => {
    const audioDefinition: MediaWorkflowDefinition = {
      schemaVersion: 1,
      prompt: { '1': { class_type: 'LoadAudio', inputs: { audio: 'placeholder.wav' } } },
      bindings: [{ key: 'audio', kind: 'audio', nodeId: '1', input: 'audio', loader: 'LoadAudio' }],
      outputs: [],
    }
    expect(() => compileComfyWorkflow(audioDefinition, {
      audio: { kind: 'audio', upload: { name: 'voice.wav', subfolder: '', type: 'input' } },
    }, {
      LoadAudio: { input: { required: { audio: [['voice.wav'], { image_upload: true }] } }, output: ['AUDIO'] },
    })).toThrow('MEDIA_BINDING_SCHEMA_INVALID')
  })

  test('Given 节点 schema When 校验 Then 报告未知节点、必填、枚举、类型和输出索引', () => {
    const invalid: MediaWorkflowDefinition = {
      schemaVersion: 1,
      prompt: {
        '1': { class_type: 'LoadImage', inputs: { image: 42 } },
        '2': { class_type: 'SaveImage', inputs: { images: ['1', 9] } },
        '3': { class_type: 'UnknownNode', inputs: {} },
      },
      bindings: [],
      outputs: [{ key: 'result', nodeId: '2', outputIndex: 1, mediaType: 'image' }],
    }
    const result = validateComfyWorkflow(invalid, objectInfo)
    expect(result.valid).toBe(false)
    expect(result.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      'INPUT_TYPE_INVALID', 'INPUT_REQUIRED', 'NODE_CLASS_UNKNOWN', 'OUTPUT_INDEX_INVALID',
    ]))
  })

  test('Given unknown 或 hidden input When 校验 Then 禁止用户工作流填入', () => {
    const result = validateComfyWorkflow({
      ...definition,
      prompt: {
        ...definition.prompt,
        '1': { class_type: 'LoadImage', inputs: { image: 'placeholder.png', prompt: 'forged', extra: true } },
      },
    }, objectInfo)
    expect(result.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining(['INPUT_HIDDEN', 'INPUT_UNKNOWN']))
  })

  test('Given 链接类型不匹配或 list 语义未适配 When 校验 Then 阻断执行', () => {
    const incompatible = validateComfyWorkflow({
      schemaVersion: 1,
      prompt: {
        '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'base.safetensors' } },
        '2': { class_type: 'SaveImage', inputs: { images: ['1', 0], filename_prefix: 'Proma' } },
      },
      bindings: [],
      outputs: [{ key: 'result', nodeId: '2', outputIndex: 0, mediaType: 'image' }],
    }, objectInfo)
    expect(incompatible.issues.map((issue) => issue.code)).toContain('LINK_TYPE_INVALID')

    const listInfo: ComfyObjectInfo = structuredClone(objectInfo)
    listInfo.LoadImage!.output_is_list = [true, false]
    const listResult = validateComfyWorkflow(definition, listInfo)
    expect(listResult.issues.map((issue) => issue.code)).toContain('LINK_LIST_UNSUPPORTED')
  })

  test('Given 环路或没有必需输出 When 校验 Then 有界返回错误', () => {
    const cyclic: MediaWorkflowDefinition = {
      schemaVersion: 1,
      prompt: {
        '1': { class_type: 'LoadImage', inputs: { image: ['2', 0] } },
        '2': { class_type: 'SaveImage', inputs: { images: ['1', 0], filename_prefix: 'x' } },
      },
      bindings: [],
      outputs: [],
    }
    const result = validateComfyWorkflow(cyclic, objectInfo, { maxIssues: 2 })
    expect(result.issues).toHaveLength(2)
    expect(result.issues.map((issue) => issue.code)).toContain('WORKFLOW_CYCLE')
    expect(result.issues.map((issue) => issue.code)).toContain('OUTPUT_REQUIRED')
  })

  test('Given 自定义输出副作用节点 When schema 存在 Then 仍按核心合同阻断', () => {
    const result = validateComfyWorkflow({
      schemaVersion: 1,
      prompt: { '1': { class_type: 'CustomNetworkPublisher', inputs: {} } },
      bindings: [],
      outputs: [{ key: 'result', nodeId: '1', outputIndex: 0, mediaType: 'image' }],
    }, {
      CustomNetworkPublisher: { input: { required: {} }, output: [], output_node: true },
    })
    expect(result.issues.map((issue) => issue.code)).toContain('NODE_CLASS_UNSAFE')
  })

  test('Given 连接已安装的处理节点 When 接口仅使用枚举、基础标量和类型化链接 Then 可校验并编译 Agent 字段', () => {
    const info: ComfyObjectInfo = {
      ...objectInfo,
      InstalledImageProcessor: {
        input: {
          required: {
            image: ['IMAGE'],
            model_name: [['processor-v2.safetensors']],
            prompt: ['STRING'],
            strength: ['FLOAT', { min: 0, max: 1 }],
          },
        },
        output: ['IMAGE'],
        output_is_list: [false],
      },
    }
    const installedDefinition: MediaWorkflowDefinition = {
      schemaVersion: 1,
      prompt: {
        '1': { class_type: 'LoadImage', inputs: { image: 'placeholder.png' } },
        '2': { class_type: 'InstalledImageProcessor', inputs: {
          image: ['1', 0], model_name: 'processor-v2.safetensors', prompt: 'fallback', strength: 0.5,
        } },
        '3': { class_type: 'SaveImage', inputs: { images: ['2', 0], filename_prefix: 'Proma/custom' } },
      },
      bindings: [
        { key: 'source', kind: 'image', nodeId: '1', input: 'image', loader: 'LoadImage' },
        { key: 'prompt', kind: 'text', nodeId: '2', input: 'prompt' },
        { key: 'strength', kind: 'number', nodeId: '2', input: 'strength' },
      ],
      outputs: [{ key: 'result', nodeId: '3', outputIndex: 0, mediaType: 'image' }],
    }

    expect(validateComfyWorkflow(installedDefinition, info)).toEqual({ valid: true, issues: [], truncated: false })
    const compiled = compileComfyWorkflow(installedDefinition, {
      source: { kind: 'image', upload: { name: 'source.png', subfolder: 'proma/run', type: 'input' } },
      prompt: { kind: 'text', value: 'cinematic portrait' },
      strength: { kind: 'number', value: 0.75 },
    }, info)
    expect(compiled.prompt['2']?.inputs).toEqual({
      image: ['1', 0], model_name: 'processor-v2.safetensors', prompt: 'cinematic portrait', strength: 0.75,
    })
  })

  test('Given 未适配节点暴露上传、路径或 URL 输入 When 校验 Then 要求显式资源合同', () => {
    const info: ComfyObjectInfo = {
      ...objectInfo,
      InstalledRemoteLoader: {
        input: { required: {
          source_url: ['STRING'],
          source: ['STRING'],
          media: [['remote.png'], { image_upload: true }],
        } },
        output: ['IMAGE'],
      },
    }
    const result = validateComfyWorkflow({
      schemaVersion: 1,
      prompt: {
        '1': { class_type: 'InstalledRemoteLoader', inputs: {
          source_url: 'https://example.com/source.png', source: 'remote.png', media: 'remote.png',
        } },
        '2': { class_type: 'SaveImage', inputs: { images: ['1', 0], filename_prefix: 'Proma' } },
      },
      bindings: [],
      outputs: [{ key: 'result', nodeId: '2', outputIndex: 0, mediaType: 'image' }],
    }, info)

    expect(result.issues.filter((issue) => issue.code === 'RESOURCE_CONTRACT_REQUIRED').map((issue) => issue.input))
      .toEqual(['source_url', 'source', 'media'])
  })

  test('Given 已安装节点要求不透明字面量 When 本地没有输入适配 Then 返回可操作阻断原因', () => {
    const info: ComfyObjectInfo = {
      ...objectInfo,
      InstalledOpaqueProcessor: {
        input: { required: { config: ['CUSTOM_CONFIG'] } },
        output: ['IMAGE'],
      },
    }
    const result = validateComfyWorkflow({
      schemaVersion: 1,
      prompt: {
        '1': { class_type: 'InstalledOpaqueProcessor', inputs: { config: { preset: 'fast' } } },
        '2': { class_type: 'SaveImage', inputs: { images: ['1', 0], filename_prefix: 'Proma' } },
      },
      bindings: [],
      outputs: [{ key: 'result', nodeId: '2', outputIndex: 0, mediaType: 'image' }],
    }, info)

    expect(result.issues).toContainEqual(expect.objectContaining({
      code: 'NODE_INTERFACE_UNSUPPORTED', nodeId: '1', input: 'config',
    }))
    expect(result.issues.find((issue) => issue.code === 'NODE_INTERFACE_UNSUPPORTED')?.message)
      .toContain('请改用节点链接或增加输入适配')
  })

  test('Given LoadImage 常量、未绑定或 SaveImage 越界前缀 When 校验 Then 阻断资源与路径注入', () => {
    const result = validateComfyWorkflow({
      ...definition,
      prompt: {
        '1': { class_type: 'LoadImage', inputs: { image: 'remote-existing.png' } },
        '2': { class_type: 'SaveImage', inputs: { images: ['1', 0], filename_prefix: '../escape' } },
      },
      bindings: [],
    }, objectInfo)
    expect(result.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      'RESOURCE_BINDING_REQUIRED', 'RESOURCE_CONSTANT_FORBIDDEN', 'OUTPUT_PREFIX_INVALID',
    ]))
  })

  test('Given LoadImage.image 被错误标量绑定 When 校验 Then 不授予图片资源资格', () => {
    const result = validateComfyWorkflow({
      ...definition,
      bindings: [{ key: 'source', kind: 'text', nodeId: '1', input: 'image' }],
    }, objectInfo)
    expect(result.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      'BINDING_TARGET_INVALID', 'RESOURCE_BINDING_REQUIRED', 'RESOURCE_CONSTANT_FORBIDDEN',
    ]))
  })

  test('Given 模型 loader When 资源字段不是实时枚举或值越界 Then 阻断执行', () => {
    const definitionWithModel: MediaWorkflowDefinition = {
      schemaVersion: 1,
      prompt: { '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'unknown.safetensors' } } },
      bindings: [],
      outputs: [{ key: 'result', nodeId: '1', outputIndex: 0, mediaType: 'image' }],
    }
    const noEnumInfo: ComfyObjectInfo = structuredClone(objectInfo)
    noEnumInfo.CheckpointLoaderSimple!.input.required.ckpt_name = ['STRING']
    expect(validateComfyWorkflow(definitionWithModel, noEnumInfo).issues.map((issue) => issue.code))
      .toContain('RESOURCE_ENUM_REQUIRED')
    expect(validateComfyWorkflow(definitionWithModel, objectInfo).issues.map((issue) => issue.code))
      .toContain('INPUT_ENUM_INVALID')
  })

  test('Given 数值字面量 When 超出 schema min/max Then 拒绝边界外值', () => {
    const boundedInfo: ComfyObjectInfo = {
      EmptyLatentImage: {
        input: { required: { width: ['INT', { min: 64, max: 2048 }], height: ['INT', { min: 64, max: 2048 }], batch_size: ['INT', { min: 1, max: 4 }] } },
        output: ['LATENT'],
        output_is_list: [false],
      },
      SaveImage: objectInfo.SaveImage!,
    }
    const result = validateComfyWorkflow({
      schemaVersion: 1,
      prompt: {
        '1': { class_type: 'EmptyLatentImage', inputs: { width: 32, height: 1024, batch_size: 0 } },
        '2': { class_type: 'SaveImage', inputs: { images: ['1', 0], filename_prefix: 'Proma' } },
      },
      bindings: [],
      outputs: [{ key: 'result', nodeId: '2', outputIndex: 0, mediaType: 'image' }],
    }, boundedInfo)
    expect(result.issues.map((issue) => issue.code).filter((code) => code === 'INPUT_RANGE_INVALID')).toHaveLength(2)
  })

  test('Given 标量绑定 text、number 0、boolean false When 编译 Then 使用正确 JS 类型', () => {
    const scalarDefinition: MediaWorkflowDefinition = {
      schemaVersion: 1,
      prompt: { '1': { class_type: 'KSampler', inputs: { text: '', seed: 1, enabled: true } } },
      bindings: [
        { key: 'text', kind: 'text', nodeId: '1', input: 'text' },
        { key: 'seed', kind: 'number', nodeId: '1', input: 'seed' },
        { key: 'enabled', kind: 'boolean', nodeId: '1', input: 'enabled' },
      ],
      outputs: [{ key: 'result', nodeId: '1', outputIndex: 0, mediaType: 'image' }],
    }
    const result = compileComfyWorkflow(scalarDefinition, {
      text: { kind: 'text', value: 'hello' },
      seed: { kind: 'number', value: 0 },
      enabled: { kind: 'boolean', value: false },
    }, objectInfo)
    expect(result.prompt['1']?.inputs).toEqual({ text: 'hello', seed: 0, enabled: false })
  })

  test('Given 数值 binding 超出实时 schema 范围 When 编译 Then 拒绝写入工作流', () => {
    const scalarDefinition: MediaWorkflowDefinition = {
      schemaVersion: 1,
      prompt: { '1': { class_type: 'KSampler', inputs: { text: '', seed: 1, enabled: true } } },
      bindings: [{ key: 'seed', kind: 'number', nodeId: '1', input: 'seed' }],
      outputs: [{ key: 'result', nodeId: '1', outputIndex: 0, mediaType: 'image' }],
    }
    expect(() => compileComfyWorkflow(scalarDefinition, { seed: { kind: 'number', value: 1_001 } }, objectInfo))
      .toThrow('MEDIA_BINDING_RANGE_INVALID')
  })

  test('Given 新 field 数字合同 When 编译 Then 校验必填、范围、步长与安全整数', () => {
    const fieldDefinition: MediaWorkflowDefinition = {
      schemaVersion: 1,
      prompt: { '1': { class_type: 'KSampler', inputs: { text: 'fallback', seed: 4, enabled: true } } },
      bindings: [{
        key: 'seed', kind: 'number', nodeId: '1', input: 'seed',
        field: { classType: 'KSampler', valueKind: 'number', label: 'Seed', controlType: 'seed', required: true, min: 0, max: 100, step: 2 },
      }],
      outputs: [],
    }

    expect(() => compileComfyWorkflow(fieldDefinition, {}, objectInfo)).toThrow('MEDIA_BINDING_REQUIRED')
    expect(() => compileComfyWorkflow(fieldDefinition, { seed: { kind: 'number', value: 3 } }, objectInfo))
      .toThrow('MEDIA_BINDING_STEP_INVALID')
    expect(() => compileComfyWorkflow(fieldDefinition, { seed: { kind: 'number', value: 101 } }, objectInfo))
      .toThrow('MEDIA_BINDING_RANGE_INVALID')
    expect(() => compileComfyWorkflow(fieldDefinition, { seed: { kind: 'number', value: 4.5 } }, objectInfo))
      .toThrow('MEDIA_BINDING_INTEGER_INVALID')
    expect(compileComfyWorkflow(fieldDefinition, { seed: { kind: 'number', value: 6 } }, objectInfo).prompt['1']?.inputs.seed).toBe(6)
  })

  test('Given 新 field 可选标量未填 When 原字面量仍合法 Then 回退；类型漂移时拒绝', () => {
    const optionalDefinition: MediaWorkflowDefinition = {
      schemaVersion: 1,
      prompt: { '1': { class_type: 'KSampler', inputs: { text: 'fallback', seed: 4, enabled: true } } },
      bindings: [{
        key: 'text', kind: 'text', nodeId: '1', input: 'text',
        field: { classType: 'KSampler', valueKind: 'string', label: 'Prompt', controlType: 'text', required: false },
      }],
      outputs: [],
    }

    expect(compileComfyWorkflow(optionalDefinition, {}, objectInfo).prompt['1']?.inputs.text).toBe('fallback')
    optionalDefinition.prompt['1']!.inputs.text = 42
    expect(() => compileComfyWorkflow(optionalDefinition, {}, objectInfo)).toThrow('MEDIA_BINDING_FALLBACK_INVALID')
  })

  test('Given 新 field 媒体映射未填 When prompt 有伪远端文件名 Then 仍要求真实上传回执', () => {
    const fieldDefinition: MediaWorkflowDefinition = {
      ...definition,
      bindings: [{
        ...definition.bindings[0]!,
        field: { classType: 'LoadImage', valueKind: 'string', label: 'Source', controlType: 'image', required: false },
      }],
    }

    expect(() => compileComfyWorkflow(fieldDefinition, {}, objectInfo)).toThrow('MEDIA_BINDING_UPLOAD_REQUIRED')
  })

  test('Given 完整受控图片工作流 When 静态校验 Then 获得执行资格', () => {
    expect(validateComfyWorkflow(definition, objectInfo)).toEqual({ valid: true, issues: [], truncated: false })
  })

  test('Given 静态音频与视频工作流 When 校验 Then 输出合同区分 history 键与媒体类型', () => {
    const info: ComfyObjectInfo = {
      LoadAudio: { input: { required: { audio: [['source.wav'], { audio_upload: true }] } }, output: ['AUDIO'] },
      SaveAudioMP3: {
        input: { required: { audio: ['AUDIO'], filename_prefix: ['STRING'], quality: [['V0', '128k', '320k']] } },
        output: ['AUDIO'], output_node: true,
      },
      LoadVideo: { input: { required: { file: [['source.mp4'], { video_upload: true }] } }, output: ['VIDEO'] },
      SaveVideo: {
        input: {
          required: {
            video: ['VIDEO'],
            filename_prefix: ['STRING'],
            format: ['COMFY_DYNAMICCOMBO_V3', {
              options: [{ key: 'mp4', inputs: { required: { codec: ['COMFY_DYNAMICCOMBO_V3', { options: [{ key: 'auto', inputs: { required: {} } }] }] } } }],
            }],
          },
        },
        output: ['VIDEO'], output_node: true,
      },
    }
    const result = validateComfyWorkflow({
      schemaVersion: 1,
      prompt: {
        '1': { class_type: 'LoadAudio', inputs: { audio: 'source.wav' } },
        '2': { class_type: 'SaveAudioMP3', inputs: { audio: ['1', 0], filename_prefix: 'audio/Proma', quality: 'V0' } },
        '3': { class_type: 'LoadVideo', inputs: { file: 'source.mp4' } },
        '4': { class_type: 'SaveVideo', inputs: { video: ['3', 0], filename_prefix: 'video/Proma', format: 'mp4', 'format.codec': 'auto' } },
      },
      bindings: [
        { key: 'audio', kind: 'audio', nodeId: '1', input: 'audio', loader: 'LoadAudio' },
        { key: 'video', kind: 'video', nodeId: '3', input: 'file', loader: 'LoadVideo' },
      ],
      outputs: [
        { key: 'soundtrack', nodeId: '2', outputIndex: 0, mediaType: 'audio' },
        { key: 'movie', nodeId: '4', outputIndex: 2, mediaType: 'video' },
      ],
    }, info)
    expect(result).toEqual({ valid: true, issues: [], truncated: false })
    expect(COMFY_CORE_NODE_CONTRACTS.SaveAudioMP3?.historyOutput).toEqual({ mediaType: 'audio', historyKey: 'audio' })
    expect(COMFY_CORE_NODE_CONTRACTS.SaveVideo?.historyOutput).toEqual({ mediaType: 'video', historyKey: 'images' })
  })

  test('Given SaveAudioAdvanced 动态格式分支 When 使用扁平 prompt 字段 Then 只接受选中分支', () => {
    const info: ComfyObjectInfo = {
      SaveAudioAdvanced: {
        input: {
          required: {
            audio: ['AUDIO'],
            filename_prefix: ['STRING'],
            format: ['COMFY_DYNAMICCOMBO_V3', {
              options: [
                { key: 'flac', inputs: { required: {} } },
                { key: 'mp3', inputs: { required: { quality: [['V0', '128k', '320k']] } } },
              ],
            }],
          },
        },
        output: ['AUDIO'], output_node: true,
      },
    }
    const base: MediaWorkflowDefinition = {
      schemaVersion: 1,
      prompt: {
        '1': { class_type: 'SaveAudioAdvanced', inputs: { audio: ['2', 0], filename_prefix: 'audio/Proma', format: 'mp3', 'format.quality': 'V0' } },
        '2': { class_type: 'VAEDecodeAudio', inputs: {} },
      },
      bindings: [],
      outputs: [{ key: 'audio', nodeId: '1', outputIndex: 0, mediaType: 'audio' }],
    }
    const validInfo: ComfyObjectInfo = {
      ...info,
      VAEDecodeAudio: { input: { required: {} }, output: ['AUDIO'] },
    }
    expect(validateComfyWorkflow(base, validInfo)).toEqual({ valid: true, issues: [], truncated: false })
    const invalid = structuredClone(base)
    invalid.prompt['1']!.inputs.format = 'flac'
    expect(validateComfyWorkflow(invalid, validInfo).issues.map((issue) => issue.code)).toContain('INPUT_UNKNOWN')
  })

  test('Given LoadVideo 预览或错误媒体选择器 When 校验 Then 不把输入预览当生成产物', () => {
    const info: ComfyObjectInfo = {
      LoadVideo: { input: { required: { file: [['source.mp4'], { video_upload: true }] } }, output: ['VIDEO'] },
      SaveWEBM: {
        input: { required: { images: ['IMAGE'], filename_prefix: ['STRING'], codec: [['vp9', 'av1']], fps: ['FLOAT'], crf: ['FLOAT'] } },
        output: ['IMAGE'], output_node: true,
      },
    }
    const result = validateComfyWorkflow({
      schemaVersion: 1,
      prompt: {
        '1': { class_type: 'LoadVideo', inputs: { file: 'source.mp4' } },
        '2': { class_type: 'SaveWEBM', inputs: { images: ['1', 0], filename_prefix: 'video/Proma', codec: 'vp9', fps: 24, crf: 32 } },
      },
      bindings: [{ key: 'video', kind: 'video', nodeId: '1', input: 'file', loader: 'LoadVideo' }],
      outputs: [
        { key: 'input-preview', nodeId: '1', outputIndex: 0, mediaType: 'video' },
        { key: 'wrong-media', nodeId: '2', outputIndex: 0, mediaType: 'image' },
      ],
    }, info)
    expect(result.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      'LINK_TYPE_INVALID', 'OUTPUT_SELECTOR_INVALID', 'OUTPUT_MEDIA_UNSUPPORTED', 'OUTPUT_DECLARATION_REQUIRED',
    ]))
  })

  test('Given ACE 1.5 与最小 Wan 节点 When 远端 schema 匹配 Then 允许静态编排', () => {
    for (const classType of ['TextEncodeAceStepAudio1.5', 'EmptyAceStep1.5LatentAudio', 'ModelSamplingAuraFlow', 'WanImageToVideo', 'Wan22ImageToVideoLatent']) {
      expect(COMFY_CORE_NODE_CONTRACTS[classType]).toBeDefined()
    }
  })

  test('Given 输出 selector 指向非输出节点、错误媒体或漏声明输出节点 When 校验 Then 全部阻断', () => {
    const invalid: MediaWorkflowDefinition = {
      ...definition,
      prompt: {
        ...definition.prompt,
        '3': { class_type: 'PreviewImage', inputs: { images: ['1', 0] } },
      },
      outputs: [
        { key: 'wrong-node', nodeId: '1', outputIndex: 0, mediaType: 'image' },
        { key: 'wrong-media', nodeId: '2', outputIndex: 0, mediaType: 'audio' },
        { key: 'valid-next-history-item', nodeId: '2', outputIndex: 1, mediaType: 'image' },
      ],
    }
    const info: ComfyObjectInfo = {
      ...objectInfo,
      PreviewImage: { input: { required: { images: ['IMAGE'] } }, output: [], output_node: true },
    }
    expect(validateComfyWorkflow(invalid, info).issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      'OUTPUT_SELECTOR_INVALID', 'OUTPUT_MEDIA_UNSUPPORTED', 'OUTPUT_DECLARATION_REQUIRED',
    ]))
  })
})
