import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  isServerOpsAuditRecord,
  isServerOpsId,
  parseServerOpsAuditListInput,
} from '@proma/shared'
import type {
  ServerOpsAuditAppendInput,
  ServerOpsAuditListInput,
  ServerOpsAuditListResult,
  ServerOpsAuditRecord,
} from '@proma/shared'
import { getConfigDir } from '../config-paths'
import { readJsonFileSafe, writeJsonFileAtomic } from '../safe-file'
import type { ReadJsonFileSafeOptions } from '../safe-file'

/** 审计文件当前写入的 schema 版本。 */
const SERVER_OPS_AUDIT_SCHEMA_VERSION = 2
/** 审计文件固定保留的最近记录数量。 */
const SERVER_OPS_AUDIT_MAX_RECORDS = 5_000
/** 单条命令允许进入公开审计的最大字符数。 */
const SERVER_OPS_AUDIT_COMMAND_MAX_LENGTH = 512
/** 允许跨审计边界公开的主进程自有稳定错误码。 */
const SERVER_OPS_AUDIT_ERROR_CODES = new Set([
  'SERVER_OPS_CONNECTION_FAILED',
  'SERVER_OPS_CONNECTION_TIMEOUT',
  'SERVER_OPS_CONNECTION_CLOSED',
  'SERVER_OPS_CONNECTION_NOT_ACTIVE',
  'SERVER_OPS_EXEC_FAILED',
  'SERVER_OPS_EXEC_TIMEOUT',
  'SERVER_OPS_RUNTIME_FAILED',
  'SERVER_OPS_RUNTIME_STOPPED',
  'SERVER_OPS_RUNTIME_START_TIMEOUT',
  'SERVER_OPS_CREDENTIAL_REQUIRED',
  'SERVER_OPS_CREDENTIAL_DECRYPT_FAILED',
  'SERVER_OPS_SECURE_STORAGE_UNAVAILABLE',
  'SERVER_OPS_PRIVATE_KEY_UNAVAILABLE',
  'SERVER_OPS_PRIVATE_KEY_INVALID',
  'SERVER_OPS_SSH_AGENT_UNAVAILABLE',
  'SERVER_OPS_AUTH_FAILED',
  'SERVER_OPS_HOST_KEY_CHANGED',
  'SERVER_OPS_HOST_KEY_REJECTED',
  'SERVER_OPS_HOST_KEY_CANDIDATE_EXPIRED',
  'SERVER_OPS_CONNECTION_CHANGED',
  'SERVER_OPS_SYSTEMD_UNSUPPORTED',
  'SERVER_OPS_SYSTEMD_PERMISSION_DENIED',
  'SERVER_OPS_SYSTEMD_OUTPUT_INVALID',
  'SERVER_OPS_SERVICE_ACTION_FAILED',
  'SERVER_OPS_SERVICE_ACTION_UNKNOWN',
  'SERVER_OPS_AUDIT_READ_FAILED',
  'SERVER_OPS_AUDIT_WRITE_FAILED',
])

/** schema v1 仅支持的 Agent 操作。 */
type ServerOpsAuditOperationV1 = 'connect' | 'exec' | 'disconnect'

/** schema v1 中尚未携带 actor 的旧审计记录。 */
interface ServerOpsAuditRecordV1 {
  id: string
  timestamp: number
  sessionId: string
  hostId: string
  operation: ServerOpsAuditOperationV1
  phase: 'start' | 'result'
  outcome: 'success' | 'error'
  durationMs?: number
  command?: string
  commandTruncated?: boolean
  exitCode?: number
  signal?: string
  errorCode?: string
}

/** 磁盘中的旧版 Agent 审计文件。 */
interface ServerOpsAuditFileV1 {
  version: 1
  records: ServerOpsAuditRecordV1[]
}

/** 磁盘中的当前审计文件。 */
interface ServerOpsAuditFileV2 {
  version: 2
  records: ServerOpsAuditRecord[]
}

/** 审计 Store 可替换的安全文件、ID 与时间依赖。 */
export interface ServerOpsAuditStoreDependencies {
  readJson: <T>(filePath: string, options: ReadJsonFileSafeOptions<T>) => T | null
  writeJson: (filePath: string, data: object) => void
  uuid: () => string
  now: () => number
}

/** 创建生产环境使用的审计 Store 依赖。 */
export function createServerOpsAuditStoreDependencies(): ServerOpsAuditStoreDependencies {
  return {
    readJson: readJsonFileSafe,
    writeJson: writeJsonFileAtomic,
    uuid: randomUUID,
    now: Date.now,
  }
}

/** schema v1 记录允许出现的精确旧字段。 */
const SERVER_OPS_AUDIT_RECORD_V1_KEYS = new Set([
  'id', 'timestamp', 'sessionId', 'hostId', 'operation', 'phase', 'outcome',
  'durationMs', 'command', 'commandTruncated', 'exitCode', 'signal', 'errorCode',
])

/** 判断未知值是否为仅包含指定字段的普通对象。 */
function hasOnlyKeys(value: unknown, keys: ReadonlySet<string>): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.keys(value).every((key) => keys.has(key))
}

/** 独立校验旧记录字段，并借当前公开约束验证共同的有界语义。 */
function isServerOpsAuditRecordV1(value: unknown): value is ServerOpsAuditRecordV1 {
  if (!hasOnlyKeys(value, SERVER_OPS_AUDIT_RECORD_V1_KEYS)) return false
  if (value.operation !== 'connect' && value.operation !== 'exec' && value.operation !== 'disconnect') return false
  return isServerOpsAuditRecord({ ...value, actor: 'agent' })
}

/** 判断磁盘值是否为严格、有界的 schema v1 文件。 */
function isServerOpsAuditFileV1(value: unknown): value is ServerOpsAuditFileV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  /** 待检查的顶层审计对象。 */
  const record = value as Record<string, unknown>
  return Object.keys(record).every((key) => key === 'version' || key === 'records')
    && record.version === 1
    && Array.isArray(record.records)
    && record.records.length <= SERVER_OPS_AUDIT_MAX_RECORDS
    && record.records.every(isServerOpsAuditRecordV1)
}

/** 判断磁盘值是否为严格、有界的 schema v2 文件。 */
function isServerOpsAuditFileV2(value: unknown): value is ServerOpsAuditFileV2 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  /** 待检查的顶层审计对象。 */
  const record = value as Record<string, unknown>
  return Object.keys(record).every((key) => key === 'version' || key === 'records')
    && record.version === SERVER_OPS_AUDIT_SCHEMA_VERSION
    && Array.isArray(record.records)
    && record.records.length <= SERVER_OPS_AUDIT_MAX_RECORDS
    && record.records.every(isServerOpsAuditRecord)
}

/** 把已严格验证的旧 Agent 记录升级为当前公开记录。 */
function migrateAuditRecord(record: ServerOpsAuditRecordV1): ServerOpsAuditRecord {
  return { ...record, actor: 'agent' }
}

/** 复制单条公开记录，防止调用方修改 Store 内部对象。 */
function cloneAuditRecord(record: ServerOpsAuditRecord): ServerOpsAuditRecord {
  return { ...record }
}

/** 脱敏后的有界命令摘要及真实截断状态。 */
interface ServerOpsAuditCommandSummary {
  command: string
  commandTruncated: boolean
}

/** 带原始 source span 的 shell WORD 词法结果。 */
interface ShellWordToken {
  start: number
  end: number
  raw: string
  value: string
  quoted: boolean
  reliable: boolean
}

/** 待应用到原始命令的脱敏替换区间。 */
interface ShellRedaction {
  start: number
  end: number
  replacement: string
}

/** 覆盖 shell 引号、拼接和反斜杠转义的单个 WORD，不尝试执行变量展开。 */
const SHELL_WORD_SOURCE = String.raw`(?:"(?:\\.|[^"\\])*"|'[^']*'|(?:\\.|[^\s;&|<>"'\\])+)+`

/** 对命令执行一次 shell WORD 词法扫描，保留 quote removal 后值与原始区间。 */
function scanShellWords(command: string): ShellWordToken[] {
  /** 扫描得到的全部 WORD。 */
  const tokens: ShellWordToken[] = []
  /** 当前扫描位置。 */
  let index = 0
  while (index < command.length) {
    while (index < command.length && /[\s;&|<>]/.test(command[index]!)) index += 1
    if (index >= command.length) break
    /** 当前 WORD 在原始命令中的起点。 */
    const start = index
    /** quote removal 后的字面值。 */
    let value = ''
    /** 当前引号上下文。 */
    let quote: "'" | '"' | null = null
    /** WORD 是否使用过引号，供不透明 payload 保守分类。 */
    let quoted = false
    /** 未闭合引号或末尾反斜杠表示无法可靠分类。 */
    let reliable = true
    while (index < command.length) {
      /** 当前字符。 */
      const character = command[index]!
      if (quote === null && /[\s;&|<>]/.test(character)) break
      if (character === "'" && quote !== '"') {
        quoted = true
        quote = quote === "'" ? null : "'"
        index += 1
        continue
      }
      if (character === '"' && quote !== "'") {
        quoted = true
        quote = quote === '"' ? null : '"'
        index += 1
        continue
      }
      if (character === '\\' && quote !== "'") {
        if (index + 1 >= command.length) {
          reliable = false
          index += 1
          break
        }
        value += command[index + 1]!
        index += 2
        continue
      }
      value += character
      index += 1
    }
    if (quote !== null) reliable = false
    tokens.push({ start, end: index, raw: command.slice(start, index), value, quoted, reliable })
  }
  return tokens
}

/** 去除 shell WORD 的语法引号与反斜杠，供 delimiter 和路径分类使用。 */
function decodeShellWord(word: string): string {
  /** 当前是否处于单引号或双引号中。 */
  let quote: "'" | '"' | null = null
  /** 去除语法字符后的保守字面值。 */
  let decoded = ''
  for (let index = 0; index < word.length; index += 1) {
    /** 当前待解释的字符。 */
    const character = word[index]!
    if (quote === null && (character === "'" || character === '"')) {
      quote = character
    } else if (quote === character) {
      quote = null
    } else if (character === '\\' && quote !== "'" && index + 1 < word.length) {
      decoded += word[index + 1]!
      index += 1
    } else {
      decoded += character
    }
  }
  return decoded
}

/** 把 heredoc 正文替换为固定占位符；无法可靠找到边界时保守隐藏剩余正文。 */
function redactHeredocBodies(command: string): string {
  /** 按 shell 的逐行 heredoc 边界扫描，统一规范为 LF 仅用于审计摘要。 */
  const lines = command.split(/\r?\n/)
  /** 已完成正文替换的输出行。 */
  const redacted: string[] = []
  /** 允许标点、引号和反斜杠且明确排除 `<<<` 的 heredoc 起始标记。 */
  const markerPattern = new RegExp(`(?<!<)<<(?!<)(\\-?)\\s*(${SHELL_WORD_SOURCE})`, 'g')
  /** 只统计真实 heredoc 运算符，用于发现无法可靠解析的 marker。 */
  const operatorPattern = /(?<!<)<<(?!<)/g
  for (let index = 0; index < lines.length; index += 1) {
    /** 当前可能声明 heredoc 的命令行。 */
    const line = lines[index]!
    /** 按命令行声明顺序收集全部 heredoc marker。 */
    const markers = [...line.matchAll(markerPattern)]
    /** 本行出现的 heredoc 运算符数量。 */
    const operatorCount = [...line.matchAll(operatorPattern)].length
    if (operatorCount === 0) {
      redacted.push(line)
      continue
    }
    redacted.push(line)
    if (markers.length !== operatorCount) {
      redacted.push('[REDACTED]')
      return redacted.join('\n')
    }
    /** 下一段 heredoc 正文开始搜索的行下标。 */
    let bodyIndex = index + 1
    for (const marker of markers) {
      /** shell 去引号和反斜杠后的真实结束标签。 */
      const delimiter = decodeShellWord(marker[2]!)
      /** `<<-` 仅允许结束标签前出现 tab。 */
      const stripTabs = marker[1] === '-'
      /** 与当前 heredoc 对应的结束标签行下标。 */
      let endIndex = bodyIndex
      while (endIndex < lines.length) {
        /** 当前候选结束行按 `<<-` 规则规范化。 */
        const candidate = stripTabs ? lines[endIndex]!.replace(/^\t+/, '') : lines[endIndex]!
        if (candidate === delimiter) break
        endIndex += 1
      }
      redacted.push('[REDACTED]')
      if (endIndex >= lines.length) return redacted.join('\n')
      redacted.push(lines[endIndex]!)
      bodyIndex = endIndex + 1
    }
    index = bodyIndex - 1
  }
  return redacted.join('\n')
}

/** 判断 quote removal 后的键是否属于必须脱敏的秘密键。 */
function isSecretKey(value: string): boolean {
  /** 分隔后的秘密语义同样 fail closed，例如 `db-password`、`auth-token`。 */
  return /(?:^|[_-])(?:pass(?:word|phrase)?|token|api[_-]?key|secret|authorization)(?:$|[_-])/i.test(value)
}

/** 返回需要按命令语义处理认证参数的 CLI 名称，路径形式同样按 basename 识别。 */
function getCredentialAwareCommand(value: string): 'curl' | 'sshpass' | 'redis-cli' | null {
  /** 去除可执行文件目录后的命令名。 */
  const command = value.split(/[\\/]/).at(-1)?.toLowerCase()
  return command === 'curl' || command === 'sshpass' || command === 'redis-cli' ? command : null
}

/** 判断指定 CLI flag 的当前值或下一参数是否承载认证秘密。 */
function isCredentialFlag(command: 'curl' | 'sshpass' | 'redis-cli', flag: string): boolean {
  if (command === 'curl') return flag === '-u' || flag === '--user'
  if (command === 'sshpass') return flag === '-p' || flag === '-f'
  return flag === '-a' || flag === '--pass'
}

/** 判断常见 CLI 是否把秘密值直接粘连在短选项后。 */
function hasAttachedCredentialValue(command: 'curl' | 'sshpass' | 'redis-cli', value: string): boolean {
  if (command === 'curl') return value.startsWith('-u') && value.length > 2
  if (command === 'sshpass') return /^-[pf].+/.test(value)
  return value.startsWith('-a') && value.length > 2
}

/** 基于统一 token 流生成秘密替换，避免 raw regex 被引号拼接绕过。 */
function redactShellWords(command: string): string {
  /** 命令的唯一 WORD token 流。 */
  const tokens = scanShellWords(command)
  /** 按 source span 收集的脱敏替换。 */
  const redactions: ShellRedaction[] = []
  /** 前一个 WORD 是否为需要隐藏下一个参数的秘密 flag。 */
  let redactNext = false
  /** 前一个 WORD 是否为 Authorization/Bearer 或不透明 data payload flag。 */
  let redactOpaqueNext = false
  /** 当前 shell 命令中需要专门识别认证 flag 的 CLI。 */
  let credentialAwareCommand: 'curl' | 'sshpass' | 'redis-cli' | null = null
  /** 上一个 WORD 的源码结束位置，用于识别换行和 shell 连接符边界。 */
  let previousTokenEnd = 0
  for (const token of tokens) {
    /** 新命令边界后不继承上一条命令的短参数语义。 */
    if (/[\n;|&]/.test(command.slice(previousTokenEnd, token.start))) credentialAwareCommand = null
    previousTokenEnd = token.end
    /** quote removal 后用于语义分类的 WORD。 */
    const value = token.value
    /** 当前 WORD 是否已确定需要整词隐藏。 */
    let redact = redactNext || redactOpaqueNext || !token.reliable
    redactNext = false
    redactOpaqueNext = false

    /** `KEY=value` 与 `--flag=value` 在 quote removal 后统一分类。 */
    const assignmentIndex = value.indexOf('=')
    if (assignmentIndex > 0) {
      /** 去除 flag 前缀后的赋值键。 */
      const key = value.slice(0, assignmentIndex).replace(/^-{1,2}/, '')
      if (isSecretKey(key) || /^header$/i.test(key)
        || /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && !value.startsWith('-')) redact = true
      /** `--user=...` 等命令专用认证参数必须隐藏整个 WORD。 */
      if (credentialAwareCommand && isCredentialFlag(credentialAwareCommand, value.slice(0, assignmentIndex))) redact = true
    }
    /** URL query 中的秘密键同样基于当前完整 token 的 quote removal 值分类。 */
    const queryIndex = value.indexOf('?')
    if (queryIndex >= 0) {
      /** 当前 URL token 中可见的 query 片段。 */
      const query = value.slice(queryIndex + 1)
      if (query.split('&').some((entry) => isSecretKey(entry.split('=', 1)[0] ?? ''))) redact = true
    }
    /** 独立 secret flag 的下一个完整 WORD 是秘密值。 */
    const flagKey = value.replace(/^-{1,2}/, '')
    if (assignmentIndex < 0 && /^-{1,2}/.test(value) && isSecretKey(flagKey)) redactNext = true
    if (/^(?:-i|--identity-file|IdentityFile)$/i.test(value)) redactNext = true
    if (credentialAwareCommand && isCredentialFlag(credentialAwareCommand, value)) redactNext = true
    if (credentialAwareCommand && hasAttachedCredentialValue(credentialAwareCommand, value)) redact = true
    if (value === '-H' || value === '--header') redactOpaqueNext = true
    /** Authorization/Bearer 后续值和 curl data payload 无法可靠细分，保守整词隐藏。 */
    if (/^(?:authorization|bearer)$/i.test(value) || /^-(?:d|data|data-raw|data-binary)$/i.test(value)) redactOpaqueNext = true
    /** quoted JSON/object payload 视为不透明秘密容器。 */
    if (token.quoted && /^[{[]/.test(value)) redact = true
    if (/^Authorization\s*:/i.test(value)) redact = true
    /** URI userinfo 与私钥路径均只依据 quote removal 后完整 WORD 分类。 */
    if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/@\s]+@/.test(value)
      || /(?:^|[\\/])\.ssh[\\/]/i.test(value)
      || /\.(?:pem|key|ppk)$/i.test(value)) redact = true
    if (redact) redactions.push({ start: token.start, end: token.end, replacement: '[REDACTED]' })
    /** 仅精确 CLI 名称启用短 flag 规则，避免把 `ssh -p` 等普通参数误判为密码。 */
    credentialAwareCommand = getCredentialAwareCommand(value) ?? credentialAwareCommand
  }
  /** 从尾到头替换，确保所有 source span 保持原始坐标。 */
  let sanitized = command
  for (const redaction of redactions.reverse()) {
    sanitized = `${sanitized.slice(0, redaction.start)}${redaction.replacement}${sanitized.slice(redaction.end)}`
  }
  return sanitized
}

/** 在完整命令上脱敏所有已知敏感 shell 结构，再计算 512 字符摘要。 */
function summarizeServerOpsAuditCommand(command: string): ServerOpsAuditCommandSummary {
  /** 完整命令先执行所有结构与秘密规则，避免边界处截断出秘密前缀。 */
  const sanitized = redactShellWords(redactHeredocBodies(command)
    .replace(new RegExp(`((?:^|[\\s;|&])\\d*(?<!<)(?:<<<|>>|>|<(?!<))\\s*)(${SHELL_WORD_SOURCE})`, 'g'), '$1[REDACTED]'))
  return {
    command: sanitized.slice(0, SERVER_OPS_AUDIT_COMMAND_MAX_LENGTH),
    commandTruncated: sanitized.length > SERVER_OPS_AUDIT_COMMAND_MAX_LENGTH,
  }
}

/** 返回兼容调用方使用的脱敏命令摘要。 */
export function sanitizeServerOpsAuditCommand(command: string): string {
  return summarizeServerOpsAuditCommand(command).command
}

/** 从未知错误中提取稳定且有界的公开错误码。 */
export function getServerOpsAuditErrorCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    && SERVER_OPS_AUDIT_ERROR_CODES.has(error.code)) return error.code
  return 'SERVER_OPS_REMOTE_OPERATION_FAILED'
}

/** 管理 `~/.proma/server-ops/audit.json` 的有界服务器操作审计。 */
export class ServerOpsAuditStore {
  /** 审计文件的固定最终路径。 */
  private readonly filePath: string
  /** 可替换的安全文件和确定性测试依赖。 */
  private readonly dependencies: ServerOpsAuditStoreDependencies
  /** 仅在写盘成功后替换的内存快照。 */
  private records: ServerOpsAuditRecord[]
  /** 已存在文件无法读取或迁移时保持的稳定错误，避免远程操作绕过审计。 */
  private unavailableErrorCode: 'SERVER_OPS_AUDIT_READ_FAILED' | 'SERVER_OPS_AUDIT_WRITE_FAILED' | null

  /** 创建 Store 并严格读取已存在的版本化审计文件。 */
  constructor(configDir = getConfigDir(), dependencies: Partial<ServerOpsAuditStoreDependencies> = {}) {
    /** 审计与主机资产共享的固定目录。 */
    const directoryPath = join(configDir, 'server-ops')
    mkdirSync(directoryPath, { recursive: true })
    this.filePath = join(directoryPath, 'audit.json')
    this.dependencies = { ...createServerOpsAuditStoreDependencies(), ...dependencies }
    /** 区分首次无文件与已有文件无法恢复，后者必须 fail closed。 */
    const existed = existsSync(this.filePath)
    if (!existed) {
      this.unavailableErrorCode = null
      this.records = []
      return
    }
    /** 原始主文件版本先独立判定，禁止 safe-file 用备份掩盖损坏现场。 */
    let primary: unknown
    try {
      primary = JSON.parse(readFileSync(this.filePath, 'utf8'))
    } catch {
      this.unavailableErrorCode = 'SERVER_OPS_AUDIT_READ_FAILED'
      this.records = []
      return
    }
    if (isServerOpsAuditFileV2(primary)) {
      /** 主文件已完成严格校验，直接复用快照避免对最多 5000 条记录重复解析。 */
      this.unavailableErrorCode = null
      this.records = primary.records.map(cloneAuditRecord)
      return
    }
    if (!isServerOpsAuditFileV1(primary)) {
      this.unavailableErrorCode = 'SERVER_OPS_AUDIT_READ_FAILED'
      this.records = []
      return
    }
    /** v1 必须再次经安全读取和独立 legacy parser，避免迁移已变化的主文件。 */
    const legacy = this.dependencies.readJson(this.filePath, { validate: isServerOpsAuditFileV1 })
    if (legacy === null) {
      this.unavailableErrorCode = 'SERVER_OPS_AUDIT_READ_FAILED'
      this.records = []
      return
    }
    /** 只有原子迁移和 v2 权威回读都成功，才允许后续审计读写。 */
    const migrated = legacy.records.map(migrateAuditRecord)
    try {
      this.dependencies.writeJson(this.filePath, { version: SERVER_OPS_AUDIT_SCHEMA_VERSION, records: migrated })
    } catch {
      this.unavailableErrorCode = 'SERVER_OPS_AUDIT_WRITE_FAILED'
      this.records = []
      return
    }
    const loaded = this.dependencies.readJson(this.filePath, { validate: isServerOpsAuditFileV2 })
    this.unavailableErrorCode = loaded === null ? 'SERVER_OPS_AUDIT_READ_FAILED' : null
    this.records = loaded?.records.map(cloneAuditRecord) ?? []
  }

  /** 追加一条严格公开记录，并以原子写提交最多 5000 条快照。 */
  append(input: ServerOpsAuditAppendInput): ServerOpsAuditRecord {
    this.assertAvailable()
    /** 完整命令先脱敏，随后由公开 DTO 校验 512 字符边界。 */
    const commandSummary = typeof input.command === 'string' ? summarizeServerOpsAuditCommand(input.command) : undefined
    /** Store 生成且即将严格校验的新记录。 */
    const record = {
      ...input,
      id: this.dependencies.uuid(),
      timestamp: this.dependencies.now(),
      ...(commandSummary === undefined ? {} : commandSummary),
    }
    if (!isServerOpsAuditRecord(record)) throw new Error('SERVER_OPS_AUDIT_RECORD_INVALID')
    /** rotation 只保留包含本条记录在内的最近 5000 条。 */
    const next = [...this.records, record].slice(-SERVER_OPS_AUDIT_MAX_RECORDS)
    try {
      this.dependencies.writeJson(this.filePath, { version: SERVER_OPS_AUDIT_SCHEMA_VERSION, records: next })
    } catch {
      /** 原子替换可能已成功，内存无法判断磁盘状态时必须持续阻断后续覆盖。 */
      this.unavailableErrorCode = 'SERVER_OPS_AUDIT_WRITE_FAILED'
      throw new Error('SERVER_OPS_AUDIT_WRITE_FAILED')
    }
    this.records = next
    return cloneAuditRecord(record)
  }

  /** 按公开筛选返回最近记录的深拷贝。 */
  list(input: ServerOpsAuditListInput = {}): ServerOpsAuditListResult {
    this.assertAvailable()
    /** 即使主进程内部调用也沿用共享严格筛选合同。 */
    const filter = parseServerOpsAuditListInput(input)
    /** 筛选后按最近上限截取，保留时间正序便于稳定阅读。 */
    const filtered = this.records.filter((record) => (
      (filter.hostId === undefined || record.hostId === filter.hostId)
      && (filter.actor === undefined || record.actor === filter.actor)
      && (filter.operation === undefined || record.operation === filter.operation)
    ))
    return { records: filtered.slice(-(filter.limit ?? SERVER_OPS_AUDIT_MAX_RECORDS)).map(cloneAuditRecord) }
  }

  /** 已有坏文件或迁移失败时向读取和写入持续暴露稳定错误。 */
  private assertAvailable(): void {
    if (this.unavailableErrorCode) throw new Error(this.unavailableErrorCode)
  }
}
