import { afterEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import type { ServerOpsServiceContext } from './server-ops-service-context'
import {
  clearServerOpsServiceContext,
  disposeServerOpsBeforeQuit,
  disposeServerOpsLifecycle,
  getServerOpsServiceContext,
  registerServerOpsServiceContext,
} from './server-ops-service-context'

/** 创建仅用于验证引用身份的服务上下文。 */
function createContext(): ServerOpsServiceContext {
  return {} as ServerOpsServiceContext
}

describe('Server Ops 共享服务上下文', () => {
  afterEach(() => {
    clearServerOpsServiceContext()
  })

  test('未初始化时返回 null，注册后读取同一引用', () => {
    expect(getServerOpsServiceContext()).toBeNull()
    const context = createContext()

    registerServerOpsServiceContext(context)

    expect(getServerOpsServiceContext()).toBe(context)
  })

  test('旧注册的 dispose 不会清理新代次', () => {
    const first = createContext()
    const second = createContext()
    const disposeFirst = registerServerOpsServiceContext(first)
    const disposeSecond = registerServerOpsServiceContext(second)

    disposeFirst()
    expect(getServerOpsServiceContext()).toBe(second)

    disposeSecond()
    expect(getServerOpsServiceContext()).toBeNull()
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
    expect(source).toContain('const serverOpsAuditStore = new ServerOpsAuditStore()')
    expect(source.match(/audit: serverOpsAuditStore/g)).toHaveLength(3)
  })

  test('上下文携带唯一观测服务并按日志先于连接的顺序幂等释放', () => {
    const calls: string[] = []
    const context = {
      overview: { getOverview: async () => ({}) },
      systemd: { listServices: async () => ({}), getServiceDetail: async () => ({}), runAction: async () => ({}) },
      logs: { dispose: () => { calls.push('logs') } },
      connections: { dispose: () => { calls.push('connections') } },
    } as unknown as ServerOpsServiceContext

    const dispose = registerServerOpsServiceContext(context)
    expect(getServerOpsServiceContext()?.overview).toBe(context.overview)
    expect(getServerOpsServiceContext()?.systemd).toBe(context.systemd)
    expect(getServerOpsServiceContext()?.logs).toBe(context.logs)

    dispose()
    dispose()
    expect(calls).toEqual(['logs', 'connections'])
    expect(getServerOpsServiceContext()).toBeNull()
  })

  test('clear 先摘除 context，logs 释放失败仍释放 connection 且重复 clear 无副作用', () => {
    const calls: string[] = []
    const context = {
      logs: { dispose: () => { calls.push('logs'); throw new Error('LOG_DISPOSE_FAILED') } },
      connections: { dispose: () => { calls.push('connections') } },
    } as unknown as ServerOpsServiceContext
    registerServerOpsServiceContext(context)

    expect(() => clearServerOpsServiceContext()).toThrow('LOG_DISPOSE_FAILED')
    expect(getServerOpsServiceContext()).toBeNull()
    expect(() => clearServerOpsServiceContext()).not.toThrow()
    expect(calls).toEqual(['logs', 'connections'])
  })

  test('main 组合清理中 IPC dispose 失败仍清理 context 且重复调用无副作用', () => {
    const calls: string[] = []
    const dispose = disposeServerOpsLifecycle(
      () => { calls.push('ipc'); throw new Error('IPC_DISPOSE_FAILED') },
      () => { calls.push('context') },
    )

    expect(() => dispose()).toThrow('IPC_DISPOSE_FAILED')
    expect(() => dispose()).not.toThrow()
    expect(calls).toEqual(['ipc', 'context'])
  })

  test('before-quit 边界记录清理异常且不阻断后续全局 listener', () => {
    const calls: string[] = []
    const errors: unknown[] = []
    const serverOpsListener = (): void => {
      disposeServerOpsBeforeQuit(
        () => { calls.push('server-ops'); throw new Error('SERVER_OPS_DISPOSE_FAILED') },
        (error) => { errors.push(error) },
      )
    }
    const laterListener = (): void => { calls.push('later-listener') }

    expect(() => serverOpsListener()).not.toThrow()
    expect(() => laterListener()).not.toThrow()
    expect(calls).toEqual(['server-ops', 'later-listener'])
    expect(errors).toHaveLength(1)
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
    expect(source).toContain("console.error('[Server Ops] IPC 初始化回滚失败:', cleanupError)")
    expect(source).toContain("console.error('[Server Ops] 日志服务初始化回滚失败:', cleanupError)")
    expect(source).toContain("console.error('[Server Ops] 连接服务初始化回滚失败:', cleanupError)")
    expect(source).toContain("console.error('[Server Ops] 退出清理失败:', error)")
  })
})
