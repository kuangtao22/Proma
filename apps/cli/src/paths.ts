/**
 * 会话存储路径解析（electron-free）。
 *
 * CLI 不依赖 Electron，通过固定 `~/.proma-location.json` 读取活动数据根。
 * 优先级：显式 `--config-dir` > `PROMA_CONFIG_DIR` > 开发目录开关 >
 * 固定 locator > 默认 `~/.proma`。locator 指向离线根时明确报错，不静默回退。
 *
 * 与 config-paths.ts 的目录布局保持一致：
 *   <configDir>/agent-sessions.json        会话索引
 *   <configDir>/agent-sessions/<id>.jsonl   单会话消息
 */
import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, win32 } from 'node:path'
import { isDataRootLocatorFile } from '@proma/shared'
import type { DataRootLocatorFile } from '@proma/shared'

export interface PathOptions {
  /** 显式指定配置目录（绝对路径）。优先级最高。 */
  configDir?: string
  /** 使用开发目录 .proma-dev（等价于 PROMA_DEV=1）。 */
  dev?: boolean
}

/** CLI 路径解析的进程依赖；测试按实例注入，避免修改全局环境。 */
export interface PathResolutionContext {
  /** 固定 locator 所在的用户 home。 */
  homeDir: string
  /** 当前 CLI 进程环境变量。 */
  env: NodeJS.ProcessEnv
}

/**
 * 按固定优先级解析 CLI 业务配置根。
 *
 * @param opts 命令行显式路径选项。
 * @param context home 与环境变量依赖；测试可注入独立实例。
 * @returns 当前 CLI 应读取的业务数据根。
 */
export function resolveConfigDir(
  opts: PathOptions = {},
  context: PathResolutionContext = { homeDir: homedir(), env: process.env },
): string {
  if (opts.configDir !== undefined) return requireAbsoluteConfigDir(opts.configDir, '--config-dir')
  if (context.env.PROMA_CONFIG_DIR !== undefined) {
    return requireAbsoluteConfigDir(context.env.PROMA_CONFIG_DIR, 'PROMA_CONFIG_DIR')
  }

  /** 保留既有 CLI 开发目录开关的显式覆盖语义。 */
  const useDev = opts.dev || context.env.PROMA_DEV === '1'
  if (useDev) return join(context.homeDir, '.proma-dev')

  /** locator 位于可迁移数据根之外，因此离线时仍可读取。 */
  const locatorPath = join(context.homeDir, '.proma-location.json')
  /** 与 Electron 保持相同恢复顺序：主文件、原子写临时文件、备份文件。 */
  const locatorCandidates = [locatorPath, `${locatorPath}.tmp`, `${locatorPath}.bak`]
  const existingCandidates = locatorCandidates.filter((candidatePath) => existsSync(candidatePath))
  if (existingCandidates.length === 0) return join(context.homeDir, '.proma')

  /** 首个 schema-valid 候选即为权威 locator；可用性失败时禁止尝试旧备份。 */
  const locatorFile = readFirstValidLocatorFile(existingCandidates)
  assertReadableDataRoot(locatorFile.activeRoot)
  return locatorFile.activeRoot
}

/** 校验显式配置根，拒绝依赖当前工作目录的相对路径。 */
function requireAbsoluteConfigDir(value: string, source: '--config-dir' | 'PROMA_CONFIG_DIR'): string {
  if (!isPortableAbsolutePath(value)) throw new Error(`${source} 必须是绝对路径`)
  return value
}

/** 按顺序读取候选，返回首个通过 schema 校验的 locator。 */
function readFirstValidLocatorFile(locatorPaths: string[]): DataRootLocatorFile {
  for (const locatorPath of locatorPaths) {
    try {
      /** JSON 先保持 unknown，校验通过后才作为路径使用。 */
      const value: unknown = JSON.parse(readFileSync(locatorPath, 'utf-8'))
      if (isDataRootLocatorFile(value)) return value
    } catch {
      /** 单个候选损坏时继续读取下一个恢复候选。 */
    }
  }

  throw new Error('数据根定位文件无效')
}

/** locator 存在时必须使用其活动根；离线或权限不足均不回退。 */
function assertReadableDataRoot(root: string): void {
  try {
    if (!statSync(root).isDirectory()) throw new Error('not-directory')
    accessSync(root, constants.R_OK | constants.X_OK)
  } catch {
    throw new Error('数据根不可用')
  }
}

/** 跨宿主平台识别 POSIX、Win32 drive 与 UNC 绝对路径。 */
function isPortableAbsolutePath(value: string): boolean {
  return isAbsolute(value) || win32.isAbsolute(value)
}

export function getSessionsIndexPath(opts: PathOptions = {}): string {
  return join(resolveConfigDir(opts), 'agent-sessions.json')
}

export function getSessionsDir(opts: PathOptions = {}): string {
  return join(resolveConfigDir(opts), 'agent-sessions')
}

export function getSessionMessagesPath(id: string, opts: PathOptions = {}): string {
  return join(getSessionsDir(opts), `${id}.jsonl`)
}
