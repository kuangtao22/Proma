/**
 * Agent 本轮文件改动记录（按 run 分桶）
 *
 * 底部「本轮文件改动」汇总需要的是真实落盘结果，而不是工具入参本身。因此这里把两类
 * 证据合并进同一份记录：
 * 1. 主进程文件监听器归属到本次运行的路径 —— 覆盖 Bash、脚本、格式化器、构建工具等
 *    非写类工具产生的改动，这些改动只能从文件系统看出。
 * 2. 成功返回的写类工具入参路径 —— 覆盖不在监听根内（例如 /tmp、外部绝对路径）的文件。
 *
 * run 标识沿用渲染进程生成并回传给主进程的 startedAt。渲染时以 turn 首条 assistant
 * 消息的创建时间落在哪个 run 的时间区间内来定位分桶，不依赖消息顺序或回复文本。
 */

import { arePathsEqual } from './session-file-changes'

/** 单轮运行的文件改动记录。 */
export interface AgentRunFileChanges {
  /** 本轮运行标识（渲染进程 startedAt 的字符串形式）。 */
  runId: string
  /** 本轮运行开始时间戳（毫秒）。 */
  startedAt: number
  /** 本轮运行结束时间戳（毫秒）；缺失表示尚未收到终态，按「仍在进行」处理。 */
  endedAt?: number
  /** 已发现的文件路径，按首次发现顺序去重保存。 */
  paths: string[]
  /**
   * 是否从本轮开始前就已在跟踪。
   * 只有为 true 时才允许断言「本轮无文件改动」：中途重载或事后补建的记录可能漏掉早期改动。
   */
  observed: boolean
  /**
   * 本轮是否存在「看到了改动但无法归属到本会话」的监听事件。
   *
   * 工作区级附加目录与工作区项目根对该工作区所有会话共享，两个会话并行时无法确定写入者；
   * 这种路径不会记给任何会话，但必须留下痕迹，否则空态会把遗漏写成结论。
   */
  hasUnattributedChanges?: boolean
}

/** 每个会话保留的最大运行记录数：覆盖当前会话可见历史，同时避免长会话内存单调增长。 */
export const MAX_TRACKED_AGENT_RUNS = 30

/**
 * 结束时间容差（毫秒）。
 *
 * turn 的创建时间取自主进程批量落盘时写入的时间戳，可能在完成事件之后才被读取到；
 * 容差只放宽区间上界，不会让「下一轮」抢占上一轮：运行的开始时间判断始终是严格上界。
 */
const RUN_END_TOLERANCE_MS = 2000

/** 写入或更新单轮运行记录时的入参。 */
export interface AgentRunFileChangesInput {
  /** 本轮运行标识（与 startedAt 对应）。 */
  runId: string
  /** 本轮运行开始时间戳（毫秒）。 */
  startedAt: number
  /** 记录首次创建时是否已在跟踪本轮运行。 */
  observed?: boolean
  /** 新发现的文件路径；重复路径不会追加。 */
  path?: string
  /** 本轮结束时间戳（毫秒）；只在首次收到终态时写入。 */
  endedAt?: number
  /** 本轮出现无法归属的共享根改动；一旦为 true 不再回退。 */
  unattributed?: boolean
}

/**
 * 写入或更新一条本轮运行记录。
 *
 * 无实际变化时返回原数组引用，避免 watcher 高频事件触发无意义的重渲染。
 *
 * @param records 当前会话已有的运行记录，按创建顺序排列。
 * @param input 本次要写入的运行身份、可选路径与终态时间。
 * @param caseInsensitive 是否按大小写不敏感比较路径（Windows 为 true）。
 * @returns 新的记录数组；无变化时返回原引用。
 */
export function upsertAgentRunFileChanges(
  records: readonly AgentRunFileChanges[],
  input: AgentRunFileChangesInput,
  caseInsensitive = false,
): AgentRunFileChanges[] {
  const existingIndex = records.findIndex((record) => record.runId === input.runId)
  const normalizedPath = typeof input.path === 'string' && input.path.length > 0 ? input.path : undefined
  const existing = existingIndex >= 0 ? records[existingIndex] : undefined

  const shouldAppendPath = normalizedPath !== undefined
    && !(existing?.paths.some((path) => arePathsEqual(path, normalizedPath, caseInsensitive)) ?? false)
  const shouldCloseRun = input.endedAt !== undefined && existing?.endedAt === undefined
  const shouldMarkUnattributed = input.unattributed === true && existing?.hasUnattributedChanges !== true

  if (existing && !shouldAppendPath && !shouldCloseRun && !shouldMarkUnattributed) {
    return records as AgentRunFileChanges[]
  }

  let next: AgentRunFileChanges[]
  if (!existing) {
    // 新运行开始即证明更早的运行已经结束：补上缺失的结束时间，避免未收到完成事件的
    // 记录一直开放，把之后空闲期的改动也算进上一轮。
    const closedEarlier = records.map((record) => (
      record.endedAt === undefined && record.startedAt < input.startedAt
        ? { ...record, endedAt: input.startedAt }
        : record
    ))
    next = [...closedEarlier, {
      runId: input.runId,
      startedAt: input.startedAt,
      ...(input.endedAt !== undefined ? { endedAt: input.endedAt } : {}),
      paths: normalizedPath !== undefined ? [normalizedPath] : [],
      // observed 只在创建时确定：事后补建的记录无法代表本轮完整改动，必须保持 false。
      observed: input.observed === true,
      ...(input.unattributed === true ? { hasUnattributedChanges: true } : {}),
    }]
  } else {
    const updated: AgentRunFileChanges = {
      ...existing,
      paths: shouldAppendPath && normalizedPath !== undefined
        ? [...existing.paths, normalizedPath]
        : existing.paths,
      ...(shouldCloseRun && input.endedAt !== undefined ? { endedAt: input.endedAt } : {}),
      ...(shouldMarkUnattributed ? { hasUnattributedChanges: true } : {}),
    }
    next = records.map((record, index) => (index === existingIndex ? updated : record))
  }

  return next.length > MAX_TRACKED_AGENT_RUNS
    ? next.slice(next.length - MAX_TRACKED_AGENT_RUNS)
    : next
}

/**
 * 按 turn 的创建时间定位它所属的运行记录。
 *
 * 同一会话的运行不重叠，且 turn 的首条 assistant 消息必然产生于本轮运行区间内，
 * 因此用「开始时间 ≤ turn 创建时间 ≤ 结束时间」即可唯一命中；仍未收到终态的运行按
 * 区间开放处理。历史上早于任何记录、或缺失时间戳的 turn 返回 undefined，由调用方
 * 回退到工具入参路径。
 *
 * @param records 当前会话已有的运行记录。
 * @param turnCreatedAt turn 首条 assistant 消息的创建时间戳（毫秒）。
 * @returns 命中的运行记录；无法可靠归属时返回 undefined。
 */
export function resolveAgentRunFileChanges(
  records: readonly AgentRunFileChanges[],
  turnCreatedAt: number | undefined,
): AgentRunFileChanges | undefined {
  if (typeof turnCreatedAt !== 'number' || !Number.isFinite(turnCreatedAt)) return undefined

  let matched: AgentRunFileChanges | undefined
  for (const record of records) {
    if (record.startedAt > turnCreatedAt) continue
    if (record.endedAt !== undefined && turnCreatedAt > record.endedAt + RUN_END_TOLERANCE_MS) continue
    if (!matched || record.startedAt > matched.startedAt) matched = record
  }
  return matched
}

/**
 * 合并工具入参路径与真实落盘路径，按首次出现顺序去重。
 *
 * 工具路径放在前面：它来自本轮消息顺序，稳定且一定属于本轮；监听器路径补充
 * Bash/脚本等非工具写入，两者交集自动收敛为一条。
 *
 * @param toolPaths 写类工具入参得到的路径。
 * @param runPaths 文件监听器归属到本轮的路径。
 * @param caseInsensitive 是否按大小写不敏感比较路径（Windows 为 true）。
 * @returns 去重后的路径列表。
 */
export function mergeTurnFilePaths(
  toolPaths: readonly string[],
  runPaths: readonly string[],
  caseInsensitive = false,
): string[] {
  const merged: string[] = []
  for (const path of [...toolPaths, ...runPaths]) {
    if (!path) continue
    if (merged.some((existing) => arePathsEqual(existing, path, caseInsensitive))) continue
    merged.push(path)
  }
  return merged
}

/** 本轮文件改动的展示分类。 */
export type AgentFileChangeCategory = 'code' | 'docs' | 'artifact' | 'other'

/** 每个分类的展示名称，顺序即分组渲染顺序。 */
export const AGENT_FILE_CHANGE_CATEGORY_LABELS: Record<AgentFileChangeCategory, string> = {
  code: '代码',
  docs: '配置与文档',
  artifact: '资源与生成物',
  other: '其他',
}

/** 分类渲染顺序：代码最需要关注，生成物最容易混进来。 */
const CATEGORY_ORDER: AgentFileChangeCategory[] = ['code', 'docs', 'artifact', 'other']

/** 常见源码/脚本扩展名。 */
const CODE_EXTENSIONS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'vue', 'svelte',
  'swift', 'm', 'mm', 'h', 'hpp', 'c', 'cc', 'cpp', 'cs',
  'py', 'rb', 'php', 'go', 'rs', 'java', 'kt', 'kts', 'scala', 'lua',
  'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd',
  'sql', 'graphql', 'gql', 'proto',
  'css', 'scss', 'sass', 'less', 'styl',
])

/** 配置、文档与元数据类扩展名。 */
const DOC_EXTENSIONS = new Set([
  'md', 'mdx', 'rst', 'txt', 'adoc',
  'json', 'json5', 'jsonc', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'properties', 'plist', 'env',
  'html', 'htm', 'xml', 'csv', 'tsv',
])

/** 资源、二进制与产物类扩展名。 */
const ARTIFACT_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'icns', 'svg', 'tiff', 'heic',
  'mp3', 'wav', 'm4a', 'flac', 'ogg', 'aac',
  'mp4', 'mov', 'm4v', 'avi', 'webm', 'mkv',
  'pdf', 'zip', 'tar', 'gz', 'bz2', 'xz', '7z', 'rar', 'dmg', 'pkg', 'exe', 'dll', 'so', 'dylib', 'a', 'o', 'class', 'jar', 'wasm',
  'ttf', 'otf', 'woff', 'woff2', 'eot',
  'xcuserstate', 'xcodeproj', 'xcworkspace', 'pbxproj', 'storyboard', 'xib', 'nib',
  'db', 'sqlite', 'sqlite3', 'bin', 'dat', 'pkl', 'ckpt', 'safetensors', 'onnx',
])

/** 锁定文件按「生成物」处理：内容由包管理器生成，人工只关心它被更新过。 */
const LOCKFILE_NAMES = new Set([
  'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb',
  'cargo.lock', 'poetry.lock', 'pipfile.lock', 'composer.lock', 'gemfile.lock',
  'podfile.lock', 'package.resolved', 'gradle.lockfile', 'pubspec.lock', 'mix.lock',
])

/** 无扩展名但属于构建/脚本入口的常见文件名。 */
const BUILD_FILE_NAMES = new Set([
  'makefile', 'gnumakefile', 'dockerfile', 'containerfile', 'gemfile', 'rakefile', 'procfile', 'brewfile',
])

/** 生成物目录：命中即归入「资源与生成物」，避免构建产物混在业务代码里。 */
const GENERATED_DIR_SEGMENTS = new Set([
  'node_modules', 'dist', 'build', 'out', 'target', 'deriveddata', 'derivedsources',
  '.next', '.nuxt', '.svelte-kit', '.turbo', '.parcel-cache', '__pycache__', '.gradle',
  '.venv', 'venv', 'coverage', 'vendor', '.build', 'pods', 'carthage', 'obj', 'bin',
])

/** 生成文件名判据：压缩、sourcemap、代码生成器产物。 */
const GENERATED_FILE_PATTERNS = [
  /\.min\.(js|css)$/i,
  /\.(js|css)\.map$/i,
  /\.generated\.[^./]+$/i,
  /_pb2(_grpc)?\.py$/i,
  /\.pb\.(swift|go|cc|h|java)$/i,
  /\.designer\.cs$/i,
  /\.g\.(cs|i\.cs)$/i,
]

/** 取路径最后一段。 */
function getBaseName(filePath: string): string {
  const segments = filePath.split(/[\\/]/)
  return segments[segments.length - 1] ?? ''
}

/** 取小写扩展名，无扩展名返回空串。 */
function getExtension(filePath: string): string {
  const baseName = getBaseName(filePath)
  const dotIndex = baseName.lastIndexOf('.')
  if (dotIndex <= 0 || dotIndex === baseName.length - 1) return ''
  return baseName.slice(dotIndex + 1).toLowerCase()
}

/**
 * 判断单个改动文件属于哪个展示分类。
 *
 * 判据全部基于路径本身，不读取文件内容也不做额外 IO：生成物目录与生成文件名优先
 * 命中（避免构建产物被当成业务代码），其次按锁定文件、扩展名、构建脚本名判断；
 * 无法判断时归入「其他」，不猜测成代码。
 *
 * @param filePath 文件路径（绝对路径或相对路径均可）。
 * @returns 展示分类。
 */
export function classifyAgentFileChange(filePath: string): AgentFileChangeCategory {
  if (!filePath) return 'other'

  const segments = filePath.split(/[\\/]/).filter(Boolean).map((segment) => segment.toLowerCase())
  const baseName = getBaseName(filePath).toLowerCase()
  const directorySegments = segments.slice(0, -1)

  if (directorySegments.some((segment) => GENERATED_DIR_SEGMENTS.has(segment))) return 'artifact'
  if (GENERATED_FILE_PATTERNS.some((pattern) => pattern.test(baseName))) return 'artifact'
  if (LOCKFILE_NAMES.has(baseName)) return 'artifact'
  if (BUILD_FILE_NAMES.has(baseName)) return 'code'
  // 点文件（.gitignore / .env.local / .eslintrc.cjs）属于配置，不因「无扩展名」落入其他。
  if (baseName.startsWith('.')) return 'docs'

  const extension = getExtension(filePath)
  if (!extension) return 'other'
  if (CODE_EXTENSIONS.has(extension)) return 'code'
  if (DOC_EXTENSIONS.has(extension)) return 'docs'
  if (ARTIFACT_EXTENSIONS.has(extension)) return 'artifact'
  return 'other'
}

/** 单个分类分组。 */
export interface AgentFileChangeGroup {
  /** 分类标识。 */
  category: AgentFileChangeCategory
  /** 分类展示名称。 */
  label: string
  /** 该分类下的文件路径，保持传入顺序。 */
  paths: string[]
}

/**
 * 把本轮改动文件按展示分类分组。
 *
 * 空分类不返回，调用方无需再过滤；分组顺序固定为代码、配置与文档、资源与生成物、其他。
 *
 * @param paths 已去重的本轮改动文件路径。
 * @returns 仅包含非空分类的分组列表。
 */
export function groupAgentFileChangesByCategory(paths: readonly string[]): AgentFileChangeGroup[] {
  const buckets = new Map<AgentFileChangeCategory, string[]>()
  for (const path of paths) {
    if (!path) continue
    const category = classifyAgentFileChange(path)
    const bucket = buckets.get(category)
    if (bucket) bucket.push(path)
    else buckets.set(category, [path])
  }

  return CATEGORY_ORDER
    .filter((category) => (buckets.get(category)?.length ?? 0) > 0)
    .map((category) => ({
      category,
      label: AGENT_FILE_CHANGE_CATEGORY_LABELS[category],
      paths: buckets.get(category)!,
    }))
}
