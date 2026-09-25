import { safeStorage } from 'electron'
import type { ApiRunChanged, ApiRunStreamChanged } from '@proma/shared'
import { ApiWorkbenchService } from './api-workbench-service'
import { ApiWorkbenchStore } from './api-workbench-store'
import { createApiWorkbenchLifecycle } from './api-workbench-lifecycle'
import { apiRuntimeClient } from './api-runtime-client'

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
  return lifecycle.get()
}
/**
 * 普通运行进程共享一个调度服务；初次打开工作台前不创建文件或子进程。
 *
 * 关闭语义交给 lifecycle：退出清理跑过但应用没退出（用户取消退出 / macOS 只关窗）时，
 * 下一次调用会重建服务，而不是让接口与流程功能在这个进程里永久报 SHUTTING_DOWN。
 */
const lifecycle = createApiWorkbenchLifecycle<ApiWorkbenchService>({
  create: () => new ApiWorkbenchService({
    store: new ApiWorkbenchStore(undefined, { safeStorage }),
    transport: (request, options) => apiRuntimeClient.run(request, options),
    onChanged: (event) => eventSink?.(event),
    onStream: (event) => streamSink?.(event),
  }),
  dispose: (service) => Promise.all([service.shutdown(), apiRuntimeClient.shutdown()]).then(() => undefined),
  onRebuild: () => {
    /** 这条日志是排查「接口打不开」时最先要看的一行：说明上次退出没有真正完成。 */
    console.warn('[接口工作台] 检测到上次退出未完成，已重建服务；接口与流程功能恢复可用')
  },
})
/** 不触发服务初始化的迁移忙碌查询。 */
export function hasActiveApiWorkbenchRequests(): boolean {
  /** 只读现有实例：迁移查询不能顺手创建服务，也不该在退出途中拉起子进程。 */
  return lifecycle.current()?.hasActiveRequests() ?? false
}
/** 退出时同步发出中止，再等待 service 结算与 Utility 真正退出。 */
export function shutdownApiWorkbench(): Promise<void> | undefined {
  return lifecycle.shutdown()
}
