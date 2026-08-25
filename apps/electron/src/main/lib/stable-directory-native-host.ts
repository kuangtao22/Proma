import electron from 'electron'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const STABLE_DIRECTORY_PROTOCOL = 1
const DEFAULT_STARTUP_TIMEOUT_MS = 3_000
const DEFAULT_TOTAL_TIMEOUT_MS = 15_000
const DEFAULT_MAX_OUTPUT_BYTES = 16 * 1024 * 1024
const DEFAULT_MAX_ACTIVE_HELPERS = 4
const DEFAULT_MAX_QUEUED_REQUESTS = 16
const DEFAULT_MAX_ROOTS_PER_REQUEST = 32
const CANVAS_INTENT_FILE_PATTERN = /^agent-node-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/i
const { app } = electron

export interface StableDirectoryOpenedRoot {
  requestedPath: string
  canonicalPath: string
  isDirectory: boolean
  size?: number
  volume: string
  fileId: string
}

export interface StableDirectoryNativeEntry {
  rootIndex: number
  name: string
  path: string
  isDirectory: boolean
  size?: number
  /** Canvas intent scan 由 helper 句柄相对读取的 UTF-8 正文。 */
  content?: string
}

export interface StableDirectoryNativeRequest {
  mode: 'list' | 'scan' | 'canvas-intent-scan' | 'canvas-intent-write'
  roots: string[]
  maxDepth?: number
  maxEntries?: number
  maxOutputBytes?: number
  ignoreDirectories?: string[]
  ignoreFiles?: string[]
  /** Canvas intent 模式下固定的单级事务目录名。 */
  childName?: string
  /** 原子写模式下固定的单级目标文件名。 */
  fileName?: string
  /** 原子写模式下不超过 64 KiB 的 UTF-8 JSON。 */
  content?: string
  signal?: AbortSignal
}

export interface StableDirectoryNativeResult {
  roots: StableDirectoryOpenedRoot[]
  entries: StableDirectoryNativeEntry[]
}

export interface StableDirectoryNativeHostDependencies {
  helperPath?: () => string
  helperExists?: (path: string) => boolean
  spawnProcess?: (path: string, args: string[]) => ChildProcessWithoutNullStreams
  startupTimeoutMs?: number
  totalTimeoutMs?: number
}

export interface StableDirectoryNativeHostLimits {
  /** 同时运行的 helper 进程上限。 */
  maxActiveHelpers?: number
  /** 等待 helper 槽位的请求上限。 */
  maxQueuedRequests?: number
  /** 单次请求允许稳定打开的 root 上限。 */
  maxRootsPerRequest?: number
}

export interface StableDirectoryNativeHost {
  /** 在模块级资源预算内运行一次稳定目录请求。 */
  run: (
    request: StableDirectoryNativeRequest,
    authorize: StableDirectoryAuthorization,
    dependencies?: StableDirectoryNativeHostDependencies,
  ) => Promise<StableDirectoryNativeResult>
}

export type StableDirectoryAuthorization = (
  roots: readonly StableDirectoryOpenedRoot[],
) => boolean | Promise<boolean>

/** 返回开发态或打包态当前平台 helper 的稳定路径。 */
function defaultHelperPath(): string {
  const executableName = process.platform === 'win32'
    ? 'stable-directory-helper.exe'
    : 'stable-directory-helper'
  return app.isPackaged
    ? join(process.resourcesPath, 'stable-directory', executableName)
    : join(__dirname, 'resources', 'stable-directory', executableName)
}

/** 把结构化请求转换为不经过 shell 的 argv。 */
function buildHelperArguments(request: StableDirectoryNativeRequest): string[] {
  const args = ['--mode', request.mode]
  for (const root of request.roots) args.push('--root', root)
  args.push('--max-depth', String(request.maxDepth ?? (request.mode === 'list' ? 0 : 10)))
  args.push('--max-entries', String(request.maxEntries ?? 10_000))
  args.push('--max-output-bytes', String(request.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES))
  for (const name of request.ignoreDirectories ?? []) args.push('--ignore-dir', name)
  for (const name of request.ignoreFiles ?? []) args.push('--ignore-file', name)
  if (request.childName) args.push('--child-name', request.childName)
  if (request.fileName) args.push('--file-name', request.fileName)
  return args
}

/** 校验 helper 报告的已打开根对象。 */
function parseOpenedRoots(value: unknown): StableDirectoryOpenedRoot[] | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (record.type !== 'opened' || record.protocol !== STABLE_DIRECTORY_PROTOCOL || !Array.isArray(record.roots)) return null
  const roots: StableDirectoryOpenedRoot[] = []
  for (const candidate of record.roots) {
    if (!candidate || typeof candidate !== 'object') return null
    const root = candidate as Record<string, unknown>
    if (typeof root.requestedPath !== 'string'
      || typeof root.canonicalPath !== 'string'
      || typeof root.isDirectory !== 'boolean'
      || typeof root.volume !== 'string'
      || typeof root.fileId !== 'string'
      || (root.size !== undefined && typeof root.size !== 'number')) return null
    roots.push({
      requestedPath: root.requestedPath,
      canonicalPath: root.canonicalPath,
      isDirectory: root.isDirectory,
      size: typeof root.size === 'number' ? root.size : undefined,
      volume: root.volume,
      fileId: root.fileId,
    })
  }
  return roots
}

/** 校验单条 helper 枚举结果，拒绝非协议字段进入业务层。 */
function parseEntry(
  value: unknown,
  request: StableDirectoryNativeRequest,
): StableDirectoryNativeEntry | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (record.type !== 'entry'
    || !Number.isSafeInteger(record.rootIndex)
    || typeof record.rootIndex !== 'number'
    || record.rootIndex < 0
    || record.rootIndex >= request.roots.length
    || typeof record.name !== 'string'
    || typeof record.path !== 'string'
    || typeof record.isDirectory !== 'boolean'
    || (record.size !== undefined
      && (typeof record.size !== 'number' || !Number.isSafeInteger(record.size) || record.size < 0))
    || (record.content !== undefined && typeof record.content !== 'string')) return null
  const isCanvasScan = request.mode === 'canvas-intent-scan'
  if (isCanvasScan && (record.path !== '' || (!record.isDirectory && typeof record.content !== 'string'))) {
    return null
  }
  if (isCanvasScan && !record.isDirectory
    && (typeof record.size !== 'number'
      || Buffer.byteLength(record.content as string, 'utf8') !== record.size
      || record.size > 64 * 1024)) return null
  if (isCanvasScan && record.isDirectory && record.content !== undefined) return null
  if (!isCanvasScan && record.content !== undefined) return null
  return {
    rootIndex: record.rootIndex,
    name: record.name,
    path: record.path,
    isDirectory: record.isDirectory,
    size: typeof record.size === 'number' ? record.size : undefined,
    content: typeof record.content === 'string' ? record.content : undefined,
  }
}

/**
 * 启动一次稳定目录 helper，在 OPENED 与 ALLOW 之间执行主进程授权。
 * helper 进程是单请求生命周期，任何异常、超时或取消都会终止并清理管道。
 */
function executeStableDirectoryNative(
  request: StableDirectoryNativeRequest,
  authorize: StableDirectoryAuthorization,
  dependencies: StableDirectoryNativeHostDependencies = {},
): Promise<StableDirectoryNativeResult> {
  const path = (dependencies.helperPath ?? defaultHelperPath)()
  if (!(dependencies.helperExists ?? existsSync)(path)) {
    return Promise.reject(new Error(`稳定目录 helper 不存在: ${path}`))
  }

  return new Promise<StableDirectoryNativeResult>((resolvePromise, rejectPromise) => {
    const maxOutputBytes = request.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
    const spawnProcess = dependencies.spawnProcess ?? ((helperPath, args) => (
      spawn(helperPath, args, { stdio: ['pipe', 'pipe', 'pipe'], detached: false })
    ))
    let child: ChildProcessWithoutNullStreams
    try {
      child = spawnProcess(path, buildHelperArguments(request))
    } catch (error) {
      rejectPromise(new Error(`稳定目录 helper 启动失败: ${error instanceof Error ? error.message : String(error)}`))
      return
    }

    let settled = false
    let authorized = false
    let authorizationPending = false
    let denialPending = false
    let openedRoots: StableDirectoryOpenedRoot[] | null = null
    const entries: StableDirectoryNativeEntry[] = []
    let stdoutBuffer = ''
    let stdoutBytes = 0
    let stderrBuffer = ''
    let startupTimer: ReturnType<typeof setTimeout> | null = null
    let totalTimer: ReturnType<typeof setTimeout> | null = null

    /** 终止进程并只结算一次 Promise。 */
    const finish = (error?: Error, result?: StableDirectoryNativeResult): void => {
      if (settled) return
      settled = true
      if (startupTimer) clearTimeout(startupTimer)
      if (totalTimer) clearTimeout(totalTimer)
      request.signal?.removeEventListener('abort', handleAbort)
      child.stdin.on('error', () => { /* 进程退出竞态下忽略 EPIPE。 */ })
      if (!child.stdin.destroyed) child.stdin.end()
      if (!child.killed) child.kill('SIGTERM')
      if (error) rejectPromise(error)
      else resolvePromise(result ?? { roots: [], entries: [] })
    }

    /** 取消信号必须同步终止 helper，避免后台继续枚举。 */
    const handleAbort = (): void => finish(new Error('稳定目录请求已取消'))
    request.signal?.addEventListener('abort', handleAbort, { once: true })
    if (request.signal?.aborted) {
      handleAbort()
      return
    }

    startupTimer = setTimeout(() => {
      if (!openedRoots) finish(new Error('稳定目录 helper 启动超时'))
    }, dependencies.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS)
    totalTimer = setTimeout(() => {
      finish(new Error('稳定目录 helper 执行超时'))
    }, dependencies.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS)

    /** 逐行执行协议状态机；授权前收到 entry 属于 helper 违规。 */
    const consumeLine = (line: string): void => {
      let value: unknown
      try {
        value = JSON.parse(line)
      } catch {
        finish(new Error('稳定目录 helper 输出无效 JSON'))
        return
      }
      if (!openedRoots) {
        const roots = parseOpenedRoots(value)
        if (!roots || roots.length !== request.roots.length) {
          finish(new Error('稳定目录 helper OPENED 响应无效'))
          return
        }
        openedRoots = roots
        if (startupTimer) clearTimeout(startupTimer)
        authorizationPending = true
        void Promise.resolve().then(() => authorize(roots)).then((allowed) => {
          if (settled) return
          authorizationPending = false
          if (!allowed) {
            denialPending = true
            child.stdin.write('DENY\n')
            queueMicrotask(() => finish(new Error('目录授权被拒绝')))
            return
          }
          authorized = true
          /** 写入正文只走授权后的 stdin，不进入 argv 或进程列表。 */
          const payload = request.mode === 'canvas-intent-write'
            ? `\t${Buffer.from(request.content ?? '', 'utf8').toString('base64')}`
            : ''
          child.stdin.write(`ALLOW${payload}\n`)
        }).catch((error) => {
          if (!settled) {
            denialPending = true
            child.stdin.write('DENY\n')
          }
          queueMicrotask(() => finish(new Error(`目录授权失败: ${error instanceof Error ? error.message : String(error)}`)))
        })
        return
      }
      const record = value && typeof value === 'object' ? value as Record<string, unknown> : null
      if (record?.type === 'entry') {
        if (!authorized || authorizationPending) {
          finish(new Error('helper 在授权前输出目录条目'))
          return
        }
        const entry = parseEntry(value, request)
        if (!entry) {
          finish(new Error('稳定目录 helper entry 响应无效'))
          return
        }
        entries.push(entry)
        return
      }
      if (record?.type === 'done') {
        if (!authorized || !Number.isSafeInteger(record.entryCount) || record.entryCount !== entries.length) {
          finish(new Error('稳定目录 helper done 响应无效'))
          return
        }
        finish(undefined, { roots: openedRoots, entries })
        return
      }
      if (record?.type === 'fatal' && typeof record.message === 'string') {
        finish(new Error(`稳定目录 helper 失败: ${record.message}`))
        return
      }
      finish(new Error('稳定目录 helper 输出未知协议消息'))
    }

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      if (settled) return
      stdoutBytes += Buffer.byteLength(chunk)
      if (stdoutBytes > maxOutputBytes) {
        finish(new Error('稳定目录 helper 输出超过预算'))
        return
      }
      stdoutBuffer += chunk
      let newline = stdoutBuffer.indexOf('\n')
      while (!settled && newline >= 0) {
        const line = stdoutBuffer.slice(0, newline).trim()
        stdoutBuffer = stdoutBuffer.slice(newline + 1)
        if (line) consumeLine(line)
        newline = stdoutBuffer.indexOf('\n')
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      if (stderrBuffer.length < 8_192) stderrBuffer += chunk.slice(0, 8_192 - stderrBuffer.length)
    })
    child.once('error', (error) => finish(new Error(`稳定目录 helper 进程错误: ${error.message}`)))
    child.once('exit', (code, signal) => {
      if (settled || denialPending) return
      finish(new Error(`稳定目录 helper 提前退出: code=${code ?? 'null'}, signal=${signal ?? 'none'}${stderrBuffer ? `, stderr=${stderrBuffer.trim()}` : ''}`))
    })
  })
}

interface PendingStableDirectoryRequest {
  /** 请求进入 host 的绝对截止时间。 */
  deadline: number
  /** 请求取消信号。 */
  signal?: AbortSignal
  /** 获得槽位后启动 helper。 */
  start: (remainingTimeoutMs: number, release: () => void) => void
  /** 排队阶段拒绝 Promise。 */
  reject: (error: Error) => void
  /** 排队取消监听。 */
  abortHandler?: () => void
  /** 排队总超时计时器。 */
  queueTimer?: ReturnType<typeof setTimeout>
  /** 防止取消、超时和启动重复结算。 */
  settled: boolean
}

/** 创建带独立进程与队列预算的 stable-directory host。 */
export function createStableDirectoryNativeHost(
  limits: StableDirectoryNativeHostLimits = {},
): StableDirectoryNativeHost {
  const maxActiveHelpers = limits.maxActiveHelpers ?? DEFAULT_MAX_ACTIVE_HELPERS
  const maxQueuedRequests = limits.maxQueuedRequests ?? DEFAULT_MAX_QUEUED_REQUESTS
  const maxRootsPerRequest = limits.maxRootsPerRequest ?? DEFAULT_MAX_ROOTS_PER_REQUEST
  if (!Number.isSafeInteger(maxActiveHelpers) || maxActiveHelpers <= 0
    || !Number.isSafeInteger(maxQueuedRequests) || maxQueuedRequests < 0
    || !Number.isSafeInteger(maxRootsPerRequest) || maxRootsPerRequest <= 0) {
    throw new Error('稳定目录 host 资源预算非法')
  }

  let activeHelpers = 0
  const queue: PendingStableDirectoryRequest[] = []

  /** 清理排队阶段的取消与超时资源。 */
  const cleanupPending = (pending: PendingStableDirectoryRequest): void => {
    if (pending.abortHandler) pending.signal?.removeEventListener('abort', pending.abortHandler)
    if (pending.queueTimer) clearTimeout(pending.queueTimer)
  }

  /** 从队列移除尚未启动的请求。 */
  const removePending = (pending: PendingStableDirectoryRequest): void => {
    const index = queue.indexOf(pending)
    if (index >= 0) queue.splice(index, 1)
  }

  /** 启动一个已预留槽位的请求，并提供幂等 release。 */
  const startPending = (pending: PendingStableDirectoryRequest): void => {
    if (pending.settled) return
    pending.settled = true
    cleanupPending(pending)
    activeHelpers += 1
    let released = false
    const release = (): void => {
      if (released) return
      released = true
      activeHelpers -= 1
      drainQueue()
    }
    const remainingTimeoutMs = pending.deadline - Date.now()
    if (remainingTimeoutMs <= 0) {
      release()
      pending.reject(new Error('稳定目录请求排队超时'))
      return
    }
    pending.start(remainingTimeoutMs, release)
  }

  /** 在空闲槽位内按 FIFO 唤醒排队请求。 */
  const drainQueue = (): void => {
    while (activeHelpers < maxActiveHelpers && queue.length > 0) {
      const pending = queue.shift()
      if (pending && !pending.settled) startPending(pending)
    }
  }

  return {
    run: (request, authorize, dependencies = {}) => {
      if (request.roots.length === 0) return Promise.resolve({ roots: [], entries: [] })
      if (request.roots.length > maxRootsPerRequest) {
        return Promise.reject(new Error(`稳定目录 roots 超过上限: ${maxRootsPerRequest}`))
      }
      if (request.mode.startsWith('canvas-intent-')) {
        if (request.roots.length !== 1 || request.childName !== 'transactions') {
          return Promise.reject(new Error('Canvas intent 原生请求目录合同无效'))
        }
        if (request.mode === 'canvas-intent-write'
          && (!request.fileName
            || !CANVAS_INTENT_FILE_PATTERN.test(request.fileName)
            || typeof request.content !== 'string'
            || Buffer.byteLength(request.content, 'utf8') > 64 * 1024)) {
          return Promise.reject(new Error('Canvas intent 原生写入合同无效'))
        }
        if ((request.maxEntries ?? 512) > 512) {
          return Promise.reject(new Error('Canvas intent 原生扫描数量超过上限'))
        }
      }
      const totalTimeoutMs = dependencies.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS
      return new Promise<StableDirectoryNativeResult>((resolvePromise, rejectPromise) => {
        const pending: PendingStableDirectoryRequest = {
          deadline: Date.now() + totalTimeoutMs,
          signal: request.signal,
          reject: rejectPromise,
          settled: false,
          start: (remainingTimeoutMs, release) => {
            const executionDependencies = { ...dependencies, totalTimeoutMs: remainingTimeoutMs }
            void executeStableDirectoryNative(request, authorize, executionDependencies).then(
              (result) => { release(); resolvePromise(result) },
              (error: unknown) => {
                release()
                rejectPromise(error instanceof Error ? error : new Error(String(error)))
              },
            )
          },
        }
        if (request.signal?.aborted) {
          pending.settled = true
          rejectPromise(new Error('稳定目录请求已取消'))
          return
        }
        if (activeHelpers < maxActiveHelpers) {
          startPending(pending)
          return
        }
        if (queue.length >= maxQueuedRequests) {
          pending.settled = true
          rejectPromise(new Error('稳定目录请求队列已满'))
          return
        }
        pending.abortHandler = () => {
          if (pending.settled) return
          pending.settled = true
          removePending(pending)
          cleanupPending(pending)
          rejectPromise(new Error('稳定目录请求已取消'))
        }
        request.signal?.addEventListener('abort', pending.abortHandler, { once: true })
        pending.queueTimer = setTimeout(() => {
          if (pending.settled) return
          pending.settled = true
          removePending(pending)
          cleanupPending(pending)
          rejectPromise(new Error('稳定目录请求排队超时'))
        }, Math.max(0, totalTimeoutMs))
        queue.push(pending)
      })
    },
  }
}

/** 应用进程共享的默认资源预算，避免 Renderer 并发请求无限 spawn。 */
const defaultStableDirectoryNativeHost = createStableDirectoryNativeHost()

/** 使用默认模块级资源预算运行一次稳定目录请求。 */
export function runStableDirectoryNative(
  request: StableDirectoryNativeRequest,
  authorize: StableDirectoryAuthorization,
  dependencies: StableDirectoryNativeHostDependencies = {},
): Promise<StableDirectoryNativeResult> {
  return defaultStableDirectoryNativeHost.run(request, authorize, dependencies)
}
