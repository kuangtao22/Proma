import { lstatSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, isAbsolute, join, resolve } from 'node:path'

/** 所有协作写者共享的固定 Server Ops 配置文件集合。 */
export type ServerOpsConfigFileName =
  | 'hosts.json'
  | 'credentials.json'
  | 'known-hosts.json'
  | 'audit.json'

/** 配置事务向上层暴露的稳定错误码。 */
export type ServerOpsConfigTransactionErrorCode =
  | 'SERVER_OPS_CONFIG_BUSY'
  | 'SERVER_OPS_CONFIG_LOCK_UNAVAILABLE'
  | 'SERVER_OPS_CONFIG_INVALID_DIRECTORY'
  | 'SERVER_OPS_CONFIG_FILE_UNSUPPORTED'
  | 'SERVER_OPS_CONFIG_ASYNC_CALLBACK'
  | 'SERVER_OPS_CONFIG_NESTED_DIRECTORY'
  | 'SERVER_OPS_CONFIG_OUTCOME_UNKNOWN'

/** 原生锁成功后由 external 持有的不透明句柄。 */
interface NativeLockAcquired {
  status: 'acquired'
  handle: object
}

/** 原生锁被其它协作进程持有时的非阻塞结果。 */
interface NativeLockBusy {
  status: 'busy'
}

/**
 * N-API addon 的最小同步合同。
 * Contract / 合同：该协议只互斥协作 Proma 进程，并在校验点检测持续的目录或锁叶替换。
 * 它不阻断同用户进程在校验与路径式写入之间进行瞬时路径重绑；回调后的校验失败必须按结果未知处理。
 */
export interface ServerOpsConfigLockNativeAddon {
  /** 单次非阻塞尝试锁定固定目录。 */
  tryAcquire(directoryPath: string): NativeLockAcquired | NativeLockBusy
  /** 验证路径仍指向取得锁时的目录和锁文件身份。 */
  verify(handle: object, directoryPath: string): void
  /** 显式释放已取得的锁；进程退出与 external finalizer 仍提供兜底。 */
  release(handle: object): void
}

/** 配置事务可替换的原生加载边界。 */
export interface ServerOpsConfigTransactionDependencies {
  /** 测试可注入真实临时构建或确定性 fake。 */
  loadNativeAddon?: () => ServerOpsConfigLockNativeAddon
}

/** 默认 addon 路径解析所需的运行态事实。 */
export interface ServerOpsConfigLockAddonPathOptions {
  /** Electron 是否正在读取打包后的 app.asar。 */
  isPackaged: boolean
  /** 当前模块的真实 __dirname。 */
  moduleDirectory: string
  /** 打包态 Electron 的 resourcesPath。 */
  resourcesPath: string
}

/** 同步、可重入的 Server Ops 配置事务函数。 */
export type ServerOpsConfigTransaction = <T>(callback: () => T) => T

/** 带稳定 code 的配置互斥能力错误。 */
export class ServerOpsConfigTransactionError extends Error {
  /** 调用方用于区分争用、能力缺失和合同错误的稳定 code。 */
  readonly code: ServerOpsConfigTransactionErrorCode

  /** 创建不包含底层路径或系统错误细节的稳定错误。 */
  constructor(code: ServerOpsConfigTransactionErrorCode, message: string = code) {
    super(message)
    this.name = 'ServerOpsConfigTransactionError'
    this.code = code
  }
}

/** 回调已完成后无法确认路径身份或锁释放时，明确禁止调用方盲目重试。 */
export class ServerOpsConfigOutcomeUnknownError extends ServerOpsConfigTransactionError {
  /** 保留不向用户展示的底层能力错误，便于诊断。 */
  override readonly cause: unknown

  constructor(cause: unknown) {
    super(
      'SERVER_OPS_CONFIG_OUTCOME_UNKNOWN',
      'SERVER_OPS_CONFIG_OUTCOME_UNKNOWN: 配置事务可能已提交，请重新读取权威状态',
    )
    this.name = 'ServerOpsConfigOutcomeUnknownError'
    this.cause = cause
  }
}

/** 固定文件集合，运行时阻断绕过 TypeScript 的未知输入。 */
const CONFIG_FILES: ReadonlySet<string> = new Set<ServerOpsConfigFileName>([
  'hosts.json',
  'credentials.json',
  'known-hosts.json',
  'audit.json',
])

/** 当前 JS isolate 内唯一的外层事务；同步调用不会在中途交出事件循环。 */
let activeTransaction: {
  directoryPath: string
  depth: number
  native: ServerOpsConfigLockNativeAddon
  handle: object
} | null = null

/** 主进程由 esbuild 输出为 CJS，使用 __filename 加载原生 addon。 */
const require = createRequire(__filename)

/** 区分源码、开发 bundle 与打包态，解析 N-API addon 的稳定资源路径。 */
export function resolveServerOpsConfigLockAddonPath(
  options: ServerOpsConfigLockAddonPathOptions,
): string {
  const filePath = join('server-ops-config-lock', 'server-ops-config-lock.node')
  if (options.isPackaged) return join(options.resourcesPath, filePath)
  const sourceDirectorySuffix = join('src', 'main', 'lib', 'server-ops')
  return options.moduleDirectory.endsWith(sourceDirectorySuffix)
    ? resolve(options.moduleDirectory, '../../../../resources', filePath)
    : join(options.moduleDirectory, 'resources', filePath)
}

/** 懒读取 Electron app，避免 Bun 源文件测试在模块加载时绑定 Electron。 */
function isPackagedElectronRuntime(): boolean {
  try {
    const electron = require('electron') as unknown
    if (!electron || typeof electron !== 'object') return false
    const app = (electron as { app?: unknown }).app
    return Boolean(app && typeof app === 'object' && (app as { isPackaged?: unknown }).isPackaged === true)
  } catch {
    return false
  }
}

/** 从当前运行环境解析默认 addon 路径。 */
function defaultAddonPath(): string {
  return resolveServerOpsConfigLockAddonPath({
    isPackaged: isPackagedElectronRuntime(),
    moduleDirectory: __dirname,
    resourcesPath: typeof process.resourcesPath === 'string' ? process.resourcesPath : '',
  })
}

/** 加载生产 N-API addon；缺失时保持 fail closed。 */
function loadDefaultNativeAddon(): ServerOpsConfigLockNativeAddon {
  try {
    return require(defaultAddonPath()) as ServerOpsConfigLockNativeAddon
  } catch {
    throw new ServerOpsConfigTransactionError(
      'SERVER_OPS_CONFIG_LOCK_UNAVAILABLE',
      'SERVER_OPS_CONFIG_LOCK_UNAVAILABLE: 配置锁原生能力不可用',
    )
  }
}

/** 判断同步事务结果是否意外跨入 Promise/thenable 边界。 */
function isThenable(value: unknown): value is PromiseLike<unknown> {
  if ((typeof value !== 'object' || value === null) && typeof value !== 'function') return false
  return typeof (value as { then?: unknown }).then === 'function'
}

/** 在调用前识别原生 async function，避免其同步前缀在锁内执行而 continuation 越界。 */
function isAsyncFunction(callback: () => unknown): boolean {
  return Object.prototype.toString.call(callback) === '[object AsyncFunction]'
}

/** 验证并解析不含符号链接的固定 Server Ops 配置目录。 */
function resolveTransactionDirectory(directoryPath: string): string {
  if (!isAbsolute(directoryPath) || basename(resolve(directoryPath)) !== 'server-ops') {
    throw new ServerOpsConfigTransactionError(
      'SERVER_OPS_CONFIG_INVALID_DIRECTORY',
      'SERVER_OPS_CONFIG_INVALID_DIRECTORY: 只允许固定 Server Ops 配置目录',
    )
  }
  try {
    const identity = lstatSync(directoryPath)
    if (!identity.isDirectory() || identity.isSymbolicLink()) throw new Error('unsafe directory')
    return realpathSync(directoryPath)
  } catch {
    throw new ServerOpsConfigTransactionError(
      'SERVER_OPS_CONFIG_INVALID_DIRECTORY',
      'SERVER_OPS_CONFIG_INVALID_DIRECTORY: Server Ops 配置目录不可安全解析',
    )
  }
}

/** 把原生异常收敛为不泄露路径的稳定能力错误。 */
function normalizeNativeError(error: unknown): ServerOpsConfigTransactionError {
  if (error instanceof ServerOpsConfigTransactionError) return error
  return new ServerOpsConfigTransactionError(
    'SERVER_OPS_CONFIG_LOCK_UNAVAILABLE',
    'SERVER_OPS_CONFIG_LOCK_UNAVAILABLE: 当前目录无法可靠加锁',
  )
}

/** 调用原生身份校验，并把平台异常收敛为稳定能力错误。 */
function verifyNativeIdentity(
  native: ServerOpsConfigLockNativeAddon,
  handle: object,
  directoryPath: string,
): void {
  try {
    native.verify(handle, directoryPath)
  } catch (error) {
    throw normalizeNativeError(error)
  }
}

/** 在不改变原业务异常类型的前提下附带锁释放失败。 */
function attachReleaseFailure(error: unknown, releaseError: ServerOpsConfigTransactionError): unknown {
  if ((typeof error === 'object' && error !== null) || typeof error === 'function') {
    try {
      if (!('cause' in error)) Object.defineProperty(error, 'cause', { value: releaseError, configurable: true })
      else Object.defineProperty(error, 'serverOpsConfigReleaseError', { value: releaseError, configurable: true })
    } catch {
      // 冻结异常无法附加诊断信息时仍优先保持原业务错误。
    }
    return error
  }
  return new AggregateError([error, releaseError], '配置事务失败且配置锁释放失败')
}

/**
 * 解析受互斥协议保护的固定文件路径。
 *
 * @param directoryPath 已验证的 `server-ops` 配置目录
 * @param fileName 固定配置文件名
 * @returns 可交给 safe-file 读写的绝对路径
 */
export function resolveServerOpsConfigFilePath(
  directoryPath: string,
  fileName: ServerOpsConfigFileName,
): string {
  const resolvedDirectory = resolveTransactionDirectory(directoryPath)
  if (!CONFIG_FILES.has(fileName)) {
    throw new ServerOpsConfigTransactionError(
      'SERVER_OPS_CONFIG_FILE_UNSUPPORTED',
      'SERVER_OPS_CONFIG_FILE_UNSUPPORTED: 文件不属于 Server Ops 协作配置集合',
    )
  }
  return join(resolvedDirectory, fileName)
}

/**
 * 为一个固定 Server Ops 配置目录创建同步短事务。
 *
 * @param directoryPath 已创建的 `server-ops` 配置目录
 * @param dependencies 测试可替换的 N-API 加载边界
 * @returns 只接受同步回调、同目录可重入的事务函数
 */
export function createServerOpsConfigTransaction(
  directoryPath: string,
  dependencies: ServerOpsConfigTransactionDependencies = {},
): ServerOpsConfigTransaction {
  const resolvedDirectory = resolveTransactionDirectory(directoryPath)
  const loadNativeAddon = dependencies.loadNativeAddon ?? loadDefaultNativeAddon

  return <T>(callback: () => T): T => {
    if (isAsyncFunction(callback)) {
      throw new ServerOpsConfigTransactionError(
        'SERVER_OPS_CONFIG_ASYNC_CALLBACK',
        'SERVER_OPS_CONFIG_ASYNC_CALLBACK: 配置事务回调必须同步完成',
      )
    }
    if (activeTransaction !== null) {
      if (activeTransaction.directoryPath !== resolvedDirectory) {
        throw new ServerOpsConfigTransactionError(
          'SERVER_OPS_CONFIG_NESTED_DIRECTORY',
          'SERVER_OPS_CONFIG_NESTED_DIRECTORY: 禁止跨配置目录嵌套事务',
        )
      }
      activeTransaction.depth += 1
      try {
        verifyNativeIdentity(activeTransaction.native, activeTransaction.handle, resolvedDirectory)
        const result = callback()
        if (isThenable(result)) {
          throw new ServerOpsConfigTransactionError(
            'SERVER_OPS_CONFIG_ASYNC_CALLBACK',
            'SERVER_OPS_CONFIG_ASYNC_CALLBACK: 配置事务回调必须同步完成',
          )
        }
        try {
          verifyNativeIdentity(activeTransaction.native, activeTransaction.handle, resolvedDirectory)
        } catch (error) {
          /** 回调已经返回，路径身份异常意味着写入结果不能安全重试。 */
          throw new ServerOpsConfigOutcomeUnknownError(error)
        }
        return result
      } finally {
        activeTransaction.depth -= 1
      }
    }

    let native: ServerOpsConfigLockNativeAddon
    let acquired: NativeLockAcquired | NativeLockBusy
    try {
      native = loadNativeAddon()
      acquired = native.tryAcquire(resolvedDirectory)
    } catch (error) {
      throw normalizeNativeError(error)
    }
    if (acquired.status === 'busy') {
      throw new ServerOpsConfigTransactionError(
        'SERVER_OPS_CONFIG_BUSY',
        'SERVER_OPS_CONFIG_BUSY: 另一个 Proma 实例正在更新服务器配置',
      )
    }

    activeTransaction = { directoryPath: resolvedDirectory, depth: 1, native, handle: acquired.handle }
    let failure: unknown
    try {
      verifyNativeIdentity(native, acquired.handle, resolvedDirectory)
      const result = callback()
      if (isThenable(result)) {
        throw new ServerOpsConfigTransactionError(
          'SERVER_OPS_CONFIG_ASYNC_CALLBACK',
          'SERVER_OPS_CONFIG_ASYNC_CALLBACK: 配置事务回调必须同步完成',
        )
      }
      try {
        verifyNativeIdentity(native, acquired.handle, resolvedDirectory)
      } catch (error) {
        /** safe-file 仍按路径写入；持久替换只可在回调后探测，不能把该结果声明为未提交。 */
        throw new ServerOpsConfigOutcomeUnknownError(error)
      }
      return result
    } catch (error) {
      failure = error
      throw error
    } finally {
      activeTransaction = null
      try {
        native.release(acquired.handle)
      } catch (error) {
        const releaseError = normalizeNativeError(error)
        if (failure !== undefined) {
          const combinedFailure = attachReleaseFailure(failure, releaseError)
          if (combinedFailure !== failure) throw combinedFailure
        }
        else throw new ServerOpsConfigOutcomeUnknownError(releaseError)
      }
    }
  }
}
