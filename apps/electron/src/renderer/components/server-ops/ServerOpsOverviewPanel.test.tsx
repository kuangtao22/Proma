import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ServerOpsOverviewResult } from '@proma/shared'
import {
  createServerOpsOverviewController,
  ServerOpsOverviewPanelView,
} from './ServerOpsOverviewPanel'
import type { ServerOpsOverviewProjection } from './ServerOpsOverviewPanel'

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
}

/** 创建可控 Promise，用于验证概览请求的并发与迟到响应。 */
function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve
    reject = nextReject
  })
  return { promise, resolve, reject }
}

/** 等待概览控制器完成当前微任务链。 */
async function flushPromises(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

/** 创建包含完整与部分字段的真实概览测试快照。 */
function createSnapshot(hostId = 'host-1'): ServerOpsOverviewResult {
  return {
    hostId,
    capturedAt: Date.UTC(2026, 8, 5),
    sampleWindowMs: 1_000,
    system: {
      hostname: 'api-prod-01',
      osName: 'Ubuntu',
      osVersion: '24.04',
      kernel: '6.8.0',
      arch: 'x86_64',
      uptimeSeconds: 93_784,
    },
    cpu: { cores: 8, usagePercent: 12.5, load1: 0.6, load5: 0.5, load15: 0.4 },
    memory: {
      totalBytes: 8 * 1024 ** 3,
      usedBytes: 4 * 1024 ** 3,
      availableBytes: 4 * 1024 ** 3,
      cacheBytes: 512 * 1024 ** 2,
    },
    swap: { totalBytes: 2 * 1024 ** 3, usedBytes: 256 * 1024 ** 2 },
    filesystems: [{
      device: '/dev/vda1',
      mountPoint: '/',
      filesystem: 'ext4',
      totalBytes: 100 * 1024 ** 3,
      usedBytes: 42 * 1024 ** 3,
      availableBytes: 58 * 1024 ** 3,
      usagePercent: 42,
    }],
    network: { receiveBytesPerSecond: 2 * 1024 ** 2, transmitBytesPerSecond: 512 * 1024 },
    processes: [{ pid: 1, name: 'systemd', cpuPercent: 0.1, memoryPercent: 0.2 }],
    warnings: [],
  }
}

/** 从静态 HTML 中截取两个稳定标识之间的单一区块。 */
function extractRegion(html: string, startMarker: string, endMarker: string): string {
  /** 目标区块起始位置。 */
  const start = html.indexOf(startMarker)
  /** 下一区块起始位置。 */
  const end = html.indexOf(endMarker, start + startMarker.length)
  expect(start).toBeGreaterThanOrEqual(0)
  expect(end).toBeGreaterThan(start)
  return html.slice(start, end)
}

/** 创建可手动推进 10 秒轮询的概览控制器测试环境。 */
function createControllerHarness() {
  /** IPC 请求记录。 */
  const calls: string[] = []
  /** 控制器投影历史。 */
  const projections: ServerOpsOverviewProjection[] = []
  /** 当前注册的轮询回调。 */
  const timers = new Map<number, () => void>()
  /** 每个轮询注册时声明的毫秒间隔。 */
  const timerDelays: number[] = []
  /** 保留所有曾注册的 callback，用于模拟 clear 后仍到达的宿主事件。 */
  const scheduledCallbacks: Array<() => void> = []
  /** IPC 实现可由单项测试替换。 */
  let getOverview = async ({ hostId }: { hostId: string }): Promise<ServerOpsOverviewResult> => {
    calls.push(hostId)
    return createSnapshot(hostId)
  }
  /** 测试定时器 ID 递增器。 */
  let nextTimerId = 0
  const controller = createServerOpsOverviewController({
    getOverview: (input) => getOverview(input),
    publish: (projection) => { projections.push(projection) },
    setInterval: (callback, delayMs) => {
      const timerId = ++nextTimerId
      timers.set(timerId, callback)
      timerDelays.push(delayMs)
      scheduledCallbacks.push(callback)
      return timerId
    },
    clearInterval: (timerId) => { timers.delete(timerId) },
  })
  controller.activate()
  return {
    calls,
    controller,
    projections,
    scheduledCallbacks,
    timerDelays,
    timers,
    tick: () => { for (const callback of [...timers.values()]) callback() },
    setGetOverview: (implementation: typeof getOverview) => { getOverview = implementation },
  }
}

describe('服务器运维真实概览面板', () => {
  test('Given 完整快照 When 静态渲染 Then 展示真实指标、文件系统和进程', () => {
    const html = renderToStaticMarkup(
      <ServerOpsOverviewPanelView
        status="ready"
        snapshot={createSnapshot()}
        stale={false}
        error={null}
        onRefresh={() => undefined}
      />,
    )

    expect(html).toContain('12.5%')
    expect(html).toContain('/dev/vda1')
    expect(html).toContain('systemd')
    expect(html).toContain('api-prod-01')
    expect(html).toContain('1 分钟 0.60')
    expect(html).toContain('5 分钟 0.50')
    expect(html).toContain('15 分钟 0.40')
    expect(html).toContain('缓存')
    expect(html).toContain('Swap')
    expect(html).toContain('接收速率')
    expect(html).toContain('aria-label="刷新服务器概览"')
    expect(html).toContain('data-server-ops-overview-system-grid="true"')
    expect(html).toContain('data-server-ops-overview-resource-grid="true"')
    expect(html).not.toContain('下一阶段')
  })

  test('Given 概览工作区 When Pane 宽度变化 Then 原生容器查询控制指标、系统与资源列数', async () => {
    /** 运维工作区的真实容器查询样式。 */
    const styles = await Bun.file(new URL('../../styles/globals.css', import.meta.url)).text()

    expect(styles).toContain('@container (min-width: 520px)')
    expect(styles).toContain('@container (min-width: 700px)')
    expect(styles).toContain('[data-server-ops-overview-grid]')
    expect(styles).toContain('[data-server-ops-overview-system-grid]')
    expect(styles).toContain('[data-server-ops-overview-resource-grid]')
  })

  test('Given 加载、空与 partial 状态 When 静态渲染 Then 保持稳定骨架、恢复入口和克制警告', () => {
    const loadingHtml = renderToStaticMarkup(
      <ServerOpsOverviewPanelView status="loading" snapshot={null} stale={false} error={null} onRefresh={() => undefined} />,
    )
    const emptyHtml = renderToStaticMarkup(
      <ServerOpsOverviewPanelView status="idle" snapshot={null} stale={false} error={null} onRefresh={() => undefined} />,
    )
    const partialHtml = renderToStaticMarkup(
      <ServerOpsOverviewPanelView
        status="ready"
        snapshot={{ ...createSnapshot(), cpu: undefined, warnings: ['CPU_PARTIAL'] }}
        stale={false}
        error={null}
        onRefresh={() => undefined}
      />,
    )

    expect(loadingHtml).toContain('data-server-ops-overview-skeleton="true"')
    expect(loadingHtml).toContain('grid-cols-2')
    expect(emptyHtml).toContain('暂无可用的服务器概览')
    expect(emptyHtml).toContain('刷新服务器概览')
    expect(partialHtml).toContain('部分指标暂不可用')
    expect(partialHtml).toContain('不可用')
    expect(partialHtml).toContain('overflow-x-auto')
    expect(partialHtml).toContain('data-server-ops-overview-grid="true"')
  })

  test('Given 多个局部 partial warning When 渲染概览 Then 各提示只出现在对应指标或详情区块', () => {
    const html = renderToStaticMarkup(
      <ServerOpsOverviewPanelView
        status="ready"
        snapshot={{
          ...createSnapshot(),
          warnings: [
            'CPU_PARTIAL',
            'MEMORY_PARTIAL',
            'NETWORK_PARTIAL',
            'SYSTEM_PARTIAL',
            'FILESYSTEM_PARTIAL',
            'PROCESS_PARTIAL',
          ],
        }}
        stale={false}
        error={null}
        onRefresh={() => undefined}
      />,
    )
    /** CPU 指标单元到内存指标单元之间的稳定范围。 */
    const cpuRegion = extractRegion(
      html,
      'data-server-ops-overview-metric="cpu"',
      'data-server-ops-overview-metric="memory"',
    )
    /** 内存指标单元到磁盘指标单元之间的稳定范围。 */
    const memoryRegion = extractRegion(
      html,
      'data-server-ops-overview-metric="memory"',
      'data-server-ops-overview-metric="root-disk"',
    )
    /** 磁盘指标单元到网络指标单元之间的稳定范围。 */
    const diskRegion = extractRegion(
      html,
      'data-server-ops-overview-metric="root-disk"',
      'data-server-ops-overview-metric="load"',
    )
    /** 网络资源单元到文件系统区之间的稳定范围。 */
    const networkRegion = extractRegion(
      html,
      'data-server-ops-overview-resource="network"',
      'data-server-ops-overview-section="filesystems"',
    )
    /** 系统信息区到文件系统区之间的稳定范围。 */
    const systemRegion = extractRegion(
      html,
      'data-server-ops-overview-section="system"',
      'data-server-ops-overview-section="filesystems"',
    )
    /** 文件系统区到进程区之间的稳定范围。 */
    const filesystemRegion = extractRegion(
      html,
      'data-server-ops-overview-section="filesystems"',
      'data-server-ops-overview-section="processes"',
    )
    /** 进程区到页面结尾之间的稳定范围。 */
    const processRegion = html.slice(html.indexOf('data-server-ops-overview-section="processes"'))

    expect(cpuRegion).toContain('CPU 数据可能不完整')
    expect(cpuRegion).not.toContain('系统信息可能不完整')
    expect(cpuRegion).not.toContain('内存数据可能不完整')
    expect(memoryRegion).toContain('内存数据可能不完整')
    expect(memoryRegion).not.toContain('CPU 数据可能不完整')
    expect(memoryRegion).not.toContain('网络数据可能不完整')
    expect(diskRegion).not.toContain('内存数据可能不完整')
    expect(diskRegion).not.toContain('网络数据可能不完整')
    expect(networkRegion).toContain('网络数据可能不完整')
    expect(networkRegion).not.toContain('内存数据可能不完整')
    expect(systemRegion).toContain('系统信息可能不完整')
    expect(systemRegion).not.toContain('文件系统数据可能不完整')
    expect(filesystemRegion).toContain('文件系统数据可能不完整')
    expect(filesystemRegion).not.toContain('进程数据可能不完整')
    expect(processRegion).toContain('进程数据可能不完整')
  })

  test('Given OUTPUT_TRUNCATED warning When 渲染概览 Then 在数据区块之外显示全局采集提示', () => {
    const html = renderToStaticMarkup(
      <ServerOpsOverviewPanelView
        status="ready"
        snapshot={{ ...createSnapshot(), warnings: ['OUTPUT_TRUNCATED'] }}
        stale={false}
        error={null}
        onRefresh={() => undefined}
      />,
    )
    /** 全局提示到指标区之间的稳定范围。 */
    const globalRegion = extractRegion(
      html,
      'data-server-ops-overview-global-warning="true"',
      'data-server-ops-overview-section="metrics"',
    )

    expect(globalRegion).toContain('远程输出已截断，部分数据可能不完整')
    expect(globalRegion).not.toContain('CPU 数据可能不完整')
  })

  test('Given 首次读取失败 When 静态渲染 Then 显示错误和可键盘访问的重试', () => {
    const html = renderToStaticMarkup(
      <ServerOpsOverviewPanelView
        status="error"
        snapshot={null}
        stale={false}
        error="服务器概览读取失败，请重试"
        onRefresh={() => undefined}
      />,
    )

    expect(html).toContain('服务器概览读取失败')
    expect(html).toContain('服务器概览读取失败，请重试')
    expect(html).toContain('<button')
    expect(html).toContain('重试')
  })

  test('Given 多文件系统、零 Swap 与最大合法字节 When 渲染 Then 顶部选择根磁盘并完整展示资源详情', () => {
    /** 最大合法字节值验证格式化不会溢出。 */
    const maximumBytes = Number.MAX_SAFE_INTEGER
    const html = renderToStaticMarkup(
      <ServerOpsOverviewPanelView
        status="ready"
        snapshot={{
          ...createSnapshot(),
          memory: {
            totalBytes: maximumBytes,
            usedBytes: 0,
            availableBytes: maximumBytes,
            cacheBytes: maximumBytes,
          },
          swap: { totalBytes: 0, usedBytes: 0 },
          filesystems: [
            {
              device: '/dev/vdb1', mountPoint: '/data', filesystem: 'ext4',
              totalBytes: 200 * 1024 ** 3, usedBytes: 190 * 1024 ** 3,
              availableBytes: 10 * 1024 ** 3, usagePercent: 95,
            },
            ...createSnapshot().filesystems,
          ],
          network: { receiveBytesPerSecond: maximumBytes, transmitBytesPerSecond: 0 },
        }}
        stale={false}
        error={null}
        onRefresh={() => undefined}
      />,
    )
    /** 根磁盘顶部指标到负载指标之间的稳定范围。 */
    const rootDiskRegion = extractRegion(
      html,
      'data-server-ops-overview-metric="root-disk"',
      'data-server-ops-overview-metric="load"',
    )
    /** 资源详情到文件系统区之间的稳定范围。 */
    const resourceRegion = extractRegion(
      html,
      'data-server-ops-overview-section="resources"',
      'data-server-ops-overview-section="filesystems"',
    )

    expect(rootDiskRegion).toContain('42%')
    expect(rootDiskRegion).toContain('/ ·')
    expect(rootDiskRegion).not.toContain('95%')
    expect(resourceRegion).toContain('总内存')
    expect(resourceRegion).toContain('已用内存')
    expect(resourceRegion).toContain('可用内存')
    expect(resourceRegion).toContain('缓存')
    expect(resourceRegion).toContain('Swap 总量')
    expect(resourceRegion).toContain('Swap 已用')
    expect(resourceRegion).toContain('0 B')
    expect(resourceRegion).toContain('8192.0 TB')
    expect(resourceRegion).toContain('接收速率')
    expect(resourceRegion).toContain('发送速率')
  })

  test('Given 面板激活且已连接 When 激活并经过 10 秒 Then 立即读取且只保留一个轮询定时器', async () => {
    const harness = createControllerHarness()
    harness.controller.select({ hostId: 'host-1', active: true, connected: true })
    await flushPromises()

    expect(harness.calls).toEqual(['host-1'])
    expect(harness.timers.size).toBe(1)
    expect(harness.timerDelays).toEqual([10_000])
    harness.tick()
    await flushPromises()
    expect(harness.calls).toEqual(['host-1', 'host-1'])

    harness.controller.select({ hostId: 'host-1', active: false, connected: true })
    expect(harness.timers.size).toBe(0)
    harness.tick()
    harness.tick()
    await flushPromises()
    expect(harness.calls).toHaveLength(2)
  })

  test('Given 同一主机请求在途 When 多次手动刷新 Then 本轮结束后最多补一次', async () => {
    const harness = createControllerHarness()
    const first = createDeferred<ServerOpsOverviewResult>()
    const second = createDeferred<ServerOpsOverviewResult>()
    let callCount = 0
    harness.setGetOverview(({ hostId }) => {
      harness.calls.push(hostId)
      callCount += 1
      return callCount === 1 ? first.promise : second.promise
    })
    harness.controller.select({ hostId: 'host-1', active: true, connected: true })
    harness.controller.refresh()
    harness.controller.refresh()
    expect(harness.calls).toHaveLength(1)

    first.resolve(createSnapshot())
    await flushPromises()
    expect(harness.calls).toHaveLength(2)

    second.resolve(createSnapshot())
    await flushPromises()
    expect(harness.calls).toHaveLength(2)
  })

  test('Given 旧主机请求迟到 When 已切换到新主机 Then 旧结果和 finally 都不能覆盖新投影', async () => {
    const harness = createControllerHarness()
    const oldRead = createDeferred<ServerOpsOverviewResult>()
    const nextRead = createDeferred<ServerOpsOverviewResult>()
    harness.setGetOverview(({ hostId }) => {
      harness.calls.push(hostId)
      return hostId === 'host-1' ? oldRead.promise : nextRead.promise
    })
    harness.controller.select({ hostId: 'host-1', active: true, connected: true })
    harness.controller.select({ hostId: 'host-2', active: true, connected: true })
    nextRead.resolve(createSnapshot('host-2'))
    await flushPromises()
    oldRead.resolve(createSnapshot('host-1'))
    await flushPromises()

    expect(harness.projections.at(-1)).toMatchObject({ hostId: 'host-2', status: 'ready', snapshot: { hostId: 'host-2' } })
    expect(harness.timers.size).toBe(1)
  })

  test('Given 旧 interval 已清除 When 切换主机后旧 callback 到达 Then 不得为新主机额外请求', async () => {
    const harness = createControllerHarness()
    harness.controller.select({ hostId: 'host-1', active: true, connected: true })
    await flushPromises()
    /** 切换前保存的旧主机 timer callback。 */
    const oldCallback = harness.scheduledCallbacks[0]
    harness.controller.select({ hostId: 'host-2', active: true, connected: true })
    await flushPromises()

    oldCallback?.()
    await flushPromises()

    expect(harness.calls).toEqual(['host-1', 'host-2'])
  })

  test('Given controller dispose 后重新 activate When 旧 owner timer callback 到达 Then 不得读取新 owner 主机', async () => {
    const harness = createControllerHarness()
    harness.controller.select({ hostId: 'host-1', active: true, connected: true })
    await flushPromises()
    /** dispose 前保存的旧 owner timer callback。 */
    const oldOwnerCallback = harness.scheduledCallbacks[0]
    harness.controller.dispose()
    harness.controller.activate()
    harness.controller.select({ hostId: 'host-2', active: true, connected: true })
    await flushPromises()

    oldOwnerCallback?.()
    await flushPromises()

    expect(harness.calls).toEqual(['host-1', 'host-2'])
  })

  test('Given 切回的主机仍有旧请求在途 When 维持单飞 Then 先发布当前主机 loading 并在旧请求后补读', async () => {
    const harness = createControllerHarness()
    const oldHostRead = createDeferred<ServerOpsOverviewResult>()
    const nextHostRead = createDeferred<ServerOpsOverviewResult>()
    const freshHostRead = createDeferred<ServerOpsOverviewResult>()
    let hostOneCalls = 0
    harness.setGetOverview(({ hostId }) => {
      harness.calls.push(hostId)
      if (hostId === 'host-2') return nextHostRead.promise
      hostOneCalls += 1
      return hostOneCalls === 1 ? oldHostRead.promise : freshHostRead.promise
    })
    harness.controller.select({ hostId: 'host-1', active: true, connected: true })
    harness.controller.select({ hostId: 'host-2', active: true, connected: true })
    harness.controller.select({ hostId: 'host-1', active: true, connected: true })

    expect(harness.projections.at(-1)).toMatchObject({ hostId: 'host-1', status: 'loading' })
    expect(harness.calls.filter((hostId) => hostId === 'host-1')).toHaveLength(1)

    oldHostRead.resolve(createSnapshot('host-1'))
    await flushPromises()
    expect(harness.calls.filter((hostId) => hostId === 'host-1')).toHaveLength(2)

    freshHostRead.resolve(createSnapshot('host-1'))
    nextHostRead.resolve(createSnapshot('host-2'))
    await flushPromises()
    expect(harness.projections.at(-1)).toMatchObject({ hostId: 'host-1', snapshot: { hostId: 'host-1' } })
  })

  test('Given 已有成功快照 When 下一次读取失败 Then 保留快照并标记 stale', async () => {
    const harness = createControllerHarness()
    harness.controller.select({ hostId: 'host-1', active: true, connected: true })
    await flushPromises()
    harness.setGetOverview(async ({ hostId }) => {
      harness.calls.push(hostId)
      throw new Error('REMOTE_READ_FAILED')
    })

    harness.controller.refresh()
    await flushPromises()

    expect(harness.projections.at(-1)).toMatchObject({
      hostId: 'host-1',
      status: 'ready',
      snapshot: { hostId: 'host-1' },
      stale: true,
      error: '服务器概览暂时不可用，请稍后重试',
    })
  })

  test('Given 成功后断线 When 同一 host 重连且首次读取失败 Then 不得复用上一 SSH 连接快照', async () => {
    const harness = createControllerHarness()
    harness.controller.select({ hostId: 'host-1', active: true, connected: true })
    await flushPromises()
    harness.controller.select({ hostId: 'host-1', active: true, connected: false })
    harness.setGetOverview(async ({ hostId }) => {
      harness.calls.push(hostId)
      throw new Error('SERVER_OPS_OVERVIEW_FAILED')
    })

    harness.controller.select({ hostId: 'host-1', active: true, connected: true })
    expect(harness.projections.at(-1)).toMatchObject({ status: 'loading', snapshot: null, stale: false })
    await flushPromises()

    expect(harness.projections.at(-1)).toMatchObject({
      status: 'error',
      snapshot: null,
      stale: false,
      error: '服务器概览读取失败，请重试',
    })
  })

  test('Given 稳定概览错误码或敏感未知错误 When 请求失败 Then 投影和 DOM 只显示固定恢复文案', async () => {
    /** 稳定公开错误码到固定中文提示的映射。 */
    const cases = [
      ['SERVER_OPS_CONNECTION_CHANGED', '服务器连接已变化，请重新连接后重试'],
      ['SERVER_OPS_OVERVIEW_OUTPUT_INVALID', '服务器返回的概览数据无效，请重试'],
      ['SERVER_OPS_OVERVIEW_FAILED', '服务器概览读取失败，请重试'],
    ] as const
    for (const [errorCode, expectedMessage] of cases) {
      const harness = createControllerHarness()
      harness.setGetOverview(async ({ hostId }) => {
        harness.calls.push(hostId)
        throw new Error(errorCode)
      })
      harness.controller.select({ hostId: 'host-1', active: true, connected: true })
      await flushPromises()
      expect(harness.projections.at(-1)?.error).toBe(expectedMessage)
    }

    const sensitive = '/Users/operator/.ssh/id_ed25519 connectionId=secret-123'
    const harness = createControllerHarness()
    harness.setGetOverview(async ({ hostId }) => {
      harness.calls.push(hostId)
      throw new Error(`Error invoking remote method: SERVER_OPS_OVERVIEW_FAILED ${sensitive}`)
    })
    harness.controller.select({ hostId: 'host-1', active: true, connected: true })
    await flushPromises()
    /** 未知错误必须统一降级，不能从 wrapper 文本提取内部 code。 */
    const projection = harness.projections.at(-1)
    expect(projection?.error).toBe('服务器概览暂时不可用，请稍后重试')
    expect(projection?.error).not.toContain(sensitive)

    const html = renderToStaticMarkup(
      <ServerOpsOverviewPanelView
        status="error"
        snapshot={null}
        stale={false}
        error={sensitive}
        onRefresh={() => undefined}
      />,
    )
    expect(html).toContain('服务器概览暂时不可用，请稍后重试')
    expect(html).not.toContain(sensitive)
    expect(html).not.toContain('connectionId')
  })

  test('Given 已有成功快照 When 当前主机断线 Then 停止轮询并显示无实时数据空态', async () => {
    const harness = createControllerHarness()
    harness.controller.select({ hostId: 'host-1', active: true, connected: true })
    await flushPromises()

    harness.controller.select({ hostId: 'host-1', active: true, connected: false })

    expect(harness.timers.size).toBe(0)
    expect(harness.projections.at(-1)).toMatchObject({
      hostId: 'host-1',
      status: 'idle',
      snapshot: null,
      stale: false,
      error: null,
    })
  })

  test('Given inactive、断线或已 dispose When 选择与刷新 Then 不发送 IPC', async () => {
    const harness = createControllerHarness()
    harness.controller.select({ hostId: 'host-1', active: false, connected: true })
    harness.controller.refresh()
    harness.controller.select({ hostId: 'host-1', active: true, connected: false })
    harness.controller.refresh()
    harness.controller.dispose()
    harness.controller.select({ hostId: 'host-1', active: true, connected: true })
    harness.controller.refresh()
    await flushPromises()

    expect(harness.calls).toHaveLength(0)
    expect(harness.timers.size).toBe(0)
  })
})
