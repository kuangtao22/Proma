import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

test('Given stable directory helper 构建脚本 When 检查三平台合同 Then 使用系统编译器并输出稳定资源路径', () => {
  const source = readFileSync(resolve(import.meta.dir, 'build-stable-directory-native.ts'), 'utf8')

  expect(source).toContain("native/stable-directory/stable-directory-helper.cc")
  expect(source).toContain("'resources/stable-directory'")
  expect(source).toContain("'stable-directory-helper'")
  expect(source).toContain("process.platform === 'darwin'")
  expect(source).toContain("process.platform === 'linux'")
  expect(source).toContain("process.platform === 'win32'")
  expect(source).toContain("execFileSync('xcrun'")
  expect(source).toMatch(/execFileSync\((?:compiler|'g\+\+'|'c\+\+')/)
  expect(source).toContain("execFileSync('cl'")
  expect(source).toContain('vswhere.exe')
  expect(source).toContain('VsDevCmd.bat')
})
