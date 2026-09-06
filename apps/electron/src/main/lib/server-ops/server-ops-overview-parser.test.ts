import { describe, expect, test } from 'bun:test'
import { parseServerOpsOverviewOutput } from './server-ops-overview-parser'

/** 创建包含所有标量组的 Linux 概览协议。 */
function createCompleteOutput(systemValues: { osName: string; osVersion: string } = { osName: 'Ubuntu', osVersion: '24.04' }): string {
  return [
    'system\thostname\tedge-1',
    `system\tosName\t${systemValues.osName}`,
    `system\tosVersion\t${systemValues.osVersion}`,
    'system\tkernel\t6.8.0-generic',
    'system\tarch\tx86_64',
    'system\tuptimeSeconds\t3600',
    'cpu\tcores\t4',
    'cpu\tusagePercent\t12.5',
    'cpu\tload\t0.1\t0.2\t0.3',
    'memory\t1073741824\t536870912\t536870912\t134217728',
    'swap\t0\t0',
    'filesystem\t/dev/vda1\text4\t/\t1073741824\t536870912\t536870912\t50',
    'network\t1000\t2000',
    'process\t1\tsystemd\t0.1\t0.2',
  ].join('\n')
}

describe('parseServerOpsOverviewOutput', () => {
  test('Given 完整 Ubuntu 行协议 When 解析 Then 返回以 bytes 为单位的完整快照', () => {
    /** 解析得到的完整概览快照。 */
    const result = parseServerOpsOverviewOutput('host-1', createCompleteOutput(), 1)

    expect(result).toEqual({
      hostId: 'host-1',
      capturedAt: 1,
      sampleWindowMs: 250,
      system: { hostname: 'edge-1', osName: 'Ubuntu', osVersion: '24.04', kernel: '6.8.0-generic', arch: 'x86_64', uptimeSeconds: 3600 },
      cpu: { cores: 4, usagePercent: 12.5, load1: 0.1, load5: 0.2, load15: 0.3 },
      memory: { totalBytes: 1073741824, usedBytes: 536870912, availableBytes: 536870912, cacheBytes: 134217728 },
      swap: { totalBytes: 0, usedBytes: 0 },
      filesystems: [{ device: '/dev/vda1', filesystem: 'ext4', mountPoint: '/', totalBytes: 1073741824, usedBytes: 536870912, availableBytes: 536870912, usagePercent: 50 }],
      network: { receiveBytesPerSecond: 1000, transmitBytesPerSecond: 2000 },
      processes: [{ pid: 1, name: 'systemd', cpuPercent: 0.1, memoryPercent: 0.2 }],
      warnings: [],
    })
  })

  test('Given Debian 与 CentOS os-release 文本 When 解析 Then 原样保留发行版名称和版本', () => {
    /** 需要覆盖的常见发行版值。 */
    const distributions = [
      { osName: 'Debian GNU/Linux', osVersion: '12 (bookworm)' },
      { osName: 'CentOS Linux', osVersion: '7 (Core)' },
    ]
    for (const distribution of distributions) {
      expect(parseServerOpsOverviewOutput('host-1', createCompleteOutput(distribution), 1).system).toMatchObject(distribution)
    }
  })

  test('Given 内存项损坏 When 解析 Then 保留完整 system 并只省略损坏组', () => {
    /** 将完整内存行替换为字段不足的协议。 */
    const output = createCompleteOutput().replace('memory\t1073741824\t536870912\t536870912\t134217728', 'memory\tbad')
    /** 局部损坏后的概览快照。 */
    const result = parseServerOpsOverviewOutput('host-1', output, 1)

    expect(result.system?.hostname).toBe('edge-1')
    expect(result.memory).toBeUndefined()
    expect(result.swap).toEqual({ totalBytes: 0, usedBytes: 0 })
    expect(result.warnings).toEqual(['MEMORY_PARTIAL'])
  })

  test('Given 标量记录重复 When 解析 Then 整组拒绝且 warning 去重', () => {
    /** 重复 CPU 字段且含另一条坏 CPU 记录的协议。 */
    const output = `${createCompleteOutput()}\ncpu\tcores\t8\ncpu\tusagePercent\tbad`
    /** 重复标量后的概览快照。 */
    const result = parseServerOpsOverviewOutput('host-1', output, 1)

    expect(result.cpu).toBeUndefined()
    expect(result.warnings.filter((warning) => warning === 'CPU_PARTIAL')).toHaveLength(1)
    expect(result.system?.hostname).toBe('edge-1')
  })

  test('Given 坏列表项与超量列表 When 解析 Then 跳过坏项并截断到公开上限', () => {
    /** 生成超过解析上限的合法文件系统记录。 */
    const filesystems = Array.from({ length: 130 }, (_, index) => `filesystem\t/dev/vd${index}\text4\t/mnt/${index}\t1024\t512\t512\t50`)
    /** 生成超过解析上限的合法进程记录。 */
    const processes = Array.from({ length: 12 }, (_, index) => `process\t${index + 1}\tworker ${index}\t1\t2`)
    /** 混入坏行后的完整协议。 */
    const output = [createCompleteOutput(), 'filesystem\tbad', ...filesystems, 'process\tbad', ...processes].join('\n')
    /** 截断后的概览快照。 */
    const result = parseServerOpsOverviewOutput('host-1', output, 1)

    expect(result.filesystems).toHaveLength(128)
    expect(result.processes).toHaveLength(10)
    expect(result.warnings).toContain('FILESYSTEM_PARTIAL')
    expect(result.warnings).toContain('PROCESS_PARTIAL')
  })

  test('Given 文件系统和进程记录完全缺失 When 解析 Then 两个空组都报告 partial', () => {
    /** 移除全部列表记录后的标量协议。 */
    const output = createCompleteOutput()
      .replace('\nfilesystem\t/dev/vda1\text4\t/\t1073741824\t536870912\t536870912\t50', '')
      .replace('\nprocess\t1\tsystemd\t0.1\t0.2', '')
    /** 空列表组的概览快照。 */
    const result = parseServerOpsOverviewOutput('host-1', output, 1)

    expect(result.filesystems).toEqual([])
    expect(result.processes).toEqual([])
    expect(result.warnings).toEqual(expect.arrayContaining(['FILESYSTEM_PARTIAL', 'PROCESS_PARTIAL']))
  })

  test('Given 多核进程与含空格名称 When 解析 Then 保留完整名称和超过 100 的 CPU 百分比', () => {
    /** 使用 Linux 多核 CPU 合法值和含空格 comm 的协议。 */
    const output = createCompleteOutput().replace('process\t1\tsystemd\t0.1\t0.2', 'process\t42\tworker pool\t250\t2.5')
    /** 多核进程概览。 */
    const result = parseServerOpsOverviewOutput('host-1', output, 1)

    expect(result.processes).toEqual([{ pid: 42, name: 'worker pool', cpuPercent: 250, memoryPercent: 2.5 }])
    expect(result.warnings).toEqual([])
  })

  test('Given 进程 CPU 超过绝对多核上限 When 解析 Then 跳过该项并报告 partial', () => {
    /** 超过 65,536 核绝对 CPU 上限的进程协议。 */
    const output = createCompleteOutput().replace('process\t1\tsystemd\t0.1\t0.2', 'process\t42\tworker\t6553600.1\t2.5')
    /** 进程 CPU 越界后的概览快照。 */
    const result = parseServerOpsOverviewOutput('host-1', output, 1)

    expect(result.processes).toEqual([])
    expect(result.warnings).toContain('PROCESS_PARTIAL')
  })

  test('Given memory 或 swap 字节关系不成立 When 解析 Then 只省略对应标量并报告 partial', () => {
    /** 覆盖和溢出无关的非法内存关系。 */
    const invalidMemoryLines = [
      'memory\t100\t60\t50\t10',
      'memory\t100\t50\t50\t101',
      `memory\t${Number.MAX_SAFE_INTEGER}\t${Number.MAX_SAFE_INTEGER}\t1\t0`,
    ]
    for (const invalidMemoryLine of invalidMemoryLines) {
      /** 替换为非法 memory 关系后的快照。 */
      const result = parseServerOpsOverviewOutput('host-1', createCompleteOutput().replace('memory\t1073741824\t536870912\t536870912\t134217728', invalidMemoryLine), 1)
      expect(result.memory).toBeUndefined()
      expect(result.swap).toEqual({ totalBytes: 0, usedBytes: 0 })
      expect(result.warnings).toContain('MEMORY_PARTIAL')
    }

    /** swap 已用空间超过总空间后的快照。 */
    const invalidSwap = parseServerOpsOverviewOutput('host-1', createCompleteOutput().replace('swap\t0\t0', 'swap\t100\t101'), 1)
    expect(invalidSwap.memory).toBeDefined()
    expect(invalidSwap.swap).toBeUndefined()
    expect(invalidSwap.warnings).toContain('MEMORY_PARTIAL')
  })

  test('Given 文件系统字节关系不成立 When 解析 Then 跳过坏记录并报告 partial', () => {
    /** 覆盖 used、available 与二者合计越界的文件系统关系。 */
    const invalidFilesystemValues = [
      '100\t101\t0',
      '100\t0\t101',
      '100\t60\t50',
      `${Number.MAX_SAFE_INTEGER}\t${Number.MAX_SAFE_INTEGER}\t1`,
    ]
    for (const invalidValues of invalidFilesystemValues) {
      /** 替换为非法文件系统关系后的快照。 */
      const output = createCompleteOutput().replace('1073741824\t536870912\t536870912\t50', `${invalidValues}\t50`)
      /** 文件系统关系校验后的快照。 */
      const result = parseServerOpsOverviewOutput('host-1', output, 1)
      expect(result.filesystems).toEqual([])
      expect(result.warnings).toContain('FILESYSTEM_PARTIAL')
    }
  })

  test('Given 重复 PID When 解析 Then 保留首条并跳过后续记录', () => {
    /** 同一 PID 出现两次的协议。 */
    const output = `${createCompleteOutput()}\nprocess\t1\trestarted systemd\t20\t1`
    /** PID 去重后的概览快照。 */
    const result = parseServerOpsOverviewOutput('host-1', output, 1)

    expect(result.processes).toEqual([{ pid: 1, name: 'systemd', cpuPercent: 0.1, memoryPercent: 0.2 }])
    expect(result.warnings).toContain('PROCESS_PARTIAL')
  })

  test('Given 未知记录或非空无法分类行 When 解析 Then 不执行内容并报告未消费输出', () => {
    /** 含未知记录和无 tag 文本的协议。 */
    const output = `${createCompleteOutput()}\nunknown\tsecret\nplain text`
    /** 忽略未知内容后的概览快照。 */
    const result = parseServerOpsOverviewOutput('host-1', output, 1)

    expect(result.warnings).toEqual(['OUTPUT_TRUNCATED'])
    expect(result.system?.hostname).toBe('edge-1')
  })

  test('Given stdout 超过 512 KiB When 解析 Then 在按行处理前拒绝 ASCII 与多字节输入', () => {
    /** 明显超过上限的 ASCII 输出。 */
    const oversizedAscii = 'a'.repeat((512 * 1024) + 1)
    /** UTF-16 长度未超限但 UTF-8 字节超限的输出。 */
    const oversizedUtf8 = '汉'.repeat(200_000)

    expect(() => parseServerOpsOverviewOutput('host-1', oversizedAscii, 1)).toThrow('SERVER_OPS_OVERVIEW_OUTPUT_INVALID')
    expect(() => parseServerOpsOverviewOutput('host-1', oversizedUtf8, 1)).toThrow('SERVER_OPS_OVERVIEW_OUTPUT_INVALID')
  })

  test('Given 文本与数值处于边界 When 解析 Then 接受上限并拒绝越界字段', () => {
    /** 使用全部合法上限构造的协议。 */
    const validOutput = createCompleteOutput()
      .replace('edge-1', 'h'.repeat(255))
      .replace('Ubuntu', 'o'.repeat(256))
      .replace('x86_64', 'a'.repeat(64))
      .replace('/dev/vda1', 'd'.repeat(1024))
      .replace('ext4', 'f'.repeat(128))
      .replace('\t/\t1073741824', `\t${'m'.repeat(1024)}\t1073741824`)
      .replace('systemd', 'p'.repeat(256))
      .replace('3600', String(Number.MAX_SAFE_INTEGER))
      .replace('network\t1000\t2000', `network\t${Number.MAX_SAFE_INTEGER}\t${Number.MAX_SAFE_INTEGER}`)
    /** 恰好位于边界的概览快照。 */
    const validResult = parseServerOpsOverviewOutput('host-1', validOutput, 8_640_000_000_000_000)
    expect(validResult.warnings).toEqual([])
    expect(validResult.system?.hostname).toHaveLength(255)

    /** 把 CPU 百分比改为越界值。 */
    const invalidOutput = createCompleteOutput().replace('cpu\tusagePercent\t12.5', 'cpu\tusagePercent\t100.1')
    /** CPU 越界后的概览快照。 */
    const invalidResult = parseServerOpsOverviewOutput('host-1', invalidOutput, 1)
    expect(invalidResult.cpu).toBeUndefined()
    expect(invalidResult.warnings).toContain('CPU_PARTIAL')
    expect(() => parseServerOpsOverviewOutput('host-1', createCompleteOutput(), -1)).toThrow('SERVER_OPS_OVERVIEW_OUTPUT_INVALID')
  })

  test('Given 文本含 tab 或空值且整数格式不严格 When 解析 Then 拒绝对应记录并保留其它类别', () => {
    /** 构造字段数异常、空文本和非安全整数。 */
    const output = createCompleteOutput()
      .replace('system\tosName\tUbuntu', 'system\tosName\tUbuntu\textra')
      .replace('filesystem\t/dev/vda1\text4', 'filesystem\t/dev/vda1\t')
      .replace('process\t1\tsystemd', 'process\t1.5\tsystemd')
    /** 严格拒绝坏字段后的结果。 */
    const result = parseServerOpsOverviewOutput('host-1', output, 1)

    expect(result.system).toBeUndefined()
    expect(result.filesystems).toEqual([])
    expect(result.processes).toEqual([])
    expect(result.warnings).toEqual(expect.arrayContaining(['SYSTEM_PARTIAL', 'FILESYSTEM_PARTIAL', 'PROCESS_PARTIAL']))
  })

  test('Given 同一输出解析两次 When 修改首次结果 Then 第二次快照不共享对象或数组', () => {
    /** 第一次解析出的可变测试快照。 */
    const first = parseServerOpsOverviewOutput('host-1', createCompleteOutput(), 1)
    /** 相同输入生成的独立快照。 */
    const second = parseServerOpsOverviewOutput('host-1', createCompleteOutput(), 1)
    first.filesystems[0]!.device = 'changed'
    first.processes.length = 0
    if (first.system) first.system.hostname = 'changed'

    expect(second.filesystems[0]!.device).toBe('/dev/vda1')
    expect(second.processes).toHaveLength(1)
    expect(second.system?.hostname).toBe('edge-1')
    expect(second.filesystems).not.toBe(first.filesystems)
  })

  test('Given hostId 非法 When 解析 Then 复用 Shared 输入合同 fail closed', () => {
    expect(() => parseServerOpsOverviewOutput('', createCompleteOutput(), 1)).toThrow('SERVER_OPS_OVERVIEW_INPUT_INVALID')
  })
})
