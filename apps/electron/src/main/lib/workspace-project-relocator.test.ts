import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { AgentSessionMeta, AgentWorkspace, DataRootMigrationProgress, WorktreeInfo } from '@proma/shared'
import { WorkspaceProjectRelocator, type WorkspaceProjectRelocatorOptions } from './workspace-project-relocator'

describe('WorkspaceProjectRelocator', () => {
  /** 每个行为用例隔离的数据根和项目目录。 */
  let tempDir: string
  /** 模拟活动数据根，journal 必须稳定落在其子目录。 */
  let configDir: string
  /** 默认外部项目源目录。 */
  let sourceRoot: string
  /** 默认首次迁移的空目标目录。 */
  let targetRoot: string
  /** 测试中的工作区索引记录。 */
  let workspace: AgentWorkspace
  /** 观察复制调用次数，阻断测试必须保持零。 */
  let copyCalls: number
  /** 观察固定三步提交的执行顺序。 */
  let commitCalls: string[]

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'proma-workspace-relocator-'))
    configDir = join(tempDir, '.proma')
    sourceRoot = join(tempDir, 'source')
    targetRoot = join(tempDir, 'target')
    mkdirSync(configDir, { recursive: true })
    mkdirSync(sourceRoot)
    mkdirSync(targetRoot)
    writeFileSync(join(sourceRoot, 'README.md'), 'data', 'utf8')
    workspace = {
      id: 'workspace-1',
      name: '项目一',
      slug: 'project-one',
      projectRootPath: sourceRoot,
      createdAt: 1,
      updatedAt: 1,
    }
    copyCalls = 0
    commitCalls = []
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  test('Given Proma 托管项目 When 迁出成功 Then 索引切到目标且源目录保留', async () => {
    workspace.projectRootPath = undefined
    /** 托管项目实际文件根。 */
    const managedRoot = join(configDir, 'agent-workspaces', workspace.slug, 'workspace-files')
    mkdirSync(managedRoot, { recursive: true })
    writeFileSync(join(managedRoot, 'managed.txt'), 'managed', 'utf8')
    const relocator = createRelocator({ managedRoot })

    const result = await relocator.run({ workspaceId: workspace.id, targetRoot })

    expect(result.stage).toBe('completed')
    expect((workspace as AgentWorkspace).projectRootPath).toBe(resolve(targetRoot))
    expect(existsSync(managedRoot)).toBe(true)
    expect(commitCalls).toEqual(['sessions', 'config', 'index'])
    expect(relocator.getStatus(workspace.id)).toBeNull()
  })

  test('Given 外部本地项目 When 迁移成功 Then 三类引用按固定顺序提交且源不删除', async () => {
    const relocator = createRelocator()
    /** 收集 workspace 进度阶段，验证 copier 适配与提交完成事件。 */
    const stages: string[] = []

    await relocator.run({ workspaceId: workspace.id, targetRoot }, (progress) => {
      stages.push(progress.stage)
    })

    expect(workspace.projectRootPath).toBe(resolve(targetRoot))
    expect(commitCalls).toEqual(['sessions', 'config', 'index'])
    expect(stages).toEqual(['copying', 'copying', 'verifying', 'verifying', 'committing', 'completed'])
    expect(existsSync(sourceRoot)).toBe(true)
  })

  test('Given 复制校验失败 When 运行迁移 Then 索引仍指旧根且 failed journal 可见', async () => {
    const relocator = createRelocator({
      copyDirectory: async () => {
        copyCalls += 1
        throw new Error('checksum mismatch')
      },
    })

    await expect(relocator.run({ workspaceId: workspace.id, targetRoot })).rejects.toThrow('checksum mismatch')

    expect(workspace.projectRootPath).toBe(sourceRoot)
    expect(commitCalls).toEqual([])
    expect(relocator.getStatus(workspace.id)).toMatchObject({ stage: 'failed', error: 'checksum mismatch' })
  })

  test.each(['copying', 'verifying', 'failed'] as const)(
    'Given 新进程读取 %s journal When 继续迁移 Then 复用原 operationId 和目标副本',
    async (stage) => {
      /** 模拟上个进程留下的稳定操作 ID。 */
      const operationId = '12345678-1234-4234-8234-123456789abc'
      writeRelocationJournal(operationId, {
        stage,
        completedBytes: stage === 'copying' ? 2 : 4,
        ...(stage === 'failed' ? { error: '上次复制中断' } : {}),
      })
      /** 捕获 copier 收到的恢复 ID。 */
      let resumedOperationId = ''
      const relocator = createRelocator({
        createOperationId: () => 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        inspectCopyOwnership: async () => 'owned',
        copyDirectory: async (input) => {
          copyCalls += 1
          resumedOperationId = input.migrationId
          return { verifiedFiles: 1, reusedFiles: 1, totalBytes: 4 }
        },
      })

      const result = await relocator.run({ workspaceId: workspace.id, targetRoot })

      expect(result.operationId).toBe(operationId)
      expect(resumedOperationId).toBe(operationId)
      expect(copyCalls).toBe(1)
    },
  )

  test('Given 同一进程迁移仍在复制 When 再次运行 Then 立即拒绝且不创建第二个控制器', async () => {
    const operationIds = [
      '12345678-1234-4234-8234-123456789abc',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    ]
    let operationIdCalls = 0
    /** 捕获嵌套 run 的拒绝消息。 */
    let duplicateError = ''
    let relocator: WorkspaceProjectRelocator
    relocator = createRelocator({
      createOperationId: () => operationIds[operationIdCalls++]!,
      inspectCopyOwnership: async () => copyCalls > 0 ? 'owned' : 'absent',
      copyDirectory: async () => {
        copyCalls += 1
        if (copyCalls === 1) {
          try {
            await relocator.run({ workspaceId: workspace.id, targetRoot })
          } catch (error) {
            duplicateError = error instanceof Error ? error.message : String(error)
          }
        }
        return { verifiedFiles: 1, reusedFiles: 0, totalBytes: 4 }
      },
    })

    await relocator.run({ workspaceId: workspace.id, targetRoot })

    expect(duplicateError).toContain('正在运行')
    expect(copyCalls).toBe(1)
    expect(operationIdCalls).toBe(1)
  })

  test.each([
    ['active Agent', { hasActiveAgentDataWritesForWorkspace: () => true }],
    ['Automation', { hasRunningAutomationForWorkspace: () => true }],
    ['activeWorktree', { listWorkspaceSessions: () => [{ activeWorktree: { path: '/tmp/wt' } } as AgentSessionMeta] }],
    ['linked worktree', { listWorktrees: async () => [{ path: sourceRoot, isMain: false }] as WorktreeInfo[] }],
  ])('Given %s When 预检迁移 Then 明确阻断且复制未调用', async (_label, overrides) => {
    const relocator = createRelocator(overrides)

    await expect(relocator.run({ workspaceId: workspace.id, targetRoot })).rejects.toThrow()
    expect(copyCalls).toBe(0)
  })

  test('Given 相同、嵌套、非空、空间不足或物理别名目标 When 预检 Then 全部拒绝', async () => {
    /** 源内嵌套目标。 */
    const nestedTarget = join(sourceRoot, 'nested')
    /** 非空目标。 */
    const nonEmptyTarget = join(tempDir, 'non-empty')
    mkdirSync(nestedTarget)
    mkdirSync(nonEmptyTarget)
    writeFileSync(join(nonEmptyTarget, 'occupied'), 'x', 'utf8')
    /** 指向源根的物理别名。 */
    const aliasTarget = join(tempDir, 'alias')
    symlinkSync(sourceRoot, aliasTarget)
    const cases: Array<{ target: string; options?: Partial<WorkspaceProjectRelocatorOptions> }> = [
      { target: sourceRoot },
      { target: nestedTarget },
      { target: nonEmptyTarget },
      { target: join(tempDir, 'small-volume'), options: { inspectTargetVolume: async () => ({ availableBytes: 3, deviceType: 'local' }) } },
      { target: aliasTarget },
    ]

    for (const current of cases) {
      const relocator = createRelocator(current.options)
      await expect(relocator.preflight({ workspaceId: workspace.id, targetRoot: current.target })).rejects.toThrow()
    }
    expect(copyCalls).toBe(0)
  })

  test('Given 首次 active 检查通过但锁后二次检查失败 When 运行 Then 先锁后拒绝并释放', async () => {
    /** 记录锁和活跃检查的线性顺序。 */
    const events: string[] = []
    /** 第一次预检空闲，锁后第二次变为活跃。 */
    let checks = 0
    const relocator = createRelocator({
      hasActiveAgentDataWritesForWorkspace: () => {
        checks += 1
        events.push(`check-${checks}`)
        return checks === 2
      },
      acquireWorkspaceOperation: () => {
        events.push('lock')
        return () => { events.push('release') }
      },
    })

    await expect(relocator.run({ workspaceId: workspace.id, targetRoot })).rejects.toThrow('Agent')

    expect(events).toEqual(['check-1', 'lock', 'check-2', 'release'])
    expect(copyCalls).toBe(0)
  })

  test.each([0, 1, 2])('Given committing journal 在第 %i 步崩溃 When 恢复 Then 幂等完成并清 journal', async (crashStep) => {
    /** 每步第一次执行后故障，恢复时同一步允许再次执行。 */
    const attempts = [0, 0, 0]
    const commit = (step: number, label: string): void => {
      attempts[step] = (attempts[step] ?? 0) + 1
      commitCalls.push(label)
      if (step === crashStep && attempts[step] === 1) throw new Error(`crash-${step}`)
    }
    const relocator = createRelocator({
      rebaseWorkspaceSessionPaths: () => commit(0, 'sessions'),
      rebaseWorkspaceConfigPaths: () => commit(1, 'config'),
      updateAgentWorkspaceProjectRoot: () => {
        workspace.projectRootPath = resolve(targetRoot)
        commit(2, 'index')
      },
    })

    await expect(relocator.run({ workspaceId: workspace.id, targetRoot })).rejects.toThrow(`crash-${crashStep}`)
    expect(relocator.getStatus(workspace.id)?.stage).toBe('committing')

    await relocator.resumeCommittingJournals()

    expect(attempts[crashStep]).toBe(2)
    expect(workspace.projectRootPath).toBe(resolve(targetRoot))
    expect(relocator.getStatus(workspace.id)).toBeNull()
  })

  test.each([
    ['仍有未复制字节', { totalBytes: 4, reusableBytes: 3, remainingBytes: 1 }],
    ['总字节数与 journal 不一致', { totalBytes: 5, reusableBytes: 5, remainingBytes: 0 }],
  ])('Given committing journal 的目标%s When 启动恢复 Then 提交前失败且不执行 rebase', async (_label, copySpace) => {
    /** 先制造第一步提交失败后留下的 committing journal。 */
    const initialRelocator = createRelocator({
      rebaseWorkspaceSessionPaths: () => { throw new Error('crash-before-step') },
    })
    await expect(initialRelocator.run({ workspaceId: workspace.id, targetRoot })).rejects.toThrow('crash-before-step')
    commitCalls = []
    const recoveringRelocator = createRelocator({
      inspectCopyOwnership: async () => 'owned',
      inspectCopySpace: async () => copySpace,
    })

    await expect(recoveringRelocator.resumeCommittingJournals()).rejects.toThrow('完整')

    expect(commitCalls).toEqual([])
    expect(recoveringRelocator.getStatus(workspace.id)?.completedBytes).toBe(4)
  })

  test('Given journal JSON 损坏或路径不合法 When 恢复 Then 不静默提交', async () => {
    /** 与生产实现约定的稳定 journal 目录。 */
    const journalDir = join(configDir, 'workspace-relocations')
    mkdirSync(journalDir)
    writeFileSync(join(journalDir, 'corrupt.json'), '{ bad json', 'utf8')
    const relocator = createRelocator()

    await expect(relocator.resumeCommittingJournals()).rejects.toThrow('journal')
    expect(commitCalls).toEqual([])

    rmSync(join(journalDir, 'corrupt.json'))
    /** 文件名合法但 targetRoot 为相对路径的 schema 非法 journal。 */
    const operationId = '12345678-1234-4234-8234-123456789abc'
    writeFileSync(join(journalDir, `${operationId}.json`), JSON.stringify({
      version: 1,
      operationId,
      workspaceId: workspace.id,
      workspaceSlug: workspace.slug,
      sourceRoot: realpathSync(sourceRoot),
      targetRoot: 'relative-target',
      stage: 'committing',
      completedBytes: 4,
      totalBytes: 4,
      completedCommitSteps: 0,
    }), 'utf8')
    await expect(relocator.resumeCommittingJournals()).rejects.toThrow('journal')
    expect(commitCalls).toEqual([])
  })

  test.each([
    ['包含未知字段', { stage: 'committing', completedBytes: 4, completedCommitSteps: 0, unexpected: true }],
    ['复制阶段已有提交步数', { stage: 'copying', completedBytes: 2, completedCommitSteps: 1 }],
    ['校验阶段字节未完成', { stage: 'verifying', completedBytes: 2, completedCommitSteps: 0 }],
    ['提交阶段字节未完成', { stage: 'committing', completedBytes: 2, completedCommitSteps: 0 }],
  ])('Given journal %s When 读取状态 Then 按精确状态机拒绝', (_label, fields) => {
    const operationId = '12345678-1234-4234-8234-123456789abc'
    writeRelocationJournal(operationId, fields)
    const relocator = createRelocator({ inspectCopyOwnership: async () => 'owned' })

    expect(() => relocator.getStatus(workspace.id)).toThrow('journal')
    expect(commitCalls).toEqual([])
  })

  test.each([
    ['外部项目索引', () => { workspace.projectRootPath = 'relative-source' }, {}],
    ['托管项目 provider', () => { workspace.projectRootPath = undefined }, { managedRoot: 'relative-managed-source' }],
  ] as const)('Given %s 返回相对源路径 When 预检 Then 在路径解析前拒绝', async (_label, prepare, overrides) => {
    prepare()
    /** 若进入 Git 查询则说明相对路径已被错误解析。 */
    let listedWorktrees = false
    const relocator = createRelocator({
      ...overrides,
      listWorktrees: async () => {
        listedWorktrees = true
        return []
      },
    })

    await expect(relocator.preflight({ workspaceId: workspace.id, targetRoot })).rejects.toThrow('源路径必须是绝对路径')
    expect(listedWorktrees).toBe(false)
  })

  test('Given 复制进行中 When 按 operationId 取消 Then AbortSignal 中止且 failed journal 可见', async () => {
    /** copier 已进入等待状态的同步通知。 */
    let notifyCopyStarted: (() => void) | undefined
    const copyStarted = new Promise<void>((resolveStarted) => { notifyCopyStarted = resolveStarted })
    const relocator = createRelocator({
      copyDirectory: async (input) => {
        copyCalls += 1
        notifyCopyStarted?.()
        await new Promise<void>((_resolveCopy, rejectCopy) => {
          input.signal?.addEventListener('abort', () => rejectCopy(new DOMException('aborted', 'AbortError')), { once: true })
        })
        return { verifiedFiles: 0, reusedFiles: 0, totalBytes: 4 }
      },
    })
    const running = relocator.run({ workspaceId: workspace.id, targetRoot })
    await copyStarted
    const operationId = relocator.getStatus(workspace.id)?.operationId
    expect(operationId).toBeString()

    expect(relocator.cancel(operationId!)).toBe(true)
    await expect(running).rejects.toThrow('aborted')
    expect(relocator.getStatus(workspace.id)?.stage).toBe('failed')
  })

  /** 创建带真实 journal I/O 与可观察业务依赖的迁移器。 */
  function createRelocator(overrides: Partial<WorkspaceProjectRelocatorOptions> & { managedRoot?: string } = {}): WorkspaceProjectRelocator {
    /** 默认复制器仅发出真实合同形状的复制/校验进度。 */
    const copyDirectory = overrides.copyDirectory ?? (async (input) => {
      copyCalls += 1
      input.onProgress(createCopyProgress(input.migrationId, 'copying'))
      input.onProgress(createCopyProgress(input.migrationId, 'verifying'))
      return { verifiedFiles: 1, reusedFiles: 0, totalBytes: 4 }
    })
    return new WorkspaceProjectRelocator({
      getConfigDir: () => configDir,
      getWorkspace: (workspaceId) => workspaceId === workspace.id ? workspace : undefined,
      getManagedProjectRoot: () => overrides.managedRoot ?? sourceRoot,
      acquireWorkspaceOperation: () => () => {},
      hasActiveAgentDataWritesForWorkspace: () => false,
      hasRunningAutomationForWorkspace: () => false,
      listWorkspaceSessions: () => [],
      listWorktrees: async () => [],
      copyDirectory,
      inspectCopyOwnership: async () => copyCalls > 0 ? 'owned' : 'absent',
      inspectCopySpace: async () => copyCalls > 0
        ? { totalBytes: 4, reusableBytes: 4, remainingBytes: 0 }
        : { totalBytes: 4, reusableBytes: 0, remainingBytes: 4 },
      scanSourceBytes: async () => 4,
      inspectTargetVolume: async () => ({ availableBytes: 100, deviceType: 'local' }),
      finalizeCopy: async () => {},
      rebaseWorkspaceSessionPaths: () => { commitCalls.push('sessions') },
      rebaseWorkspaceConfigPaths: () => { commitCalls.push('config') },
      updateAgentWorkspaceProjectRoot: (_workspaceId, root) => {
        commitCalls.push('index')
        workspace.projectRootPath = root
      },
      ...overrides,
    })
  }

  /** 写入可按字段覆盖的真实迁移 journal，驱动公开恢复边界测试。 */
  function writeRelocationJournal(operationId: string, fields: Record<string, unknown>): void {
    const journalDirectory = join(configDir, 'workspace-relocations')
    mkdirSync(journalDirectory, { recursive: true })
    writeFileSync(join(journalDirectory, `${operationId}.json`), JSON.stringify({
      version: 1,
      operationId,
      workspaceId: workspace.id,
      workspaceSlug: workspace.slug,
      sourceRoot: realpathSync(sourceRoot),
      targetRoot,
      stage: 'committing',
      completedBytes: 4,
      totalBytes: 4,
      completedCommitSteps: 0,
      ...fields,
    }), 'utf8')
  }
})

/** 构造 copier 原生进度，验证适配层而不复制算法。 */
function createCopyProgress(migrationId: string, stage: 'copying' | 'verifying'): DataRootMigrationProgress {
  return {
    migrationId,
    stage,
    completedBytes: stage === 'copying' ? 2 : 4,
    totalBytes: 4,
    currentRelativePath: 'README.md',
  }
}
