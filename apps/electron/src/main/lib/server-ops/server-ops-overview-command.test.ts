import { describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  SERVER_OPS_OVERVIEW_COMMAND,
  SERVER_OPS_OVERVIEW_COMMAND_VERSION,
} from './server-ops-overview-command'

/** 固定脚本的同步执行结果。 */
interface CommandExecutionResult {
  exitCode: number
  stdout: string
  stderr: string
}

/** 通过 /bin/sh 执行受控 fixture 脚本并解码输出。 */
function executeCommand(command: string, env: Record<string, string | undefined> = process.env): CommandExecutionResult {
  /** 固定脚本子进程结果。 */
  const result = Bun.spawnSync({ cmd: ['/bin/sh', '-c', command], env, stdout: 'pipe', stderr: 'pipe' })
  return {
    exitCode: result.exitCode,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  }
}

/** 创建一行符合 /proc/net/dev 的接口计数。 */
function createNetworkLine(name: string, receiveBytes: number, transmitBytes: number, indent = ''): string {
  return `${indent}${name}: ${receiveBytes} 0 0 0 0 0 0 0 ${transmitBytes} 0 0 0 0 0 0 0`
}

/** 使用受控 meminfo 执行固定脚本并返回 memory/swap 协议行。 */
function executeMemoryFixture(meminfo: string): string[] {
  /** 当前测试持有的临时 fixture 根目录。 */
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'proma-overview-memory-'))
  try {
    /** 替代 /proc/meminfo 的 fixture 文件。 */
    const meminfoPath = join(fixtureRoot, 'meminfo')
    writeFileSync(meminfoPath, meminfo)
    /** 仅替换内存数据源并缩短采样等待的固定命令。 */
    const command = SERVER_OPS_OVERVIEW_COMMAND
      .replaceAll('/proc/meminfo', meminfoPath)
      .replace('sleep 0.25', 'sleep 0.01')
    /** 实际 shell 采集结果。 */
    const result = executeCommand(command)
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe('')
    return result.stdout.split('\n').filter((line) => line.startsWith('memory\t') || line.startsWith('swap\t'))
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true })
  }
}

describe('server ops overview command', () => {
  test('Given 固定采集命令 When 检查版本与数据源 Then 合同完整且无动态插值入口', () => {
    expect(SERVER_OPS_OVERVIEW_COMMAND_VERSION).toBe(1)
    expect(SERVER_OPS_OVERVIEW_COMMAND).toContain('export LC_ALL=C')
    for (const source of ['/etc/os-release', '/proc/stat', '/proc/loadavg', '/proc/meminfo', '/proc/net/dev', 'df -PkT', 'uname', 'ps ']) {
      expect(SERVER_OPS_OVERVIEW_COMMAND).toContain(source)
    }
    expect(SERVER_OPS_OVERVIEW_COMMAND).toContain('sleep 0.25')
    expect(SERVER_OPS_OVERVIEW_COMMAND).not.toContain('${')
  })

  test('Given 任一 Linux 数据源失败 When 检查采集结构 Then 不因单组失败终止后续组', () => {
    expect(SERVER_OPS_OVERVIEW_COMMAND).not.toMatch(/^set\s+-[A-Za-z]*e/m)
    for (const collector of ['collect_system', 'collect_cpu_and_network', 'collect_memory', 'collect_filesystems', 'collect_processes']) {
      expect(SERVER_OPS_OVERVIEW_COMMAND).toContain(`${collector} 2>/dev/null || true`)
    }
  })

  test('Given Linux CPU 计数含 guest 字段 When 检查采集公式 Then total 只累计 user 到 steal', () => {
    expect(SERVER_OPS_OVERVIEW_COMMAND).toContain('index <= 9')
    expect(SERVER_OPS_OVERVIEW_COMMAND).not.toContain('for (index = 2; index <= NF')
  })

  test('Given 固定采集命令 When 检查远端副作用 Then 不提权不写文件也不启动常驻任务', () => {
    expect(SERVER_OPS_OVERVIEW_COMMAND).not.toMatch(/\bsudo\b/)
    expect(SERVER_OPS_OVERVIEW_COMMAND).not.toMatch(/(^|[^<])>>?\s*\/(?!dev\/null(?:\s|$))/m)
    expect(SERVER_OPS_OVERVIEW_COMMAND).not.toMatch(/\b(?:nohup|systemctl\s+(?:start|restart|enable)|disown)\b/)
    expect(SERVER_OPS_OVERVIEW_COMMAND).not.toMatch(/&\s*(?:$|\n)/)
  })

  test('Given 固定采集命令 When 检查文本输出 Then 所有外部文本先移除 tab CR LF', () => {
    expect(SERVER_OPS_OVERVIEW_COMMAND).toContain("tr '\\t\\r\\n' '   '")
    expect(SERVER_OPS_OVERVIEW_COMMAND).toContain('top CPU 5')
    expect(SERVER_OPS_OVERVIEW_COMMAND).toContain('top memory 5')
    expect(SERVER_OPS_OVERVIEW_COMMAND).toContain('seen_pid')
    expect(SERVER_OPS_OVERVIEW_COMMAND).toContain('ps -eo pid=,%cpu=,%mem=,comm=')
    expect(SERVER_OPS_OVERVIEW_COMMAND).toContain('for (field_index = 4; field_index <= NF; field_index += 1)')
  })

  test('Given 短网卡名和无缩进长网卡名 When 实际采样 Then 按冒号右侧字段计算网络速率', () => {
    /** 当前测试持有的临时 fixture 根目录。 */
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'proma-overview-network-'))
    try {
      /** 采样期间会被替换的 net/dev 文件。 */
      const networkPath = join(fixtureRoot, 'net-dev')
      /** 第二次采样使用的 net/dev 文件。 */
      const networkAfterPath = join(fixtureRoot, 'net-dev-after')
      /** net/dev 固定表头。 */
      const header = 'Inter-| Receive | Transmit\n face |bytes packets errs drop fifo frame compressed multicast|bytes packets errs drop fifo colls carrier compressed'
      writeFileSync(networkPath, [header, createNetworkLine('eth0', 100, 200, '  '), createNetworkLine('docker0', 300, 400), createNetworkLine('enp0s3', 500, 600)].join('\n'))
      writeFileSync(networkAfterPath, [header, createNetworkLine('eth0', 110, 220, '  '), createNetworkLine('docker0', 330, 440), createNetworkLine('enp0s3', 550, 660)].join('\n'))
      /** 把真实 Linux 数据源替换为两阶段网络 fixture 的命令。 */
      const command = SERVER_OPS_OVERVIEW_COMMAND
        .replaceAll('/proc/net/dev', networkPath)
        .replace('sleep 0.25', `cp '${networkAfterPath}' '${networkPath}'; sleep 0.01`)
      /** 实际 shell 采样结果。 */
      const result = executeCommand(command)

      expect(result.exitCode).toBe(0)
      expect(result.stderr).toBe('')
      expect(result.stdout.split('\n').filter((line) => line.startsWith('network\t'))).toEqual(['network\t360\t480'])
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true })
    }
  })

  test('Given df 和 ps 输出部分内容后失败 When 实际采集 Then 不发布伪完整列表组', () => {
    /** 当前测试持有的临时 fixture 根目录。 */
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'proma-overview-pipe-failure-'))
    try {
      /** 注入失败命令的临时 bin 目录。 */
      const binPath = join(fixtureRoot, 'bin')
      mkdirSync(binPath)
      /** 输出一条文件系统后失败的 df fixture。 */
      const dfPath = join(binPath, 'df')
      /** 输出一条进程后失败的 ps fixture。 */
      const psPath = join(binPath, 'ps')
      writeFileSync(dfPath, "#!/bin/sh\nprintf 'Filesystem Type 1024-blocks Used Available Capacity Mounted on\\n/dev/fake ext4 100 50 50 50%% /\\n'\nexit 7\n")
      writeFileSync(psPath, "#!/bin/sh\nprintf '42 10 2 worker pool\\n'\nexit 7\n")
      chmodSync(dfPath, 0o700)
      chmodSync(psPath, 0o700)
      /** 仅覆盖 df/ps 的受控命令环境。 */
      const env = { ...process.env, PATH: `${binPath}:/usr/bin:/bin` }
      /** 实际 shell 采集结果。 */
      const result = executeCommand(SERVER_OPS_OVERVIEW_COMMAND.replace('sleep 0.25', 'sleep 0.01'), env)
      /** 所有列表协议行。 */
      const listLines = result.stdout.split('\n').filter((line) => line.startsWith('filesystem\t') || line.startsWith('process\t'))

      expect(result.exitCode).toBe(0)
      expect(result.stderr).toBe('')
      expect(listLines).toEqual([])
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true })
    }
  })

  test('Given os-release 只有 VERSION_ID When 实际采集 Then system 使用版本 ID 回退', () => {
    /** 当前测试持有的临时 fixture 根目录。 */
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'proma-overview-os-release-'))
    try {
      /** 仅含 NAME 与 VERSION_ID 的 os-release fixture。 */
      const osReleasePath = join(fixtureRoot, 'os-release')
      /** uptime fixture。 */
      const uptimePath = join(fixtureRoot, 'uptime')
      writeFileSync(osReleasePath, 'NAME="Fixture Linux"\nVERSION_ID="42"\n')
      writeFileSync(uptimePath, '123.45 67.89\n')
      /** 把 system 数据源替换为 fixture 的命令。 */
      const command = SERVER_OPS_OVERVIEW_COMMAND
        .replaceAll('/etc/os-release', osReleasePath)
        .replaceAll('/proc/uptime', uptimePath)
        .replace('sleep 0.25', 'sleep 0.01')
      /** 实际 shell 采集结果。 */
      const result = executeCommand(command)
      /** system 协议行。 */
      const systemLines = result.stdout.split('\n').filter((line) => line.startsWith('system\t'))

      expect(result.exitCode).toBe(0)
      expect(result.stderr).toBe('')
      expect(systemLines).toContain('system\tosVersion\t42')
      expect(systemLines).toHaveLength(6)
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true })
    }
  })

  test('Given memory 完整但 Swap 字段缺失 When 实际采集 Then 只发布完整 memory', () => {
    /** 缺少 SwapFree 的 meminfo fixture。 */
    const meminfo = [
      'MemTotal: 100 kB',
      'MemAvailable: 40 kB',
      'Buffers: 10 kB',
      'Cached: 20 kB',
      'SReclaimable: 5 kB',
      'SwapTotal: 50 kB',
    ].join('\n')

    expect(executeMemoryFixture(meminfo)).toEqual(['memory\t102400\t61440\t40960\t35840'])
  })

  test('Given Swap 完整但 memory 字段缺失 When 实际采集 Then 只发布完整 swap', () => {
    /** 缺少 MemAvailable 的 meminfo fixture。 */
    const meminfo = [
      'MemTotal: 100 kB',
      'Buffers: 10 kB',
      'Cached: 20 kB',
      'SReclaimable: 5 kB',
      'SwapTotal: 50 kB',
      'SwapFree: 20 kB',
    ].join('\n')

    expect(executeMemoryFixture(meminfo)).toEqual(['swap\t51200\t30720'])
  })
})
