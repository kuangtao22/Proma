import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { DataRootMigrationProgress } from '@proma/shared'
import { DataRootLocator } from './data-root-locator'
import {
  DataRootMigrationCoordinator,
  DataRootMigrationError,
  type DataRootMigrationCoordinatorOptions,
} from './data-root-migration'
import type { CopyDirectoryInput, CopyDirectoryResult } from './verified-directory-copier'
import { getDirectoryCopySidecarPath } from './verified-directory-copier'

/** 为协调器测试创建的可控依赖集合。 */
interface TestHarness {
  coordinator: DataRootMigrationCoordinator
  locator: DataRootLocator
  lockPath: string
  copyCalls: CopyDirectoryInput[]
  finalizeCalls: Array<{ migrationId: string; targetRoot: string }>
  rebaseCalls: Array<{ sourceRoot: string; targetRoot: string }>
}

describe('DataRootMigrationCoordinator', () => {
  /** 每个用例独立的用户目录。 */
  let homeDir: string
  /** 当前活动数据根。 */
  let sourceRoot: string
  /** 待迁移目标根。 */
  let targetRoot: string

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'proma-data-root-migration-'))
    sourceRoot = join(homeDir, '.proma')
    targetRoot = join(homeDir, 'target')
    mkdirSync(sourceRoot)
    writeFileSync(join(sourceRoot, 'settings.json'), '{"theme":"dark"}')
  })

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true })
  })

  test('Given 预检通过 When 创建计划 Then 持久化 pending 且不提前创建目标目录', async () => {
    const harness = createHarness()

    const plan = await harness.coordinator.createPlan(targetRoot)

    expect(plan.stage).toBe('pending')
    expect(plan.totalBytes).toBe(Buffer.byteLength('{"theme":"dark"}'))
    expect(existsSync(targetRoot)).toBe(false)
    expect(harness.locator.inspect().locatorFile?.migration).toMatchObject({
      id: 'migration-1',
      sourceRoot,
      targetRoot,
      stage: 'pending',
    })
  })

  test('Given pending 迁移 When 完整运行 Then 按阶段切换并在 commit 后 finalize', async () => {
    const stages: string[] = []
    let harness: TestHarness
    harness = createHarness({
      copyDirectory: async (input) => {
        mkdirSync(input.targetRoot, { recursive: true })
        input.onProgress({
          migrationId: input.migrationId,
          stage: 'copying',
          completedBytes: 0,
          totalBytes: 16,
          currentRelativePath: 'settings.json',
        })
        writeFileSync(join(input.targetRoot, 'settings.json'), '{"theme":"dark"}')
        input.onProgress({
          migrationId: input.migrationId,
          stage: 'verifying',
          completedBytes: 16,
          totalBytes: 16,
          currentRelativePath: 'settings.json',
        })
        return { verifiedFiles: 1, reusedFiles: 0, totalBytes: 16 }
      },
      finalizeCopy: async (input) => {
        expect(harness.locator.requireActiveRoot()).toBe(targetRoot)
        expect(harness.locator.inspect().locatorFile?.postCommitCleanup).toMatchObject({ migrationId: input.migrationId })
      },
    })
    await harness.coordinator.createPlan(targetRoot)

    await harness.coordinator.runPending((progress) => stages.push(progress.stage))

    expect(stages).toEqual(['copying', 'copying', 'copying', 'verifying', 'rebasing', 'switching'])
    expect(harness.rebaseCalls).toEqual([{ sourceRoot, targetRoot }])
    expect(harness.finalizeCalls).toEqual([{ migrationId: 'migration-1', targetRoot }])
    expect(harness.locator.inspect().locatorFile).toMatchObject({
      activeRoot: targetRoot,
      previousRoot: sourceRoot,
    })
    expect(harness.locator.inspect().locatorFile?.migration).toBeUndefined()
    expect(harness.locator.inspect().locatorFile?.postCommitCleanup).toBeUndefined()
  })

  test('Given 真实 Task3 和 Task4 依赖 When 运行 Then 复制内容、切换 locator 并清理 sidecar', async () => {
    const progressEvents: DataRootMigrationProgress[] = []
    const externalPath = join(homeDir, 'external-project')
    const workspaceDir = join(sourceRoot, 'agent-workspaces', 'alpha')
    mkdirSync(workspaceDir, { recursive: true })
    writeFileSync(join(sourceRoot, 'agent-sessions.json'), JSON.stringify({
      version: 4,
      sessions: [{
        id: 'session-1', title: '测试会话', createdAt: 1, updatedAt: 2,
        piSessionFile: join(sourceRoot, 'sdk-config', 'sessions', 'a.jsonl'),
        attachedDirectories: [externalPath],
      }],
    }))
    writeFileSync(join(sourceRoot, 'agent-workspaces.json'), JSON.stringify({
      version: 2,
      workspaces: [{ id: 'workspace-1', name: 'Alpha', slug: 'alpha', createdAt: 1, updatedAt: 2 }],
    }))
    writeFileSync(join(workspaceDir, 'config.json'), JSON.stringify({
      attachedFiles: [join(sourceRoot, 'agent-workspaces', 'alpha', 'owned.txt'), externalPath],
      note: `保留普通文本 ${sourceRoot}`,
    }))
    const locator = new DataRootLocator({ homeDir })
    const coordinator = new DataRootMigrationCoordinator({
      locator,
      lockPath: join(homeDir, '.real-migration.lock'),
      createMigrationId: () => 'real-migration',
      getAvailableBytes: async () => 1_000_000,
      isPidRunning: () => false,
    })

    await coordinator.createPlan(targetRoot)
    await coordinator.runPending((progress) => progressEvents.push(progress))

    expect(readFileSync(join(targetRoot, 'settings.json'), 'utf-8')).toBe('{"theme":"dark"}')
    const sessions = JSON.parse(readFileSync(join(targetRoot, 'agent-sessions.json'), 'utf-8')) as {
      sessions: Array<{ piSessionFile: string; attachedDirectories: string[] }>
    }
    const workspaceConfig = JSON.parse(
      readFileSync(join(targetRoot, 'agent-workspaces', 'alpha', 'config.json'), 'utf-8'),
    ) as { attachedFiles: string[]; note: string }
    expect(sessions.sessions[0]?.piSessionFile).toBe(join(targetRoot, 'sdk-config', 'sessions', 'a.jsonl'))
    expect(sessions.sessions[0]?.attachedDirectories).toEqual([externalPath])
    expect(workspaceConfig.attachedFiles).toEqual([
      join(targetRoot, 'agent-workspaces', 'alpha', 'owned.txt'),
      externalPath,
    ])
    expect(workspaceConfig.note).toBe(`保留普通文本 ${sourceRoot}`)
    const stageOrder = ['copying', 'verifying', 'rebasing', 'switching']
    expect(progressEvents.map((progress) => stageOrder.indexOf(progress.stage))).toEqual(
      progressEvents.map((progress) => stageOrder.indexOf(progress.stage)).sort((left, right) => left - right),
    )
    expect(progressEvents.some((progress) => progress.stage === 'verifying')).toBe(true)
    expect(locator.requireActiveRoot()).toBe(targetRoot)
    expect(existsSync(getDirectoryCopySidecarPath(targetRoot))).toBe(false)
  })

  test('Given 复制失败 When 运行 Then 保存 failed 且活动根不切换', async () => {
    const harness = createHarness({ copyDirectory: async () => { throw new Error('磁盘读取失败 /secret/path') } })
    await harness.coordinator.createPlan(targetRoot)

    await expect(harness.coordinator.runPending()).rejects.toBeInstanceOf(DataRootMigrationError)

    expect(harness.locator.requireActiveRoot()).toBe(sourceRoot)
    expect(harness.locator.inspect().locatorFile?.migration).toMatchObject({
      stage: 'failed',
      error: '复制数据失败',
    })
    expect(harness.finalizeCalls).toEqual([])
  })

  test('Given rebase 失败 When 运行 Then 不切换且保留复制 sidecar', async () => {
    const harness = createHarness({ rebaseOwnedPaths: () => { throw new Error('配置写入失败') } })
    await harness.coordinator.createPlan(targetRoot)

    await expect(harness.coordinator.runPending()).rejects.toBeInstanceOf(DataRootMigrationError)

    expect(harness.locator.requireActiveRoot()).toBe(sourceRoot)
    expect(harness.locator.inspect().locatorFile?.migration?.stage).toBe('failed')
    expect(harness.finalizeCalls).toEqual([])
  })

  test('Given 已持久化 switching When 恢复 Then 不重复复制和重写并直接提交', async () => {
    const harness = createHarness()
    mkdirSync(targetRoot)
    harness.locator.write({ version: 1, activeRoot: sourceRoot, migration: createRecord('switching', 16, 16) })

    await harness.coordinator.resumePending()

    expect(harness.copyCalls).toEqual([])
    expect(harness.rebaseCalls).toEqual([])
    expect(harness.locator.requireActiveRoot()).toBe(targetRoot)
    expect(harness.finalizeCalls).toHaveLength(1)
  })

  test('Given 已持久化 verifying 或 rebasing When 恢复 Then 不倒退阶段并从安全边界继续', async () => {
    for (const stage of ['verifying', 'rebasing'] as const) {
      const isolatedTarget = join(homeDir, `target-${stage}`)
      mkdirSync(isolatedTarget)
      const locator = new DataRootLocator({ homeDir: join(homeDir, stage) })
      mkdirSync(join(homeDir, stage))
      mkdirSync(join(homeDir, stage, '.proma'))
      const isolatedSource = join(homeDir, stage, '.proma')
      writeFileSync(join(isolatedSource, 'settings.json'), '{"theme":"dark"}')
      locator.write({ version: 1, activeRoot: isolatedSource, migration: {
        id: `migration-${stage}`,
        sourceRoot: isolatedSource,
        targetRoot: isolatedTarget,
        stage,
        completedBytes: 16,
        totalBytes: 16,
        startedAt: 1,
        updatedAt: 2,
      } })
      const harness = createHarness({ locator, createMigrationId: () => `migration-${stage}` })

      await harness.coordinator.resumePending()

      expect(harness.copyCalls).toEqual([])
      expect(harness.rebaseCalls).toEqual([{ sourceRoot: isolatedSource, targetRoot: isolatedTarget }])
      expect(locator.requireActiveRoot()).toBe(isolatedTarget)
    }
  })

  test('Given commit 后 finalize 失败 When 本次结束和下次恢复 Then 不回滚并幂等清理', async () => {
    let finalizeAttempts = 0
    const first = createHarness({
      finalizeCopy: async () => {
        finalizeAttempts += 1
        throw new Error('sidecar 暂时无法删除')
      },
    })
    await first.coordinator.createPlan(targetRoot)

    await first.coordinator.runPending()

    expect(first.locator.requireActiveRoot()).toBe(targetRoot)
    expect(first.locator.inspect().locatorFile?.migration).toBeUndefined()
    expect(first.locator.inspect().locatorFile?.postCommitCleanup).toBeDefined()

    const second = createHarness({
      locator: first.locator,
      finalizeCopy: async () => { finalizeAttempts += 1 },
    })
    await second.coordinator.resumePending()

    expect(finalizeAttempts).toBe(2)
    expect(second.locator.inspect().locatorFile?.postCommitCleanup).toBeUndefined()
  })

  test('Given copying 进行中 When 取消 Then 中止复制、清除记录并保持源根', async () => {
    let started: (() => void) | undefined
    const copyStarted = new Promise<void>((resolve) => { started = resolve })
    const harness = createHarness({
      copyDirectory: async (input) => {
        started?.()
        await new Promise<void>((resolve, reject) => {
          input.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
          setTimeout(resolve, 2_000)
        })
        return { verifiedFiles: 0, reusedFiles: 0, totalBytes: 16 }
      },
    })
    await harness.coordinator.createPlan(targetRoot)
    const running = harness.coordinator.runPending()
    await copyStarted

    await harness.coordinator.cancel()
    await expect(running).rejects.toMatchObject({ name: 'AbortError' })

    expect(harness.locator.requireActiveRoot()).toBe(sourceRoot)
    expect(harness.locator.inspect().locatorFile?.migration).toBeUndefined()
  })

  test('Given runPending 后立即 cancel When 尚未进入 copier Then latch 不丢失且不切换', async () => {
    const harness = createHarness({
      copyDirectory: async (input) => {
        expect(input.signal?.aborted).toBe(true)
        throw Object.assign(new Error('aborted'), { name: 'AbortError' })
      },
    })
    await harness.coordinator.createPlan(targetRoot)

    const running = harness.coordinator.runPending()
    await harness.coordinator.cancel()
    await expect(running).rejects.toMatchObject({ name: 'AbortError' })

    expect(harness.copyCalls.length === 0 || harness.copyCalls[0]?.signal?.aborted).toBe(true)
    expect(harness.locator.inspect().locatorFile?.migration).toBeUndefined()
    expect(harness.locator.requireActiveRoot()).toBe(sourceRoot)
  })

  test('Given switching 或已提交 When 取消 Then 明确拒绝', async () => {
    const switching = createHarness()
    mkdirSync(targetRoot)
    switching.locator.write({ version: 1, activeRoot: sourceRoot, migration: createRecord('switching', 16, 16) })
    await expect(switching.coordinator.cancel()).rejects.toThrow('切换阶段不能取消')

    switching.locator.commitMigration('migration-1')
    await expect(switching.coordinator.cancel()).rejects.toThrow('没有可取消')
  })

  test('Given 已有运行任务 When 并发 resume Then 第二次调用被拒绝', async () => {
    let release: (() => void) | undefined
    const blocker = new Promise<void>((resolve) => { release = resolve })
    const harness = createHarness({
      copyDirectory: async () => {
        await blocker
        mkdirSync(targetRoot, { recursive: true })
        return { verifiedFiles: 1, reusedFiles: 0, totalBytes: 16 }
      },
    })
    await harness.coordinator.createPlan(targetRoot)
    const firstRun = harness.coordinator.runPending()

    await expect(harness.coordinator.resumePending()).rejects.toThrow('正在运行')
    release?.()
    await firstRun
  })

  test('Given 空间不足 When 创建计划 Then 无目标和 locator 副作用', async () => {
    const harness = createHarness({ getAvailableBytes: async () => 1 })

    await expect(harness.coordinator.createPlan(targetRoot)).rejects.toMatchObject({ code: 'INSUFFICIENT_SPACE' })

    expect(existsSync(targetRoot)).toBe(false)
    expect(existsSync(harness.locator.getLocatorPath())).toBe(false)
    expect(existsSync(harness.lockPath)).toBe(false)
  })

  test('Given 目标由即将生成的 migrationId sidecar 拥有 When 创建计划 Then 接受非空断点目标', async () => {
    mkdirSync(targetRoot)
    writeFileSync(join(targetRoot, 'partial.txt'), 'partial')
    writeFileSync(getDirectoryCopySidecarPath(targetRoot), JSON.stringify({
      version: 1,
      migrationId: 'migration-1',
      sourceRoot: resolve(sourceRoot),
      targetRoot: resolve(targetRoot),
    }))
    const locator = new DataRootLocator({ homeDir })
    const coordinator = new DataRootMigrationCoordinator({
      locator,
      lockPath: join(homeDir, '.owned-plan.lock'),
      createMigrationId: () => 'migration-1',
      getAvailableBytes: async () => 1_000_000,
      isPidRunning: () => false,
    })

    await expect(coordinator.createPlan(targetRoot)).resolves.toMatchObject({ migrationId: 'migration-1' })
  })

  test('Given plan 后空间变为不足 When run 复检 Then 保存 failed 且不调用 copier', async () => {
    let checks = 0
    const harness = createHarness({
      getAvailableBytes: async () => {
        checks += 1
        return checks === 1 ? 1_000_000 : 1
      },
    })
    await harness.coordinator.createPlan(targetRoot)

    await expect(harness.coordinator.runPending()).rejects.toMatchObject({ code: 'INSUFFICIENT_SPACE' })

    expect(harness.copyCalls).toEqual([])
    expect(harness.locator.requireActiveRoot()).toBe(sourceRoot)
    expect(harness.locator.inspect().locatorFile?.migration?.stage).toBe('failed')
  })

  test('Given plan 后目标父目录变为 source 物理 alias When run 复检 Then 不复制也不切换', async () => {
    const targetParent = join(homeDir, 'target-parent')
    const originalParent = join(homeDir, 'target-parent-original')
    const selectedTarget = join(targetParent, 'target')
    mkdirSync(targetParent)
    const harness = createHarness()
    await harness.coordinator.createPlan(selectedTarget)
    renameSync(targetParent, originalParent)
    symlinkSync(sourceRoot, targetParent, 'dir')

    await expect(harness.coordinator.runPending()).rejects.toMatchObject({ code: 'UNSAFE_TARGET' })

    expect(harness.copyCalls).toEqual([])
    expect(harness.locator.requireActiveRoot()).toBe(sourceRoot)
  })

  test('Given plan 后目标父目录失去写权限 When run 复检 Then 不调用 copier', async () => {
    if (process.platform === 'win32') return
    const targetParent = join(homeDir, 'readonly-target-parent')
    const selectedTarget = join(targetParent, 'target')
    mkdirSync(targetParent)
    const harness = createHarness()
    await harness.coordinator.createPlan(selectedTarget)
    chmodSync(targetParent, 0o500)
    try {
      await expect(harness.coordinator.runPending()).rejects.toMatchObject({ code: 'TARGET_NOT_WRITABLE' })
      expect(harness.copyCalls).toEqual([])
      expect(harness.locator.requireActiveRoot()).toBe(sourceRoot)
    } finally {
      chmodSync(targetParent, 0o700)
    }
  })

  test('Given 目标嵌套源根或物理 alias When 创建计划 Then 预检拒绝且无副作用', async () => {
    const harness = createHarness({ inspectCopyOwnership: async () => 'absent' })
    await expect(harness.coordinator.createPlan(join(sourceRoot, 'nested'))).rejects.toMatchObject({ code: 'UNSAFE_TARGET' })
    await expect(harness.coordinator.createPlan(sourceRoot)).rejects.toMatchObject({ code: 'UNSAFE_TARGET' })
    const aliasRoot = join(homeDir, 'source-alias')
    symlinkSync(sourceRoot, aliasRoot, 'dir')
    await expect(harness.coordinator.createPlan(aliasRoot)).rejects.toMatchObject({ code: 'UNSAFE_TARGET' })
    expect(existsSync(harness.locator.getLocatorPath())).toBe(false)
  })

  test('Given 活锁或确认死亡的陈旧锁 When 创建计划 Then 分别拒绝或恢复', async () => {
    const active = createHarness({ isPidRunning: () => true })
    writeFileSync(active.lockPath, JSON.stringify({ version: 1, pid: 42, createdAt: 1, ownerToken: 'active-owner' }))
    await expect(active.coordinator.createPlan(targetRoot)).rejects.toMatchObject({ code: 'MIGRATION_LOCKED' })

    rmSync(active.lockPath)
    const stale = createHarness({ isPidRunning: () => false })
    writeFileSync(stale.lockPath, JSON.stringify({ version: 1, pid: 42, createdAt: 1, ownerToken: 'stale-owner' }))
    await stale.coordinator.createPlan(targetRoot)
    expect(existsSync(stale.lockPath)).toBe(true)
    await stale.coordinator.cancel()
    expect(existsSync(stale.lockPath)).toBe(false)
  })

  test('Given 另一个 contender 持有 recovery mutex When 接管陈旧锁 Then 不删除主锁', async () => {
    const harness = createHarness({ isPidRunning: (pid) => pid === process.pid })
    const staleLock = { version: 1, pid: 42, createdAt: 1, ownerToken: 'stale-owner' }
    const recoveryLock = { version: 1, pid: process.pid, createdAt: 2, ownerToken: 'recovery-owner' }
    writeFileSync(harness.lockPath, JSON.stringify(staleLock))
    writeFileSync(`${harness.lockPath}.recover`, JSON.stringify(recoveryLock))

    await expect(harness.coordinator.createPlan(targetRoot)).rejects.toMatchObject({ code: 'MIGRATION_LOCKED' })

    expect(JSON.parse(readFileSync(harness.lockPath, 'utf-8'))).toEqual(staleLock)
    expect(JSON.parse(readFileSync(`${harness.lockPath}.recover`, 'utf-8'))).toEqual(recoveryLock)
  })

  test('Given 当前 owner 锁在运行中被替换 When 释放 Then 不删除其他 owner 的锁', async () => {
    const harness = createHarness({
      copyDirectory: async () => {
        writeFileSync(harness.lockPath, JSON.stringify({
          version: 1, pid: 99, createdAt: 2, ownerToken: 'replacement-owner',
        }))
        throw new Error('copy failed')
      },
    })
    await harness.coordinator.createPlan(targetRoot)

    await expect(harness.coordinator.runPending()).rejects.toBeInstanceOf(DataRootMigrationError)

    expect(JSON.parse(readFileSync(harness.lockPath, 'utf-8'))).toMatchObject({ ownerToken: 'replacement-owner' })
  })

  test('Given 高频文件进度 When 运行 Then 对外单调且 locator 写入被节流', async () => {
    let now = 1_000
    const events: DataRootMigrationProgress[] = []
    const harness = createHarness({
      now: () => now,
      progressPersistIntervalMs: 100,
      copyDirectory: async (input) => {
        mkdirSync(targetRoot, { recursive: true })
        for (const completedBytes of [1, 2, 3, 16]) {
          input.onProgress({ migrationId: input.migrationId, stage: 'verifying', completedBytes, totalBytes: 16 })
          now += 10
        }
        return { verifiedFiles: 4, reusedFiles: 0, totalBytes: 16 }
      },
    })
    await harness.coordinator.createPlan(targetRoot)
    const originalUpdate = harness.locator.updateMigration.bind(harness.locator)
    let progressWrites = 0
    harness.locator.updateMigration = (migrationId, update) => {
      if (update.completedBytes !== undefined && update.stage === undefined) progressWrites += 1
      return originalUpdate(migrationId, update)
    }

    await harness.coordinator.runPending((progress) => events.push(progress))

    expect(events.every((event, index) => index === 0 || event.completedBytes >= events[index - 1]!.completedBytes)).toBe(true)
    expect(events.map((event) => event.stage)).toEqual([
      'copying', 'copying', 'copying', 'copying', 'copying', 'verifying', 'rebasing', 'switching',
    ])
    expect(progressWrites).toBeLessThan(4)
  })

  test('Given locator 阶段写入失败 When 运行 Then 不会继续到 rebase 或切换', async () => {
    const harness = createHarness()
    await harness.coordinator.createPlan(targetRoot)
    const originalUpdate = harness.locator.updateMigration.bind(harness.locator)
    harness.locator.updateMigration = (migrationId, update) => {
      if (update.stage === 'rebasing') throw new Error('locator write failed')
      return originalUpdate(migrationId, update)
    }

    await expect(harness.coordinator.runPending()).rejects.toBeInstanceOf(DataRootMigrationError)

    expect(harness.rebaseCalls).toEqual([])
    expect(harness.locator.requireActiveRoot()).toBe(sourceRoot)
  })

  test('Given commit locator 写入失败 When 下次 resume Then 保持 switching 并完成切换', async () => {
    const harness = createHarness()
    await harness.coordinator.createPlan(targetRoot)
    const originalCommit = harness.locator.commitMigration.bind(harness.locator)
    let commitAttempts = 0
    harness.locator.commitMigration = (migrationId) => {
      commitAttempts += 1
      if (commitAttempts === 1) throw new Error('locator commit failed')
      return originalCommit(migrationId)
    }

    await expect(harness.coordinator.runPending()).rejects.toMatchObject({ code: 'LOCATOR_WRITE_FAILED' })
    expect(harness.locator.requireActiveRoot()).toBe(sourceRoot)
    expect(harness.locator.inspect().locatorFile?.migration).toMatchObject({
      stage: 'switching',
      error: '切换数据根失败',
    })

    await harness.coordinator.resumePending()
    expect(harness.locator.requireActiveRoot()).toBe(targetRoot)
    expect(commitAttempts).toBe(2)
  })

  test('Given switching 目标或 sidecar 异常 When resume Then 拒绝盲切且活动根保持 source', async () => {
    const harness = createHarness({ inspectCopyOwnership: async () => 'absent' })
    mkdirSync(targetRoot)
    harness.locator.write({ version: 1, activeRoot: sourceRoot, migration: createRecord('switching', 16, 16) })

    await expect(harness.coordinator.resumePending()).rejects.toBeInstanceOf(DataRootMigrationError)

    expect(harness.locator.requireActiveRoot()).toBe(sourceRoot)
    expect(harness.locator.inspect().locatorFile?.migration).toMatchObject({
      stage: 'switching',
      error: '目标副本不属于当前迁移',
    })
  })

  test('Given 节流窗口内文件已提交后复制失败 When 保存 failed Then 立即落盘最后 completedBytes', async () => {
    const harness = createHarness({
      progressPersistIntervalMs: 10_000,
      copyDirectory: async (input) => {
        input.onProgress({
          migrationId: input.migrationId,
          stage: 'verifying',
          completedBytes: 8,
          totalBytes: 16,
          currentRelativePath: 'first.bin',
        })
        throw new Error('second file failed')
      },
    })
    await harness.coordinator.createPlan(targetRoot)

    await expect(harness.coordinator.runPending()).rejects.toBeInstanceOf(DataRootMigrationError)

    expect(harness.locator.inspect().locatorFile?.migration).toMatchObject({
      stage: 'failed',
      completedBytes: 8,
    })
  })

  test('Given failed 记录 When 重复 resume Then 复用同一 migrationId 并最终完成', async () => {
    let attempts = 0
    const harness = createHarness({
      copyDirectory: async (input) => {
        attempts += 1
        if (attempts === 1) throw new Error('first failure')
        mkdirSync(targetRoot, { recursive: true })
        return { verifiedFiles: 1, reusedFiles: 1, totalBytes: 16 }
      },
    })
    await harness.coordinator.createPlan(targetRoot)
    await expect(harness.coordinator.runPending()).rejects.toBeInstanceOf(DataRootMigrationError)

    await harness.coordinator.resumePending()

    expect(harness.copyCalls.map((call) => call.migrationId)).toEqual(['migration-1', 'migration-1'])
    expect(harness.locator.requireActiveRoot()).toBe(targetRoot)
  })

  /** 创建使用真实 locator、可替换执行依赖的协调器。 */
  function createHarness(overrides: Partial<DataRootMigrationCoordinatorOptions> = {}): TestHarness {
    const locator = overrides.locator ?? new DataRootLocator({ homeDir })
    const lockPath = join(homeDir, '.proma-data-root-migration.lock')
    const copyCalls: CopyDirectoryInput[] = []
    const finalizeCalls: Array<{ migrationId: string; targetRoot: string }> = []
    const rebaseCalls: Array<{ sourceRoot: string; targetRoot: string }> = []
    const copyDirectory = overrides.copyDirectory ?? (async (input: CopyDirectoryInput): Promise<CopyDirectoryResult> => {
      mkdirSync(input.targetRoot, { recursive: true })
      writeFileSync(join(input.targetRoot, 'settings.json'), readFileSync(join(input.sourceRoot, 'settings.json')))
      return { verifiedFiles: 1, reusedFiles: 0, totalBytes: 16 }
    })
    const finalizeOverride = overrides.finalizeCopy
    const options: DataRootMigrationCoordinatorOptions = {
      ...overrides,
      locator,
      lockPath,
      createMigrationId: overrides.createMigrationId ?? (() => 'migration-1'),
      now: overrides.now ?? (() => 1_000),
      getAvailableBytes: overrides.getAvailableBytes ?? (async () => 1_000_000),
      isPidRunning: overrides.isPidRunning ?? (() => false),
      copyDirectory: async (input) => {
        copyCalls.push(input)
        return copyDirectory(input)
      },
      rebaseOwnedPaths: (input) => {
        rebaseCalls.push(input)
        return overrides.rebaseOwnedPaths
          ? overrides.rebaseOwnedPaths(input)
          : { inspectedFiles: [], updatedFiles: [] }
      },
      finalizeCopy: async (input) => {
        finalizeCalls.push(input)
        await finalizeOverride?.(input)
      },
      inspectCopyOwnership: overrides.inspectCopyOwnership ?? (async () => 'owned'),
      progressPersistIntervalMs: overrides.progressPersistIntervalMs ?? 250,
    }
    return {
      coordinator: new DataRootMigrationCoordinator(options),
      locator,
      lockPath,
      copyCalls,
      finalizeCalls,
      rebaseCalls,
    }
  }

  /** 创建 locator 可直接接收的迁移记录。 */
  function createRecord(stage: 'switching', completedBytes: number, totalBytes: number) {
    return {
      id: 'migration-1',
      sourceRoot,
      targetRoot,
      stage,
      completedBytes,
      totalBytes,
      startedAt: 1,
      updatedAt: 2,
    }
  }
})
