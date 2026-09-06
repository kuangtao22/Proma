import { isServerOpsId } from '@proma/shared'
import type {
  AgentSessionMeta,
  ServerOpsAuditAppendInput,
  ServerOpsAuditOperation,
  ServerOpsAuthMethod,
  ServerOpsConnectionPhase,
  ServerOpsConnectionState,
  ServerOpsHost,
  ServerOpsHostKey,
} from '@proma/shared'
import { isOrdinaryTopLevelAgentSession } from '../agent-session-visibility'
import { getServerOpsServiceContext } from './server-ops-service-context'
import type { ServerOpsRuntimeExecResult } from '../../../utility/server-ops/server-ops-runtime-protocol'
import { getServerOpsAuditErrorCode } from './server-ops-audit-store'

/** Agent 可见的审计降级警告。 */
export type ServerOpsAgentWarning = 'SERVER_OPS_AUDIT_RESULT_WRITE_FAILED'

/** Agent 可读取的服务器公开资产，不包含凭据引用与时间元数据。 */
export interface ServerOpsAgentHost {
  id: string
  name: string
  address: string
  port: number
  username: string
  authMethod: ServerOpsAuthMethod
  tags: string[]
  phase: ServerOpsConnectionPhase
}

/** Agent 可读取的连接状态白名单，不包含 connectionId 或 Host Key candidateId。 */
export interface ServerOpsAgentStatus {
  hostId: string
  phase: ServerOpsConnectionPhase
  hostKey?: ServerOpsHostKey
  previousHostKey?: ServerOpsHostKey
  errorCode?: string
  message?: string
  warnings?: ServerOpsAgentWarning[]
}

/** Agent 命令结果允许附加审计后写失败警告。 */
export interface ServerOpsAgentExecResult extends ServerOpsRuntimeExecResult {
  warnings?: ServerOpsAgentWarning[]
}

/** 远程失败且结果审计失败时供 Pi 序列化的公开错误合同。 */
interface ServerOpsAgentOperationError extends Error {
  code: string
  cause: unknown
  warnings: ServerOpsAgentWarning[]
}

/** Facade 使用的最小服务边界，防止意外取得凭据或 Host Key 确认能力。 */
export interface ServerOpsAgentFacadeServices {
  hosts: Pick<import('./server-ops-ipc').ServerOpsHostStoreContract, 'get'>
  access: Pick<import('./server-ops-agent-access-store').ServerOpsAgentAccessStore, 'get' | 'getCurrent' | 'revoke'>
  connections: Pick<import('./server-ops-ipc').ServerOpsConnectionContract, 'getState' | 'connect' | 'exec' | 'disconnect'>
  audit: Pick<import('./server-ops-audit-store').ServerOpsAuditStore, 'append'>
}

/** Facade 可替换依赖，仅用于隔离会话事实与主进程服务实例。 */
export interface ServerOpsAgentFacadeDependencies {
  getSession: (sessionId: string) => AgentSessionMeta | undefined
  services: ServerOpsAgentFacadeServices
}

/** 创建 Facade 时由 Orchestrator 闭包捕获的真实运行身份。 */
export interface CreateServerOpsAgentFacadeInput {
  sessionId: string
  triggeredBy?: 'user' | 'automation' | 'delegation' | 'external'
  /** Orchestrator 提供的权威会话读取器；避免 Facade 隐式发现运行上下文。 */
  getSession?: (sessionId: string) => AgentSessionMeta | undefined
  dependencies?: ServerOpsAgentFacadeDependencies
}

/** 模型可调用的服务器运维能力。 */
export interface ServerOpsAgentFacade {
  list: () => ServerOpsAgentHost[]
  status: (input: { hostId: string }) => ServerOpsAgentStatus
  connect: (input: { hostId: string }) => Promise<ServerOpsAgentStatus>
  exec: (input: { hostId: string; command: string; timeoutMs?: number }) => Promise<ServerOpsAgentExecResult>
  disconnect: (input: { hostId: string }) => ServerOpsAgentStatus
}

/** 仅普通用户交互运行可以注册并执行服务器工具。 */
function isInteractiveRunSource(triggeredBy: CreateServerOpsAgentFacadeInput['triggeredBy']): boolean {
  return triggeredBy === undefined || triggeredBy === 'user'
}

/** 校验模型提供的公开服务器 ID。 */
function requireHostId(hostId: string): string {
  if (!isServerOpsId(hostId)) throw new Error('SERVER_OPS_HOST_ID_INVALID')
  return hostId
}

/** 将内部连接状态投影为 Agent 白名单 DTO。 */
function publicStatus(state: ServerOpsConnectionState): ServerOpsAgentStatus {
  /** 首次未知 Host Key 只返回算法与指纹，确认动作仍归 UI。 */
  const hostKey = state.phase === 'host-key-required' ? state.candidate : state.hostKey
  return {
    hostId: state.hostId,
    phase: state.phase,
    ...(hostKey ? { hostKey: { algorithm: hostKey.algorithm, fingerprint: hostKey.fingerprint } } : {}),
    ...(state.previousHostKey ? {
      previousHostKey: {
        algorithm: state.previousHostKey.algorithm,
        fingerprint: state.previousHostKey.fingerprint,
      },
    } : {}),
    ...(state.errorCode ? { errorCode: state.errorCode } : {}),
    ...(state.phase === 'host-key-required'
      ? { message: '请在服务器运维界面确认服务器指纹后重新连接。' }
      : state.message ? { message: state.message } : {}),
  }
}

/** 保留远程错误原因，同时让 Pi 的错误文本和结构字段都携带审计降级警告。 */
function attachAuditResultWarning(error: unknown): ServerOpsAgentOperationError {
  /** 生产远程边界已把内部异常收敛为公开文本；未知值只使用稳定错误码。 */
  const reason = error instanceof Error ? error.message : 'SERVER_OPS_REMOTE_OPERATION_FAILED'
  /** 公开错误同时保留稳定远程错误码、原始 cause 与固定 warning。 */
  const wrapped = new Error(`${reason}\nSERVER_OPS_AUDIT_RESULT_WRITE_FAILED`) as ServerOpsAgentOperationError
  wrapped.code = getServerOpsAuditErrorCode(error)
  wrapped.cause = error
  wrapped.warnings = ['SERVER_OPS_AUDIT_RESULT_WRITE_FAILED']
  return wrapped
}

/** 创建仅持有公开主机、连接和内存授权能力的会话级 Facade。 */
export function createServerOpsAgentFacade(input: CreateServerOpsAgentFacadeInput): ServerOpsAgentFacade | null {
  if (!isInteractiveRunSource(input.triggeredBy)) return null
  /** 未显式注入时只读取已初始化的全局上下文，不创建 fallback。 */
  const context = input.dependencies ? null : getServerOpsServiceContext()
  const dependencies = input.dependencies ?? (context && input.getSession ? {
    getSession: input.getSession,
    services: {
      hosts: context.hosts,
      access: context.access,
      connections: context.connections,
      audit: context.audit,
    },
  } : null)
  if (!dependencies) return null

  /** 每次调用都 fresh-read 普通会话与精确授权，撤销后立即生效。 */
  const requireAuthorizedHost = (hostId: string): ServerOpsHost => {
    if (!isInteractiveRunSource(input.triggeredBy)
      || !isOrdinaryTopLevelAgentSession(dependencies.getSession(input.sessionId))) {
      throw new Error('SERVER_OPS_AGENT_SESSION_NOT_ALLOWED')
    }
    const normalizedHostId = requireHostId(hostId)
    if (!dependencies.services.access.get(input.sessionId, normalizedHostId)) {
      throw new Error('SERVER_OPS_AGENT_ACCESS_REQUIRED')
    }
    const host = dependencies.services.hosts.get(normalizedHostId)
    if (!host) throw new Error('SERVER_OPS_HOST_NOT_FOUND')
    return host
  }

  /** 远程动作开始前同步写审计；失败必须用稳定错误阻断真实调用。 */
  const appendAuditStart = (operation: ServerOpsAuditOperation, hostId: string, command?: string): number => {
    try {
      return dependencies.services.audit.append({
        actor: 'agent',
        sessionId: input.sessionId,
        hostId,
        operation,
        phase: 'start',
        outcome: 'success',
        ...(command === undefined ? {} : { command }),
      }).timestamp
    } catch {
      throw new Error('SERVER_OPS_AUDIT_START_WRITE_FAILED')
    }
  }

  /** 远程动作结束后 best-effort 写结果，返回是否需要公开降级警告。 */
  const appendAuditResult = (
    operation: ServerOpsAuditOperation,
    hostId: string,
    startedAt: number,
    outcome: 'success' | 'error',
    options: Pick<ServerOpsAuditAppendInput, 'command' | 'exitCode' | 'signal' | 'errorCode'> = {},
  ): boolean => {
    try {
      dependencies.services.audit.append({
        actor: 'agent',
        sessionId: input.sessionId,
        hostId,
        operation,
        phase: 'result',
        outcome,
        durationMs: Math.max(0, Date.now() - startedAt),
        ...options,
      })
      return false
    } catch {
      return true
    }
  }

  return {
    list() {
      if (!isInteractiveRunSource(input.triggeredBy)
        || !isOrdinaryTopLevelAgentSession(dependencies.getSession(input.sessionId))) {
        throw new Error('SERVER_OPS_AGENT_SESSION_NOT_ALLOWED')
      }
      /** 单槽快照只暴露当前授权目标，不枚举其他资产。 */
      const current = dependencies.services.access.getCurrent()
      if (!current || current.sessionId !== input.sessionId
        || !dependencies.services.access.get(input.sessionId, current.hostId)) {
        throw new Error('SERVER_OPS_AGENT_ACCESS_REQUIRED')
      }
      const host = requireAuthorizedHost(current.hostId)
      return [{
        id: host.id,
        name: host.name,
        address: host.address,
        port: host.port,
        username: host.username,
        authMethod: host.authMethod,
        tags: [...host.tags],
        phase: dependencies.services.connections.getState(host.id).phase,
      }]
    },
    status({ hostId }) {
      const host = requireAuthorizedHost(hostId)
      return publicStatus(dependencies.services.connections.getState(host.id))
    },
    async connect({ hostId }) {
      const host = requireAuthorizedHost(hostId)
      const startedAt = appendAuditStart('connect', host.id)
      try {
        /** 底层只返回公开状态，但仍移除 connectionId 等内部字段。 */
        const state = await dependencies.services.connections.connect({ hostId: host.id, cols: 120, rows: 32 })
        const outcome = state.phase === 'error' || state.phase === 'blocked' ? 'error' : 'success'
        const warning = appendAuditResult('connect', host.id, startedAt, outcome, {
          ...(state.errorCode ? { errorCode: getServerOpsAuditErrorCode({ code: state.errorCode }) } : {}),
        })
        return { ...publicStatus(state), ...(warning ? { warnings: ['SERVER_OPS_AUDIT_RESULT_WRITE_FAILED'] } : {}) }
      } catch (error) {
        const warning = appendAuditResult('connect', host.id, startedAt, 'error', { errorCode: getServerOpsAuditErrorCode(error) })
        if (warning) throw attachAuditResultWarning(error)
        throw error
      }
    },
    async exec({ hostId, command, timeoutMs = 30_000 }) {
      const host = requireAuthorizedHost(hostId)
      if (typeof command !== 'string' || command.length < 1 || command.length > 8192 || command.includes('\0')) {
        throw new Error('SERVER_OPS_EXEC_COMMAND_INVALID')
      }
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120_000) {
        throw new Error('SERVER_OPS_EXEC_TIMEOUT_INVALID')
      }
      const state = dependencies.services.connections.getState(host.id)
      if (state.phase !== 'connected' || !state.connectionId) throw new Error('SERVER_OPS_CONNECTION_NOT_ACTIVE')
      const startedAt = appendAuditStart('exec', host.id, command)
      try {
        const result = await dependencies.services.connections.exec(host.id, state.connectionId, command, timeoutMs)
        /** 非零退出码或 signal 都代表远程命令失败，但真实输出仍原样返回给 Agent。 */
        const outcome = result.signal !== undefined || (result.exitCode !== undefined && result.exitCode !== 0) ? 'error' : 'success'
        const warning = appendAuditResult('exec', host.id, startedAt, outcome, {
          command,
          ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
          ...(result.signal === undefined ? {} : { signal: result.signal }),
        })
        return {
          stdout: result.stdout,
          stderr: result.stderr,
          ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
          ...(result.signal === undefined ? {} : { signal: result.signal }),
          truncated: result.truncated,
          ...(warning ? { warnings: ['SERVER_OPS_AUDIT_RESULT_WRITE_FAILED'] } : {}),
        }
      } catch (error) {
        const warning = appendAuditResult('exec', host.id, startedAt, 'error', { command, errorCode: getServerOpsAuditErrorCode(error) })
        if (warning) throw attachAuditResultWarning(error)
        throw error
      }
    },
    disconnect({ hostId }) {
      const host = requireAuthorizedHost(hostId)
      const startedAt = appendAuditStart('disconnect', host.id)
      try {
        const state = dependencies.services.connections.disconnect(host.id)
        const warning = appendAuditResult('disconnect', host.id, startedAt, 'success')
        return { ...publicStatus(state), ...(warning ? { warnings: ['SERVER_OPS_AUDIT_RESULT_WRITE_FAILED'] } : {}) }
      } catch (error) {
        const warning = appendAuditResult('disconnect', host.id, startedAt, 'error', { errorCode: getServerOpsAuditErrorCode(error) })
        if (warning) throw attachAuditResultWarning(error)
        throw error
      } finally {
        /** 底层断开异常也必须撤销授权，同时由 finally 保留原始错误向上抛出。 */
        dependencies.services.access.revoke(input.sessionId, host.id)
      }
    },
  }
}
