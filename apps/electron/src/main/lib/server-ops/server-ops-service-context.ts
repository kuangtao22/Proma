import type { ServerOpsAgentAccessStore } from './server-ops-agent-access-store'
import type { ServerOpsConnectionContract, ServerOpsCredentialStoreContract, ServerOpsHostStoreContract } from './server-ops-ipc'
import type { ServerOpsHostTrustStore } from './server-ops-host-trust-store'
import type { ServerOpsAuditStore } from './server-ops-audit-store'
import type { ServerOpsLogService } from './server-ops-log-service'
import type { ServerOpsOverviewService } from './server-ops-overview-service'
import type { ServerOpsSystemdService } from './server-ops-systemd-service'
import type { ServerOpsTrustService } from './server-ops-trust-service'
import type { ServerOpsDockerService } from './server-ops-docker-service'
import type { ServerOpsFileService } from './server-ops-file-service'
import type { ServerOpsDockerConsoleService } from './server-ops-docker-console-service'
import type { ServerOpsFileTransferService } from './server-ops-file-transfer-service'
import type { ServerOpsLocalFileLeaseRegistry } from './server-ops-local-file-leases'

/** Server Ops 主进程唯一服务实例边界。 */
export interface ServerOpsServiceContext {
  hosts: ServerOpsHostStoreContract
  credentials: ServerOpsCredentialStoreContract
  trust: ServerOpsHostTrustStore
  connections: ServerOpsConnectionContract
  access: ServerOpsAgentAccessStore
  audit: Pick<ServerOpsAuditStore, 'append' | 'list'> & { prepareForWrites?: () => Promise<void> }
  overview: ServerOpsOverviewService
  systemd: ServerOpsSystemdService
  logs: ServerOpsLogService
  trustManagement?: ServerOpsTrustService
  docker?: ServerOpsDockerService
  files?: ServerOpsFileService
  console?: ServerOpsDockerConsoleService
  transfers?: ServerOpsFileTransferService
  fileLeases?: ServerOpsLocalFileLeaseRegistry
  /** 注册代次拥有的配置监听，与连接一起释放。 */
  disposeTrustWatcher?: () => void
}

/** 当前已注册的 Server Ops 服务上下文；缺失时保持 null。 */
let currentContext: ServerOpsServiceContext | null = null

/** 当前注册代次；用于阻止旧 disposer 清理后注册的新实例。 */
let currentGeneration = 0

/** 一代 context 的清理与共享 runtime 所有权查询。 */
export interface ServerOpsServiceContextRegistration {
  dispose(): Promise<void>
  ownsRuntime(): boolean
}

/** 注册应用生命周期内唯一的 Server Ops 服务上下文。 */
export function registerServerOpsServiceContext(context: ServerOpsServiceContext): ServerOpsServiceContextRegistration {
  /** 先原子摘除旧引用并推进代次，旧代异步释放失败也不能恢复陈旧 context。 */
  const previous = detachCurrentContext()
  /** 本次注册独占当前已推进的代次。 */
  const generation = currentGeneration
  /** 仅本 registration 成功摘除自身时，才可能拥有共享 runtime 的最终释放权。 */
  let detachedByRegistration = false
  currentContext = context
  /** 新代已发布后再释放旧代；相同资源引用的所有权直接转交新代。 */
  void disposeContext(previous, context).catch((error: unknown) => console.error('[Server Ops] 旧服务上下文清理失败:', error))
  return {
    async dispose() {
      if (currentGeneration !== generation) return
      /** disposer 先摘除自身代次，再释放捕获引用，保证幂等与新代安全。 */
      const owned = detachCurrentContext()
      detachedByRegistration = true
      await disposeContext(owned, null)
    },
    ownsRuntime() {
      /** 清理期间若发布了新代，runtime 所有权随 singleton 一并转交。 */
      return detachedByRegistration && currentContext === null && currentGeneration === generation + 1
    },
  }
}

/** 读取当前 Server Ops 服务上下文，不创建备用实例。 */
export function getServerOpsServiceContext(): ServerOpsServiceContext | null {
  return currentContext
}

/** 清除 Server Ops 服务上下文，供退出和测试收口。 */
export async function clearServerOpsServiceContext(): Promise<void> {
  /** 清理入口必须先失效公开引用，再执行可能抛错的真实资源释放。 */
  const context = detachCurrentContext()
  await disposeContext(context, null)
}

/** 判断旧代资源是否已由注册时继任者或清理期间发布的最新代继续持有。 */
function ownedByNewerContext<K extends keyof ServerOpsServiceContext>(
  context: ServerOpsServiceContext,
  nextContext: ServerOpsServiceContext | null,
  key: K,
): boolean {
  return context[key] !== undefined
    && (context[key] === nextContext?.[key] || context[key] === currentContext?.[key])
}

/** 按业务服务、传输/句柄、连接的依赖顺序释放一代服务。 */
async function disposeContext(context: ServerOpsServiceContext | null, nextContext: ServerOpsServiceContext | null): Promise<void> {
  if (!context) return
  /** 保留首个异常，但不能让它阻断后续连接释放。 */
  let firstError: unknown
  if (!ownedByNewerContext(context, nextContext, 'trustManagement')) {
    try { context.trustManagement?.dispose() } catch (error) { firstError = error }
  }
  if (!ownedByNewerContext(context, nextContext, 'docker')) {
    try { context.docker?.dispose() } catch (error) { firstError ??= error }
  }
  if (!ownedByNewerContext(context, nextContext, 'files')) {
    try { context.files?.dispose() } catch (error) { firstError ??= error }
  }
  if (!ownedByNewerContext(context, nextContext, 'console')) {
    try { context.console?.dispose() } catch (error) { firstError ??= error }
  }
  if (!ownedByNewerContext(context, nextContext, 'disposeTrustWatcher')) {
    try { context.disposeTrustWatcher?.() } catch (error) { firstError ??= error }
  }
  if (!ownedByNewerContext(context, nextContext, 'logs')) {
    try { context.logs?.dispose() } catch (error) { firstError ??= error }
  }
  /** 传输和未领取句柄可并行收口，但连接必须等待两者都进入终态。 */
  const asyncDisposals: Promise<void>[] = []
  if (!ownedByNewerContext(context, nextContext, 'transfers') && context.transfers) {
    try { asyncDisposals.push(context.transfers.dispose()) } catch (error) { firstError ??= error }
  }
  if (!ownedByNewerContext(context, nextContext, 'fileLeases') && context.fileLeases) {
    try { asyncDisposals.push(context.fileLeases.dispose()) } catch (error) { firstError ??= error }
  }
  /** allSettled 保证任一异步清理失败都不会跳过其余资源与连接。 */
  const asyncResults = await Promise.allSettled(asyncDisposals)
  for (const result of asyncResults) if (result.status === 'rejected') firstError ??= result.reason
  if (!ownedByNewerContext(context, nextContext, 'connections')) {
    try { context.connections?.dispose?.() } catch (error) { firstError ??= error }
  }
  if (firstError !== undefined) throw firstError
}

/** 原子摘除当前 context 并推进代次，返回仅供调用方释放的旧引用。 */
function detachCurrentContext(): ServerOpsServiceContext | null {
  const context = currentContext
  currentContext = null
  currentGeneration += 1
  return context
}

/** 组合 IPC、context 与共享 runtime 清理，任一步骤失败仍执行下一层且整体单飞。 */
export function disposeServerOpsLifecycle(
  disposeIpc: () => void | Promise<void>,
  disposeContextRegistration: () => void | Promise<void>,
  disposeRuntime: () => void | Promise<void> = () => undefined,
  ownsRuntime: () => boolean = () => true,
): () => Promise<void> {
  /** 同一生命周期的所有调用复用一项清理结果。 */
  let disposal: Promise<void> | null = null
  return () => {
    if (disposal) return disposal
    disposal = (async () => {
      /** 保留首个错误，同时保证共享 runtime 永远是最后一个释放步骤。 */
      let firstError: unknown
      try { await disposeIpc() } catch (error) { firstError = error }
      try { await disposeContextRegistration() } catch (error) { firstError ??= error }
      if (ownsRuntime()) {
        try { await disposeRuntime() } catch (error) { firstError ??= error }
      }
      if (firstError !== undefined) throw firstError
    })()
    return disposal
  }
}

/** Electron before-quit 使用的最小可测试事件合同。 */
export interface ServerOpsBeforeQuitEvent {
  preventDefault(): void
}

/** Electron 退出事件边界：等待 Server Ops 清理后恢复退出，清理或日志失败均不锁死应用。 */
export async function disposeServerOpsBeforeQuit(
  event: ServerOpsBeforeQuitEvent,
  disposeLifecycle: () => void | Promise<void>,
  resumeQuit: () => void,
  reportError: (error: unknown) => void,
): Promise<void> {
  event.preventDefault()
  try {
    await disposeLifecycle()
  } catch (error) {
    try { reportError(error) } catch { /* 日志设施异常也不能击穿退出事件链。 */ }
  } finally {
    resumeQuit()
  }
}

/** 创建清理期间持续阻止退出、终态后放行的处理器。 */
function createServerOpsBeforeQuitHandler(
  disposeLifecycle: () => void | Promise<void>,
  resumeQuit: () => void,
  reportError: (error: unknown) => void,
): (event: ServerOpsBeforeQuitEvent) => void {
  /** 清理完成后不再阻止最终 quit。 */
  let completed = false
  /** 首次事件同步置位，阻止清理期间的重复退出启动第二条链路。 */
  let started = false
  return (event) => {
    if (completed) return
    if (started) {
      event.preventDefault()
      return
    }
    started = true
    void disposeServerOpsBeforeQuit(event, disposeLifecycle, () => {
      completed = true
      resumeQuit()
    }, reportError)
  }
}

/** Server Ops 异步退出屏障所需的最小 Electron App 合同。 */
export interface ServerOpsQuitApplication {
  prependListener(eventName: 'before-quit', listener: (event: ServerOpsBeforeQuitEvent) => void): unknown
  removeListener(eventName: 'before-quit', listener: (event: ServerOpsBeforeQuitEvent) => void): unknown
  quit(): void
}

/** 注册持续到清理终态的退出屏障，先解绑自身再恢复最终 quit。 */
export function registerServerOpsBeforeQuitBarrier(
  application: ServerOpsQuitApplication,
  disposeLifecycle: () => void | Promise<void>,
  reportError: (error: unknown) => void,
): void {
  /** listener 必须保持同一引用，终态才能在再次 quit 前精确解绑。 */
  let listener: (event: ServerOpsBeforeQuitEvent) => void
  listener = createServerOpsBeforeQuitHandler(disposeLifecycle, () => {
    application.removeListener('before-quit', listener)
    application.quit()
  }, reportError)
  application.prependListener('before-quit', listener)
}
