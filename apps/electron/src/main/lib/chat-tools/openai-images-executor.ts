import { randomUUID } from 'node:crypto'
import { readFileSync, realpathSync, statSync } from 'node:fs'
import { basename, isAbsolute, relative, resolve } from 'node:path'
import { MAX_ATTACHMENT_SIZE } from '@proma/shared'
import type { AgentToolResultImage } from '@proma/shared'
import { deleteAttachment, saveAttachment } from '../attachment-service'
import type { ResolvedImageGenerationRoute } from '../image-generation-runtime'
import { downloadSafeRemoteImage } from './safe-remote-image'
import type { DownloadedRemoteImage } from './safe-remote-image'

/** 执行器的网络、附件和 ID 依赖，测试可完全替换。 */
export interface OpenAIImagesExecutorDependencies {
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  downloadRemoteImage: (url: string, signal?: AbortSignal) => Promise<DownloadedRemoteImage>
  saveAttachment: typeof saveAttachment
  deleteAttachment: typeof deleteAttachment
  createId: () => string
}

/** 单次 GPT Image 2 文生图或编辑请求。 */
export interface ExecuteOpenAIImagesInput {
  route: Extract<ResolvedImageGenerationRoute, { executor: 'openai-images' }>
  sessionId: string
  prompt: string
  referenceImagePaths?: string[]
  cwd?: string
  allowedRoots?: string[]
  aspectRatio?: string
  imageSize?: string
  numberOfImages?: number
  signal?: AbortSignal
}

/** 与现有 Pi 图片工具一致的结构化附件结果。 */
export interface OpenAIImagesExecutionResult {
  imageAttachments: AgentToolResultImage[]
}

interface ParsedImage {
  bytes: Buffer
  mediaType: DownloadedRemoteImage['mediaType']
}

interface OpenAIImageResponseItem {
  b64_json?: string
  image_base64?: string
  base64?: string
  url?: string
  image_url?: string
}

const defaultDependencies: OpenAIImagesExecutorDependencies = {
  fetch: (input, init) => globalThis.fetch(input, init),
  downloadRemoteImage: (url, signal) => downloadSafeRemoteImage(url, undefined, signal),
  saveAttachment,
  deleteAttachment,
  createId: randomUUID,
}

/** 调用 OpenAI Images 兼容接口并把所有结果原子化保存为本地附件。 */
export async function executeOpenAIImages(
  input: ExecuteOpenAIImagesInput,
  dependencies: OpenAIImagesExecutorDependencies = defaultDependencies,
): Promise<OpenAIImagesExecutionResult> {
  input.signal?.throwIfAborted()
  const prompt = input.prompt.trim()
  if (!prompt) throw new Error('生图提示词不能为空')
  const count = normalizeImageCount(input.numberOfImages)
  const referenceImages = readAuthorizedReferenceImages(input)
  const endpoint = referenceImages.length > 0 ? 'images/edits' : 'images/generations'
  const url = `${input.route.baseUrl.trim().replace(/\/+$/, '')}/${endpoint}`
  const request = referenceImages.length > 0
    ? createEditRequest(input, prompt, count, referenceImages[0]!)
    : createGenerationRequest(input, prompt, count)

  input.signal?.throwIfAborted()
  const response = await dependencies.fetch(url, request)
  input.signal?.throwIfAborted()
  if (!response.ok) throw await createResponseError(response)
  const responseBody = await parseJsonResponse(response)
  const items = parseResponseItems(responseBody)
  /** 先解析并验证完整响应，避免保存部分成功后才发现后续条目无效。 */
  const parsedImages: ParsedImage[] = []
  for (const item of items) {
    parsedImages.push(await parseResponseImage(item, dependencies, input.signal))
  }
  input.signal?.throwIfAborted()
  return saveParsedImages(input, parsedImages, dependencies)
}

/** 构建 OpenAI Images JSON 文生图请求。 */
function createGenerationRequest(
  input: ExecuteOpenAIImagesInput,
  prompt: string,
  count: number,
): RequestInit {
  return {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${input.route.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: input.route.snapshot.modelId,
      prompt,
      size: resolveOpenAIImageSize(input.aspectRatio),
      n: count,
    }),
    signal: input.signal,
  }
}

/** 构建 OpenAI Images multipart 单参考图编辑请求。 */
function createEditRequest(
  input: ExecuteOpenAIImagesInput,
  prompt: string,
  count: number,
  reference: ParsedImage & { filename: string },
): RequestInit {
  const form = new FormData()
  form.set('model', input.route.snapshot.modelId)
  form.set('prompt', prompt)
  form.set('size', resolveOpenAIImageSize(input.aspectRatio))
  form.set('n', String(count))
  form.set('image', new Blob([new Uint8Array(reference.bytes)], { type: reference.mediaType }), reference.filename)
  return {
    method: 'POST',
    headers: { Authorization: `Bearer ${input.route.apiKey}` },
    body: form,
    signal: input.signal,
  }
}

/** 校验全部参考图路径，首版协议只把第一张发送给 edits。 */
function readAuthorizedReferenceImages(
  input: ExecuteOpenAIImagesInput,
): Array<ParsedImage & { filename: string }> {
  const paths = input.referenceImagePaths ?? []
  if (paths.length === 0) return []
  const roots = [input.cwd, ...(input.allowedRoots ?? [])]
    .filter((root): root is string => typeof root === 'string' && root.trim().length > 0)
    .map((root) => resolveAuthorizedRoot(root))
  if (roots.length === 0) throw new Error('参考图缺少授权目录')
  return paths.map((rawPath) => {
    const candidate = isAbsolute(rawPath) ? rawPath : resolve(input.cwd ?? '', rawPath)
    const lexicalPath = resolve(candidate)
    if (!roots.some((root) => isContainedPath(root.lexical, lexicalPath))) {
      throw new Error('参考图不在授权目录内')
    }
    const actualPath = resolveExistingPath(candidate)
    if (!roots.some((root) => isContainedPath(root.actual, actualPath))) {
      throw new Error('参考图不在授权目录内')
    }
    const stats = statSync(actualPath)
    if (!stats.isFile() || stats.size > MAX_ATTACHMENT_SIZE) throw new Error('参考图无效或超过大小限制')
    const bytes = readFileSync(actualPath)
    const mediaType = detectImageMediaType(bytes)
    if (!mediaType) throw new Error('参考图不是受支持的图片')
    return { bytes, mediaType, filename: basename(actualPath) }
  })
}

/** 解析授权根；根暂时不可访问时仍可先用于词法越界判断。 */
function resolveAuthorizedRoot(path: string): { lexical: string; actual: string } {
  const lexical = resolve(path)
  try {
    return { lexical, actual: realpathSync(lexical) }
  } catch {
    return { lexical, actual: lexical }
  }
}

/** 解析真实路径，拒绝不存在的参考图或授权根。 */
function resolveExistingPath(path: string): string {
  try {
    return realpathSync(resolve(path))
  } catch {
    throw new Error('参考图不存在或不可访问')
  }
}

/** 判断真实路径是否位于已授权根内。 */
function isContainedPath(root: string, candidate: string): boolean {
  const contained = relative(root, candidate)
  return contained === '' || (contained !== '..' && !contained.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
    && !isAbsolute(contained))
}

/** 将工具参数限制到服务支持的 1 至 4 张。 */
function normalizeImageCount(value: number | undefined): number {
  if (value === undefined) return 1
  if (!Number.isSafeInteger(value) || value < 1 || value > 4) throw new Error('生图数量必须在 1 到 4 之间')
  return value
}

/** 将 Design 的常用画幅映射到 OpenAI Images 尺寸。 */
function resolveOpenAIImageSize(aspectRatio?: string): string {
  if (aspectRatio === '16:9' || aspectRatio === '4:3') return '1536x1024'
  if (aspectRatio === '9:16' || aspectRatio === '3:4') return '1024x1536'
  return '1024x1024'
}

/** 严格读取 JSON 响应，拒绝 HTML 或其它代理错误页。 */
async function parseJsonResponse(response: Response): Promise<unknown> {
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
  if (!contentType.includes('application/json')) throw new Error('生图服务返回了非 JSON 响应')
  try {
    return await response.json()
  } catch {
    throw new Error('生图服务返回的 JSON 无效')
  }
}

/** 从 OpenAI Images 兼容响应中提取非空 data 数组。 */
function parseResponseItems(value: unknown): OpenAIImageResponseItem[] {
  if (!isRecord(value) || !Array.isArray(value.data) || value.data.length === 0) {
    throw new Error('生图服务没有返回图片')
  }
  return value.data.map((item) => {
    if (!isRecord(item)) throw new Error('生图服务返回的图片条目无效')
    return {
      b64_json: optionalString(item.b64_json),
      image_base64: optionalString(item.image_base64),
      base64: optionalString(item.base64),
      url: optionalString(item.url),
      image_url: optionalString(item.image_url),
    }
  })
}

/** 解析单个 Base64 或 URL 图片结果，并验证实际图片签名。 */
async function parseResponseImage(
  item: OpenAIImageResponseItem,
  dependencies: OpenAIImagesExecutorDependencies,
  signal?: AbortSignal,
): Promise<ParsedImage> {
  signal?.throwIfAborted()
  const base64 = item.b64_json ?? item.image_base64 ?? item.base64
  if (base64) {
    const bytes = decodeStrictBase64(base64)
    const mediaType = detectImageMediaType(bytes)
    if (!mediaType) throw new Error('生图服务返回的 Base64 不是受支持的图片')
    return { bytes, mediaType }
  }
  const url = item.url ?? item.image_url
  if (!url) throw new Error('生图服务返回的图片条目缺少内容')
  const downloaded = await dependencies.downloadRemoteImage(url, signal)
  const detected = detectImageMediaType(downloaded.bytes)
  if (!detected || detected !== downloaded.mediaType) throw new Error('远程图片内容与类型不一致')
  return downloaded
}

/** 严格解码标准 Base64，拒绝空白、URL-safe 变体和静默截断。 */
function decodeStrictBase64(value: string): Buffer {
  if (!value || value.length % 4 !== 0
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error('生图服务返回的 Base64 无效')
  }
  const bytes = Buffer.from(value, 'base64')
  if (bytes.length === 0 || bytes.length > MAX_ATTACHMENT_SIZE) throw new Error('生图结果为空或超过大小限制')
  return bytes
}

/** 依据文件签名识别 Proma 支持的四类图片。 */
function detectImageMediaType(bytes: Buffer): DownloadedRemoteImage['mediaType'] | undefined {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 6 && (bytes.subarray(0, 6).toString('ascii') === 'GIF87a'
    || bytes.subarray(0, 6).toString('ascii') === 'GIF89a')) return 'image/gif'
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF'
    && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
  return undefined
}

/** 保存已完整验证的图片，并在任一保存失败时回滚本轮已写附件。 */
function saveParsedImages(
  input: ExecuteOpenAIImagesInput,
  images: ParsedImage[],
  dependencies: OpenAIImagesExecutorDependencies,
): OpenAIImagesExecutionResult {
  const savedPaths: string[] = []
  const imageAttachments: AgentToolResultImage[] = []
  try {
    for (const [index, image] of images.entries()) {
      input.signal?.throwIfAborted()
      const extension = extensionForMediaType(image.mediaType)
      const filename = `gpt-image-2-${dependencies.createId()}-${index + 1}${extension}`
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

/** 获取保存附件使用的可信扩展名。 */
function extensionForMediaType(mediaType: DownloadedRemoteImage['mediaType']): string {
  if (mediaType === 'image/jpeg') return '.jpg'
  if (mediaType === 'image/webp') return '.webp'
  if (mediaType === 'image/gif') return '.gif'
  return '.png'
}

/** 构建不含 Header、Key、prompt、Base64 或本地路径的服务错误。 */
async function createResponseError(response: Response): Promise<Error> {
  const requestId = response.headers.get('x-request-id')?.trim()
  let message = ''
  try {
    const body = await response.json()
    if (isRecord(body) && isRecord(body.error) && typeof body.error.message === 'string') {
      message = sanitizeServiceMessage(body.error.message)
    }
  } catch {
    message = ''
  }
  const requestSuffix = requestId ? `，请求 ID: ${sanitizeServiceMessage(requestId)}` : ''
  const messageSuffix = message ? `：${message}` : ''
  return new Error(`生图服务请求失败 (${response.status})${requestSuffix}${messageSuffix}`)
}

/** 清洗服务错误中的控制字符并限制公开长度。 */
function sanitizeServiceMessage(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200)
}

/** 将未知字段收窄为非空字符串。 */
function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** 判断未知值是否为普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
