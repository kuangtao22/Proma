#!/usr/bin/env bun
/**
 * 同步 Electron 打包时需要保留为 external 的主进程运行时依赖。
 *
 * Bun workspace 会把依赖 hoist 到仓库根 node_modules；electron-builder 的 files
 * 规则以 apps/electron 为 appDir，因此打包前需要把 external 依赖闭包复制到
 * apps/electron/node_modules，保证 packaged app 中 Node 模块解析可用。
 */

import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

interface PackageManifest {
  name?: string
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
}

interface RuntimeDependency {
  name: string
  optional: boolean
}

interface SyncContext {
  sourceNodeModules: string
  fallbackNodeModules: readonly string[]
  targetNodeModules: string
  copiedPackages: Map<string, string>
  topLevelPackageSources: Map<string, string>
  skippedOptionalPackages: string[]
}

interface RuntimeTargetContract {
  /** 面向构建日志的目标平台名称。 */
  displayName: string
  /** 目标平台必须进入安装包的运行时包。 */
  requiredPackages: readonly string[]
}

export interface SyncRuntimeDepsOptions {
  sourceNodeModules?: string
  /** 主源目录无法解析依赖时继续搜索的 node_modules；测试传空数组以保持 fixture 隔离。 */
  fallbackNodeModules?: readonly string[]
  targetNodeModules?: string
  externalRuntimePackages?: readonly string[]
  /** 是否在同步前清空目标 node_modules；打包需要 true，开发启动使用 false 避免破坏本地调试内容。 */
  cleanTarget?: boolean
  /** 安装包目标操作系统；与 targetArch 同时提供时启用平台依赖合同。 */
  targetPlatform?: string
  /** 安装包目标 CPU 架构；与 targetPlatform 同时提供时启用平台依赖合同。 */
  targetArch?: string
}

export interface SyncRuntimeDepsResult {
  copiedPackageCount: number
  copiedPackages: string[]
  skippedOptionalPackages: string[]
}

export const EXTERNAL_RUNTIME_PACKAGES: readonly string[] = [
  '@earendil-works/pi-coding-agent',
  // pi-coding-agent 0.85.0 的根入口会加载 experimental server，但发布包漏声明了该依赖。
  '@earendil-works/pi-server',
  '@earendil-works/pi-agent-core',
  '@earendil-works/pi-ai',
  'pdfjs-dist',
  'sharp',
  // 独立 Terminal utility process 通过 require 加载其 native PTY binding。
  'node-pty',
  // 独立 Server Ops utility process 使用 ssh2 的纯 JavaScript crypto 路径。
  'ssh2',
]

/** ssh2 的性能型可选依赖含 native binding，跨平台打包统一走 JS fallback。 */
const SKIPPED_OPTIONAL_RUNTIME_PACKAGES = new Set(['cpu-features', 'nan'])

/** 需要在打包前强制验证的目标平台运行时依赖。 */
const RUNTIME_TARGET_CONTRACTS = new Map<string, RuntimeTargetContract>([
  ['win32-x64', {
    displayName: 'Windows x64',
    requiredPackages: ['@img/sharp-win32-x64'],
  }],
])

const appDir = resolve(import.meta.dir, '..')
const repoRoot = resolve(appDir, '../..')
const repoNodeModules = join(repoRoot, 'node_modules')
const bunVirtualNodeModules = join(repoNodeModules, '.bun', 'node_modules')
const defaultSourceNodeModules = existsSync(bunVirtualNodeModules) ? bunVirtualNodeModules : repoNodeModules
const defaultTargetNodeModules = join(appDir, 'node_modules')

function getPackageDir(nodeModulesDir: string, packageName: string): string {
  if (packageName.startsWith('@')) {
    const parts = packageName.split('/')
    const scope = parts[0]
    const name = parts[1]
    if (!scope || !name) throw new Error(`非法 scoped package 名称: ${packageName}`)
    return join(nodeModulesDir, scope, name)
  }
  return join(nodeModulesDir, packageName)
}

function resolvePackageFromNodeModules(nodeModulesDir: string, packageName: string): string | undefined {
  const packageDir = getPackageDir(nodeModulesDir, packageName)
  if (existsSync(join(packageDir, 'package.json'))) {
    return realpathSync(packageDir)
  }
  return undefined
}

function resolvePackageUpwards(startDir: string, packageName: string): string | undefined {
  let currentDir = resolve(startDir)

  while (true) {
    const resolvedPackageDir = resolvePackageFromNodeModules(join(currentDir, 'node_modules'), packageName)
    if (resolvedPackageDir) return resolvedPackageDir

    const parentDir = dirname(currentDir)
    if (parentDir === currentDir) return undefined
    currentDir = parentDir
  }
}

function resolvePackageSourceDir(ctx: SyncContext, packageName: string, resolveFromDir?: string): string | undefined {
  if (resolveFromDir) {
    const parentResolvedDir = resolvePackageUpwards(resolveFromDir, packageName)
    if (parentResolvedDir) return parentResolvedDir
  }

  for (const nodeModulesDir of [ctx.sourceNodeModules, ...ctx.fallbackNodeModules]) {
    const resolvedPackageDir = resolvePackageFromNodeModules(nodeModulesDir, packageName)
    if (resolvedPackageDir) return resolvedPackageDir
  }

  return undefined
}

function readPackageManifest(sourceDir: string): PackageManifest {
  return JSON.parse(readFileSync(join(sourceDir, 'package.json'), 'utf-8')) as PackageManifest
}

function listRuntimeDependencies(manifest: PackageManifest): RuntimeDependency[] {
  const dependencies = Object.keys(manifest.dependencies ?? {}).map((name) => ({ name, optional: false }))
  const optionalDependencies = Object.keys(manifest.optionalDependencies ?? {}).map((name) => ({ name, optional: true }))
  return [...dependencies, ...optionalDependencies]
}

function copyPackage(
  ctx: SyncContext,
  packageName: string,
  optional = false,
  resolveFromDir?: string,
  targetNodeModules = ctx.targetNodeModules,
  sourceAncestors = new Set<string>(),
): void {
  const sourceDir = resolvePackageSourceDir(ctx, packageName, resolveFromDir)
  if (!sourceDir) {
    if (optional) {
      ctx.skippedOptionalPackages.push(packageName)
      return
    }
    throw new Error(`缺少运行时依赖: ${packageName} (${getPackageDir(ctx.sourceNodeModules, packageName)})`)
  }
  const manifest = readPackageManifest(sourceDir)
  const isTopLevel = targetNodeModules === ctx.targetNodeModules

  const targetDir = getPackageDir(targetNodeModules, packageName)
  const targetKey = resolve(targetDir)
  const existingSourceDir = ctx.copiedPackages.get(targetKey)
  if (existingSourceDir) {
    if (existingSourceDir === sourceDir) return
    throw new Error(`运行时依赖版本冲突: ${packageName} 已复制自 ${existingSourceDir}，又解析到 ${sourceDir}`)
  }

  ctx.copiedPackages.set(targetKey, sourceDir)
  if (isTopLevel) ctx.topLevelPackageSources.set(packageName, sourceDir)

  mkdirSync(dirname(targetDir), { recursive: true })
  rmSync(targetDir, { recursive: true, force: true })
  cpSync(sourceDir, targetDir, {
    recursive: true,
    dereference: true,
    force: true,
    preserveTimestamps: true,
    // ssh2 安装脚本可能在包内编译可选 binding；正式包固定排除以保持三平台一致。
    filter: (source) => packageName !== 'ssh2' || !source.endsWith('.node'),
  })

  const nextAncestors = new Set(sourceAncestors)
  nextAncestors.add(sourceDir)
  for (const dependency of listRuntimeDependencies(manifest)) {
    copyDependency(ctx, dependency, packageName, sourceDir, targetDir, nextAncestors)
  }
}

function copyDependency(
  ctx: SyncContext,
  dependency: RuntimeDependency,
  parentPackageName: string,
  parentSourceDir: string,
  parentTargetDir: string,
  sourceAncestors: Set<string>,
): void {
  if (parentPackageName === 'ssh2' && dependency.optional && SKIPPED_OPTIONAL_RUNTIME_PACKAGES.has(dependency.name)) {
    ctx.skippedOptionalPackages.push(dependency.name)
    return
  }
  const sourceDir = resolvePackageSourceDir(ctx, dependency.name, parentSourceDir)
  if (!sourceDir) {
    if (dependency.optional) {
      ctx.skippedOptionalPackages.push(dependency.name)
      return
    }
    throw new Error(`缺少运行时依赖: ${dependency.name} (${parentSourceDir})`)
  }

  if (sourceAncestors.has(sourceDir)) return

  const topLevelSourceDir = ctx.topLevelPackageSources.get(dependency.name)
  if (!topLevelSourceDir || topLevelSourceDir === sourceDir) {
    copyPackage(ctx, dependency.name, dependency.optional, parentSourceDir, ctx.targetNodeModules, sourceAncestors)
    return
  }

  copyPackage(
    ctx,
    dependency.name,
    dependency.optional,
    parentSourceDir,
    join(parentTargetDir, 'node_modules'),
    sourceAncestors,
  )
}

function assertNoAbsoluteSymlinks(dir: string): void {
  if (!existsSync(dir)) return
  const stack = [dir]
  const offenders: string[] = []
  while (stack.length > 0) {
    const current = stack.pop()!
    for (const entry of readdirSync(current)) {
      const fullPath = join(current, entry)
      const stat = lstatSync(fullPath)
      if (stat.isSymbolicLink()) {
        const target = readlinkSync(fullPath)
        if (target.startsWith('/')) offenders.push(fullPath)
        continue
      }
      if (stat.isDirectory()) stack.push(fullPath)
    }
  }
  if (offenders.length > 0) {
    throw new Error(`检测到绝对 symlink，会导致打包后模块解析失效: ${offenders.slice(0, 10).join(', ')}`)
  }
}

/** 校验目标平台的可选原生包确实由本次同步复制，避免生成启动后才报错的安装包。 */
function assertRuntimeTargetContract(ctx: SyncContext, targetPlatform?: string, targetArch?: string): void {
  if (targetPlatform === undefined && targetArch === undefined) return
  if (!targetPlatform || !targetArch) {
    throw new Error('targetPlatform 与 targetArch 必须同时提供')
  }

  /** 当前目标平台与架构对应的稳定合同键。 */
  const targetKey = `${targetPlatform}-${targetArch}`
  /** 当前目标平台需要满足的运行时依赖合同。 */
  const contract = RUNTIME_TARGET_CONTRACTS.get(targetKey)
  if (!contract) return

  for (const packageName of contract.requiredPackages) {
    /** 必须由本次同步写入的应用级包路径。 */
    const targetPackageKey = resolve(getPackageDir(ctx.targetNodeModules, packageName))
    if (!ctx.copiedPackages.has(targetPackageKey)) {
      throw new Error(`${contract.displayName} 运行时依赖缺失: ${packageName}`)
    }
  }
}

function prepareTargetNodeModules(sourceNodeModules: string, targetNodeModules: string): void {
  const source = resolve(sourceNodeModules)
  const target = resolve(targetNodeModules)
  if (source === target) {
    throw new Error('sourceNodeModules 与 targetNodeModules 不能相同，避免误删源依赖')
  }
  if (basename(target) !== 'node_modules') {
    throw new Error(`拒绝清理非 node_modules 目录: ${target}`)
  }

  rmSync(target, { recursive: true, force: true })
  mkdirSync(target, { recursive: true })
}

export function syncRuntimeDeps(options: SyncRuntimeDepsOptions = {}): SyncRuntimeDepsResult {
  const ctx: SyncContext = {
    sourceNodeModules: options.sourceNodeModules ?? defaultSourceNodeModules,
    fallbackNodeModules: options.fallbackNodeModules ?? [bunVirtualNodeModules, repoNodeModules],
    targetNodeModules: options.targetNodeModules ?? defaultTargetNodeModules,
    copiedPackages: new Map<string, string>(),
    topLevelPackageSources: new Map<string, string>(),
    skippedOptionalPackages: [],
  }
  const externalRuntimePackages = options.externalRuntimePackages ?? EXTERNAL_RUNTIME_PACKAGES

  if (options.cleanTarget ?? true) {
    prepareTargetNodeModules(ctx.sourceNodeModules, ctx.targetNodeModules)
  } else {
    const source = resolve(ctx.sourceNodeModules)
    const target = resolve(ctx.targetNodeModules)
    if (source === target) {
      throw new Error('sourceNodeModules 与 targetNodeModules 不能相同，避免覆盖源依赖')
    }
    if (basename(target) !== 'node_modules') {
      throw new Error(`拒绝同步到非 node_modules 目录: ${target}`)
    }
    mkdirSync(target, { recursive: true })
  }

  for (const packageName of externalRuntimePackages) {
    copyPackage(ctx, packageName)
  }

  assertRuntimeTargetContract(ctx, options.targetPlatform, options.targetArch)
  assertNoAbsoluteSymlinks(ctx.targetNodeModules)

  return {
    copiedPackageCount: ctx.copiedPackages.size,
    copiedPackages: [...ctx.copiedPackages.keys()],
    skippedOptionalPackages: [...ctx.skippedOptionalPackages],
  }
}

/** 读取形如 --name=value 的命令行参数。 */
function readCliOption(name: string): string | undefined {
  /** 当前参数使用的完整前缀。 */
  const prefix = `--${name}=`
  /** 命令行中匹配此前缀的参数。 */
  const argument = process.argv.find((value) => value.startsWith(prefix))
  return argument?.slice(prefix.length)
}

function main(): void {
  /** Windows 等跨平台打包时显式传入的目标操作系统。 */
  const targetPlatform = readCliOption('target-platform')
  /** Windows 等跨平台打包时显式传入的目标 CPU 架构。 */
  const targetArch = readCliOption('target-arch')
  /** 当前同步执行结果，用于输出可审计的依赖数量。 */
  const result = syncRuntimeDeps({
    cleanTarget: !process.argv.includes('--no-clean'),
    targetPlatform,
    targetArch,
  })
  const skipped = result.skippedOptionalPackages.length > 0
    ? `，跳过未安装 optional 依赖 ${result.skippedOptionalPackages.length} 个`
    : ''
  console.log(`[runtime-deps] 已同步 ${result.copiedPackageCount} 个主进程运行时依赖${skipped}`)
}

if (import.meta.main) {
  main()
}
