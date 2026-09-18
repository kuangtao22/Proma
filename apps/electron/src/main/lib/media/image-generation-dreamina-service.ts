/**
 * 即梦 CLI 的登录、状态与登出服务。
 *
 * 即梦没有 HTTP 接口，唯一入口是本地 dreamina 命令，登录态由 CLI 自己保存在系统凭据库。
 * 本服务只做四件事：查询登录态与额度、发起 OAuth 设备码登录、轮询授权结果、清除登录态。
 * device_code 始终留在主进程内存，Renderer 只能拿到 user_code 与授权地址。
 */
import type {
  ImageGenerationDreaminaLoginPollResult,
  ImageGenerationDreaminaLoginStartResult,
  ImageGenerationDreaminaLogoutResult,
  ImageGenerationDreaminaStatus,
} from '@proma/shared'
import {
  DREAMINA_LOGIN_MESSAGES,
  parseDreaminaCliInput,
  parseDreaminaLoginPollResult,
  parseDreaminaLoginRequestInput,
  parseDreaminaLoginStartInput,
  parseDreaminaLoginStartResult,
  parseDreaminaLogoutResult,
  parseDreaminaStatus,
} from '@proma/shared'

/** CLI 单次调用结果；只保留判定所需字段，不向上暴露原始输出。 */
export interface DreaminaCliRunResult {
  exitCode: number
  stdout: string
  stderr: string
  /** CLI 缺失或进程超时等基础设施失败，与业务失败区分。 */
  failureCode?: 'cliMissing' | 'timeout'
}

/** 可注入的 CLI 执行器，便于测试喂入真实输出样本。 */
export type DreaminaCliRun = (
  args: readonly string[],
  cliPath: string,
  timeoutMs: number,
) => Promise<DreaminaCliRunResult>

export interface ImageGenerationDreaminaServiceOptions {
  /** 可注入的 CLI 执行器；缺省走真实 spawn。 */
  run?: DreaminaCliRun
  /** 单次 CLI 调用超时；缺省 60 秒。 */
  timeoutMs?: number
  /** 设备码未知有效期时的兜底 TTL；缺省 10 分钟。 */
  deviceCodeTtlMs?: number
  /** 可注入的时钟，便于测试过期语义。 */
  now?: () => number
}

/** 一次进行中的设备码登录；只保存身份与到期时间，不保存凭据。 */
interface ActiveDreaminaLogin {
  requestId: string
  cliPath: string
  deviceCode: string
  /** 设备码绝对到期时间，超过后不再向上游查询。 */
  expiresAt: number
}

/** 单窗口允许并发的设备码登录上限，防御 Renderer 反复点击。 */
const MAX_ACTIVE_LOGINS_PER_OWNER = 4
/** 单次 CLI 调用默认超时。 */
const DEFAULT_TIMEOUT_MS = 60_000
/** 设备码未知有效期时的兜底 TTL。 */
const DEFAULT_DEVICE_CODE_TTL_MS = 10 * 60_000
/** Node timer 不发生溢出的最大毫秒值。 */
const MAX_TIMEOUT_MS = 2_147_483_647
/** checklogin 单次在 CLI 内等待的秒数，避免长时间占用 IPC。 */
const CHECK_LOGIN_POLL_SECONDS = 8
/** CLI 输出中的 ANSI 颜色控制符，解析前必须剥离。 */
const ANSI_PATTERN = /\u001b\[[0-9;]*m/g
/** 单次调用允许保留的输出上限，防止异常 CLI 撑爆内存。 */
const OUTPUT_LIMIT = 64 * 1024

/** 剥离 ANSI 控制符后的纯文本输出。 */
function normalizeOutput(stdout: string, stderr: string): string {
  return `${stdout}\n${stderr}`.replace(ANSI_PATTERN, '')
}

/** 从文本中读取 key: value 形式的字段。 */
function readField(output: string, key: string): string | null {
  const matched = new RegExp(`^\\s*${key}\\s*[:=]\\s*(\\S+)\\s*$`, 'm').exec(output)
  return matched?.[1] ?? null
}

/** 判断输出是否命中任一标记；标记全部来自 CLI 自身的固定文案。 */
function matchesAny(output: string, markers: readonly string[]): boolean {
  return markers.some((marker) => output.includes(marker))
}

/** 判定为「仍在等待授权」的标记。 */
const PENDING_MARKERS = ['authorization_pending', '登录尚未完成', '等待登录超时', '请重试']
/** 判定为「授权被拒绝」的标记。 */
const DENIED_MARKERS = ['登录已被拒绝', 'login denied']
/** 判定为「登录态或设备码已失效」的标记。 */
const EXPIRED_MARKERS = ['登录已过期', '设备码已过期', '请重新登录', '请重新在 cli 发起登录']
/** 判定为「登录已成功」的标记。 */
const SUCCESS_MARKERS = ['OAuth 登录成功', '已复用当前本地 OAuth 登录态']
/** 判定为「本次调用复用了既有登录态」的标记。 */
const REUSED_MARKERS = ['已复用']
/** 判定为「本地登录态已清除」的标记。 */
const LOGOUT_MARKERS = ['已清除本地登录态']
/** 判定为「未登录」的标记；用于额度查询失败时的分类。 */
const LOGGED_OUT_MARKERS = ['未登录', '请重新登录', '登录已过期', '登录尚未完成', '请重新在 cli 发起登录']

/** 生产默认执行器：spawn CLI 并在超时后终止子进程。 */
const defaultRunCli: DreaminaCliRun = async (args, cliPath, timeoutMs) => {
  const { spawn } = await import('node:child_process')
  return await new Promise<DreaminaCliRunResult>((resolve) => {
    let settled = false
    let stdout = ''
    let stderr = ''
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (result: DreaminaCliRunResult): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      resolve(result)
    }
    const child = spawn(cliPath, [...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* 进程已退出时忽略 */ }
      finish({ exitCode: 1, stdout, stderr, failureCode: 'timeout' })
    }, timeoutMs)
    child.stdout?.on('data', (chunk: Buffer) => { if (stdout.length < OUTPUT_LIMIT) stdout += chunk.toString('utf8') })
    child.stderr?.on('data', (chunk: Buffer) => { if (stderr.length < OUTPUT_LIMIT) stderr += chunk.toString('utf8') })
    child.once('error', () => finish({ exitCode: 1, stdout, stderr, failureCode: 'cliMissing' }))
    child.once('close', (code) => finish({ exitCode: code ?? 1, stdout, stderr }))
  })
}

/** 从 login 输出中读取设备码有效期；缺失或非法时回落到兜底 TTL。 */
function readExpiresInSeconds(output: string): number | null {
  const matched = /^\s*expires_in\s*[:=]\s*(\d+)\s*$/m.exec(output)
  if (!matched) return null
  const seconds = Number(matched[1])
  return Number.isSafeInteger(seconds) && seconds > 0 ? seconds : null
}

/** 管理即梦登录态、设备码流程与窗口级资源回收。 */
export class ImageGenerationDreaminaService {
  private readonly run: DreaminaCliRun
  private readonly timeoutMs: number
  private readonly deviceCodeTtlMs: number
  private readonly now: () => number
  /** owner -> 活动设备码登录；窗口销毁时整体释放。 */
  private readonly activeByOwner = new Map<number, Map<string, ActiveDreaminaLogin>>()
  /** 设备码登录的单调递增序号，保证 requestId 稳定且不泄露 device_code。 */
  private sequence = 0

  constructor(options: ImageGenerationDreaminaServiceOptions = {}) {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const deviceCodeTtlMs = options.deviceCodeTtlMs ?? DEFAULT_DEVICE_CODE_TTL_MS
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS
      || !Number.isSafeInteger(deviceCodeTtlMs) || deviceCodeTtlMs <= 0 || deviceCodeTtlMs > MAX_TIMEOUT_MS) {
      throw new Error('IMAGE_GENERATION_CONFIG_INVALID')
    }
    this.run = options.run ?? defaultRunCli
    this.timeoutMs = timeoutMs
    this.deviceCodeTtlMs = deviceCodeTtlMs
    this.now = options.now ?? Date.now
  }

  /** 当前进行中的设备码登录总数，用于生命周期观测。 */
  get activeLoginCount(): number {
    let total = 0
    for (const state of this.activeByOwner.values()) total += state.size
    return total
  }

  /** 查询即梦登录态与剩余额度；查询本身不消耗额度。 */
  async status(value: unknown): Promise<ImageGenerationDreaminaStatus> {
    const input = parseDreaminaCliInput(value)
    const result = await this.run(['user_credit'], input.cliPath ?? 'dreamina', this.timeoutMs)
    if (result.failureCode === 'cliMissing') {
      return parseDreaminaStatus({
        state: 'cliMissing',
        credit: null,
        message: DREAMINA_LOGIN_MESSAGES.statusCliMissing,
      })
    }
    if (result.failureCode === 'timeout') {
      return parseDreaminaStatus({ state: 'unknown', credit: null, message: DREAMINA_LOGIN_MESSAGES.timeout })
    }
    const output = normalizeOutput(result.stdout, result.stderr)
    if (result.exitCode === 0) {
      const credit = ImageGenerationDreaminaService.readCredit(result.stdout)
      /** 退出码为 0 但读不到额度时不猜测，明确回落到未知。 */
      return credit === null
        ? parseDreaminaStatus({ state: 'unknown', credit: null, message: DREAMINA_LOGIN_MESSAGES.statusUnknown })
        : parseDreaminaStatus({ state: 'loggedIn', credit, message: DREAMINA_LOGIN_MESSAGES.statusLoggedIn })
    }
    /** 只有命中明确的失效标记才判定为未登录，其余保持未知。 */
    return matchesAny(output, LOGGED_OUT_MARKERS)
      ? parseDreaminaStatus({ state: 'loggedOut', credit: null, message: DREAMINA_LOGIN_MESSAGES.statusLoggedOut })
      : parseDreaminaStatus({ state: 'unknown', credit: null, message: DREAMINA_LOGIN_MESSAGES.statusUnknown })
  }

  /** 发起设备码登录；已登录且未要求重新登录时直接复用。 */
  async startLogin(ownerId: number, value: unknown): Promise<ImageGenerationDreaminaLoginStartResult> {
    const input = parseDreaminaLoginStartInput(value)
    this.assertOwner(ownerId)
    const cliPath = input.cliPath ?? 'dreamina'
    const args = input.relogin === true ? ['relogin', '--headless'] : ['login', '--headless']
    const result = await this.run(args, cliPath, this.timeoutMs)
    if (result.failureCode === 'cliMissing') {
      return parseDreaminaLoginStartResult({ state: 'failed', message: DREAMINA_LOGIN_MESSAGES.cliMissing })
    }
    if (result.failureCode === 'timeout') {
      return parseDreaminaLoginStartResult({ state: 'failed', message: DREAMINA_LOGIN_MESSAGES.timeout })
    }
    const output = normalizeOutput(result.stdout, result.stderr)
    if (matchesAny(output, REUSED_MARKERS)) {
      return parseDreaminaLoginStartResult({ state: 'reused', message: DREAMINA_LOGIN_MESSAGES.reused })
    }
    const verificationUri = readField(output, 'verification_uri')
    const userCode = readField(output, 'user_code')
    const deviceCode = readField(output, 'device_code')
    /** 三要素缺一不可，缺任何一个都无法让用户完成授权。 */
    if (!verificationUri || !userCode || !deviceCode) {
      return parseDreaminaLoginStartResult({
        state: 'failed',
        message: matchesAny(output, DENIED_MARKERS)
          ? DREAMINA_LOGIN_MESSAGES.denied
          : DREAMINA_LOGIN_MESSAGES.failed,
      })
    }
    const active = this.registerLogin(ownerId, cliPath, deviceCode, readExpiresInSeconds(output))
    return parseDreaminaLoginStartResult({
      state: 'pending',
      requestId: active.requestId,
      verificationUri,
      userCode,
      expiresInSeconds: Math.max(0, Math.round((active.expiresAt - this.now()) / 1000)),
      message: DREAMINA_LOGIN_MESSAGES.pending,
    })
  }

  /** 轮询一次授权结果；未知输出按仍在等待处理，超时才明确失败。 */
  async pollLogin(ownerId: number, value: unknown): Promise<ImageGenerationDreaminaLoginPollResult> {
    const input = parseDreaminaLoginRequestInput(value)
    this.assertOwner(ownerId)
    const active = this.activeByOwner.get(ownerId)?.get(input.requestId)
    if (!active) {
      return parseDreaminaLoginPollResult({
        requestId: input.requestId,
        state: 'failed',
        message: DREAMINA_LOGIN_MESSAGES.requestUnknown,
      })
    }
    /** 设备码到期后不再向上游查询，直接释放并报过期。 */
    if (this.now() >= active.expiresAt) {
      this.dropLogin(ownerId, input.requestId)
      return parseDreaminaLoginPollResult({
        requestId: input.requestId,
        state: 'failed',
        message: DREAMINA_LOGIN_MESSAGES.expired,
      })
    }
    const result = await this.run(
      ['login', 'checklogin', `--device_code=${active.deviceCode}`, `--poll=${CHECK_LOGIN_POLL_SECONDS}`],
      active.cliPath,
      this.timeoutMs,
    )
    if (result.failureCode === 'cliMissing') {
      this.dropLogin(ownerId, input.requestId)
      return parseDreaminaLoginPollResult({
        requestId: input.requestId,
        state: 'failed',
        message: DREAMINA_LOGIN_MESSAGES.cliMissing,
      })
    }
    if (result.failureCode === 'timeout') {
      /** 单次调用超时只是这一次没结论，保留设备码继续等待。 */
      return parseDreaminaLoginPollResult({
        requestId: input.requestId,
        state: 'pending',
        message: DREAMINA_LOGIN_MESSAGES.pending,
      })
    }
    const output = normalizeOutput(result.stdout, result.stderr)
    if (result.exitCode === 0 && matchesAny(output, SUCCESS_MARKERS)) {
      this.dropLogin(ownerId, input.requestId)
      return parseDreaminaLoginPollResult({
        requestId: input.requestId,
        state: 'success',
        message: DREAMINA_LOGIN_MESSAGES.success,
      })
    }
    if (matchesAny(output, DENIED_MARKERS)) {
      this.dropLogin(ownerId, input.requestId)
      return parseDreaminaLoginPollResult({
        requestId: input.requestId,
        state: 'failed',
        message: DREAMINA_LOGIN_MESSAGES.denied,
      })
    }
    if (matchesAny(output, EXPIRED_MARKERS) && !matchesAny(output, PENDING_MARKERS)) {
      this.dropLogin(ownerId, input.requestId)
      return parseDreaminaLoginPollResult({
        requestId: input.requestId,
        state: 'failed',
        message: DREAMINA_LOGIN_MESSAGES.expired,
      })
    }
    /** 仍在等待授权或输出无法识别，都保持 pending 让界面继续刷新。 */
    return parseDreaminaLoginPollResult({
      requestId: input.requestId,
      state: 'pending',
      message: DREAMINA_LOGIN_MESSAGES.pending,
    })
  }

  /** 幂等取消一次设备码登录；device_code 随之丢弃。 */
  cancelLogin(ownerId: number, value: unknown): void {
    const input = parseDreaminaLoginRequestInput(value)
    this.dropLogin(ownerId, input.requestId)
  }

  /** 窗口销毁或撤权时释放该窗口的全部设备码登录。 */
  releaseOwner(ownerId: number): void {
    this.activeByOwner.delete(ownerId)
  }

  /** 进程退出前释放全部设备码登录。 */
  dispose(): void {
    this.activeByOwner.clear()
  }

  /** 清除本地登录态；不影响已保存的任务与配置。 */
  async logout(value: unknown): Promise<ImageGenerationDreaminaLogoutResult> {
    const input = parseDreaminaCliInput(value)
    const result = await this.run(['logout'], input.cliPath ?? 'dreamina', this.timeoutMs)
    if (result.failureCode !== undefined) {
      return parseDreaminaLogoutResult({ state: 'failed', message: DREAMINA_LOGIN_MESSAGES.logoutFailed })
    }
    const output = normalizeOutput(result.stdout, result.stderr)
    /** 退出码为 0 即视为已清除；CLI 文案变化时仍以退出码为准。 */
    return result.exitCode === 0 || matchesAny(output, LOGOUT_MARKERS)
      ? parseDreaminaLogoutResult({ state: 'loggedOut', message: DREAMINA_LOGIN_MESSAGES.logoutSucceeded })
      : parseDreaminaLogoutResult({ state: 'failed', message: DREAMINA_LOGIN_MESSAGES.logoutFailed })
  }

  /** 从 user_credit 的 JSON 输出中读取剩余额度。 */
  private static readCredit(stdout: string): number | null {
    const matched = /\{[\s\S]*\}/.exec(stdout)
    if (!matched) return null
    try {
      const parsed: unknown = JSON.parse(matched[0])
      if (parsed === null || typeof parsed !== 'object') return null
      const credit = (parsed as { total_credit?: unknown }).total_credit
      return typeof credit === 'number' && Number.isSafeInteger(credit) && credit >= 0 ? credit : null
    } catch {
      return null
    }
  }

  /** 校验 owner 身份，阻止非法 IPC 参数建立状态。 */
  private assertOwner(ownerId: number): void {
    if (!Number.isSafeInteger(ownerId) || ownerId < 0) throw new Error('IMAGE_GENERATION_CONFIG_INVALID')
  }

  /** 登记一次设备码登录；超出窗口上限时先释放最早的一条。 */
  private registerLogin(
    ownerId: number,
    cliPath: string,
    deviceCode: string,
    expiresInSeconds: number | null,
  ): ActiveDreaminaLogin {
    const state = this.activeByOwner.get(ownerId) ?? new Map<string, ActiveDreaminaLogin>()
    if (state.size >= MAX_ACTIVE_LOGINS_PER_OWNER) {
      const oldest = [...state.values()][0]
      if (oldest) state.delete(oldest.requestId)
    }
    this.sequence += 1
    /** 设备码有效期不得突破兜底 TTL，避免异常上游签发超长设备码。 */
    const ttlMs = expiresInSeconds === null
      ? this.deviceCodeTtlMs
      : Math.min(expiresInSeconds * 1000, this.deviceCodeTtlMs)
    const active: ActiveDreaminaLogin = {
      requestId: `dreamina-${this.now().toString(36)}-${this.sequence.toString(36)}`,
      cliPath,
      deviceCode,
      expiresAt: this.now() + Math.max(ttlMs, 1_000),
    }
    state.set(active.requestId, active)
    this.activeByOwner.set(ownerId, state)
    return active
  }

  /** 幂等移除一次设备码登录。 */
  private dropLogin(ownerId: number, requestId: string): void {
    const state = this.activeByOwner.get(ownerId)
    if (!state) return
    state.delete(requestId)
    if (state.size === 0) this.activeByOwner.delete(ownerId)
  }
}
