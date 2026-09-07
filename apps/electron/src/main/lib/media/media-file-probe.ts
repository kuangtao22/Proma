import { execFile } from 'node:child_process'

const PROBE_TIMEOUT_MS = 10_000
const PROBE_MAX_BUFFER = 64 * 1024
/** 优先固定系统安装位置，最后通过当前应用 PATH 查找。 */
const PROBE_CANDIDATES = ['/usr/bin/ffprobe', '/opt/homebrew/bin/ffprobe', '/usr/local/bin/ffprobe', 'ffprobe']

/** ffprobe 调用参数保持可注入，测试不依赖开发机安装状态。 */
export interface MediaProbeExecOptions { timeout: number; maxBuffer: number }
export interface MediaProbeExecResult { stdout: string; stderr: string }
export type MediaProbeExec = (file: string, args: readonly string[], options: MediaProbeExecOptions) => Promise<MediaProbeExecResult>

/** 已验证的音视频格式和技术元数据。 */
export type ProbedMediaFile =
  | { mediaKind: 'audio'; mediaType: string; extension: string; metadata: { durationMs: number; sampleRate: number; channels: number; codec: string } }
  | { mediaKind: 'video'; mediaType: string; extension: string; metadata: { width: number; height: number; durationMs: number; fps: number | null; codec: string; hasAudio: boolean } }

export interface MediaFileProbeDependencies {
  exec?: MediaProbeExec
  candidates?: readonly string[]
}

interface ProbeStream {
  codec_type?: unknown
  codec_name?: unknown
  width?: unknown
  height?: unknown
  r_frame_rate?: unknown
  sample_rate?: unknown
  channels?: unknown
  duration?: unknown
}

interface ProbeJson {
  format?: { format_name?: unknown; duration?: unknown }
  streams?: ProbeStream[]
}

type SignatureKind = 'audio-only' | 'video-only' | 'audio-video'

interface SignatureFormat {
  kind: SignatureKind
  family: 'wav' | 'mp3' | 'flac' | 'ogg' | 'mp4' | 'webm' | 'avi'
}

/** 无需启动ffprobe即可确定的真实文件签名；复合容器在流探测前不猜媒体类别。 */
export interface MediaFileSignature {
  extension: string
  mediaType: string
  mediaKind?: 'image' | 'audio' | 'video'
}

/** 生产调用固定禁用 shell，并限制运行时间与输出体积。 */
const defaultExec: MediaProbeExec = async (file, args, options) => await new Promise((resolve, reject) => {
  execFile(file, [...args], { encoding: 'utf8', windowsHide: true, timeout: options.timeout, maxBuffer: options.maxBuffer }, (error, stdout, stderr) => {
    if (error) { reject(error); return }
    resolve({ stdout, stderr })
  })
})

/** 提交付费音视频生成前验证本机能接收产物，不读取任何用户媒体。 */
export async function assertMediaProbeAvailable(dependencies: MediaFileProbeDependencies = {}): Promise<void> {
  const exec = dependencies.exec ?? defaultExec
  for (const candidate of dependencies.candidates ?? PROBE_CANDIDATES) {
    try {
      const result = await exec(candidate, ['-version'], { timeout: PROBE_TIMEOUT_MS, maxBuffer: PROBE_MAX_BUFFER })
      if (!/^ffprobe version /m.test(result.stdout)) throw new Error('MEDIA_PROBE_INVALID')
      return
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw new Error('MEDIA_PROBE_UNAVAILABLE', { cause: error })
    }
  }
  throw new Error('MEDIA_PROBE_UNAVAILABLE')
}

/** 只用文件头确定允许的容器族，不信任调用方 MIME 或扩展名。 */
function detectSignature(bytes: Uint8Array): SignatureFormat {
  const header = Buffer.from(bytes.subarray(0, 64))
  const ascii = header.toString('latin1')
  if (ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WAVE') return { kind: 'audio-only', family: 'wav' }
  if (ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'AVI ') return { kind: 'video-only', family: 'avi' }
  if (ascii.startsWith('fLaC')) return { kind: 'audio-only', family: 'flac' }
  if (ascii.startsWith('OggS')) return { kind: 'audio-only', family: 'ogg' }
  if (ascii.startsWith('ID3') || (header.length >= 2 && header[0] === 0xff && (header[1]! & 0xe0) === 0xe0)) return { kind: 'audio-only', family: 'mp3' }
  if (header.length >= 12 && ascii.slice(4, 8) === 'ftyp') return { kind: 'audio-video', family: 'mp4' }
  if (header.length >= 4 && header[0] === 0x1a && header[1] === 0x45 && header[2] === 0xdf && header[3] === 0xa3) return { kind: 'audio-video', family: 'webm' }
  throw new Error('MEDIA_FILE_SIGNATURE_UNSUPPORTED')
}

/** 为上传计划和资产路由提供唯一同步签名识别入口。 */
export function detectMediaFileSignature(bytes: Uint8Array): MediaFileSignature {
  const header = Buffer.from(bytes.subarray(0, 64))
  const ascii = header.toString('latin1')
  if (header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return { extension: '.png', mediaType: 'image/png', mediaKind: 'image' }
  if (header.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return { extension: '.jpg', mediaType: 'image/jpeg', mediaKind: 'image' }
  if (ascii.startsWith('GIF87a') || ascii.startsWith('GIF89a')) return { extension: '.gif', mediaType: 'image/gif', mediaKind: 'image' }
  if (ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WEBP') return { extension: '.webp', mediaType: 'image/webp', mediaKind: 'image' }
  const signature = detectSignature(bytes)
  if (signature.family === 'wav') return { extension: '.wav', mediaType: 'audio/wav', mediaKind: 'audio' }
  if (signature.family === 'mp3') return { extension: '.mp3', mediaType: 'audio/mpeg', mediaKind: 'audio' }
  if (signature.family === 'flac') return { extension: '.flac', mediaType: 'audio/flac', mediaKind: 'audio' }
  if (signature.family === 'ogg') return { extension: '.ogg', mediaType: 'audio/ogg', mediaKind: 'audio' }
  if (signature.family === 'avi') return { extension: '.avi', mediaType: 'video/x-msvideo', mediaKind: 'video' }
  if (signature.family === 'webm') return { extension: '.webm', mediaType: 'application/webm' }
  return { extension: '.mp4', mediaType: 'application/mp4' }
}

/** 将 ffprobe 有限数值字段解析为正数。 */
function positiveNumber(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : Number.NaN
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

/** 将帧率有理数解析为有限正数，未知值保持 null。 */
function frameRate(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const [numerator, denominator] = value.split('/').map(Number)
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || !denominator || !numerator || numerator! < 0 || denominator! < 0) return null
  const valueFps = numerator! / denominator!
  return Number.isFinite(valueFps) && valueFps > 0 ? valueFps : null
}

/** 验证 ffprobe 声明的容器族与真实签名相符。 */
function assertFormatFamily(signature: SignatureFormat, formatName: unknown): void {
  if (typeof formatName !== 'string') throw new Error('MEDIA_PROBE_INVALID')
  const accepted: Record<SignatureFormat['family'], string[]> = {
    wav: ['wav'], mp3: ['mp3'], flac: ['flac'], ogg: ['ogg'], mp4: ['mov', 'mp4', 'm4a', '3gp'], webm: ['webm', 'matroska'], avi: ['avi'],
  }
  const names = formatName.toLowerCase().split(',')
  if (!accepted[signature.family].some((name) => names.includes(name))) throw new Error('MEDIA_PROBE_TYPE_MISMATCH')
}

/** 根据探测事实选择规范 MIME 和扩展名。 */
function fileFormat(signature: SignatureFormat, mediaKind: 'audio' | 'video'): { mediaType: string; extension: string } {
  if (mediaKind === 'video') {
    if (signature.family === 'avi') return { mediaType: 'video/x-msvideo', extension: '.avi' }
    if (signature.family === 'webm') return { mediaType: 'video/webm', extension: '.webm' }
    return { mediaType: 'video/mp4', extension: '.mp4' }
  }
  if (signature.family === 'wav') return { mediaType: 'audio/wav', extension: '.wav' }
  if (signature.family === 'mp3') return { mediaType: 'audio/mpeg', extension: '.mp3' }
  if (signature.family === 'flac') return { mediaType: 'audio/flac', extension: '.flac' }
  if (signature.family === 'ogg') return { mediaType: 'audio/ogg', extension: '.ogg' }
  if (signature.family === 'webm') return { mediaType: 'audio/webm', extension: '.webm' }
  return { mediaType: 'audio/mp4', extension: '.m4a' }
}

/** 用系统 ffprobe 验证本地受管临时文件，禁止任何网络协议。 */
export async function probeMediaFile(path: string, signatureBytes: Uint8Array, dependencies: MediaFileProbeDependencies = {}): Promise<ProbedMediaFile> {
  const signature = detectSignature(signatureBytes)
  const exec = dependencies.exec ?? defaultExec
  const candidates = dependencies.candidates ?? PROBE_CANDIDATES
  const args = ['-v', 'error', '-protocol_whitelist', 'file', '-show_entries',
    'format=format_name,duration:stream=codec_type,codec_name,width,height,r_frame_rate,sample_rate,channels,duration', '-of', 'json', path]
  let result: MediaProbeExecResult | undefined
  for (const candidate of candidates) {
    try { result = await exec(candidate, args, { timeout: PROBE_TIMEOUT_MS, maxBuffer: PROBE_MAX_BUFFER }); break } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw new Error('MEDIA_PROBE_FAILED', { cause: error })
    }
  }
  if (!result) throw new Error('MEDIA_PROBE_UNAVAILABLE')
  let parsed: ProbeJson
  try { parsed = JSON.parse(result.stdout) as ProbeJson } catch (error) { throw new Error('MEDIA_PROBE_INVALID', { cause: error }) }
  if (!Array.isArray(parsed.streams)) throw new Error('MEDIA_PROBE_INVALID')
  assertFormatFamily(signature, parsed.format?.format_name)
  const video = parsed.streams.find((stream) => stream.codec_type === 'video')
  const audio = parsed.streams.find((stream) => stream.codec_type === 'audio')
  const duration = positiveNumber(parsed.format?.duration) ?? positiveNumber(video?.duration) ?? positiveNumber(audio?.duration)
  if (!duration) throw new Error('MEDIA_PROBE_INVALID')
  if (video) {
    if (signature.kind === 'audio-only') throw new Error('MEDIA_PROBE_TYPE_MISMATCH')
    const width = positiveNumber(video.width); const height = positiveNumber(video.height)
    if (!width || !height || !Number.isSafeInteger(width) || !Number.isSafeInteger(height) || typeof video.codec_name !== 'string' || !video.codec_name) throw new Error('MEDIA_PROBE_INVALID')
    const format = fileFormat(signature, 'video')
    return { mediaKind: 'video', ...format, metadata: { width, height, durationMs: Math.round(duration * 1000), fps: frameRate(video.r_frame_rate), codec: video.codec_name, hasAudio: Boolean(audio) } }
  }
  if (!audio || signature.kind === 'video-only') throw new Error('MEDIA_PROBE_TYPE_MISMATCH')
  const sampleRate = positiveNumber(audio.sample_rate); const channels = positiveNumber(audio.channels)
  if (!sampleRate || !channels || !Number.isSafeInteger(sampleRate) || !Number.isSafeInteger(channels) || typeof audio.codec_name !== 'string' || !audio.codec_name) throw new Error('MEDIA_PROBE_INVALID')
  const format = fileFormat(signature, 'audio')
  return { mediaKind: 'audio', ...format, metadata: { durationMs: Math.round(duration * 1000), sampleRate, channels, codec: audio.codec_name } }
}
