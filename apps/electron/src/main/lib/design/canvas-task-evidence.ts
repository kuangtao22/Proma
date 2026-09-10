import { createHash } from 'node:crypto'
import type { CanvasNode } from '@proma/shared'
import type { CanvasToolProviderDependencies } from './canvas-tool-provider'
import type { CanvasTaskAbsentArtifact, CanvasTaskEvidence } from './canvas-task-contract'

/** 将真实版本事实压成无正文、无路径的证据身份。 */
export function createCanvasTaskEvidence(
  canvasId: string, node: CanvasNode, validation: CanvasTaskEvidence['validation'], value: unknown, jobId?: string,
): CanvasTaskEvidence {
  return { canvasId, nodeId: node.id, nodeKind: node.kind, validation,
    identity: createHash('sha256').update(JSON.stringify(value)).digest('hex'), ...(jobId ? { jobId } : {}) }
}

/** 按精确节点和已签发维度复读证据；调用方负责前后复验作用域与图版本。 */
async function resolveCanvasTaskFact(
  dependencies: CanvasToolProviderDependencies, projectId: string, node: CanvasNode, proof: CanvasTaskEvidence,
  /** 仅任务启动基线可记录确定的空产物；完成证据始终要求真实交付。 */
  allowAbsent = false,
): Promise<CanvasTaskEvidence | CanvasTaskAbsentArtifact | undefined> {
  /** 不接受以同 ID 的另一类节点替代原产物。 */
  if (node.kind !== proof.nodeKind) return undefined
  const target = { projectId, canvasId: proof.canvasId, nodeId: node.id }
  const create = (value: unknown) => createCanvasTaskEvidence(proof.canvasId, node, proof.validation, value, proof.jobId)
  /** absence 与可交付证据采用不同类型，空基线永远不能进入 record。 */
  const absent = (): CanvasTaskAbsentArtifact => ({ canvasId: proof.canvasId, nodeId: node.id,
    nodeKind: node.kind, validation: proof.validation, absent: true })
  if (node.kind === 'document' || node.kind === 'webview') {
    const contentId = node.kind === 'document' ? node.documentId : node.prototypeId
    if (proof.validation !== 'content') return undefined
    if (node.contentRevision < 1) return allowAbsent && node.contentRevision === 0 ? absent() : undefined
    const snapshot = await dependencies.textArtifacts.read({ ...target, kind: node.kind, contentId, contentRevision: node.contentRevision })
    return snapshot.content.trim() ? create([contentId, node.contentRevision, snapshot.content]) : undefined
  }
  if (node.kind === 'agent') {
    if (proof.validation === 'configuration') {
      const config = await dependencies.agentConfigs.load(target)
      return create([node.agentSessionId, config.revision])
    }
    if (proof.validation !== 'content') return undefined
    if (!node.outputPointer) return allowAbsent ? absent() : undefined
    const content = await dependencies.agentOutputs.read(target)
    return content.trim() ? create([node.agentSessionId, node.outputPointer, content]) : undefined
  }
  if (node.kind === 'image') {
    const imageTarget = { ...target, imageModuleId: node.imageModuleId }
    const config = await dependencies.images.loadConfig(imageTarget)
    if (proof.validation === 'configuration') return create([node.imageModuleId, config.revision])
    if (proof.validation === 'inspection') {
      const versions = proof.jobId ? await dependencies.images.listVersions(imageTarget) : []
      const assetId = proof.jobId ? versions.find(version => version.jobId === proof.jobId)?.assetId : config.adoptedAssetId
      if (!assetId) return allowAbsent && !proof.jobId && !node.adoptedAssetId && !config.adoptedAssetId
        ? absent() : undefined
      if (!proof.jobId && node.adoptedAssetId !== assetId) return undefined
      const thumbnail = await dependencies.images.readThumbnail(projectId, assetId)
      return create([node.imageModuleId, assetId, proof.jobId ?? null, createHash('sha256').update(thumbnail.bytes).digest('hex')])
    }
    if (proof.validation !== 'adopted') return undefined
    if (!config.adoptedAssetId) return allowAbsent && !node.adoptedAssetId ? absent() : undefined
    if (config.adoptedAssetId !== node.adoptedAssetId) return undefined
    const thumbnail = await dependencies.images.readThumbnail(projectId, config.adoptedAssetId)
    return create([node.imageModuleId, config.adoptedAssetId, createHash('sha256').update(thumbnail.bytes).digest('hex')])
  }
  const media = await dependencies.canvasMedia.load({ ...target, mediaModuleId: node.mediaModuleId, mediaKind: node.kind })
  if (proof.validation === 'configuration') return create([node.mediaModuleId, media.config.revision])
  if (proof.validation !== 'adopted') return undefined
  if (media.config.adoptedOutputs.length === 0) return allowAbsent ? absent() : undefined
  /** 正式素材必须仍然存在；元数据不提供 inspection 证据。 */
  if (media.config.adoptedOutputs.some(output => !media.assets.some(asset => asset.id === output.asset.assetId
    && asset.revision === output.asset.revision && asset.hash === output.asset.hash))) return undefined
  return create([node.mediaModuleId, media.config.adoptedOutputs])
}

/** 完成验收只返回真实产物；即使空状态合法，也不能签发交付证据。 */
export async function resolveCanvasTaskEvidence(
  dependencies: CanvasToolProviderDependencies, projectId: string, node: CanvasNode, proof: CanvasTaskEvidence,
): Promise<CanvasTaskEvidence | undefined> {
  const fact = await resolveCanvasTaskFact(dependencies, projectId, node, proof)
  return fact && !('absent' in fact) ? fact : undefined
}

/** 启动时区分空草稿与读取故障，使同一节点可从未交付推进到首次正式产物。 */
export function resolveCanvasTaskBaseline(
  dependencies: CanvasToolProviderDependencies, projectId: string, node: CanvasNode, proof: CanvasTaskEvidence,
): Promise<CanvasTaskEvidence | CanvasTaskAbsentArtifact | undefined> {
  return resolveCanvasTaskFact(dependencies, projectId, node, proof, true)
}
