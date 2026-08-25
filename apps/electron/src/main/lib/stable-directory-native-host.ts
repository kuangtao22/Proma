import electron from 'electron'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const STABLE_DIRECTORY_PROTOCOL = 1
const DEFAULT_STARTUP_TIMEOUT_MS = 3_000
const DEFAULT_TOTAL_TIMEOUT_MS = 15_000
const DEFAULT_MAX_OUTPUT_BYTES = 16 * 1024 * 1024
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
}

export interface StableDirectoryNativeRequest {
  mode: 'list' | 'scan'
  roots: string[]
  maxDepth?: number
  maxEntries?: number
  maxOutputBytes?: number
  ignoreDirectories?: string[]
  ignoreFiles?: string[]
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

type StableDirectoryAuthorization = (
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
function parseEntry(value: unknown, rootCount: number): StableDirectoryNativeEntry | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (record.type !== 'entry'
    || !Number.isSafeInteger(record.rootIndex)
    || typeof record.rootIndex !== 'number'
    || record.rootIndex < 0
    || record.rootIndex >= rootCount
    || typeof record.name !== 'string'
    || typeof record.path !== 'string'
    || typeof record.isDirectory !== 'boolean'
    || (record.size !== undefined && typeof record.size !== 'number')) return null
  return {
    rootIndex: record.rootIndex,
    name: record.name,
    path: record.path,
    isDirectory: record.isDirectory,
    size: typeof record.size === 'number' ? record.size : undefined,
  }
}

/**
 * 启动一次稳定目录 helper，在 OPENED 与 ALLOW 之间执行主进程授权。
 * helper 进程是单请求生命周期，任何异常、超时或取消都会终止并清理管道。
 */
export function runStableDirectoryNative(
  request: StableDirectoryNativeRequest,
  authorize: StableDirectoryAuthorization,
  dependencies: StableDirectoryNativeHostDependencies = {},
): Promise<StableDirectoryNativeResult> {
  if (request.roots.length === 0) return Promise.resolve({ roots: [], entries: [] })
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
        void Promise.resolve(authorize(roots)).then((allowed) => {
          if (settled) return
          authorizationPending = false
          if (!allowed) {
            denialPending = true
            child.stdin.write('DENY\n')
            queueMicrotask(() => finish(new Error('目录授权被拒绝')))
            return
          }
          authorized = true
          child.stdin.write('ALLOW\n')
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
        const entry = parseEntry(value, openedRoots.length)
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
