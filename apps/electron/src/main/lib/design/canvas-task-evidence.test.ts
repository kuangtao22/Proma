import { createHash } from 'node:crypto'
import { describe, expect, test } from 'bun:test'
import type { CanvasNode } from '@proma/shared'
import type { CanvasToolProviderDependencies } from './canvas-tool-provider'
import { createCanvasTaskEvidence, resolveCanvasTaskEvidence } from './canvas-task-evidence'

const documentNode: Extract<CanvasNode, { kind: 'document' }> = {
  id: 'doc-1', kind: 'document', title: '文档', position: { x: 0, y: 0 },
  documentId: 'document-1', contentRevision: 2,
}
const webviewNode: Extract<CanvasNode, { kind: 'webview' }> = {
  id: 'web-1', kind: 'webview', title: '原型', position: { x: 0, y: 0 },
  prototypeId: 'prototype-1', contentRevision: 1, devicePreset: 'desktop',
}
const agentNode: Extract<CanvasNode, { kind: 'agent' }> = {
  id: 'agent-1', kind: 'agent', title: 'Agent', position: { x: 0, y: 0 },
  agentSessionId: 'session-1',
  outputPointer: {
    messageUuid: '11111111-1111-4111-8111-111111111111',
    contentSha256: 'a'.repeat(64), completedAt: 10,
  },
}
const imageNode: Extract<CanvasNode, { kind: 'image' }> = {
  id: 'image-1', kind: 'image', title: '图片', position: { x: 0, y: 0 },
  imageModuleId: 'image-module-1', adoptedAssetId: 'asset-current',
}
const videoNode: Extract<CanvasNode, { kind: 'video' }> = {
  id: 'video-1', kind: 'video', title: '视频', position: { x: 0, y: 0 },
  mediaModuleId: 'media-module-1',
}

/** 创建只包含证据复验所需边界的依赖，测试不访问磁盘或网络。 */
function createDependencies() {
  let agentContent = 'Agent 正式输出'
  let thumbnailBytes = Buffer.from('thumbnail-v1')
  let includeMediaAsset = true
  const adoptedOutput = {
    key: 'video.main', mediaKind: 'video' as const, role: 'primary' as const, order: 0,
    asset: { assetId: 'video-asset', revision: 1, hash: 'b'.repeat(64), mediaKind: 'video' as const },
  }
  const dependencies = {
    textArtifacts: {
      read: async (target: { kind: 'document' | 'webview' }) => ({
        content: target.kind === 'document' ? '# 正式文档' : '<main>正式原型</main>',
      }),
    },
    agentConfigs: { load: async () => ({ revision: 4 }) },
    agentOutputs: { read: async () => agentContent },
    images: {
      loadConfig: async () => ({ revision: 3, adoptedAssetId: 'asset-current' }),
      listVersions: async () => [{ jobId: 'job-history', assetId: 'asset-history', createdAt: 5 }],
      readThumbnail: async () => ({ bytes: thumbnailBytes, mediaType: 'image/png' as const }),
    },
    canvasMedia: {
      load: async () => ({
        config: { revision: 6, adoptedOutputs: [adoptedOutput] },
        assets: includeMediaAsset ? [{
          id: adoptedOutput.asset.assetId,
          revision: adoptedOutput.asset.revision,
          hash: adoptedOutput.asset.hash,
        }] : [],
      }),
    },
  } as unknown as CanvasToolProviderDependencies
  return {
    dependencies,
    setAgentContent: (value: string) => { agentContent = value },
    setThumbnailBytes: (value: string) => { thumbnailBytes = Buffer.from(value) },
    removeMediaAsset: () => { includeMediaAsset = false },
    adoptedOutput,
  }
}

describe('Canvas 任务证据复验', () => {
  test('Given 已提交文档与 WebView When 复验证据 Then 绑定当前正文版本且空占位不签发', async () => {
    const fixture = createDependencies()
    for (const node of [documentNode, webviewNode]) {
      const proof = createCanvasTaskEvidence('canvas-1', node, 'content', null)
      const result = await resolveCanvasTaskEvidence(fixture.dependencies, 'project-1', node, proof)
      const contentId = node.kind === 'document' ? node.documentId : node.prototypeId
      const content = node.kind === 'document' ? '# 正式文档' : '<main>正式原型</main>'
      expect(result).toEqual(createCanvasTaskEvidence(
        'canvas-1', node, 'content', [contentId, node.contentRevision, content],
      ))
    }

    const emptyNode = { ...documentNode, contentRevision: 0 }
    await expect(resolveCanvasTaskEvidence(
      fixture.dependencies,
      'project-1',
      emptyNode,
      createCanvasTaskEvidence('canvas-1', emptyNode, 'content', null),
    )).resolves.toBeUndefined()
  })

  test('Given Agent 正式输出与配置 When 内容或 revision 变化 Then 对应证据身份独立变化', async () => {
    const fixture = createDependencies()
    const contentProof = createCanvasTaskEvidence('canvas-1', agentNode, 'content', null)
    const configProof = createCanvasTaskEvidence('canvas-1', agentNode, 'configuration', null)
    const firstContent = await resolveCanvasTaskEvidence(fixture.dependencies, 'project-1', agentNode, contentProof)
    const config = await resolveCanvasTaskEvidence(fixture.dependencies, 'project-1', agentNode, configProof)

    fixture.setAgentContent('Agent 修改后的正式输出')
    const changedContent = await resolveCanvasTaskEvidence(fixture.dependencies, 'project-1', agentNode, contentProof)

    expect(firstContent?.identity).not.toBe(changedContent?.identity)
    expect(config).toEqual(createCanvasTaskEvidence(
      'canvas-1', agentNode, 'configuration', [agentNode.agentSessionId, 4],
    ))
  })

  test('Given 图片配置、采用图与历史图 When 复验 Then 分维度绑定任务和缩略图内容哈希', async () => {
    const fixture = createDependencies()
    const configuration = await resolveCanvasTaskEvidence(
      fixture.dependencies, 'project-1', imageNode,
      createCanvasTaskEvidence('canvas-1', imageNode, 'configuration', null),
    )
    const adopted = await resolveCanvasTaskEvidence(
      fixture.dependencies, 'project-1', imageNode,
      createCanvasTaskEvidence('canvas-1', imageNode, 'adopted', null),
    )
    const historicalProof = createCanvasTaskEvidence('canvas-1', imageNode, 'inspection', null, 'job-history')
    const historical = await resolveCanvasTaskEvidence(
      fixture.dependencies, 'project-1', imageNode, historicalProof,
    )
    const thumbnailHash = createHash('sha256').update(Buffer.from('thumbnail-v1')).digest('hex')

    expect(configuration).toEqual(createCanvasTaskEvidence(
      'canvas-1', imageNode, 'configuration', [imageNode.imageModuleId, 3],
    ))
    expect(adopted).toEqual(createCanvasTaskEvidence(
      'canvas-1', imageNode, 'adopted', [imageNode.imageModuleId, 'asset-current', thumbnailHash],
    ))
    expect(historical).toEqual(createCanvasTaskEvidence(
      'canvas-1', imageNode, 'inspection', [imageNode.imageModuleId, 'asset-history', 'job-history', thumbnailHash],
      'job-history',
    ))

    fixture.setThumbnailBytes('thumbnail-v2')
    const changed = await resolveCanvasTaskEvidence(
      fixture.dependencies, 'project-1', imageNode, historicalProof,
    )
    expect(changed?.identity).not.toBe(historical?.identity)
  })

  test('Given 音视频仅有元数据和采用资产 When 复验 Then 配置与采用可证明但内容检查保持不可用', async () => {
    const fixture = createDependencies()
    const configuration = await resolveCanvasTaskEvidence(
      fixture.dependencies, 'project-1', videoNode,
      createCanvasTaskEvidence('canvas-1', videoNode, 'configuration', null),
    )
    const adoptedProof = createCanvasTaskEvidence('canvas-1', videoNode, 'adopted', null)
    const adopted = await resolveCanvasTaskEvidence(
      fixture.dependencies, 'project-1', videoNode, adoptedProof,
    )
    const inspection = await resolveCanvasTaskEvidence(
      fixture.dependencies, 'project-1', videoNode,
      createCanvasTaskEvidence('canvas-1', videoNode, 'inspection', null),
    )

    expect(configuration).toEqual(createCanvasTaskEvidence(
      'canvas-1', videoNode, 'configuration', [videoNode.mediaModuleId, 6],
    ))
    expect(adopted).toEqual(createCanvasTaskEvidence(
      'canvas-1', videoNode, 'adopted', [videoNode.mediaModuleId, [fixture.adoptedOutput]],
    ))
    expect(inspection).toBeUndefined()

    fixture.removeMediaAsset()
    await expect(resolveCanvasTaskEvidence(
      fixture.dependencies, 'project-1', videoNode, adoptedProof,
    )).resolves.toBeUndefined()
  })
})
