import { WebSocket } from 'ws'
import { ComfyUIClient } from './comfyui-client'

export type ComfyProgressEvent =
  | { type: 'node'; promptId: string; nodeId: string }
  | { type: 'progress'; promptId: string; nodeId?: string; value?: number; max?: number }
  | { type: 'changed'; promptId: string }
  | { type: 'disconnected'; promptId: string }

export interface ComfyProgressSubscription {
  connectionId: string
  instanceGeneration: string
  baseUrl: string
  headers?: Record<string, string>
  clientId: string
}

interface ProgressSocket {
  on(event: string, listener: (...args: unknown[]) => void): this
  close(): void
  terminate?(): void
}

interface StreamEntry {
  key: string
  input: ComfyProgressSubscription
  listeners: Set<(event: ComfyProgressEvent) => void>
  socket: ProgressSocket | null
  timer: ReturnType<typeof setTimeout> | null
  retryMs: number
  generation: number
}

export interface ComfyProgressStreamOptions {
  socketFactory?: (url: string, options: { headers?: Record<string, string> }) => ProgressSocket
  setTimeout?: (handler: () => void, timeout: number) => ReturnType<typeof setTimeout>
  clearTimeout?: (timer: ReturnType<typeof setTimeout>) => void
}

const MAX_FRAME_BYTES = 64 * 1024

/** 管理按连接实例复用的 ComfyUI 进度 WebSocket。 */
export class ComfyProgressStream {
  private readonly entries = new Map<string, StreamEntry>()
  private readonly makeSocket: (url: string, options: { headers?: Record<string, string> }) => ProgressSocket
  private readonly schedule: (handler: () => void, timeout: number) => ReturnType<typeof setTimeout>
  private readonly cancelTimer: (timer: ReturnType<typeof setTimeout>) => void

  constructor(options: ComfyProgressStreamOptions = {}) {
    this.makeSocket = options.socketFactory ?? ((url, socketOptions) => new WebSocket(url, socketOptions) as unknown as ProgressSocket)
    this.schedule = options.setTimeout ?? ((handler, timeout) => setTimeout(handler, timeout))
    this.cancelTimer = options.clearTimeout ?? ((timer) => clearTimeout(timer))
  }

  /** 订阅同一连接实例；最后一个订阅释放后关闭连接和重连定时器。 */
  subscribe(input: ComfyProgressSubscription, listener: (event: ComfyProgressEvent) => void): () => void {
    const key = `${input.connectionId}\0${input.instanceGeneration}\0${input.clientId}`
    let entry = this.entries.get(key)
    if (!entry) {
      entry = { key, input: { ...input, headers: input.headers ? { ...input.headers } : undefined }, listeners: new Set(), socket: null, timer: null, retryMs: 1_000, generation: 0 }
      this.entries.set(key, entry)
      entry.listeners.add(listener)
      this.connect(entry)
    }
    entry.listeners.add(listener)
    return () => {
      entry!.listeners.delete(listener)
      if (entry!.listeners.size === 0) this.remove(entry!)
    }
  }

  /** 关闭全部连接，供应用退出或实例切换时调用。 */
  dispose(): void {
    for (const entry of [...this.entries.values()]) this.remove(entry)
  }

  private connect(entry: StreamEntry): void {
    const generation = ++entry.generation
    const url = new ComfyUIClient({ baseUrl: entry.input.baseUrl }).buildWebSocketUrl(entry.input.clientId)
    let socket: ProgressSocket
    try { socket = this.makeSocket(url, { headers: entry.input.headers }) } catch { this.disconnected(entry, generation); return }
    entry.socket = socket
    socket.on('open', () => { if (entry.socket === socket && generation === entry.generation) entry.retryMs = 1_000 })
    socket.on('message', (data: unknown, isBinary: unknown) => { if (entry.socket === socket && generation === entry.generation && isBinary !== true) this.handleFrame(entry, data) })
    socket.on('close', () => { if (entry.socket === socket && generation === entry.generation) this.disconnected(entry, generation) })
    socket.on('error', () => { if (entry.socket === socket && generation === entry.generation) this.disconnected(entry, generation) })
  }

  private handleFrame(entry: StreamEntry, data: unknown): void {
    // ws 的文本帧默认也以 Buffer 回调，二进制标志必须在事件入口判断。
    if (Buffer.isBuffer(data) || data instanceof Uint8Array) {
      if (data.byteLength > MAX_FRAME_BYTES) return
      data = Buffer.from(data).toString('utf8')
    }
    if (typeof data !== 'string' || Buffer.byteLength(data, 'utf8') > MAX_FRAME_BYTES) return
    let value: unknown
    try { value = JSON.parse(data) } catch { return }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return
    const record = value as Record<string, unknown>
    const type = record.type
    const payload = record.data
    if (typeof type !== 'string' || !payload || typeof payload !== 'object' || Array.isArray(payload)) return
    const body = payload as Record<string, unknown>
    const promptId = body.prompt_id
    if (typeof promptId !== 'string' || !promptId || promptId.length > 256) return
    if (type === 'progress') {
      const valueNumber = body.value
      const maxNumber = body.max
      if (typeof valueNumber !== 'number' || !Number.isSafeInteger(valueNumber) || valueNumber < 0 || typeof maxNumber !== 'number' || !Number.isSafeInteger(maxNumber) || maxNumber <= 0 || valueNumber > maxNumber) return
      const nodeId = typeof body.node === 'string' && body.node ? body.node : undefined
      this.emit(entry, { type: 'progress', promptId, ...(nodeId ? { nodeId } : {}), value: valueNumber, max: maxNumber })
      return
    }
    if (type === 'executing') {
      if (body.node === null) this.emit(entry, { type: 'changed', promptId })
      else if (typeof body.node === 'string' && body.node) this.emit(entry, { type: 'node', promptId, nodeId: body.node })
      return
    }
    if (type === 'execution_start' || type === 'execution_cached' || type === 'execution_success' || type === 'execution_error') this.emit(entry, { type: 'changed', promptId })
  }

  private emit(entry: StreamEntry, event: ComfyProgressEvent): void {
    for (const listener of entry.listeners) {
      try { listener(event) } catch { /* 单个订阅失败不能关闭其它任务的共享连接。 */ }
    }
  }

  private disconnected(entry: StreamEntry, generation: number): void {
    if (generation !== entry.generation || entry.listeners.size === 0) return
    const socket = entry.socket
    entry.socket = null
    socket?.terminate?.()
    this.emit(entry, { type: 'disconnected', promptId: '' })
    const delay = entry.retryMs
    entry.retryMs = Math.min(30_000, entry.retryMs * 2)
    entry.timer = this.schedule(() => { entry!.timer = null; if (entry!.listeners.size > 0) this.connect(entry!) }, delay)
  }

  private remove(entry: StreamEntry): void {
    if (entry.timer) this.cancelTimer(entry.timer)
    entry.timer = null
    entry.generation += 1
    entry.socket?.close()
    entry.socket = null
    entry.listeners.clear()
    this.entries.delete(entry.key)
  }
}
