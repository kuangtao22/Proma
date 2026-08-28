import { describe, expect, test } from 'bun:test'
import { applyCanvasMutations, createEmptyCanvasDocument } from '@proma/shared'
import type { CanvasChangeEvent, CanvasDocument, CanvasImageModuleConfig } from '@proma/shared'
import { createCanvasImageJobTargetAdapter } from './canvas-image-job-target'
import type { CanvasImageJobTarget } from './canvas-image-job-target'

/** 创建图片模块的完整业务身份。 */
function createTarget(suffix: string): CanvasImageJobTarget {
  return {
    kind: 'canvas-image', canvasId: 'canvas-1',
    nodeId: `image-node-${suffix}`, imageModuleId: `image-module-${suffix}`,
  }
}

/** 创建可执行采用事务的最小测试环境。 */
function createFixture() {
  const targetA = createTarget('a')
  const targetB = createTarget('b')
  let document: CanvasDocument = createEmptyCanvasDocument('project-1', 'canvas-1', 1)
  document.nodes = [targetA, targetB].map((target) => ({
    id: target.nodeId,
    kind: 'image' as const,
    title: target.nodeId,
    position: { x: 0, y: 0 },
    imageModuleId: target.imageModuleId,
  }))
  const configs = new Map<string, CanvasImageModuleConfig>([targetA, targetB].map((target) => [
    target.imageModuleId,
    {
      schemaVersion: 2, kind: 'image', contentId: target.imageModuleId,
      revision: 0, createdAt: 1, updatedAt: 1, prompt: '',
      selectedModelProfileId: null, aspectRatio: '1:1', imageSize: 'auto',
      contextMode: 'auto', adoptedAssetId: null,
    },
  ]))
  /** 记录节点投影提交后对 Renderer 发布的图变化事件。 */
  const canvasChanges: CanvasChangeEvent[] = []
  const adapter = createCanvasImageJobTargetAdapter({
    canvasStore: {
      requireStableAuthoritativeDocument: () => document,
      mutate: (_target, expectedRevision, mutations) => {
        if (expectedRevision !== document.revision) throw new Error('CANVAS_REVISION_CONFLICT')
        document = {
          ...applyCanvasMutations(document, mutations),
          revision: document.revision + 1,
          updatedAt: document.updatedAt + 1,
        }
        return document
      },
    },
    imageStore: {
      load: async (target) => structuredClone(configs.get(target.imageModuleId)!),
      adoptAsset: async (target, expectedRevision, assetId) => {
        const current = configs.get(target.imageModuleId)!
        if (current.revision !== expectedRevision) throw new Error('CANVAS_IMAGE_REVISION_CONFLICT')
        const next = {
          ...current,
          revision: current.revision + 1,
          updatedAt: current.updatedAt + 1,
          adoptedAssetId: assetId,
        }
        configs.set(target.imageModuleId, next)
        return structuredClone(next)
      },
    },
    onCanvasChanged: (event) => { canvasChanges.push(event) },
  })
  return { adapter, canvasChanges, configs, targetA, targetB, get document() { return document } }
}

describe('Canvas 图片 Job 目标适配器', () => {
  test('Given A 与 B 独立图片模块 When A 采用输出 Then 只更新 A 配置和节点投影', async () => {
    const fixture = createFixture()
    const beforeB = structuredClone(fixture.configs.get(fixture.targetB.imageModuleId))

    await fixture.adapter.adoptOutput('project-1', fixture.targetA, 'asset-a')

    expect(fixture.configs.get(fixture.targetA.imageModuleId)?.adoptedAssetId).toBe('asset-a')
    expect(fixture.document.nodes.find((node) => node.id === fixture.targetA.nodeId))
      .toMatchObject({ kind: 'image', adoptedAssetId: 'asset-a' })
    expect(fixture.configs.get(fixture.targetB.imageModuleId)).toEqual(beforeB)
    expect(fixture.document.nodes.find((node) => node.id === fixture.targetB.nodeId))
      .not.toHaveProperty('adoptedAssetId')
    expect(await fixture.adapter.isOutputAdopted('project-1', fixture.targetA, 'asset-a')).toBe(true)
    expect(fixture.canvasChanges).toEqual([{
      projectId: 'project-1', canvasId: 'canvas-1', revision: 1, cause: 'graph',
    }])
  })

  test('Given 配置已采用但节点投影滞后 When 重放采用 Then 只修复节点投影', async () => {
    const fixture = createFixture()
    const current = fixture.configs.get(fixture.targetA.imageModuleId)!
    fixture.configs.set(fixture.targetA.imageModuleId, { ...current, adoptedAssetId: 'asset-a' })

    expect(await fixture.adapter.isOutputAdopted('project-1', fixture.targetA, 'asset-a')).toBe(false)
    await fixture.adapter.adoptOutput('project-1', fixture.targetA, 'asset-a')

    expect(await fixture.adapter.isOutputAdopted('project-1', fixture.targetA, 'asset-a')).toBe(true)
    expect(fixture.canvasChanges).toEqual([{
      projectId: 'project-1', canvasId: 'canvas-1', revision: 1, cause: 'graph',
    }])
  })
})
