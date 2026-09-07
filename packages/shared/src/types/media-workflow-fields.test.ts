import { describe, expect, test } from 'bun:test'
import type { ComfyPrompt, MediaWorkflowDefinition } from './media-workflow'
import {
  createMediaWorkflowFieldBinding,
  listMediaWorkflowFields,
  validateMediaWorkflowFieldBindings,
  validateMediaWorkflowFieldValue,
} from './media-workflow-fields'

const prompt: ComfyPrompt = {
  '1': {
    class_type: 'KSampler',
    inputs: {
      prompt: 'sunrise',
      seed: 7,
      enabled: true,
      model: ['2', 0],
      options: { mode: 'fast' },
      empty: null,
    },
    _meta: { title: '采样器' },
  },
  '2': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'base.safetensors' } },
  '3': { class_type: 'LoadImage', inputs: { image: 'placeholder.png' } },
}

describe('媒体工作流真实字段合同', () => {
  test('Given API JSON When 枚举字段 Then 标量可编辑且连线与复杂值只读', () => {
    const fields = listMediaWorkflowFields(prompt)

    expect(fields).toHaveLength(8)
    expect(fields.find((field) => field.nodeId === '1' && field.input === 'prompt')).toEqual(expect.objectContaining({
      classType: 'KSampler', nodeTitle: '采样器', value: 'sunrise', valueKind: 'string', editable: true,
    }))
    expect(fields.find((field) => field.input === 'model')).toEqual(expect.objectContaining({
      valueKind: 'linked', editable: false,
    }))
    expect(fields.find((field) => field.input === 'options')).toEqual(expect.objectContaining({
      valueKind: 'complex', editable: false,
    }))
    expect(fields.find((field) => field.input === 'empty')).toEqual(expect.objectContaining({
      valueKind: 'complex', editable: false,
    }))
  })

  test('Given 真实标量字段 When 创建绑定 Then 固定节点类型、原始类型与数字语义', () => {
    const seed = listMediaWorkflowFields(prompt).find((field) => field.input === 'seed')!

    expect(createMediaWorkflowFieldBinding(seed, 'seed')).toEqual({
      key: '1.seed',
      kind: 'number',
      nodeId: '1',
      input: 'seed',
      field: {
        classType: 'KSampler',
        valueKind: 'number',
        label: 'seed',
        controlType: 'seed',
        required: true,
        min: 0,
        step: 1,
      },
    })
  })

  test('Given 媒体控件 When 目标不是官方 loader 精确字段 Then 拒绝猜测上传槽位', () => {
    const text = listMediaWorkflowFields(prompt).find((field) => field.input === 'prompt')!
    const image = listMediaWorkflowFields(prompt).find((field) => field.nodeId === '3' && field.input === 'image')!

    expect(() => createMediaWorkflowFieldBinding(text, 'image')).toThrow('MEDIA_WORKFLOW_FIELD_CONTROL_INVALID')
    expect(createMediaWorkflowFieldBinding(image, 'image')).toEqual(expect.objectContaining({
      kind: 'image', loader: 'LoadImage', field: expect.objectContaining({ controlType: 'image' }),
    }))
  })

  test('Given JSON 修改后 class_type、input 或原始类型变化 When 校验 Then 有界报告失效绑定', () => {
    const source = listMediaWorkflowFields(prompt).find((field) => field.input === 'prompt')!
    const binding = createMediaWorkflowFieldBinding(source)
    const definition: MediaWorkflowDefinition = {
      schemaVersion: 1,
      prompt: { ...prompt, '1': { ...prompt['1']!, class_type: 'OtherSampler' } },
      bindings: [binding],
      outputs: [],
    }

    expect(validateMediaWorkflowFieldBindings(definition)).toEqual([
      expect.objectContaining({ code: 'FIELD_CLASS_CHANGED', key: '1.prompt', nodeId: '1', input: 'prompt' }),
    ])

    definition.prompt['1'] = { class_type: 'KSampler', inputs: { prompt: 42 } }
    expect(validateMediaWorkflowFieldBindings(definition)).toEqual([
      expect.objectContaining({ code: 'FIELD_VALUE_KIND_CHANGED' }),
    ])
  })

  test('Given 重复 key、重复 target 与超量绑定 When 校验 Then 列表最多返回 64 项', () => {
    const field = listMediaWorkflowFields(prompt).find((item) => item.input === 'prompt')!
    const first = createMediaWorkflowFieldBinding(field)
    const duplicate = { ...first }
    const oversized: MediaWorkflowDefinition = {
      schemaVersion: 1,
      prompt,
      bindings: Array.from({ length: 129 }, (_, index) => ({
        ...first,
        key: `field-${index}`,
        nodeId: index === 0 ? '1' : 'missing',
        input: index === 0 ? 'prompt' : `input-${index}`,
      })),
      outputs: [],
    }

    expect(validateMediaWorkflowFieldBindings({ ...oversized, bindings: [first, duplicate] }).map((issue) => issue.code))
      .toEqual(['FIELD_KEY_DUPLICATE', 'FIELD_TARGET_DUPLICATE'])
    const issues = validateMediaWorkflowFieldBindings(oversized)
    expect(issues[0]?.code).toBe('FIELD_BINDING_LIMIT_EXCEEDED')
    expect(issues).toHaveLength(64)
  })

  test('Given scalar field When prepare 校验值 Then required、类型与数字约束使用同一合同', () => {
    const field = listMediaWorkflowFields(prompt).find((item) => item.input === 'seed')!
    const binding = createMediaWorkflowFieldBinding(field, 'seed')
    binding.field = { ...binding.field!, max: 9, step: 2 }

    expect(validateMediaWorkflowFieldValue(binding, undefined)).toContain('必填')
    expect(validateMediaWorkflowFieldValue(binding, 4.5)).toContain('安全整数')
    expect(validateMediaWorkflowFieldValue(binding, 10)).toContain('最大值')
    expect(validateMediaWorkflowFieldValue(binding, 7)).toContain('步长')
    expect(validateMediaWorkflowFieldValue(binding, 8)).toBeNull()
    binding.field = { ...binding.field!, required: false }
    expect(validateMediaWorkflowFieldValue(binding, undefined)).toBeNull()
  })
})
