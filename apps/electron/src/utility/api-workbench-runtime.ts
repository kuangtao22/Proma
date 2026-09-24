import { createCipheriv, randomBytes, type CipherGCM } from 'node:crypto'
import { createWriteStream, type WriteStream } from 'node:fs'
import { once } from 'node:events'
import { join } from 'node:path'
import { API_LIMITS, type ApiSseEvent, type ApiTransportResult } from '@proma/shared'
import { executeApiTransport } from '../main/lib/api-workbench/api-transport.ts'
import {
  parseApiRuntimeRequest,
  type ApiRuntimeMessage,
  type ApiRuntimeRequest,
} from '../main/lib/api-workbench/api-runtime-protocol.ts'

/** 加密产物固定魔数。 */
const ARTIFACT_MAGIC = Buffer.from('API1', 'ascii')
/** AES-GCM 使用 96 位随机 IV。 */
const ARTIFACT_IV_BYTES = 12
/** 事件增量最长等待时间，保证低流量流也会及时出现在界面。 */
const SSE_FLUSH_INTERVAL_MS = 100

/** Electron utility process 暴露的父端口最小接口。 */
interface RuntimeParentPort {
  on(event: 'message', listener: (event: { data: unknown }) => void): void
  postMessage(message: ApiRuntimeMessage): void
  start?: () => void
}

/**
 * 事件增量批量上报器：按条数或时间触发，避免每帧一次进程消息。
 * @param post 真正发送一批事件的回调。
 * @returns push 与 flush 两个入口；flush 必须在发送最终结果前调用。
 */
function createSseBatcher(post: (events: ApiSseEvent[]) => void): { push: (event: ApiSseEvent) => void; flush: () => void } {
  let pending: ApiSseEvent[] = []
  /** 已缓冲事件的原始帧字符数，用于同时约束单条进程消息大小。 */
  let pendingChars = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  /** 立即发送已缓冲事件并清理定时器。 */
  const flush = (): void => {
    if (timer) {
      clearTimeout(timer)
      timer = undefined
    }
    if (pending.length === 0) return
    const batch = pending
    pending = []
    pendingChars = 0
    post(batch)
  }
  return {
    push: (event) => {
      pending.push(event)
      pendingChars += event.raw.length
      if (pending.length >= API_LIMITS.sseDeltaEvents || pendingChars >= API_LIMITS.sseDeltaChars) {
        flush()
        return
      }
      if (!timer) timer = setTimeout(flush, SSE_FLUSH_INTERVAL_MS)
    },
    flush,
  }
}

/** 单个加密文件写入器，明文字节不会缓存在内存。 */
class EncryptedArtifactWriter {
  private readonly cipher: CipherGCM
  private readonly stream: WriteStream
  private finalized = false

  private constructor(stream: WriteStream, cipher: CipherGCM) {
    this.stream = stream
    this.cipher = cipher
  }

  /** 创建文件并先写入 API1 与随机 IV。 */
  static async create(path: string, key: Buffer): Promise<EncryptedArtifactWriter> {
    const iv = randomBytes(ARTIFACT_IV_BYTES)
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    const stream = createWriteStream(path, { flags: 'wx', mode: 0o600 })
    await once(stream, 'open')
    const writer = new EncryptedArtifactWriter(stream, cipher)
    await writer.writeEncrypted(Buffer.concat([ARTIFACT_MAGIC, iv]), false)
    return writer
  }

  /** 流式加密一段真实响应字节，并遵守文件背压。 */
  async write(chunk: Uint8Array): Promise<void> {
    if (this.finalized) throw new Error('加密产物已经结束')
    await this.writeEncrypted(this.cipher.update(chunk), false)
  }

  /** 写入 final 和 authTag，并等待文件描述符真实 close。 */
  async finalize(): Promise<void> {
    if (this.finalized) return
    this.finalized = true
    const tail = Buffer.concat([this.cipher.final(), this.cipher.getAuthTag()])
    await this.writeEncrypted(tail, true)
    if (!this.stream.closed) await once(this.stream, 'close')
  }

  /** 关闭未能认证完成的文件，调用方会把产物标为不可用。 */
  async closeUnavailable(): Promise<void> {
    if (this.stream.closed) return
    this.stream.destroy()
    await once(this.stream, 'close').catch(() => {})
  }

  /** 写入密文；结束写入时由 end 触发 flush 与 close。 */
  private async writeEncrypted(chunk: Buffer, end: boolean): Promise<void> {
    if (end) {
      await new Promise<void>((resolve, reject) => {
        const fail = (error: Error): void => { this.stream.off('error', fail); reject(error) }
        this.stream.once('error', fail)
        this.stream.end(chunk, () => { this.stream.off('error', fail); resolve() })
      })
      return
    }
    if (!this.stream.write(chunk)) await once(this.stream, 'drain')
  }
}

/** 创建原始和解码正文两个独立加密写入器。 */
async function createArtifactWriters(directory: string, keyBase64: string): Promise<{ raw: EncryptedArtifactWriter; decoded: EncryptedArtifactWriter }> {
  const key = Buffer.from(keyBase64, 'base64')
  if (key.byteLength !== 32) throw new Error('AES-256-GCM 密钥长度无效')
  let raw: EncryptedArtifactWriter | undefined
  try {
    raw = await EncryptedArtifactWriter.create(join(directory, 'raw.bin.enc'), key)
    const decoded = await EncryptedArtifactWriter.create(join(directory, 'decoded.bin.enc'), key)
    return { raw, decoded }
  } catch (error) {
    await raw?.closeUnavailable()
    throw error
  } finally {
    key.fill(0)
  }
}

/** 生成不包含路径、密钥或底层文件错误细节的产物失败结果。 */
function artifactUnavailable(result?: ApiTransportResult): ApiTransportResult {
  return {
    state: 'failed', hops: result?.hops ?? [],
    body: result?.body ?? { rawBytes: 0, decodedBytes: 0, contentType: '', encoding: '', preview: '', previewTruncated: false, complete: false, decoded: false },
    error: { code: 'API_ARTIFACT_UNAVAILABLE', phase: 'artifact', message: '响应产物无法完成加密，已标记为不可用' },
  }
}

/**
 * 执行 utility 的单次运行。无 artifacts 时只保留传输层有界预览；有 artifacts
 * 时成功、失败或取消都会尝试完成 GCM 标签，使已采集的 partial 字节可认证读取。
 */
export async function executeApiRuntimeRun(
  message: Extract<ApiRuntimeRequest, { type: 'api-workbench.run' }>,
  signal?: AbortSignal,
  onSseEvent?: (event: ApiSseEvent) => void,
): Promise<ApiTransportResult> {
  if (!message.artifacts) return executeApiTransport(message.request, { signal, ...(onSseEvent ? { onSseEvent } : {}) })
  let writers: { raw: EncryptedArtifactWriter; decoded: EncryptedArtifactWriter }
  try {
    writers = await createArtifactWriters(message.artifacts.directory, message.artifacts.keyBase64)
  } catch {
    return artifactUnavailable()
  }
  let result: ApiTransportResult | undefined
  try {
    result = await executeApiTransport(message.request, {
      signal,
      onRawChunk: (chunk) => writers.raw.write(chunk),
      onDecodedChunk: (chunk) => writers.decoded.write(chunk),
      ...(onSseEvent ? { onSseEvent } : {}),
    })
    await Promise.all([writers.raw.finalize(), writers.decoded.finalize()])
    return result
  } catch {
    await Promise.all([writers.raw.closeUnavailable(), writers.decoded.closeUnavailable()])
    return artifactUnavailable(result)
  }
}

/** utility 进程一次只接受一个 run；cancel 必须命中当前 requestId。 */
function attachRuntime(parentPort: RuntimeParentPort): void {
  let activeRequestId: string | undefined
  let controller: AbortController | undefined
  let resultSent = false
  parentPort.on('message', (event) => {
    let message: ApiRuntimeRequest
    const outer = event.data
    const payload = outer && typeof outer === 'object' && 'data' in outer ? (outer as { data: unknown }).data : outer
    try { message = parseApiRuntimeRequest(payload) } catch { return }
    if (message.type === 'api-workbench.cancel') {
      if (message.requestId === activeRequestId) controller?.abort()
      return
    }
    if (message.type === 'api-workbench.ack') {
      if (resultSent && message.requestId === activeRequestId) process.exit(0)
      return
    }
    if (activeRequestId) return
    activeRequestId = message.requestId
    controller = new AbortController()
    /** 事件增量必须先于结果回执发出，父进程按到达顺序装配运行记录。 */
    const batcher = createSseBatcher((events) => parentPort.postMessage({
      type: 'api-workbench.stream', requestId: message.requestId, events,
    }))
    void executeApiRuntimeRun(message, controller.signal, (event) => batcher.push(event)).then((result) => {
      batcher.flush()
      resultSent = true
      parentPort.postMessage({ type: 'api-workbench.result', requestId: message.requestId, result })
    }, () => {
      batcher.flush()
      resultSent = true
      parentPort.postMessage({
        type: 'api-workbench.result', requestId: message.requestId,
        result: artifactUnavailable(),
      })
    })
  })
  parentPort.start?.()
}

/** Node 原生测试导入时没有 parentPort；Electron utility 启动时自动挂载。 */
const parentPort = (process as typeof process & { parentPort?: RuntimeParentPort }).parentPort
if (parentPort) attachRuntime(parentPort)
