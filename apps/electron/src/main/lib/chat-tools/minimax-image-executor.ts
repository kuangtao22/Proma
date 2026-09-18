/**
 * MiniMax 图像生成执行器。
 *
 * 只使用独立生成配置提供的 Base URL 与 API Key：POST `${baseUrl}/image_generation`，
 * 取回 image_urls 后下载并保存为本地附件。凭据只在本次调用内存在，不落任何日志。
 */
import { createHash, randomUUID } from 'node:crypto'
import type { AgentToolResultImage } from '@proma/shared'
import { deleteAttachment, saveAttachment } from '../attachment-service'
import type { ResolvedImageGenerationRoute } from '../image-generation-runtime'
import { downloadSafeRemoteImage } from './safe-remote-image'
import { readAuthorizedReferenceImages } from './openai-images-executor'
import type { DownloadedRemoteImage } from './safe-remote-image'
import type { ImageRequestAudit } from './image-request-context'

/** 执行器的网络、附件和 ID 依赖，测试可完全替换。 */
export interface MiniMaxImagesExecutorDependencies {
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  downloadRemoteImage: (url: string, signal?: AbortSignal) => Promise<DownloadedRemoteImage>
  saveAttachment: typeof saveAttachment
  deleteAttachment: typeof deleteAttachment
  createId: () => string
}

/** 单次 MiniMax 文生图请求。 */
export interface ExecuteMiniMaxImagesInput {
  route: Extract<ResolvedImageGenerationRoute, { executor: 'minimax-image' }>
  sessionId: string
  prompt: string
  /** 参考图路径；非空时作为人物主体参考走图生图。 */
  referenceImagePaths?: string[]
  /** 参考图授权根与工作目录，与其它执行器共用同一套校验。 */
  cwd?: string
  allowedRoots?: string[]
  aspectRatio?: string
  numberOfImages?: number
  signal?: AbortSignal
  /** 请求构造完成后、网络发送前同步捕获不含凭据的可信审计信息。 */
  captureRequest?: (request: ImageRequestAudit) => void
}

export interface MiniMaxImagesExecutionResult {
  imageAttachments: AgentToolResultImage[]
}

const defaultDependencies: MiniMaxImagesExecutorDependencies = {
  fetch: (input, init) => globalThis.fetch(input, init),
  downloadRemoteImage: (url, signal) => downloadSafeRemoteImage(url, undefined, signal),
  saveAttachment,
  deleteAttachment,
  createId: randomUUID,
}

/** MiniMax 单次请求的图片数量上限，与官方文档的 n 取值范围一致。 */
const MAX_IMAGE_COUNT = 9
/** MiniMax 图生图只接受单张人物主体参考图。 */
const MAX_REFERENCE_IMAGE_COUNT = 1
/** 返回体读取上限，避免异常上游撑爆内存。 */
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024
/** 官方支持的宽高比；不在表内的取值回落到 1:1。 */
const SUPPORTED_ASPECT_RATIOS = new Set(['1:1', '16:9', '4:3', '3:2', '2:3', '3:4', '9:16', '21:9'])

/** 调用 MiniMax 图像接口并把结果原子化保存为本地附件。 */
export async function executeMiniMaxImages(
  input: ExecuteMiniMaxImagesInput,
  dependencies: MiniMaxImagesExecutorDependencies = defaultDependencies,
): Promise<MiniMaxImagesExecutionResult> {
  input.signal?.throwIfAborted()
  const prompt = input.prompt.trim()
  if (!prompt) throw new Error('生图提示词不能为空')
  /** 参考图先过授权校验；MiniMax 只接受单张人物主体参考。 */
  const references = readAuthorizedReferenceImages(input)
  if (references.length > MAX_REFERENCE_IMAGE_COUNT) {
    throw new Error('MiniMax 图生图只支持 1 张人物主体参考图')
  }
  const count = normalizeImageCount(input.numberOfImages)
  const url = `${input.route.baseUrl.trim().replace(/\/+$/, '')}/image_generation`

  input.captureRequest?.({
    executor: 'minimax-image',
    modelId: input.route.snapshot.modelId,
    prompt,
    referenceImages: references.map((reference) => ({
      path: reference.path,
      sha256: createHash('sha256').update(reference.bytes).digest('hex'),
      byteSize: reference.bytes.length,
    })),
  })
  input.signal?.throwIfAborted()
  const response = await dependencies.fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${input.route.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: input.route.snapshot.modelId,
      prompt,
      n: count,
      response_format: 'url',
      prompt_optimizer: false,
      /** 有参考图时按人物主体参考做图生图；Data URL 内联，避免上传到第三方存储。 */
      ...(references.length > 0
        ? { subject_reference: [{ type: 'character', image_file: `data:${references[0]!.mediaType};base64,${references[0]!.bytes.toString('base64')}` }] }
        : {}),
      ...(resolveAspectRatio(input.aspectRatio) ? { aspect_ratio: resolveAspectRatio(input.aspectRatio) } : {}),
    }),
    signal: input.signal,
  })
  input.signal?.throwIfAborted()
  if (!response.ok) throw await createResponseError(response)
  const text = await response.text()
  if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) throw new Error('MiniMax 图像响应过大，已中止读取')
  const payload = parsePayload(text)
  const imageUrls = readImageUrls(payload)
  if (imageUrls.length === 0) throw new Error('MiniMax 未返回任何图片，请稍后重试')

  /** 先全部下载校验，再统一保存，避免保存到一半才发现后续条目无效。 */
  const parsed: DownloadedRemoteImage[] = []
  for (const imageUrl of imageUrls) {
    input.signal?.throwIfAborted()
    parsed.push(await dependencies.downloadRemoteImage(imageUrl, input.signal))
  }
  input.signal?.throwIfAborted()
  return saveParsedImages(input, parsed, dependencies)
}

/** 归一化请求张数；非法值回落到 1。 */
function normalizeImageCount(value: number | undefined): number {
  if (value === undefined) return 1
  if (!Number.isSafeInteger(value) || value < 1) return 1
  return Math.min(value, MAX_IMAGE_COUNT)
}

/** 把画布的宽高比映射到 MiniMax 支持的取值。 */
function resolveAspectRatio(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  return SUPPORTED_ASPECT_RATIOS.has(value) ? value : undefined
}

/** 读取错误响应体；只保留状态码与官方 message，不携带请求头或凭据。 */
async function createResponseError(response: Response): Promise<Error> {
  let detail = ''
  try {
    const text = await response.text()
    const parsed: unknown = JSON.parse(text)
    if (parsed !== null && typeof parsed === 'object') {
      const baseResp = (parsed as { base_resp?: { status_msg?: unknown } }).base_resp
      if (typeof baseResp?.status_msg === 'string') detail = baseResp.status_msg
    }
  } catch {
    // 上游正文不可解析时只保留状态码。
  }
  return new Error(`MiniMax 图像接口返回 ${response.status}${detail ? `：${detail}` : ''}`)
}

/** 解析响应 JSON。 */
function parsePayload(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('MiniMax 图像响应无法解析')
  }
}

/** 读取 image_urls；业务错误码优先于空结果。 */
function readImageUrls(payload: unknown): string[] {
  if (payload === null || typeof payload !== 'object') throw new Error('MiniMax 图像响应无法解析')
  const baseResp = (payload as { base_resp?: { status_code?: unknown; status_msg?: unknown } }).base_resp
  if (typeof baseResp?.status_code === 'number' && baseResp.status_code !== 0) {
    const message = typeof baseResp.status_msg === 'string' && baseResp.status_msg ? `：${baseResp.status_msg}` : ''
    throw new Error(`MiniMax 图像生成失败${message}`)
  }
  const urls = (payload as { data?: { image_urls?: unknown } }).data?.image_urls
  if (!Array.isArray(urls)) throw new Error('MiniMax 图像响应缺少 image_urls')
  return urls.filter((url): url is string => typeof url === 'string' && url.trim().length > 0)
}

/** 保存下载结果；任一步失败都回收已经写入的附件。 */
function saveParsedImages(
  input: ExecuteMiniMaxImagesInput,
  images: DownloadedRemoteImage[],
  dependencies: MiniMaxImagesExecutorDependencies,
): MiniMaxImagesExecutionResult {
  const savedPaths: string[] = []
  const imageAttachments: AgentToolResultImage[] = []
  try {
    for (const [index, image] of images.entries()) {
      input.signal?.throwIfAborted()
      const filename = `minimax-image-${dependencies.createId()}-${index + 1}${extensionForMediaType(image.mediaType)}`
      const result = dependencies.saveAttachment({
        conversationId: input.sessionId,
        filename,
        mediaType: image.mediaType,
        data: image.bytes.toString('base64'),
      })
      savedPaths.push(result.attachment.localPath)
      imageAttachments.push({
        localPath: result.attachment.localPath,
        filename: result.attachment.filename,
        mediaType: result.attachment.mediaType,
      })
    }
    return { imageAttachments }
  } catch (error) {
    for (const path of savedPaths) dependencies.deleteAttachment(path)
    throw error
  }
}

/** 下载结果媒体类型对应的扩展名。 */
function extensionForMediaType(mediaType: DownloadedRemoteImage['mediaType']): string {
  if (mediaType === 'image/jpeg') return '.jpg'
  if (mediaType === 'image/webp') return '.webp'
  return '.png'
}
