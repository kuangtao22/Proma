import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { DataRootMigrationProgress } from '@proma/shared'
import {
  copyDirectoryVerified,
  finalizeDirectoryCopy,
  getDirectoryCopySidecarPath,
  hashFile,
  type CopyDirectoryResult,
} from './verified-directory-copier'

/** 返回目标根外、与目标路径稳定绑定的迁移 sidecar 路径。 */
function getSidecarPath(targetRoot: string): string {
  return getDirectoryCopySidecarPath(targetRoot)
}

/** 为单个测试创建的源目录与目标目录。 */
interface CopyFixture {
  sourceRoot: string
  targetRoot: string
}

/** 创建彼此隔离的复制测试目录。 */
function createFixture(testRoot: string): CopyFixture {
  /** 当前测试使用的源目录。 */
  const sourceRoot = join(testRoot, 'source')
  /** 当前测试使用的目标目录。 */
  const targetRoot = join(testRoot, 'target')
  mkdirSync(sourceRoot)
  return { sourceRoot, targetRoot }
}

/** 使用固定迁移标识执行目录复制。 */
function copyFixture(
  fixture: CopyFixture,
  options: Partial<Pick<Parameters<typeof copyDirectoryVerified>[0], 'signal' | 'onProgress' | 'concurrency'>> = {},
): Promise<CopyDirectoryResult> {
  return copyDirectoryVerified({
    migrationId: 'migration-current',
    ...fixture,
    onProgress: options.onProgress ?? (() => {}),
    signal: options.signal,
    concurrency: options.concurrency,
  })
}

describe('verified-directory-copier', () => {
  /** 每个用例独立使用的临时根目录。 */
  let testRoot: string

  beforeEach(() => {
    testRoot = mkdtempSync(join(tmpdir(), 'proma-verified-copy-'))
  })

  afterEach(() => {
    rmSync(testRoot, { recursive: true, force: true })
  })

  test('Given 普通文件、Unicode 路径与外部符号链接 When 复制并校验 Then 内容一致且链接不被跟随', async () => {
    /** 当前用例的源目录和目标目录。 */
    const fixture = createFixture(testRoot)
    /** 位于源目录外部、禁止被递归跟随的文件。 */
    const externalTarget = join(testRoot, 'outside.txt')
    writeFileSync(externalTarget, 'outside-secret')
    mkdirSync(join(fixture.sourceRoot, '含 空格'))
    writeFileSync(join(fixture.sourceRoot, '含 空格', '数据.txt'), 'hello 世界')
    symlinkSync(externalTarget, join(fixture.sourceRoot, 'external-link'))

    /** 完成复制后的校验统计。 */
    const result = await copyFixture(fixture)

    expect(result).toEqual({ verifiedFiles: 2, reusedFiles: 0, totalBytes: 12 })
    expect(readFileSync(join(fixture.targetRoot, '含 空格', '数据.txt'), 'utf-8')).toBe('hello 世界')
    expect(readlinkSync(join(fixture.targetRoot, 'external-link'))).toBe(externalTarget)
    expect(await hashFile(join(fixture.targetRoot, '含 空格', '数据.txt'))).toBe(
      await hashFile(join(fixture.sourceRoot, '含 空格', '数据.txt')),
    )
    expect(readdirSync(fixture.targetRoot).some((name) => name.includes('directory-copy'))).toBe(false)
    expect(existsSync(getSidecarPath(fixture.targetRoot))).toBe(true)
  })

  test('Given 同迁移留下的完整目标 When 恢复迁移 Then 复用哈希一致的文件和链接', async () => {
    /** 当前用例的源目录和目标目录。 */
    const fixture = createFixture(testRoot)
    writeFileSync(join(fixture.sourceRoot, 'stable.txt'), 'stable')
    symlinkSync('stable.txt', join(fixture.sourceRoot, 'stable-link'))
    await copyFixture(fixture)

    /** 恢复执行后的复用统计。 */
    const result = await copyFixture(fixture)

    expect(result).toEqual({ verifiedFiles: 2, reusedFiles: 2, totalBytes: 6 })
  })

  test('Given 同迁移目标残留已从源删除的文件 When 恢复复制 Then 精确清理残留而不复活旧数据', async () => {
    /** 当前用例的源目录和目标目录。 */
    const fixture = createFixture(testRoot)
    writeFileSync(join(fixture.sourceRoot, 'keep.txt'), 'keep')
    writeFileSync(join(fixture.sourceRoot, 'deleted.txt'), 'deleted')
    await copyFixture(fixture)
    unlinkSync(join(fixture.sourceRoot, 'deleted.txt'))

    /** 源删除文件后的恢复结果。 */
    const result = await copyFixture(fixture)

    expect(result).toEqual({ verifiedFiles: 1, reusedFiles: 1, totalBytes: 4 })
    expect(existsSync(join(fixture.targetRoot, 'deleted.txt'))).toBe(false)
  })

  test('Given 复制成功且重复恢复 When 显式 finalize Then sidecar 全部清理且数据保留', async () => {
    /** 当前用例的源目录和目标目录。 */
    const fixture = createFixture(testRoot)
    writeFileSync(join(fixture.sourceRoot, 'stable.txt'), 'stable')
    await copyFixture(fixture)
    /** 同 migrationId 的重复执行结果。 */
    const repeated = await copyFixture(fixture)
    /** 目标根外的主 sidecar 路径。 */
    const sidecarPath = getSidecarPath(fixture.targetRoot)

    expect(repeated.reusedFiles).toBe(1)
    expect(existsSync(sidecarPath)).toBe(true)
    await finalizeDirectoryCopy({
      migrationId: 'migration-current',
      targetRoot: fixture.targetRoot,
    })
    expect(existsSync(sidecarPath)).toBe(false)
    expect(existsSync(`${sidecarPath}.tmp`)).toBe(false)
    expect(existsSync(`${sidecarPath}.bak`)).toBe(false)
    expect(readFileSync(join(fixture.targetRoot, 'stable.txt'), 'utf-8')).toBe('stable')
  })

  test('Given 空源目录与经符号链接父目录指回源的目标别名 When 复制 Then copier 自身拒绝物理同路径', async () => {
    if (process.platform === 'win32') return
    /** 当前用例的源目录和目标目录。 */
    const fixture = createFixture(testRoot)
    /** 指回测试根的父目录符号链接。 */
    const aliasParent = join(testRoot, 'alias-parent')
    symlinkSync(testRoot, aliasParent, 'dir')
    /** 经符号链接父目录解析后与 sourceRoot 相同的目标。 */
    const aliasedTarget = join(aliasParent, 'source')

    await expect(copyDirectoryVerified({
      migrationId: 'migration-current',
      sourceRoot: fixture.sourceRoot,
      targetRoot: aliasedTarget,
      onProgress: () => {},
    })).rejects.toThrow('物理路径')
  })

  test('Given 不同迁移标识的目标 marker When 开始复制 Then 拒绝接管目标', async () => {
    /** 当前用例的源目录和目标目录。 */
    const fixture = createFixture(testRoot)
    writeFileSync(join(fixture.sourceRoot, 'file.txt'), 'content')
    await copyDirectoryVerified({
      migrationId: 'migration-old',
      ...fixture,
      onProgress: () => {},
    })

    await expect(copyFixture(fixture)).rejects.toThrow('迁移标识')
  })

  test('Given 非空且没有 marker 的目标 When 开始复制 Then 拒绝覆盖未知内容', async () => {
    /** 当前用例的源目录和目标目录。 */
    const fixture = createFixture(testRoot)
    mkdirSync(fixture.targetRoot)
    writeFileSync(join(fixture.targetRoot, 'unknown.txt'), 'do-not-touch')

    await expect(copyFixture(fixture)).rejects.toThrow('非空')
    expect(readFileSync(join(fixture.targetRoot, 'unknown.txt'), 'utf-8')).toBe('do-not-touch')
  })

  test('Given schema 非法的 marker When 恢复复制 Then 拒绝信任目标内容', async () => {
    /** 当前用例的源目录和目标目录。 */
    const fixture = createFixture(testRoot)
    mkdirSync(fixture.targetRoot)
    writeFileSync(getSidecarPath(fixture.targetRoot), JSON.stringify({ migrationId: 'migration-current' }))

    await expect(copyFixture(fixture)).rejects.toThrow('marker')
  })

  test('Given 原子写只留下有效 tmp marker When 恢复复制 Then 提升断点并继续', async () => {
    /** 当前用例的源目录和目标目录。 */
    const fixture = createFixture(testRoot)
    mkdirSync(fixture.targetRoot)
    writeFileSync(join(fixture.sourceRoot, 'resume.txt'), 'resume')
    /** 模拟 rename 前崩溃留下的严格 marker 内容。 */
    const marker = {
      version: 1,
      migrationId: 'migration-current',
      sourceRoot: resolve(fixture.sourceRoot),
      targetRoot: resolve(fixture.targetRoot),
    }
    writeFileSync(`${getSidecarPath(fixture.targetRoot)}.tmp`, JSON.stringify(marker))

    /** 从临时 marker 恢复后的复制结果。 */
    const result = await copyFixture(fixture)

    expect(result.verifiedFiles).toBe(1)
    expect(existsSync(getSidecarPath(fixture.targetRoot))).toBe(true)
  })

  test('Given main marker 是根外符号链接且 tmp 有效 When 恢复复制 Then 整体拒绝且不触碰根外文件', async () => {
    /** 当前用例的源目录和目标目录。 */
    const fixture = createFixture(testRoot)
    mkdirSync(fixture.targetRoot)
    writeFileSync(join(fixture.sourceRoot, 'resume.txt'), 'resume')
    /** 位于目标根外、不得被 safe-file 跟随读取或改写的文件。 */
    const outsideMarker = join(testRoot, 'outside-marker.json')
    writeFileSync(outsideMarker, 'outside-must-stay')
    /** 模拟 rename 前崩溃留下的合法临时 marker。 */
    const validMarker = {
      version: 1,
      migrationId: 'migration-current',
      sourceRoot: resolve(fixture.sourceRoot),
      targetRoot: resolve(fixture.targetRoot),
    }
    /** 恶意主 marker 指向目标根之外。 */
    const markerPath = getSidecarPath(fixture.targetRoot)
    symlinkSync(outsideMarker, markerPath)
    writeFileSync(`${markerPath}.tmp`, JSON.stringify(validMarker))

    await expect(copyFixture(fixture)).rejects.toThrow('普通文件')
    expect(readFileSync(outsideMarker, 'utf-8')).toBe('outside-must-stay')
  })

  test('Given 平台支持 FIFO 且 bak marker 是 FIFO When main 有效 Then 仍整体拒绝且不读取 FIFO', async () => {
    if (process.platform === 'win32') return
    /** 当前用例的源目录和目标目录。 */
    const fixture = createFixture(testRoot)
    mkdirSync(fixture.targetRoot)
    /** 可独立通过 schema 校验的主 marker。 */
    const validMarker = {
      version: 1,
      migrationId: 'migration-current',
      sourceRoot: resolve(fixture.sourceRoot),
      targetRoot: resolve(fixture.targetRoot),
    }
    /** 主 marker 路径及其恶意 FIFO 备份候选。 */
    const markerPath = getSidecarPath(fixture.targetRoot)
    writeFileSync(markerPath, JSON.stringify(validMarker))
    /** 创建特殊备份候选的系统命令结果。 */
    const created = Bun.spawnSync(['mkfifo', `${markerPath}.bak`])
    if (created.exitCode !== 0) return

    await expect(copyFixture(fixture)).rejects.toThrow('普通文件')
  })

  test('Given 平台支持 FIFO When 扫描特殊文件 Then 明确拒绝不完整迁移', async () => {
    if (process.platform === 'win32') return
    /** 当前用例的源目录和目标目录。 */
    const fixture = createFixture(testRoot)
    /** 用于验证特殊文件拒绝逻辑的 FIFO 路径。 */
    const fifoPath = join(fixture.sourceRoot, 'events.fifo')
    /** 调用系统 mkfifo 创建特殊文件的结果。 */
    const created = Bun.spawnSync(['mkfifo', fifoPath])
    if (created.exitCode !== 0) return

    await expect(copyFixture(fixture)).rejects.toThrow('特殊文件')
  })

  test('Given 复制进行中收到取消信号 When 当前数据块结束 Then 抛出 AbortError 并保留断点', async () => {
    /** 当前用例的源目录和目标目录。 */
    const fixture = createFixture(testRoot)
    /** 足以产生多个固定缓冲数据块的测试内容。 */
    const largeContent = Buffer.alloc(512 * 1024, 7)
    writeFileSync(join(fixture.sourceRoot, 'large.bin'), largeContent)
    /** 控制复制中断时机的取消控制器。 */
    const controller = new AbortController()

    /** 复制 Promise，在收到首个数据块进度后被取消。 */
    const copying = copyFixture(fixture, {
      signal: controller.signal,
      onProgress: (progress) => {
        if (progress.stage === 'copying' && progress.completedBytes > 0) controller.abort()
      },
    })

    await expect(copying).rejects.toMatchObject({ name: 'AbortError' })
    expect(existsSync(getSidecarPath(fixture.targetRoot))).toBe(true)
    expect(existsSync(join(fixture.targetRoot, 'large.bin'))).toBe(false)
    await Bun.sleep(50)
    expect(readdirSync(fixture.targetRoot).some((name) => name.includes('.proma-copy-'))).toBe(false)
  })

  test('Given 首次校验发现目标损坏 When 自动重拷 Then 仅重试该文件并成功', async () => {
    /** 当前用例的源目录和目标目录。 */
    const fixture = createFixture(testRoot)
    writeFileSync(join(fixture.sourceRoot, 'retry.txt'), 'correct-content')
    /** 是否已经制造过首次校验损坏。 */
    let corruptedOnce = false

    /** 首次校验被破坏后完成重试的结果。 */
    const result = await copyFixture(fixture, {
      onProgress: (progress) => {
        if (progress.stage === 'verifying' && !corruptedOnce) {
          corruptedOnce = true
          writeFileSync(join(fixture.targetRoot, 'retry.txt'), 'corrupted')
        }
      },
    })

    expect(result.verifiedFiles).toBe(1)
    expect(readFileSync(join(fixture.targetRoot, 'retry.txt'), 'utf-8')).toBe('correct-content')
  })

  test('Given 两次校验都发现目标损坏 When 单文件重试耗尽 Then 明确失败', async () => {
    /** 当前用例的源目录和目标目录。 */
    const fixture = createFixture(testRoot)
    writeFileSync(join(fixture.sourceRoot, 'always-bad.txt'), 'correct-content')
    /** 校验阶段主动破坏目标的次数。 */
    let corruptionCount = 0

    await expect(copyFixture(fixture, {
      onProgress: (progress) => {
        if (progress.stage === 'verifying') {
          corruptionCount += 1
          writeFileSync(join(fixture.targetRoot, 'always-bad.txt'), `corrupted-${corruptionCount}`)
        }
      },
    })).rejects.toThrow('校验失败')
    expect(corruptionCount).toBe(2)
  })

  test('Given 首次符号链接校验发现目标链接损坏 When 自动重建 Then 只重试该链接并成功', async () => {
    /** 当前用例的源目录和目标目录。 */
    const fixture = createFixture(testRoot)
    symlinkSync('expected-target', join(fixture.sourceRoot, 'retry-link'))
    /** 目标链接被验证的次数。 */
    let verificationCount = 0

    /** 首次链接损坏后完成局部重建的结果。 */
    const result = await copyFixture(fixture, {
      onProgress: (progress) => {
        if (progress.stage !== 'verifying') return
        verificationCount += 1
        if (verificationCount !== 1) return
        /** 当前验证回调中需要替换的目标链接。 */
        const targetLink = join(fixture.targetRoot, 'retry-link')
        unlinkSync(targetLink)
        symlinkSync('wrong-target', targetLink)
      },
    })

    expect(result.verifiedFiles).toBe(1)
    expect(verificationCount).toBe(2)
    expect(readlinkSync(join(fixture.targetRoot, 'retry-link'))).toBe('expected-target')
  })

  test('Given 两次符号链接校验都发现目标损坏 When 链接重试耗尽 Then 明确失败', async () => {
    /** 当前用例的源目录和目标目录。 */
    const fixture = createFixture(testRoot)
    symlinkSync('expected-target', join(fixture.sourceRoot, 'always-bad-link'))
    /** 每次验证阶段主动替换目标链接的计数。 */
    let corruptionCount = 0

    await expect(copyFixture(fixture, {
      onProgress: (progress) => {
        if (progress.stage !== 'verifying') return
        corruptionCount += 1
        /** 当前验证回调中需要替换的目标链接。 */
        const targetLink = join(fixture.targetRoot, 'always-bad-link')
        unlinkSync(targetLink)
        symlinkSync(`wrong-target-${corruptionCount}`, targetLink)
      },
    })).rejects.toThrow('符号链接校验失败')
    expect(corruptionCount).toBe(2)
  })

  test('Given 复制中目标目录被替换为根外符号链接 When 原子提交文件 Then 身份复验失败且根外保持为空', async () => {
    if (process.platform === 'win32') return
    /** 当前用例的源目录和目标目录。 */
    const fixture = createFixture(testRoot)
    mkdirSync(join(fixture.sourceRoot, 'nested'))
    writeFileSync(join(fixture.sourceRoot, 'nested', 'large.bin'), Buffer.alloc(512 * 1024, 3))
    /** 竞态攻击试图引导写入的根外目录。 */
    const outsideDirectory = join(testRoot, 'outside-directory')
    mkdirSync(outsideDirectory)
    /** 是否已经在复制数据块回调中替换过目标目录。 */
    let replacedDirectory = false

    await expect(copyFixture(fixture, {
      concurrency: 1,
      onProgress: (progress) => {
        if (progress.stage !== 'copying' || replacedDirectory) return
        replacedDirectory = true
        /** 原目标目录被移走后的保留路径。 */
        const displacedDirectory = join(fixture.targetRoot, 'nested-displaced')
        renameSync(join(fixture.targetRoot, 'nested'), displacedDirectory)
        symlinkSync(outsideDirectory, join(fixture.targetRoot, 'nested'), 'dir')
      },
    })).rejects.toThrow('身份')
    expect(readdirSync(outsideDirectory)).toEqual([])
  })

  test('Given 普通文件复制期间源文件被删除 When 最终重扫 Then 失败并保留可恢复 sidecar', async () => {
    /** 当前用例的源目录和目标目录。 */
    const fixture = createFixture(testRoot)
    /** 复制期间将被删除但已由打开文件描述符持有的源文件。 */
    const sourceFile = join(fixture.sourceRoot, 'changing.bin')
    writeFileSync(sourceFile, Buffer.alloc(512 * 1024, 4))
    /** 是否已经删除过源文件。 */
    let removedSource = false

    await expect(copyFixture(fixture, {
      concurrency: 1,
      onProgress: (progress) => {
        if (progress.stage !== 'copying' || removedSource) return
        removedSource = true
        unlinkSync(sourceFile)
      },
    })).rejects.toThrow('源目录')
    expect(existsSync(getSidecarPath(fixture.targetRoot))).toBe(true)
  })

  test('Given concurrency=2 且一个 worker 回调失败 When 任务拒绝 Then 其他 worker 中断并且不再后台提交', async () => {
    /** 当前用例的源目录和目标目录。 */
    const fixture = createFixture(testRoot)
    writeFileSync(join(fixture.sourceRoot, 'a-fail.bin'), Buffer.alloc(128 * 1024, 5))
    writeFileSync(join(fixture.sourceRoot, 'z-other.bin'), Buffer.alloc(8 * 1024 * 1024, 6))

    await expect(copyFixture(fixture, {
      concurrency: 2,
      onProgress: (progress) => {
        if (progress.stage === 'copying' && progress.currentRelativePath === 'a-fail.bin') {
          throw new Error('测试 worker 失败')
        }
      },
    })).rejects.toThrow('测试 worker 失败')
    /** worker 全部收敛时另一个文件不得被后台提交。 */
    const otherTarget = join(fixture.targetRoot, 'z-other.bin')
    expect(existsSync(otherTarget)).toBe(false)
    await Bun.sleep(50)
    expect(existsSync(otherTarget)).toBe(false)
  })

  test('Given concurrency=2 多文件真实并发复制 When 汇报进度 Then 字节单调且不超过普通文件总量', async () => {
    /** 当前用例的源目录和目标目录。 */
    const fixture = createFixture(testRoot)
    writeFileSync(join(fixture.sourceRoot, 'first.bin'), Buffer.alloc(160 * 1024, 1))
    writeFileSync(join(fixture.sourceRoot, 'second.bin'), Buffer.alloc(160 * 1024, 2))
    /** 记录复制器发出的全部进度快照。 */
    const progressEvents: DataRootMigrationProgress[] = []

    /** 并发数覆盖为 2 后完成的复制结果。 */
    const result = await copyFixture(fixture, {
      concurrency: 2,
      onProgress: (progress) => progressEvents.push({ ...progress }),
    })

    expect(progressEvents.some((progress) => progress.stage === 'copying')).toBe(true)
    expect(progressEvents.some((progress) => progress.stage === 'verifying')).toBe(true)
    expect(progressEvents.every((progress) => progress.currentRelativePath !== undefined)).toBe(true)
    expect(progressEvents.every((progress) => progress.totalBytes === result.totalBytes)).toBe(true)
    expect(progressEvents.every((progress) => progress.completedBytes <= progress.totalBytes)).toBe(true)
    expect(progressEvents.every((progress, index) => index === 0 || progress.completedBytes >= progressEvents[index - 1]!.completedBytes)).toBe(true)
  })
})
