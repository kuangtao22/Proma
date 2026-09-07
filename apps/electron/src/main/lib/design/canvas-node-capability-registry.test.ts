import { describe, expect, test } from 'bun:test'
import type { CanvasNode } from '@proma/shared'
import { canvasNodeCapabilityRegistry } from './canvas-node-capability-registry'

/** 构造覆盖全部节点类别的最小权威节点。 */
function createNode(kind: CanvasNode['kind']): CanvasNode {
  const base = { id: `${kind}-1`, kind, title: kind, position: { x: 0, y: 0 } }
  switch (kind) {
    case 'agent': return { ...base, kind, agentSessionId: 'session-1' }
    case 'image': return { ...base, kind, imageModuleId: 'image-module-1' }
    case 'audio':
    case 'video': return { ...base, kind, mediaModuleId: 'media-module-1' }
    case 'document': return { ...base, kind, documentId: 'document-1', contentRevision: 1 }
    case 'webview': return { ...base, kind, prototypeId: 'prototype-1', contentRevision: 1, devicePreset: 'desktop' }
  }
}

describe('Canvas 节点能力注册表', () => {
  test('Given 当前四类可用节点 When 枚举能力 Then 返回稳定、有界且无重复的派生能力', () => {
    expect(canvasNodeCapabilityRegistry.list(createNode('agent'), { availability: 'available' }))
      .toEqual(['read', 'update-config', 'run', 'rebuild'])
    expect(canvasNodeCapabilityRegistry.list(createNode('image'), { availability: 'available' }))
      .toEqual([
        'read', 'preview', 'update-config', 'run', 'review-required',
        'task-status', 'task-control', 'versions', 'adopt-version', 'export',
      ])
    expect(canvasNodeCapabilityRegistry.list(createNode('document'), { availability: 'available' }))
      .toEqual(['read', 'update-content', 'versions', 'adopt-version', 'export'])
    expect(canvasNodeCapabilityRegistry.list(createNode('webview'), { availability: 'available' }))
      .toEqual(['read', 'update-content', 'versions', 'adopt-version', 'export'])

    for (const kind of ['agent', 'image', 'audio', 'video', 'document', 'webview'] as const) {
      const capabilities = canvasNodeCapabilityRegistry.list(createNode(kind), { availability: 'available' })
      expect(capabilities.length).toBeLessThanOrEqual(10)
      expect(new Set(capabilities).size).toBe(capabilities.length)
    }
  })

  test('Given 节点不可用或损坏 When 枚举能力 Then 绝不公开运行能力', () => {
    for (const availability of ['unavailable', 'corrupt'] as const) {
      for (const kind of ['agent', 'image', 'audio', 'video'] as const) {
        expect(canvasNodeCapabilityRegistry.list(createNode(kind), { availability })).not.toContain('run')
      }
    }
  })

  test('Given 节点不支持目标能力 When 预检 Then 使用稳定错误拒绝', () => {
    expect(() => canvasNodeCapabilityRegistry.assert(createNode('document'), 'run'))
      .toThrow('CANVAS_NODE_CAPABILITY_UNSUPPORTED')
    expect(() => canvasNodeCapabilityRegistry.assert(createNode('agent'), 'update-content'))
      .toThrow('CANVAS_NODE_CAPABILITY_UNSUPPORTED')
  })

  test('Given 实际工具清单和 plan 上限 When 枚举能力 Then 使用兼容 fallback 且隐藏写能力', () => {
    const fallbackTools = new Set(['canvas_read', 'canvas_update_artifact', 'canvas_list_versions'])
    expect(canvasNodeCapabilityRegistry.list(createNode('image'), {
      availability: 'available', availableToolNames: fallbackTools, permissionCeiling: 'execute',
    })).toEqual(['read', 'update-config', 'review-required', 'versions'])

    const completeTools = new Set([
      'canvas_read', 'canvas_inspect_images', 'canvas_update_image_config', 'canvas_run_nodes',
      'canvas_get_task', 'canvas_cancel_task', 'canvas_list_versions', 'canvas_adopt_version',
      'canvas_export_artifact',
    ])
    expect(canvasNodeCapabilityRegistry.list(createNode('image'), {
      availability: 'available', availableToolNames: completeTools, permissionCeiling: 'plan',
    })).toEqual(['read', 'preview', 'review-required', 'task-status', 'versions'])

    /** 批次采用是图片节点的 adopt-version 兼容入口，不向文档节点错误扩权。 */
    const batchOnlyTools = new Set(['canvas_read', 'canvas_adopt_candidate_batch'])
    expect(canvasNodeCapabilityRegistry.list(createNode('image'), {
      availability: 'available', availableToolNames: batchOnlyTools, permissionCeiling: 'execute',
    })).toContain('adopt-version')
    expect(canvasNodeCapabilityRegistry.list(createNode('document'), {
      availability: 'available', availableToolNames: batchOnlyTools, permissionCeiling: 'execute',
    })).not.toContain('adopt-version')
  })
})
