import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  ImageGenerationProfile,
  ReplaceImageGenerationCatalogRequest,
} from '@proma/shared'
import { ImageGenerationConfigStore, type ImageGenerationSecureStorage } from './image-generation-config-store'

/** 每个测试使用独立真实目录，验证原子文件行为而非模拟文件系统。 */
let directory = ''
/** 独立生图配置文件的测试路径。 */
let configPath = ''

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'proma-image-generation-'))
  configPath = join(directory, 'image-generation-profiles.json')
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

/** 构造可逆的测试安全存储；磁盘只会收到密文 Buffer。 */
function createSecureStorage(overrides: Partial<ImageGenerationSecureStorage> = {}): ImageGenerationSecureStorage {
  return {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'keychain',
    encryptString: (value) => Buffer.from(`enc:${value}`, 'utf8'),
    decryptString: (value) => value.toString('utf8').replace(/^enc:/, ''),
    ...overrides,
  }
}

/** 创建 Store 并允许覆盖依赖。 */
function createStore(options: Partial<ConstructorParameters<typeof ImageGenerationConfigStore>[0]> = {}): ImageGenerationConfigStore {
  return new ImageGenerationConfigStore({
    configPath,
    secureStorage: createSecureStorage(),
    ...options,
  })
}

/** 构造密钥型供应商配置。 */
function openaiProfile(overrides: Partial<ImageGenerationProfile> = {}): ImageGenerationProfile {
  return {
    id: 'openai-main',
    name: 'ChatGPT 生图',
    provider: 'openai-images',
    baseUrl: 'https://api.openai.com/v1',
    models: [{ id: 'gpt-image-1', capabilities: ['text-to-image'] }],
    enabled: true,
    createdAt: 10,
    updatedAt: 20,
    ...overrides,
  } as ImageGenerationProfile
}

/** 构造即梦配置：没有服务地址与密钥。 */
function dreaminaProfile(overrides: Partial<ImageGenerationProfile> = {}): ImageGenerationProfile {
  return {
    id: 'dreamina-main',
    name: '即梦',
    provider: 'dreamina',
    models: [{ id: '5.0', capabilities: ['text-to-image'], params: { resolution_type: '2k' } }],
    enabled: true,
    createdAt: 10,
    updatedAt: 20,
    ...overrides,
  } as ImageGenerationProfile
}

/** 构造首次替换目录的请求。 */
function createRequest(
  profiles: ReplaceImageGenerationCatalogRequest['profiles'],
  expectedRevision = 0,
): ReplaceImageGenerationCatalogRequest {
  return { expectedRevision, profiles }
}

describe('独立生图配置存储', () => {
  test('Given 首次读取 When 文件不存在 Then 返回空目录且不创建文件', () => {
    expect(createStore().readPublic()).toEqual({ schemaVersion: 1, revision: 0, profiles: [] })
    expect(existsSync(configPath)).toBeFalse()
  })

  test('Given 密钥型配置 When 保存 Then 磁盘只有密文且解密可取回原值', () => {
    const catalog = createStore().replace(createRequest([
      { profile: openaiProfile(), credentialUpdate: { mode: 'replace', apiKey: 'secret-key' } },
    ]))
    expect(catalog.profiles[0]).toMatchObject({
      id: 'openai-main',
      credentialConfigured: true,
      endpointOrigin: 'https://api.openai.com',
    })
    const persisted = readFileSync(configPath, 'utf8')
    expect(persisted).not.toContain('secret-key')
    expect(persisted).toContain(Buffer.from('enc:secret-key').toString('base64'))
    expect(createStore().resolveApiKey('openai-main')).toBe('secret-key')
  })

  test('Given 第三方 OpenAI Images 使用 HTTP When 保存并重读 Then 公开目录保留完整地址合同', () => {
    createStore().replace(createRequest([
      {
        profile: openaiProfile({
          name: '第三方 GPT 生图',
          baseUrl: 'http://images.example.test:8030/v1',
        }),
        credentialUpdate: { mode: 'replace', apiKey: 'third-party-secret' },
      },
    ]))

    /** 用新 Store 实例从磁盘重读，避免只验证本次 replace 的内存返回值。 */
    const reopenedStore = createStore()
    expect(reopenedStore.readPublic().profiles[0]).toMatchObject({
      provider: 'openai-images',
      baseUrl: 'http://images.example.test:8030/v1',
      endpointOrigin: 'http://images.example.test:8030',
      credentialConfigured: true,
    })
    expect(reopenedStore.resolveApiKey('openai-main')).toBe('third-party-secret')
  })

  test('Given 即梦配置 When 保存 Then 不写入密文槽位且拒绝替换密钥', () => {
    const catalog = createStore().replace(createRequest([
      { profile: dreaminaProfile(), credentialUpdate: { mode: 'preserve' } },
    ]))
    expect(catalog.profiles[0]).toMatchObject({ provider: 'dreamina', credentialConfigured: true })
    /** 即梦走 CLI 登录态，不允许把密钥写进目录。 */
    expect(() => createStore().replace(createRequest([
      { profile: dreaminaProfile(), credentialUpdate: { mode: 'replace', apiKey: 'leak' } },
    ]))).toThrow('IMAGE_GENERATION_CONFIG_INVALID')
    expect(() => createStore().resolveApiKey('dreamina-main')).toThrow('IMAGE_GENERATION_CREDENTIAL_NOT_APPLICABLE')
  })

  test('Given revision 过期或保留不存在的密文 When 提交 Then 稳定冲突且不写文件', () => {
    createStore().replace(createRequest([
      { profile: openaiProfile(), credentialUpdate: { mode: 'replace', apiKey: 'first-secret' } },
    ]))
    const before = readFileSync(configPath, 'utf8')
    expect(() => createStore().replace(createRequest([
      { profile: openaiProfile(), credentialUpdate: { mode: 'preserve' } },
    ], 0))).toThrow('IMAGE_GENERATION_CONFIG_CONFLICT')
    expect(() => createStore().replace(createRequest([
      /** 新增的密钥型配置没有可保留的密文，必须显式提供 Key。 */
      { profile: openaiProfile({ id: 'openai-2' }), credentialUpdate: { mode: 'preserve' } },
    ], 1))).toThrow('IMAGE_GENERATION_CREDENTIAL_PRESERVE_INVALID')
    expect(readFileSync(configPath, 'utf8')).toBe(before)
  })

  test('Given 已保存配置 When 编辑但保留凭据 Then 密文与创建时间不变', () => {
    createStore().replace(createRequest([
      { profile: openaiProfile(), credentialUpdate: { mode: 'replace', apiKey: 'first-secret' } },
    ]))
    const catalog = createStore().replace(createRequest([
      {
        profile: openaiProfile({ name: '改名后', createdAt: 999, updatedAt: 999 }),
        credentialUpdate: { mode: 'preserve' },
      },
    ], 1))
    expect(catalog.profiles[0]).toMatchObject({ name: '改名后', createdAt: 10 })
    expect(createStore().resolveApiKey('openai-main')).toBe('first-secret')
  })

  test('Given 损坏目录或未知字段 When 读取 Then 严格拒绝', () => {
    writeFileSync(configPath, '{not-json', { mode: 0o600 })
    expect(() => createStore().readPublic()).toThrow('IMAGE_GENERATION_CONFIG_INVALID')

    writeFileSync(configPath, JSON.stringify({
      schemaVersion: 1,
      revision: 1,
      profiles: [{ profile: dreaminaProfile(), encryptedApiKey: 'leak' }],
    }), { mode: 0o600 })
    expect(() => createStore().readPublic()).toThrow('IMAGE_GENERATION_CONFIG_INVALID')

    writeFileSync(configPath, JSON.stringify({
      schemaVersion: 2,
      revision: 1,
      profiles: [],
    }), { mode: 0o600 })
    expect(() => createStore().readPublic()).toThrow('IMAGE_GENERATION_CONFIG_INVALID')
  })
})
