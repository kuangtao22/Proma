#!/usr/bin/env bun
/** 使用当前平台系统 C++ 编译器构建稳定目录 helper。 */

import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const appDir = resolve(scriptDir, '..')
const source = resolve(appDir, 'native/stable-directory/stable-directory-helper.cc')
const executableName = process.platform === 'win32' ? 'stable-directory-helper.exe' : 'stable-directory-helper'
const output = resolve(appDir, 'resources/stable-directory', executableName)

/** 在 Windows PATH 未初始化时定位 Visual Studio 开发者命令脚本。 */
function findVisualStudioDeveloperCommand(): string {
  const programFilesX86 = process.env['ProgramFiles(x86)']
  if (!programFilesX86) throw new Error('ProgramFiles(x86) is unavailable')
  const vswhere = resolve(programFilesX86, 'Microsoft Visual Studio/Installer/vswhere.exe')
  if (!existsSync(vswhere)) throw new Error(`vswhere.exe not found: ${vswhere}`)
  const installationPath = execFileSync(vswhere, [
    '-latest',
    '-products', '*',
    '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
    '-property', 'installationPath',
  ], { encoding: 'utf8' }).trim()
  const developerCommand = resolve(installationPath, 'Common7/Tools/VsDevCmd.bat')
  if (!installationPath || !existsSync(developerCommand)) {
    throw new Error('Visual Studio C++ developer command not found')
  }
  return developerCommand
}

/** 为 Windows 批处理文件安全引用单个参数。 */
function quoteWindowsArgument(value: string): string {
  return `"${value.replaceAll('"', '""')}"`
}

/**
 * 通过临时批处理文件初始化 Visual Studio 环境并运行编译器。
 *
 * 不能把带空格的 VsDevCmd.bat 路径直接拼进 `cmd /s /c`：该组合会再次处理
 * 最外层引号，在 GitHub Windows runner 上把引号本身当成命令名的一部分。
 */
function compileWithVisualStudioDeveloperCommand(
  developerCommand: string,
  targetArchitecture: string,
  compilerArgs: string[],
): void {
  const commandDirectory = mkdtempSync(join(tmpdir(), 'proma-stable-directory-build-'))
  const commandFile = join(commandDirectory, 'build.cmd')
  const command = [
    '@echo off',
    `call ${quoteWindowsArgument(developerCommand)} -no_logo -arch=${targetArchitecture} -host_arch=${targetArchitecture}`,
    'if errorlevel 1 exit /b %errorlevel%',
    `cl ${compilerArgs.map(quoteWindowsArgument).join(' ')}`,
  ].join('\r\n')

  try {
    writeFileSync(commandFile, `${command}\r\n`, 'utf8')
    execFileSync('cmd.exe', ['/d', '/c', commandFile], { stdio: 'inherit' })
  } finally {
    rmSync(commandDirectory, { recursive: true, force: true })
  }
}

if (!existsSync(source)) throw new Error(`Stable directory helper source not found: ${source}`)
mkdirSync(dirname(output), { recursive: true })
rmSync(output, { force: true })

if (process.platform === 'darwin') {
  execFileSync('xcrun', ['clang++', '-O2', '-std=c++17', '-Wall', '-Wextra', source, '-o', output], { stdio: 'inherit' })
} else if (process.platform === 'linux') {
  const compiler = process.env.CXX || 'g++'
  execFileSync(compiler, ['-O2', '-std=c++17', '-Wall', '-Wextra', source, '-o', output], { stdio: 'inherit' })
} else if (process.platform === 'win32') {
  const compilerArgs = ['/nologo', '/O2', '/std:c++17', '/EHsc', '/W4', source, `/Fe:${output}`]
  try {
    execFileSync('cl', compilerArgs, { stdio: 'inherit' })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    const developerCommand = findVisualStudioDeveloperCommand()
    const targetArchitecture = process.arch === 'arm64' ? 'arm64' : 'x64'
    compileWithVisualStudioDeveloperCommand(developerCommand, targetArchitecture, compilerArgs)
  }
} else {
  throw new Error(`Unsupported stable directory helper platform: ${process.platform}`)
}

if (process.platform !== 'win32') chmodSync(output, 0o755)
console.log(`[stable-directory-native] built ${output}`)
