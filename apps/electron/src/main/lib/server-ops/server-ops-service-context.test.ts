import { afterEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import type { ServerOpsServiceContext } from './server-ops-service-context'
import {
  clearServerOpsServiceContext,
  disposeServerOpsBeforeQuit,
  disposeServerOpsLifecycle,
  getServerOpsServiceContext,
  registerServerOpsBeforeQuitBarrier,
  registerServerOpsServiceContext,
} from './server-ops-service-context'

/** 创建仅用于验证引用身份的服务上下文。 */
function createContext(): ServerOpsServiceContext {
  return {} as ServerOpsServiceContext
}

describe('Server Ops 共享服务上下文', () => {
  afterEach(async () => {
    await clearServerOpsServiceContext()
  })

  test('未初始化时返回 null，注册后读取同一引用', () => {
    expect(getServerOpsServiceContext()).toBeNull()
    const context = createContext()

    registerServerOpsServiceContext(context)

    expect(getServerOpsServiceContext()).toBe(context)
  })

  test('旧注册的 dispose 不会清理新代次复用的连接实例', async () => {
    /** 模拟两代 context 复用应用级唯一 connection singleton。 */
    const calls: string[] = []
    const connections = { dispose: () => { calls.push('connections') } }
    const first = { ...createContext(), connections } as unknown as ServerOpsServiceContext
    const second = { ...createContext(), connections } as unknown as ServerOpsServiceContext
    const firstRegistration = registerServerOpsServiceContext(first)
    const secondRegistration = registerServerOpsServiceContext(second)

    await Promise.resolve()
    await firstRegistration.dispose()
    expect(getServerOpsServiceContext()).toBe(second)
    expect(calls).toEqual([])

    await secondRegistration.dispose()
    expect(getServerOpsServiceContext()).toBeNull()
    expect(calls).toEqual(['connections'])
  })

  test('普通 Agent 会话删除成功后撤销对应服务器授权', () => {
    const source = readFileSync(new URL('../../ipc.ts', import.meta.url), 'utf8')
    const handlerStart = source.indexOf('AGENT_IPC_CHANNELS.DELETE_SESSION')
    const deleteCall = source.indexOf('deleteAgentSession(id)', handlerStart)
    const revokeCall = source.indexOf('serverOpsIpcRegistration.revokeSession(id)', deleteCall)

    expect(handlerStart).toBeGreaterThan(-1)
    expect(deleteCall).toBeGreaterThan(handlerStart)
    expect(revokeCall).toBeGreaterThan(deleteCall)
  })

  test('唯一服务上下文、systemd 与 IPC 共用同一个审计 Store 实例', () => {
    const source = readFileSync(new URL('../../ipc.ts', import.meta.url), 'utf8')
    expect(source).toContain('const serverOpsAuditStore = new ServerOpsAuditStore(undefined, { requirePreparedSchema: true })')
    expect(source).toContain('prepareForWrites: () => serverOpsAuditStore.prepareForWrites(acquireServerOpsMutationGuard)')
    expect(source.match(/audit: serverOpsAudit,/g)).toHaveLength(7)
  })

  test('上下文携带唯一观测服务并按日志先于连接的顺序幂等释放', async () => {
    const calls: string[] = []
    const context = {
      overview: { getOverview: async () => ({}) },
      systemd: { listServices: async () => ({}), getServiceDetail: async () => ({}), runAction: async () => ({}) },
      logs: { dispose: () => { calls.push('logs') } },
      connections: { dispose: () => { calls.push('connections') } },
    } as unknown as ServerOpsServiceContext

    const registration = registerServerOpsServiceContext(context)
    expect(getServerOpsServiceContext()?.overview).toBe(context.overview)
    expect(getServerOpsServiceContext()?.systemd).toBe(context.systemd)
    expect(getServerOpsServiceContext()?.logs).toBe(context.logs)

    await registration.dispose()
    await registration.dispose()
    expect(calls).toEqual(['logs', 'connections'])
    expect(getServerOpsServiceContext()).toBeNull()
  })

  test('clear 等待传输与文件句柄后关闭连接，异步失败仍继续全部清理', async () => {
    const calls: string[] = []
    /** 两个异步闸门用于证明连接不会提前释放。 */
    let resolveTransfer: (() => void) | undefined
    let resolveLeases: (() => void) | undefined
    const context = {
      transfers: { dispose: async () => { calls.push('transfers'); await new Promise<void>((resolve) => { resolveTransfer = resolve }); throw new Error('TRANSFER_DISPOSE_FAILED') } },
      fileLeases: { dispose: async () => { calls.push('leases'); await new Promise<void>((resolve) => { resolveLeases = resolve }) } },
      logs: { dispose: () => { calls.push('logs') } },
      connections: { dispose: () => { calls.push('connections') } },
    } as unknown as ServerOpsServiceContext
    registerServerOpsServiceContext(context)

    const clearing = clearServerOpsServiceContext()
    expect(getServerOpsServiceContext()).toBeNull()
    expect(calls).toEqual(['logs', 'transfers', 'leases'])
    resolveTransfer?.()
    await Promise.resolve()
    expect(calls).not.toContain('connections')
    resolveLeases?.()
    await expect(clearing).rejects.toThrow('TRANSFER_DISPOSE_FAILED')
    expect(calls).toEqual(['logs', 'transfers', 'leases', 'connections'])
    await expect(clearServerOpsServiceContext()).resolves.toBeUndefined()
  })

  test('main 组合清理中 IPC 与 context 失败仍按序关闭 runtime 且重复调用复用同一结果', async () => {
    const calls: string[] = []
    const dispose = disposeServerOpsLifecycle(
      () => { calls.push('ipc'); throw new Error('IPC_DISPOSE_FAILED') },
      async () => { calls.push('context'); throw new Error('CONTEXT_DISPOSE_FAILED') },
      () => { calls.push('runtime') },
    )

    const first = dispose()
    expect(dispose()).toBe(first)
    await expect(first).rejects.toThrow('IPC_DISPOSE_FAILED')
    expect(calls).toEqual(['ipc', 'context', 'runtime'])
  })

  test('旧 lifecycle 迟到清理时不会停止已转交新代的 runtime singleton', async () => {
    const calls: string[] = []
    const firstRegistration = registerServerOpsServiceContext(createContext())
    const firstLifecycle = disposeServerOpsLifecycle(
      () => { calls.push('ipc:first') },
      firstRegistration.dispose,
      () => { calls.push('runtime:first') },
      firstRegistration.ownsRuntime,
    )
    const secondRegistration = registerServerOpsServiceContext(createContext())

    await firstLifecycle()
    expect(calls).toEqual(['ipc:first'])
    expect(getServerOpsServiceContext()).not.toBeNull()

    const secondLifecycle = disposeServerOpsLifecycle(
      () => { calls.push('ipc:second') },
      secondRegistration.dispose,
      () => { calls.push('runtime:second') },
      secondRegistration.ownsRuntime,
    )
    await secondLifecycle()
    expect(calls).toEqual(['ipc:first', 'ipc:second', 'runtime:second'])
  })

  test('旧 context 等待传输期间注册新代时不会迟到关闭新代复用的 connection', async () => {
    const calls: string[] = []
    /** 模拟旧代传输清理仍在等待。 */
    let resolveTransfer: (() => void) | undefined
    const connections = { dispose: () => { calls.push('connections') } }
    const first = {
      ...createContext(),
      connections,
      transfers: { dispose: async () => { await new Promise<void>((resolve) => { resolveTransfer = resolve }) } },
    } as unknown as ServerOpsServiceContext
    const second = { ...createContext(), connections } as unknown as ServerOpsServiceContext
    const firstRegistration = registerServerOpsServiceContext(first)

    const firstDisposal = firstRegistration.dispose()
    const secondRegistration = registerServerOpsServiceContext(second)
    resolveTransfer?.()
    await firstDisposal
    expect(calls).toEqual([])

    await secondRegistration.dispose()
    expect(calls).toEqual(['connections'])
  })

  test('before-quit 阻止首次退出并在异步清理失败后仍恢复退出', async () => {
    const calls: string[] = []
    const errors: unknown[] = []
    /** 首次 before-quit 的最小事件边界。 */
    const event = { preventDefault: () => { calls.push('prevent') } }

    await disposeServerOpsBeforeQuit(
      event,
      async () => { calls.push('server-ops'); throw new Error('SERVER_OPS_DISPOSE_FAILED') },
      () => { calls.push('quit') },
      (error) => { errors.push(error); throw new Error('REPORT_FAILED') },
    )

    expect(calls).toEqual(['prevent', 'server-ops', 'quit'])
    expect(errors).toHaveLength(1)
  })

  test('before-quit 注册屏障持续拦截在途重复退出，终态解绑后只恢复一次 quit', async () => {
    const calls: string[] = []
    /** 控制首次异步清理何时结束。 */
    let resolveCleanup: (() => void) | undefined
    /** 模拟 Electron App 的真实 listener 注册、解绑与退出入口。 */
    const listeners: Array<(event: { preventDefault(): void }) => void> = []
    const application = {
      prependListener: (_eventName: 'before-quit', nextListener: (event: { preventDefault(): void }) => void) => {
        calls.push('register')
        listeners.push(nextListener)
      },
      removeListener: (_eventName: 'before-quit', registeredListener: (event: { preventDefault(): void }) => void) => {
        calls.push('remove')
        const index = listeners.indexOf(registeredListener)
        if (index >= 0) listeners.splice(index, 1)
      },
      quit: () => { calls.push('quit') },
    }
    registerServerOpsBeforeQuitBarrier(
      application,
      async () => { calls.push('cleanup'); await new Promise<void>((resolve) => { resolveCleanup = resolve }) },
      () => { calls.push('error') },
    )
    /** 分别模拟首次退出与清理期间的重复退出事件。 */
    const firstEvent = { preventDefault: () => { calls.push('prevent:first') } }
    const repeatedEvent = { preventDefault: () => { calls.push('prevent:repeated') } }

    const registeredListener = listeners[0]
    if (!registeredListener) throw new Error('before-quit listener 未注册')
    registeredListener(firstEvent)
    registeredListener(repeatedEvent)
    expect(calls).toEqual(['register', 'prevent:first', 'cleanup', 'prevent:repeated'])
    resolveCleanup?.()
    await Promise.resolve()
    await Promise.resolve()
    expect(calls).toEqual(['register', 'prevent:first', 'cleanup', 'prevent:repeated', 'remove', 'quit'])
    expect(listeners).toHaveLength(0)

    registeredListener(repeatedEvent)
    expect(calls).toEqual(['register', 'prevent:first', 'cleanup', 'prevent:repeated', 'remove', 'quit'])
  })

  test('main 先完成 IPC 注册再发布 context，初始化失败按日志、连接顺序收口', () => {
    const source = readFileSync(new URL('../../ipc.ts', import.meta.url), 'utf8')
    const ipcRegistration = source.indexOf('registerServerOpsIpcHandlers({')
    const contextRegistration = source.indexOf('registerServerOpsServiceContext({')
    const initializationCatch = source.indexOf('Server Ops 初始化失败时', ipcRegistration)
    const logDispose = source.indexOf('serverOpsLogService.dispose()', initializationCatch)
    const connectionDispose = source.indexOf('serverOpsConnectionService.dispose()', initializationCatch)

    expect(ipcRegistration).toBeGreaterThan(-1)
    expect(contextRegistration).toBeGreaterThan(ipcRegistration)
    expect(initializationCatch).toBeGreaterThan(contextRegistration)
    expect(logDispose).toBeGreaterThan(initializationCatch)
    expect(connectionDispose).toBeGreaterThan(logDispose)
    expect(source).toContain('disposeServerOpsLifecycle(')
    expect(source).toContain('() => { serverOpsRuntimeClient.stop() }')
    expect(source).toContain('registerServerOpsBeforeQuitBarrier(')
    expect(source).toContain('serverOpsLifecycle.dispose,')
    expect(source).toContain("console.error('[Server Ops] IPC 初始化回滚失败:', cleanupError)")
    expect(source).toContain("console.error('[Server Ops] 日志服务初始化回滚失败:', cleanupError)")
    expect(source).toContain("console.error('[Server Ops] 连接服务初始化回滚失败:', cleanupError)")
    expect(source).toContain("console.error('[Server Ops] 退出清理失败:', error)")
    const indexSource = readFileSync(new URL('../../index.ts', import.meta.url), 'utf8')
    expect(indexSource).not.toContain("{ name: '服务器运维 SSH 进程', run: () => { serverOpsRuntimeClient.stop() } }")
  })
})
