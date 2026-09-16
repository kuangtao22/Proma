import { describe, expect, spyOn, test } from 'bun:test'
import type {
  AudioGenerationProfile,
  AudioGenerationPublicCatalog,
  AudioGenerationTestInput,
} from '@proma/shared'
import { AUDIO_GENERATION_TEST_MESSAGES } from '@proma/shared'
import {
  AudioGenerationTestService,
  type AudioGenerationProviderTester,
  type AudioGenerationResolvedTestInput,
  type AudioGenerationTestStore,
} from './audio-generation-test-service'

/** 构造合法音频配置，测试只覆盖与当前场景相关的字段。 */
function profile(
  provider: AudioGenerationProfile['provider'] = 'xiaomi',
  overrides: Partial<AudioGenerationProfile> = {},
): AudioGenerationProfile {
  const common = {
    id: `${provider}-main`,
    name: `${provider} 主配置`,
    baseUrl: `https://${provider}.example/v1/audio`,
    modelId: `${provider}-model`,
    voiceId: `${provider}-voice`,
    enabled: true,
    createdAt: 10,
    updatedAt: 20,
  }
  return provider === 'minimax'
    ? { ...common, provider, groupId: 'group-1', ...overrides } as AudioGenerationProfile
    : { ...common, provider, ...overrides } as AudioGenerationProfile
}

/** 构造一次性草稿测试输入，API Key 不进入任何持久化依赖。 */
function draftInput(
  requestId: string,
  provider: AudioGenerationProfile['provider'] = 'xiaomi',
  apiKey = 'draft-secret',
  overrides: Partial<AudioGenerationProfile> = {},
): AudioGenerationTestInput {
  return { kind: 'draft', requestId, profile: profile(provider, overrides), apiKey }
}

/** 构造公开目录，允许测试公开扩展字段是否会被服务剥离。 */
function catalog(
  savedProfile: AudioGenerationProfile = profile(),
): AudioGenerationPublicCatalog {
  return {
    schemaVersion: 1,
    revision: 1,
    profiles: [{
      ...savedProfile,
      credentialConfigured: true,
      endpointOrigin: new URL(savedProfile.baseUrl).origin,
    }],
  }
}

/** 构造可观察调用次数的内存 Store。 */
function storeFixture(options: {
  publicCatalog?: AudioGenerationPublicCatalog
  apiKey?: string
  readError?: Error
  resolveError?: Error
} = {}): AudioGenerationTestStore & { readCalls: number; resolveCalls: number } {
  return {
    readCalls: 0,
    resolveCalls: 0,
    readPublic() {
      this.readCalls += 1
      if (options.readError) throw options.readError
      return options.publicCatalog ?? catalog()
    },
    resolveApiKey() {
      this.resolveCalls += 1
      if (options.resolveError) throw options.resolveError
      return options.apiKey ?? 'saved-secret'
    },
  }
}

/** 创建可由测试显式完成或拒绝的 Promise。 */
function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

/** 构造固定成功结果，确保 tester 结果仍经过 Shared parser。 */
function successTester(
  inspect?: (input: AudioGenerationResolvedTestInput, signal: AbortSignal) => void,
): AudioGenerationProviderTester {
  return {
    test: async (input, signal) => {
      inspect?.(input, signal)
      return { state: 'success', message: AUDIO_GENERATION_TEST_MESSAGES.success }
    },
  }
}

describe('独立音频供应商测试服务', () => {
  test('Given 小米和 MiniMax 尚无验证合同 When 使用默认 tester Then 不发网络请求并返回固定 unavailable', async () => {
    /** 保留 Bun fetch 的 preconnect 静态合同，同时禁止真实网络访问。 */
    const blockedFetch = Object.assign(
      async () => { throw new Error('不应访问网络') },
      { preconnect: (_url: string | URL) => undefined },
    ) satisfies typeof fetch
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(blockedFetch)
    const service = new AudioGenerationTestService({ store: storeFixture() })
    try {
      expect(await service.test(7, draftInput('xiaomi-request', 'xiaomi'))).toEqual({
        requestId: 'xiaomi-request',
        state: 'unavailable',
        message: AUDIO_GENERATION_TEST_MESSAGES.unavailable.xiaomi,
      })
      expect(await service.test(7, draftInput('minimax-request', 'minimax'))).toEqual({
        requestId: 'minimax-request',
        state: 'unavailable',
        message: AUDIO_GENERATION_TEST_MESSAGES.unavailable.minimax,
      })
      expect(fetchSpy).toHaveBeenCalledTimes(0)
    } finally {
      fetchSpy.mockRestore()
    }
  })

  test('Given 草稿凭据 When 测试 Then 只在 tester 调用栈收到严格配置和当前 Key', async () => {
    const store = storeFixture()
    let received: AudioGenerationResolvedTestInput | undefined
    const service = new AudioGenerationTestService({
      store,
      testers: { xiaomi: successTester(input => { received = input }) },
    })

    expect(await service.test(7, draftInput('draft-request', 'xiaomi', 'current-secret'))).toMatchObject({
      state: 'success', requestId: 'draft-request',
    })
    expect(received).toEqual({ profile: profile(), apiKey: 'current-secret' })
    expect(store.readCalls).toBe(0)
    expect(store.resolveCalls).toBe(0)
    expect(service.activeTestCount).toBe(0)
  })

  test('Given 已保存配置 When 测试 Then 从 Store 按 ID 解密且剥离公开扩展字段', async () => {
    const saved = profile('minimax')
    const store = storeFixture({ publicCatalog: catalog(saved), apiKey: 'saved-current-secret' })
    let received: AudioGenerationResolvedTestInput | undefined
    const service = new AudioGenerationTestService({
      store,
      testers: { minimax: successTester(input => { received = input }) },
    })
    /** 模拟未来 Store 意外增加公开字段，服务必须重新构造严格 Profile。 */
    Object.assign(store.readPublic().profiles[0]!, { futurePublicField: 'ignored' })

    const result = await service.test(7, {
      kind: 'saved', requestId: 'saved-request', profileId: saved.id,
    })

    expect(result).toMatchObject({ state: 'success', requestId: 'saved-request' })
    expect(received).toEqual({ profile: saved, apiKey: 'saved-current-secret' })
    expect(received).not.toHaveProperty('credentialConfigured')
    expect(received).not.toHaveProperty('endpointOrigin')
    expect(received).not.toHaveProperty('futurePublicField')
    expect(store.resolveCalls).toBe(1)
  })

  test('Given 同 owner 同草稿配置 When 第二次使用不同 Key Then 及时取消第一请求', async () => {
    const firstRun = deferred<Awaited<ReturnType<AudioGenerationProviderTester['test']>>>()
    let calls = 0
    const service = new AudioGenerationTestService({
      store: storeFixture(),
      testers: { xiaomi: {
        test: async () => ++calls === 1
          ? firstRun.promise
          : { state: 'success', message: AUDIO_GENERATION_TEST_MESSAGES.success },
      } },
    })

    const first = service.test(7, draftInput('request-1', 'xiaomi', 'first-secret'))
    const second = service.test(7, draftInput('request-2', 'xiaomi', 'second-secret'))

    expect(await first).toEqual({
      requestId: 'request-1', state: 'cancelled', message: AUDIO_GENERATION_TEST_MESSAGES.cancelled,
    })
    expect(await second).toMatchObject({ requestId: 'request-2', state: 'success' })
    firstRun.resolve({ state: 'success', message: AUDIO_GENERATION_TEST_MESSAGES.success })
    await Promise.resolve()
    expect(service.activeTestCount).toBe(0)
  })

  test('Given 不同 owner 的相同配置 When 同时测试 Then 彼此不取消', async () => {
    const runs = [deferred<Awaited<ReturnType<AudioGenerationProviderTester['test']>>>(), deferred<Awaited<ReturnType<AudioGenerationProviderTester['test']>>>()]
    let calls = 0
    const service = new AudioGenerationTestService({
      store: storeFixture(),
      testers: { xiaomi: { test: async () => runs[calls++]!.promise } },
    })
    const first = service.test(7, draftInput('owner-7'))
    const second = service.test(8, draftInput('owner-8'))
    await Promise.resolve()

    expect(service.activeTestCount).toBe(2)
    runs[0]!.resolve({ state: 'success', message: AUDIO_GENERATION_TEST_MESSAGES.success })
    runs[1]!.resolve({ state: 'success', message: AUDIO_GENERATION_TEST_MESSAGES.success })
    expect((await first).state).toBe('success')
    expect((await second).state).toBe('success')
  })

  test('Given tester 忽略 signal When 显式取消两次 Then Promise 立即返回且取消幂等', async () => {
    const run = deferred<Awaited<ReturnType<AudioGenerationProviderTester['test']>>>()
    const service = new AudioGenerationTestService({
      store: storeFixture(),
      testers: { xiaomi: { test: async () => run.promise } },
    })
    const pending = service.test(7, draftInput('cancel-request'))
    service.cancel(7, 'cancel-request')
    service.cancel(7, 'cancel-request')

    expect(await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('取消未及时返回')), 50)),
    ])).toEqual({
      requestId: 'cancel-request', state: 'cancelled', message: AUDIO_GENERATION_TEST_MESSAGES.cancelled,
    })
    expect(service.activeTestCount).toBe(0)
    run.resolve({ state: 'success', message: AUDIO_GENERATION_TEST_MESSAGES.success })
  })

  test('Given owner 有多个活动测试 When releaseOwner Then 全部取消且其他 owner 保持活动', async () => {
    const runs = Array.from(
      { length: 3 },
      () => deferred<Awaited<ReturnType<AudioGenerationProviderTester['test']>>>(),
    )
    let calls = 0
    const service = new AudioGenerationTestService({
      store: storeFixture(),
      testers: { xiaomi: { test: async () => runs[calls++]!.promise } },
    })
    const first = service.test(7, draftInput('first', 'xiaomi', 'key', { id: 'profile-1' }))
    const second = service.test(7, draftInput('second', 'xiaomi', 'key', { id: 'profile-2' }))
    const other = service.test(8, draftInput('other', 'xiaomi', 'key', { id: 'profile-3' }))
    service.releaseOwner(7)
    service.releaseOwner(7)

    expect((await first).state).toBe('cancelled')
    expect((await second).state).toBe('cancelled')
    expect(service.activeTestCount).toBe(1)
    runs[2]!.resolve({ state: 'success', message: AUDIO_GENERATION_TEST_MESSAGES.success })
    expect((await other).state).toBe('success')
  })

  test('Given 多个 owner 有活动测试 When dispose Then 全部及时取消且可重复调用', async () => {
    const never = new Promise<never>(() => {})
    const service = new AudioGenerationTestService({
      store: storeFixture(),
      testers: { xiaomi: { test: async () => never } },
    })
    const first = service.test(7, draftInput('first-owner'))
    const second = service.test(8, draftInput('second-owner'))
    service.dispose()
    service.dispose()

    expect((await first).state).toBe('cancelled')
    expect((await second).state).toBe('cancelled')
    expect(service.activeTestCount).toBe(0)
  })

  test('Given 相同 requestId 被新身份复用 When 旧 tester 迟到拒绝 Then 不删除新请求且不产生未处理拒绝', async () => {
    const firstRun = deferred<Awaited<ReturnType<AudioGenerationProviderTester['test']>>>()
    const secondRun = deferred<Awaited<ReturnType<AudioGenerationProviderTester['test']>>>()
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => { unhandled.push(reason) }
    process.on('unhandledRejection', onUnhandled)
    let calls = 0
    const service = new AudioGenerationTestService({
      store: storeFixture(),
      testers: { xiaomi: { test: async () => (++calls === 1 ? firstRun.promise : secondRun.promise) } },
    })
    try {
      const first = service.test(7, draftInput('same-request', 'xiaomi', 'key', { id: 'profile-1' }))
      const second = service.test(7, draftInput('same-request', 'xiaomi', 'key', { id: 'profile-2' }))
      expect((await first).state).toBe('cancelled')
      firstRun.reject(new Error('Bearer secret-key https://host/private?token=secret /Users/private/key'))
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(unhandled).toEqual([])
      expect(service.activeTestCount).toBe(1)
      secondRun.resolve({ state: 'success', message: AUDIO_GENERATION_TEST_MESSAGES.success })
      expect((await second).state).toBe('success')
      expect(service.activeTestCount).toBe(0)
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  test('Given tester 抛出秘密和本地路径 When 测试失败 Then 只返回固定脱敏文案', async () => {
    const service = new AudioGenerationTestService({
      store: storeFixture(),
      testers: { xiaomi: { test: async () => {
        throw new Error('Bearer secret-key https://tts.example/private?token=secret /Users/alice/key')
      } } },
    })

    const result = await service.test(7, draftInput('failed-request', 'xiaomi', 'secret-key'))
    expect(result).toEqual({
      requestId: 'failed-request', state: 'failed', message: AUDIO_GENERATION_TEST_MESSAGES.failed,
    })
    expect(JSON.stringify(result)).not.toContain('secret-key')
    expect(JSON.stringify(result)).not.toContain('tts.example')
    expect(JSON.stringify(result)).not.toContain('/Users/alice')
  })

  test('Given Store 查找或解密失败 When 测试已保存配置 Then 只返回固定 failed', async () => {
    for (const store of [
      storeFixture({ publicCatalog: { schemaVersion: 1, revision: 0, profiles: [] } }),
      storeFixture({ readError: new Error('/Users/alice/corrupt-config') }),
      storeFixture({ resolveError: new Error('Bearer saved-secret') }),
    ]) {
      const service = new AudioGenerationTestService({ store, testers: { xiaomi: successTester() } })
      expect(await service.test(7, {
        kind: 'saved', requestId: `saved-failure-${store.readCalls}`, profileId: 'xiaomi-main',
      })).toMatchObject({ state: 'failed', message: AUDIO_GENERATION_TEST_MESSAGES.failed })
    }
  })

  test('Given tester 返回非受控消息 When 结果校验 Then fail closed 为固定 failed', async () => {
    const service = new AudioGenerationTestService({
      store: storeFixture(),
      testers: { xiaomi: { test: async () => ({ state: 'success', message: 'Bearer leaked-secret' }) } },
    })
    expect(await service.test(7, draftInput('invalid-result'))).toEqual({
      requestId: 'invalid-result', state: 'failed', message: AUDIO_GENERATION_TEST_MESSAGES.failed,
    })
  })

  test('Given tester 运行时伪造 requestId 或额外字段 When 结果校验 Then 保留原身份并 fail closed', async () => {
    /** 绕过静态 Omit 模拟不可信 adapter 的真实运行时返回。 */
    const maliciousResults: unknown[] = [
      {
        requestId: 'attacker-request',
        state: 'success',
        message: AUDIO_GENERATION_TEST_MESSAGES.success,
      },
      {
        state: 'success',
        message: AUDIO_GENERATION_TEST_MESSAGES.success,
        futureField: 'unexpected',
      },
    ]
    let calls = 0
    const service = new AudioGenerationTestService({
      store: storeFixture(),
      testers: { xiaomi: {
        test: async () => maliciousResults[calls++] as Awaited<ReturnType<AudioGenerationProviderTester['test']>>,
      } },
    })

    for (const requestId of ['original-request-1', 'original-request-2']) {
      expect(await service.test(7, draftInput(requestId, 'xiaomi', 'secret', { id: requestId }))).toEqual({
        requestId,
        state: 'failed',
        message: AUDIO_GENERATION_TEST_MESSAGES.failed,
      })
    }
    expect(await new AudioGenerationTestService({
      store: storeFixture(),
      testers: { xiaomi: successTester() },
    }).test(7, draftInput('trusted-request'))).toEqual({
      requestId: 'trusted-request',
      state: 'success',
      message: AUDIO_GENERATION_TEST_MESSAGES.success,
    })
  })

  test('Given 非法输入 When 测试 Then 在调用 Store 或 tester 前拒绝', async () => {
    const store = storeFixture()
    let testerCalls = 0
    const service = new AudioGenerationTestService({
      store,
      testers: { xiaomi: successTester(() => { testerCalls += 1 }) },
    })

    await expect(service.test(7, {
      ...draftInput('invalid-input'),
      unexpected: 'field',
    })).rejects.toThrow('AUDIO_GENERATION_CONFIG_INVALID')
    expect(store.readCalls).toBe(0)
    expect(store.resolveCalls).toBe(0)
    expect(testerCalls).toBe(0)
    expect(service.activeTestCount).toBe(0)
  })
})
