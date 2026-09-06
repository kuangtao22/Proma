import type { ServerOpsAgentAccessStore } from './server-ops-agent-access-store'
import type { ServerOpsConnectionContract, ServerOpsCredentialStoreContract, ServerOpsHostStoreContract } from './server-ops-ipc'
import type { ServerOpsHostTrustStore } from './server-ops-host-trust-store'
import type { ServerOpsAuditStore } from './server-ops-audit-store'
import type { ServerOpsLogService } from './server-ops-log-service'
import type { ServerOpsOverviewService } from './server-ops-overview-service'
import type { ServerOpsSystemdService } from './server-ops-systemd-service'

/** Server Ops 主进程唯一服务实例边界。 */
export interface ServerOpsServiceContext {
  hosts: ServerOpsHostStoreContract
  credentials: ServerOpsCredentialStoreContract
  trust: ServerOpsHostTrustStore
  connections: ServerOpsConnectionContract
  access: ServerOpsAgentAccessStore
  audit: ServerOpsAuditStore
  overview: ServerOpsOverviewService
  systemd: ServerOpsSystemdService
  logs: ServerOpsLogService
}

/** 当前已注册的 Server Ops 服务上下文；缺失时保持 null。 */
let currentContext: ServerOpsServiceContext | null = null

/** 当前注册代次；用于阻止旧 disposer 清理后注册的新实例。 */
let currentGeneration = 0

/** 注册应用生命周期内唯一的 Server Ops 服务上下文。 */
export function registerServerOpsServiceContext(context: ServerOpsServiceContext): () => void {
  /** 先原子摘除旧引用并推进代次，释放失败也不能恢复陈旧 context。 */
  const previous = detachCurrentContext()
  disposeContext(previous)
  /** 本次注册独占当前已推进的代次。 */
  const generation = currentGeneration
  currentContext = context
  return () => {
    if (currentGeneration !== generation) return
    /** disposer 先摘除自身代次，再释放捕获引用，保证幂等与新代安全。 */
    const owned = detachCurrentContext()
    disposeContext(owned)
  }
}

/** 读取当前 Server Ops 服务上下文，不创建备用实例。 */
export function getServerOpsServiceContext(): ServerOpsServiceContext | null {
  return currentContext
}

/** 清除 Server Ops 服务上下文，供退出和测试收口。 */
export function clearServerOpsServiceContext(): void {
  /** 清理入口必须先失效公开引用，再执行可能抛错的真实资源释放。 */
  const context = detachCurrentContext()
  disposeContext(context)
}

/** 按日志 owner/订阅先于连接的顺序释放一代服务。 */
function disposeContext(context: ServerOpsServiceContext | null): void {
  if (!context) return
  /** 保留首个异常，但不能让它阻断后续连接释放。 */
  let firstError: unknown
  try { context.logs?.dispose() } catch (error) { firstError = error }
  try { context.connections?.dispose?.() } catch (error) { firstError ??= error }
  if (firstError !== undefined) throw firstError
}

/** 原子摘除当前 context 并推进代次，返回仅供调用方释放的旧引用。 */
function detachCurrentContext(): ServerOpsServiceContext | null {
  const context = currentContext
  currentContext = null
  currentGeneration += 1
  return context
}

/** 组合 IPC 与 context 清理，任一步骤失败仍执行下一层且整体幂等。 */
export function disposeServerOpsLifecycle(disposeIpc: () => void, disposeContextRegistration: () => void): () => void {
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    let firstError: unknown
    try { disposeIpc() } catch (error) { firstError = error }
    try { disposeContextRegistration() } catch (error) { firstError ??= error }
    if (firstError !== undefined) throw firstError
  }
}

/** Electron 退出事件边界：记录 Server Ops 清理异常，但不阻断后续全局 listener。 */
export function disposeServerOpsBeforeQuit(disposeLifecycle: () => void, reportError: (error: unknown) => void): void {
  try {
    disposeLifecycle()
  } catch (error) {
    try { reportError(error) } catch { /* 日志设施异常也不能击穿退出事件链。 */ }
  }
}
