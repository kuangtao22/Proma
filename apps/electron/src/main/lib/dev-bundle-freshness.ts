/**
 * 开发态 bundle 新鲜度检查。
 *
 * 主进程与 preload 是 esbuild 打包产物，renderer 却由 Vite 直接提供源码。
 * 只改动共享合同而没有重建主进程时，界面已经按新合同渲染，主进程仍按旧合同校验，
 * 表现出来就是「界面看得见、保存被拒绝」这类没有线索的假故障。
 * 这里只在开发态做一次 mtime 比较，过期就打印明确告警，不改变任何运行行为。
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

/** 需要保持最新的打包产物，与 dev-bundle-readiness 的清单一致。 */
const BUNDLE_RELATIVE_PATHS = ['dist/main.cjs', 'dist/preload.cjs'] as const
/** 参与比较的源码目录：主进程源码与共享合同。 */
const SOURCE_RELATIVE_PATHS = ['src/main', 'src/preload', '../../packages/shared/src'] as const
/** 单个目录最多递归的层数，避免深层依赖目录拖慢启动。 */
const MAX_SCAN_DEPTH = 8

export interface DevBundleFreshnessOptions {
  /** 应用根目录；缺省使用当前文件所在包目录。 */
  root?: string
  /** 参与比较的源码目录（相对 root）；缺省为主进程、preload 与共享合同。 */
  sourcePaths?: readonly string[]
}

/** 递归收集目录下最新的文件修改时间；读取失败按 0 处理，不阻塞启动。 */
function newestMtimeMs(path: string, depth = 0): number {
  if (depth > MAX_SCAN_DEPTH) return 0
  try {
    const stat = statSync(path)
    if (stat.isFile()) return stat.mtimeMs
    if (!stat.isDirectory()) return 0
    let newest = 0
    for (const entry of readdirSync(path)) {
      const child = join(path, entry)
      const childMtime = newestMtimeMs(child, depth + 1)
      if (childMtime > newest) newest = childMtime
    }
    return newest
  } catch {
    return 0
  }
}

/**
 * 检测打包产物是否落后于源码。
 * 入参：可选根目录；返回值：过期时给出可读诊断，正常或无法判断时返回 null。
 * 无法判断的情况（产物缺失、目录缺失）一律返回 null，避免误报。
 */
export function detectStaleDevBundle(options: DevBundleFreshnessOptions = {}): string | null {
  const root = options.root ?? resolve(import.meta.dir, '..', '..')
  const sourcePaths = options.sourcePaths ?? SOURCE_RELATIVE_PATHS
  const stale: string[] = []
  for (const bundle of BUNDLE_RELATIVE_PATHS) {
    const bundlePath = resolve(root, bundle)
    if (!existsSync(bundlePath)) continue
    const bundleMtime = newestMtimeMs(bundlePath)
    const sourceMtime = Math.max(...sourcePaths.map((source) => newestMtimeMs(resolve(root, source))))
    if (sourceMtime > bundleMtime) stale.push(bundle)
  }
  if (stale.length === 0) return null
  return `[开发构建] ${stale.join('、')} 落后于源码，主进程可能仍在运行旧合同；请重建（bun run build:main / build:preload）或改用 bun run dev`
}
