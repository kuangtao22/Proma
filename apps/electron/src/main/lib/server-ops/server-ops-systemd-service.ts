import {
  parseServerOpsServiceActionInput,
  parseServerOpsServiceActionResult,
  parseServerOpsServiceDetailInput,
  parseServerOpsServiceDetailResult,
  parseServerOpsServiceListInput,
  parseServerOpsServiceListResult,
  parseServerOpsSystemdUnitId,
} from '@proma/shared'
import type {
  ServerOpsAuditAppendInput,
  ServerOpsServiceAction,
  ServerOpsServiceActionInput,
  ServerOpsServiceActionResult,
  ServerOpsServiceDetailInput,
  ServerOpsServiceDetailResult,
  ServerOpsServiceListInput,
  ServerOpsServiceListResult,
  ServerOpsServiceSummary,
  ServerOpsSystemdCapability,
} from '@proma/shared'
import type { ServerOpsActiveConnectionIdentity } from './server-ops-connection-service'
import type { ServerOpsRuntimeExecResult } from '../../../utility/server-ops/server-ops-runtime-protocol'

/** systemd 能力发现只允许执行的固定命令。 */
export const SERVER_OPS_SYSTEMD_CAPABILITY_COMMAND = "LC_ALL=C sh -c 'cat /proc/1/comm; command -v systemctl'"
/** systemd 服务列表只允许执行的固定命令。 */
export const SERVER_OPS_SYSTEMD_LIST_COMMAND = 'LC_ALL=C systemctl list-units --type=service --all --no-legend --no-pager --plain'
/** 读取类 systemd 命令的固定超时。 */
const SERVER_OPS_SYSTEMD_READ_TIMEOUT_MS = 5_000
/** 服务动作的固定超时。 */
const SERVER_OPS_SYSTEMD_ACTION_TIMEOUT_MS = 30_000
/** 列表最多向公开边界返回的服务数量。 */
const SERVER_OPS_SYSTEMD_MAX_SERVICES = 1_000
/** 详情只允许出现的固定 systemctl show 字段。 */
const SERVER_OPS_SYSTEMD_SHOW_FIELDS = [
  'Id', 'Description', 'LoadState', 'ActiveState', 'SubState', 'UnitFileState', 'MainPID', 'ActiveEnterTimestamp',
] as const

/** systemd Service 使用的最小依赖边界。 */
export interface ServerOpsSystemdServiceDependencies {
  getActiveIdentity: (hostId: string) => ServerOpsActiveConnectionIdentity
  exec: (hostId: string, connectionId: string, command: string, timeoutMs: number) => Promise<ServerOpsRuntimeExecResult>
  audit: { append: (input: ServerOpsAuditAppendInput) => unknown }
  now: () => number
}

/** 动作执行完成后的内部稳定事实。 */
interface ServiceActionExecution {
  outcome: 'success' | 'error'
  errorCode?: 'SERVER_OPS_SERVICE_ACTION_FAILED' | 'SERVER_OPS_SERVICE_ACTION_UNKNOWN' | 'SERVER_OPS_SYSTEMD_PERMISSION_DENIED'
}

/** 列表命令经过严格资格判断后的内部结果。 */
interface ServiceListExecution {
  capability: 'available' | 'permission-denied'
  result?: ServerOpsRuntimeExecResult
}

/** 允许跨服务边界暴露的稳定错误码。 */
type ServerOpsSystemdErrorCode =
  | 'SERVER_OPS_CONNECTION_CHANGED'
  | 'SERVER_OPS_SYSTEMD_OUTPUT_INVALID'
  | 'SERVER_OPS_SERVICE_ACTION_FAILED'
  | 'SERVER_OPS_SERVICE_ACTION_IN_PROGRESS'
  | 'SERVER_OPS_SERVICE_ACTION_UNKNOWN'
  | 'SERVER_OPS_SYSTEMD_PERMISSION_DENIED'
  | 'SERVER_OPS_AUDIT_READ_FAILED'
  | 'SERVER_OPS_AUDIT_WRITE_FAILED'

/** 判断未知错误消息是否属于允许公开的稳定码。 */
function isStableSystemdErrorCode(value: unknown): value is ServerOpsSystemdErrorCode {
  return value === 'SERVER_OPS_CONNECTION_CHANGED'
    || value === 'SERVER_OPS_SYSTEMD_OUTPUT_INVALID'
    || value === 'SERVER_OPS_SERVICE_ACTION_FAILED'
    || value === 'SERVER_OPS_SERVICE_ACTION_IN_PROGRESS'
    || value === 'SERVER_OPS_SERVICE_ACTION_UNKNOWN'
    || value === 'SERVER_OPS_SYSTEMD_PERMISSION_DENIED'
    || value === 'SERVER_OPS_AUDIT_READ_FAILED'
    || value === 'SERVER_OPS_AUDIT_WRITE_FAILED'
}

/** 将任意底层错误收敛为仅含稳定码的公开 Error。 */
function createPublicSystemdError(error: unknown, fallback: ServerOpsSystemdErrorCode): Error {
  /** 仅用于匹配 allowlist 的错误消息。 */
  const message = error instanceof Error ? error.message : undefined
  return new Error(isStableSystemdErrorCode(message) ? message : fallback)
}

/** 判断两次读取是否仍属于同一活跃连接代次。 */
function identitiesEqual(left: ServerOpsActiveConnectionIdentity, right: ServerOpsActiveConnectionIdentity): boolean {
  return left.hostId === right.hostId
    && left.connectionId === right.connectionId
    && left.generation === right.generation
}

/** 使用 POSIX 单引号编码一个已经严格校验的命令参数。 */
function quotePosixArgument(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

/** 严格识别固定 locale、动作与 unit 完全匹配的 systemctl 权限拒绝输出。 */
function isStandardActionPermissionDenied(
  stderr: string,
  unitId: string,
  action: ServerOpsServiceAction,
): boolean {
  /** 只移除命令惯常产生的单个末尾换行，额外空白仍拒绝。 */
  const output = stderr.endsWith('\r\n')
    ? stderr.slice(0, -2)
    : stderr.endsWith('\n')
      ? stderr.slice(0, -1)
      : stderr
  /** 三条完整 canonical 输出同时绑定当前固定动作与 unit。 */
  const allowedOutputs = new Set([
    `Failed to ${action} ${unitId}: Access denied`,
    `Failed to ${action} ${unitId}: Permission denied.`,
    `Failed to ${action} ${unitId}: Interactive authentication required.\nSee system logs and 'systemctl status ${unitId}' for details.`,
  ])
  return allowedOutputs.has(output)
}

/** 将输出拆为有界单行文本，并拒绝 NUL、超长行和超量行。 */
function parseOutputLines(output: string, maximumLines: number): string[] {
  if (output.includes('\0')) throw new Error('SERVER_OPS_SYSTEMD_OUTPUT_INVALID')
  /** 去除命令惯常末尾换行后的原始行。 */
  const normalized = output.replace(/\r?\n$/u, '')
  if (normalized.length === 0) return []
  /** 远程输出中的全部单行。 */
  const lines = normalized.split(/\r?\n/u)
  if (lines.length > maximumLines || lines.some((line) => line.length > 8_192 || line.includes('\r'))) {
    throw new Error('SERVER_OPS_SYSTEMD_OUTPUT_INVALID')
  }
  return lines
}

/** 将 UnitFileState 映射为公开 enabled 三态。 */
function parseEnabledState(value: string): boolean | null {
  if (value === 'enabled' || value === 'enabled-runtime' || value === 'linked' || value === 'linked-runtime' || value === 'alias') return true
  if (value === 'disabled' || value === 'masked' || value === 'masked-runtime') return false
  return null
}

/** 编排 systemd 能力、列表、详情与用户确认动作。 */
export class ServerOpsSystemdService {
  /** 完整的可替换窄依赖。 */
  private readonly dependencies: ServerOpsSystemdServiceDependencies
  /** 按连接代次与 unit 隔离的动作单飞集合。 */
  private readonly actionFlights = new Set<string>()

  constructor(dependencies: ServerOpsSystemdServiceDependencies) {
    this.dependencies = dependencies
  }

  /** 校验输入并读取当前主机的 systemd 服务列表。 */
  async listServices(input: ServerOpsServiceListInput): Promise<ServerOpsServiceListResult> {
    /** 主进程入口再次执行 Shared exact-key 校验。 */
    const parsedInput = parseServerOpsServiceListInput(input)
    /** 请求开始时捕获的活跃连接身份。 */
    const identity = this.readInitialIdentity(parsedInput.hostId)
    try {
      /** 当前主机的 systemd 能力。 */
      const capability = await this.discoverCapability(identity)
      if (capability !== 'available') {
        return parseServerOpsServiceListResult({ hostId: identity.hostId, capability, services: [], warnings: [] })
      }
      /** 固定 list-units 命令的远程结果或明确权限状态。 */
      const listExecution = await this.execServiceList(identity)
      if (listExecution.capability === 'permission-denied') {
        return parseServerOpsServiceListResult({
          hostId: identity.hostId, capability: 'permission-denied', services: [], warnings: [],
        })
      }
      /** available 分支必须携带经过资格门禁的结果。 */
      const result = listExecution.result
      if (!result) throw new Error('SERVER_OPS_SYSTEMD_OUTPUT_INVALID')
      /** 严格解析并限制为前一千项的服务摘要。 */
      const services = this.parseServiceList(result.stdout).slice(0, SERVER_OPS_SYSTEMD_MAX_SERVICES)
      this.assertIdentityUnchanged(identity)
      return parseServerOpsServiceListResult({ hostId: identity.hostId, capability, services, warnings: [] })
    } catch (error) {
      throw createPublicSystemdError(error, 'SERVER_OPS_SYSTEMD_OUTPUT_INVALID')
    }
  }

  /** 校验输入并读取单个服务的结构化状态和最近一百行日志。 */
  async getServiceDetail(input: ServerOpsServiceDetailInput): Promise<ServerOpsServiceDetailResult> {
    /** 主进程入口再次执行 Shared exact-key 与 unit 校验。 */
    const parsedInput = parseServerOpsServiceDetailInput(input)
    /** 请求开始时捕获的活跃连接身份。 */
    const identity = this.readInitialIdentity(parsedInput.hostId)
    try {
      return await this.readServiceDetail(identity, parsedInput.unitId)
    } catch (error) {
      throw createPublicSystemdError(error, 'SERVER_OPS_SYSTEMD_OUTPUT_INVALID')
    }
  }

  /** 校验用户动作，执行一次固定命令并写入开始与结果审计。 */
  async runAction(input: ServerOpsServiceActionInput): Promise<ServerOpsServiceActionResult> {
    /** 主进程入口再次执行 Shared exact-key、ID、unit 与动作枚举校验。 */
    const parsedInput = parseServerOpsServiceActionInput(input)
    /** 动作前捕获且贯穿全流程的连接身份。 */
    const identity = this.readInitialIdentity(parsedInput.hostId)
    /** 精确动作身份允许新连接代次绕过旧连接中的未决动作。 */
    const actionFlightKey = JSON.stringify([
      identity.hostId,
      identity.connectionId,
      identity.generation,
      parsedInput.unitId,
    ])
    if (this.actionFlights.has(actionFlightKey)) {
      throw new Error('SERVER_OPS_SERVICE_ACTION_IN_PROGRESS')
    }
    this.actionFlights.add(actionFlightKey)
    try {
      /** 动作用于审计的固定 operation。 */
      const operation = `service-${parsedInput.action}` as const
      /** 动作起始时间，仅用于有界 duration。 */
      let startedAt: number
      try {
        startedAt = this.dependencies.now()
        this.dependencies.audit.append({
          actor: 'user', sessionId: parsedInput.sessionId, hostId: parsedInput.hostId, unitId: parsedInput.unitId,
          operation, phase: 'start', outcome: 'success',
        })
      } catch (error) {
        throw createPublicSystemdError(error, 'SERVER_OPS_AUDIT_WRITE_FAILED')
      }

      /** 仅执行一次的远程动作结果。 */
      let execution = await this.executeAction(identity, parsedInput.unitId, parsedInput.action)
      /** 动作返回时立即冻结的耗时，详情回读不计入动作时长。 */
      const durationMs = this.readDuration(startedAt)
      /** 动作后的展示性详情；失败不得改变原动作 outcome。 */
      let detail: ServerOpsServiceDetailResult | undefined
      /** 可公开但不含底层详情的 warning。 */
      const warnings: string[] = []

      if (!this.identityIsCurrent(identity)) {
        execution = { ...execution, outcome: 'error', errorCode: 'SERVER_OPS_SERVICE_ACTION_UNKNOWN' }
      } else {
        try {
          detail = await this.readServiceDetail(identity, parsedInput.unitId)
        } catch (error) {
          if (error instanceof Error && error.message === 'SERVER_OPS_CONNECTION_CHANGED') {
            execution = { ...execution, outcome: 'error', errorCode: 'SERVER_OPS_SERVICE_ACTION_UNKNOWN' }
          } else {
            warnings.push('SERVER_OPS_SYSTEMD_OUTPUT_INVALID')
          }
        }
      }
      if (!this.identityIsCurrent(identity)) {
        execution = { ...execution, outcome: 'error', errorCode: 'SERVER_OPS_SERVICE_ACTION_UNKNOWN' }
      }

      /** result 审计严格反映动作或身份不确定性的最终事实。 */
      const resultAudit: ServerOpsAuditAppendInput = {
        actor: 'user', sessionId: parsedInput.sessionId, hostId: parsedInput.hostId, unitId: parsedInput.unitId,
        operation, phase: 'result', outcome: execution.outcome, durationMs,
        ...(execution.errorCode === undefined ? {} : { errorCode: execution.errorCode }),
      }
      try {
        this.dependencies.audit.append(resultAudit)
      } catch {
        if (execution.outcome === 'success') warnings.push('SERVER_OPS_AUDIT_RESULT_WRITE_FAILED')
      }

      /** result 审计本身也是身份竞态窗口，返回前必须再次 fresh-read。 */
      if (!this.identityIsCurrent(identity)) throw new Error('SERVER_OPS_SERVICE_ACTION_UNKNOWN')
      if (execution.errorCode) throw new Error(execution.errorCode)
      return parseServerOpsServiceActionResult({
        hostId: parsedInput.hostId,
        unitId: parsedInput.unitId,
        action: parsedInput.action,
        ...(detail?.service === undefined ? {} : { service: detail.service }),
        warnings,
      })
    } finally {
      this.actionFlights.delete(actionFlightKey)
    }
  }

  /** 使用固定命令发现 PID 1 与 systemctl 能力。 */
  private async discoverCapability(identity: ServerOpsActiveConnectionIdentity): Promise<ServerOpsSystemdCapability> {
    /** 能力命令允许用非零 127 表示没有 systemctl，其他字段仍严格有界。 */
    let result: ServerOpsRuntimeExecResult
    try {
      result = await this.dependencies.exec(
        identity.hostId,
        identity.connectionId,
        SERVER_OPS_SYSTEMD_CAPABILITY_COMMAND,
        SERVER_OPS_SYSTEMD_READ_TIMEOUT_MS,
      )
    } catch (error) {
      this.assertIdentityUnchanged(identity)
      if (error instanceof Error && error.message === 'SERVER_OPS_CONNECTION_NOT_ACTIVE') throw new Error('SERVER_OPS_CONNECTION_CHANGED')
      throw new Error('SERVER_OPS_SYSTEMD_OUTPUT_INVALID')
    }
    this.assertIdentityUnchanged(identity)
    if (result.signal !== undefined || result.truncated || result.stderr.trim().length > 0 || (result.exitCode !== 0 && result.exitCode !== 127)) {
      throw new Error('SERVER_OPS_SYSTEMD_OUTPUT_INVALID')
    }
    /** 能力输出最多包含 PID 1 名称和 systemctl 路径。 */
    const lines = parseOutputLines(result.stdout, 2)
    if (lines.length === 0 || lines[0]!.trim().length === 0) throw new Error('SERVER_OPS_SYSTEMD_OUTPUT_INVALID')
    if (lines[0]!.trim() !== 'systemd') return 'unsupported'
    if (result.exitCode === 127) return 'unsupported'
    if (lines.length !== 2 || !/^\/[A-Za-z0-9_./+-]*systemctl$/u.test(lines[1]!.trim())) {
      throw new Error('SERVER_OPS_SYSTEMD_OUTPUT_INVALID')
    }
    return 'available'
  }

  /** 在指定身份上执行一个读取命令并应用统一资格门禁。 */
  private async execRead(identity: ServerOpsActiveConnectionIdentity, command: string): Promise<ServerOpsRuntimeExecResult> {
    /** runtime 返回的原始读取结果。 */
    let result: ServerOpsRuntimeExecResult
    try {
      result = await this.dependencies.exec(identity.hostId, identity.connectionId, command, SERVER_OPS_SYSTEMD_READ_TIMEOUT_MS)
    } catch (error) {
      this.assertIdentityUnchanged(identity)
      if (error instanceof Error && error.message === 'SERVER_OPS_CONNECTION_NOT_ACTIVE') throw new Error('SERVER_OPS_CONNECTION_CHANGED')
      throw new Error('SERVER_OPS_SYSTEMD_OUTPUT_INVALID')
    }
    this.assertIdentityUnchanged(identity)
    if (result.exitCode !== 0 || result.signal !== undefined || result.truncated || result.stderr.trim().length > 0) {
      throw new Error('SERVER_OPS_SYSTEMD_OUTPUT_INVALID')
    }
    return result
  }

  /** 执行固定列表命令，并只识别 LC_ALL=C 下的标准权限拒绝文本。 */
  private async execServiceList(identity: ServerOpsActiveConnectionIdentity): Promise<ServiceListExecution> {
    /** systemctl list-units 返回的原始结果。 */
    let result: ServerOpsRuntimeExecResult
    try {
      result = await this.dependencies.exec(
        identity.hostId,
        identity.connectionId,
        SERVER_OPS_SYSTEMD_LIST_COMMAND,
        SERVER_OPS_SYSTEMD_READ_TIMEOUT_MS,
      )
    } catch (error) {
      this.assertIdentityUnchanged(identity)
      if (error instanceof Error && error.message === 'SERVER_OPS_CONNECTION_NOT_ACTIVE') throw new Error('SERVER_OPS_CONNECTION_CHANGED')
      throw new Error('SERVER_OPS_SYSTEMD_OUTPUT_INVALID')
    }
    this.assertIdentityUnchanged(identity)
    if (result.exitCode === 0 && result.signal === undefined && !result.truncated && result.stderr.trim().length === 0) {
      return { capability: 'available', result }
    }
    /** 固定 locale 下允许识别为能力状态的标准权限拒绝集合。 */
    const permissionDenied = /^(?:Failed to list units: )?(?:Access denied|Permission denied|Interactive authentication required)\.?$/u
    if (result.exitCode !== undefined && result.exitCode > 0
      && result.signal === undefined && !result.truncated && result.stdout.length === 0
      && permissionDenied.test(result.stderr.trim())) {
      return { capability: 'permission-denied' }
    }
    throw new Error('SERVER_OPS_SYSTEMD_OUTPUT_INVALID')
  }

  /** 严格解析 systemctl list-units 的五列纯文本输出。 */
  private parseServiceList(output: string): ServerOpsServiceSummary[] {
    /** 最多接受 runtime 容量内可能出现的服务行，公开结果随后收敛到一千。 */
    const lines = parseOutputLines(output, 20_000)
    return lines.map((line) => {
      /** 固定前四列加非空描述列的匹配结果。 */
      const match = /^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.+)$/u.exec(line)
      if (!match) throw new Error('SERVER_OPS_SYSTEMD_OUTPUT_INVALID')
      /** Shared parser 再次约束可进入命令边界的 unit。 */
      const unitId = parseServerOpsSystemdUnitId(match[1])
      return {
        unitId,
        loadState: match[2]!,
        activeState: match[3]!,
        subState: match[4]!,
        description: match[5]!,
        enabled: null,
      }
    })
  }

  /** 使用固定 show 与 journal 命令读取一个服务详情。 */
  private async readServiceDetail(identity: ServerOpsActiveConnectionIdentity, unitId: string): Promise<ServerOpsServiceDetailResult> {
    /** 内部调用仍再次经过 Shared unit parser。 */
    const parsedUnitId = parseServerOpsSystemdUnitId(unitId)
    /** 当前主机的 systemd 能力。 */
    const capability = await this.discoverCapability(identity)
    if (capability !== 'available') {
      return parseServerOpsServiceDetailResult({
        hostId: identity.hostId, capability, statusLines: [], recentLogLines: [], warnings: [],
      })
    }
    /** 已验证 unit 的 POSIX 安全命令参数。 */
    const quotedUnit = quotePosixArgument(parsedUnitId)
    /** systemctl show 的固定命令。 */
    const showCommand = `LC_ALL=C systemctl show --no-pager --property=${SERVER_OPS_SYSTEMD_SHOW_FIELDS.join(',')} -- ${quotedUnit}`
    /** journalctl 的固定最近一百行命令。 */
    const journalCommand = `LC_ALL=C journalctl --quiet --no-pager --lines=100 --unit=${quotedUnit}`
    /** 独立且有界的 show 结果。 */
    const showResult = await this.execRead(identity, showCommand)
    /** 独立且有界的 journal 结果。 */
    const journalResult = await this.execRead(identity, journalCommand)
    /** show 原始状态行用于公开详情展示。 */
    const statusLines = parseOutputLines(showResult.stdout, 200)
    /** journal 最多公开命令合同中的一百行。 */
    const recentLogLines = parseOutputLines(journalResult.stdout, 100)
    /** 严格 key=value 输出解析得到的服务摘要。 */
    const service = this.parseServiceDetail(parsedUnitId, statusLines)
    this.assertIdentityUnchanged(identity)
    return parseServerOpsServiceDetailResult({
      hostId: identity.hostId, capability, service, statusLines, recentLogLines, warnings: [],
    })
  }

  /** 严格解析 systemctl show 的精确字段集合。 */
  private parseServiceDetail(expectedUnitId: string, lines: string[]): ServerOpsServiceSummary {
    if (lines.length !== SERVER_OPS_SYSTEMD_SHOW_FIELDS.length) throw new Error('SERVER_OPS_SYSTEMD_OUTPUT_INVALID')
    /** 按字段名保存且拒绝重复或未知字段的 show 值。 */
    const fields = new Map<string, string>()
    for (const line of lines) {
      /** key 与 value 的唯一分隔位置。 */
      const separator = line.indexOf('=')
      if (separator < 1) throw new Error('SERVER_OPS_SYSTEMD_OUTPUT_INVALID')
      /** 当前固定字段名。 */
      const key = line.slice(0, separator)
      /** 当前字段原始值。 */
      const value = line.slice(separator + 1)
      if (!SERVER_OPS_SYSTEMD_SHOW_FIELDS.includes(key as typeof SERVER_OPS_SYSTEMD_SHOW_FIELDS[number]) || fields.has(key)) {
        throw new Error('SERVER_OPS_SYSTEMD_OUTPUT_INVALID')
      }
      fields.set(key, value)
    }
    if (SERVER_OPS_SYSTEMD_SHOW_FIELDS.some((field) => !fields.has(field))) throw new Error('SERVER_OPS_SYSTEMD_OUTPUT_INVALID')
    /** 由 systemctl 返回的实际 unit 身份。 */
    const unitId = parseServerOpsSystemdUnitId(fields.get('Id'))
    if (unitId !== expectedUnitId) throw new Error('SERVER_OPS_SYSTEMD_OUTPUT_INVALID')
    /** MainPID 必须是 systemd 公开的非负安全整数。 */
    const mainPidText = fields.get('MainPID')!
    if (!/^\d+$/u.test(mainPidText)) throw new Error('SERVER_OPS_SYSTEMD_OUTPUT_INVALID')
    /** 转换后的主进程 PID。 */
    const mainPid = Number(mainPidText)
    if (!Number.isSafeInteger(mainPid) || mainPid > 2_147_483_647) throw new Error('SERVER_OPS_SYSTEMD_OUTPUT_INVALID')
    /** 非空详情字段交由 Shared 输出 parser 完成最终范围校验。 */
    const description = fields.get('Description')!
    const loadState = fields.get('LoadState')!
    const activeState = fields.get('ActiveState')!
    const subState = fields.get('SubState')!
    if (!description || !loadState || !activeState || !subState) throw new Error('SERVER_OPS_SYSTEMD_OUTPUT_INVALID')
    /** 空时间戳表示尚未进入 active，不公开可选字段。 */
    const activeSince = fields.get('ActiveEnterTimestamp')!
    return {
      unitId,
      description,
      loadState,
      activeState,
      subState,
      enabled: parseEnabledState(fields.get('UnitFileState')!),
      mainPid,
      ...(activeSince.length === 0 ? {} : { activeSince }),
    }
  }

  /** 执行一次固定枚举动作，并把输出状态收敛为稳定领域事实。 */
  private async executeAction(
    identity: ServerOpsActiveConnectionIdentity,
    unitId: string,
    action: ServerOpsServiceAction,
  ): Promise<ServiceActionExecution> {
    /** 内部动作边界再次严格解析 unit。 */
    const parsedUnitId = parseServerOpsSystemdUnitId(unitId)
    /** 动作枚举到固定 systemctl 子命令的一一映射。 */
    const commands: Record<ServerOpsServiceAction, string> = {
      start: 'start', stop: 'stop', restart: 'restart', enable: 'enable', disable: 'disable',
    }
    /** 只含固定动作与安全 unit 参数的命令。 */
    const command = `LC_ALL=C systemctl ${commands[action]} -- ${quotePosixArgument(parsedUnitId)}`
    try {
      /** 唯一一次动作 exec 的远程结果。 */
      const result = await this.dependencies.exec(
        identity.hostId, identity.connectionId, command, SERVER_OPS_SYSTEMD_ACTION_TIMEOUT_MS,
      )
      if (!this.identityIsCurrent(identity)) {
        return { outcome: 'error', errorCode: 'SERVER_OPS_SERVICE_ACTION_UNKNOWN' }
      }
      if (result.exitCode === 0 && result.signal === undefined && !result.truncated) {
        return { outcome: 'success' }
      }
      if (result.exitCode !== undefined && result.exitCode > 0
        && result.signal === undefined && !result.truncated && result.stdout.length === 0
        && isStandardActionPermissionDenied(result.stderr, parsedUnitId, action)) {
        return { outcome: 'error', errorCode: 'SERVER_OPS_SYSTEMD_PERMISSION_DENIED' }
      }
      /** 无退出状态或截断时无法证明动作结果；stderr 不参与动作成功判断。 */
      const errorCode = result.exitCode === undefined || result.truncated
        ? 'SERVER_OPS_SERVICE_ACTION_UNKNOWN'
        : 'SERVER_OPS_SERVICE_ACTION_FAILED'
      return { outcome: 'error', errorCode }
    } catch {
      /** Promise rejection 发生在命令可能已 dispatch 之后，无法证明远程结果。 */
      return { outcome: 'error', errorCode: 'SERVER_OPS_SERVICE_ACTION_UNKNOWN' }
    }
  }

  /** 读取动作耗时并在时间源异常时稳定降级为零。 */
  private readDuration(startedAt: number): number {
    try {
      /** 防止非单调测试时钟制造负数或非整数审计字段。 */
      return Math.max(0, Math.floor(this.dependencies.now() - startedAt))
    } catch {
      return 0
    }
  }

  /** 请求起点读取活跃身份，不存在时统一视为连接变化。 */
  private readInitialIdentity(hostId: string): ServerOpsActiveConnectionIdentity {
    try {
      return this.dependencies.getActiveIdentity(hostId)
    } catch {
      throw new Error('SERVER_OPS_CONNECTION_CHANGED')
    }
  }

  /** 判断当前活跃身份是否仍与动作起点完全一致。 */
  private identityIsCurrent(expected: ServerOpsActiveConnectionIdentity): boolean {
    try {
      return identitiesEqual(this.dependencies.getActiveIdentity(expected.hostId), expected)
    } catch {
      return false
    }
  }

  /** fresh-read 并在连接身份漂移时 fail closed。 */
  private assertIdentityUnchanged(expected: ServerOpsActiveConnectionIdentity): void {
    if (!this.identityIsCurrent(expected)) throw new Error('SERVER_OPS_CONNECTION_CHANGED')
  }
}
