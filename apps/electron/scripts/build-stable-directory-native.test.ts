import { expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

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

test.skipIf(process.platform === 'win32')('Given Windows 路径纯函数合同 When 在当前 C++ 编译器运行 Then drive 与 UNC 扩展路径双向规范化', () => {
  const contractSource = resolve(import.meta.dir, '../native/stable-directory/stable-directory-helper-path-contract.cc')
  const outputDir = mkdtempSync(join(tmpdir(), 'proma-stable-path-contract-'))
  const output = join(outputDir, 'path-contract')
  try {
    if (process.platform === 'darwin') {
      execFileSync('xcrun', ['clang++', '-std=c++17', '-Wall', '-Wextra', contractSource, '-o', output])
    } else {
      execFileSync(process.env.CXX || 'g++', ['-std=c++17', '-Wall', '-Wextra', contractSource, '-o', output])
    }
    execFileSync(output)
  } finally {
    rmSync(outputDir, { recursive: true, force: true })
  }
})

test('Given Windows helper 实现 When 检查源码合同 Then 内部递归保留 extended path 且展示路径单独规范化', () => {
  const source = readFileSync(resolve(import.meta.dir, '../native/stable-directory/stable-directory-helper.cc'), 'utf8')
  expect(source).toContain('ToExtendedWindowsPath')
  expect(source).toContain('WindowsPathForDisplay')
  expect(source).toContain('root->canonical_wide = extended_final_path')
  expect(source).toContain('OpenStableRoot(WideToUtf8(child_path)')
})

test('Given stable directory helper 的 Canvas intent 模式 When 检查三平台系统调用合同 Then POSIX 相对操作且 Windows 拒绝 reparse', () => {
  const source = readFileSync(resolve(import.meta.dir, '../native/stable-directory/stable-directory-helper.cc'), 'utf8')

  expect(source).toContain('mkdirat(')
  expect(source).toContain('openat(')
  expect(source).toContain('renameat(')
  expect(source).toContain('fsync(')
  expect(source).toContain('RootDirectory')
  expect(source).toContain('FILE_OPEN_REPARSE_POINT')
  expect(source).toContain('FILE_ATTRIBUTE_REPARSE_POINT')
})
