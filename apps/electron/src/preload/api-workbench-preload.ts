import { API_WORKBENCH_CHANNELS, parseApiCommand, parseApiResponse, parseApiRunChanged, parseApiRunStreamChanged } from '@proma/shared'
import type { ApiWorkbenchApi, ApiCommandInputs, ApiCommandMethod, ApiCommandResults } from '@proma/shared'

/** 隔离的 IPC 调用入口，测试无需加载 Electron。 */
export type ApiWorkbenchInvoke = (channel: string, command: unknown) => Promise<unknown>
/** 订阅入口返回清理函数；原始事件只能经过 parser 后进入 Renderer。 */
export type ApiWorkbenchSubscribe = (channel: string, listener: (value: unknown) => void) => () => void

/** 组装接口工作台桥接，参数与返回均进行运行时验证。 */
export function createApiWorkbenchPreload(invoke: ApiWorkbenchInvoke, subscribe: ApiWorkbenchSubscribe): ApiWorkbenchApi {
  /** 单一通道保持方法和返回类型关联。 */
  const call = async <M extends ApiCommandMethod>(method: M, input: ApiCommandInputs[M]): Promise<ApiCommandResults[M]> => {
    const command = parseApiCommand({ method, input })
    return parseApiResponse(method, await invoke(API_WORKBENCH_CHANNELS.INVOKE, command))
  }
  return {
    getCatalog: (input) => call('getCatalog', input),
    saveCatalog: (input) => call('saveCatalog', input),
    prepare: (input) => call('prepare', input),
    send: (input) => call('send', input),
    cancel: (input) => call('cancel', input),
    listRuns: (input) => call('listRuns', input),
    getRun: (input) => call('getRun', input),
    readBody: (input) => call('readBody', input),
    pinRun: (input) => call('pinRun', input),
    getRuntimeVariables: (input) => call('getRuntimeVariables', input),
    clearRuntimeVariables: (input) => call('clearRuntimeVariables', input),
    onChanged: (callback) => subscribe(API_WORKBENCH_CHANNELS.CHANGED, (value) => { callback(parseApiRunChanged(value)) }),
    /** 流式事件同样先过 parser；损坏消息直接丢弃，不进入渲染层。 */
    onStream: (callback) => subscribe(API_WORKBENCH_CHANNELS.STREAM, (value) => {
      try {
        callback(parseApiRunStreamChanged(value))
      } catch {
        // 主进程广播损坏时保持静默，避免把未知对象送进界面状态。
      }
    }),
  }
}
