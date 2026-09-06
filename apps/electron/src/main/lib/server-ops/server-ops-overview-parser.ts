import { parseServerOpsOverviewInput, parseServerOpsOverviewResult } from '@proma/shared'
import type {
  ServerOpsOverviewCpu,
  ServerOpsOverviewFilesystem,
  ServerOpsOverviewMemory,
  ServerOpsOverviewNetwork,
  ServerOpsOverviewProcess,
  ServerOpsOverviewResult,
  ServerOpsOverviewSwap,
  ServerOpsOverviewSystem,
  ServerOpsOverviewWarningCode,
} from '@proma/shared'

/** 固定采集脚本的采样窗口。 */
const SAMPLE_WINDOW_MS = 250
/** 远端概览输出允许的 UTF-8 最大字节数。 */
const MAX_OUTPUT_BYTES = 512 * 1024
/** 文件系统快照公开上限。 */
const MAX_FILESYSTEMS = 128
/** 高资源进程快照公开上限。 */
const MAX_PROCESSES = 10
/** 复用编码器校验真实 UTF-8 字节数。 */
const OUTPUT_TEXT_ENCODER = new TextEncoder()

/** 标量组的原始字段与完整性状态。 */
interface ScalarGroupState {
  values: Map<string, string[]>
  invalid: boolean
}

/** 创建一个尚未接收字段的标量组。 */
function createScalarGroupState(): ScalarGroupState {
  return { values: new Map<string, string[]>(), invalid: false }
}

/** 创建统一的概览输出错误，避免透出解析细节。 */
function createOutputInvalidError(): Error {
  return new Error('SERVER_OPS_OVERVIEW_OUTPUT_INVALID')
}

/** 校验入口时间戳，失败时使用稳定输出错误码。 */
function validateCapturedAt(capturedAt: number): void {
  if (!Number.isSafeInteger(capturedAt) || capturedAt < 0 || capturedAt > 8_640_000_000_000_000) {
    throw createOutputInvalidError()
  }
}

/** 校验 stdout 类型和 UTF-8 字节上限，明显超限时避免额外编码分配。 */
function validateOutputSize(stdout: string): void {
  if (typeof stdout !== 'string' || stdout.length > MAX_OUTPUT_BYTES) throw createOutputInvalidError()
  if (OUTPUT_TEXT_ENCODER.encode(stdout).byteLength > MAX_OUTPUT_BYTES) throw createOutputInvalidError()
}

/** 判断文本字段是否非空、单行、无 tab/NUL 且未超过字符上限。 */
function isBoundedText(value: string | undefined, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength && !/[\t\r\n\0]/.test(value)
}

/** 解析指定范围内的十进制安全整数。 */
function parseInteger(value: string | undefined, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number | undefined {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)$/.test(value)) return undefined
  /** 由严格十进制文本转换出的候选整数。 */
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : undefined
}

/** 解析指定范围内的非负有限十进制数。 */
function parseNumber(value: string | undefined, maximum = Number.MAX_SAFE_INTEGER): number | undefined {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) return undefined
  /** 由严格十进制文本转换出的候选数值。 */
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= maximum ? parsed : undefined
}

/** 向标量组写入唯一字段；重复或字段数错误会让整组失效。 */
function addScalarField(state: ScalarGroupState, field: string, values: string[], expectedCount: number): void {
  if (values.length !== expectedCount || state.values.has(field)) {
    state.invalid = true
    return
  }
  state.values.set(field, values)
}

/** 从完整且合法的 system 字段生成公开对象。 */
function parseSystemGroup(state: ScalarGroupState): ServerOpsOverviewSystem | undefined {
  /** system 允许且必须完整出现的字段名。 */
  const requiredFields = ['hostname', 'osName', 'osVersion', 'kernel', 'arch', 'uptimeSeconds']
  if (state.invalid || state.values.size !== requiredFields.length || requiredFields.some((field) => !state.values.has(field))) return undefined
  /** system 文本字段。 */
  const hostname = state.values.get('hostname')?.[0]
  const osName = state.values.get('osName')?.[0]
  const osVersion = state.values.get('osVersion')?.[0]
  const kernel = state.values.get('kernel')?.[0]
  const arch = state.values.get('arch')?.[0]
  /** system 运行秒数。 */
  const uptimeSeconds = parseInteger(state.values.get('uptimeSeconds')?.[0], 0)
  if (!isBoundedText(hostname, 255) || !isBoundedText(osName, 256) || !isBoundedText(osVersion, 256)
    || !isBoundedText(kernel, 256) || !isBoundedText(arch, 64) || uptimeSeconds === undefined) return undefined
  return { hostname, osName, osVersion, kernel, arch, uptimeSeconds }
}

/** 从完整且合法的 CPU 字段生成公开对象。 */
function parseCpuGroup(state: ScalarGroupState): ServerOpsOverviewCpu | undefined {
  if (state.invalid || state.values.size !== 3 || !state.values.has('cores') || !state.values.has('usagePercent') || !state.values.has('load')) return undefined
  /** CPU 核心数。 */
  const cores = parseInteger(state.values.get('cores')?.[0], 1, 65_536)
  /** CPU 使用百分比。 */
  const usagePercent = parseNumber(state.values.get('usagePercent')?.[0], 100)
  /** 三个标准负载窗口值。 */
  const loadValues = state.values.get('load') ?? []
  const load1 = parseNumber(loadValues[0])
  const load5 = parseNumber(loadValues[1])
  const load15 = parseNumber(loadValues[2])
  if (cores === undefined || usagePercent === undefined || loadValues.length !== 3
    || load1 === undefined || load5 === undefined || load15 === undefined) return undefined
  return { cores, usagePercent, load1, load5, load15 }
}

/** 从唯一 memory 记录生成公开对象。 */
function parseMemoryGroup(state: ScalarGroupState): ServerOpsOverviewMemory | undefined {
  /** memory 的四个字节字段。 */
  const values = state.values.get('record') ?? []
  if (state.invalid || state.values.size !== 1 || values.length !== 4) return undefined
  /** 经边界校验的 memory 字节字段。 */
  const numbers = values.map((value) => parseInteger(value, 0))
  if (numbers.some((value) => value === undefined)) return undefined
  /** 已完成类型收窄的内存字节字段。 */
  const [totalBytes, usedBytes, availableBytes, cacheBytes] = numbers as [number, number, number, number]
  if (usedBytes > totalBytes || availableBytes > totalBytes || usedBytes !== totalBytes - availableBytes || cacheBytes > totalBytes) return undefined
  return { totalBytes, usedBytes, availableBytes, cacheBytes }
}

/** 从唯一 swap 记录生成公开对象。 */
function parseSwapGroup(state: ScalarGroupState): ServerOpsOverviewSwap | undefined {
  /** swap 的两个字节字段。 */
  const values = state.values.get('record') ?? []
  if (state.invalid || state.values.size !== 1 || values.length !== 2) return undefined
  /** 经边界校验的 swap 字节字段。 */
  const totalBytes = parseInteger(values[0], 0)
  const usedBytes = parseInteger(values[1], 0)
  return totalBytes === undefined || usedBytes === undefined || usedBytes > totalBytes ? undefined : { totalBytes, usedBytes }
}

/** 从唯一 network 记录生成公开对象。 */
function parseNetworkGroup(state: ScalarGroupState): ServerOpsOverviewNetwork | undefined {
  /** network 的两个每秒字节字段。 */
  const values = state.values.get('record') ?? []
  if (state.invalid || state.values.size !== 1 || values.length !== 2) return undefined
  /** 经边界校验的 network 速率。 */
  const receiveBytesPerSecond = parseInteger(values[0], 0)
  const transmitBytesPerSecond = parseInteger(values[1], 0)
  return receiveBytesPerSecond === undefined || transmitBytesPerSecond === undefined
    ? undefined
    : { receiveBytesPerSecond, transmitBytesPerSecond }
}

/** 解析单条文件系统记录，失败时由调用方添加分类 warning。 */
function parseFilesystemRecord(fields: string[]): ServerOpsOverviewFilesystem | undefined {
  if (fields.length !== 7) return undefined
  /** 文件系统文本字段。 */
  const [device, filesystem, mountPoint] = fields
  /** 文件系统容量与占用百分比字段。 */
  const totalBytes = parseInteger(fields[3], 0)
  const usedBytes = parseInteger(fields[4], 0)
  const availableBytes = parseInteger(fields[5], 0)
  const usagePercent = parseNumber(fields[6], 100)
  if (!isBoundedText(device, 1_024) || !isBoundedText(filesystem, 128) || !isBoundedText(mountPoint, 1_024)
    || totalBytes === undefined || usedBytes === undefined || availableBytes === undefined || usagePercent === undefined) return undefined
  if (usedBytes > totalBytes || availableBytes > totalBytes || usedBytes > totalBytes - availableBytes) return undefined
  return { device, filesystem, mountPoint, totalBytes, usedBytes, availableBytes, usagePercent }
}

/** 解析单条进程记录，失败时由调用方添加分类 warning。 */
function parseProcessRecord(fields: string[]): ServerOpsOverviewProcess | undefined {
  if (fields.length !== 4) return undefined
  /** 进程 ID 与资源占用。 */
  const pid = parseInteger(fields[0], 1, 2_147_483_647)
  const cpuPercent = parseNumber(fields[2], 6_553_600)
  const memoryPercent = parseNumber(fields[3], 100)
  if (pid === undefined || !isBoundedText(fields[1], 256) || cpuPercent === undefined || memoryPercent === undefined) return undefined
  return { pid, name: fields[1], cpuPercent, memoryPercent }
}

/** 把固定采集行协议解析为 Renderer 可见的有界快照。 */
export function parseServerOpsOverviewOutput(hostId: string, stdout: string, capturedAt: number): ServerOpsOverviewResult {
  parseServerOpsOverviewInput({ hostId })
  validateCapturedAt(capturedAt)
  validateOutputSize(stdout)

  /** 当前快照的结构化警告，使用 Set 防止同一分类重复。 */
  const warnings = new Set<ServerOpsOverviewWarningCode>()
  /** 各标量类别的独立解析状态。 */
  const systemState = createScalarGroupState()
  const cpuState = createScalarGroupState()
  const memoryState = createScalarGroupState()
  const swapState = createScalarGroupState()
  const networkState = createScalarGroupState()
  /** 逐行解析后的文件系统，最多保留 128 项。 */
  const filesystems: ServerOpsOverviewFilesystem[] = []
  /** 逐行解析后的进程，最多保留 10 项。 */
  const processes: ServerOpsOverviewProcess[] = []
  /** 已发布的 PID，用于丢弃脚本或远端输出中的重复进程记录。 */
  const processIds = new Set<number>()
  /** 是否收到过文件系统记录，用于区分完整空输出与正常列表。 */
  let filesystemRecordSeen = false
  /** 是否收到过进程记录，用于区分完整空输出与正常列表。 */
  let processRecordSeen = false

  for (const line of stdout.split('\n')) {
    if (line.length === 0) continue
    /** 当前行严格按 tab 切分后的字段。 */
    const [recordType, ...fields] = line.split('\t')
    if (recordType === 'system') {
      /** system 当前字段名。 */
      const [field, ...values] = fields
      if (!['hostname', 'osName', 'osVersion', 'kernel', 'arch', 'uptimeSeconds'].includes(field ?? '')) systemState.invalid = true
      else addScalarField(systemState, field!, values, 1)
      continue
    }
    if (recordType === 'cpu') {
      /** CPU 当前字段名。 */
      const [field, ...values] = fields
      if (field === 'cores' || field === 'usagePercent') addScalarField(cpuState, field, values, 1)
      else if (field === 'load') addScalarField(cpuState, field, values, 3)
      else cpuState.invalid = true
      continue
    }
    if (recordType === 'memory') {
      addScalarField(memoryState, 'record', fields, 4)
      continue
    }
    if (recordType === 'swap') {
      addScalarField(swapState, 'record', fields, 2)
      continue
    }
    if (recordType === 'network') {
      addScalarField(networkState, 'record', fields, 2)
      continue
    }
    if (recordType === 'filesystem') {
      filesystemRecordSeen = true
      /** 当前文件系统候选记录。 */
      const filesystem = parseFilesystemRecord(fields)
      if (!filesystem || filesystems.length >= MAX_FILESYSTEMS) warnings.add('FILESYSTEM_PARTIAL')
      else filesystems.push(filesystem)
      continue
    }
    if (recordType === 'process') {
      processRecordSeen = true
      /** 当前进程候选记录。 */
      const process = parseProcessRecord(fields)
      if (!process || processIds.has(process.pid) || processes.length >= MAX_PROCESSES) warnings.add('PROCESS_PARTIAL')
      else {
        processIds.add(process.pid)
        processes.push(process)
      }
      continue
    }
    warnings.add('OUTPUT_TRUNCATED')
  }

  /** 只在标量组完整合法时发布的公开对象。 */
  const system = parseSystemGroup(systemState)
  const cpu = parseCpuGroup(cpuState)
  const memory = parseMemoryGroup(memoryState)
  const swap = parseSwapGroup(swapState)
  const network = parseNetworkGroup(networkState)
  if (!system) warnings.add('SYSTEM_PARTIAL')
  if (!cpu) warnings.add('CPU_PARTIAL')
  if (!memory || !swap) warnings.add('MEMORY_PARTIAL')
  if (!network) warnings.add('NETWORK_PARTIAL')
  if (!filesystemRecordSeen || filesystems.length === 0) warnings.add('FILESYSTEM_PARTIAL')
  if (!processRecordSeen || processes.length === 0) warnings.add('PROCESS_PARTIAL')

  return parseServerOpsOverviewResult({
    hostId,
    capturedAt,
    sampleWindowMs: SAMPLE_WINDOW_MS,
    ...(system ? { system } : {}),
    ...(cpu ? { cpu } : {}),
    ...(memory ? { memory } : {}),
    ...(swap ? { swap } : {}),
    filesystems,
    ...(network ? { network } : {}),
    processes,
    warnings: [...warnings],
  })
}
