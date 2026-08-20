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

  test('Given 普通窗口完整 preload When 静态分析 Then 不暴露恢复或退出 API', () => {
    /** 完整 preload 只允许普通窗口打开数据目录，不得转发 dedicated recovery 能力。 */
    const source = readFileSync(join(import.meta.dir, 'index.ts'), 'utf8')
    expect(source).not.toContain('recoverDataRoot:')
    expect(source).not.toContain('exitDataRootManagement:')
    expect(source).not.toContain('PATH_MANAGEMENT_IPC_CHANNELS.RECOVER_DATA_ROOT')
    expect(source).not.toContain('PATH_MANAGEMENT_IPC_CHANNELS.EXIT_APP')
  })
})
