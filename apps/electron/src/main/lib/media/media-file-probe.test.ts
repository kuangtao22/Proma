import { describe, expect, test } from 'bun:test'
import { assertMediaProbeAvailable, detectMediaFileSignature, probeMediaFile } from './media-file-probe'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

describe('音视频文件探测', () => {
  test('Given 付费运行尚未开始 When 检查接收工具 Then 仅执行有界 version 查询且缺失明确失败', async () => {
    const argsSeen: string[][] = []
    await assertMediaProbeAvailable({ candidates: ['ffprobe'], exec: async (_file, args) => {
      argsSeen.push([...args]); return { stdout: 'ffprobe version 7.1\n', stderr: '' }
    } })
    expect(argsSeen).toEqual([['-version']])
    await expect(assertMediaProbeAvailable({ candidates: [], exec: async () => { throw new Error('unused') } })).rejects.toThrow('MEDIA_PROBE_UNAVAILABLE')
  })
  test('Given 图片与复合容器签名 When 同步识别 Then 上传计划复用规范扩展且不猜复合容器媒体类别', () => {
    expect(detectMediaFileSignature(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))).toEqual({ extension: '.png', mediaType: 'image/png', mediaKind: 'image' })
    expect(detectMediaFileSignature(Buffer.from('000000186674797069736f6d', 'hex'))).toEqual({ extension: '.mp4', mediaType: 'application/mp4' })
  })
  test('Given MP4真实签名和ffprobe视频流 When 探测 Then 返回实际视频结构且未知fps保持null', async () => {
    const calls: Array<{ file: string; args: readonly string[]; options: { timeout: number; maxBuffer: number } }> = []
    const result = await probeMediaFile('/managed/probe.bin', Buffer.from('000000186674797069736f6d', 'hex'), {
      candidates: ['/usr/bin/ffprobe'],
      exec: async (file, args, options) => {
        calls.push({ file, args, options })
        return { stdout: JSON.stringify({ format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '2.5' }, streams: [
          { codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080, r_frame_rate: '0/0' },
          { codec_type: 'audio', codec_name: 'aac', sample_rate: '48000', channels: 2 },
        ] }), stderr: '' }
      },
    })
    expect(result).toEqual({ mediaKind: 'video', mediaType: 'video/mp4', extension: '.mp4', metadata: { width: 1920, height: 1080, durationMs: 2500, fps: null, codec: 'h264', hasAudio: true } })
    expect(calls[0]?.args).toContain('-protocol_whitelist')
    expect(calls[0]?.args).toContain('file')
    expect(calls[0]?.options).toEqual({ timeout: 10_000, maxBuffer: 64 * 1024 })
  })

  test('Given WAV真实签名和音频流 When 探测 Then 返回采样率、声道和时长', async () => {
    const signature = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVEfmt ')])
    const result = await probeMediaFile('/managed/audio.bin', signature, { candidates: ['ffprobe'], exec: async () => ({
      stdout: JSON.stringify({ format: { format_name: 'wav', duration: '1.25' }, streams: [{ codec_type: 'audio', codec_name: 'pcm_s16le', sample_rate: '44100', channels: 1 }] }), stderr: '',
    }) })
    expect(result).toEqual({ mediaKind: 'audio', mediaType: 'audio/wav', extension: '.wav', metadata: { durationMs: 1250, sampleRate: 44100, channels: 1, codec: 'pcm_s16le' } })
  })

  test('Given 所有可信候选均不存在 When 探测 Then 明确报告工具不可用', async () => {
    await expect(probeMediaFile('/managed/audio.bin', Buffer.from('fLaC'), {
      candidates: ['/usr/bin/ffprobe', 'ffprobe'],
      exec: async () => { const error = new Error('missing') as NodeJS.ErrnoException; error.code = 'ENOENT'; throw error },
    })).rejects.toThrow('MEDIA_PROBE_UNAVAILABLE')
  })

  test('Given MIME伪装或ffprobe结构与签名矛盾 When 探测 Then 以真实签名校验并拒绝', async () => {
    await expect(probeMediaFile('/managed/fake.bin', Buffer.from('fLaC'), { candidates: ['ffprobe'], exec: async () => ({
      stdout: JSON.stringify({ format: { format_name: 'matroska,webm', duration: '1' }, streams: [{ codec_type: 'video', codec_name: 'vp9', width: 10, height: 10, r_frame_rate: '24/1' }] }), stderr: '',
    }) })).rejects.toThrow('MEDIA_PROBE_TYPE_MISMATCH')
  })

  test.skipIf(!existsSync('/opt/homebrew/bin/ffprobe'))('Given 本机真实 ffprobe 与生成的 PCM WAV When 按生产参数探测 Then 正确读取音频时长及采样率', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'proma-real-media-probe-'))
    try {
      const bytes = Buffer.alloc(44 + 16000)
      bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8)
      bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22)
      bytes.writeUInt32LE(8000, 24); bytes.writeUInt32LE(16000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34)
      bytes.write('data', 36); bytes.writeUInt32LE(16000, 40)
      const path = join(directory, 'audio.wav')
      writeFileSync(path, bytes)
      const result = await probeMediaFile(path, bytes, { candidates: ['/opt/homebrew/bin/ffprobe'] })
      expect(result).toMatchObject({ mediaKind: 'audio', mediaType: 'audio/wav', metadata: { durationMs: 1000, sampleRate: 8000, channels: 1 } })
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })
})
