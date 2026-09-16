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
  /** 执行供应商测试；结果仍会由服务交给 Shared parser 复验。 */
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
}

/** 单个活动测试持有的最小生命周期状态，不保存 Profile 或 API Key。 */
interface ActiveTest {
  /** 不包含秘密的稳定配置身份。 */
  identity: string
  /** 通知支持 AbortSignal 的 tester 停止底层工作。 */
  controller: AbortController
  /** 让忽略 AbortSignal 的 tester 也能立即向调用方返回取消。 */
  resolveCancellation: (result: AudioGenerationTestResult) => void
  /** 防止重复取消重复触发生命周期副作用。 */
  cancelled: boolean
}

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

/** 从公开投影显式挑选持久化字段，阻止摘要或未来字段进入 tester。 */
function rebuildStrictProfile(source: AudioGenerationPublicProfile): AudioGenerationProfile {
  /** 两个供应商共享的严格 Profile 字段。 */
  const common = {
    id: source.id,
    name: source.name,
    baseUrl: source.baseUrl,
    modelId: source.modelId,
    voiceId: source.voiceId,
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
  /** owner -> requestId -> 活动测试；记录中不保存凭据或完整配置。 */
  private readonly activeByOwner = new Map<number, Map<string, ActiveTest>>()

  /** 创建测试服务并用调用方 adapter 覆盖默认不可用实现。 */
  constructor(options: AudioGenerationTestServiceOptions) {
    this.store = options.store
    this.testers = { ...DEFAULT_TESTERS, ...options.testers }
  }

  /** 返回当前活动测试总数，用于生命周期观测与资源诊断。 */
  get activeTestCount(): number {
    /** 所有 owner 下仍登记的测试数量。 */
    let count = 0
    for (const tests of this.activeByOwner.values()) count += tests.size
    return count
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
    /** 由取消入口独立完成的 Promise，不依赖 tester 响应 signal。 */
    let resolveCancellation!: (result: AudioGenerationTestResult) => void
    const cancellation = new Promise<AudioGenerationTestResult>((resolve) => {
      resolveCancellation = resolve
    })
    /** 注册表只保存生命周期状态，不保存 resolvedInput。 */
    const active: ActiveTest = {
      identity,
      controller,
      resolveCancellation,
      cancelled: false,
    }
    /** 当前 owner 的活动请求表。 */
    const ownerTests = this.activeByOwner.get(ownerId) ?? new Map<string, ActiveTest>()
    ownerTests.set(input.requestId, active)
    this.activeByOwner.set(ownerId, ownerTests)

    /** 底层 Promise 始终挂接 catch，保证取消后迟到 reject 不成为未处理异常。 */
    const execution = (async (): Promise<AudioGenerationTestResult> => {
      if (active.cancelled) return cancelledResult(input.requestId)
      /** 供应商 adapter 只在当前异步调用链取得明文凭据。 */
      const testerResult = await this.testers[resolvedInput.profile.provider].test(
        resolvedInput,
        controller.signal,
      )
      if (active.cancelled) return cancelledResult(input.requestId)
      return parseAudioGenerationTestResult({ requestId: input.requestId, ...testerResult })
    })().catch(() => active.cancelled
      ? cancelledResult(input.requestId)
      : failedResult(input.requestId))

    try {
      /** 任一显式生命周期取消都可先于忽略 signal 的 tester 收口。 */
      return await Promise.race([execution, cancellation])
    } finally {
      /** 迟到旧请求只能删除自身，不能覆盖同 requestId 的新注册。 */
      const currentOwnerTests = this.activeByOwner.get(ownerId)
      if (currentOwnerTests?.get(input.requestId) === active) {
        currentOwnerTests.delete(input.requestId)
        if (currentOwnerTests.size === 0) this.activeByOwner.delete(ownerId)
      }
    }
  }

  /** 幂等取消 owner 下指定 requestId。 */
  cancel(ownerId: number, requestId: string): void {
    const active = this.activeByOwner.get(ownerId)?.get(requestId)
    if (active) this.cancelActive(requestId, active)
  }

  /** 幂等释放 owner 的全部测试，供窗口销毁时统一清理。 */
  releaseOwner(ownerId: number): void {
    const tests = this.activeByOwner.get(ownerId)
    if (!tests) return
    for (const [requestId, active] of tests) this.cancelActive(requestId, active)
  }

  /** 幂等取消所有 owner 的活动测试。 */
  dispose(): void {
    for (const ownerId of [...this.activeByOwner.keys()]) this.releaseOwner(ownerId)
  }

  /** 新请求开始前取消同 requestId 或同配置身份的旧请求。 */
  private cancelReplaced(ownerId: number, requestId: string, identity: string): void {
    const tests = this.activeByOwner.get(ownerId)
    if (!tests) return
    for (const [activeRequestId, active] of tests) {
      if (activeRequestId === requestId || active.identity === identity) {
        this.cancelActive(activeRequestId, active)
      }
    }
  }

  /** 同时完成及时取消结果并通知支持 AbortSignal 的 tester。 */
  private cancelActive(requestId: string, active: ActiveTest): void {
    if (active.cancelled) return
    active.cancelled = true
    active.resolveCancellation(cancelledResult(requestId))
    active.controller.abort()
  }
}
