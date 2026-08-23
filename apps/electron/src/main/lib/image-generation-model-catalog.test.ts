import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ImageGenerationModelProfile, ImageGenerationModelSnapshot } from '@proma/shared'
import {
  IMAGE_GENERATION_MODEL_ID_MAX_LENGTH,
  IMAGE_GENERATION_MODEL_NAME_MAX_LENGTH,
} from '@proma/shared'
import { ImageGenerationModelCatalog } from './image-generation-model-catalog'

/** 测试使用的临时目录，避免模型配置污染真实用户目录。 */
let tempDir = ''
/** 测试目录内的模型目录文件路径。 */
let configPath = ''
/** 可在测试过程中替换的旧 Nano Banana 凭据。 */
let credentials: Record<string, string> = {}

/** 记录凭据快照读取次数的测试目录实例。 */
interface ChangingCredentialsCatalogHarness {
  catalog: ImageGenerationModelCatalog
  getCallCount: () => number
}

/** 创建使用当前测试凭据的模型目录实例。 */
function createCatalog(now = 100): ImageGenerationModelCatalog {
  return new ImageGenerationModelCatalog({
    configPath,
    getNanoBananaCredentials: () => credentials,
    now: () => now,
  })
}

/** 创建每次读取都返回不同值的凭据源，用于验证单次调用快照一致性。 */
function createChangingCredentialsCatalog(): ChangingCredentialsCatalogHarness {
  /** 当前实例累计读取旧凭据的次数。 */
  let callCount = 0
  return {
    catalog: new ImageGenerationModelCatalog({
      configPath,
      getNanoBananaCredentials: () => {
        callCount += 1
        return callCount === 1
          ? { apiKey: 'first-key', model: 'gemini-first' }
          : { apiKey: '   ', model: 'gemini-later' }
      },
      now: () => 100,
    }),
    getCallCount: () => callCount,
  }
}

/** 创建完整且可持久化的模型 profile。 */
function createProfile(
  id: string,
  overrides: Partial<ImageGenerationModelProfile> = {},
): ImageGenerationModelProfile {
  return {
    id,
    name: `模型 ${id}`,
    executor: 'nano-banana',
    modelId: `gemini-${id}`,
    enabled: true,
    createdAt: 10,
    updatedAt: 20,
    ...overrides,
  }
}

/** 直接写入候选目录内容，用于验证严格读取边界。 */
function writeRawConfig(value: string): void {
  writeFileSync(configPath, value, 'utf8')
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'proma-image-model-catalog-'))
  configPath = join(tempDir, 'image-generation-models.json')
  credentials = {}
})

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true })
})

describe('ImageGenerationModelCatalog', () => {
  test('Given 目录文件不存在且旧配置完整 When 列出目录 Then 只读合成旧 Nano Banana 默认项', () => {
    credentials = {
      apiKey: 'key',
      model: 'gemini-custom-image',
      baseUrl: 'https://secret.example.test',
    }

    /** 首次读取时从旧凭据合成的公开目录。 */
    const result = createCatalog(123).listCatalog()

    expect(result).toEqual({
      profiles: [{
        id: 'legacy-nano-banana-default',
        name: 'Nano Banana 默认模型',
        executor: 'nano-banana',
        modelId: 'gemini-custom-image',
        enabled: true,
        createdAt: 123,
        updatedAt: 123,
      }],
      inheritedFromLegacyConfig: true,
      credentialsConfigured: true,
    })
    expect(existsSync(configPath)).toBe(false)
  })

  test('Given 旧配置没有 model When 列出目录 Then 使用稳定默认图片模型', () => {
    credentials = { apiKey: 'key' }

    expect(createCatalog().listCatalog().profiles[0]?.modelId).toBe(
      'gemini-3.1-flash-image-preview',
    )
  })

  test('Given 已有目录 When 完整替换多个 profile Then 原子持久化且新实例可恢复', () => {
    /** 用于证明 safe-file 备份语义的旧目录内容。 */
    const previousFile = { schemaVersion: 1, profiles: [createProfile('old')] }
    writeRawConfig(JSON.stringify(previousFile))
    credentials = { apiKey: ' key ' }
    /** 本次完整替换并持久化的模型列表。 */
    const profiles = [
      createProfile('fast', { name: ' 快速模型 ', modelId: ' gemini-fast ' }),
      createProfile('quality', { enabled: false }),
    ]

    /** replaceProfiles 返回的清洗后公开目录。 */
    const saved = createCatalog().replaceProfiles(profiles)
    /** 从磁盘重建实例后的目录结果。 */
    const restored = createCatalog(999).listCatalog()

    expect(saved).toEqual({
      profiles: [
        createProfile('fast', { name: '快速模型', modelId: 'gemini-fast' }),
        createProfile('quality', { enabled: false }),
      ],
      inheritedFromLegacyConfig: false,
      credentialsConfigured: true,
    })
    expect(restored).toEqual(saved)
    expect(JSON.parse(readFileSync(configPath, 'utf8'))).toEqual({
      schemaVersion: 1,
      profiles: saved.profiles,
    })
    expect(JSON.parse(readFileSync(`${configPath}.bak`, 'utf8'))).toEqual(previousFile)
    expect(existsSync(`${configPath}.tmp`)).toBe(false)
  })

  test('Given 名称和模型 ID 达到共享上限 When 替换并读取目录 Then 完整保留不截断', () => {
    /** 最大合法名称必须在目录和公开结果中保持逐字一致。 */
    const name = '名'.repeat(IMAGE_GENERATION_MODEL_NAME_MAX_LENGTH)
    /** 最大合法模型 ID 必须保持真实执行标识，不能在任何层截断。 */
    const modelId = 'm'.repeat(IMAGE_GENERATION_MODEL_ID_MAX_LENGTH)

    const saved = createCatalog().replaceProfiles([createProfile('maximum', { name, modelId })])

    expect(saved.profiles[0]?.name).toBe(name)
    expect(saved.profiles[0]?.modelId).toBe(modelId)
    expect(createCatalog().listOptions()[0]).toMatchObject({ name, modelId })
  })

  test.each([
    ['name', { name: '名'.repeat(IMAGE_GENERATION_MODEL_NAME_MAX_LENGTH + 1) }],
    ['modelId', { modelId: 'm'.repeat(IMAGE_GENERATION_MODEL_ID_MAX_LENGTH + 1) }],
  ])('Given 已有合法目录 When 替换 profile 的 %s 超限 Then 原子写前拒绝且候选文件不变', (_field, overrides) => {
    /** 写前校验使用的合法主文件原始字节。 */
    const validMain = JSON.stringify({ schemaVersion: 1, profiles: [createProfile('current')] })
    /** 已存在临时候选用于证明失败不会触发 safe-file 轮换。 */
    const validTemp = JSON.stringify({ schemaVersion: 1, profiles: [createProfile('temp')] })
    /** 已存在备份候选用于证明失败不会触发 safe-file 轮换。 */
    const validBackup = JSON.stringify({ schemaVersion: 1, profiles: [createProfile('backup')] })
    writeFileSync(configPath, validMain, 'utf8')
    writeFileSync(`${configPath}.tmp`, validTemp, 'utf8')
    writeFileSync(`${configPath}.bak`, validBackup, 'utf8')

    expect(() => createCatalog().replaceProfiles([createProfile('oversized', overrides)]))
      .toThrow('长度不能超过')
    expect(readFileSync(configPath, 'utf8')).toBe(validMain)
    expect(readFileSync(`${configPath}.tmp`, 'utf8')).toBe(validTemp)
    expect(readFileSync(`${configPath}.bak`, 'utf8')).toBe(validBackup)
  })

  test('Given 主文件损坏且恢复候选合法 When 完整替换 Then 拒绝写入且三份文件逐字节不变', () => {
    /** 故意损坏的主文件原始字节。 */
    const damagedMain = '{"schemaVersion":1,"profiles":['
    /** 已存在的合法临时候选原始字节。 */
    const validTemp = JSON.stringify({ schemaVersion: 1, profiles: [createProfile('temp')] }, null, 2)
    /** 已存在的合法备份候选原始字节。 */
    const validBackup = JSON.stringify({ schemaVersion: 1, profiles: [createProfile('backup')] })
    writeFileSync(configPath, damagedMain, 'utf8')
    writeFileSync(`${configPath}.tmp`, validTemp, 'utf8')
    writeFileSync(`${configPath}.bak`, validBackup, 'utf8')

    expect(() => createCatalog().replaceProfiles([createProfile('replacement')])).toThrow(
      '生图模型目录 JSON 损坏',
    )
    expect(readFileSync(configPath, 'utf8')).toBe(damagedMain)
    expect(readFileSync(`${configPath}.tmp`, 'utf8')).toBe(validTemp)
    expect(readFileSync(`${configPath}.bak`, 'utf8')).toBe(validBackup)
  })

  test('Given legacy 凭据读取时变化 When listCatalog Then 单次快照同时决定 model 与配置状态', () => {
    /** 使用变化凭据源的目录测试实例。 */
    const harness = createChangingCredentialsCatalog()

    /** 单次公开调用返回的目录结果。 */
    const result = harness.catalog.listCatalog()

    expect(harness.getCallCount()).toBe(1)
    expect(result.profiles[0]?.modelId).toBe('gemini-first')
    expect(result.credentialsConfigured).toBe(true)
  })

  test('Given legacy 凭据读取时变化 When listOptions Then 单次快照同时决定 model 与可用性', () => {
    /** 使用变化凭据源的目录测试实例。 */
    const harness = createChangingCredentialsCatalog()

    /** 单次公开调用返回的模型选项。 */
    const options = harness.catalog.listOptions()

    expect(harness.getCallCount()).toBe(1)
    expect(options[0]?.modelId).toBe('gemini-first')
    expect(options[0]?.available).toBe(true)
  })

  test('Given legacy 凭据读取时变化 When resolveAvailableSnapshot Then 使用同一可用凭据快照', () => {
    /** 使用变化凭据源的目录测试实例。 */
    const harness = createChangingCredentialsCatalog()

    /** 单次解析得到的任务模型快照。 */
    const snapshot = harness.catalog.resolveAvailableSnapshot('legacy-nano-banana-default')

    expect(harness.getCallCount()).toBe(1)
    expect(snapshot.modelId).toBe('gemini-first')
  })

  test('Given legacy 凭据读取时变化 When assertSnapshotAvailable Then 使用同一可用凭据快照', () => {
    /** 使用变化凭据源的目录测试实例。 */
    const harness = createChangingCredentialsCatalog()
    /** 与首次凭据快照相符的历史任务快照。 */
    const snapshot: ImageGenerationModelSnapshot = {
      profileId: 'legacy-nano-banana-default',
      name: '历史名称',
      executor: 'nano-banana',
      modelId: 'gemini-first',
    }

    expect(() => harness.catalog.assertSnapshotAvailable(snapshot)).not.toThrow()
    expect(harness.getCallCount()).toBe(1)
  })

  test('Given 已有合法目录且凭据读取时变化 When replaceProfiles Then 只读取一次凭据快照', () => {
    /** 写前必须通过严格校验的当前合法目录。 */
    const currentFile = { schemaVersion: 1, profiles: [createProfile('current')] }
    writeRawConfig(JSON.stringify(currentFile))
    /** 使用变化凭据源的目录测试实例。 */
    const harness = createChangingCredentialsCatalog()

    /** 完整替换后的公开目录结果。 */
    const result = harness.catalog.replaceProfiles([createProfile('replacement')])

    expect(harness.getCallCount()).toBe(1)
    expect(result.credentialsConfigured).toBe(true)
  })

  test('Given API Key 缺失或 profile 停用 When 列出选项 Then 返回明确不可用原因', () => {
    createCatalog().replaceProfiles([
      createProfile('missing-key'),
      createProfile('disabled', { enabled: false }),
    ])

    expect(createCatalog().listOptions()).toEqual([
      {
        profileId: 'missing-key',
        name: '模型 missing-key',
        executor: 'nano-banana',
        modelId: 'gemini-missing-key',
        available: false,
        unavailableReason: 'Nano Banana API Key 未配置',
      },
      {
        profileId: 'disabled',
        name: '模型 disabled',
        executor: 'nano-banana',
        modelId: 'gemini-disabled',
        available: false,
        unavailableReason: '模型已停用',
      },
    ])
  })

  test('Given profile 不存在、停用或凭据缺失 When 解析可用快照 Then 分别明确拒绝', () => {
    credentials = { apiKey: 'key' }
    createCatalog().replaceProfiles([createProfile('disabled', { enabled: false })])

    expect(() => createCatalog().resolveAvailableSnapshot('missing')).toThrow('生图模型不存在')
    expect(() => createCatalog().resolveAvailableSnapshot('disabled')).toThrow('生图模型已停用')

    createCatalog().replaceProfiles([createProfile('enabled')])
    credentials = { apiKey: '   ' }
    expect(() => createCatalog().resolveAvailableSnapshot('enabled')).toThrow(
      'Nano Banana API Key 未配置',
    )
  })

  test('Given 已固化快照 When profile 仅改名 Then 快照仍有效且保留历史名称', () => {
    credentials = { apiKey: 'key' }
    createCatalog().replaceProfiles([createProfile('stable', { name: '旧名称' })])
    /** 任务创建时固化的历史快照。 */
    const snapshot = createCatalog().resolveAvailableSnapshot('stable')

    createCatalog().replaceProfiles([createProfile('stable', { name: '新名称' })])

    expect(() => createCatalog().assertSnapshotAvailable(snapshot)).not.toThrow()
    expect(snapshot.name).toBe('旧名称')
  })

  test('Given 已固化快照 When 当前 profile 或凭据变化 Then 按稳定执行字段拒绝失效快照', () => {
    credentials = { apiKey: 'key' }
    createCatalog().replaceProfiles([createProfile('stable')])
    /** 供多种当前状态变化复用的任务快照。 */
    const snapshot = createCatalog().resolveAvailableSnapshot('stable')

    createCatalog().replaceProfiles([])
    expect(() => createCatalog().assertSnapshotAvailable(snapshot)).toThrow('生图模型不存在')

    createCatalog().replaceProfiles([createProfile('stable', { enabled: false })])
    expect(() => createCatalog().assertSnapshotAvailable(snapshot)).toThrow('生图模型已停用')

    createCatalog().replaceProfiles([createProfile('stable')])
    credentials = {}
    expect(() => createCatalog().assertSnapshotAvailable(snapshot)).toThrow('Nano Banana API Key 未配置')

    credentials = { apiKey: 'key' }
    createCatalog().replaceProfiles([createProfile('stable', { modelId: 'gemini-changed' })])
    expect(() => createCatalog().assertSnapshotAvailable(snapshot)).toThrow('生图模型快照与当前配置不一致')

    /** 编译期之外模拟未来或损坏快照中的未知执行器。 */
    const changedExecutor = { ...snapshot, executor: 'unknown' } as unknown as ImageGenerationModelSnapshot
    createCatalog().replaceProfiles([createProfile('stable')])
    expect(() => createCatalog().assertSnapshotAvailable(changedExecutor)).toThrow(
      '生图模型快照与当前配置不一致',
    )
  })

  test.each([
    ['损坏 JSON', '{', '生图模型目录 JSON 损坏'],
    ['未知 schemaVersion', JSON.stringify({ schemaVersion: 2, profiles: [] }), 'schemaVersion'],
    ['重复 ID', JSON.stringify({ schemaVersion: 1, profiles: [createProfile('dup'), createProfile('dup')] }), 'ID 重复'],
    ['空 name', JSON.stringify({ schemaVersion: 1, profiles: [createProfile('empty-name', { name: '  ' })] }), 'name'],
    ['空 modelId', JSON.stringify({ schemaVersion: 1, profiles: [createProfile('empty-model', { modelId: '' })] }), 'modelId'],
    ['name 超限', JSON.stringify({ schemaVersion: 1, profiles: [createProfile('long-name', { name: '名'.repeat(IMAGE_GENERATION_MODEL_NAME_MAX_LENGTH + 1) })] }), 'name 长度不能超过'],
    ['modelId 超限', JSON.stringify({ schemaVersion: 1, profiles: [createProfile('long-model', { modelId: 'm'.repeat(IMAGE_GENERATION_MODEL_ID_MAX_LENGTH + 1) })] }), 'modelId 长度不能超过'],
    ['未知 executor', JSON.stringify({ schemaVersion: 1, profiles: [{ ...createProfile('unknown'), executor: 'other' }] }), 'executor'],
  ])('Given %s When 读取目录 Then 明确失败且不覆盖原文件', (_caseName, raw, message) => {
    writeRawConfig(raw)

    expect(() => createCatalog().listCatalog()).toThrow(message)
    expect(readFileSync(configPath, 'utf8')).toBe(raw)
    expect(existsSync(`${configPath}.bak`)).toBe(false)
  })

  test('Given 旧 Nano Banana 模型 ID 超限 When 合成兼容目录 Then 明确拒绝且不生成配置文件', () => {
    credentials = {
      apiKey: 'key',
      model: 'm'.repeat(IMAGE_GENERATION_MODEL_ID_MAX_LENGTH + 1),
    }

    expect(() => createCatalog().listCatalog()).toThrow('modelId 长度不能超过')
    expect(existsSync(configPath)).toBe(false)
  })

  test.each([
    ['缺少字段', { id: 'missing-fields' }],
    ['额外字段', { ...createProfile('extra'), secret: 'not-allowed' }],
    ['空 ID', createProfile('   ')],
    ['非布尔 enabled', { ...createProfile('enabled'), enabled: 1 }],
    ['负 createdAt', createProfile('created', { createdAt: -1 })],
    ['非有限 updatedAt', createProfile('updated', { updatedAt: Number.POSITIVE_INFINITY })],
  ])('Given profile %s When 完整替换 Then 拒绝写入不稳定 schema', (_caseName, profile) => {
    expect(() => createCatalog().replaceProfiles([
      profile as unknown as ImageGenerationModelProfile,
    ])).toThrow('生图模型 profile')
    expect(existsSync(configPath)).toBe(false)
  })

  test('Given 凭据与配置路径包含敏感值 When 返回目录、选项和快照 Then 仅暴露公开白名单字段', () => {
    credentials = {
      apiKey: 'super-secret-api-key',
      baseUrl: 'https://secret.example.test',
      model: 'gemini-image',
    }
    /** 三类公开结果的序列化文本，用于统一检查敏感信息泄漏。 */
    const catalog = createCatalog()
    const outputs = [
      catalog.listCatalog(),
      catalog.listOptions(),
      catalog.resolveAvailableSnapshot('legacy-nano-banana-default'),
    ]
    const serialized = JSON.stringify(outputs)

    expect(serialized).not.toContain('super-secret-api-key')
    expect(serialized).not.toContain('https://secret.example.test')
    expect(serialized).not.toContain(configPath)
    expect(serialized).not.toContain('apiKey')
    expect(serialized).not.toContain('baseUrl')
    expect(outputs[2]).toEqual({
      profileId: 'legacy-nano-banana-default',
      name: 'Nano Banana 默认模型',
      executor: 'nano-banana',
      modelId: 'gemini-image',
    })
  })
})
