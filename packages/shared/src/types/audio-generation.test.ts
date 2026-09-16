import { describe, expect, test } from 'bun:test'
import {
  AUDIO_GENERATION_LEGACY_WARNING,
  AUDIO_GENERATION_PROVIDER_DESCRIPTORS,
  parseAudioGenerationProfile,
  parseAudioGenerationSettingsResult,
  parseAudioGenerationTestCancelInput,
  parseAudioGenerationTestInput,
  parseAudioGenerationTestResult,
  parseReplaceAudioGenerationCatalogRequest,
} from './audio-generation'

/** 创建合法的小米音频配置，允许单个测试覆盖目标字段。 */
function createXiaomiProfile(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'audio-1',
    name: ' 小米语音 ',
    provider: 'xiaomi',
    baseUrl: 'https://tts.example/v1///',
    modelId: ' mimo-tts ',
    voiceId: ' voice-1 ',
    enabled: true,
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  }
}

/** 创建合法的 MiniMax 音频配置，允许单个测试覆盖目标字段。 */
function createMiniMaxProfile(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'audio-2',
    name: ' MiniMax ',
    provider: 'minimax',
    baseUrl: 'https://api.minimax.example/',
    modelId: ' speech-02 ',
    voiceId: ' female-1 ',
    groupId: ' group-1 ',
    enabled: true,
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  }
}

describe('独立音频生成 Shared 合同', () => {
  test('Given 小米与 MiniMax 配置 When 严格解析 Then 清洗字段并保留供应商差异', () => {
    expect(parseAudioGenerationProfile(createXiaomiProfile())).toEqual({
      id: 'audio-1', name: '小米语音', provider: 'xiaomi', baseUrl: 'https://tts.example/v1',
      modelId: 'mimo-tts', voiceId: 'voice-1', enabled: true, createdAt: 1, updatedAt: 2,
    })
    expect(parseAudioGenerationProfile(createMiniMaxProfile())).toEqual({
      id: 'audio-2', name: 'MiniMax', provider: 'minimax', baseUrl: 'https://api.minimax.example',
      modelId: 'speech-02', voiceId: 'female-1', groupId: 'group-1', enabled: true, createdAt: 1, updatedAt: 2,
    })
  })

  test('Given URL 内嵌凭据、查询或片段 When 解析 Then 使用稳定 URL 错误码拒绝', () => {
    for (const baseUrl of [
      'https://token@example.com/v1',
      'https://example.com/v1?token=secret',
      'https://example.com/v1?',
      'https://example.com/v1#secret',
      'https://example.com/v1#',
      'ftp://example.com/v1',
    ]) {
      expect(() => parseAudioGenerationProfile(createXiaomiProfile({ baseUrl })))
        .toThrow('AUDIO_GENERATION_URL_INVALID')
    }
  })

  test('Given Base URL 含原始 ASCII 控制字符 When 解析 Then 拒绝 parser 隐式清洗', () => {
    for (const baseUrl of [
      'https://exa\tmple.com/v1',
      'https://example.com/\r/v1',
      'https://example.com/\n/v1',
    ]) {
      expect(() => parseAudioGenerationProfile(createXiaomiProfile({ baseUrl })))
        .toThrow('AUDIO_GENERATION_URL_INVALID')
    }
    expect(parseAudioGenerationProfile(createXiaomiProfile({
      baseUrl: 'https://example.com/v1/%0A/%3F/%23/',
    })).baseUrl).toBe('https://example.com/v1/%0A/%3F/%23')
  })

  test('Given 供应商字段错配或未知字段 When 解析 Then 使用稳定配置错误码拒绝', () => {
    expect(() => parseAudioGenerationProfile(createXiaomiProfile({ groupId: 'forbidden' })))
      .toThrow('AUDIO_GENERATION_CONFIG_INVALID')
    expect(() => parseAudioGenerationProfile(createMiniMaxProfile({ vendorSecret: 'forbidden' })))
      .toThrow('AUDIO_GENERATION_CONFIG_INVALID')
    expect(() => parseAudioGenerationProfile(createMiniMaxProfile({ provider: 'unknown' })))
      .toThrow('AUDIO_GENERATION_CONFIG_INVALID')
  })

  test('Given 稳定 ID 与有界文本 When 越过安全合同 Then 拒绝危险或超长输入', () => {
    for (const id of ['包含空格', '__proto__', 'a'.repeat(257)]) {
      expect(() => parseAudioGenerationProfile(createXiaomiProfile({ id })))
        .toThrow('AUDIO_GENERATION_CONFIG_INVALID')
    }
    expect(() => parseAudioGenerationProfile(createXiaomiProfile({ name: '名'.repeat(129) })))
      .toThrow('AUDIO_GENERATION_CONFIG_INVALID')
  })

  test('Given 超长空白包裹短文本 When 解析受限文本 Then 按原始长度拒绝', () => {
    /** 超过所有短文本上限、但 trim 后只剩一个字符的攻击输入。 */
    const paddedShortText = `${' '.repeat(10_000)}值`
    expect(() => parseAudioGenerationProfile(createXiaomiProfile({ name: paddedShortText })))
      .toThrow('AUDIO_GENERATION_CONFIG_INVALID')
    expect(() => parseAudioGenerationProfile(createMiniMaxProfile({ groupId: paddedShortText })))
      .toThrow('AUDIO_GENERATION_CONFIG_INVALID')
    expect(() => parseReplaceAudioGenerationCatalogRequest({
      expectedRevision: 0,
      profiles: [{
        profile: createXiaomiProfile(),
        credentialUpdate: { mode: 'replace', apiKey: paddedShortText },
      }],
    })).toThrow('AUDIO_GENERATION_CONFIG_INVALID')
    expect(() => parseAudioGenerationTestResult({
      requestId: 'request-1', state: 'success', message: `${' '.repeat(10_000)}音频生成服务连接测试成功`,
    })).toThrow('AUDIO_GENERATION_CONFIG_INVALID')
  })

  test('Given provider union When 读取公开描述 Then 顺序、显示名和专属字段精确', () => {
    expect(AUDIO_GENERATION_PROVIDER_DESCRIPTORS).toEqual([
      { provider: 'xiaomi', label: '小米 TTS', specificFields: [] },
      { provider: 'minimax', label: 'MiniMax Speech', specificFields: ['groupId'] },
    ])
  })

  test('Given 完整替换请求 When 解析 Then 清洗 Profile 与凭据更新', () => {
    expect(parseReplaceAudioGenerationCatalogRequest({
      expectedRevision: 3,
      profiles: [
        { profile: createXiaomiProfile(), credentialUpdate: { mode: 'preserve' } },
        { profile: createMiniMaxProfile(), credentialUpdate: { mode: 'replace', apiKey: ' secret-key ' } },
      ],
    })).toMatchObject({
      expectedRevision: 3,
      profiles: [
        { profile: { provider: 'xiaomi', name: '小米语音' }, credentialUpdate: { mode: 'preserve' } },
        { profile: { provider: 'minimax', groupId: 'group-1' }, credentialUpdate: { mode: 'replace', apiKey: 'secret-key' } },
      ],
    })
  })

  test('Given 凭据更新含未知字段、空 Key 或重复 Profile When 解析 Then 拒绝', () => {
    expect(() => parseReplaceAudioGenerationCatalogRequest({
      expectedRevision: 0,
      profiles: [{ profile: createXiaomiProfile(), credentialUpdate: { mode: 'preserve', apiKey: 'leak' } }],
    })).toThrow('AUDIO_GENERATION_CONFIG_INVALID')
    expect(() => parseReplaceAudioGenerationCatalogRequest({
      expectedRevision: 0,
      profiles: [{ profile: createXiaomiProfile(), credentialUpdate: { mode: 'replace', apiKey: '   ' } }],
    })).toThrow('AUDIO_GENERATION_CONFIG_INVALID')
    expect(() => parseReplaceAudioGenerationCatalogRequest({
      expectedRevision: 0,
      profiles: [
        { profile: createXiaomiProfile(), credentialUpdate: { mode: 'preserve' } },
        { profile: createXiaomiProfile(), credentialUpdate: { mode: 'preserve' } },
      ],
    })).toThrow('AUDIO_GENERATION_CONFIG_INVALID')
  })

  test('Given draft 与 saved 测试输入 When 解析 Then 只保留各自声明字段', () => {
    expect(parseAudioGenerationTestInput({
      kind: 'draft', requestId: 'request-1', profile: createMiniMaxProfile(), apiKey: ' draft-key ',
    })).toMatchObject({
      kind: 'draft', requestId: 'request-1', profile: { provider: 'minimax', groupId: 'group-1' }, apiKey: 'draft-key',
    })
    expect(parseAudioGenerationTestInput({
      kind: 'saved', requestId: 'request-2', profileId: 'audio-1',
    })).toEqual({ kind: 'saved', requestId: 'request-2', profileId: 'audio-1' })
    expect(() => parseAudioGenerationTestInput({
      kind: 'saved', requestId: 'request-2', profileId: 'audio-1', apiKey: 'forbidden',
    })).toThrow('AUDIO_GENERATION_CONFIG_INVALID')
  })

  test('Given 测试结果与取消 envelope When 严格解析 Then 只接受固定状态和中文消息', () => {
    expect(parseAudioGenerationTestResult({
      requestId: 'request-1', state: 'unavailable', message: '小米 TTS 尚缺少已验证的官方测试接口',
    })).toEqual({ requestId: 'request-1', state: 'unavailable', message: '小米 TTS 尚缺少已验证的官方测试接口' })
    expect(parseAudioGenerationTestResult({
      requestId: 'request-2', state: 'success', message: '音频生成服务连接测试成功',
    })).toEqual({ requestId: 'request-2', state: 'success', message: '音频生成服务连接测试成功' })
    expect(parseAudioGenerationTestCancelInput({ requestId: 'request-1' })).toEqual({ requestId: 'request-1' })
    expect(() => parseAudioGenerationTestResult({
      requestId: 'request-1', state: 'unknown', message: '未知状态',
    })).toThrow('AUDIO_GENERATION_CONFIG_INVALID')
    expect(() => parseAudioGenerationTestResult({
      requestId: 'request-1', state: 'failed', message: 'Bearer secret-key',
    })).toThrow('AUDIO_GENERATION_CONFIG_INVALID')
    for (const message of [
      '测试失败：sk-live-secret-value',
      '测试失败：api_key=secret-value',
      '测试失败：/Users/example/.proma/config.json',
    ]) {
      expect(() => parseAudioGenerationTestResult({ requestId: 'request-1', state: 'failed', message }))
        .toThrow('AUDIO_GENERATION_CONFIG_INVALID')
    }
    expect(() => parseAudioGenerationTestResult({
      requestId: 'request-1', state: 'success', message: '音频生成服务连接测试失败',
    })).toThrow('AUDIO_GENERATION_CONFIG_INVALID')
  })

  test('Given 设置结果 When 解析 Then 公开 Profile 与旧摘要均使用严格字段', () => {
    const parsed = parseAudioGenerationSettingsResult({
      catalog: {
        schemaVersion: 1,
        revision: 4,
        profiles: [{
          ...createXiaomiProfile(), name: '小米语音', baseUrl: 'https://tts.example/v1',
          credentialConfigured: true, endpointOrigin: 'https://tts.example',
        }],
      },
      legacyAudioProfiles: [{
        id: 'legacy-1', name: '旧语音', protocol: 'minimax-speech', modelId: 'speech-01', enabled: false,
      }],
      legacyWarning: AUDIO_GENERATION_LEGACY_WARNING,
    })
    expect(parsed.catalog.profiles[0]).toMatchObject({ credentialConfigured: true, endpointOrigin: 'https://tts.example' })
    expect(parsed.legacyAudioProfiles[0]?.protocol).toBe('minimax-speech')
    expect(parsed.legacyWarning).toBe(AUDIO_GENERATION_LEGACY_WARNING)
    expect(() => parseAudioGenerationSettingsResult({
      ...parsed,
      legacyAudioProfiles: [{ ...parsed.legacyAudioProfiles[0], protocol: 'minimax-music' }],
    })).toThrow('AUDIO_GENERATION_CONFIG_INVALID')
    expect(() => parseAudioGenerationSettingsResult({ ...parsed, secret: 'forbidden' }))
      .toThrow('AUDIO_GENERATION_CONFIG_INVALID')
    for (const legacyWarning of [
      '旧配置读取失败：api_key=secret-value',
      '旧配置读取失败：sk-live-secret-value',
      '旧配置读取失败：/Users/example/.proma/media.json',
    ]) {
      expect(() => parseAudioGenerationSettingsResult({ ...parsed, legacyWarning }))
        .toThrow('AUDIO_GENERATION_CONFIG_INVALID')
    }
  })
})
