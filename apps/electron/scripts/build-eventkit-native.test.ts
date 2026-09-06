import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

test('Given EventKit 构建依赖属于 Electron workspace When 检查头文件路径 Then 从当前 workspace 解析 node-addon-api', () => {
  /** EventKit 构建脚本源码，用于锁定干净 workspace 中的依赖解析边界。 */
  const source = readFileSync(resolve(import.meta.dir, 'build-eventkit-native.ts'), 'utf8')

  expect(source).toContain("resolve(appDir, 'node_modules/node-addon-api')")
  expect(source).not.toContain("resolve(appDir, '../../node_modules/node-addon-api')")
})

test('Given 开发态 Electron 属于 Electron workspace When 注入 EventKit 权限 Then 从当前 workspace 解析 Electron.app', () => {
  /** EventKit 构建脚本源码，用于锁定开发态 Electron 的权限注入目标。 */
  const source = readFileSync(resolve(import.meta.dir, 'build-eventkit-native.ts'), 'utf8')

  expect(source).toContain("resolve(appDir, 'node_modules/electron/dist/Electron.app')")
  expect(source).not.toContain("resolve(appDir, '../../node_modules/electron/dist/Electron.app')")
})
