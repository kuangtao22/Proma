import { execFile } from 'node:child_process'
import { closeSync, openSync, readSync } from 'node:fs'
import type { MediaAssetRef } from '@proma/shared'
import { probeMediaFile, type ProbedMediaFile } from './media-file-probe'
import type { MediaAssetFile, MediaSourceContext } from './media-source-service'

const MAX_MEDIA_BYTES = 128 * 1024 * 1024
const MAX_VIDEO_PIXELS = 33_177_600
const MAX_DURATION_MS = 30 * 60 * 1_000
const MAX_VISUAL_SAMPLES = 12
const MAX_SAMPLE_EDGE = 768
const MAX_SAMPLE_BYTES = 8 * 1024 * 1024
const DECODE_TIMEOUT_MS = 120_000
const DECODE_MAX_BUFFER = 64 * 1024
const FFMPEG_CANDIDATES = ['/usr/bin/ffmpeg', '/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', 'ffmpeg']

/** 数值交付条件支持精确值或上下界，精确帧率可配置容差。 */
export interface MediaNumericRequirement {
  exact?: number
  min?: number
  max?: number
  tolerance?: number
}

/** Host 对单个音视频交付物执行的技术规格和可选抽帧要求。 */
export interface MediaDeliveryRequirements {
  width?: MediaNumericRequirement
  height?: MediaNumericRequirement
  durationMs?: MediaNumericRequirement
  fps?: MediaNumericRequirement
  audioPolicy: 'required' | 'optional' | 'forbidden'
  visualSamples?: { count: number }
}

export type MediaInspectionCheckStatus = 'pass' | 'fail' | 'unchecked'

/** 固定字段让调用方能区分未要求、检查通过与技术失败。 */
export interface MediaDeliveryChecks {
  width: MediaInspectionCheckStatus
  height: MediaInspectionCheckStatus
  durationMs: MediaInspectionCheckStatus
  fps: MediaInspectionCheckStatus
  audio: MediaInspectionCheckStatus
  decode: MediaInspectionCheckStatus
}

/** 可序列化的视频或音频技术事实，不携带文件路径或媒体字节。 */
export type MediaDeliveryTechnicalFacts =
  | { mediaKind: 'video'; width: number; height: number; durationMs: number; fps: number | null; codec: string; hasAudio: boolean }
  | { mediaKind: 'audio'; durationMs: number; sampleRate: number; channels: number; codec: string }

/** Host 技术检查状态只描述机器实际完成的工作。 */
export interface MediaDeliveryTechnicalResult {
  status: 'passed' | 'failed' | 'unavailable'
  facts?: MediaDeliveryTechnicalFacts
}

/** 可持久化的检查摘要；路径和抽帧字节均不进入该对象。 */
export interface MediaDeliveryInspectionSummary {
  asset: MediaAssetRef
  evidenceHash: string
  technical: MediaDeliveryTechnicalResult
  checks: MediaDeliveryChecks
  probe: { status: 'available' } | { status: 'unavailable' | 'failed'; code: string }
  coverage: 'technical' | 'sampled' | 'full'
  decodeCoverage: 'none' | 'full'
  sampledTimesMs: number[]
  audioCoverage: 'none' | 'technical'
  contentVerdict: 'unknown'
  checkedConditions: string[]
  unchecked: string[]
}

/** 抽帧字节只供本次模型调用，调用方不得写入任务或聊天持久化记录。 */
export interface MediaDeliveryVisualSample {
  timeMs: number
  mediaType: 'image/jpeg'
  bytes: Uint8Array
}

/** summary 可安全持久化，samples 是必须在调用结束后释放的临时证据。 */
export interface MediaDeliveryInspectionResult {
  summary: MediaDeliveryInspectionSummary
  samples: MediaDeliveryVisualSample[]
}

/** 可注入命令执行器使边界测试无需依赖开发机安装 ffmpeg。 */
export interface MediaDeliveryInspectionExecuteOptions {
  timeout: number
  maxBuffer: number
  signal?: AbortSignal
}

/** 执行器固定接收可执行文件和参数数组，禁止 shell 字符串。 */
export type MediaDeliveryInspectionExecute = (
  file: string,
  args: readonly string[],
  options: MediaDeliveryInspectionExecuteOptions,
) => Promise<{ stdout: Uint8Array; stderr: string }>

/** 服务只依赖 Host 的可信资产入口，不能接收任意路径。 */
export interface MediaDeliveryInspectionDependencies {
  withAssetFile<T>(
    context: MediaSourceContext,
    asset: MediaAssetRef,
    maxBytes: number,
    effect: (snapshot: MediaAssetFile) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T>
  probe?: (path: string, signatureBytes: Uint8Array) => Promise<ProbedMediaFile>
  execute?: MediaDeliveryInspectionExecute
}

/** Agent 内容评审必须准确声明它实际看到的范围。 */
export interface MediaReviewClaim {
  coverage: 'technical' | 'sampled' | 'full'
  verdict: 'passed' | 'failed'
  checkedConditions: string[]
  unchecked: string[]
}

/** 验证后的 Agent 评审与 Host 技术证明分开保存。 */
export interface ValidatedMediaReview extends MediaReviewClaim {
  source: 'agent-assessment'
  evidenceHash: string
  sampledTimesMs: number[]
}

/** 进程级串行队列限制大型媒体同时解码，等待期间仍可取消。 */
class MediaInspectionQueue {
  private tail: Promise<void> = Promise.resolve()

  /** 取得唯一执行权；任一任务结束后释放后继。 */
  async run<T>(effect: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    throwIfAborted(signal)
    const previous = this.tail
    let release: () => void = () => undefined
    let acquired = false
    this.tail = new Promise<void>((resolve) => { release = resolve })
    try {
      await waitForTurn(previous, signal)
      acquired = true
      throwIfAborted(signal)
      return await effect()
    } finally {
      /** 等待期间取消可以立即返回，但当前 ticket 必须留到前序结束才释放后继。 */
      if (acquired) release()
      else void previous.then(release, release)
    }
  }
}

const inspectionQueue = new MediaInspectionQueue()

/** 使用 execFile 直接执行，保留 AbortSignal、超时与输出上限。 */
const defaultExecute: MediaDeliveryInspectionExecute = async (file, args, options) => await new Promise((resolve, reject) => {
  execFile(file, [...args], {
    encoding: 'buffer',
    windowsHide: true,
    timeout: options.timeout,
    maxBuffer: options.maxBuffer,
    signal: options.signal,
  }, (error, stdout, stderr) => {
    if (error) { reject(error); return }
    resolve({ stdout: new Uint8Array(stdout), stderr: Buffer.from(stderr).toString('utf8') })
  })
})

/** 在队列等待和命令执行边界统一抛标准 AbortError。 */
function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return
  const error = new Error('媒体检查已取消')
  error.name = 'AbortError'
  throw error
}

/** 等待前序任务时监听取消，避免取消请求被长视频阻塞。 */
async function waitForTurn(previous: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) { await previous; return }
  await new Promise<void>((resolve, reject) => {
    /** 前序任务结束或取消时都必须移除另一侧监听。 */
    const onAbort = (): void => {
      signal.removeEventListener('abort', onAbort)
      const error = new Error('媒体检查已取消')
      error.name = 'AbortError'
      reject(error)
    }
    signal.addEventListener('abort', onAbort, { once: true })
    void previous.then(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, reject)
  })
}

/** 只读签名头供 ffprobe 验证容器，不把完整媒体复制进第二份内存。 */
function readSignatureBytes(path: string): Uint8Array {
  const descriptor = openSync(path, 'r')
  try {
    const bytes = Buffer.alloc(64)
    const length = readSync(descriptor, bytes, 0, bytes.byteLength, 0)
    return bytes.subarray(0, length)
  } finally {
    closeSync(descriptor)
  }
}

/** 检查注入或默认命令失败是否只是当前候选不存在。 */
function isMissingExecutable(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

/** 保留取消语义，避免将取消误报为工具故障。 */
function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

/** 按固定可信候选执行 ffmpeg，所有候选缺失时返回结构化 unavailable。 */
async function executeFfmpeg(
  execute: MediaDeliveryInspectionExecute,
  args: readonly string[],
  options: MediaDeliveryInspectionExecuteOptions,
): Promise<{ status: 'ok'; stdout: Uint8Array } | { status: 'unavailable' | 'failed' }> {
  for (const candidate of FFMPEG_CANDIDATES) {
    try {
      const result = await execute(candidate, args, options)
      return { status: 'ok', stdout: result.stdout }
    } catch (error) {
      if (isAbortError(error)) throw error
      if (!isMissingExecutable(error)) return { status: 'failed' }
    }
  }
  return { status: 'unavailable' }
}

/** 校验 Host 返回仍精确对应调用方资产引用。 */
function assertExactAssetFile(file: MediaAssetFile, asset: MediaAssetRef): void {
  if (file.asset.assetId !== asset.assetId || file.asset.revision !== asset.revision
    || file.asset.hash !== asset.hash || file.asset.mediaKind !== asset.mediaKind
    || file.record.id !== asset.assetId || file.record.revision !== asset.revision
    || file.record.hash !== asset.hash || file.record.mediaKind !== asset.mediaKind) {
    throw new Error('MEDIA_ASSET_CHANGED')
  }
}

/** 限制解码尺寸、时长和文件大小，避免恶意媒体造成无界资源占用。 */
function assertResourceLimits(file: MediaAssetFile, probe?: ProbedMediaFile): void {
  if (file.record.byteSize > MAX_MEDIA_BYTES) throw new Error('MEDIA_INSPECTION_RESOURCE_LIMIT')
  if (!probe && file.record.mediaKind === 'image') throw new Error('MEDIA_INSPECTION_MEDIA_KIND_UNSUPPORTED')
  const metadata = probe?.metadata ?? (file.record.mediaKind === 'image' ? undefined : file.record.metadata)
  if (!metadata) throw new Error('MEDIA_INSPECTION_MEDIA_KIND_UNSUPPORTED')
  if (metadata.durationMs > MAX_DURATION_MS) throw new Error('MEDIA_INSPECTION_RESOURCE_LIMIT')
  if ('width' in metadata && metadata.width * metadata.height > MAX_VIDEO_PIXELS) {
    throw new Error('MEDIA_INSPECTION_RESOURCE_LIMIT')
  }
}

/** 判断单个有限数值是否满足显式规格。 */
function matchesRequirement(value: number | null, requirement?: MediaNumericRequirement): MediaInspectionCheckStatus {
  if (!requirement) return 'unchecked'
  if (value === null || !Number.isFinite(value)) return 'fail'
  const tolerance = requirement.tolerance ?? 0
  if (requirement.exact !== undefined && Math.abs(value - requirement.exact) > tolerance) return 'fail'
  if (requirement.min !== undefined && value < requirement.min) return 'fail'
  if (requirement.max !== undefined && value > requirement.max) return 'fail'
  return 'pass'
}

/** 将探测联合类型缩减为无路径、可序列化的技术事实。 */
function technicalFacts(probed: ProbedMediaFile): MediaDeliveryTechnicalFacts {
  return probed.mediaKind === 'video'
    ? { mediaKind: 'video', ...probed.metadata }
    : { mediaKind: 'audio', ...probed.metadata }
}

/** 根据媒体事实计算规格检查，不把未提供的规格伪装为通过。 */
function evaluateChecks(probed: ProbedMediaFile, requirements: MediaDeliveryRequirements): MediaDeliveryChecks {
  const video = probed.mediaKind === 'video' ? probed.metadata : undefined
  const hasAudio = probed.mediaKind === 'audio' || video?.hasAudio === true
  return {
    width: matchesRequirement(video?.width ?? null, requirements.width),
    height: matchesRequirement(video?.height ?? null, requirements.height),
    durationMs: matchesRequirement(probed.metadata.durationMs, requirements.durationMs),
    fps: matchesRequirement(video?.fps ?? null, requirements.fps),
    audio: requirements.audioPolicy === 'optional' ? 'pass'
      : requirements.audioPolicy === 'required' ? (hasAudio ? 'pass' : 'fail')
        : (hasAudio ? 'fail' : 'pass'),
    decode: 'unchecked',
  }
}

/** 生成覆盖全时长的均匀样本时间，不抽取末尾边界外帧。 */
function sampleTimes(durationMs: number, requested: number): number[] {
  const count = Math.min(MAX_VISUAL_SAMPLES, Math.max(0, Math.floor(requested)))
  return Array.from({ length: count }, (_unused, index) => Math.floor(durationMs * (index + 0.5) / count))
}

/** 将已执行的检查字段转换为可审计条件列表。 */
function checkedConditions(checks: MediaDeliveryChecks): string[] {
  return (Object.entries(checks) as Array<[keyof MediaDeliveryChecks, MediaInspectionCheckStatus]>)
    .filter(([, status]) => status !== 'unchecked')
    .map(([name]) => name)
}

/** 判断所有实际执行的技术检查是否通过。 */
function technicalStatus(checks: MediaDeliveryChecks): 'passed' | 'failed' {
  return Object.values(checks).some((status) => status === 'fail') ? 'failed' : 'passed'
}

/** 构造工具缺失摘要，明确所有未检查项并保持证据哈希。 */
function unavailableSummary(asset: MediaAssetRef): MediaDeliveryInspectionSummary {
  return {
    asset: structuredClone(asset), evidenceHash: asset.hash,
    technical: { status: 'unavailable' },
    checks: { width: 'unchecked', height: 'unchecked', durationMs: 'unchecked', fps: 'unchecked', audio: 'unchecked', decode: 'unchecked' },
    probe: { status: 'unavailable', code: 'MEDIA_INSPECTION_TOOL_UNAVAILABLE' },
    coverage: 'technical', decodeCoverage: 'none', sampledTimesMs: [], audioCoverage: 'none',
    contentVerdict: 'unknown', checkedConditions: [],
    unchecked: ['technical-metadata', 'decode', 'visual-content', 'audio-content'],
  }
}

/** 创建具备可信资产复验、有界解码和有限抽帧的媒体交付检查服务。 */
export function createMediaDeliveryInspectionService(dependencies: MediaDeliveryInspectionDependencies): {
  inspect(context: MediaSourceContext, asset: MediaAssetRef, requirements: MediaDeliveryRequirements, signal?: AbortSignal): Promise<MediaDeliveryInspectionResult>
} {
  const probe = dependencies.probe ?? ((path, bytes) => probeMediaFile(path, bytes))
  const execute = dependencies.execute ?? defaultExecute
  return {
    /** 每次检查串行执行，探测、解码与抽帧共用同一可信私有快照。 */
    async inspect(context, asset, requirements, signal) {
      return await inspectionQueue.run(async () => {
        throwIfAborted(signal)
        return await dependencies.withAssetFile(context, asset, MAX_MEDIA_BYTES, async (initial) => {
          assertExactAssetFile(initial, asset)
          assertResourceLimits(initial)

          let probed: ProbedMediaFile
          try {
            const signature = dependencies.probe ? new Uint8Array() : readSignatureBytes(initial.path)
            probed = await probe(initial.path, signature)
          } catch (error) {
            if (isAbortError(error)) throw error
            const unavailable = error instanceof Error && error.message === 'MEDIA_PROBE_UNAVAILABLE'
            if (unavailable) return { summary: unavailableSummary(asset), samples: [] }
            return {
              summary: {
                ...unavailableSummary(asset),
                technical: { status: 'failed' },
                probe: { status: 'failed', code: 'MEDIA_INSPECTION_PROBE_FAILED' },
              },
              samples: [],
            }
          }

          assertResourceLimits(initial, probed)
          const checks = evaluateChecks(probed, requirements)
          const decodeArgs = [
            '-nostdin', '-v', 'error', '-protocol_whitelist', 'file,pipe', '-threads', '1',
            '-i', initial.path, '-map', '0:v?', '-map', '0:a?', '-f', 'null', '-',
          ]
          const decoded = await executeFfmpeg(execute, decodeArgs, {
            timeout: DECODE_TIMEOUT_MS, maxBuffer: DECODE_MAX_BUFFER, signal,
          })
          if (decoded.status === 'unavailable') return { summary: unavailableSummary(asset), samples: [] }
          checks.decode = decoded.status === 'ok' ? 'pass' : 'fail'

          const samples: MediaDeliveryVisualSample[] = []
          const times = probed.mediaKind === 'video' && decoded.status === 'ok'
            ? sampleTimes(probed.metadata.durationMs, requirements.visualSamples?.count ?? 0)
            : []
          let sampleBytes = 0
          for (const timeMs of times) {
            throwIfAborted(signal)
            const sampleArgs = [
              '-nostdin', '-v', 'error', '-protocol_whitelist', 'file,pipe', '-threads', '1',
              '-ss', (timeMs / 1_000).toFixed(3), '-i', initial.path,
              '-map', '0:v:0', '-frames:v', '1', '-vf', `scale=${MAX_SAMPLE_EDGE}:${MAX_SAMPLE_EDGE}:force_original_aspect_ratio=decrease`,
              '-f', 'image2pipe', '-vcodec', 'mjpeg', '-',
            ]
            const sampled = await executeFfmpeg(execute, sampleArgs, {
              timeout: DECODE_TIMEOUT_MS, maxBuffer: MAX_SAMPLE_BYTES + 1, signal,
            })
            if (sampled.status !== 'ok') throw new Error('MEDIA_INSPECTION_SAMPLING_INCOMPLETE')
            sampleBytes += sampled.stdout.byteLength
            if (sampleBytes > MAX_SAMPLE_BYTES) throw new Error('MEDIA_INSPECTION_RESOURCE_LIMIT')
            samples.push({ timeMs, mediaType: 'image/jpeg', bytes: sampled.stdout })
          }

          const sampledTimesMs = samples.map((sample) => sample.timeMs)
          const visualCoverage = samples.length > 0 ? 'sampled' : 'technical'
          const unchecked = probed.mediaKind === 'audio'
            ? ['audio-content']
            : [
                'full-video-content', 'visual-content',
                ...(probed.metadata.hasAudio ? ['audio-content', 'audio-video-sync'] : []),
              ]
          return {
            summary: {
              asset: structuredClone(asset), evidenceHash: asset.hash,
              technical: { status: technicalStatus(checks), facts: technicalFacts(probed) },
              checks, probe: { status: 'available' }, coverage: visualCoverage,
              decodeCoverage: checks.decode === 'pass' ? 'full' : 'none',
              sampledTimesMs, audioCoverage: probed.mediaKind === 'audio' || (probed.mediaKind === 'video' && probed.metadata.hasAudio) ? 'technical' : 'none',
              contentVerdict: 'unknown', checkedConditions: checkedConditions(checks), unchecked,
            },
            samples,
          }
        }, signal)
      }, signal)
    },
  }
}

/** 校验 Agent 评审没有超出 Host 实际交付的样本与技术覆盖范围。 */
export function validateMediaReview(result: MediaDeliveryInspectionResult, claim: MediaReviewClaim): ValidatedMediaReview {
  const { summary, samples } = result
  if (claim.coverage === 'full' || (claim.coverage === 'sampled' && (summary.coverage !== 'sampled' || samples.length === 0))) {
    throw new Error('MEDIA_REVIEW_COVERAGE_OVERCLAIMED')
  }
  if (claim.verdict === 'passed' && claim.coverage === 'technical' && summary.technical.status !== 'passed') {
    throw new Error('MEDIA_REVIEW_TECHNICAL_NOT_PASSED')
  }
  if (claim.coverage === 'sampled') {
    const claimsFullContent = claim.checkedConditions.some((condition) => /全片|完整(?:视频|内容|动作)|full[ -]?(?:video|content)/i.test(condition))
    if (claimsFullContent) throw new Error('MEDIA_REVIEW_COVERAGE_OVERCLAIMED')
    if (!claim.unchecked.includes('full-video-content')) throw new Error('MEDIA_REVIEW_UNCHECKED_REQUIRED')
  }
  if (claim.checkedConditions.length === 0 || claim.checkedConditions.length > 64
    || claim.unchecked.length > 64 || [...claim.checkedConditions, ...claim.unchecked].some((value) => !value.trim() || value.length > 256)) {
    throw new Error('MEDIA_REVIEW_INVALID')
  }
  return {
    source: 'agent-assessment', evidenceHash: summary.evidenceHash,
    coverage: claim.coverage, verdict: claim.verdict,
    checkedConditions: [...claim.checkedConditions], unchecked: [...claim.unchecked],
    sampledTimesMs: claim.coverage === 'sampled' ? [...summary.sampledTimesMs] : [],
  }
}
