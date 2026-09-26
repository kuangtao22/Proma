/**
 * 监听事件的路径归属判定（纯逻辑）
 *
 * watcher 事件本身不带来源会话，渲染进程只能先按「哪些运行中会话的受管根覆盖了这个
 * 改动路径」缩小范围。当一个路径同时落在两个运行中会话的根里——工作区级附加目录与
 * 工作区项目根对该工作区的所有会话共享，这在实际使用中很常见——仅凭根无法判定写入者。
 *
 * 此时改用「该会话本轮工具调用触碰过的绝对路径」作为证据：只有证据指向改动路径所在
 * 子目录（严格深于共享根）的会话才算写入者。三种结论都必须能表达，不能替用户猜：
 * - unique：恰好一个会话有证据，改动归属它；
 * - unknown：没有任何会话有证据（会话刚重载、命令行只出现共享根本身等）；
 * - ambiguous：两个及以上会话都有证据，二者都可能是写入者。
 */

/** 单个候选会话的归属依据。 */
export interface WatcherAttributionCandidate {
  /** 候选会话 id。 */
  sessionId: string
  /**
   * 改动路径落在该会话的哪个受管根下。
   * 附加文件按「其所在目录」传入，这样「证据必须比共享根更具体」的判据对所有来源一致。
   */
  ownedRoot: string
  /** 该会话本轮工具调用里出现过的绝对路径；命令行命令文本里解析出的路径也计入。 */
  activityPaths: readonly string[]
}

/** 归属结论；非 unique 时必须由调用方按「无法归属」处理，不能静默丢弃。 */
export type WatcherPathAttribution =
  | { kind: 'unique'; sessionId: string }
  | { kind: 'ambiguous' }
  | { kind: 'unknown' }

/** 单个路径的最大长度：命令行里可能夹带超长文本，超过即认为不是路径。 */
const MAX_PATH_LENGTH = 4096

/** 工具入参里直接承载路径的字段名。 */
const PATH_INPUT_KEYS = ['file_path', 'filePath', 'notebook_path', 'path', 'cwd', 'dir', 'directory']

/** 需要按命令文本解析路径的字段名。 */
const COMMAND_INPUT_KEYS = ['command', 'cmd']

/**
 * 命令文本中的绝对路径：`/…`、`C:\…`、`\\…`。
 * 只在明确的分隔符之后起头，避免把 `http://`、算式中途的 `/` 误判成路径。
 */
const ABSOLUTE_PATH_PATTERN = /(?:^|[\s'"`(=:,])((?:\/|[A-Za-z]:[\\/]|\\\\)[^\s'"`;|&<>),]*)/g

/** 判断是否为绝对路径（与渲染进程其它模块同一口径）。 */
function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || path.startsWith('\\\\') || /^[A-Za-z]:[\\/]/.test(path)
}

/** 归一化后按段拆分路径，供公共前缀比较使用。 */
function toPathSegments(path: string, caseInsensitive: boolean): string[] {
  const normalized = path.replace(/\\/g, '/')
  const segments = normalized.split('/').filter((segment) => segment.length > 0)
  return caseInsensitive ? segments.map((segment) => segment.toLowerCase()) : segments
}

/**
 * 计算两个路径的公共头部段数。
 *
 * 以段为单位（而不是字符），这样 `/a/bc` 与 `/a/bcd` 不会被算成同一目录下的证据。
 *
 * @param left 路径 A。
 * @param right 路径 B。
 * @param caseInsensitive 是否按大小写不敏感比较（Windows 为 true）。
 * @returns 公共头部段数；无公共段时为 0。
 */
export function countCommonLeadingSegments(left: string, right: string, caseInsensitive = false): number {
  const leftSegments = toPathSegments(left, caseInsensitive)
  const rightSegments = toPathSegments(right, caseInsensitive)
  const limit = Math.min(leftSegments.length, rightSegments.length)
  let common = 0
  while (common < limit && leftSegments[common] === rightSegments[common]) common += 1
  return common
}

/**
 * 从工具入参里提取本轮触碰过的绝对路径。
 *
 * 覆盖两类来源：①直接承载路径的字段（`file_path`/`path`/`cwd` 等）；②命令行文本里出现
 * 的绝对路径字面量——Agent 常用 `python3 - <<'PY' … Path('/abs/x.py')` 或
 * `R=/abs/repo; sed -n … "$R/子路径"` 这类写法，只有命令文本里有证据。
 * 变量拼接出的路径（`$R/子路径`）解析不出来，但赋值处通常已出现绝对路径前缀，足以用于
 * 子目录级判定。
 *
 * @param input 工具调用入参（未知类型，非对象时返回空数组）。
 * @param maxPaths 最多返回多少条；用于给长会话的活动证据设上界。
 * @returns 去重后的绝对路径列表，按发现顺序排列。
 */
export function extractToolActivityPaths(input: unknown, maxPaths = 64): string[] {
  if (!input || typeof input !== 'object') return []
  const record = input as Record<string, unknown>
  const paths: string[] = []
  const pushPath = (candidate: string | undefined): void => {
    if (!candidate) return
    const trimmed = candidate.trim()
    if (trimmed.length === 0 || trimmed.length > MAX_PATH_LENGTH) return
    // `//host/path` 是 URL 的协议相对写法（`https://host/path` 会匹配出 `//host/path`），
    // 不是本机路径；`file:///a` 同理。
    if (trimmed.startsWith('//')) return
    if (!isAbsolutePath(trimmed)) return
    if (paths.includes(trimmed)) return
    if (paths.length >= maxPaths) return
    paths.push(trimmed)
  }

  for (const key of PATH_INPUT_KEYS) {
    const value = record[key]
    if (typeof value === 'string') pushPath(value)
  }

  for (const key of COMMAND_INPUT_KEYS) {
    const value = record[key]
    if (typeof value !== 'string' || value.length === 0) continue
    for (const match of value.matchAll(ABSOLUTE_PATH_PATTERN)) {
      pushPath(match[1])
      if (paths.length >= maxPaths) break
    }
  }

  return paths
}

/**
 * 判定共享根上的改动属于哪个会话。
 *
 * 判据：候选会话的本轮活动路径必须与改动路径共享「严格深于该候选受管根」的目录前缀。
 * 也就是说，两个会话都只在共享根里活动时不会给出结论，而是如实报 unknown。
 * 只有一个候选覆盖该路径时不存在歧义，直接归属（不做证据要求）。
 *
 * @param changedPath 监听器上报的改动路径。
 * @param candidates 覆盖该路径的运行中会话及其活动证据。
 * @param caseInsensitive 是否按大小写不敏感比较（Windows 为 true）。
 * @returns 归属结论；候选为空时为 unknown。
 */
export function resolveWatcherPathAttribution(
  changedPath: string,
  candidates: readonly WatcherAttributionCandidate[],
  caseInsensitive = false,
): WatcherPathAttribution {
  if (candidates.length === 0) return { kind: 'unknown' }
  if (candidates.length === 1) return { kind: 'unique', sessionId: candidates[0]!.sessionId }

  const writers: string[] = []

  for (const candidate of candidates) {
    const requiredDepth = toPathSegments(candidate.ownedRoot, caseInsensitive).length + 1
    const hasEvidence = candidate.activityPaths.some((activityPath) => (
      countCommonLeadingSegments(activityPath, changedPath, caseInsensitive) >= requiredDepth
    ))
    if (hasEvidence) writers.push(candidate.sessionId)
  }

  if (writers.length === 1) return { kind: 'unique', sessionId: writers[0]! }
  return writers.length === 0 ? { kind: 'unknown' } : { kind: 'ambiguous' }
}
