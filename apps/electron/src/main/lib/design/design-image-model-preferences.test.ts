import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ImageGenerationModelOption, ImageGenerationModelSnapshot } from '@proma/shared'
import { DesignImageModelPreferences } from './design-image-model-preferences'
import type { DesignPaths } from './design-paths'

/** 当前测试创建的隔离目录，结束后统一回收。 */
const temporaryRoots: string[] = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** 创建单项目缓存根及偏好路径。 */
function createPaths(root: string, projectId: string): DesignPaths {
  /** 项目独立的 Design 缓存根。 */
  const cacheRoot = join(root, projectId)
  return {
    projectId,
    projectRoot: join(root, 'projects', projectId),
    designRoot: join(root, 'projects', projectId, '.proma', 'design'),
    canvasPath: join(root, 'projects', projectId, '.proma', 'design', 'canvas.json'),
    assetsDir: join(root, 'projects', projectId, '.proma', 'design', 'assets'),
    annotationsDir: join(root, 'projects', projectId, '.proma', 'design', 'annotations'),
    cacheRoot,
    preferencesPath: join(cacheRoot, 'preferences.json'),
    thumbnailsDir: join(cacheRoot, 'thumbnails'),
    jobsDir: join(cacheRoot, 'jobs'),
    stagingDir: join(cacheRoot, 'staging'),
  }
}

/** 创建可用或不可用的公开模型选项。 */
function createOption(profileId: string, available = true): ImageGenerationModelOption {
  return {
    profileId,
    name: `模型 ${profileId}`,
    executor: 'nano-banana',
    modelId: `model-${profileId}`,
    available,
    ...(available ? {} : { unavailableReason: '模型已停用' }),
  }
}

/** 创建只暴露公开模型字段的任务快照。 */
function createSnapshot(profileId: string): ImageGenerationModelSnapshot {
  return {
    profileId,
    name: `模型 ${profileId}`,
    executor: 'nano-banana',
    modelId: `model-${profileId}`,
  }
}

/** 创建带项目隔离路径和可变 Catalog 的偏好服务 fixture。 */
function createFixture(options: ImageGenerationModelOption[]) {
  /** 本用例独立的配置根。 */
  const root = mkdtempSync(join(tmpdir(), 'proma-design-preferences-'))
  temporaryRoots.push(root)
  /** Catalog 当前公开的清洗选项。 */
  let currentOptions = options
  /** 构造服务所需的窄依赖。 */
  const createService = (): DesignImageModelPreferences => new DesignImageModelPreferences({
    pathResolver: { resolve: (projectId) => createPaths(root, projectId) },
    imageModels: {
      listOptions: () => currentOptions.map((option) => ({ ...option })),
      resolveAvailableSnapshot: (profileId) => {
        /** 只有当前 available 选项可解析为快照。 */
        const option = currentOptions.find((candidate) => candidate.profileId === profileId)
        if (!option?.available) throw new Error(`生图模型不可用: ${profileId}`)
        return createSnapshot(profileId)
      },
    },
    now: () => 123,
  })
  return {
    root,
    createService,
    setOptions: (nextOptions: ImageGenerationModelOption[]) => { currentOptions = nextOptions },
  }
}

describe('Design 项目生图模型偏好', () => {
  test('Given 偏好文件不存在 When 读取 Then 选择首个可用模型但不落盘', () => {
    const fixture = createFixture([
      createOption('disabled', false),
      createOption('profile-a'),
      createOption('profile-b'),
    ])

    const selection = fixture.createService().getSelection('project-a')

    expect(selection).toEqual({
      projectId: 'project-a',
      options: [createOption('disabled', false), createOption('profile-a'), createOption('profile-b')],
      selectedProfileId: 'profile-a',
    })
    expect(existsSync(createPaths(fixture.root, 'project-a').preferencesPath)).toBe(false)
  })

  test('Given 偏好文件不存在且没有可用模型 When 读取 Then 保留未选择且不落盘', () => {
    const fixture = createFixture([createOption('disabled', false)])

    const selection = fixture.createService().getSelection('project-a')

    expect(selection.selectedProfileId).toBeUndefined()
    expect(selection.invalidSelectedProfileId).toBeUndefined()
    expect(existsSync(createPaths(fixture.root, 'project-a').preferencesPath)).toBe(false)
  })

  test('Given 两个项目选择不同模型 When 新实例读取 Then 各自恢复且互不串线', () => {
    const fixture = createFixture([createOption('profile-a'), createOption('profile-b')])
    const service = fixture.createService()

    service.setSelection({ projectId: 'project-a', imageModelProfileId: 'profile-a' })
    service.setSelection({ projectId: 'project-b', imageModelProfileId: 'profile-b' })
    const restarted = fixture.createService()

    expect(restarted.getSelection('project-a').selectedProfileId).toBe('profile-a')
    expect(restarted.getSelection('project-b').selectedProfileId).toBe('profile-b')
    expect(JSON.parse(readFileSync(createPaths(fixture.root, 'project-a').preferencesPath, 'utf8'))).toEqual({
      schemaVersion: 1,
      imageModelProfileId: 'profile-a',
      updatedAt: 123,
    })
  })

  test('Given 已选模型被删除、停用或凭据失效 When 读取 Then 保留无效 ID 且不回退改盘', () => {
    const fixture = createFixture([createOption('profile-a'), createOption('profile-b')])
    fixture.createService().setSelection({ projectId: 'project-a', imageModelProfileId: 'profile-b' })
    /** 模拟原 profile 仍存在但已因停用或凭据失效不可用。 */
    fixture.setOptions([createOption('profile-a'), createOption('profile-b', false)])
    /** 读取前固定磁盘文本，验证服务不会自动修复。 */
    const preferencesPath = createPaths(fixture.root, 'project-a').preferencesPath
    const before = readFileSync(preferencesPath, 'utf8')

    const selection = fixture.createService().getSelection('project-a')

    expect(selection.selectedProfileId).toBeUndefined()
    expect(selection.invalidSelectedProfileId).toBe('profile-b')
    expect(readFileSync(preferencesPath, 'utf8')).toBe(before)

    /** profile 从目录删除后仍保留原 ID，不自动选择其它可用项。 */
    fixture.setOptions([createOption('profile-a')])
    const deletedSelection = fixture.createService().getSelection('project-a')
    expect(deletedSelection.selectedProfileId).toBeUndefined()
    expect(deletedSelection.invalidSelectedProfileId).toBe('profile-b')
    expect(readFileSync(preferencesPath, 'utf8')).toBe(before)
  })

  test('Given 偏好文件损坏或未知版本 When 读取或设置 Then 明确失败且拒绝覆盖', () => {
    const fixture = createFixture([createOption('profile-a')])
    /** 已存在的损坏主文件是唯一事实，不允许从候选恢复。 */
    const preferencesPath = createPaths(fixture.root, 'project-a').preferencesPath
    mkdirSync(createPaths(fixture.root, 'project-a').cacheRoot, { recursive: true })
    writeFileSync(preferencesPath, JSON.stringify({ schemaVersion: 2, imageModelProfileId: 'profile-a', updatedAt: 1 }))

    expect(() => fixture.createService().getSelection('project-a')).toThrow('schemaVersion')
    expect(() => fixture.createService().setSelection({
      projectId: 'project-a',
      imageModelProfileId: 'profile-a',
    })).toThrow('schemaVersion')
    expect(JSON.parse(readFileSync(preferencesPath, 'utf8')).schemaVersion).toBe(2)
  })

  test('Given 偏好根结构夹带未知字段 When 读取 Then 严格拒绝', () => {
    const fixture = createFixture([createOption('profile-a')])
    const preferencesPath = createPaths(fixture.root, 'project-a').preferencesPath
    mkdirSync(createPaths(fixture.root, 'project-a').cacheRoot, { recursive: true })
    writeFileSync(preferencesPath, JSON.stringify({
      schemaVersion: 1,
      imageModelProfileId: 'profile-a',
      updatedAt: 1,
      credentials: 'forged-secret',
    }))

    expect(() => fixture.createService().getSelection('project-a')).toThrow('字段')
  })

  test('Given 原子写失败 When 设置 Then 不广播选择变化', () => {
    const fixture = createFixture([createOption('profile-a')])
    /** 用普通文件占据缓存根，使目录创建或写入稳定失败。 */
    writeFileSync(createPaths(fixture.root, 'project-a').cacheRoot, 'not-a-directory')
    const service = fixture.createService()
    /** 收集成功写入后才允许出现的业务事件。 */
    const events: Array<{ projectId: string }> = []
    service.onChanged((event) => events.push(event))

    expect(() => service.setSelection({
      projectId: 'project-a',
      imageModelProfileId: 'profile-a',
    })).toThrow()
    expect(events).toEqual([])
  })

  test('Given 时钟返回非法时间 When 设置 Then 在落盘和广播前拒绝', () => {
    const fixture = createFixture([createOption('profile-a')])
    /** 使用异常时钟构造服务，验证持久化 schema 在写前成立。 */
    const service = new DesignImageModelPreferences({
      pathResolver: { resolve: (projectId) => createPaths(fixture.root, projectId) },
      imageModels: {
        listOptions: () => [createOption('profile-a')],
        resolveAvailableSnapshot: () => createSnapshot('profile-a'),
      },
      now: () => Number.NaN,
    })
    /** 非法时间不得产生成功变化事件。 */
    const events: Array<{ projectId: string }> = []
    service.onChanged((event) => events.push(event))

    expect(() => service.setSelection({
      projectId: 'project-a', imageModelProfileId: 'profile-a',
    })).toThrow('updatedAt')
    expect(existsSync(createPaths(fixture.root, 'project-a').preferencesPath)).toBe(false)
    expect(events).toEqual([])
  })
})
