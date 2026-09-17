import { createHash } from 'node:crypto'
import type {
  AudioGenerationProfile,
  AudioGenerationProvider,
  AudioGenerationPublicCatalog,
  AudioGenerationPublicProfile,
  AudioGenerationTestResult,
} from '@proma/shared'
import {
  AUDIO_GENERATION_TEST_MESSAGES,
  parseAudioGenerationProfile,
  parseAudioGenerationTestInput,
  parseAudioGenerationTestResult,
} from '@proma/shared'

/** 测试器唯一可见的主进程输入；明文凭据不得离开当前调用链。 */
export interface AudioGenerationResolvedTestInput {
  /** 已去除公开摘要字段并重新严格解析的配置。 */
  profile: AudioGenerationProfile
  /** 草稿传入或从系统安全存储按需解密的当前凭据。 */
  apiKey: string
}

/** 单个供应商测试 adapter 的最小合同。 */
export interface AudioGenerationProviderTester {
  /** 执行供应商测试；真实 adapter 必须响应 AbortSignal，结果仍由服务严格复验。 */
  test(
    resolvedInput: AudioGenerationResolvedTestInput,
    signal: AbortSignal,
  ): Promise<Omit<AudioGenerationTestResult, 'requestId'>>
}

/** 测试服务读取配置与按需解密所需的最小 Store 合同。 */
export interface AudioGenerationTestStore {
  /** 读取不含凭据的权威公开目录。 */
  readPublic(): AudioGenerationPublicCatalog
  /** 仅解密目标配置的 API Key。 */
  resolveApiKey(profileId: string): string
}

/** 测试服务可注入依赖。 */
export interface AudioGenerationTestServiceOptions {
  /** 独立音频配置 Store。 */
  store: AudioGenerationTestStore
  /** 按供应商覆盖默认不可用 adapter，供后续真实合同和测试注入。 */
  testers?: Partial<Record<AudioGenerationProvider, AudioGenerationProviderTester>>
  /** 单次测试 deadline；生产默认 15 秒，测试可注入更短正整数。 */
  timeoutMs?: number
}

/** 单个活动测试持有的最小生命周期状态，不保存 Profile 或 API Key。 */
interface ActiveTest {
  /** 活动测试所属窗口身份。 */
  ownerId: number
  /** 服务绑定且不可由 adapter 改写的请求身份。 */
  requestId: string
  /** 不包含秘密的稳定配置身份。 */
  identity: string
  /** 通知支持 AbortSignal 的 tester 停止底层工作。 */
  controller: AbortController
  /** 让忽略 AbortSignal 的 tester 也能立即向调用方返回终态。 */
  resolveInterruption: (result: AudioGenerationTestResult) => void
  /** 当前由用户取消或 deadline 触发的终止原因。 */
  interruption: 'cancelled' | 'timeout' | null
  /** 服务级 deadline timer，所有终态统一清理。 */
  timer: ReturnType<typeof setTimeout> | null
  /** 标记两个索引和全局计数是否仍持有该活动测试。 */
  registered: boolean
}

/** 单个 owner 的 O(1) request 与配置身份双索引。 */
interface OwnerActiveTests {
  /** 按公开 requestId 定位显式取消目标。 */
  byRequestId: Map<string, ActiveTest>
  /** 按不含秘密的身份定位替换目标。 */
  byIdentity: Map<string, ActiveTest>
}

/** 生产单次连接测试 deadline。 */
const DEFAULT_TEST_TIMEOUT_MS = 15_000
/** Node timer 不发生溢出的最大毫秒值。 */
const MAX_TEST_TIMEOUT_MS = 2_147_483_647
/** 单个设置窗口允许并发的连接测试上限。 */
const MAX_ACTIVE_TESTS_PER_OWNER = 16
/** 当前主进程允许并发的连接测试总上限。 */
const MAX_ACTIVE_TESTS_GLOBAL = 64

/** 首批供应商在缺少已验证官方测试合同时仅返回固定不可用结果。 */
const DEFAULT_TESTERS: Record<AudioGenerationProvider, AudioGenerationProviderTester> = {
  xiaomi: {
    test: async () => ({
      state: 'unavailable',
      message: AUDIO_GENERATION_TEST_MESSAGES.unavailable.xiaomi,
    }),
  },
  minimax: {
    test: async () => ({
      state: 'unavailable',
      message: AUDIO_GENERATION_TEST_MESSAGES.unavailable.minimax,
    }),
  },
}

/** 构造并严格校验唯一允许公开的失败结果。 */
function failedResult(requestId: string): AudioGenerationTestResult {
  return parseAudioGenerationTestResult({
    requestId,
    state: 'failed',
    message: AUDIO_GENERATION_TEST_MESSAGES.failed,
  })
}

/** 构造并严格校验唯一允许公开的取消结果。 */
function cancelledResult(requestId: string): AudioGenerationTestResult {
  return parseAudioGenerationTestResult({
    requestId,
    state: 'cancelled',
    message: AUDIO_GENERATION_TEST_MESSAGES.cancelled,
  })
}

/** 严格约束不可信 adapter 的运行时结果，并由服务绑定原始请求身份。 */
function parseProviderTesterResult(
  provider: AudioGenerationProvider,
  requestId: string,
  value: unknown,
): AudioGenerationTestResult {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('AUDIO_GENERATION_CONFIG_INVALID')
  }
  /** 包含不可枚举键与 Symbol 的完整自有键集合，避免额外字段旁路。 */
  const keys = Reflect.ownKeys(value)
  if (keys.length !== 2 || !keys.includes('state') || !keys.includes('message')) {
    throw new Error('AUDIO_GENERATION_CONFIG_INVALID')
  }
  /** 只读取已验证存在的受控字段，adapter 无法覆盖 requestId。 */
  const result = value as { state: unknown; message: unknown }
  /** Shared 严格 parser 校验状态与受控消息集合。 */
  const parsed = parseAudioGenerationTestResult({
    requestId,
    state: result.state,
    message: result.message,
  })
  if (parsed.state === 'unavailable'
    && parsed.message !== AUDIO_GENERATION_TEST_MESSAGES.unavailable[provider]) {
    throw new Error('AUDIO_GENERATION_CONFIG_INVALID')
  }
  return parsed
}

/** 从公开投影显式挑选持久化字段，阻止摘要或未来字段进入 tester。 */
function rebuildStrictProfile(source: AudioGenerationPublicProfile): AudioGenerationProfile {
  /** 两个供应商共享的严格 Profile 字段。 */
  const common = {
    id: source.id,
    name: source.name,
    baseUrl: source.baseUrl,
    models: source.models,
    enabled: source.enabled,
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
    ...(source.legacyMediaProfileId === undefined
      ? {}
      : { legacyMediaProfileId: source.legacyMediaProfileId }),
  }
  if (source.provider === 'xiaomi') {
    return parseAudioGenerationProfile({ ...common, provider: 'xiaomi' })
  }
  if (source.provider === 'minimax') {
    return parseAudioGenerationProfile({
      ...common,
      provider: 'minimax',
      ...(source.groupId === undefined ? {} : { groupId: source.groupId }),
    })
  }
  throw new Error('AUDIO_GENERATION_CONFIG_INVALID')
}

/** 生成不含凭据的草稿身份，避免 Key 出现在 Map key 或调试字符串。 */
function draftIdentity(profile: AudioGenerationProfile): string {
  return `draft:${createHash('sha256').update(JSON.stringify(profile)).digest('hex')}`
}

/** 管理按窗口隔离、可抢占且对外完全脱敏的供应商连接测试。 */
export class AudioGenerationTestService {
  /** 配置与凭据的权威来源。 */
  private readonly store: AudioGenerationTestStore
  /** 两个供应商的完整 adapter 映射。 */
  private readonly testers: Record<AudioGenerationProvider, AudioGenerationProviderTester>
  /** 单次测试的服务级 deadline。 */
  private readonly timeoutMs: number
  /** owner -> 双索引活动状态；记录中不保存凭据或完整配置。 */
  private readonly activeByOwner = new Map<number, OwnerActiveTests>()
  /** 当前两个索引共同代表的唯一活动测试总数。 */
  private totalActiveTests = 0

  /** 创建测试服务并用调用方 adapter 覆盖默认不可用实现。 */
  constructor(options: AudioGenerationTestServiceOptions) {
    /** 调用方注入值必须同时满足 JS 安全整数与 Node timer 范围。 */
    const timeoutMs = options.timeoutMs ?? DEFAULT_TEST_TIMEOUT_MS
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TEST_TIMEOUT_MS) {
      throw new Error('AUDIO_GENERATION_CONFIG_INVALID')
    }
    this.store = options.store
    this.testers = { ...DEFAULT_TESTERS, ...options.testers }
    this.timeoutMs = timeoutMs
  }

  /** 返回当前活动测试总数，用于生命周期观测与资源诊断。 */
  get activeTestCount(): number {
    return this.totalActiveTests
  }

  /** 严格解析输入、解析单个凭据并执行可及时取消的供应商测试。 */
  async test(ownerId: number, value: unknown): Promise<AudioGenerationTestResult> {
    /** Shared parser 先于 Store 和 tester 执行，非法 envelope 不产生副作用。 */
    const input = parseAudioGenerationTestInput(value)
    if (!Number.isSafeInteger(ownerId) || ownerId < 0) {
      throw new Error('AUDIO_GENERATION_CONFIG_INVALID')
    }
    /** saved 以稳定 ID 标识；draft 只散列不含秘密的严格 Profile。 */
    const identity = input.kind === 'saved'
      ? `saved:${input.profileId}`
      : draftIdentity(input.profile)
    this.cancelReplaced(ownerId, input.requestId, identity)
    /** 上限判断先于 Store 和 tester，溢出请求不读取凭据也不登记状态。 */
    const ownerActiveCount = this.activeByOwner.get(ownerId)?.byRequestId.size ?? 0
    if (ownerActiveCount >= MAX_ACTIVE_TESTS_PER_OWNER
      || this.totalActiveTests >= MAX_ACTIVE_TESTS_GLOBAL) {
      return failedResult(input.requestId)
    }

    /** 当前调用栈内短暂存在的严格 Profile 与明文 Key。 */
    let resolvedInput: AudioGenerationResolvedTestInput
    try {
      if (input.kind === 'draft') {
        resolvedInput = { profile: input.profile, apiKey: input.apiKey }
      } else {
        /** 公开目录只用于定位配置，未知公开字段不会传入 tester。 */
        const publicProfile = this.store.readPublic().profiles.find(profile => profile.id === input.profileId)
        if (!publicProfile) return failedResult(input.requestId)
        /** 从公开投影重建并复验的严格配置。 */
        const strictProfile = rebuildStrictProfile(publicProfile)
        /** 复用 draft parser 校验 Store 解密结果，避免建立第二套 Key 合同。 */
        const credentialInput = parseAudioGenerationTestInput({
          kind: 'draft',
          requestId: input.requestId,
          profile: strictProfile,
          apiKey: this.store.resolveApiKey(input.profileId),
        })
        if (credentialInput.kind !== 'draft') throw new Error('AUDIO_GENERATION_CONFIG_INVALID')
        resolvedInput = { profile: strictProfile, apiKey: credentialInput.apiKey }
      }
    } catch {
      return failedResult(input.requestId)
    }

    /** 本次底层测试的取消控制器。 */
    const controller = new AbortController()
    /** 由取消或 deadline 独立完成的 Promise，不依赖 tester 响应 signal。 */
    let resolveInterruption!: (result: AudioGenerationTestResult) => void
    const interruption = new Promise<AudioGenerationTestResult>((resolve) => {
      resolveInterruption = resolve
    })
    /** 注册表只保存生命周期状态，不保存 resolvedInput。 */
    const active: ActiveTest = {
      ownerId,
      requestId: input.requestId,
      identity,
      controller,
      resolveInterruption,
      interruption: null,
      timer: null,
      registered: false,
    }
    this.registerActive(active)
    active.timer = setTimeout(() => this.timeoutActive(active), this.timeoutMs)

    /** 底层 Promise 始终挂接 catch，保证取消后迟到 reject 不成为未处理异常。 */
    const execution = (async (): Promise<AudioGenerationTestResult> => {
      if (active.interruption === 'cancelled') return cancelledResult(input.requestId)
      if (active.interruption === 'timeout') return failedResult(input.requestId)
      /** 供应商 adapter 只在当前异步调用链取得明文凭据。 */
      const testerResult = await this.testers[resolvedInput.profile.provider].test(
        resolvedInput,
        controller.signal,
      )
      if (active.interruption === 'cancelled') return cancelledResult(input.requestId)
      if (active.interruption === 'timeout') return failedResult(input.requestId)
      return parseProviderTesterResult(resolvedInput.profile.provider, input.requestId, testerResult)
    })().catch(() => active.interruption === 'cancelled'
      ? cancelledResult(input.requestId)
      : failedResult(input.requestId)).finally(() => this.unregisterActive(active))

    try {
      /** 任一显式生命周期取消都可先于忽略 signal 的 tester 收口。 */
      return await Promise.race([execution, interruption])
    } finally {
      /** 迟到旧请求只会尝试注销自身，引用校验保护后来注册的新请求。 */
      this.unregisterActive(active)
    }
  }

  /** 幂等取消 owner 下指定 requestId。 */
  cancel(ownerId: number, requestId: string): void {
    const active = this.activeByOwner.get(ownerId)?.byRequestId.get(requestId)
    if (active) this.cancelActive(active)
  }

  /** 幂等释放 owner 的全部测试，供窗口销毁时统一清理。 */
  releaseOwner(ownerId: number): void {
    const state = this.activeByOwner.get(ownerId)
    if (!state) return
    for (const active of [...state.byRequestId.values()]) this.cancelActive(active)
  }

  /** 幂等取消所有 owner 的活动测试。 */
  dispose(): void {
    for (const ownerId of [...this.activeByOwner.keys()]) this.releaseOwner(ownerId)
  }

  /** 新请求开始前取消同 requestId 或同配置身份的旧请求。 */
  private cancelReplaced(ownerId: number, requestId: string, identity: string): void {
    const state = this.activeByOwner.get(ownerId)
    if (!state) return
    /** request 与 identity 可能指向不同测试，Set 负责安全去重。 */
    const replaced = new Set<ActiveTest>()
    const requestMatch = state.byRequestId.get(requestId)
    const identityMatch = state.byIdentity.get(identity)
    if (requestMatch) replaced.add(requestMatch)
    if (identityMatch) replaced.add(identityMatch)
    for (const active of replaced) this.cancelActive(active)
  }

  /** 把活动测试同时写入 owner 双索引并推进全局计数。 */
  private registerActive(active: ActiveTest): void {
    /** 当前 owner 不存在时创建共享的双索引容器。 */
    const state = this.activeByOwner.get(active.ownerId) ?? {
      byRequestId: new Map<string, ActiveTest>(),
      byIdentity: new Map<string, ActiveTest>(),
    }
    state.byRequestId.set(active.requestId, active)
    state.byIdentity.set(active.identity, active)
    this.activeByOwner.set(active.ownerId, state)
    active.registered = true
    this.totalActiveTests += 1
  }

  /** 引用一致时同步摘除两个索引、全局计数和 deadline timer。 */
  private unregisterActive(active: ActiveTest): void {
    if (active.timer !== null) {
      clearTimeout(active.timer)
      active.timer = null
    }
    if (!active.registered) return
    active.registered = false
    /** 旧 completion 不得删除相同 requestId 或 identity 的新活动测试。 */
    const state = this.activeByOwner.get(active.ownerId)
    if (state?.byRequestId.get(active.requestId) === active) {
      state.byRequestId.delete(active.requestId)
    }
    if (state?.byIdentity.get(active.identity) === active) {
      state.byIdentity.delete(active.identity)
    }
    if (state && state.byRequestId.size === 0 && state.byIdentity.size === 0) {
      this.activeByOwner.delete(active.ownerId)
    }
    this.totalActiveTests -= 1
  }

  /** 同时完成及时取消结果并通知支持 AbortSignal 的 tester。 */
  private cancelActive(active: ActiveTest): void {
    if (active.interruption !== null) return
    active.interruption = 'cancelled'
    try {
      active.controller.abort()
    } catch {
      // 异常 abort listener 不得阻断索引清理和固定取消结果。
    }
    this.unregisterActive(active)
    active.resolveInterruption(cancelledResult(active.requestId))
  }

  /** deadline 到达后释放索引、终止 adapter 并返回固定失败。 */
  private timeoutActive(active: ActiveTest): void {
    if (active.interruption !== null || !active.registered) return
    active.interruption = 'timeout'
    try {
      active.controller.abort()
    } catch {
      // 异常 abort listener 不得阻断 deadline 的资源清理和固定失败结果。
    }
    this.unregisterActive(active)
    active.resolveInterruption(failedResult(active.requestId))
  }
}
