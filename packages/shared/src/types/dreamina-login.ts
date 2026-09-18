/**
 * 即梦 CLI OAuth 设备码登录的公开合同。
 *
 * 即梦只有本地 CLI，登录态由 CLI 自己保存；主进程负责 spawn 与解析，
 * 跨 IPC 只暴露设备码受理结果、固定中文文案与剩余额度，
 * device_code 始终留在主进程内存里，Renderer 只能通过 requestId 轮询。
 */

/** 即梦登录态；unknown 表示查询失败，界面必须提示而不是假设未登录。 */
export type ImageGenerationDreaminaLoginState = 'loggedIn' | 'loggedOut' | 'cliMissing' | 'unknown'

/** 即梦账号状态；已登录时同时给出可用额度。 */
export interface ImageGenerationDreaminaStatus {
  state: ImageGenerationDreaminaLoginState
  /** 已登录时的剩余额度；其它状态为 null，避免用假数字冒充。 */
  credit: number | null
  /** 固定中文提示，不携带 CLI 原始输出、路径或命令。 */
  message: string
}

/** 发起登录：复用现有登录态、给出设备码材料，或直接失败。 */
export type ImageGenerationDreaminaLoginStartResult =
  | { state: 'reused'; message: string }
  | {
    state: 'pending'
    /** 主进程为本次设备码流程签发的身份，Renderer 只能用它轮询。 */
    requestId: string
    /** 用户在浏览器打开的授权地址。 */
    verificationUri: string
    /** 用户需要在授权页核对并输入的设备码。 */
    userCode: string
    /** 设备码有效期（秒）；CLI 未给出时为 null。 */
    expiresInSeconds: number | null
    message: string
  }
  | { state: 'failed'; message: string }

/** 单次轮询的结果；pending 表示仍在等待用户在浏览器完成授权。 */
export interface ImageGenerationDreaminaLoginPollResult {
  requestId: string
  state: 'pending' | 'success' | 'failed'
  message: string
}

/** 退出登录的结果。 */
export interface ImageGenerationDreaminaLogoutResult {
  state: 'loggedOut' | 'failed'
  message: string
}

/** 查询状态与退出登录共用的输入，只允许可选 CLI 路径。 */
export interface DreaminaCliInput {
  cliPath?: string
}

/** 发起登录的输入；relogin 表示先清除本地登录态再走完整设备码流程。 */
export interface DreaminaLoginStartInput {
  cliPath?: string
  relogin?: boolean
}

/** 轮询或取消设备码流程的输入；device_code 不出现在 Renderer 侧。 */
export interface DreaminaLoginRequestInput {
  requestId: string
}

/**
 * 唯一允许公开的固定中文文案。
 * 界面只渲染这些字符串，CLI 原始输出一律不穿过 IPC。
 */
export const DREAMINA_LOGIN_MESSAGES = {
  reused: '已复用当前即梦登录态',
  pending: '请在浏览器完成授权，本页会自动刷新登录状态',
  success: '即梦登录成功',
  failed: '即梦登录失败，请重新发起',
  cancelled: '已取消即梦登录',
  timeout: '等待授权超时，请重新发起登录',
  denied: '即梦登录已被拒绝，请重新发起',
  expired: '设备码已过期，请重新发起登录',
  cliMissing: '未找到即梦 CLI，请检查安装或 cliPath 配置',
  statusLoggedOut: '未登录，请先登录即梦',
  statusCliMissing: '未找到即梦 CLI，无法查询登录态',
  statusUnknown: '即梦登录态查询失败，请稍后重试',
  statusLoggedIn: '即梦已登录',
  logoutSucceeded: '已退出即梦登录',
  logoutFailed: '退出即梦登录失败，请重试',
  requestUnknown: '登录会话已失效，请重新发起登录',
} as const

/** CLI 路径与文本字段长度上限，沿用生图配置的同类限制。 */
const DREAMINA_TEXT_MAX_LENGTH = 2_048
/** 设备码与 user_code 的长度上限。 */
const DREAMINA_CODE_MAX_LENGTH = 256
/** 设备码有效期上限：24 小时，超过视为上游异常。 */
const DREAMINA_EXPIRES_MAX_SECONDS = 86_400

/** 判断未知值是否为可枚举的普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** 判断对象仅包含调用方声明的字段。 */
function hasOnlyKeys(value: Record<string, unknown>, allowedKeys: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowedKeys.includes(key))
}

/** 解析必填文本：去除首尾空白并拒绝空值、非法类型与超长内容。 */
function parseRequiredText(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') throw new Error('IMAGE_GENERATION_CONFIG_INVALID')
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > maxLength) throw new Error('IMAGE_GENERATION_CONFIG_INVALID')
  return trimmed
}

/** 解析可选文本：缺省与非字符串之外的空值都归一化为 undefined。 */
function parseOptionalText(value: unknown, maxLength: number): string | undefined {
  if (value === undefined) return undefined
  return parseRequiredText(value, maxLength)
}

/** 判断未知数字是非负安全整数。 */
function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/** 解析可选 CLI 路径输入，拒绝额外字段。 */
export function parseDreaminaCliInput(value: unknown): DreaminaCliInput {
  if (!isRecord(value) || !hasOnlyKeys(value, ['cliPath'])) {
    throw new Error('IMAGE_GENERATION_CONFIG_INVALID')
  }
  const cliPath = parseOptionalText(value.cliPath, DREAMINA_TEXT_MAX_LENGTH)
  return cliPath === undefined ? {} : { cliPath }
}

/** 解析发起登录输入，拒绝额外字段。 */
export function parseDreaminaLoginStartInput(value: unknown): DreaminaLoginStartInput {
  if (!isRecord(value) || !hasOnlyKeys(value, ['cliPath', 'relogin'])
    || (value.relogin !== undefined && typeof value.relogin !== 'boolean')) {
    throw new Error('IMAGE_GENERATION_CONFIG_INVALID')
  }
  const cliPath = parseOptionalText(value.cliPath, DREAMINA_TEXT_MAX_LENGTH)
  return {
    ...(cliPath === undefined ? {} : { cliPath }),
    ...(value.relogin === undefined ? {} : { relogin: value.relogin }),
  }
}

/** 解析轮询或取消输入，拒绝额外字段。 */
export function parseDreaminaLoginRequestInput(value: unknown): DreaminaLoginRequestInput {
  if (!isRecord(value) || !hasOnlyKeys(value, ['requestId'])) {
    throw new Error('IMAGE_GENERATION_CONFIG_INVALID')
  }
  return { requestId: parseRequiredText(value.requestId, DREAMINA_CODE_MAX_LENGTH) }
}

/** 构造并严格校验账号状态；未登录、CLI 缺失与查询失败必须使用各自的固定文案。 */
export function parseDreaminaStatus(value: unknown): ImageGenerationDreaminaStatus {
  if (!isRecord(value) || !hasOnlyKeys(value, ['state', 'credit', 'message'])) {
    throw new Error('IMAGE_GENERATION_CONFIG_INVALID')
  }
  const state = value.state
  if (state !== 'loggedIn' && state !== 'loggedOut' && state !== 'cliMissing' && state !== 'unknown') {
    throw new Error('IMAGE_GENERATION_CONFIG_INVALID')
  }
  const message = parseRequiredText(value.message, DREAMINA_TEXT_MAX_LENGTH)
  /** 只有已登录状态允许携带额度，且必须是合法的非负整数。 */
  if (state === 'loggedIn') {
    if (!isNonNegativeSafeInteger(value.credit)) {
      throw new Error('IMAGE_GENERATION_CONFIG_INVALID')
    }
    if (message !== DREAMINA_LOGIN_MESSAGES.statusLoggedIn) throw new Error('IMAGE_GENERATION_CONFIG_INVALID')
    return { state, credit: value.credit, message }
  }
  if (value.credit !== null) throw new Error('IMAGE_GENERATION_CONFIG_INVALID')
  const allowedMessages: readonly string[] = state === 'loggedOut'
    ? [DREAMINA_LOGIN_MESSAGES.statusLoggedOut]
    : state === 'cliMissing'
      ? [DREAMINA_LOGIN_MESSAGES.statusCliMissing, DREAMINA_LOGIN_MESSAGES.cliMissing]
      : [DREAMINA_LOGIN_MESSAGES.statusUnknown, DREAMINA_LOGIN_MESSAGES.timeout]
  if (!allowedMessages.includes(message)) throw new Error('IMAGE_GENERATION_CONFIG_INVALID')
  return { state, credit: null, message }
}

/** 校验授权地址必须是 http(s) 绝对地址。 */
function parseVerificationUri(value: unknown): string {
  const uri = parseRequiredText(value, DREAMINA_TEXT_MAX_LENGTH)
  if (!/^https?:\/\/[^\s]+$/i.test(uri)) throw new Error('IMAGE_GENERATION_CONFIG_INVALID')
  return uri
}

/** 发起登录允许公开的失败文案。 */
const FAILED_START_MESSAGES: readonly string[] = [
  DREAMINA_LOGIN_MESSAGES.failed,
  DREAMINA_LOGIN_MESSAGES.cliMissing,
  DREAMINA_LOGIN_MESSAGES.timeout,
  DREAMINA_LOGIN_MESSAGES.denied,
]

/** 构造并严格校验发起登录结果。 */
export function parseDreaminaLoginStartResult(value: unknown): ImageGenerationDreaminaLoginStartResult {
  if (!isRecord(value)) throw new Error('IMAGE_GENERATION_CONFIG_INVALID')
  const state = value.state
  if (state === 'reused') {
    if (!hasOnlyKeys(value, ['state', 'message']) || value.message !== DREAMINA_LOGIN_MESSAGES.reused) {
      throw new Error('IMAGE_GENERATION_CONFIG_INVALID')
    }
    return { state, message: DREAMINA_LOGIN_MESSAGES.reused }
  }
  if (state === 'pending') {
    if (!hasOnlyKeys(value, ['state', 'requestId', 'verificationUri', 'userCode', 'expiresInSeconds', 'message'])) {
      throw new Error('IMAGE_GENERATION_CONFIG_INVALID')
    }
    if (value.expiresInSeconds !== null
      && (!isNonNegativeSafeInteger(value.expiresInSeconds) || value.expiresInSeconds > DREAMINA_EXPIRES_MAX_SECONDS)) {
      throw new Error('IMAGE_GENERATION_CONFIG_INVALID')
    }
    return {
      state,
      requestId: parseRequiredText(value.requestId, DREAMINA_CODE_MAX_LENGTH),
      verificationUri: parseVerificationUri(value.verificationUri),
      userCode: parseRequiredText(value.userCode, DREAMINA_CODE_MAX_LENGTH),
      expiresInSeconds: value.expiresInSeconds,
      message: DREAMINA_LOGIN_MESSAGES.pending,
    }
  }
  if (state !== 'failed' || !hasOnlyKeys(value, ['state', 'message'])) {
    throw new Error('IMAGE_GENERATION_CONFIG_INVALID')
  }
  const message = parseRequiredText(value.message, DREAMINA_TEXT_MAX_LENGTH)
  if (!FAILED_START_MESSAGES.includes(message)) throw new Error('IMAGE_GENERATION_CONFIG_INVALID')
  return { state, message }
}

/** 构造并严格校验轮询结果。 */
export function parseDreaminaLoginPollResult(value: unknown): ImageGenerationDreaminaLoginPollResult {
  if (!isRecord(value) || !hasOnlyKeys(value, ['requestId', 'state', 'message'])) {
    throw new Error('IMAGE_GENERATION_CONFIG_INVALID')
  }
  const state = value.state
  if (state !== 'pending' && state !== 'success' && state !== 'failed') {
    throw new Error('IMAGE_GENERATION_CONFIG_INVALID')
  }
  const message = parseRequiredText(value.message, DREAMINA_TEXT_MAX_LENGTH)
  const allowedMessages: readonly string[] = state === 'pending'
    ? [DREAMINA_LOGIN_MESSAGES.pending, DREAMINA_LOGIN_MESSAGES.requestUnknown]
    : state === 'success'
      ? [DREAMINA_LOGIN_MESSAGES.success, DREAMINA_LOGIN_MESSAGES.reused]
      : [
          DREAMINA_LOGIN_MESSAGES.failed,
          DREAMINA_LOGIN_MESSAGES.cancelled,
          DREAMINA_LOGIN_MESSAGES.timeout,
          DREAMINA_LOGIN_MESSAGES.denied,
          DREAMINA_LOGIN_MESSAGES.expired,
          DREAMINA_LOGIN_MESSAGES.cliMissing,
          DREAMINA_LOGIN_MESSAGES.requestUnknown,
        ]
  if (!allowedMessages.includes(message)) throw new Error('IMAGE_GENERATION_CONFIG_INVALID')
  return { requestId: parseRequiredText(value.requestId, DREAMINA_CODE_MAX_LENGTH), state, message }
}

/** 构造并严格校验退出登录结果。 */
export function parseDreaminaLogoutResult(value: unknown): ImageGenerationDreaminaLogoutResult {
  if (!isRecord(value) || !hasOnlyKeys(value, ['state', 'message'])) {
    throw new Error('IMAGE_GENERATION_CONFIG_INVALID')
  }
  const state = value.state
  if (state === 'loggedOut') {
    if (value.message !== DREAMINA_LOGIN_MESSAGES.logoutSucceeded) throw new Error('IMAGE_GENERATION_CONFIG_INVALID')
    return { state, message: DREAMINA_LOGIN_MESSAGES.logoutSucceeded }
  }
  if (state !== 'failed' || value.message !== DREAMINA_LOGIN_MESSAGES.logoutFailed) {
    throw new Error('IMAGE_GENERATION_CONFIG_INVALID')
  }
  return { state, message: DREAMINA_LOGIN_MESSAGES.logoutFailed }
}
