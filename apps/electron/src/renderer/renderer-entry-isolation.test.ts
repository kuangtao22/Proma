import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

describe('路径窗口 renderer 隔离', () => {
  test('Given renderer 主入口 When 静态分析 Then 不导入普通 App、atoms 或业务 hooks', () => {
    /** 主入口只允许承担窗口模式分流。 */
    const source = readFileSync(join(import.meta.dir, 'main.tsx'), 'utf8')
    expect(source).not.toContain("from './App'")
    expect(source).not.toContain("from './atoms/")
    expect(source).not.toContain("from './hooks/")
    expect(source).toContain("import('./normal-renderer-main')")
  })
})
