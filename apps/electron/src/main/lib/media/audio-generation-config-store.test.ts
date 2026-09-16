import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  AudioGenerationProfile,
  ReplaceAudioGenerationCatalogRequest,
} from '@proma/shared'
import { AtomicWritePostCommitError, writeJsonFileAtomicSecure } from '../safe-file'
import {
  AudioGenerationConfigStore,
  type AudioGenerationConfigStoreOptions,
  type AudioGenerationSecureStorage,
} from './audio-generation-config-store'

/** 每个测试使用独立真实目录，验证原子文件行为而非模拟文件系统。 */
let directory = ''
/** 独立音频配置文件的测试路径。 */
let configPath = ''

/** 构造可逆的测试安全存储；磁盘只会收到密文 Buffer。 */
function createSecureStorage(
  overrides: Partial<AudioGenerationSecureStorage> = {},
): AudioGenerationSecureStorage {
  return {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'keychain',
    encryptString: (value) => Buffer.from(`encrypted:${value}`),
    decryptString: (value) => value.toString().replace(/^encrypted:/, ''),
    ...overrides,
  }
}

/** 构造固定时钟的配置 Store，便于验证更新时间。 */
function createStore(
  secureStorage = createSecureStorage(),
  now: () => number = () => 100,
  options: Pick<
    AudioGenerationConfigStoreOptions,
    'platform' | 'beforeCommit' | 'beforeReadFinish' | 'writeConfig'
  > = {},
): AudioGenerationConfigStore {
  const storeOptions: AudioGenerationConfigStoreOptions = { configPath, secureStorage, now, ...options }
  return new AudioGenerationConfigStore(storeOptions)
}

/** 构造合法的小米 TTS 配置，可按测试需要覆盖字段。 */
function xiaomiProfile(overrides: Partial<AudioGenerationProfile> = {}): AudioGenerationProfile {
  return {
    id: 'xiaomi-main',
    name: '小米主音色',
    provider: 'xiaomi',
    baseUrl: 'https://tts.example/v1/audio',
    modelId: 'mimo-tts',
    voiceId: 'voice-1',
    enabled: true,
    createdAt: 10,
    updatedAt: 20,
    ...overrides,
  } as AudioGenerationProfile
}

/** 构造首次替换目录的请求。 */
function firstRequest(
  profile: AudioGenerationProfile = xiaomiProfile(),
  apiKey = 'secret-key',
): ReplaceAudioGenerationCatalogRequest {
  return {
    expectedRevision: 0,
    profiles: [{ profile, credentialUpdate: { mode: 'replace', apiKey } }],
  }
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'proma-audio-generation-'))
  configPath = join(directory, 'audio-generation-profiles.json')
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

describe('独立音频生成配置存储', () => {
  test('Given 首次读取 When 文件不存在 Then 返回 revision 0 空目录', () => {
    expect(createStore().readPublic()).toEqual({ schemaVersion: 1, revision: 0, profiles: [] })
  })

  test('Given 新配置与 API Key When 替换目录 Then 仅原子持久化 safeStorage 密文', () => {
    const saved = createStore().replace(firstRequest())

    expect(saved).toEqual({
      schemaVersion: 1,
      revision: 1,
      profiles: [{
        ...xiaomiProfile(),
        updatedAt: 100,
        credentialConfigured: true,
        endpointOrigin: 'https://tts.example',
      }],
    })
    /** 验证重启后的公开投影不依赖解密能力。 */
    expect(createStore(createSecureStorage({
      isEncryptionAvailable: () => false,
      decryptString: () => { throw new Error('不应解密') },
    })).readPublic()).toEqual(saved)
    const persisted = readFileSync(configPath, 'utf8')
    expect(persisted).not.toContain('secret-key')
    expect(persisted).toContain(Buffer.from('encrypted:secret-key').toString('base64'))
    expect(statSync(configPath).mode & 0o777).toBe(0o600)
    expect(existsSync(`${configPath}.lock`)).toBeFalse()
  })

  test('Given 旧 revision When 替换 Then 保留原文件并返回冲突', () => {
    const store = createStore()
    store.replace(firstRequest())
    const before = readFileSync(configPath, 'utf8')

    expect(() => store.replace(firstRequest())).toThrow('AUDIO_GENERATION_CONFIG_CONFLICT')
    expect(readFileSync(configPath, 'utf8')).toBe(before)
  })

  test('Given safeStorage 不可用或为 basic_text When 新增凭据 Then 不写文件', () => {
    for (const secureStorage of [
      createSecureStorage({ isEncryptionAvailable: () => false }),
      createSecureStorage({ getSelectedStorageBackend: () => 'basic_text' }),
    ]) {
      expect(() => createStore(secureStorage, () => 100, { platform: 'linux' }).replace(firstRequest())).toThrow(
        'AUDIO_GENERATION_SECURE_STORAGE_UNAVAILABLE',
      )
      expect(existsSync(configPath)).toBeFalse()
    }
  })

  test('Given macOS 或 Windows safeStorage 可用 When 保存并解密 Then 不调用 Linux-only backend', () => {
    for (const platform of ['darwin', 'win32'] as const) {
      const secureStorage = createSecureStorage({
        getSelectedStorageBackend: () => { throw new Error('非 Linux 不应调用 backend') },
      })
      const store = createStore(secureStorage, () => 100, { platform })

      expect(store.replace(firstRequest()).revision).toBe(1)
      expect(store.resolveApiKey('xiaomi-main')).toBe('secret-key')
      rmSync(configPath)
    }
  })

  test('Given 新 ID When 请求 preserve Then 拒绝且不创建目录', () => {
    expect(() => createStore().replace({
      expectedRevision: 0,
      profiles: [{ profile: xiaomiProfile(), credentialUpdate: { mode: 'preserve' } }],
    })).toThrow('AUDIO_GENERATION_CREDENTIAL_PRESERVE_INVALID')
    expect(existsSync(configPath)).toBeFalse()
  })

  test('Given 已有密文且安全存储不可用 When 只改非秘密字段 Then 保留密文并完成 CAS', () => {
    createStore().replace(firstRequest())
    const before = JSON.parse(readFileSync(configPath, 'utf8')) as {
      profiles: Array<{ encryptedApiKey: string }>
    }
    const unavailable = createStore(createSecureStorage({
      isEncryptionAvailable: () => false,
      encryptString: () => { throw new Error('不应重新加密') },
      decryptString: () => { throw new Error('不应解密') },
    }), () => 200)

    const saved = unavailable.replace({
      expectedRevision: 1,
      profiles: [{
        profile: { ...xiaomiProfile(), name: '更新名称', createdAt: 999, updatedAt: 999 },
        credentialUpdate: { mode: 'preserve' },
      }],
    })

    expect(saved.profiles[0]).toMatchObject({ name: '更新名称', createdAt: 10, updatedAt: 200 })
    const after = JSON.parse(readFileSync(configPath, 'utf8')) as {
      profiles: Array<{ encryptedApiKey: string }>
    }
    expect(after.profiles[0]?.encryptedApiKey).toBe(before.profiles[0]?.encryptedApiKey)
  })

  test('Given 目录删除已有条目 When 完整替换 Then 当前文件物理移除对应密文', () => {
    const store = createStore()
    store.replace(firstRequest())
    const ciphertext = Buffer.from('encrypted:secret-key').toString('base64')

    expect(store.replace({ expectedRevision: 1, profiles: [] })).toEqual({
      schemaVersion: 1,
      revision: 2,
      profiles: [],
    })
    expect(readFileSync(configPath, 'utf8')).not.toContain(ciphertext)
  })

  test('Given 已保存凭据 When 按 ID 解析 Then 只解密目标配置', () => {
    const decrypted: string[] = []
    const secureStorage = createSecureStorage({
      decryptString: (value) => {
        decrypted.push(value.toString())
        return value.toString().replace(/^encrypted:/, '')
      },
    })
    const store = createStore(secureStorage)
    store.replace({
      expectedRevision: 0,
      profiles: [
        { profile: xiaomiProfile(), credentialUpdate: { mode: 'replace', apiKey: 'first-secret' } },
        {
          profile: xiaomiProfile({ id: 'xiaomi-backup', name: '备用音色' }),
          credentialUpdate: { mode: 'replace', apiKey: 'second-secret' },
        },
      ],
    })

    expect(store.resolveApiKey('xiaomi-backup')).toBe('second-secret')
    expect(decrypted).toEqual(['encrypted:second-secret'])
  })

  test('Given 解密失败或安全存储不可用 When 解析已保存凭据 Then 返回稳定脱敏错误', () => {
    createStore().replace(firstRequest())

    expect(() => createStore(createSecureStorage({
      decryptString: () => { throw new Error('secret-key 解密失败') },
    })).resolveApiKey('xiaomi-main')).toThrow('AUDIO_GENERATION_CREDENTIAL_DECRYPT_FAILED')
    expect(() => createStore(createSecureStorage({
      isEncryptionAvailable: () => false,
    })).resolveApiKey('xiaomi-main')).toThrow('AUDIO_GENERATION_SECURE_STORAGE_UNAVAILABLE')
    expect(() => createStore().resolveApiKey('missing')).toThrow('AUDIO_GENERATION_PROFILE_NOT_FOUND')
  })

  test('Given 损坏 JSON、未知字段、重复 ID 或非法密文 When 读取 Then 严格拒绝', () => {
    const validProfile = xiaomiProfile()
    const validCiphertext = Buffer.from('encrypted:secret-key').toString('base64')
    const invalidCatalogs: string[] = [
      '{not-json',
      JSON.stringify({ schemaVersion: 2, revision: 0, profiles: [] }),
      JSON.stringify({ schemaVersion: 1, revision: -1, profiles: [] }),
      JSON.stringify({ schemaVersion: 1, revision: 0, profiles: [], unknown: true }),
      JSON.stringify({
        schemaVersion: 1,
        revision: 1,
        profiles: [{ profile: { ...validProfile, name: '' }, encryptedApiKey: validCiphertext }],
      }),
      JSON.stringify({
        schemaVersion: 1,
        revision: 1,
        profiles: [
          { profile: validProfile, encryptedApiKey: validCiphertext },
          { profile: validProfile, encryptedApiKey: validCiphertext },
        ],
      }),
      JSON.stringify({
        schemaVersion: 1,
        revision: 1,
        profiles: [{ profile: validProfile, encryptedApiKey: '%%%not-base64%%%' }],
      }),
      JSON.stringify({
        schemaVersion: 1,
        revision: 1,
        profiles: [{ profile: validProfile, encryptedApiKey: '' }],
      }),
      JSON.stringify({
        schemaVersion: 1,
        revision: 1,
        profiles: [{ profile: validProfile, encryptedApiKey: validCiphertext, plaintext: 'secret-key' }],
      }),
    ]

    for (const contents of invalidCatalogs) {
      writeFileSync(configPath, contents, { mode: 0o600 })
      expect(() => createStore().readPublic()).toThrow('AUDIO_GENERATION_CONFIG_INVALID')
    }
  })

  test('Given 配置路径是符号链接 When 读取 Then 不跟随到外部文件', () => {
    const externalPath = join(directory, 'external.json')
    writeFileSync(externalPath, JSON.stringify({ schemaVersion: 1, revision: 0, profiles: [] }))
    symlinkSync(externalPath, configPath)

    expect(() => createStore().readPublic()).toThrow('AUDIO_GENERATION_CONFIG_INVALID')
  })

  test('Given revision 读取后配置路径被置换 When 提交 Then 拒绝覆盖且保留外部内容', () => {
    createStore().replace(firstRequest())
    const externalContents = JSON.stringify({ external: 'replacement' })
    const replacementPath = join(directory, 'replacement.json')
    const store = createStore(createSecureStorage(), () => 200, {
      beforeCommit: () => {
        writeFileSync(replacementPath, externalContents, { mode: 0o600 })
        renameSync(replacementPath, configPath)
      },
    })

    expect(() => store.replace({
      expectedRevision: 1,
      profiles: [{ profile: xiaomiProfile(), credentialUpdate: { mode: 'preserve' } }],
    })).toThrow('AUDIO_GENERATION_CONFIG_CONFLICT')
    expect(readFileSync(configPath, 'utf8')).toBe(externalContents)
  })

  test('Given revision 读取后同 inode 被原地改写 When 提交 Then 拒绝覆盖且保留外部内容', () => {
    createStore().replace(firstRequest())
    const externalContents = JSON.stringify({ external: 'same-inode-change-with-different-size' })
    const store = createStore(createSecureStorage(), () => 200, {
      beforeCommit: () => { writeFileSync(configPath, externalContents, { mode: 0o600 }) },
    })

    expect(() => store.replace({
      expectedRevision: 1,
      profiles: [{ profile: xiaomiProfile(), credentialUpdate: { mode: 'preserve' } }],
    })).toThrow('AUDIO_GENERATION_CONFIG_CONFLICT')
    expect(readFileSync(configPath, 'utf8')).toBe(externalContents)
  })

  test('Given revision 读取后目标被换成符号链接 When 提交 Then 返回冲突且不跟随链接', () => {
    createStore().replace(firstRequest())
    const externalPath = join(directory, 'external-target.json')
    const externalContents = JSON.stringify({ external: 'symlink-target' })
    writeFileSync(externalPath, externalContents, { mode: 0o600 })
    const store = createStore(createSecureStorage(), () => 200, {
      beforeCommit: () => {
        rmSync(configPath)
        symlinkSync(externalPath, configPath)
      },
    })

    expect(() => store.replace({
      expectedRevision: 1,
      profiles: [{ profile: xiaomiProfile(), credentialUpdate: { mode: 'preserve' } }],
    })).toThrow('AUDIO_GENERATION_CONFIG_CONFLICT')
    expect(readFileSync(externalPath, 'utf8')).toBe(externalContents)
  })

  test('Given rename 已提交但 durability 失败 When 替换 Then 磁盘已推进且返回结果未知', () => {
    createStore().replace(firstRequest())
    const store = createStore(createSecureStorage(), () => 200, {
      writeConfig: (filePath, data, options) => {
        writeJsonFileAtomicSecure(filePath, data, options)
        throw new AtomicWritePostCommitError(
          'mainDurabilityUncertain',
          new Error(`不得公开路径或秘密: ${filePath} secret-key`),
        )
      },
    })

    expect(() => store.replace({
      expectedRevision: 1,
      profiles: [{
        profile: { ...xiaomiProfile(), name: '已提交的新名称' },
        credentialUpdate: { mode: 'preserve' },
      }],
    })).toThrow('AUDIO_GENERATION_CONFIG_OUTCOME_UNKNOWN')
    expect(createStore().readPublic()).toMatchObject({
      revision: 2,
      profiles: [{ name: '已提交的新名称', updatedAt: 200 }],
    })
  })

  test('Given 文件描述符读取期间同 inode 改写 When 读取 Then 返回冲突且不暴露底层错误', () => {
    createStore().replace(firstRequest())
    const externalContents = JSON.stringify({ external: 'read-race-with-different-size' })
    const store = createStore(createSecureStorage(), () => 200, {
      beforeReadFinish: () => { writeFileSync(configPath, externalContents, { mode: 0o600 }) },
    })

    expect(() => store.readPublic()).toThrow('AUDIO_GENERATION_CONFIG_CONFLICT')
    expect(readFileSync(configPath, 'utf8')).toBe(externalContents)
  })

  test('Given 文件或加密结果超过 1 MiB When 读取或保存 Then 拒绝且不提交新目录', () => {
    writeFileSync(configPath, ' '.repeat(1024 * 1024 + 1), { mode: 0o600 })
    expect(() => createStore().readPublic()).toThrow('AUDIO_GENERATION_CONFIG_SIZE_LIMIT')

    rmSync(configPath)
    const oversizedEncryption = createSecureStorage({
      encryptString: () => Buffer.alloc(1024 * 1024),
    })
    expect(() => createStore(oversizedEncryption).replace(firstRequest())).toThrow(
      'AUDIO_GENERATION_CONFIG_SIZE_LIMIT',
    )
    expect(existsSync(configPath)).toBeFalse()
  })

  test('Given 128 条配置 When 保存 Then 接受上限且拒绝第 129 条', () => {
    const profiles = Array.from({ length: 128 }, (_, index) => ({
      profile: xiaomiProfile({ id: `xiaomi-${index}`, name: `音色 ${index}` }),
      credentialUpdate: { mode: 'replace' as const, apiKey: `secret-${index}` },
    }))
    expect(createStore().replace({ expectedRevision: 0, profiles }).profiles).toHaveLength(128)

    expect(() => createStore().replace({
      expectedRevision: 1,
      profiles: [...profiles.map(({ profile }) => ({
        profile,
        credentialUpdate: { mode: 'preserve' as const },
      })), {
        profile: xiaomiProfile({ id: 'xiaomi-over-limit' }),
        credentialUpdate: { mode: 'replace', apiKey: 'secret-over-limit' },
      }],
    })).toThrow('AUDIO_GENERATION_CONFIG_INVALID')
  })

  test('Given 当前时间早于创建时间 When 替换 Then 拒绝非法或回退时间戳且不写文件', () => {
    expect(() => createStore(createSecureStorage(), () => 9).replace(firstRequest())).toThrow(
      'AUDIO_GENERATION_CONFIG_INVALID',
    )
    expect(existsSync(configPath)).toBeFalse()
  })
})
