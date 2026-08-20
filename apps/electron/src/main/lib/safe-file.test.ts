import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
})
