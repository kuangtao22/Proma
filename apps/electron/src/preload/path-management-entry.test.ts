import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

describe('路径窗口 preload 隔离', () => {
  test('Given 路径 preload 入口 When 静态分析 Then 只暴露 pathManagementAPI', () => {
    /** 专用 preload 入口不得导入或暴露完整业务 API。 */
    const source = readFileSync(join(import.meta.dir, 'path-management-entry.ts'), 'utf8')
    expect(source).toContain("contextBridge.exposeInMainWorld('pathManagementAPI'")
    expect(source).not.toContain("'electronAPI'")
    expect(source).not.toContain("from './index'")
  })
})
