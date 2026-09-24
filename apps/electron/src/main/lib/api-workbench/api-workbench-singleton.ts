import { safeStorage } from 'electron'
import type { ApiRunChanged, ApiRunStreamChanged } from '@proma/shared'
import { ApiWorkbenchService } from './api-workbench-service'
import { ApiWorkbenchStore } from './api-workbench-store'
import { apiRuntimeClient } from './api-runtime-client'

/** 普通运行进程共享一个调度服务；初次打开工作台前不创建文件或子进程。 */
let service: ApiWorkbenchService | undefined
/** 退出屏障启动后拒绝新请求；重复退出沿用同一个等待。 */
let closing = false
let shutdownPromise: Promise<void> | undefined
/** 只由受信主窗口注册事件接收者，事件本身不携带正文。 */
let eventSink: ((event: ApiRunChanged) => void) | undefined
/** 流式事件接收者与状态事件共用主窗口，只是通道不同。 */
let streamSink: ((event: ApiRunStreamChanged) => void) | undefined
/** IPC 装配时绑定受信窗口的轻量事件广播。 */
export function setApiWorkbenchEventSink(sink: (event: ApiRunChanged) => void): void { eventSink = sink }
/** IPC 装配时绑定流式事件广播；未注册时事件仍会写入运行记录。 */
export function setApiWorkbenchStreamSink(sink: (event: ApiRunStreamChanged) => void): void { streamSink = sink }
/** 返回唯一服务；秘密由系统安全存储保护，不可用时 Store 显式退化为内存记录。 */
export function getApiWorkbenchService(): ApiWorkbenchService {
  if (closing) throw new Error('API_WORKBENCH_SHUTTING_DOWN')
  if (!service) service = new ApiWorkbenchService({
    store: new ApiWorkbenchStore(undefined, { safeStorage }),
    transport: (request, options) => apiRuntimeClient.run(request, options),
    onChanged: (event) => eventSink?.(event),
    onStream: (event) => streamSink?.(event),
  })
  return service
}
/** 不触发服务初始化的迁移忙碌查询。 */
export function hasActiveApiWorkbenchRequests(): boolean { return service?.hasActiveRequests() ?? false }
/** 退出时同步发出中止，再等待 service 结算与 Utility 真正退出。 */
export function shutdownApiWorkbench(): Promise<void> | undefined {
  if (closing) return shutdownPromise
  closing = true
  if (!service) return undefined
  shutdownPromise = Promise.all([service.shutdown(), apiRuntimeClient.shutdown()]).then(() => {
    eventSink = undefined
    streamSink = undefined
  })
  return shutdownPromise
}
