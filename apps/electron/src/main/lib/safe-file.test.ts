import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readJsonFileSafe } from './safe-file'

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
