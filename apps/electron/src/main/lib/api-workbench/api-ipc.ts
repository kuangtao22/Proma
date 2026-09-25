import { API_WORKBENCH_CHANNELS, parseApiCommand, parseApiResponse } from '@proma/shared'
import type { ApiWorkbenchService } from './api-workbench-service'

/** IPC 只需要发送方身份，不向业务层暴露 Electron 句柄。 */
export interface ApiIpcEvent { sender: { id: number } }
/** 服务对象由生产 singleton 或测试夹具提供。 */
export interface ApiIpcDependencies {
  ipc: { handle(channel: string, listener: (event: ApiIpcEvent, input: unknown) => Promise<unknown>): void; removeHandler(channel: string): void }
  service: Pick<ApiWorkbenchService, 'getCatalog' | 'saveCatalog' | 'prepare' | 'send' | 'cancel' | 'listRuns' | 'getRun' | 'readBody' | 'pinRun' | 'getRuntimeVariables' | 'clearRuntimeVariables' | 'getCookieJar' | 'clearCookieJar' | 'registerPickedFiles' | 'prepareScenario' | 'runScenario' | 'cancelScenario' | 'listScenarioRuns' | 'getScenarioRun'>
  /**
   * 原生文件对话框由主进程打开；这是全流程唯一接受路径字符串的入口，
   * 渲染层与模型都只能拿到文件引用与元数据。
   */
  pickFilePaths?(event: ApiIpcEvent): Promise<string[]>
  isAuthorizedSender(event: ApiIpcEvent): boolean
  requireSession(sessionId: string): { id: string; workspaceId: string }
  assertWorkspaceWritable?(workspaceId: string): void
  runWorkspaceWrite?<T>(workspaceId: string, effect: () => T): T
}
/** 只向应用自身窗口注册接口工作台；每次调用 fresh-read 会话归属。 */
export function registerApiWorkbenchIpc(dependencies: ApiIpcDependencies): { dispose(): void } {
  dependencies.ipc.handle(API_WORKBENCH_CHANNELS.INVOKE, async (event, value) => {
    if (!dependencies.isAuthorizedSender(event)) throw new Error('API_ACCESS_DENIED')
    const command = parseApiCommand(value)
    const session = dependencies.requireSession(command.input.sessionId)
    const context = { workspaceId: session.workspaceId, sessionId: session.id, source: 'manual' as const }
    if (['saveCatalog', 'send', 'pinRun', 'runScenario', 'cancelScenario'].includes(command.method)) dependencies.assertWorkspaceWritable?.(context.workspaceId)
    /** IPC 等待结束后再次验证窗口与会话，禁止迟到结果进入新的所有权范围。 */
    const assertCurrent = (): void => {
      if (!dependencies.isAuthorizedSender(event)) throw new Error('API_ACCESS_DENIED')
      const current = dependencies.requireSession(context.sessionId)
      if (current.workspaceId !== context.workspaceId) throw new Error('API_SCOPE_CHANGED')
    }
    /** 网络与落盘全过程持有现有迁移写租约，避免预检后迁移插入。 */
    const write = <T>(effect: () => T): T => dependencies.runWorkspaceWrite ? dependencies.runWorkspaceWrite(context.workspaceId, effect) : effect()
    const service = dependencies.service
    let result: unknown
    switch (command.method) {
      case 'getCatalog': result = await service.getCatalog(context.workspaceId); break
      case 'saveCatalog': result = await write(() => service.saveCatalog(context.workspaceId, command.input.expectedRevision, command.input.catalog)); break
      case 'prepare': result = await service.prepare(context, command.input); break
      case 'send': result = await write(() => service.send(context, command.input.preparedId)); break
      case 'cancel': await service.cancel(context, command.input.preparedId); result = undefined; break
      case 'listRuns': result = await service.listRuns(context, command.input); break
      case 'getRun': result = await service.getRun(context, command.input.runId, command.input.reveal ?? false); break
      case 'readBody': result = await service.readBody(context, command.input.runId, command.input); break
      case 'pinRun': result = await write(() => service.pinRun(context, command.input.runId, command.input.pinned)); break
      case 'getRuntimeVariables': result = { variables: service.getRuntimeVariables(context.workspaceId) }; break
      case 'clearRuntimeVariables': result = { cleared: service.clearRuntimeVariables(context.workspaceId) }; break
      case 'getCookieJar': result = { cookies: service.getCookieJar(context.workspaceId) }; break
      case 'clearCookieJar': result = { cleared: service.clearCookieJar(context.workspaceId) }; break
      case 'pickApiFiles': {
        /** 用户在对话框里取消时返回空列表，不制造任何引用。 */
        const paths = dependencies.pickFilePaths ? await dependencies.pickFilePaths(event) : []
        result = { files: service.registerPickedFiles(context.workspaceId, paths) }
        break
      }
      /** 流程：准备只出步骤清单；运行/取消沿用同一条写租约；列表与读取是查询。 */
      case 'prepareScenario': result = await service.prepareScenario(context, command.input); break
      case 'runScenario': result = await write(() => service.runScenario(context, command.input.preparedId)); break
      case 'cancelScenario': await service.cancelScenario(context, command.input.preparedId); result = undefined; break
      case 'listScenarioRuns': result = await service.listScenarioRuns(context, command.input); break
      case 'getScenarioRun': result = await service.getScenarioRun(context, command.input.scenarioRunId); break
    }
    assertCurrent()
    return parseApiResponse(command.method, result)
  })
  return { dispose: () => dependencies.ipc.removeHandler(API_WORKBENCH_CHANNELS.INVOKE) }
}
