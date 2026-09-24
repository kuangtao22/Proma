#!/usr/bin/env bun
/** 构建跨平台 Server Ops 配置锁 N-API addon。 */

import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const appDir = resolve(scriptDir, '..')
const source = resolve(appDir, 'native/server-ops-config-lock/server-ops-config-lock-addon.cc')
const output = process.env.SERVER_OPS_CONFIG_LOCK_OUTPUT
  ? resolve(process.env.SERVER_OPS_CONFIG_LOCK_OUTPUT)
  : resolve(appDir, 'resources/server-ops-config-lock/server-ops-config-lock.node')
const nodeVersion = execFileSync('node', ['-p', 'process.versions.node'], { encoding: 'utf8' }).trim()
const nodeGypRoot = process.platform === 'darwin'
  ? resolve(homedir(), 'Library/Caches/node-gyp')
  : process.platform === 'win32'
    ? resolve(process.env.LOCALAPPDATA ?? homedir(), 'node-gyp/Cache')
    : resolve(homedir(), '.cache/node-gyp')
const nodeRoot = resolve(nodeGypRoot, nodeVersion)
const nodeHeaders = resolve(nodeRoot, 'include/node')

/**
 * 通过现有 node-gyp 构建 Windows addon，并将结果复制到固定资源路径。
 *
 * 无入参或返回值；复用当前 Node 头文件与 Node-API 8，由 node-gyp 注入
 * win_delay_load_hook、delayimp 和延迟导入，使 Node API 解析到 Electron/Proma 宿主。
 */
function buildWindowsAddon(): void {
  /** 编译中间文件仅落在临时目录，避免多个构建相互覆盖。 */
  const buildDirectory = mkdtempSync(join(tmpdir(), 'proma-server-ops-lock-build-'))
  /** 从仓库现有依赖解析构建工具，不下载或新增依赖。 */
  const require = createRequire(import.meta.url)
  try {
    copyFileSync(source, join(buildDirectory, 'server-ops-config-lock-addon.cc'))
    copyFileSync(resolve(dirname(source), 'binding.gyp'), join(buildDirectory, 'binding.gyp'))
    execFileSync('node', [
      require.resolve('node-gyp/bin/node-gyp.js'), 'rebuild',
      // 下载缓存按架构保存 node.lib；--nodedir 则假定为 Node 源码的 Release/node.lib。
      `--directory=${buildDirectory}`, `--devdir=${nodeGypRoot}`, `--target=${nodeVersion}`, `--arch=${process.arch}`,
    ], { stdio: 'inherit' })
    copyFileSync(join(buildDirectory, 'build/Release/server-ops-config-lock.node'), output)
  } finally {
    rmSync(buildDirectory, { recursive: true, force: true })
  }
}

if (!existsSync(source)) throw new Error(`Server Ops config lock source not found: ${source}`)
if (!existsSync(resolve(nodeHeaders, 'node_api.h'))) {
  execFileSync('bun', ['x', 'node-gyp', 'install', '--devdir', nodeGypRoot, nodeVersion], { stdio: 'inherit' })
}
if (!existsSync(resolve(nodeHeaders, 'node_api.h'))) {
  throw new Error(`Node-API headers not found for Node ${nodeVersion}`)
}
mkdirSync(dirname(output), { recursive: true })
rmSync(output, { force: true })

if (process.platform === 'darwin') {
  execFileSync('xcrun', [
    'clang++', '-O2', '-std=c++17', '-DNAPI_VERSION=8', '-Wall', '-Wextra',
    '-bundle', '-undefined', 'dynamic_lookup', '-I', nodeHeaders, source, '-o', output,
  ], { stdio: 'inherit' })
} else if (process.platform === 'linux') {
  execFileSync(process.env.CXX || 'g++', [
    '-O2', '-std=c++17', '-DNAPI_VERSION=8', '-Wall', '-Wextra', '-shared', '-fPIC',
    '-I', nodeHeaders, source, '-o', output,
  ], { stdio: 'inherit' })
} else if (process.platform === 'win32') {
  const nodeLibrary = resolve(nodeRoot, process.arch === 'arm64' ? 'arm64' : 'x64', 'node.lib')
  if (!existsSync(nodeLibrary)) throw new Error(`Node import library not found: ${nodeLibrary}`)
  buildWindowsAddon()
} else {
  throw new Error(`Unsupported config lock platform: ${process.platform}`)
}

console.log(`[server-ops-config-lock] built ${output}`)
