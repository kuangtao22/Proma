import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ensureDirectoryDurable,
  readJsonFileSafe,
  removeFileAtomic,
  writeJsonFileAtomic,
  writeJsonFileAtomicSecure,
  writeTextFileAtomic,
} from './safe-file'

/** safe-file validator 测试使用的最小 schema。 */
interface VersionedValue {
  version: 1
  value: string
}

/**
 * 校验测试数据是否符合 VersionedValue。
 *
 * @param value 从候选 JSON 文件解析出的未知值。
 * @returns 版本和值字段合法时返回 true。
 */
function isVersionedValue(value: unknown): value is VersionedValue {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && 'version' in value
    && value.version === 1
    && 'value' in value
    && typeof value.value === 'string'
}

/** 构造带 Node 文件系统错误字段的稳定测试错误。 */
function createFileSystemError(code: string, syscall: string): Error & { code: string; syscall: string } {
  return Object.assign(new Error(`${syscall} ${code}`), { code, syscall })
}

describe('Windows durability capability', () => {
  test('Given 普通 JSON 原子写已 rename 且 Windows 不支持目录 open When 返回 Then 文件已 fsync 且报告 file-only', () => {
    /** 隔离 Windows capability 合同的目标文件。 */
    const tempDir = mkdtempSync(join(tmpdir(), 'proma-json-win-durability-'))
    const filePath = join(tempDir, 'state.json')
    let syncedFilePath = ''
    try {
      const result = writeJsonFileAtomic(filePath, { value: 'saved' }, false, {
        platform: 'win32',
        syncFile: (currentPath) => { syncedFilePath = currentPath },
        syncDirectory: () => { throw createFileSystemError('EPERM', 'open') },
      })

      expect(result).toBe('file-only')
      expect(syncedFilePath).toBe(filePath)
      expect(JSON.parse(readFileSync(filePath, 'utf8'))).toEqual({ value: 'saved' })
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  test('Given 普通文本原子写已 rename 且 Windows 不支持目录 open When 返回 Then 内容保留且报告 file-only', () => {
    /** 隔离文本原子写的 Windows capability 合同。 */
    const tempDir = mkdtempSync(join(tmpdir(), 'proma-text-win-durability-'))
    const filePath = join(tempDir, 'session.jsonl')
    let fileSyncCalls = 0
    try {
      const result = writeTextFileAtomic(filePath, 'saved\n', {
        platform: 'win32',
        syncFile: () => { fileSyncCalls += 1 },
        syncDirectory: () => { throw createFileSystemError('EPERM', 'open') },
      })

      expect(result).toBe('file-only')
      expect(fileSyncCalls).toBe(1)
      expect(readFileSync(filePath, 'utf8')).toBe('saved\n')
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  test('Given Windows 安全写遇到非 capability EPERM When 提交后同步 Then 仍向上传播真实 I/O 错误', () => {
    /** 非目录 open 阶段的 EPERM 不得被泛化吞掉。 */
    const tempDir = mkdtempSync(join(tmpdir(), 'proma-secure-win-io-error-'))
    const filePath = join(tempDir, 'journal.json')
    try {
      expect(() => writeJsonFileAtomicSecure(filePath, { stage: 'copying' }, {
        platform: 'win32',
        syncFile: () => {},
        syncDirectory: () => { throw createFileSystemError('EPERM', 'fsync') },
      })).toThrow('fsync EPERM')
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })
})

describe('readJsonFileSafe validator', () => {
  /** 每个用例隔离使用的临时目录。 */
  let tempDir: string
  /** 每个用例固定读取的主文件路径。 */
  let filePath: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'proma-safe-file-'))
    filePath = join(tempDir, 'state.json')
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  test('Given schema-invalid primary and valid backup When reading with validator Then backup is restored', () => {
    /** 语法合法但 schema 不合法的主文件。 */
    const invalidPrimary = { version: 2, value: 'primary' }
    /** 应从恢复链返回并覆盖主文件的有效备份。 */
    const validBackup: VersionedValue = { version: 1, value: 'backup' }
    writeFileSync(filePath, JSON.stringify(invalidPrimary), 'utf-8')
    writeFileSync(`${filePath}.bak`, JSON.stringify(validBackup), 'utf-8')

    expect(readJsonFileSafe(filePath, { validate: isVersionedValue })).toEqual(validBackup)
    expect(JSON.parse(readFileSync(filePath, 'utf-8'))).toEqual(validBackup)
  })

  test('Given schema-invalid tmp and valid backup When reading with validator Then tmp is not promoted', () => {
    /** 不得被提升为主文件的 schema 非法临时文件。 */
    const invalidTmp = { version: 1, value: 42 }
    /** 临时文件非法时应继续恢复的有效备份。 */
    const validBackup: VersionedValue = { version: 1, value: 'backup' }
    writeFileSync(`${filePath}.tmp`, JSON.stringify(invalidTmp), 'utf-8')
    writeFileSync(`${filePath}.bak`, JSON.stringify(validBackup), 'utf-8')

    expect(readJsonFileSafe(filePath, { validate: isVersionedValue })).toEqual(validBackup)
    expect(existsSync(`${filePath}.tmp`)).toBe(false)
    expect(JSON.parse(readFileSync(filePath, 'utf-8'))).toEqual(validBackup)
  })

  test('Given schema-invalid JSON When reading without validator Then existing parse-only behavior remains compatible', () => {
    /** 旧调用方没有 validator 时仍应原样返回的 JSON 对象。 */
    const parseableValue = { version: 99, legacy: true }
    writeFileSync(filePath, JSON.stringify(parseableValue), 'utf-8')

    expect(readJsonFileSafe<typeof parseableValue>(filePath)).toEqual(parseableValue)
  })

  test('Given valid primary JSON and a throwing validator When reading Then it propagates without restoring backup', () => {
    /** validator 抛错前主文件保存的原始内容。 */
    const primaryContent = JSON.stringify({ version: 1, value: 'primary' })
    /** 即使 schema 合法也不得在 validator 异常后恢复的备份内容。 */
    const backupContent = JSON.stringify({ version: 1, value: 'backup' })
    /** 必须保持对象身份向上传播的 validator 原始错误。 */
    const validatorError = new Error('validator execution failed')
    /** 模拟调用方 validator 自身异常的类型守卫。 */
    const throwingValidator = (_value: unknown): _value is VersionedValue => {
      throw validatorError
    }
    writeFileSync(filePath, primaryContent, 'utf-8')
    writeFileSync(`${filePath}.bak`, backupContent, 'utf-8')
    /** 捕获 readJsonFileSafe 向上传播的错误以验证对象身份。 */
    let caughtError: unknown

    try {
      readJsonFileSafe(filePath, { validate: throwingValidator })
    } catch (error) {
      caughtError = error
    }

    expect(readFileSync(filePath, 'utf-8')).toBe(primaryContent)
    expect(readFileSync(`${filePath}.bak`, 'utf-8')).toBe(backupContent)
    expect(caughtError).toBe(validatorError)
  })

  test('Given valid tmp JSON and a throwing validator When reading Then it propagates without deleting tmp', () => {
    /** validator 抛错前临时文件保存的原始内容。 */
    const tmpContent = JSON.stringify({ version: 1, value: 'temporary' })
    /** 必须保持对象身份向上传播的 validator 原始错误。 */
    const validatorError = new Error('tmp validator execution failed')
    /** 模拟调用方 validator 自身异常的类型守卫。 */
    const throwingValidator = (_value: unknown): _value is VersionedValue => {
      throw validatorError
    }
    writeFileSync(`${filePath}.tmp`, tmpContent, 'utf-8')
    /** 捕获 readJsonFileSafe 向上传播的错误以验证对象身份。 */
    let caughtError: unknown

    try {
      readJsonFileSafe(filePath, { validate: throwingValidator })
    } catch (error) {
      caughtError = error
    }

    expect(existsSync(filePath)).toBe(false)
    expect(readFileSync(`${filePath}.tmp`, 'utf-8')).toBe(tmpContent)
    expect(caughtError).toBe(validatorError)
  })

  test('Given valid tmp JSON and a deterministic promotion failure When reading Then it throws and preserves tmp', () => {
    /** 让主路径成为目录，从而稳定触发文件覆盖目录的 rename 失败。 */
    mkdirSync(filePath)
    /** rename 失败后必须保留的有效临时文件内容。 */
    const tmpContent = JSON.stringify({ version: 1, value: 'temporary' })
    writeFileSync(`${filePath}.tmp`, tmpContent, 'utf-8')
    /** 捕获底层 renameSync 原始错误，验证不会被恢复链吞掉。 */
    let caughtError: unknown

    try {
      readJsonFileSafe(filePath, { validate: isVersionedValue })
    } catch (error) {
      caughtError = error
    }

    expect(caughtError).toBeInstanceOf(Error)
    expect(statSync(filePath).isDirectory()).toBe(true)
    expect(readFileSync(`${filePath}.tmp`, 'utf-8')).toBe(tmpContent)
  })

  test('Given Windows 有效 tmp 提升成功但不支持目录 open When 读取 Then 返回恢复值且不在 rename 后失败', () => {
    /** 模拟上次崩溃留下的有效临时索引。 */
    const tmpValue: VersionedValue = { version: 1, value: 'temporary' }
    writeFileSync(`${filePath}.tmp`, JSON.stringify(tmpValue), 'utf8')
    let fileSyncCalls = 0

    const result = readJsonFileSafe(filePath, {
      validate: isVersionedValue,
      platform: 'win32',
      syncFile: () => { fileSyncCalls += 1 },
      syncDirectory: () => { throw createFileSystemError('EPERM', 'open') },
    })

    expect(result).toEqual(tmpValue)
    expect(fileSyncCalls).toBe(1)
    expect(JSON.parse(readFileSync(filePath, 'utf8'))).toEqual(tmpValue)
  })

  test('Given valid backup JSON and a deterministic atomic restore failure When reading Then it throws', () => {
    /** 让主路径成为目录，从而稳定触发原子恢复最后的 rename 失败。 */
    mkdirSync(filePath)
    /** 原子恢复失败后必须保持原内容的有效备份。 */
    const backupContent = JSON.stringify({ version: 1, value: 'backup' })
    writeFileSync(`${filePath}.bak`, backupContent, 'utf-8')
    /** 捕获 writeJsonFileAtomic 内部 renameSync 原始错误。 */
    let caughtError: unknown

    try {
      readJsonFileSafe(filePath, { validate: isVersionedValue })
    } catch (error) {
      caughtError = error
    }

    expect(caughtError).toBeInstanceOf(Error)
    expect(statSync(filePath).isDirectory()).toBe(true)
    expect(readFileSync(`${filePath}.bak`, 'utf-8')).toBe(backupContent)
  })
})

describe('writeJsonFileAtomicSecure', () => {
  test('Given 固定 .tmp 是根外 symlink When 安全写入 Then 不跟随且根外文件保持不变', () => {
    /** 隔离目录与根外哨兵文件。 */
    const tempDir = mkdtempSync(join(tmpdir(), 'proma-secure-json-'))
    const filePath = join(tempDir, 'marker.json')
    const outsidePath = join(tempDir, 'outside.json')
    writeFileSync(outsidePath, 'outside')
    symlinkSync(outsidePath, `${filePath}.tmp`)

    try {
      writeJsonFileAtomicSecure(filePath, { owner: 'proma', version: 1 })
      expect(JSON.parse(readFileSync(filePath, 'utf8'))).toEqual({ owner: 'proma', version: 1 })
      expect(readFileSync(outsidePath, 'utf8')).toBe('outside')
      expect(statSync(`${filePath}.tmp`).isFile()).toBe(true)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  test('Given 目的路径是 symlink When 安全写入 Then 拒绝且根外文件保持不变', () => {
    /** 目的 symlink 不得被备份或 rename 覆盖。 */
    const tempDir = mkdtempSync(join(tmpdir(), 'proma-secure-json-dest-'))
    const filePath = join(tempDir, 'marker.json')
    const outsidePath = join(tempDir, 'outside.json')
    writeFileSync(outsidePath, 'outside')
    symlinkSync(outsidePath, filePath)

    try {
      expect(() => writeJsonFileAtomicSecure(filePath, { owner: 'proma', version: 1 }))
        .toThrow('安全原子写入目标不是普通文件')
      expect(readFileSync(outsidePath, 'utf8')).toBe('outside')
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  test('Given 随机 temp 在提交前被置换 When 安全写入 Then 拒绝且不删除攻击者文件', () => {
    /** 注入点模拟同目录攻击者替换已关闭的随机 temp。 */
    const tempDir = mkdtempSync(join(tmpdir(), 'proma-secure-json-temp-race-'))
    const filePath = join(tempDir, 'marker.json')
    let attackerTempPath = ''

    try {
      expect(() => writeJsonFileAtomicSecure(filePath, { owner: 'proma', version: 1 }, {
        beforeRename: (tempPath) => {
          attackerTempPath = tempPath
          unlinkSync(tempPath)
          writeFileSync(tempPath, 'attacker')
        },
      })).toThrow('安全原子写入临时文件身份已变化')
      expect(readFileSync(attackerTempPath, 'utf8')).toBe('attacker')
      expect(existsSync(filePath)).toBe(false)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  test('Given 父目录在提交前被替换 When 安全写入 Then 拒绝提交到新目录', () => {
    /** 替换父目录模拟挂载点或目录交换竞态。 */
    const tempDir = mkdtempSync(join(tmpdir(), 'proma-secure-json-parent-race-'))
    const parentPath = join(tempDir, 'parent')
    const movedParentPath = join(tempDir, 'parent-old')
    const filePath = join(parentPath, 'marker.json')
    mkdirSync(parentPath)

    try {
      expect(() => writeJsonFileAtomicSecure(filePath, { owner: 'proma', version: 1 }, {
        beforeRename: () => {
          renameSync(parentPath, movedParentPath)
          mkdirSync(parentPath)
        },
      })).toThrow('安全原子写入父目录身份已变化')
      expect(existsSync(filePath)).toBe(false)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  test('Given 安全原子写完成 rename When 返回成功 Then 已同步父目录且文件可见', () => {
    /** 通过窄注入观察目录同步发生时 rename 已完成。 */
    const tempDir = mkdtempSync(join(tmpdir(), 'proma-secure-json-durable-'))
    const filePath = join(tempDir, 'marker.json')
    let syncCalls = 0
    try {
      writeJsonFileAtomicSecure(filePath, { durable: true }, {
        syncDirectory: (directoryPath) => {
          syncCalls += 1
          expect(directoryPath).toBe(tempDir)
          expect(JSON.parse(readFileSync(filePath, 'utf8'))).toEqual({ durable: true })
        },
      })

      expect(syncCalls).toBe(1)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })
})

describe('ensureDirectoryDurable', () => {
  test('Given journal 目录首次创建 When 返回成功 Then 依次同步父目录与新目录', () => {
    /** 记录目录创建后的两次同步顺序。 */
    const tempDir = mkdtempSync(join(tmpdir(), 'proma-durable-directory-'))
    const directoryPath = join(tempDir, 'workspace-relocations')
    const syncedDirectories: string[] = []
    try {
      ensureDirectoryDurable(directoryPath, {
        syncDirectory: (currentPath) => {
          expect(statSync(directoryPath).isDirectory()).toBe(true)
          syncedDirectories.push(currentPath)
        },
      })

      expect(syncedDirectories).toEqual([tempDir, directoryPath])
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  test('Given 当前平台目录同步失败 When 首次创建 Then 明确向上传播 durability 错误', () => {
    /** 注入不支持目录 fsync 的平台错误。 */
    const tempDir = mkdtempSync(join(tmpdir(), 'proma-durable-directory-error-'))
    const directoryPath = join(tempDir, 'workspace-relocations')
    try {
      expect(() => ensureDirectoryDurable(directoryPath, {
        syncDirectory: () => { throw new Error('directory fsync unsupported') },
      })).toThrow('directory fsync unsupported')
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  test('Given Windows 首次创建 journal 目录但不支持目录 open When 返回 Then 不回滚目录并报告 file-only', () => {
    /** Windows 无目录 fsync 能力时仍需保留已创建目录。 */
    const tempDir = mkdtempSync(join(tmpdir(), 'proma-durable-directory-win-'))
    const directoryPath = join(tempDir, 'workspace-relocations')
    try {
      const result = ensureDirectoryDurable(directoryPath, {
        platform: 'win32',
        syncDirectory: () => { throw createFileSystemError('EPERM', 'open') },
      })

      expect(result).toBe('file-only')
      expect(statSync(directoryPath).isDirectory()).toBe(true)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })
})

describe('removeFileAtomic', () => {
  test('Given 普通 journal 文件 When 原子删除 Then 原路径消失且同目录不残留 tombstone', () => {
    /** 隔离原子删除行为的临时目录。 */
    const tempDir = mkdtempSync(join(tmpdir(), 'proma-atomic-remove-'))
    const filePath = join(tempDir, 'journal.json')
    writeFileSync(filePath, '{}', 'utf8')

    try {
      removeFileAtomic(filePath)

      expect(existsSync(filePath)).toBe(false)
      expect(readFileNames(tempDir)).toEqual([])
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  test('Given journal 已不存在 When 重复原子删除 Then 幂等成功', () => {
    /** 不存在的明确文件路径。 */
    const tempDir = mkdtempSync(join(tmpdir(), 'proma-atomic-remove-missing-'))
    const filePath = join(tempDir, 'journal.json')

    try {
      expect(() => removeFileAtomic(filePath)).not.toThrow()
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  test('Given journal 与父目录均已不存在 When 重复原子删除 Then 仍幂等成功', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'proma-atomic-remove-missing-parent-'))
    const filePath = join(tempDir, 'removed-parent', 'journal.json')

    try {
      expect(() => removeFileAtomic(filePath)).not.toThrow()
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  test('Given 删除目标是目录或符号链接 When 原子删除 Then 拒绝误删', () => {
    /** 同时放置目录、外部文件与指向外部文件的符号链接。 */
    const tempDir = mkdtempSync(join(tmpdir(), 'proma-atomic-remove-unsafe-'))
    const directoryPath = join(tempDir, 'journal-dir')
    const outsidePath = join(tempDir, 'outside.json')
    const symlinkPath = join(tempDir, 'journal-link.json')
    mkdirSync(directoryPath)
    writeFileSync(outsidePath, 'outside', 'utf8')
    symlinkSync(outsidePath, symlinkPath)

    try {
      expect(() => removeFileAtomic(directoryPath)).toThrow('原子删除目标不是普通文件')
      expect(() => removeFileAtomic(symlinkPath)).toThrow('原子删除目标不是普通文件')
      expect(readFileSync(outsidePath, 'utf8')).toBe('outside')
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  test('Given rename 后 tombstone 清理失败 When 原子删除 Then 原 journal 不复活且抛出可诊断错误', () => {
    /** 注入 unlink 失败，稳定覆盖 rename 成功后的故障窗口。 */
    const tempDir = mkdtempSync(join(tmpdir(), 'proma-atomic-remove-failure-'))
    const filePath = join(tempDir, 'journal.json')
    writeFileSync(filePath, '{}', 'utf8')

    try {
      expect(() => removeFileAtomic(filePath, {
        unlinkTombstone: () => { throw new Error('disk busy') },
      })).toThrow('原子删除已提交，但 tombstone 清理失败')
      expect(existsSync(filePath)).toBe(false)
      const tombstoneNames = readFileNames(tempDir)
      expect(tombstoneNames).toHaveLength(1)
      expect(tombstoneNames[0]).not.toContain('journal.json')

      removeFileAtomic(filePath)
      expect(readFileNames(tempDir)).toEqual([])
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  test('Given 原子删除完成 rename 与 unlink When 返回成功 Then 每个目录项变更后都同步父目录', () => {
    /** 捕获 tombstone 路径与两次目录同步时的可见状态。 */
    const tempDir = mkdtempSync(join(tmpdir(), 'proma-atomic-remove-durable-'))
    const filePath = join(tempDir, 'journal.json')
    let tombstonePath = ''
    const syncStates: string[] = []
    writeFileSync(filePath, '{}', 'utf8')
    try {
      removeFileAtomic(filePath, {
        afterRenameBeforeVerify: (currentTombstonePath) => { tombstonePath = currentTombstonePath },
        syncDirectory: () => {
          syncStates.push(existsSync(tombstonePath) ? 'renamed' : 'unlinked')
        },
      })

      expect(syncStates).toEqual(['renamed', 'unlinked'])
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  test('Given Windows journal 删除已提交但不支持目录 open When 返回 Then 不重建文件并报告 file-only', () => {
    /** Windows 删除边界必须把目录能力不足与真实删除失败区分。 */
    const tempDir = mkdtempSync(join(tmpdir(), 'proma-atomic-remove-win-'))
    const filePath = join(tempDir, 'journal.json')
    let fileSyncCalls = 0
    writeFileSync(filePath, '{}', 'utf8')
    try {
      const result = removeFileAtomic(filePath, {
        platform: 'win32',
        syncFile: () => { fileSyncCalls += 1 },
        syncDirectory: () => { throw createFileSystemError('EPERM', 'open') },
      })

      expect(result).toBe('file-only')
      expect(fileSyncCalls).toBe(1)
      expect(existsSync(filePath)).toBe(false)
      expect(readFileNames(tempDir)).toEqual([])
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  test('Given A 删除已 rename 且仍 active When B 同目录删除 Then B 不回收 A tombstone', () => {
    /** 两个同目录删除用于稳定制造同步交错。 */
    const tempDir = mkdtempSync(join(tmpdir(), 'proma-atomic-remove-interleaved-'))
    const firstPath = join(tempDir, 'first.json')
    const secondPath = join(tempDir, 'second.json')
    let activeTombstonePath = ''
    writeFileSync(firstPath, 'first', 'utf8')
    writeFileSync(secondPath, 'second', 'utf8')
    try {
      expect(() => removeFileAtomic(firstPath, {
        afterRenameBeforeVerify: (tombstonePath) => {
          activeTombstonePath = tombstonePath
          removeFileAtomic(secondPath)
          expect(readFileSync(activeTombstonePath, 'utf8')).toBe('first')
        },
      })).not.toThrow()

      expect(existsSync(firstPath)).toBe(false)
      expect(existsSync(secondPath)).toBe(false)
      expect(readFileNames(tempDir)).toEqual([])
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  test('Given 其他进程 tombstone owner 仍存活 When 回收 Then 跳过；owner 明确消失后才删除', () => {
    /** 人工构造另一个进程遗留的协议 tombstone。 */
    const tempDir = mkdtempSync(join(tmpdir(), 'proma-atomic-remove-cross-process-'))
    const sourcePath = join(tempDir, 'source.json')
    const missingPath = join(tempDir, 'missing.json')
    const ownerProcessId = 424242
    writeFileSync(sourcePath, 'owned', 'utf8')
    const sourceStat = statSync(sourcePath)
    const tombstonePath = join(
      tempDir,
      `.proma-delete-${ownerProcessId}-${sourceStat.dev}-${sourceStat.ino}-00000000-0000-4000-8000-000000000001.tombstone`,
    )
    renameSync(sourcePath, tombstonePath)
    let processChecks = 0
    try {
      removeFileAtomic(missingPath, {
        isProcessAlive: (processId) => {
          processChecks += 1
          expect(processId).toBe(ownerProcessId)
          return true
        },
      })

      expect(processChecks).toBe(1)
      expect(readFileSync(tombstonePath, 'utf8')).toBe('owned')

      removeFileAtomic(missingPath, { isProcessAlive: () => false })
      expect(existsSync(tombstonePath)).toBe(false)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  test('Given rename 后 tombstone 路径被替换 When 原子删除 Then 拒绝 unlink 替换文件', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'proma-atomic-remove-tombstone-race-'))
    const filePath = join(tempDir, 'journal.json')
    writeFileSync(filePath, 'proma-owned', 'utf8')
    /** 捕获随机 tombstone 路径以验证攻击者文件仍存在。 */
    let tombstonePath = ''

    try {
      expect(() => removeFileAtomic(filePath, {
        afterRenameBeforeVerify: (currentTombstonePath) => {
          tombstonePath = currentTombstonePath
          unlinkSync(currentTombstonePath)
          writeFileSync(currentTombstonePath, 'replacement', 'utf8')
        },
      })).toThrow('tombstone 身份已变化')
      expect(readFileSync(tombstonePath, 'utf8')).toBe('replacement')
      expect(existsSync(filePath)).toBe(false)

      expect(() => removeFileAtomic(filePath)).toThrow('无法安全回收')
      expect(readFileSync(tombstonePath, 'utf8')).toBe('replacement')
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  test('Given rename 后父目录被移走并同名重建 When 原子删除 Then 新目录文件不被误删且旧 tombstone 保留', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'proma-atomic-remove-parent-race-'))
    const parentPath = join(tempDir, 'parent')
    const movedParentPath = join(tempDir, 'parent-old')
    const filePath = join(parentPath, 'journal.json')
    mkdirSync(parentPath)
    writeFileSync(filePath, 'proma-owned', 'utf8')
    /** 随机 tombstone 文件名，用于同时检查新旧父目录。 */
    let tombstoneName = ''

    try {
      expect(() => removeFileAtomic(filePath, {
        afterRenameBeforeVerify: (tombstonePath) => {
          tombstoneName = tombstonePath.slice(parentPath.length + 1)
          renameSync(parentPath, movedParentPath)
          mkdirSync(parentPath)
          writeFileSync(join(parentPath, tombstoneName), 'replacement', 'utf8')
        },
      })).toThrow('父目录身份已变化')
      expect(readFileSync(join(parentPath, tombstoneName), 'utf8')).toBe('replacement')
      expect(readFileSync(join(movedParentPath, tombstoneName), 'utf8')).toBe('proma-owned')
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })
})

/** 返回目录当前条目名称，供 tombstone 清理断言使用。 */
function readFileNames(directoryPath: string): string[] {
  return readdirSync(directoryPath)
}
