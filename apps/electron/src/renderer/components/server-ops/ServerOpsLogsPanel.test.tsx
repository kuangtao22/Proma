import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import type {
  ServerOpsLogExitEvent,
  ServerOpsLogIdentity,
  ServerOpsLogOutputAck,
  ServerOpsLogOutputEvent,
  ServerOpsLogStartInput,
  ServerOpsLogStartResult,
} from '@proma/shared'
import {
  createServerOpsLogBuffer,
  createServerOpsLogsController,
  projectServerOpsLogsForHost,
  ServerOpsLogsPanelView,
  useServerOpsVisibleLogText,
  useServerOpsLogsAutoScroll,
} from './ServerOpsLogsPanel'
import type { ServerOpsLogsProjection } from './ServerOpsLogsPanel'

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
}

/** 创建可控 Promise，用于验证日志流启动与释放竞态。 */
function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve
    reject = nextReject
  })
  return { promise, resolve, reject }
}

/** 等待控制器的微任务链完成。 */
async function flushPromises(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

interface MinimalEventTarget {
  addEventListener: () => void
  removeEventListener: () => void
}

/** 创建只运行日志自动滚动 Hook 的最小 React 宿主。 */
function createHookRoot(): {
  render: (node: React.ReactElement) => void
  unmount: () => void
  restore: () => void
} {
  const eventTarget: MinimalEventTarget = { addEventListener: () => undefined, removeEventListener: () => undefined }
  class FakeHtmlIFrameElement {}
  const fakeWindow = { ...eventTarget, event: undefined, HTMLIFrameElement: FakeHtmlIFrameElement }
  const fakeDocument = {
    ...eventTarget,
    nodeType: 9,
    defaultView: fakeWindow,
    activeElement: null,
    body: null,
    documentElement: { namespaceURI: 'http://www.w3.org/1999/xhtml' },
  }
  const container = {
    ...eventTarget,
    nodeType: 1,
    tagName: 'DIV',
    namespaceURI: 'http://www.w3.org/1999/xhtml',
    ownerDocument: fakeDocument,
  }
  const globals = globalThis as unknown as { window?: unknown; document?: unknown; IS_REACT_ACT_ENVIRONMENT?: boolean }
  const previousWindow = globals.window
  const previousDocument = globals.document
  const previousActEnvironment = globals.IS_REACT_ACT_ENVIRONMENT
  globals.window = fakeWindow
  globals.document = fakeDocument
  globals.IS_REACT_ACT_ENVIRONMENT = true
  const root = createRoot(container as unknown as Element)
  return {
    render: (node) => { root.render(node) },
    unmount: () => { root.unmount() },
    restore: () => {
      globals.window = previousWindow
      globals.document = previousDocument
      globals.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
    },
  }
}

interface AutoScrollProbeProps {
  projection: ServerOpsLogsProjection
  viewport: { scrollTop: number; scrollHeight: number }
}

/** 通过真实 Effect 观察日志正文物化提交后的自动滚动。 */
function AutoScrollProbe({ projection, viewport }: AutoScrollProbeProps): null {
  const viewportRef = React.useRef<HTMLDivElement>(viewport as HTMLDivElement)
  useServerOpsLogsAutoScroll(projection.paused || !projection.atBottom, projection.materializedRevision, viewportRef)
  return null
}

interface SearchProjectionProbeProps {
  lines: string[]
  text: string
  query: string
  lineCount: number
  onText: (text: string) => void
}

/** 通过真实 Hook 重渲染验证本地搜索只随物化正文或 query 重新派生。 */
function SearchProjectionProbe(props: SearchProjectionProbeProps): null {
  /** lineCount 只模拟轻量统计变化，不参与搜索派生。 */
  void props.lineCount
  props.onText(useServerOpsVisibleLogText(props.lines, props.text, props.query))
  return null
}

/** 创建日志控制器测试环境。 */
function createControllerHarness(options: {
  buffer?: ReturnType<typeof createServerOpsLogBuffer>
  scheduleMaterialize?: (callback: () => void) => () => void
} = {}) {
  const starts: ServerOpsLogStartInput[] = []
  const stops: ServerOpsLogIdentity[] = []
  const acknowledgements: ServerOpsLogOutputAck[] = []
  const exports: Array<{ hostId: string; content: string }> = []
  const projections: ServerOpsLogsProjection[] = []
  const notices: Array<{ kind: 'success' | 'warning' | 'error' | 'info'; message: string }> = []
  let nextStream = 0
  let start = async (input: ServerOpsLogStartInput): Promise<ServerOpsLogStartResult> => {
    starts.push(input)
    return { hostId: input.hostId, streamId: `stream-${++nextStream}` }
  }
  let stop = async (input: ServerOpsLogIdentity): Promise<void> => { stops.push(input) }
  let acknowledge = async (input: ServerOpsLogOutputAck): Promise<void> => { acknowledgements.push(input) }
  let exportLogs = async (input: { hostId: string; content: string }): Promise<{ saved: boolean }> => {
    exports.push(input)
    return { saved: true }
  }
  const controller = createServerOpsLogsController({
    start: (input) => start(input),
    stop: (input) => stop(input),
    acknowledge: (input) => acknowledge(input),
    exportLogs: (input) => exportLogs(input),
    publish: (projection) => { projections.push(projection) },
    notify: (kind, message) => { notices.push({ kind, message }) },
    ...(options.buffer ? { buffer: options.buffer } : {}),
    scheduleMaterialize: options.scheduleMaterialize ?? ((callback) => {
      callback()
      return () => undefined
    }),
  })
  controller.activate()
  return {
    acknowledgements,
    controller,
    exports,
    notices,
    projections,
    starts,
    stops,
    setAcknowledge: (implementation: typeof acknowledge) => { acknowledge = implementation },
    setExportLogs: (implementation: typeof exportLogs) => { exportLogs = implementation },
    setStart: (implementation: typeof start) => { start = implementation },
    setStop: (implementation: typeof stop) => { stop = implementation },
  }
}

describe('服务器运维实时日志面板', () => {
  test('Given 5100 行 When 写入默认缓冲 Then 只保留最新 5000 行并标记截断', () => {
    const buffer = createServerOpsLogBuffer({ maxLines: 5_000, maxBytes: 2_097_152 })
    buffer.append(Array.from({ length: 5_100 }, (_, index) => `line-${index}\n`).join(''))

    const projection = buffer.project()
    expect(projection.lineCount).toBe(5_000)
    expect(projection.text).not.toContain('line-0\n')
    expect(projection.text).toStartWith('line-100\n')
    expect(projection.text).toEndWith('line-5099\n')
    expect(projection.truncated).toBe(true)
  })

  test('Given Unicode、CRLF 与无末尾换行 When 跨 chunk 写入 Then 精确维护 UTF-8 字节和行边界', () => {
    const buffer = createServerOpsLogBuffer({ maxLines: 10, maxBytes: 64 })
    buffer.append('中文\r')
    buffer.append('\nsecond')
    buffer.append('-part')

    expect(buffer.project()).toMatchObject({
      text: '中文\r\nsecond-part',
      lineCount: 2,
      byteLength: new TextEncoder().encode('中文\r\nsecond-part').byteLength,
      truncated: false,
    })
  })

  test('Given UTF-8 字节超过上限 When 淘汰 Then 不按 JS 字符数误判', () => {
    const buffer = createServerOpsLogBuffer({ maxLines: 10, maxBytes: 8 })
    buffer.append('甲\n乙\n丙\n')

    expect(buffer.project()).toMatchObject({ text: '乙\n丙\n', byteLength: 8, truncated: true })
  })

  test('Given 单行自身超过字节上限 When 写入 Then 丢弃该行且内存保持有界', () => {
    const buffer = createServerOpsLogBuffer({ maxLines: 10, maxBytes: 8 })
    buffer.append('这是一个很长的单行')

    expect(buffer.project()).toEqual({ text: '', lines: [], lineCount: 0, byteLength: 0, truncated: true })
  })

  test('Given 超长未换行物理行跨 chunk When 已淘汰 Then 丢弃到下一换行后再恢复 Unicode 与 CRLF', () => {
    const buffer = createServerOpsLogBuffer({ maxLines: 10, maxBytes: 17 })
    buffer.append('超长中文片段')
    buffer.append('x')
    buffer.append('y\r')
    buffer.append('\n恢复\r\nnext')

    expect(buffer.project()).toEqual({
      text: '恢复\r\nnext',
      lines: ['恢复\r\n', 'next'],
      lineCount: 2,
      byteLength: new TextEncoder().encode('恢复\r\nnext').byteLength,
      truncated: true,
    })
  })

  test('Given 当前流 chunk When 接收 Then 先发布缓冲再 ACK', async () => {
    const harness = createControllerHarness()
    await harness.controller.select({ hostId: 'host-1', active: true, connected: true })
    harness.setAcknowledge(async (input) => {
      expect(harness.projections.at(-1)?.text).toBe('first\n')
      harness.acknowledgements.push(input)
    })

    await harness.controller.handleOutput({ hostId: 'host-1', streamId: 'stream-1', sequence: 0, data: 'first\n' })

    expect(harness.acknowledgements).toEqual([{ hostId: 'host-1', streamId: 'stream-1', sequence: 0 }])
  })

  test('Given 旧主机、旧流或重复乱序 sequence When 接收 Then 零写入且零 ACK', async () => {
    const harness = createControllerHarness()
    await harness.controller.select({ hostId: 'host-1', active: true, connected: true })
    await harness.controller.handleOutput({ hostId: 'host-1', streamId: 'stream-1', sequence: 0, data: 'accepted\n' })
    const invalidEvents: ServerOpsLogOutputEvent[] = [
      { hostId: 'host-2', streamId: 'stream-1', sequence: 2, data: 'old-host\n' },
      { hostId: 'host-1', streamId: 'stream-old', sequence: 2, data: 'old-stream\n' },
      { hostId: 'host-1', streamId: 'stream-1', sequence: 0, data: 'duplicate\n' },
    ]
    for (const event of invalidEvents) await harness.controller.handleOutput(event)

    expect(harness.projections.at(-1)?.text).toBe('accepted\n')
    expect(harness.acknowledgements).toEqual([{ hostId: 'host-1', streamId: 'stream-1', sequence: 0 }])
  })

  test('Given 首包非 0 或 0 后直接到 2 When 接收 Then gap 不写入不 ACK并精确停止当前流', async () => {
    for (const events of [
      [{ hostId: 'host-1', streamId: 'stream-1', sequence: 1, data: 'bad-first\n' }],
      [
        { hostId: 'host-1', streamId: 'stream-1', sequence: 0, data: 'first\n' },
        { hostId: 'host-1', streamId: 'stream-1', sequence: 2, data: 'gap\n' },
      ],
    ] satisfies ServerOpsLogOutputEvent[][]) {
      const harness = createControllerHarness()
      await harness.controller.select({ hostId: 'host-1', connectionId: 'connection-1', active: true, connected: true })
      for (const event of events) await harness.controller.handleOutput(event)

      expect(harness.projections.at(-1)).toMatchObject({ status: 'error', error: '日志序列不连续，实时流已停止' })
      expect(harness.projections.at(-1)?.text).not.toContain('gap')
      expect(harness.projections.at(-1)?.text).not.toContain('bad-first')
      expect(harness.acknowledgements).toHaveLength(events.length - 1)
      expect(harness.stops).toEqual([{ hostId: 'host-1', streamId: 'stream-1' }])
      await harness.controller.handleOutput({ hostId: 'host-1', streamId: 'stream-old', sequence: 0, data: 'late\n' })
      expect(harness.acknowledgements).toHaveLength(events.length - 1)
    }
  })

  test('Given burst 输出 When ACK 前发布轻量 revision Then 不会每个 chunk 物化完整缓冲', async () => {
    /** 包装真实 buffer 统计昂贵 project 调用次数。 */
    const realBuffer = createServerOpsLogBuffer({ maxLines: 5_000, maxBytes: 2_097_152 })
    let materializations = 0
    const buffer = {
      append: realBuffer.append,
      clear: realBuffer.clear,
      inspect: realBuffer.inspect,
      project: () => { materializations += 1; return realBuffer.project() },
    }
    /** 测试显式驱动物化批次。 */
    const scheduled: Array<() => void> = []
    const harness = createControllerHarness({
      buffer,
      scheduleMaterialize: (callback) => { scheduled.push(callback); return () => undefined },
    })
    await harness.controller.select({ hostId: 'host-1', connectionId: 'connection-1', active: true, connected: true })
    const baseline = materializations

    const outputs = Array.from({ length: 100 }, (_, sequence) => harness.controller.handleOutput({
      hostId: 'host-1', streamId: 'stream-1', sequence, data: `line-${sequence}\n`,
    }))
    await Promise.all(outputs)

    expect(materializations).toBe(baseline)
    expect(scheduled).toHaveLength(1)
    expect(harness.projections.at(-1)).toMatchObject({ bufferRevision: 100, lineCount: 100 })
    scheduled[0]?.()
    expect(materializations).toBe(baseline + 1)
    expect(harness.projections.at(-1)?.text).toContain('line-99')
  })

  test('Given 物化行引用与 query 未变 When 仅行数和字节统计发布 Then 不重复执行本地搜索过滤', async () => {
    /** 代理只统计 filter 属性读取次数，不改变真实数组语义。 */
    let filterReads = 0
    const lines = new Proxy(['Alpha\n', 'error beta\n'], {
      get: (target, property, receiver) => {
        if (property === 'filter') filterReads += 1
        return Reflect.get(target, property, receiver)
      },
    })
    /** 每次真实渲染观察 Hook 返回的可见正文。 */
    const visibleTexts: string[] = []
    const host = createHookRoot()
    try {
      await act(async () => {
        host.render(<SearchProjectionProbe lines={lines} text={'Alpha\nerror beta\n'} query="error" lineCount={2} onText={(text) => visibleTexts.push(text)} />)
      })
      await act(async () => {
        host.render(<SearchProjectionProbe lines={lines} text={'Alpha\nerror beta\n'} query="error" lineCount={3} onText={(text) => visibleTexts.push(text)} />)
      })

      expect(filterReads).toBe(1)
      expect(visibleTexts.at(-1)).toBe('error beta\n')
    } finally {
      act(() => { host.unmount() })
      host.restore()
    }
  })

  test('Given chunk 先轻量发布 When 正文批次随后物化 Then 只在新正文提交后滚动到最新高度', async () => {
    /** 手动控制正文物化时机，模拟 16ms 批次边界。 */
    const scheduled: Array<() => void> = []
    const harness = createControllerHarness({
      scheduleMaterialize: (callback) => { scheduled.push(callback); return () => undefined },
    })
    await harness.controller.select({ hostId: 'host-1', connectionId: 'connection-1', active: true, connected: true })
    /** 视口高度只在正文真正提交后增长。 */
    const viewport = { scrollTop: 0, scrollHeight: 10 }
    const host = createHookRoot()
    try {
      await act(async () => {
        host.render(<AutoScrollProbe projection={harness.projections.at(-1)!} viewport={viewport} />)
      })
      viewport.scrollTop = 0

      await harness.controller.handleOutput({
        hostId: 'host-1', streamId: 'stream-1', sequence: 0, data: 'new line\n',
      })
      const lightweight = harness.projections.at(-1)!
      await act(async () => {
        host.render(<AutoScrollProbe projection={lightweight} viewport={viewport} />)
      })
      expect(lightweight.text).toBe('')
      expect(lightweight.materializedRevision).toBe(0)
      expect(viewport.scrollTop).toBe(0)

      scheduled[0]?.()
      const materialized = harness.projections.at(-1)!
      viewport.scrollHeight = 20
      await act(async () => {
        host.render(<AutoScrollProbe projection={materialized} viewport={viewport} />)
      })
      expect(materialized.text).toBe('new line\n')
      expect(materialized.materializedRevision).toBe(1)
      expect(viewport.scrollTop).toBe(20)
    } finally {
      act(() => { host.unmount() })
      host.restore()
    }
  })

  test('Given 用户已滚离底部 When 切换主机并收到新正文 Then 跟随事实重置且物化后滚到新高度', async () => {
    /** 手动控制新主机正文物化时机。 */
    const scheduled: Array<() => void> = []
    const harness = createControllerHarness({
      scheduleMaterialize: (callback) => { scheduled.push(callback); return () => undefined },
    })
    await harness.controller.select({ hostId: 'host-1', connectionId: 'connection-1', active: true, connected: true })
    const viewport = { scrollTop: 0, scrollHeight: 10 }
    const host = createHookRoot()
    try {
      await act(async () => {
        host.render(<AutoScrollProbe projection={harness.projections.at(-1)!} viewport={viewport} />)
      })
      harness.controller.setAtBottom(false)
      await act(async () => {
        host.render(<AutoScrollProbe projection={harness.projections.at(-1)!} viewport={viewport} />)
      })
      viewport.scrollTop = 0

      await harness.controller.select({ hostId: 'host-2', connectionId: 'connection-2', active: true, connected: true })
      await harness.controller.handleOutput({
        hostId: 'host-2', streamId: 'stream-2', sequence: 0, data: 'host two\n',
      })
      await act(async () => {
        host.render(<AutoScrollProbe projection={harness.projections.at(-1)!} viewport={viewport} />)
      })
      scheduled.at(-1)?.()
      viewport.scrollHeight = 20
      await act(async () => {
        host.render(<AutoScrollProbe projection={harness.projections.at(-1)!} viewport={viewport} />)
      })

      expect(viewport.scrollTop).toBe(20)
    } finally {
      act(() => { host.unmount() })
      host.restore()
    }
  })

  test('Given 用户已滚离底部 When clear 或离开再进入 Then 新正文物化后都恢复自动跟随', async () => {
    for (const scenario of ['clear', 're-enter'] as const) {
      /** 每个重置场景使用独立控制器与物化队列。 */
      const scheduled: Array<() => void> = []
      const harness = createControllerHarness({
        scheduleMaterialize: (callback) => { scheduled.push(callback); return () => undefined },
      })
      await harness.controller.select({ hostId: 'host-1', connectionId: 'connection-1', active: true, connected: true })
      const viewport = { scrollTop: 0, scrollHeight: 10 }
      const host = createHookRoot()
      try {
        await act(async () => {
          host.render(<AutoScrollProbe projection={harness.projections.at(-1)!} viewport={viewport} />)
        })
        harness.controller.setAtBottom(false)
        await act(async () => {
          host.render(<AutoScrollProbe projection={harness.projections.at(-1)!} viewport={viewport} />)
        })
        viewport.scrollTop = 0

        if (scenario === 'clear') {
          harness.controller.clear()
        } else {
          await harness.controller.select({ hostId: 'host-1', connectionId: 'connection-1', active: false, connected: true })
          await harness.controller.select({ hostId: 'host-1', connectionId: 'connection-1', active: true, connected: true })
        }
        /** clear 保留原流，重进则启动第二个流生命周期。 */
        const streamId = scenario === 'clear' ? 'stream-1' : 'stream-2'
        await harness.controller.handleOutput({ hostId: 'host-1', streamId, sequence: 0, data: `${scenario}\n` })
        await act(async () => {
          host.render(<AutoScrollProbe projection={harness.projections.at(-1)!} viewport={viewport} />)
        })
        scheduled.at(-1)?.()
        viewport.scrollHeight = 20
        await act(async () => {
          host.render(<AutoScrollProbe projection={harness.projections.at(-1)!} viewport={viewport} />)
        })

        expect(viewport.scrollTop).toBe(20)
      } finally {
        act(() => { host.unmount() })
        host.restore()
      }
    }
  })

  test('Given active 且 connected When 选择主机 Then 显式启动；远程筛选重启而本地搜索不重启', async () => {
    const harness = createControllerHarness()
    await harness.controller.select({ hostId: 'host-1', active: true, connected: true })
    harness.controller.setQuery('error')
    await flushPromises()
    expect(harness.starts).toHaveLength(1)

    await harness.controller.updateRemoteFilters({ since: '1h', priority: 'warning', tailLines: 300 })
    expect(harness.stops).toEqual([{ hostId: 'host-1', streamId: 'stream-1' }])
    expect(harness.starts.at(-1)).toMatchObject({ hostId: 'host-1', since: '1h', priority: 'warning', tailLines: 300 })
  })

  test('Given 当前流 When 远程筛选变化 Then 等待精确 stop 完成后才 start 新流', async () => {
    const harness = createControllerHarness()
    const stop = createDeferred<void>()
    await harness.controller.select({ hostId: 'host-1', active: true, connected: true })
    harness.setStop((input) => {
      harness.stops.push(input)
      return stop.promise
    })

    const changing = harness.controller.updateRemoteFilters({ priority: 'err' })
    await flushPromises()
    expect(harness.stops).toEqual([{ hostId: 'host-1', streamId: 'stream-1' }])
    expect(harness.starts).toHaveLength(1)

    stop.resolve()
    await changing
    expect(harness.starts).toHaveLength(2)
  })

  test('Given A 修改筛选、搜索和暂停 When 切换到 B Then 同一 controller 显式恢复新主机默认状态', async () => {
    const harness = createControllerHarness()
    await harness.controller.select({ hostId: 'host-a', connectionId: 'connection-a', active: true, connected: true })
    harness.controller.setQuery('needle')
    harness.controller.setPaused(true)
    await harness.controller.updateRemoteFilters({
      source: { kind: 'unit', unitId: 'app-a.service' },
      since: '1h',
      priority: 'err',
      tailLines: 300,
    })

    await harness.controller.select({ hostId: 'host-b', connectionId: 'connection-b', active: true, connected: true })

    expect(harness.starts.at(-1)).toEqual({
      hostId: 'host-b',
      source: { kind: 'system' },
      since: '15m',
      priority: 'info',
      tailLines: 200,
    })
    expect(harness.projections.at(-1)).toMatchObject({
      hostId: 'host-b',
      source: { kind: 'system' },
      since: '15m',
      priority: 'info',
      tailLines: 200,
      query: '',
      paused: false,
      lineCount: 0,
      byteLength: 0,
    })
  })

  test('Given stop 尚未返回 When 收到被阻断流的精确 exit Then 解除屏障并启动待替换流', async () => {
    const harness = createControllerHarness()
    const stop = createDeferred<void>()
    await harness.controller.select({ hostId: 'host-1', connectionId: 'connection-1', active: true, connected: true })
    harness.setStop((input) => {
      harness.stops.push(input)
      return stop.promise
    })

    const changing = harness.controller.updateRemoteFilters({ priority: 'err' })
    await flushPromises()
    harness.controller.handleExit({ hostId: 'host-1', streamId: 'stream-1', reason: 'stopped' })
    await changing

    expect(harness.starts).toHaveLength(2)
    stop.resolve()
  })

  test('Given stop 尚未返回 When 同主机连接代次明确变化并重新进入 Then 新代次不被旧屏障阻断', async () => {
    const harness = createControllerHarness()
    const stop = createDeferred<void>()
    await harness.controller.select({ hostId: 'host-1', connectionId: 'connection-1', active: true, connected: true })
    harness.setStop((input) => {
      harness.stops.push(input)
      return stop.promise
    })

    const changingConnection = harness.controller.select({
      hostId: 'host-1',
      connectionId: 'connection-2',
      active: true,
      connected: true,
    })
    await flushPromises()
    await harness.controller.select({ hostId: 'host-1', connectionId: 'connection-2', active: false, connected: true })
    const entering = harness.controller.select({
      hostId: 'host-1',
      connectionId: 'connection-2',
      active: true,
      connected: true,
    })
    await Promise.all([changingConnection, entering])

    expect(harness.starts).toHaveLength(2)
    stop.resolve()
  })

  test('Given 切主机正在等待旧 stop When 又切到第三台主机 Then 旧选择不能替新主机重复启动', async () => {
    const harness = createControllerHarness()
    const stop = createDeferred<void>()
    await harness.controller.select({ hostId: 'host-1', active: true, connected: true })
    harness.setStop((input) => {
      harness.stops.push(input)
      return stop.promise
    })

    const selectingHost2 = harness.controller.select({ hostId: 'host-2', connectionId: 'connection-2', active: true, connected: true })
    await flushPromises()
    const selectingHost3 = harness.controller.select({ hostId: 'host-3', connectionId: 'connection-3', active: true, connected: true })
    await flushPromises()
    expect(harness.starts).toHaveLength(1)
    stop.resolve()
    await Promise.all([selectingHost2, selectingHost3])

    expect(harness.starts.filter((input) => input.hostId === 'host-2')).toHaveLength(0)
    expect(harness.starts.filter((input) => input.hostId === 'host-3')).toHaveLength(1)
  })

  test('Given streamId 被新生命周期复用 When 每次离开日志页 Then 每个生命周期都精确 stop 一次且无历史集合抑制', async () => {
    const harness = createControllerHarness()
    harness.setStart(async (input) => {
      harness.starts.push(input)
      return { hostId: input.hostId, streamId: 'reused-stream' }
    })
    for (let cycle = 0; cycle < 2; cycle += 1) {
      await harness.controller.select({ hostId: 'host-1', connectionId: `connection-${cycle}`, active: true, connected: true })
      await harness.controller.select({ hostId: 'host-1', connectionId: `connection-${cycle}`, active: false, connected: true })
    }

    expect(harness.stops).toEqual([
      { hostId: 'host-1', streamId: 'reused-stream' },
      { hostId: 'host-1', streamId: 'reused-stream' },
    ])
  })

  test('Given 日志页保持 active When 连接代次变化 Then 失效旧流但不自动重连，离开再进入才启动', async () => {
    const harness = createControllerHarness()
    await harness.controller.select({ hostId: 'host-1', connectionId: 'connection-1', active: true, connected: true })
    await harness.controller.select({ hostId: 'host-1', connectionId: null, active: true, connected: false })
    await harness.controller.select({ hostId: 'host-1', connectionId: 'connection-2', active: true, connected: true })
    expect(harness.starts).toHaveLength(1)

    await harness.controller.select({ hostId: 'host-1', connectionId: 'connection-2', active: false, connected: true })
    await harness.controller.select({ hostId: 'host-1', connectionId: 'connection-2', active: true, connected: true })
    expect(harness.starts).toHaveLength(2)
  })

  test('Given 日志页保持 active 且 connected When connectionId 直接变化 Then 精确停止且不自动重连', async () => {
    const harness = createControllerHarness()
    await harness.controller.select({ hostId: 'host-1', connectionId: 'connection-1', active: true, connected: true })

    await harness.controller.select({ hostId: 'host-1', connectionId: 'connection-2', active: true, connected: true })

    expect(harness.stops).toEqual([{ hostId: 'host-1', streamId: 'stream-1' }])
    expect(harness.starts).toHaveLength(1)
  })

  test('Given 切页或断线 When 生命周期失效 Then 精确 stop 且连接变化不自动重连', async () => {
    for (const next of [
      { hostId: 'host-1', active: false, connected: true },
      { hostId: 'host-1', active: true, connected: false },
    ]) {
      const harness = createControllerHarness()
      await harness.controller.select({ hostId: 'host-1', active: true, connected: true })
      await harness.controller.select(next)
      await harness.controller.select({ ...next, connected: true })
      expect(harness.stops).toEqual([{ hostId: 'host-1', streamId: 'stream-1' }])
      expect(harness.starts).toHaveLength(1)
    }
  })

  test('Given start 结果迟到 When 已切页 Then 立即精确 stop 且不发布 streaming', async () => {
    const harness = createControllerHarness()
    const start = createDeferred<ServerOpsLogStartResult>()
    harness.setStart((input) => {
      harness.starts.push(input)
      return start.promise
    })
    const starting = harness.controller.select({ hostId: 'host-1', active: true, connected: true })
    await flushPromises()
    await harness.controller.select({ hostId: 'host-1', active: false, connected: true })
    start.resolve({ hostId: 'host-1', streamId: 'late-stream' })
    await starting

    expect(harness.stops).toContainEqual({ hostId: 'host-1', streamId: 'late-stream' })
    expect(harness.projections.at(-1)?.status).toBe('idle')
  })

  test('Given Electron 包装的稳定启动错误 When 启动失败 Then 映射能力或权限状态且不泄漏附加文本', async () => {
    for (const [errorCode, status] of [
      ['SERVER_OPS_LOG_UNAVAILABLE', 'unsupported'],
      ['SERVER_OPS_LOG_PERMISSION_DENIED', 'permission-denied'],
    ] as const) {
      const harness = createControllerHarness()
      harness.setStart(async () => {
        throw new Error(`Error invoking remote method 'server-ops:start-log-stream': Error: ${errorCode}`)
      })

      await harness.controller.select({ hostId: 'host-1', active: true, connected: true })

      expect(harness.projections.at(-1)?.status).toBe(status)
      expect(JSON.stringify(harness.projections.at(-1))).not.toContain('remote method')
    }
  })

  test('Given 已暂停 When 日志继续到达 Then 仍 ACK 且按上限淘汰', async () => {
    const harness = createControllerHarness()
    await harness.controller.select({ hostId: 'host-1', active: true, connected: true })
    harness.controller.setPaused(true)
    for (let sequence = 0; sequence < 5_100; sequence += 1) {
      await harness.controller.handleOutput({ hostId: 'host-1', streamId: 'stream-1', sequence, data: `line-${sequence}\n` })
    }

    expect(harness.acknowledgements).toHaveLength(5_100)
    expect(harness.projections.at(-1)).toMatchObject({ paused: true, lineCount: 5_000, truncated: true })
  })

  test('Given 用户主动离开底部 When 新日志到达 Then 不抢滚动并显示返回底部入口', async () => {
    const harness = createControllerHarness()
    await harness.controller.select({ hostId: 'host-1', active: true, connected: true })
    harness.controller.setAtBottom(false)

    await harness.controller.handleOutput({ hostId: 'host-1', streamId: 'stream-1', sequence: 0, data: 'new\n' })

    expect(harness.projections.at(-1)?.hasNewLogs).toBe(true)
    harness.controller.markAtBottom()
    expect(harness.projections.at(-1)?.hasNewLogs).toBe(false)
  })

  test('Given 当前流 ACK 失败 When Promise 拒绝 Then 安全停止并显示不泄漏底层文本的错误', async () => {
    const harness = createControllerHarness()
    harness.setAcknowledge(async () => { throw new Error('secret ack failure') })
    await harness.controller.select({ hostId: 'host-1', active: true, connected: true })

    await harness.controller.handleOutput({ hostId: 'host-1', streamId: 'stream-1', sequence: 0, data: 'first\n' })
    await flushPromises()

    expect(harness.stops).toEqual([{ hostId: 'host-1', streamId: 'stream-1' }])
    expect(harness.projections.at(-1)).toMatchObject({ status: 'error', error: '日志确认失败，实时流已停止' })
    expect(JSON.stringify(harness.projections.at(-1))).not.toContain('secret')
  })

  test('Given stop 同步抛错 When 切页 Then 仍同步失效旧流且不阻断生命周期', async () => {
    const harness = createControllerHarness()
    harness.setStop(() => { throw new Error('stop failed') })
    await harness.controller.select({ hostId: 'host-1', active: true, connected: true })

    await expect(harness.controller.select({ hostId: 'host-1', active: false, connected: true })).resolves.toBeUndefined()
    expect(harness.projections.at(-1)?.status).toBe('idle')
  })

  test('Given 远程筛选切换的 stop reject When 无法确认旧流已停止 Then 不启动替代流并发布脱敏诊断', async () => {
    const harness = createControllerHarness()
    const stop = createDeferred<void>()
    await harness.controller.select({ hostId: 'host-1', connectionId: 'connection-1', active: true, connected: true })
    harness.setStop((input) => {
      harness.stops.push(input)
      return stop.promise
    })

    const firstChange = harness.controller.updateRemoteFilters({ priority: 'err' })
    await flushPromises()
    const secondChange = harness.controller.updateRemoteFilters({ since: '1h' })
    await flushPromises()
    expect(harness.starts).toHaveLength(1)

    stop.reject(new Error('secret stop failure'))
    await Promise.all([firstChange, secondChange])

    expect(harness.stops).toEqual([{ hostId: 'host-1', streamId: 'stream-1' }])
    expect(harness.starts).toHaveLength(1)
    expect(harness.projections.at(-1)).toMatchObject({
      status: 'error',
      error: '无法确认旧日志流已停止，已取消启动新日志流',
      warning: '日志流停止失败，请检查 SSH 连接状态',
    })
    expect(JSON.stringify(harness.projections.at(-1))).not.toContain('secret')
  })

  test('Given 切换主机的 stop reject When 无法确认旧流已停止 Then 不为新主机启动日志流', async () => {
    const harness = createControllerHarness()
    await harness.controller.select({ hostId: 'host-1', connectionId: 'connection-1', active: true, connected: true })
    harness.setStop(async (input) => {
      harness.stops.push(input)
      throw new Error('secret host switch stop failure')
    })

    await harness.controller.select({ hostId: 'host-2', connectionId: 'connection-2', active: true, connected: true })

    expect(harness.stops).toEqual([{ hostId: 'host-1', streamId: 'stream-1' }])
    expect(harness.starts).toHaveLength(1)
    expect(harness.projections.at(-1)).toMatchObject({
      hostId: 'host-2',
      status: 'error',
      error: '无法确认旧日志流已停止，已取消启动新日志流',
      warning: '日志流停止失败，请检查 SSH 连接状态',
    })
    expect(JSON.stringify(harness.projections.at(-1))).not.toContain('secret')
  })

  test('Given dispose 的 stop reject When StrictMode owner 重新激活 Then 发布稳定诊断且底层文本不泄漏', async () => {
    const harness = createControllerHarness()
    const stop = createDeferred<void>()
    await harness.controller.select({ hostId: 'host-1', connectionId: 'connection-1', active: true, connected: true })
    harness.setStop((input) => {
      harness.stops.push(input)
      return stop.promise
    })

    harness.controller.dispose()
    await flushPromises()
    harness.controller.activate()
    const replay = harness.controller.select({
      hostId: 'host-1',
      connectionId: 'connection-1',
      active: true,
      connected: true,
    })
    await flushPromises()
    expect(harness.starts).toHaveLength(1)

    stop.reject(new Error('secret dispose failure'))
    await replay

    expect(harness.stops).toEqual([{ hostId: 'host-1', streamId: 'stream-1' }])
    expect(harness.starts).toHaveLength(1)
    expect(harness.projections.at(-1)).toMatchObject({
      status: 'error',
      error: '无法确认旧日志流已停止，已取消启动新日志流',
      warning: '日志流停止失败，请检查 SSH 连接状态',
    })
    expect(JSON.stringify(harness.projections.at(-1))).not.toContain('secret')
  })

  test('Given dispose 后旧 stop 尚未返回 When 新连接代次重放 Then 直接解除旧代次门禁', async () => {
    const harness = createControllerHarness()
    const stop = createDeferred<void>()
    await harness.controller.select({ hostId: 'host-1', connectionId: 'connection-1', active: true, connected: true })
    harness.setStop((input) => {
      harness.stops.push(input)
      return stop.promise
    })

    harness.controller.dispose()
    await flushPromises()
    harness.controller.activate()
    let replaySettled = false
    const replay = harness.controller.select({
      hostId: 'host-1',
      connectionId: 'connection-2',
      active: true,
      connected: true,
    }).then(() => { replaySettled = true })
    /** 让完整 barrier 链结算，但不释放仍 pending 的 stop IPC。 */
    await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
    /** 先保存断言事实，再释放旧测试 Promise，避免失败时留下悬空异步链。 */
    const settledBeforeStopResult = replaySettled
    stop.resolve()
    await replay

    expect(settledBeforeStopResult).toBe(true)
    expect(harness.starts).toHaveLength(2)
  })

  test('Given ACK 失败 When 当前流继续输出或已经切流 Then 不产生未处理拒绝且只污染当前流状态', async () => {
    const harness = createControllerHarness()
    const ack = createDeferred<void>()
    harness.setAcknowledge(() => ack.promise)
    await harness.controller.select({ hostId: 'host-1', active: true, connected: true })
    const handling = harness.controller.handleOutput({ hostId: 'host-1', streamId: 'stream-1', sequence: 0, data: 'first\n' })
    await harness.controller.updateRemoteFilters({ since: '1h' })
    ack.reject(new Error('secret ack failure'))
    await handling

    expect(harness.projections.at(-1)?.status).toBe('streaming')
    expect(JSON.stringify(harness.projections.at(-1))).not.toContain('secret')
  })

  test('Given 当前有界缓冲 When 导出 Then 只导出未淘汰内容并区分取消成功失败', async () => {
    const harness = createControllerHarness()
    await harness.controller.select({ hostId: 'host-1', active: true, connected: true })
    for (let sequence = 0; sequence < 5_001; sequence += 1) {
      await harness.controller.handleOutput({ hostId: 'host-1', streamId: 'stream-1', sequence, data: `line-${sequence}\n` })
    }
    await harness.controller.exportCurrent()
    expect(harness.exports[0]?.content).not.toContain('line-0\n')
    expect(harness.exports[0]?.content).toStartWith('line-1\n')
    expect(harness.notices.at(-1)).toEqual({ kind: 'success', message: '日志已导出' })

    harness.setExportLogs(async (input) => { harness.exports.push(input); return { saved: false } })
    await harness.controller.exportCurrent()
    expect(harness.notices.at(-1)).toEqual({ kind: 'info', message: '已取消导出' })

    harness.setExportLogs(async () => { throw new Error('secret path') })
    await harness.controller.exportCurrent()
    expect(harness.notices.at(-1)).toEqual({ kind: 'error', message: '日志导出失败，请稍后重试' })
  })

  test('Given exit 与 dispose 竞态 When 重复收口 Then 每个精确流最多 stop 一次且 StrictMode 可重新激活', async () => {
    const harness = createControllerHarness()
    await harness.controller.select({ hostId: 'host-1', active: true, connected: true })
    const exit: ServerOpsLogExitEvent = { hostId: 'host-1', streamId: 'stream-1', reason: 'remote-exit' }
    harness.controller.handleExit(exit)
    harness.controller.dispose()
    harness.controller.activate()
    expect(harness.projections.at(-1)).toMatchObject({ status: 'idle', streamId: null })
    await harness.controller.select({ hostId: 'host-1', active: true, connected: true })

    expect(harness.stops.filter((item) => item.streamId === 'stream-1')).toHaveLength(0)
    expect(harness.starts).toHaveLength(2)
  })

  test('Given 切换主机后的首帧仍持有旧投影 When 渲染新主机 Then 不展示旧主机日志或筛选', () => {
    /** 模拟 React 在 passive effect 执行前仍持有的上一主机投影。 */
    const staleProjection: ServerOpsLogsProjection = {
      hostId: 'host-a',
      streamId: 'stream-a',
      requestRevision: 7,
      status: 'streaming',
      paused: true,
      query: 'secret-a',
      error: null,
      warning: 'host-a-warning',
      hasNewLogs: true,
      atBottom: false,
      bufferRevision: 3,
      materializedRevision: 3,
      source: { kind: 'unit', unitId: 'host-a.service' },
      since: '24h',
      priority: 'debug',
      tailLines: 500,
      text: 'host-a-secret-log\n',
      lines: ['host-a-secret-log\n'],
      lineCount: 1,
      byteLength: 18,
      truncated: true,
    }

    const visibleProjection = projectServerOpsLogsForHost(staleProjection, 'host-b')
    const html = renderToStaticMarkup(
      <ServerOpsLogsPanelView
        {...visibleProjection}
        connected
        onSourceChange={() => undefined}
        onUnitIdChange={() => undefined}
        onSinceChange={() => undefined}
        onPriorityChange={() => undefined}
        onQueryChange={() => undefined}
        onTogglePaused={() => undefined}
        onClear={() => undefined}
        onExport={() => undefined}
        onReturnToBottom={() => undefined}
      />,
    )

    expect(visibleProjection).toMatchObject({
      hostId: 'host-b',
      streamId: null,
      status: 'idle',
      paused: false,
      query: '',
      source: { kind: 'system' },
      since: '15m',
      priority: 'info',
      tailLines: 200,
      text: '',
      lines: [],
      lineCount: 0,
      byteLength: 0,
      truncated: false,
    })
    expect(html).not.toContain('host-a-secret-log')
    expect(html).not.toContain('host-a.service')
    expect(html).not.toContain('secret-a')
    expect(html).not.toContain('host-a-warning')
  })

  test('Given 不同状态 When 渲染 Then 提供安全状态、稳定工具栏和可选日志正文', () => {
    const html = renderToStaticMarkup(
      <ServerOpsLogsPanelView
        status="streaming"
        connected
        text={'alpha\nerror beta\n'}
        lines={['alpha\n', 'error beta\n']}
        lineCount={2}
        byteLength={17}
        truncated
        paused
        query="error"
        source={{ kind: 'system' }}
        since="15m"
        priority="info"
        tailLines={200}
        error={null}
        warning={null}
        hasNewLogs
        atBottom
        bufferRevision={0}
        materializedRevision={0}
        onSourceChange={() => undefined}
        onUnitIdChange={() => undefined}
        onSinceChange={() => undefined}
        onPriorityChange={() => undefined}
        onQueryChange={() => undefined}
        onTogglePaused={() => undefined}
        onClear={() => undefined}
        onExport={() => undefined}
        onReturnToBottom={() => undefined}
      />,
    )

    expect(html).toContain('aria-label="日志来源"')
    expect(html).toContain('aria-label="日志时间范围"')
    expect(html).toContain('aria-label="日志优先级"')
    expect(html).toContain('aria-label="搜索已接收日志"')
    expect(html).toContain('暂停自动滚动')
    expect(html).toContain('清空本地日志')
    expect(html).toContain('导出当前日志')
    expect(html).toContain('有新日志')
    expect(html).toContain('error beta')
    expect(html).not.toContain('>alpha<')
    expect(html).toContain('日志已达到本地缓冲上限')
    expect(html).toContain('select-text')
    /** 高频计数必须位于 live region 外，只播报低频流状态。 */
    const liveRegion = html.match(/<span[^>]*role="status"[^>]*>[^<]*<\/span>/u)?.[0] ?? ''
    expect(liveRegion).toContain('aria-live="polite"')
    expect(liveRegion).toContain('实时接收')
    expect(liveRegion).not.toContain('2 行')
  })
})
