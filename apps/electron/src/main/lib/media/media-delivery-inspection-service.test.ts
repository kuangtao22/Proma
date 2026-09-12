import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MediaAssetFile, MediaSourceContext } from './media-source-service'
import type { MediaAssetRef } from '@proma/shared'
import {
  createMediaDeliveryInspectionService,
  validateMediaReview,
  type MediaDeliveryInspectionDependencies,
  type MediaDeliveryInspectionExecute,
} from './media-delivery-inspection-service'

const context: MediaSourceContext = { projectId: 'project-1', sessionId: 'session-1' }
const asset: MediaAssetRef = { assetId: 'video-1', revision: 1, hash: 'a'.repeat(64), mediaKind: 'video' }

/** 构造不暴露真实磁盘的可信视频文件结果。 */
function videoFile(overrides: Partial<MediaAssetFile['record']> = {}): MediaAssetFile {
  return {
    path: '/managed/video.mp4',
    asset,
    record: {
      id: asset.assetId,
      revision: 1,
      hash: asset.hash,
      filename: 'video.mp4',
      byteSize: 1_024,
      mediaKind: 'video',
      mediaType: 'video/mp4',
      createdAt: 1,
      metadata: { width: 1080, height: 1440, durationMs: 18_000, fps: 30, codec: 'h264', hasAudio: true },
      ...overrides,
    } as MediaAssetFile['record'],
  }
}

/** 测试中以固定可信快照执行回调，模拟 Host 自动释放的 withAssetFile。 */
function withAssetFile(file: () => MediaAssetFile = videoFile): MediaDeliveryInspectionDependencies['withAssetFile'] {
  return async (_context, _asset, _maxBytes, effect) => await effect(file())
}

describe('媒体交付检查服务', () => {
  test('Given 精确视频资产与生产规格 When 检查 Then 完整解码并返回不含路径的技术证据', async () => {
    const leaseCalls: Array<{ asset: MediaAssetRef; maxBytes: number }> = []
    const executeCalls: Array<{ file: string; args: readonly string[]; maxBuffer: number }> = []
    const service = createMediaDeliveryInspectionService({
      withAssetFile: async (_context, input, maxBytes, effect) => {
        leaseCalls.push({ asset: input, maxBytes })
        return await effect(videoFile())
      },
      probe: async () => ({
        mediaKind: 'video', mediaType: 'video/mp4', extension: '.mp4',
        metadata: { width: 1080, height: 1440, durationMs: 18_000, fps: 30, codec: 'h264', hasAudio: true },
      }),
      execute: async (file, args, options) => {
        executeCalls.push({ file, args, maxBuffer: options.maxBuffer })
        return { stdout: new Uint8Array(), stderr: '' }
      },
    })

    const result = await service.inspect(context, asset, {
      width: { exact: 1080 },
      height: { exact: 1440 },
      durationMs: { min: 17_900, max: 18_100 },
      fps: { exact: 30, tolerance: 0.01 },
      audioPolicy: 'required',
    })

    expect(leaseCalls).toEqual([{ asset, maxBytes: 128 * 1024 * 1024 }])
    expect(executeCalls).toHaveLength(1)
    expect(executeCalls[0]?.args).toEqual([
      '-nostdin', '-v', 'error', '-protocol_whitelist', 'file,pipe', '-threads', '1',
      '-i', '/managed/video.mp4', '-map', '0:v?', '-map', '0:a?', '-f', 'null', '-',
    ])
    expect(result.summary).toMatchObject({
      asset, evidenceHash: asset.hash,
      technical: {
        status: 'passed',
        facts: { mediaKind: 'video', width: 1080, height: 1440, durationMs: 18_000, fps: 30, hasAudio: true, codec: 'h264' },
      },
      checks: { width: 'pass', height: 'pass', durationMs: 'pass', fps: 'pass', audio: 'pass', decode: 'pass' },
      probe: { status: 'available' },
      coverage: 'technical', contentVerdict: 'unknown',
      checkedConditions: ['width', 'height', 'durationMs', 'fps', 'audio', 'decode'],
      unchecked: ['full-video-content', 'visual-content', 'audio-content', 'audio-video-sync'],
    })
    expect(result.samples).toEqual([])
    expect(JSON.stringify(result)).not.toContain('/managed/video.mp4')
  })

  test('Given 静音视频与禁止音轨要求 When 检查 Then 音轨条件通过但内容仍未知', async () => {
    const service = createMediaDeliveryInspectionService({
      withAssetFile: withAssetFile(),
      probe: async () => ({
        mediaKind: 'video', mediaType: 'video/mp4', extension: '.mp4',
        metadata: { width: 1080, height: 1440, durationMs: 18_000, fps: 30, codec: 'h264', hasAudio: false },
      }),
      execute: async () => ({ stdout: new Uint8Array(), stderr: '' }),
    })
    const result = await service.inspect(context, asset, { audioPolicy: 'forbidden' })
    expect(result.summary.checks.audio).toBe('pass')
    expect(result.summary.coverage).toBe('technical')
    expect(result.summary.contentVerdict).toBe('unknown')
  })

  test('Given 音频资产只完成技术解码 When 检查 Then 只声明音频内容未检而不虚构视觉范围', async () => {
    const audioAsset: MediaAssetRef = { assetId: 'audio-1', revision: 1, hash: 'b'.repeat(64), mediaKind: 'audio' }
    const audioFile: MediaAssetFile = {
      path: '/managed/audio.wav', asset: audioAsset,
      record: {
        id: audioAsset.assetId, revision: 1, hash: audioAsset.hash, filename: 'audio.wav', byteSize: 1_024,
        mediaKind: 'audio', mediaType: 'audio/wav', createdAt: 1,
        metadata: { durationMs: 2_000, sampleRate: 48_000, channels: 2, codec: 'pcm_s16le' },
      },
    }
    const service = createMediaDeliveryInspectionService({
      withAssetFile: withAssetFile(() => audioFile),
      probe: async () => ({
        mediaKind: 'audio', mediaType: 'audio/wav', extension: '.wav',
        metadata: { durationMs: 2_000, sampleRate: 48_000, channels: 2, codec: 'pcm_s16le' },
      }),
      execute: async () => ({ stdout: new Uint8Array(), stderr: '' }),
    })

    const result = await service.inspect(context, audioAsset, { audioPolicy: 'required' })
    expect(result.summary.unchecked).toEqual(['audio-content'])
  })

  test('Given 本机没有媒体分析工具 When 检查 Then 返回结构化 unavailable 而不是伪造通过', async () => {
    const unavailable = Object.assign(new Error('missing'), { code: 'ENOENT' })
    const service = createMediaDeliveryInspectionService({
      withAssetFile: withAssetFile(),
      probe: async () => { throw new Error('MEDIA_PROBE_UNAVAILABLE') },
      execute: async () => { throw unavailable },
    })
    const result = await service.inspect(context, asset, { audioPolicy: 'required' })
    expect(result.summary).toMatchObject({
      technical: { status: 'unavailable' },
      probe: { status: 'unavailable', code: 'MEDIA_INSPECTION_TOOL_UNAVAILABLE' },
      checks: { audio: 'unchecked', decode: 'unchecked' },
      coverage: 'technical', contentVerdict: 'unknown',
    })
    expect(result.summary.unchecked).toContain('technical-metadata')
  })

  test('Given Host无法建立稳定快照 When 检查 Then 不启动解码并保留资产变化错误', async () => {
    let executed = false
    const service = createMediaDeliveryInspectionService({
      withAssetFile: async () => { throw new Error('MEDIA_ASSET_CHANGED') },
      probe: async () => ({
        mediaKind: 'video', mediaType: 'video/mp4', extension: '.mp4',
        metadata: { width: 1080, height: 1440, durationMs: 18_000, fps: 30, codec: 'h264', hasAudio: true },
      }),
      execute: async () => { executed = true; return { stdout: new Uint8Array(), stderr: '' } },
    })
    await expect(service.inspect(context, asset, { audioPolicy: 'optional' })).rejects.toThrow('MEDIA_ASSET_CHANGED')
    expect(executed).toBe(false)
  })

  test('Given 用户已取消检查 When 调用服务 Then 抛标准 AbortError且不启动分析', async () => {
    let executed = false
    const execute: MediaDeliveryInspectionExecute = async () => {
      executed = true
      return { stdout: new Uint8Array(), stderr: '' }
    }
    const service = createMediaDeliveryInspectionService({
      withAssetFile: withAssetFile(),
      probe: async () => ({
        mediaKind: 'video', mediaType: 'video/mp4', extension: '.mp4',
        metadata: { width: 1080, height: 1440, durationMs: 18_000, fps: 30, codec: 'h264', hasAudio: true },
      }),
      execute,
    })
    const controller = new AbortController()
    controller.abort()
    await expect(service.inspect(context, asset, { audioPolicy: 'optional' }, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(executed).toBe(false)
  })

  test('Given 两个媒体同时请求检查 When 解码 Then 进程内最多执行一个ffmpeg', async () => {
    let active = 0
    let maxActive = 0
    const service = createMediaDeliveryInspectionService({
      withAssetFile: withAssetFile(),
      probe: async () => ({
        mediaKind: 'video', mediaType: 'video/mp4', extension: '.mp4',
        metadata: { width: 1080, height: 1440, durationMs: 18_000, fps: 30, codec: 'h264', hasAudio: true },
      }),
      execute: async () => {
        active += 1
        maxActive = Math.max(maxActive, active)
        await new Promise((resolve) => setTimeout(resolve, 5))
        active -= 1
        return { stdout: new Uint8Array(), stderr: '' }
      },
    })
    await Promise.all([
      service.inspect(context, asset, { audioPolicy: 'optional' }),
      service.inspect(context, asset, { audioPolicy: 'optional' }),
    ])
    expect(maxActive).toBe(1)
  })

  test('Given 队列中间任务被取消 When 第三个任务等待 Then 不绕过仍运行的首个解码', async () => {
    let active = 0
    let maxActive = 0
    let executeCount = 0
    let releaseFirst: () => void = () => undefined
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
    let notifyFirstStarted: (() => void) | undefined
    const firstStarted = new Promise<void>((resolve) => { notifyFirstStarted = resolve })
    const service = createMediaDeliveryInspectionService({
      withAssetFile: withAssetFile(),
      probe: async () => ({
        mediaKind: 'video', mediaType: 'video/mp4', extension: '.mp4',
        metadata: { width: 1080, height: 1440, durationMs: 18_000, fps: 30, codec: 'h264', hasAudio: true },
      }),
      execute: async () => {
        executeCount += 1
        active += 1
        maxActive = Math.max(maxActive, active)
        if (executeCount === 1) {
          notifyFirstStarted?.()
          await firstGate
        }
        active -= 1
        return { stdout: new Uint8Array(), stderr: '' }
      },
    })
    const first = service.inspect(context, asset, { audioPolicy: 'optional' })
    await firstStarted
    const controller = new AbortController()
    const cancelled = service.inspect(context, asset, { audioPolicy: 'optional' }, controller.signal)
    const observedCancellation = cancelled.catch((error: unknown) => error)
    const third = service.inspect(context, asset, { audioPolicy: 'optional' })
    controller.abort()
    expect(await observedCancellation).toMatchObject({ name: 'AbortError' })
    expect(executeCount).toBe(1)
    releaseFirst()
    await Promise.all([first, third])
    expect(maxActive).toBe(1)
    expect(executeCount).toBe(2)
  })

  test('Given 请求有限视觉抽帧 When 检查 Then 最多返回12张768长边样本且仍不能声称全片内容通过', async () => {
    const sampleBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xd9])
    const service = createMediaDeliveryInspectionService({
      withAssetFile: withAssetFile(),
      probe: async () => ({
        mediaKind: 'video', mediaType: 'video/mp4', extension: '.mp4',
        metadata: { width: 1080, height: 1440, durationMs: 18_000, fps: 30, codec: 'h264', hasAudio: true },
      }),
      execute: async (_file, args) => ({ stdout: args.includes('image2pipe') ? sampleBytes : new Uint8Array(), stderr: '' }),
    })
    const result = await service.inspect(context, asset, { audioPolicy: 'optional', visualSamples: { count: 99 } })
    expect(result.samples).toHaveLength(12)
    expect(result.summary.coverage).toBe('sampled')
    expect(result.summary.sampledTimesMs[0]).toBeGreaterThanOrEqual(0)
    expect(result.summary.sampledTimesMs.at(-1)).toBeLessThan(18_000)
    expect(validateMediaReview(result, {
      coverage: 'sampled', verdict: 'passed',
      checkedConditions: ['片尾绿点状态'], unchecked: ['full-video-content'],
    })).toMatchObject({ source: 'agent-assessment', coverage: 'sampled', verdict: 'passed' })
    expect(() => validateMediaReview(result, {
      coverage: 'full', verdict: 'passed', checkedConditions: ['全片内容'], unchecked: [],
    })).toThrow('MEDIA_REVIEW_COVERAGE_OVERCLAIMED')
    expect(() => validateMediaReview(result, {
      coverage: 'sampled', verdict: 'passed', checkedConditions: ['片尾绿点状态'], unchecked: [],
    })).toThrow('MEDIA_REVIEW_UNCHECKED_REQUIRED')
  })

  test('Given 计划抽取三帧但第二帧失败 When 检查 Then 明确失败且不返回部分sampled证据', async () => {
    let sampleCall = 0
    const service = createMediaDeliveryInspectionService({
      withAssetFile: withAssetFile(),
      probe: async () => ({
        mediaKind: 'video', mediaType: 'video/mp4', extension: '.mp4',
        metadata: { width: 1080, height: 1440, durationMs: 18_000, fps: 30, codec: 'h264', hasAudio: true },
      }),
      execute: async (_file, args) => {
        if (!args.includes('image2pipe')) return { stdout: new Uint8Array(), stderr: '' }
        sampleCall += 1
        if (sampleCall === 2) throw new Error('decode failed')
        return { stdout: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), stderr: '' }
      },
    })

    await expect(service.inspect(context, asset, {
      audioPolicy: 'optional', visualSamples: { count: 3 },
    })).rejects.toThrow('MEDIA_INSPECTION_SAMPLING_INCOMPLETE')
  })

  test('Given 视频超过资源边界 When 检查 Then 在启动ffmpeg前拒绝', async () => {
    let executed = false
    const service = createMediaDeliveryInspectionService({
      withAssetFile: withAssetFile(() => videoFile({ byteSize: 128 * 1024 * 1024 + 1 })),
      probe: async () => ({
        mediaKind: 'video', mediaType: 'video/mp4', extension: '.mp4',
        metadata: { width: 1080, height: 1440, durationMs: 18_000, fps: 30, codec: 'h264', hasAudio: true },
      }),
      execute: async () => { executed = true; return { stdout: new Uint8Array(), stderr: '' } },
    })
    await expect(service.inspect(context, asset, { audioPolicy: 'optional' })).rejects.toThrow('MEDIA_INSPECTION_RESOURCE_LIMIT')
    expect(executed).toBe(false)
  })

  test.skipIf(!existsSync('/opt/homebrew/bin/ffmpeg') || !existsSync('/opt/homebrew/bin/ffprobe'))(
    'Given 本机真实ffmpeg生成临时音视频 When 使用生产执行器检查 Then 完成解码与有限抽帧',
    async () => {
      const directory = mkdtempSync(join(tmpdir(), 'proma-media-inspection-'))
      try {
        const path = join(directory, 'fixture.mp4')
        execFileSync('/opt/homebrew/bin/ffmpeg', [
          '-nostdin', '-v', 'error',
          '-f', 'lavfi', '-i', 'color=c=blue:s=320x240:d=1:r=24',
          '-f', 'lavfi', '-i', 'sine=frequency=1000:duration=1',
          '-shortest', '-c:v', 'mpeg4', '-c:a', 'aac', '-pix_fmt', 'yuv420p', path,
        ], { timeout: 10_000 })
        const bytes = readFileSync(path)
        const hash = createHash('sha256').update(bytes).digest('hex')
        const fixtureAsset: MediaAssetRef = { assetId: 'real-video', revision: 1, hash, mediaKind: 'video' }
        const file: MediaAssetFile = {
          path,
          asset: fixtureAsset,
          record: {
            id: fixtureAsset.assetId, revision: 1, hash, filename: 'fixture.mp4', byteSize: statSync(path).size,
            mediaKind: 'video', mediaType: 'video/mp4', createdAt: 1,
            metadata: { width: 320, height: 240, durationMs: 1_000, fps: 24, codec: 'mpeg4', hasAudio: true },
          },
        }
        const service = createMediaDeliveryInspectionService({ withAssetFile: withAssetFile(() => file) })
        const result = await service.inspect(context, fixtureAsset, {
          width: { exact: 320 }, height: { exact: 240 }, durationMs: { min: 900, max: 1_100 },
          fps: { exact: 24, tolerance: 0.01 }, audioPolicy: 'required', visualSamples: { count: 2 },
        })
        expect(result.summary).toMatchObject({ technical: { status: 'passed' }, coverage: 'sampled', decodeCoverage: 'full' })
        expect(result.samples).toHaveLength(2)
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    },
  )
})
