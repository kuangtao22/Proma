import type { CanvasTaskEvidence, CanvasTaskRequirement } from './canvas-task-contract'

/** 核验声明的媒体阶段、技术条件和实际内容检查范围。 */
export function assertCanvasTaskMediaInspection(requirement: CanvasTaskRequirement, proof: CanvasTaskEvidence): void {
  /** 未声明媒体验收的旧合同仍遵守原证据规则。 */
  const expected = requirement.mediaReview
  if (!expected) return
  /** 检查摘要由 Host 签发；普通采用元数据不能代替真实文件检查。 */
  const inspection = proof.mediaInspection
  if (!inspection) throw new Error('CANVAS_TASK_MEDIA_INSPECTION_REQUIRED')
  if (inspection.technicalStatus !== 'passed' || !inspection.decoded) {
    throw new Error('CANVAS_TASK_MEDIA_TECHNICAL_CHECK_FAILED')
  }
  if (expected.requireAudio === true && inspection.hasAudio !== true) {
    throw new Error('CANVAS_TASK_MEDIA_AUDIO_REQUIRED')
  }
  if ((expected.width !== undefined && inspection.width !== expected.width)
    || (expected.height !== undefined && inspection.height !== expected.height)
    || (expected.minDurationSeconds !== undefined
      && (inspection.durationMs === undefined || inspection.durationMs < expected.minDurationSeconds * 1000))
    || (expected.maxDurationSeconds !== undefined
      && (inspection.durationMs === undefined || inspection.durationMs > expected.maxDurationSeconds * 1000))) {
    throw new Error('CANVAS_TASK_MEDIA_SPECIFICATION_MISMATCH')
  }
  if ((expected.contentCoverage === 'full' && inspection.coverage !== 'full')
    || (expected.contentCoverage === 'sampled'
      && (inspection.coverage === 'none' || inspection.sampledTimesMs.length === 0))) {
    throw new Error('CANVAS_TASK_MEDIA_CONTENT_COVERAGE_INCOMPLETE')
  }
  if (expected.contentCoverage !== 'technical' && inspection.verdict !== 'passed') {
    throw new Error('CANVAS_TASK_MEDIA_REVIEW_REQUIRED')
  }
}
