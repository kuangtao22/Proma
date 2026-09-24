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

/**
 * 需要保持最新的打包产物，与 dev-bundle-readiness 的清单一致。
 *
 * 每个产物只和它真正打包进去的源码目录比较：
 * 运行时产物（server-ops / agent / terminal）走 `src/utility`，
 * 其中 agent-runtime 还会包进 `src/main/lib/adapters`。
 * 逐个比较而不是统一取最大 mtime，否则改主进程会误报运行时产物过期。
 */
const DEV_BUNDLES: readonly { bundle: string; sources: readonly string[]; rebuild: string }[] = [
  { bundle: 'dist/main.cjs', sources: ['src/main', 'src/preload', '../../packages/shared/src'], rebuild: 'bun run build:main' },
  { bundle: 'dist/preload.cjs', sources: ['src/preload', '../../packages/shared/src'], rebuild: 'bun run build:preload' },
  { bundle: 'dist/server-ops-runtime.cjs', sources: ['src/utility/server-ops-runtime.ts', 'src/utility/server-ops', '../../packages/shared/src'], rebuild: 'bun run build:server-ops-runtime' },
  /** agent-runtime 会包进主进程的 Pi 适配器，因此只盯 `src/main/lib`（不含 ipc.ts 等不影响它的文件）。 */
  { bundle: 'dist/agent-runtime.cjs', sources: ['src/utility/agent-runtime.ts', 'src/utility/agent-runtime-request-timeout.ts', 'src/main/lib', '../../packages/shared/src'], rebuild: 'bun run build:agent-runtime' },
  { bundle: 'dist/terminal-runtime.cjs', sources: ['src/utility/terminal-runtime.ts', 'src/utility/terminal-shell-resolver.ts', '../../packages/shared/src'], rebuild: 'bun run build:terminal-runtime' },
  { bundle: 'dist/api-workbench-runtime.cjs', sources: ['src/utility/api-workbench-runtime.ts', 'src/main/lib/api-workbench', '../../packages/shared/src'], rebuild: 'bun run build:api-workbench-runtime' },
] as const
/** 单个目录最多递归的层数，避免深层依赖目录拖慢启动。 */
const MAX_SCAN_DEPTH = 8

export interface DevBundleFreshnessOptions {
  /** 应用根目录；缺省使用当前文件所在包目录。 */
  root?: string
  /**
   * 覆盖比较用的源码目录（相对 root）。
   *
   * 提供时对所有产物统一生效，供测试与自定义场景使用；
   * 缺省按每个产物自己的真实依赖目录逐个比较。
   */
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
  /**
   * 缺省根目录按源码布局推导（`src/main/lib` → 应用根）。
   *
   * 打包后的主进程只有 `dist/`，路径层级不同，因此 `main/index.ts` 会显式传入根目录；
   * 这里保留的推导只服务测试与直接 import 的场景。
   */
  const root = options.root ?? resolve(import.meta.dir, '..', '..', '..')
  /** 过期产物及其重建命令。 */
  const stale: { bundle: string; rebuild: string }[] = []
  for (const entry of DEV_BUNDLES) {
    const bundlePath = resolve(root, entry.bundle)
    if (!existsSync(bundlePath)) continue
    const bundleMtime = newestMtimeMs(bundlePath)
    /** 本次比较使用的源码目录：显式覆盖优先，否则用该产物自己的依赖目录。 */
    const sourcePaths = options.sourcePaths ?? entry.sources
    const sourceMtime = Math.max(...sourcePaths.map((source) => newestMtimeMs(resolve(root, source))))
    if (sourceMtime > bundleMtime) stale.push({ bundle: entry.bundle, rebuild: entry.rebuild })
  }
  if (stale.length === 0) return null
  return `[开发构建] ${stale.map((entry) => `${entry.bundle}（${entry.rebuild}）`).join('、')} 落后于源码，主进程或运行时可能仍在跑旧合同；也可改用 bun run dev`
}
