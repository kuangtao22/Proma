import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
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
import { readJsonFileSafe, writeJsonFileAtomicSecure } from './safe-file'

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
})
