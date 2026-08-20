import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

describe('数据根身份探测资源上限', () => {
  test('Given marker 实现 When 静态审计 Then JSON 与 SQLite 都使用固定长度 readSync', () => {
    /** 静态合同防止后续重构重新引入整文件同步读取。 */
    const source = readFileSync(join(import.meta.dir, 'data-root-marker.ts'), 'utf8')
    expect(source).not.toContain('readFileSync')
    expect(source).toContain('lstatSync')
    expect(source).toContain('O_NOFOLLOW')
    expect(source).toContain('readSync')
    expect(source).toContain('Buffer.alloc(16)')
  })
})
