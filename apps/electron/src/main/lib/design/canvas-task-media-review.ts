import type { MediaAssetRef } from '@proma/shared'
import type { AgentToolResult } from '@earendil-works/pi-agent-core'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { MediaDeliveryInspectionResult } from '../media/media-delivery-inspection-service'
import type { CanvasTaskEvidence, createCanvasTaskContract } from './canvas-task-contract'
import { createCanvasMediaReviewTools } from './canvas-media-review-tools'

/** 当前正式主素材及其版本证据，必须由 Provider fresh-read 提供。 */
export interface CanvasTaskMediaTarget {
  asset: MediaAssetRef
  proof: CanvasTaskEvidence
}

/** 媒体工具复用同一合同实例，外部只提供受授权的实际资产读取。 */
interface CanvasTaskMediaReviewDependencies {
  getTask: () => ReturnType<typeof createCanvasTaskContract>
  readTarget: (canvasId: string, nodeId: string, signal: AbortSignal) => Promise<CanvasTaskMediaTarget>
  inspect: (asset: MediaAssetRef, signal: AbortSignal) => Promise<MediaDeliveryInspectionResult>
  verifyAsset: (asset: MediaAssetRef, signal: AbortSignal) => Promise<void>
}

/** 将可序列化摘要作为文本回执，原始帧只在本次模型工具结果中传递。 */
function result(details: Record<string, unknown>): AgentToolResult<unknown> {
  return { content: [{ type: 'text', text: JSON.stringify(details) }], details }
}

/** 将媒体检查接到真实任务证据，不缓存媒体字节，不允许抽样冒充全片验收。 */
export function createCanvasTaskMediaReview(dependencies: CanvasTaskMediaReviewDependencies): ToolDefinition[] {
  /** 仅保存本轮已实际提供样本的证据 ID；跨回合未评审检查须重新读取样本。 */
  const deliveredSamples = new Set<string>()
  return createCanvasMediaReviewTools({
    inspect: async (input, signal) => {
      const task = dependencies.getTask()
      const current = await dependencies.readTarget(input.canvasId, input.nodeId, signal)
      const inspected = await dependencies.inspect(current.asset, signal)
      /** 解码可能较慢，返回前复读当前采用版本及权限，拒绝旧素材检查覆盖新成果。 */
      const latest = await dependencies.readTarget(input.canvasId, input.nodeId, signal)
      if (latest.proof.identity !== current.proof.identity || dependencies.getTask() !== task) {
        throw new Error('CANVAS_TASK_EVIDENCE_STALE')
      }
      const summary = inspected.summary
      const facts = summary.technical.facts
      const proof: CanvasTaskEvidence = { ...current.proof, mediaInspection: {
        assetHash: current.asset.hash, technicalStatus: summary.technical.status,
        decoded: summary.decodeCoverage === 'full', coverage: summary.coverage === 'sampled' ? 'sampled' : 'none',
        sampledTimesMs: [...summary.sampledTimesMs], verdict: 'unreviewed',
        notes: '技术检查与有限抽样；完整画面、动作、音频内容及同步尚未验收。',
        ...(facts ? { durationMs: Math.round(facts.durationMs) } : {}),
        ...(facts?.mediaKind === 'video' ? { width: facts.width, height: facts.height,
          hasAudio: facts.hasAudio, ...(facts.fps === null ? {} : { fps: facts.fps }) } : {}),
      } }
      const evidence = task.record(proof)
      if (inspected.samples.length > 0) {
        if (deliveredSamples.size >= 256) deliveredSamples.delete(deliveredSamples.values().next().value!)
        deliveredSamples.add(evidence.evidenceId)
      }
      const response = result({ canvasId: input.canvasId, nodeId: input.nodeId, evidence,
        inspectionEvidenceId: evidence.evidenceId, inspection: summary,
        fullContentReviewed: false, audioContentReviewed: false,
        nextAction: inspected.samples.length ? { tool: 'canvas_review_media', ...input,
          inspectionEvidenceId: evidence.evidenceId, coverage: 'sampled' } : undefined })
      for (const sample of inspected.samples) {
        response.content.push({ type: 'text', text: `抽样时间：${sample.timeMs} ms（仅此帧）` },
          { type: 'image', mimeType: sample.mediaType, data: Buffer.from(sample.bytes).toString('base64') })
      }
      return response
    },
    review: async (input, signal) => {
      const task = dependencies.getTask()
      const source = task.exportState().proofs.find(item => item.evidenceId === input.inspectionEvidenceId)?.evidence
      if (!source?.mediaInspection || source.canvasId !== input.canvasId || source.nodeId !== input.nodeId) {
        throw new Error('CANVAS_MEDIA_INSPECTION_EVIDENCE_NOT_FOUND')
      }
      if (input.coverage === 'full') throw new Error('MEDIA_REVIEW_COVERAGE_OVERCLAIMED')
      if (!deliveredSamples.has(input.inspectionEvidenceId) || source.mediaInspection.coverage !== 'sampled'
        || source.mediaInspection.sampledTimesMs.length === 0) throw new Error('CANVAS_MEDIA_SAMPLES_REQUIRED')
      const current = await dependencies.readTarget(input.canvasId, input.nodeId, signal)
      if (current.proof.identity !== source.identity || current.asset.hash !== source.mediaInspection.assetHash) {
        throw new Error('CANVAS_TASK_EVIDENCE_STALE')
      }
      await dependencies.verifyAsset(current.asset, signal)
      const latest = await dependencies.readTarget(input.canvasId, input.nodeId, signal)
      if (latest.proof.identity !== source.identity || dependencies.getTask() !== task) throw new Error('CANVAS_TASK_EVIDENCE_STALE')
      const evidence = task.record({ ...source, mediaInspection: { ...source.mediaInspection,
        coverage: 'sampled', verdict: input.verdict, notes: input.notes } })
      return result({ canvasId: input.canvasId, nodeId: input.nodeId, evidence, coverage: 'sampled',
        verdict: input.verdict, fullContentReviewed: false, audioContentReviewed: false,
        unchecked: ['full-video-content', 'audio-content', 'audio-video-sync'] })
    },
  })
}
