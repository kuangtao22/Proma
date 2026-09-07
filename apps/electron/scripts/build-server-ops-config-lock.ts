#!/usr/bin/env bun
/** 构建跨平台 Server Ops 配置锁 N-API addon。 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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

/** 为 Windows 批处理参数保留空格并拒绝引号逃逸。 */
function quoteWindowsArgument(value: string): string {
  return `"${value.replaceAll('"', '""')}"`
}

/** 在 Visual Studio 未进入 PATH 时定位开发者环境脚本。 */
function findVisualStudioDeveloperCommand(): string {
  const programFilesX86 = process.env['ProgramFiles(x86)']
  if (!programFilesX86) throw new Error('ProgramFiles(x86) is unavailable')
  const vswhere = resolve(programFilesX86, 'Microsoft Visual Studio/Installer/vswhere.exe')
  if (!existsSync(vswhere)) throw new Error(`vswhere.exe not found: ${vswhere}`)
  const installationPath = execFileSync(vswhere, [
    '-latest', '-products', '*',
    '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
    '-property', 'installationPath',
  ], { encoding: 'utf8' }).trim()
  const developerCommand = resolve(installationPath, 'Common7/Tools/VsDevCmd.bat')
  if (!installationPath || !existsSync(developerCommand)) {
    throw new Error('Visual Studio C++ developer command not found')
  }
  return developerCommand
}

/** 通过隔离批处理初始化 Visual Studio 环境并执行 cl。 */
function compileWithVisualStudio(compilerArguments: string[]): void {
  const commandDirectory = mkdtempSync(join(tmpdir(), 'proma-server-ops-lock-build-'))
  const commandFile = join(commandDirectory, 'build.cmd')
  const architecture = process.arch === 'arm64' ? 'arm64' : 'x64'
  const command = [
    '@echo off',
    `call ${quoteWindowsArgument(findVisualStudioDeveloperCommand())} -no_logo -arch=${architecture} -host_arch=${architecture}`,
    'if errorlevel 1 exit /b %errorlevel%',
    `cl ${compilerArguments.map(quoteWindowsArgument).join(' ')}`,
  ].join('\r\n')
  try {
    writeFileSync(commandFile, `${command}\r\n`, 'utf8')
    execFileSync('cmd.exe', ['/d', '/c', commandFile], { stdio: 'inherit' })
  } finally {
    rmSync(commandDirectory, { recursive: true, force: true })
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
  const compilerArguments = [
    '/nologo', '/O2', '/std:c++17', '/EHsc', '/W4', '/LD', `/I${nodeHeaders}`,
    source, nodeLibrary, `/Fe:${output}`,
  ]
  try {
    execFileSync('cl', compilerArguments, { stdio: 'inherit' })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    compileWithVisualStudio(compilerArguments)
  }
} else {
  throw new Error(`Unsupported config lock platform: ${process.platform}`)
}

console.log(`[server-ops-config-lock] built ${output}`)
