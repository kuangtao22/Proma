import { isServerOpsLoopbackAddress } from '@proma/shared'
import type {
  ServerOpsDataCredentialDiscoveryInput,
  ServerOpsDataCredentialDiscoveryResult,
  ServerOpsDataEngine,
  ServerOpsDiscoveredCredentialApplyInput,
  ServerOpsDiscoveredCredentialApplyResult,
  ServerOpsDiscoveredCredentialCandidate,
} from '@proma/shared'
import { execFileAsync } from '../async-command'

/**
 * 本机数据源凭据发现（L1）。
 *
 * 目标：本地调试库的口令通常是脚本随机生成后写进容器环境的，用户自己也不知道；
 * 这一层只做"发现"——在**回环地址**上按"发布地址 + 端口"精确匹配本机容器，
 * 读出容器环境里的账号与口令，交给用户在数据源弹窗里点选填入。
 *
 * 边界（有意为之，不要放宽）：
 * - 只处理回环地址：私有网段是另一台机器，按端口匹配会把别的库的口令串过来。
 * - 只读容器环境变量，不读用户文件，也不接收任何手输路径。
 * - 不创建账号、不改权限、不保存；口令只在主进程内存与单次 IPC 回执里存在。
 */

/** 容器发布的一个端口映射。 */
export interface ServerOpsContainerPort {
  /** 发布到的主机地址；空串、`0.0.0.0`、`::` 都表示"所有网卡"，因此包含回环。 */
  hostIp: string
  hostPort: number
}

/** 发现所需的容器摘要。 */
export interface ServerOpsContainerSummary {
  name: string
  ports: ServerOpsContainerPort[]
}

/**
 * 容器运行时探测接口。
 *
 * 抽成接口是为了让单测注入夹具：真实实现会调用 podman/docker CLI，
 * 测试绝不能依赖本机是否装了容器运行时。
 */
export interface ServerOpsContainerInspection {
  /** 列出当前运行的容器；返回 null 表示本机没有可用的容器运行时。 */
  listContainers(): Promise<ServerOpsContainerSummary[] | null>
  /** 读取指定容器的环境变量（`K=V` 形式）；返回 null 表示读取失败。 */
  readContainerEnv(containerName: string): Promise<string[] | null>
}

/** 单次命令的超时与输出上限，避免容器运行时卡住主进程。 */
const COMMAND_TIMEOUT_MS = 5_000
const MAX_COMMAND_OUTPUT = 1_048_576
/** 候选数量上限，与共享合同保持一致。 */
const MAX_CANDIDATES = 8
/** 同一目标最多读取几个容器的环境变量，避免异常环境下放大开销。 */
const MAX_CONTAINERS = 3
/** 容器名白名单：只允许容器运行时规范里的字符，避免把外部输出当作命令参数注入。 */
const CONTAINER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u

/** 候选里"账号键"的取值范围，用于生成稳定且不泄漏凭据的候选标识。 */
type CandidateAccountKey = 'root' | 'user' | 'password'

/** 内部候选：带口令，只在本模块内流转；对外一律剥掉口令。 */
interface InternalCandidate {
  candidate: ServerOpsDiscoveredCredentialCandidate
  password: string | null
}

/** 归一化地址：统一小写、去掉方括号，并把"所有网卡"收敛成一个哨兵值。 */
function normalizeAddress(address: string): string {
  const trimmed = address.trim().toLowerCase().replace(/^\[/u, '').replace(/\]$/u, '')
  if (trimmed === '' || trimmed === '0.0.0.0' || trimmed === '::' || trimmed === '*') return 'all'
  if (trimmed === 'localhost') return '127.0.0.1'
  return trimmed
}

/** 判断容器发布的端口是否就是用户填写的回环目标。 */
function matchesTarget(port: ServerOpsContainerPort, targetIp: string, targetPort: number): boolean {
  if (port.hostPort !== targetPort) return false
  const published = normalizeAddress(port.hostIp)
  return published === 'all' || published === targetIp
}

/** 解析 `K=V` 形式的环境变量列表；格式异常的行直接忽略。 */
function parseEnvironment(entries: readonly string[]): Map<string, string> {
  const environment = new Map<string, string>()
  for (const entry of entries) {
    const separator = entry.indexOf('=')
    if (separator <= 0) continue
    const key = entry.slice(0, separator)
    const value = entry.slice(separator + 1)
    if (value === '' || environment.has(key)) continue
    environment.set(key, value)
  }
  return environment
}

/** 组装一条候选；`accountKey` 参与候选标识，因此必须稳定。 */
function createCandidate(options: {
  containerName: string
  accountKey: CandidateAccountKey
  label: string
  username?: string
  password: string
  privilege: ServerOpsDiscoveredCredentialCandidate['privilege']
}): InternalCandidate {
  return {
    candidate: {
      id: `${options.containerName}|${options.accountKey}`,
      label: options.label,
      hasPassword: true,
      origin: 'container-env',
      privilege: options.privilege,
      ...(options.username === undefined ? {} : { username: options.username }),
    },
    password: options.password,
  }
}

/**
 * 按引擎把容器环境映射为候选。
 *
 * 只识别官方镜像约定的键名（MySQL 官方镜像、PostgreSQL 官方镜像、Redis 的 `REDIS_PASSWORD`），
 * 不去猜自定义变量名——猜错会把不相干的变量值当成口令填进连接，代价是用户看到莫名其妙的认证失败。
 */
function buildCandidates(engine: ServerOpsDataEngine, containerName: string, environment: Map<string, string>): InternalCandidate[] {
  /** 该容器贡献的候选。 */
  const candidates: InternalCandidate[] = []
  if (engine === 'mysql') {
    const rootPassword = environment.get('MYSQL_ROOT_PASSWORD')
    if (rootPassword !== undefined) {
      candidates.push(createCandidate({
        containerName,
        accountKey: 'root',
        label: `容器 ${containerName} 的 MYSQL_ROOT_PASSWORD`,
        username: 'root',
        password: rootPassword,
        privilege: 'superuser',
      }))
    }
    const username = environment.get('MYSQL_USER')
    const password = environment.get('MYSQL_PASSWORD')
    if (username !== undefined && password !== undefined) {
      candidates.push(createCandidate({
        containerName,
        accountKey: 'user',
        label: `容器 ${containerName} 的 MYSQL_USER / MYSQL_PASSWORD`,
        username,
        password,
        privilege: 'user',
      }))
    }
    return candidates
  }
  if (engine === 'postgresql') {
    const password = environment.get('POSTGRES_PASSWORD')
    if (password !== undefined) {
      const username = environment.get('POSTGRES_USER') ?? 'postgres'
      candidates.push(createCandidate({
        containerName,
        accountKey: 'password',
        label: `容器 ${containerName} 的 POSTGRES_PASSWORD`,
        username,
        password,
        privilege: username === 'postgres' ? 'superuser' : 'user',
      }))
    }
    return candidates
  }
  if (engine === 'redis') {
    const password = environment.get('REDIS_PASSWORD')
    if (password !== undefined) {
      candidates.push(createCandidate({
        containerName,
        accountKey: 'password',
        label: `容器 ${containerName} 的 REDIS_PASSWORD`,
        password,
        privilege: 'unknown',
      }))
    }
  }
  /** SQLite 是本地文件，没有容器凭据语义。 */
  return candidates
}

/**
 * 收集目标上的全部候选（含口令）。
 *
 * @param input 用户已填的地址、端口与引擎
 * @param inspection 容器探测实现（生产为 CLI，测试为夹具）
 * @returns 去重后的候选数组
 */
async function collectLocalCredentials(
  input: ServerOpsDataCredentialDiscoveryInput,
  inspection: ServerOpsContainerInspection,
): Promise<InternalCandidate[]> {
  /** 地址必须落在回环；私有网段与公网一律拒绝，避免按端口串到别的库。 */
  const targetIp = normalizeAddress(input.address)
  if (!isServerOpsLoopbackAddress(targetIp)) throw new Error('SERVER_OPS_DATA_CREDENTIAL_ADDRESS_UNSUPPORTED')
  if (input.engine === 'sqlite') return []

  /** 容器运行时不可用时按"未发现"处理，不向用户暴露 CLI 细节。 */
  const containers = await inspection.listContainers()
  if (containers === null) return []

  /** 精确匹配发布地址与端口，并且最多探测若干个容器。 */
  const matched = containers
    .filter((container) => CONTAINER_NAME_PATTERN.test(container.name))
    .filter((container) => container.ports.some((port) => matchesTarget(port, targetIp, input.port)))
    .slice(0, MAX_CONTAINERS)

  /** 逐个读取环境变量；单个容器读取失败不影响其它候选。 */
  const collected: InternalCandidate[] = []
  for (const container of matched) {
    const environment = await inspection.readContainerEnv(container.name)
    if (environment === null) continue
    collected.push(...buildCandidates(input.engine, container.name, parseEnvironment(environment)))
  }

  /** 按候选标识去重并裁剪数量，保证结果满足共享合同。 */
  const seen = new Set<string>()
  return collected.filter((entry) => {
    if (seen.has(entry.candidate.id)) return false
    seen.add(entry.candidate.id)
    return seen.size <= MAX_CANDIDATES
  })
}

/** 发现本机可用凭据；结果不含口令值。 */
export async function discoverServerOpsLocalCredentials(
  input: ServerOpsDataCredentialDiscoveryInput,
  inspection: ServerOpsContainerInspection,
): Promise<ServerOpsDataCredentialDiscoveryResult> {
  const collected = await collectLocalCredentials(input, inspection)
  return { candidates: collected.map((entry) => entry.candidate) }
}

/**
 * 取回某个候选的账号与口令。
 *
 * 重新执行一次发现而不是缓存上次结果：候选从产生到点击之间可能已经变了，
 * 用过期的凭据去填连接只会让用户看到一次莫名的认证失败。
 */
export async function applyServerOpsDiscoveredCredential(
  input: ServerOpsDiscoveredCredentialApplyInput,
  inspection: ServerOpsContainerInspection,
): Promise<ServerOpsDiscoveredCredentialApplyResult> {
  const collected = await collectLocalCredentials(input, inspection)
  const matched = collected.find((entry) => entry.candidate.id === input.candidateId)
  if (matched === undefined) throw new Error('SERVER_OPS_DATA_CREDENTIAL_CANDIDATE_NOT_FOUND')
  return {
    password: matched.password,
    ...(matched.candidate.username === undefined ? {} : { username: matched.candidate.username }),
  }
}

/** 把 `inspect --format '{{json .Config.Env}}'` 的输出解析成环境变量数组。 */
export function parseContainerEnvironment(stdout: string): string[] | null {
  try {
    const parsed: unknown = JSON.parse(stdout.trim())
    if (!Array.isArray(parsed)) return null
    return parsed.filter((entry): entry is string => typeof entry === 'string')
  } catch {
    return null
  }
}

/** 解析 `host:port->...` 形式的端口发布字符串（docker 的 `Ports` 字段就是这种形状）。 */
function parsePublishedPorts(text: string): ServerOpsContainerPort[] {
  /** 逐个匹配"可选主机 + 端口 ->"，兼容 `0.0.0.0:13307->3306/tcp` 与 `13307->3306/tcp`。 */
  const matched = text.matchAll(/(?:([0-9A-Za-z:.]+):)?(\d+)->/gu)
  const ports: ServerOpsContainerPort[] = []
  for (const match of matched) {
    const hostPort = Number(match[2])
    if (!Number.isInteger(hostPort) || hostPort < 1 || hostPort > 65_535) continue
    ports.push({ hostIp: match[1] ?? 'all', hostPort })
  }
  return ports
}

/** 从 podman 的端口条目里取出发布地址与端口。 */
function readPodmanPort(entry: unknown): ServerOpsContainerPort | null {
  if (typeof entry === 'string') return parsePublishedPorts(entry)[0] ?? null
  if (typeof entry !== 'object' || entry === null) return null
  const record = entry as Record<string, unknown>
  const hostPort = typeof record.host_port === 'number' ? record.host_port : Number.NaN
  if (!Number.isInteger(hostPort) || hostPort < 1 || hostPort > 65_535) return null
  const hostIp = typeof record.host_ip === 'string' ? record.host_ip : 'all'
  return { hostIp, hostPort }
}

/** 读取容器名；podman 给数组，docker 给字符串。 */
function readContainerName(value: unknown): string | null {
  if (typeof value === 'string' && value !== '') return value
  if (Array.isArray(value) && typeof value[0] === 'string' && value[0] !== '') return value[0]
  return null
}

/** 解析 `podman ps --format json` 的输出。 */
export function parsePodmanContainerList(stdout: string): ServerOpsContainerSummary[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout.trim() === '' ? '[]' : stdout)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const containers: ServerOpsContainerSummary[] = []
  for (const entry of parsed) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as Record<string, unknown>
    const name = readContainerName(record.Names)
    if (name === null) continue
    const rawPorts = Array.isArray(record.Ports) ? record.Ports : []
    const ports = rawPorts.map((port) => readPodmanPort(port)).filter((port): port is ServerOpsContainerPort => port !== null)
    containers.push({ name, ports })
  }
  return containers
}

/** 解析 `docker ps --format '{{json .}}'` 的逐行 JSON 输出。 */
export function parseDockerContainerList(stdout: string): ServerOpsContainerSummary[] {
  const containers: ServerOpsContainerSummary[] = []
  for (const line of stdout.split('\n')) {
    if (line.trim() === '') continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    if (typeof parsed !== 'object' || parsed === null) continue
    const record = parsed as Record<string, unknown>
    const name = readContainerName(record.Names)
    if (name === null) continue
    const ports = typeof record.Ports === 'string' ? parsePublishedPorts(record.Ports) : []
    containers.push({ name, ports })
  }
  return containers
}

/** 已解析出的容器运行时。 */
interface ContainerRuntime {
  file: string
  kind: 'podman' | 'docker'
}

/** 生产实现：依次尝试 podman 与 docker，成功一个就记住，避免每次重复探测。 */
export function createContainerCliInspection(): ServerOpsContainerInspection {
  /** 首次成功解析出的运行时；不缓存"不可用"，用户之后启动容器运行时应当能恢复。 */
  let resolved: ContainerRuntime | null = null

  /** 执行一条固定参数的命令；失败一律返回 null。 */
  const run = async (runtime: ContainerRuntime, args: readonly string[]): Promise<string | null> => {
    try {
      const result = await execFileAsync(runtime.file, args, {
        encoding: 'utf8',
        timeout: COMMAND_TIMEOUT_MS,
        env: process.env,
      })
      const stdout = typeof result.stdout === 'string' ? result.stdout : ''
      return stdout.length > MAX_COMMAND_OUTPUT ? null : stdout
    } catch {
      return null
    }
  }

  /** 探测可用的容器运行时。 */
  const ensureRuntime = async (): Promise<ContainerRuntime | null> => {
    if (resolved !== null) return resolved
    for (const candidate of [{ file: 'podman', kind: 'podman' }, { file: 'docker', kind: 'docker' }] as const) {
      const output = await run(candidate, ['ps', '--format', 'json'])
      if (output !== null) {
        resolved = candidate
        return resolved
      }
    }
    return null
  }

  return {
    listContainers: async () => {
      const runtime = await ensureRuntime()
      if (runtime === null) return null
      /** podman 用 `--format json` 的整体 JSON，docker 用逐行 JSON。 */
      const output = runtime.kind === 'podman'
        ? await run(runtime, ['ps', '--format', 'json'])
        : await run(runtime, ['ps', '--format', '{{json .}}'])
      if (output === null) return null
      return runtime.kind === 'podman' ? parsePodmanContainerList(output) : parseDockerContainerList(output)
    },
    readContainerEnv: async (containerName) => {
      if (!CONTAINER_NAME_PATTERN.test(containerName)) return null
      const runtime = await ensureRuntime()
      if (runtime === null) return null
      const output = await run(runtime, ['inspect', containerName, '--format', '{{json .Config.Env}}'])
      return output === null ? null : parseContainerEnvironment(output)
    },
  }
}
