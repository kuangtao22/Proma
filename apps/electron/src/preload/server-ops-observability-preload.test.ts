import { describe, expect, test } from 'bun:test'
import { SERVER_OPS_IPC_CHANNELS } from '@proma/shared'
import {
  invokeServerOpsLogAck,
  invokeServerOpsLogExport,
  invokeServerOpsLogStart,
  invokeServerOpsLogStop,
  invokeServerOpsOverview,
  invokeServerOpsServiceAction,
  invokeServerOpsServiceDetail,
  invokeServerOpsServiceList,
  subscribeServerOpsLogExit,
  subscribeServerOpsLogOutput,
} from './server-ops-observability-preload'

/** 创建可验证通道、输入和严格返回解析的 invoke 替身。 */
function createInvoke(result: unknown, calls: Array<{ channel: string; input: unknown }>) {
  return async (channel: string, input: unknown): Promise<unknown> => {
    calls.push({ channel, input })
    return result
  }
}

describe('Server Ops 观测 preload', () => {
  test('所有 invoke 都先严格解析输入并再次严格解析结果', async () => {
    const calls: Array<{ channel: string; input: unknown }> = []
    await expect(invokeServerOpsOverview(createInvoke({ hostId: 'host-1', capturedAt: 1, sampleWindowMs: 1, filesystems: [], processes: [], warnings: [] }, calls), { hostId: 'host-1' }))
      .resolves.toMatchObject({ hostId: 'host-1' })
    await expect(invokeServerOpsServiceList(createInvoke({ hostId: 'host-1', capability: 'available', services: [], warnings: [] }, calls), { hostId: 'host-1' }))
      .resolves.toMatchObject({ capability: 'available' })
    await expect(invokeServerOpsServiceDetail(createInvoke({ hostId: 'host-1', capability: 'available', statusLines: [], recentLogLines: [], warnings: [] }, calls), { hostId: 'host-1', unitId: 'nginx.service' }))
      .resolves.toMatchObject({ hostId: 'host-1' })
    await expect(invokeServerOpsServiceAction(createInvoke({ hostId: 'host-1', unitId: 'nginx.service', action: 'restart', warnings: [] }, calls), { sessionId: 'session-1', hostId: 'host-1', unitId: 'nginx.service', action: 'restart' }))
      .resolves.toMatchObject({ action: 'restart' })
    await expect(invokeServerOpsLogStart(createInvoke({ hostId: 'host-1', streamId: 'stream-1' }, calls), { hostId: 'host-1', source: { kind: 'system' }, since: '15m', priority: 'info', tailLines: 100 }))
      .resolves.toEqual({ hostId: 'host-1', streamId: 'stream-1' })
    await expect(invokeServerOpsLogStop(createInvoke(undefined, calls), { hostId: 'host-1', streamId: 'stream-1' })).resolves.toBeUndefined()
    await expect(invokeServerOpsLogAck(createInvoke(undefined, calls), { hostId: 'host-1', streamId: 'stream-1', sequence: 1 })).resolves.toBeUndefined()
    await expect(invokeServerOpsLogExport(createInvoke({ saved: false }, calls), { hostId: 'host-1', content: 'line' })).resolves.toEqual({ saved: false })
    expect(calls.map((call) => call.channel)).toEqual([
      SERVER_OPS_IPC_CHANNELS.GET_OVERVIEW,
      SERVER_OPS_IPC_CHANNELS.LIST_SERVICES,
      SERVER_OPS_IPC_CHANNELS.GET_SERVICE_DETAIL,
      SERVER_OPS_IPC_CHANNELS.RUN_SERVICE_ACTION,
      SERVER_OPS_IPC_CHANNELS.START_LOG_STREAM,
      SERVER_OPS_IPC_CHANNELS.STOP_LOG_STREAM,
      SERVER_OPS_IPC_CHANNELS.ACK_LOG_OUTPUT,
      SERVER_OPS_IPC_CHANNELS.EXPORT_LOG,
    ])
  })

  test('main 返回或事件夹带内部连接字段时 fail closed', async () => {
    const calls: Array<{ channel: string; input: unknown }> = []
    await expect(invokeServerOpsLogStart(createInvoke({ hostId: 'host-1', streamId: 'stream-1', connectionId: 'secret' }, calls), { hostId: 'host-1', source: { kind: 'system' }, since: '15m', priority: 'info', tailLines: 100 }))
      .rejects.toThrow('SERVER_OPS_LOG_START_RESULT_INVALID')

    const bridge = createEventBridge()
    let delivered = 0
    subscribeServerOpsLogOutput(bridge, () => { delivered += 1 })
    expect(() => bridge.emit(SERVER_OPS_IPC_CHANNELS.LOG_OUTPUT, { hostId: 'host-1', streamId: 'stream-1', sequence: 1, data: 'x', generation: 1 })).not.toThrow()
    expect(delivered).toBe(0)
    expect(() => bridge.emit(SERVER_OPS_IPC_CHANNELS.LOG_OUTPUT, { hostId: 'host-1', streamId: 'stream-1', sequence: 2, data: 'valid' })).not.toThrow()
    expect(delivered).toBe(1)
  })

  test('订阅使用同一包装 listener 精确清理且回调异常不阻断其它订阅', () => {
    const bridge = createEventBridge()
    const received: string[] = []
    const disposeThrowing = subscribeServerOpsLogOutput(bridge, () => { throw new Error('renderer-listener-failed') })
    const disposeOutput = subscribeServerOpsLogOutput(bridge, (event) => { received.push(event.data) })
    const disposeExit = subscribeServerOpsLogExit(bridge, (event) => { received.push(event.reason) })

    expect(() => bridge.emit(SERVER_OPS_IPC_CHANNELS.LOG_OUTPUT, { hostId: 'host-1', streamId: 'stream-1', sequence: 1, data: 'ok' })).not.toThrow()
    bridge.emit(SERVER_OPS_IPC_CHANNELS.LOG_EXIT, { hostId: 'host-1', streamId: 'stream-1', reason: 'stopped' })
    expect(received).toEqual(['ok', 'stopped'])
    disposeThrowing()
    disposeOutput()
    disposeOutput()
    disposeExit()
    expect(bridge.listenerCount()).toBe(0)
  })
})

/** 创建最小 Electron 事件桥，验证精确 listener 身份。 */
function createEventBridge() {
  const listeners = new Map<string, Set<(event: unknown, payload: unknown) => void>>()
  return {
    on(channel: string, listener: (event: unknown, payload: unknown) => void): void {
      const entries = listeners.get(channel) ?? new Set()
      entries.add(listener)
      listeners.set(channel, entries)
    },
    removeListener(channel: string, listener: (event: unknown, payload: unknown) => void): void {
      listeners.get(channel)?.delete(listener)
    },
    emit(channel: string, payload: unknown): void {
      for (const listener of listeners.get(channel) ?? []) listener({}, payload)
    },
    listenerCount(): number {
      return [...listeners.values()].reduce((count, entries) => count + entries.size, 0)
    },
  }
}
