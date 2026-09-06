import { parseServerOpsOverviewInput } from '@proma/shared'
import type { ServerOpsOverviewInput, ServerOpsOverviewResult } from '@proma/shared'
import { SERVER_OPS_OVERVIEW_COMMAND } from './server-ops-overview-command'
import { parseServerOpsOverviewOutput } from './server-ops-overview-parser'
import type { ServerOpsActiveConnectionIdentity } from './server-ops-connection-service'
import type { ServerOpsRuntimeExecResult } from '../../../utility/server-ops/server-ops-runtime-protocol'

/** Overview Service 使用的最小连接能力边界。 */
export interface ServerOpsOverviewConnections {
  getActiveIdentity: (hostId: string) => ServerOpsActiveConnectionIdentity
  exec: (hostId: string, connectionId: string, command: string, timeoutMs: number) => Promise<ServerOpsRuntimeExecResult>
}

/** Overview Service 可替换依赖。 */
export interface ServerOpsOverviewServiceDependencies {
  connections: ServerOpsOverviewConnections
  now: () => number
}

/** 可安全跨 Renderer 边界暴露的 Overview 稳定错误码。 */
type ServerOpsOverviewErrorCode =
  | 'SERVER_OPS_CONNECTION_CHANGED'
  | 'SERVER_OPS_OVERVIEW_OUTPUT_INVALID'
  | 'SERVER_OPS_OVERVIEW_FAILED'

/** 判断错误是否属于允许原样保留的 Overview 稳定错误码。 */
function isStableOverviewErrorCode(value: unknown): value is ServerOpsOverviewErrorCode {
  return value === 'SERVER_OPS_CONNECTION_CHANGED'
    || value === 'SERVER_OPS_OVERVIEW_OUTPUT_INVALID'
    || value === 'SERVER_OPS_OVERVIEW_FAILED'
}

/** 将未知错误收敛为只含稳定 code 的公开 Error。 */
function createPublicOverviewError(error: unknown, fallback: ServerOpsOverviewErrorCode): Error {
  /** Error message 仅用于识别稳定领域码，绝不拼接底层详情。 */
  const message = error instanceof Error ? error.message : undefined
  return new Error(isStableOverviewErrorCode(message) ? message : fallback)
}

/** 判断两次 fresh-read 是否仍指向完全相同的连接所有权。 */
function identitiesEqual(left: ServerOpsActiveConnectionIdentity, right: ServerOpsActiveConnectionIdentity): boolean {
  return left.hostId === right.hostId
    && left.connectionId === right.connectionId
    && left.generation === right.generation
}

/** 为完整连接身份生成无歧义的单飞键。 */
function createIdentityKey(identity: ServerOpsActiveConnectionIdentity): string {
  return JSON.stringify([identity.hostId, identity.connectionId, identity.generation])
}

/** 采集并校验单台服务器运行概览，确保旧连接结果不会被发布。 */
export class ServerOpsOverviewService {
  /** Overview 采集依赖。 */
  private readonly dependencies: ServerOpsOverviewServiceDependencies
  /** 按完整活跃身份隔离的在途采集 Promise。 */
  private readonly pending = new Map<string, Promise<ServerOpsOverviewResult>>()

  constructor(dependencies: ServerOpsOverviewServiceDependencies) {
    this.dependencies = dependencies
  }

  /** 校验请求并复用相同连接身份的在途采集。 */
  async getOverview(input: ServerOpsOverviewInput): Promise<ServerOpsOverviewResult> {
    /** 再次执行 Shared exact-key 输入校验，拒绝 Renderer 侧绕过。 */
    const parsedInput = parseServerOpsOverviewInput(input)
    /** 请求开始时捕获的完整活跃连接身份。 */
    const identity = this.readInitialIdentity(parsedInput.hostId)
    /** 当前身份对应的无歧义单飞键。 */
    const key = createIdentityKey(identity)
    /** 同一身份已经存在的在途采集。 */
    const existing = this.pending.get(key)
    if (existing) return existing

    /** 新身份独占的底层采集 Promise。 */
    const collection = this.collect(identity)
    /** 带身份保护清理的公开 Promise。 */
    const pending = collection.finally(() => {
      if (this.pending.get(key) === pending) this.pending.delete(key)
    })
    this.pending.set(key, pending)
    return pending
  }

  /** 执行远程采集，并在三个边界复核连接身份。 */
  private async collect(identity: ServerOpsActiveConnectionIdentity): Promise<ServerOpsOverviewResult> {
    this.assertIdentityUnchanged(identity)
    /** runtime 返回的完整 exec 结果。 */
    let execResult: ServerOpsRuntimeExecResult
    try {
      execResult = await this.dependencies.connections.exec(
        identity.hostId,
        identity.connectionId,
        SERVER_OPS_OVERVIEW_COMMAND,
        10_000,
      )
    } catch (error) {
      /** transport 失败时仍先确认是否实为连接切换竞态。 */
      this.assertIdentityUnchanged(identity)
      if (error instanceof Error && error.message === 'SERVER_OPS_CONNECTION_NOT_ACTIVE') {
        throw new Error('SERVER_OPS_CONNECTION_CHANGED')
      }
      throw createPublicOverviewError(error, 'SERVER_OPS_OVERVIEW_FAILED')
    }

    this.assertIdentityUnchanged(identity)
    if (!this.isValidExecResult(execResult)) throw new Error('SERVER_OPS_OVERVIEW_OUTPUT_INVALID')

    /** now() 生成的单次采集时间戳。 */
    let capturedAt: number
    try {
      capturedAt = this.dependencies.now()
    } catch (error) {
      throw createPublicOverviewError(error, 'SERVER_OPS_OVERVIEW_FAILED')
    }

    /** 由严格 parser 生成的公开概览快照。 */
    let overview: ServerOpsOverviewResult
    try {
      overview = parseServerOpsOverviewOutput(identity.hostId, execResult.stdout, capturedAt)
    } catch (error) {
      throw createPublicOverviewError(error, 'SERVER_OPS_OVERVIEW_OUTPUT_INVALID')
    }

    this.assertIdentityUnchanged(identity)
    return overview
  }

  /** 请求起点 fresh-read 身份，不存在时统一视为连接已变化。 */
  private readInitialIdentity(hostId: string): ServerOpsActiveConnectionIdentity {
    try {
      return this.dependencies.connections.getActiveIdentity(hostId)
    } catch {
      throw new Error('SERVER_OPS_CONNECTION_CHANGED')
    }
  }

  /** fresh-read 并精确比较三字段连接身份。 */
  private assertIdentityUnchanged(expected: ServerOpsActiveConnectionIdentity): void {
    /** 当前时点的活跃连接身份。 */
    let current: ServerOpsActiveConnectionIdentity
    try {
      current = this.dependencies.connections.getActiveIdentity(expected.hostId)
    } catch {
      throw new Error('SERVER_OPS_CONNECTION_CHANGED')
    }
    if (!identitiesEqual(current, expected)) throw new Error('SERVER_OPS_CONNECTION_CHANGED')
  }

  /** 严格校验 Overview 固定命令允许发布的 exec 状态。 */
  private isValidExecResult(result: ServerOpsRuntimeExecResult): boolean {
    return result.exitCode === 0
      && result.signal === undefined
      && result.truncated === false
      && result.stderr.trim().length === 0
  }
}
