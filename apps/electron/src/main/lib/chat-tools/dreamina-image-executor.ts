/**
 * 即梦图像执行器。
 *
 * 即梦没有 HTTP 接口，凭据是本机 CLI 登录态：先 `text2image` 提交任务拿到 submit_id，
 * 再 `query_result --download_dir` 轮询下载结果，最后把文件保存为受管附件。
 * 只有 gen_status=success 才算成功；submit 被接受不等于生成完成。
 */
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import type { AgentToolResultImage } from '@proma/shared'
import { deleteAttachment, saveAttachment } from '../attachment-service'
import type { ResolvedImageGenerationRoute } from '../image-generation-runtime'
import type { ImageRequestAudit } from './image-request-context'
import { readAuthorizedReferenceImages } from './openai-images-executor'

/** 单次 CLI 调用结果；只保留判定所需字段。 */
export interface DreaminaCliResult {
  exitCode: number
  stdout: string
  stderr: string
  /** CLI 缺失或进程超时等基础设施失败，与业务失败区分。 */
  failureCode?: 'cliMissing' | 'timeout'
}

export type DreaminaCliRunner = (args: readonly string[], cliPath: string) => Promise<DreaminaCliResult>

/** 执行器依赖，测试可整体替换。 */
export interface DreaminaImagesExecutorDependencies {
  runCli: DreaminaCliRunner
  saveAttachment: typeof saveAttachment
  deleteAttachment: typeof deleteAttachment
  createTempDir: () => Promise<string>
  removeTempDir: (path: string) => Promise<void>
}

export interface ExecuteDreaminaImagesInput {
  route: Extract<ResolvedImageGenerationRoute, { executor: 'dreamina-image' }>
  sessionId: string
  prompt: string
  /** 参考图路径；非空时走 image2image，最多 10 张。 */
  referenceImagePaths?: string[]
  /** 参考图授权根与工作目录，与其它执行器共用同一套校验。 */
  cwd?: string
  allowedRoots?: string[]
  aspectRatio?: string
  numberOfImages?: number
  signal?: AbortSignal
  captureRequest?: (request: ImageRequestAudit) => void
  /** 生成结果的等待上限；缺省 4 分钟。 */
  timeoutMs?: number
  /** 自定义输出宽高（像素）；与宽高比互斥，且必须同时给出。 */
  width?: number
  height?: number
  /** 轮询间隔；缺省 3 秒。 */
  pollIntervalMs?: number
}

export interface DreaminaImagesExecutionResult {
  imageAttachments: AgentToolResultImage[]
}

/** 单次请求允许生成的图片数量上限。 */
const MAX_IMAGE_COUNT = 4
/** 即梦图生图允许的参考图数量上限，来自 CLI 说明。 */
const MAX_REFERENCE_IMAGE_COUNT = 10
/** 默认等待生成完成的时长。 */
const DEFAULT_TIMEOUT_MS = 4 * 60_000
/** 默认轮询间隔。 */
const DEFAULT_POLL_INTERVAL_MS = 3_000
/** 单次 CLI 调用超时，避免轮询或提交挂死。 */
const CLI_TIMEOUT_MS = 60_000
/** 即梦支持的宽高比；不在表内的取值不传 --ratio。 */
const SUPPORTED_ASPECT_RATIOS = new Set(['1:1', '3:4', '16:9', '4:3', '9:16', '21:9'])

/**
 * 各分辨率档位的边长与总像素上限，来自 `dreamina image2image -h`。
 * 两个约束必须同时满足，后端配置仍是最终权威。
 */
const RESOLUTION_LIMITS: Record<string, { minSide: number; maxSide: number; maxPixels: number }> = {
  '1k': { minSide: 512, maxSide: 2016, maxPixels: 1_763_584 },
  '1.5k': { minSide: 972, maxSide: 2268, maxPixels: 2_359_296 },
  '2k': { minSide: 768, maxSide: 3072, maxPixels: 4_194_304 },
  '4k': { minSide: 1536, maxSide: 6240, maxPixels: 16_777_216 },
}

const defaultDependencies: DreaminaImagesExecutorDependencies = {
  runCli: (args, cliPath) => defaultRunCli(args, cliPath),
  saveAttachment,
  deleteAttachment,
  createTempDir: () => mkdtemp(join(tmpdir(), 'proma-dreamina-')),
  removeTempDir: (path) => rm(path, { recursive: true, force: true }),
}

/** 提交与查询结果的最小结构。 */
interface DreaminaTaskPayload {
  submitId: string
  status: string
  failReason: string
  imagePaths: string[]
}

/** 执行一次即梦文生图并返回受管附件。 */
export async function executeDreaminaImages(
  input: ExecuteDreaminaImagesInput,
  dependencies: DreaminaImagesExecutorDependencies = defaultDependencies,
): Promise<DreaminaImagesExecutionResult> {
  input.signal?.throwIfAborted()
  const prompt = input.prompt.trim()
  if (!prompt) throw new Error('生图提示词不能为空')
  /** 参考图必须通过授权目录校验；超限或越界都在调用 CLI 前拒绝。 */
  const references = readAuthorizedReferenceImages(input)
  if (references.length > MAX_REFERENCE_IMAGE_COUNT) {
    throw new Error(`即梦图生图最多支持 ${MAX_REFERENCE_IMAGE_COUNT} 张参考图`)
  }
  const count = normalizeImageCount(input.numberOfImages)
  const cliPath = input.route.cliPath?.trim() || 'dreamina'
  const workDir = await dependencies.createTempDir()
  try {
    input.captureRequest?.({
      executor: 'dreamina-image',
      modelId: input.route.snapshot.modelId,
      prompt,
      referenceImages: references.map((reference) => ({
        path: reference.path,
        sha256: createHash('sha256').update(reference.bytes).digest('hex'),
        byteSize: reference.bytes.length,
      })),
    })
    const submitted = await submitTask(input, dependencies, cliPath, prompt, count, references)
    const payload = await waitForResult(input, dependencies, cliPath, submitted, workDir)
    return await saveResultImages(input, dependencies, payload.imagePaths, workDir)
  } finally {
    /** 临时下载目录只承载中间产物，落附件后必须清理。 */
    await dependencies.removeTempDir(workDir).catch(() => undefined)
  }
}

/** 提交文生图任务并解析 submit_id。 */
async function submitTask(
  input: ExecuteDreaminaImagesInput,
  dependencies: DreaminaImagesExecutorDependencies,
  cliPath: string,
  prompt: string,
  count: number,
  references: readonly { path: string }[],
): Promise<string> {
  const params = input.route.snapshot
  /** 有参考图就是编辑任务，必须走 image2image，而不是把参考图丢掉。 */
  const args = references.length > 0
    ? [
        'image2image',
        `--prompt=${prompt}`,
        `--model_version=${params.modelId}`,
        ...references.map((reference) => `--images=${reference.path}`),
        `--generate_num=${count}`,
        '--poll=0',
      ]
    : [
        'text2image',
        `--prompt=${prompt}`,
        `--model_version=${params.modelId}`,
        `--generate_num=${count}`,
        '--poll=0',
      ]
  const ratio = resolveAspectRatio(input.aspectRatio)
  /** 自定义尺寸与宽高比互斥，CLI 不接受同时传入。 */
  const size = resolveCustomSize(input)
  if (size) args.push(`--width=${size.width}`, `--height=${size.height}`)
  else if (ratio) args.push(`--ratio=${ratio}`)
  const result = await dependencies.runCli(args, cliPath)
  assertCliAvailable(result)
  /** 需要网页确认等情况 CLI 不返回 JSON，必须先识别提示再尝试解析。 */
  const failure = describeCliFailure(result)
  if (failure) throw new Error(failure)
  const payload = parseTaskPayload(result.stdout)
  if (!payload.submitId) throw new Error('即梦未返回任务 ID，提交失败')
  return payload.submitId
}

/** 轮询直到终态；超时或取消都立即结束并给出明确原因。 */
async function waitForResult(
  input: ExecuteDreaminaImagesInput,
  dependencies: DreaminaImagesExecutorDependencies,
  cliPath: string,
  submitId: string,
  workDir: string,
): Promise<DreaminaTaskPayload> {
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const intervalMs = input.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  const deadline = Date.now() + timeoutMs
  let last: DreaminaTaskPayload | undefined
  while (true) {
    input.signal?.throwIfAborted()
    const result = await dependencies.runCli(
      ['query_result', `--submit_id=${submitId}`, `--download_dir=${workDir}`],
      cliPath,
    )
    assertCliAvailable(result)
    const payload = parseTaskPayload(result.stdout)
    last = payload
    /** CLI 明确失败时直接报原因，不把 fail 当成待完成继续轮询。 */
    if (payload.status === 'fail') {
      throw new Error(payload.failReason ? `即梦生成失败：${payload.failReason}` : '即梦生成失败')
    }
    if (payload.status === 'success' && payload.imagePaths.length > 0) return payload
    const failure = describeCliFailure(result)
    if (failure) throw new Error(failure)
    if (Date.now() >= deadline) {
      throw new Error(`即梦生成超时，任务 ${submitId} 可能仍在进行，可在即梦客户端查看`)
    }
    await sleep(intervalMs, input.signal)
  }
}

/** 校验下载结果全部位于本次临时目录内，再保存为受管附件。 */
async function saveResultImages(
  input: ExecuteDreaminaImagesInput,
  dependencies: DreaminaImagesExecutorDependencies,
  imagePaths: readonly string[],
  workDir: string,
): Promise<DreaminaImagesExecutionResult> {
  const root = resolve(workDir)
  const savedPaths: string[] = []
  const imageAttachments: AgentToolResultImage[] = []
  try {
    for (const [index, imagePath] of imagePaths.entries()) {
      input.signal?.throwIfAborted()
      /** 只接受本次任务目录内的文件，防止 CLI 输出被篡改后读取任意路径。 */
      const absolute = resolve(imagePath)
      if (absolute !== root && !absolute.startsWith(`${root}${sep}`)) {
        throw new Error('即梦返回的图片路径不在任务目录内，已拒绝读取')
      }
      /** 文件可能已被 CLI 删除，缺失时给出业务提示而不是原生 ENOENT。 */
      const exists = await stat(absolute).then((info) => info.isFile()).catch(() => false)
      if (!exists) throw new Error('即梦返回的图片文件不存在')
      const bytes = await readFile(absolute)
      const filename = `dreamina-image-${input.route.snapshot.modelId}-${index + 1}.png`
      const result = dependencies.saveAttachment({
        conversationId: input.sessionId,
        filename,
        mediaType: 'image/png',
        data: bytes.toString('base64'),
      })
      savedPaths.push(result.attachment.localPath)
      imageAttachments.push({
        localPath: result.attachment.localPath,
        filename: result.attachment.filename,
        mediaType: result.attachment.mediaType,
      })
    }
    if (imageAttachments.length === 0) throw new Error('即梦未返回任何图片')
    return { imageAttachments }
  } catch (error) {
    for (const path of savedPaths) dependencies.deleteAttachment(path)
    throw error
  }
}

/** CLI 缺失或超时统一转成可操作提示。 */
function assertCliAvailable(result: DreaminaCliResult): void {
  if (result.failureCode === 'cliMissing') throw new Error('未找到即梦 CLI，请检查安装或 cliPath 配置')
  if (result.failureCode === 'timeout') throw new Error('即梦 CLI 调用超时，请检查网络后重试')
}

/** 从 CLI 输出里识别需要用户先去网页确认的情况。 */
function describeCliFailure(result: DreaminaCliResult): string | null {
  const output = `${result.stdout}\n${result.stderr}`
  if (output.includes('AigcComplianceConfirmationRequired')) {
    return '该模型需要先在即梦网页端完成一次生成确认，请到即梦 Web 完成后再重试'
  }
  if (result.exitCode !== 0 && !output.trim()) return '即梦 CLI 执行失败，请检查登录态'
  return null
}

/** 解析 CLI 的 JSON 输出；即梦在纯文本错误时也应给出可读提示。 */
function parseTaskPayload(stdout: string): DreaminaTaskPayload {
  const matched = /\{[\s\S]*\}/.exec(stdout)
  if (!matched) throw new Error('即梦返回内容无法解析')
  let parsed: unknown
  try {
    parsed = JSON.parse(matched[0])
  } catch {
    throw new Error('即梦返回内容无法解析')
  }
  if (parsed === null || typeof parsed !== 'object') throw new Error('即梦返回内容无法解析')
  const record = parsed as Record<string, unknown>
  const images = (record.result_json as { images?: unknown } | undefined)?.images
  return {
    submitId: typeof record.submit_id === 'string' ? record.submit_id : '',
    status: typeof record.gen_status === 'string' ? record.gen_status : '',
    failReason: typeof record.fail_reason === 'string' ? record.fail_reason : '',
    imagePaths: Array.isArray(images)
      ? images.flatMap((item) => (item !== null && typeof item === 'object' && typeof (item as { path?: unknown }).path === 'string'
        ? [(item as { path: string }).path]
        : []))
      : [],
  }
}

/** 归一化生成张数；非法值回落到 1。 */
function normalizeImageCount(value: number | undefined): number {
  if (value === undefined) return 1
  if (!Number.isSafeInteger(value) || value < 1) return 1
  return Math.min(value, MAX_IMAGE_COUNT)
}

/** 把画布宽高比映射到 CLI 支持的取值。 */
function resolveAspectRatio(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  return SUPPORTED_ASPECT_RATIOS.has(value) ? value : undefined
}

/**
 * 校验并解析自定义尺寸。
 * 入参：执行输入；返回值：合法宽高，未指定时返回 null。
 * 规则来自 CLI 说明：必须同时给出正整数、落在所选分辨率档位的边长与总像素上限内。
 */
function resolveCustomSize(input: ExecuteDreaminaImagesInput): { width: number; height: number } | null {
  const { width, height } = input
  if (width === undefined && height === undefined) return null
  if (width === undefined || height === undefined) {
    throw new Error('自定义尺寸必须同时提供 width 与 height')
  }
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
    throw new Error('自定义尺寸必须为正整数')
  }
  /** 档位来自模型参数；未知档位时按 2k 处理，与内置默认一致。 */
  const resolutionType = input.route.resolutionType ?? '2k'
  const limits = RESOLUTION_LIMITS[resolutionType.toLowerCase()] ?? RESOLUTION_LIMITS['2k']!
  const withinSide = width >= limits.minSide && width <= limits.maxSide
    && height >= limits.minSide && height <= limits.maxSide
  const withinPixels = width * height <= limits.maxPixels
  if (!withinSide || !withinPixels) {
    throw new Error(`自定义尺寸超出 ${resolutionType} 档位限制：每边需在 ${limits.minSide}-${limits.maxSide}，总像素不超过 ${limits.maxPixels}`)
  }
  return { width, height }
}

/** 可被取消的等待。 */
async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolveSleep, rejectSleep) => {
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolveSleep() }, ms)
    const onAbort = (): void => { clearTimeout(timer); rejectSleep(new Error('即梦生成已取消')) }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** 生产默认执行器：spawn CLI 并在超时后终止子进程。 */
async function defaultRunCli(args: readonly string[], cliPath: string): Promise<DreaminaCliResult> {
  const { spawn } = await import('node:child_process')
  return await new Promise<DreaminaCliResult>((resolveResult) => {
    let settled = false
    let stdout = ''
    let stderr = ''
    const limit = 256 * 1024
    const finish = (result: DreaminaCliResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolveResult(result)
    }
    const child = spawn(cliPath, [...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* 进程已退出时忽略 */ }
      finish({ exitCode: 1, stdout, stderr, failureCode: 'timeout' })
    }, CLI_TIMEOUT_MS)
    child.stdout?.on('data', (chunk: Buffer) => { if (stdout.length < limit) stdout += chunk.toString('utf8') })
    child.stderr?.on('data', (chunk: Buffer) => { if (stderr.length < limit) stderr += chunk.toString('utf8') })
    child.once('error', () => finish({ exitCode: 1, stdout, stderr, failureCode: 'cliMissing' }))
    child.once('close', (code) => finish({ exitCode: code ?? 1, stdout, stderr }))
  })
}
