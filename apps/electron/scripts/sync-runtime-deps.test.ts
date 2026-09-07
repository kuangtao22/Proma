import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EXTERNAL_RUNTIME_PACKAGES, syncRuntimeDeps } from './sync-runtime-deps'

/** 当前测试创建的隔离目录。 */
const temporaryDirectories: string[] = []

/** 创建带 package.json 的最小依赖目录。 */
function createPackage(nodeModules: string, name: string, manifest: object, files: Record<string, string> = {}): void {
  /** scoped 与普通包都适用的目标目录。 */
  const packageDir = join(nodeModules, ...name.split('/'))
  mkdirSync(packageDir, { recursive: true })
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ name, version: '1.0.0', ...manifest }), 'utf8')
  for (const [relativePath, content] of Object.entries(files)) {
    /** fixture 文件的完整路径。 */
    const filePath = join(packageDir, relativePath)
    mkdirSync(join(filePath, '..'), { recursive: true })
    writeFileSync(filePath, content, 'utf8')
  }
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('SSH runtime 依赖同步', () => {
  test('external 列表包含 ssh2 且同步时排除可选原生 binding', () => {
    expect(EXTERNAL_RUNTIME_PACKAGES).toContain('ssh2')
    /** 当前用例的隔离根目录。 */
    const root = mkdtempSync(join(tmpdir(), 'proma-server-ops-runtime-deps-'))
    temporaryDirectories.push(root)
    /** fixture 源依赖目录。 */
    const sourceNodeModules = join(root, 'source', 'node_modules')
    /** fixture 目标依赖目录。 */
    const targetNodeModules = join(root, 'target', 'node_modules')
    createPackage(sourceNodeModules, 'ssh2', {
      optionalDependencies: { 'cpu-features': '1.0.0', nan: '1.0.0' },
    }, {
      'lib/index.js': 'module.exports = {}',
      'lib/protocol/crypto/build/Release/sshcrypto.node': 'native-canary',
    })
    createPackage(sourceNodeModules, 'cpu-features', {}, { 'build/Release/cpufeatures.node': 'native-canary' })
    createPackage(sourceNodeModules, 'nan', {})

    const result = syncRuntimeDeps({
      sourceNodeModules,
      fallbackNodeModules: [],
      targetNodeModules,
      externalRuntimePackages: ['ssh2'],
    })

    expect(existsSync(join(targetNodeModules, 'ssh2', 'lib', 'index.js'))).toBe(true)
    expect(existsSync(join(targetNodeModules, 'ssh2', 'lib', 'protocol', 'crypto', 'build', 'Release', 'sshcrypto.node'))).toBe(false)
    expect(existsSync(join(targetNodeModules, 'cpu-features'))).toBe(false)
    expect(existsSync(join(targetNodeModules, 'nan'))).toBe(false)
    expect(result.skippedOptionalPackages).toEqual(expect.arrayContaining(['cpu-features', 'nan']))
  })
})

describe('Sharp Windows runtime 依赖同步', () => {
  test('Given Windows x64 目标包缺失 When 同步 Sharp Then 在生成安装包前失败', () => {
    /** 当前用例的隔离根目录。 */
    const root = mkdtempSync(join(tmpdir(), 'proma-sharp-win32-missing-'))
    temporaryDirectories.push(root)
    /** 仅包含宿主平台 Sharp 可选依赖的源目录。 */
    const sourceNodeModules = join(root, 'source', 'node_modules')
    /** 模拟 Electron 应用运行时依赖的目标目录。 */
    const targetNodeModules = join(root, 'target', 'node_modules')
    createPackage(sourceNodeModules, 'sharp', {
      optionalDependencies: {
        '@img/sharp-darwin-arm64': '1.0.0',
        '@img/sharp-win32-x64': '1.0.0',
      },
    })
    createPackage(sourceNodeModules, '@img/sharp-darwin-arm64', {})

    expect(() => syncRuntimeDeps({
      sourceNodeModules,
      fallbackNodeModules: [],
      targetNodeModules,
      externalRuntimePackages: ['sharp'],
      targetPlatform: 'win32',
      targetArch: 'x64',
    })).toThrow('Windows x64 运行时依赖缺失: @img/sharp-win32-x64')
  })

  test('Given Windows x64 目标包已安装 When 同步 Sharp Then 原生 binding 被复制到应用目录', () => {
    /** 当前用例的隔离根目录。 */
    const root = mkdtempSync(join(tmpdir(), 'proma-sharp-win32-present-'))
    temporaryDirectories.push(root)
    /** 包含 Windows Sharp 可选依赖的源目录。 */
    const sourceNodeModules = join(root, 'source', 'node_modules')
    /** 模拟 Electron 应用运行时依赖的目标目录。 */
    const targetNodeModules = join(root, 'target', 'node_modules')
    createPackage(sourceNodeModules, 'sharp', {
      optionalDependencies: { '@img/sharp-win32-x64': '1.0.0' },
    })
    createPackage(sourceNodeModules, '@img/sharp-win32-x64', {}, {
      'lib/sharp-win32-x64.node': 'windows-native-canary',
    })

    syncRuntimeDeps({
      sourceNodeModules,
      fallbackNodeModules: [],
      targetNodeModules,
      externalRuntimePackages: ['sharp'],
      targetPlatform: 'win32',
      targetArch: 'x64',
    })

    expect(existsSync(join(
      targetNodeModules,
      '@img',
      'sharp-win32-x64',
      'lib',
      'sharp-win32-x64.node',
    ))).toBe(true)
  })
})
