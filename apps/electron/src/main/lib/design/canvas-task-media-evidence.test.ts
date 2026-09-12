import { expect, test } from 'bun:test'
import type { CanvasTaskEvidence, CanvasTaskRequirement } from './canvas-task-contract'
import { assertCanvasTaskMediaInspection } from './canvas-task-media-evidence'

/** 真实视频采用证据与任务条件，避免把报告正文当作视频检查。 */
const requirement: CanvasTaskRequirement = { id: 'video', description: '交付预演', nodeId: 'video-1', nodeKind: 'video',
  validation: 'adopted', mediaReview: { stage: 'preview', contentCoverage: 'sampled', requireAudio: true } }
const proof: CanvasTaskEvidence = { canvasId: 'canvas-1', nodeId: 'video-1', nodeKind: 'video', validation: 'adopted', identity: 'a'.repeat(64),
  mediaInspection: { assetHash: 'b'.repeat(64), technicalStatus: 'passed', decoded: true, coverage: 'sampled',
    sampledTimesMs: [0, 500, 1000], verdict: 'passed', notes: '已检查抽样画面，完整内容未检', hasAudio: true } }

test('Given 只有采用元数据 When 要求媒体检查 Then 拒绝无检查证据完成', () => {
  expect(() => assertCanvasTaskMediaInspection(requirement, { ...proof, mediaInspection: undefined })).toThrow('CANVAS_TASK_MEDIA_INSPECTION_REQUIRED')
})
test('Given 七个结束帧通过 When 要求完整成片 Then 不能冒充完整观看', () => {
  expect(() => assertCanvasTaskMediaInspection({ ...requirement, mediaReview: { stage: 'final', contentCoverage: 'full' } }, proof))
    .toThrow('CANVAS_TASK_MEDIA_CONTENT_COVERAGE_INCOMPLETE')
})
test('Given 静音视频 When 明确要求有声或允许静音 Then 分别拒绝或通过', () => {
  const silent = { ...proof, mediaInspection: { ...proof.mediaInspection!, hasAudio: false } }
  expect(() => assertCanvasTaskMediaInspection(requirement, silent)).toThrow('CANVAS_TASK_MEDIA_AUDIO_REQUIRED')
  expect(() => assertCanvasTaskMediaInspection({ ...requirement, mediaReview: { ...requirement.mediaReview!, requireAudio: false } }, silent)).not.toThrow()
})
test('Given 可解码但未评审或尺寸不符 When 要求样本检查 Then 明确拒绝', () => {
  expect(() => assertCanvasTaskMediaInspection(requirement, { ...proof, mediaInspection: { ...proof.mediaInspection!, verdict: 'unreviewed' } }))
    .toThrow('CANVAS_TASK_MEDIA_REVIEW_REQUIRED')
  expect(() => assertCanvasTaskMediaInspection({ ...requirement, mediaReview: { ...requirement.mediaReview!, width: 1080 } }, proof))
    .toThrow('CANVAS_TASK_MEDIA_SPECIFICATION_MISMATCH')
})
