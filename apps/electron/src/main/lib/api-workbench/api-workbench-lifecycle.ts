/**
 * 接口工作台服务的生命周期：可创建、可优雅关闭、**关闭未真正退出时可重建**。
 *
 * 为什么要重建：退出流程会先跑清理（停子进程、关服务），再由窗口决定是否真的退出；
 * 用户在「Agent 还在运行，确认退出吗」里点取消、或 macOS 只关窗口不退出时，清理已经跑过、
 * 应用却继续活着。旧实现把「已清理」当成永久状态，于是整个进程里接口工作台只能报
 * `API_WORKBENCH_SHUTTING_DOWN`（运维面板同时半死），必须重启客户端才能恢复。
 * 这里的规则是：**关闭已经结算、却还有人调用 → 说明应用没退出，直接重建一份新服务**；
 * 关闭仍在进行中时依旧 fail closed，避免退出途中又拉起子进程。
 */

export interface ApiWorkbenchLifecycle<T> {
  /** 取当前服务：未创建则创建；关闭已结算则重建；关闭进行中则抛错。 */
  get(): T
  /** 只看不建：查询类调用（例如迁移忙碌检查）用它，避免顺手拉起存储与子进程。 */
  current(): T | undefined
  /** 关闭服务；重复调用复用同一个等待，服务不存在时立即结算。 */
  shutdown(): Promise<void> | undefined
  /** 当前是否处于「已关闭且尚未重建」状态，供诊断与测试。 */
  isClosed(): boolean
}

export interface ApiWorkbenchLifecycleOptions<T> {
  /** 创建服务（真实实现里会懒加载存储与子进程客户端）。 */
  create: () => T
  /** 关闭服务；抛错也必须让内部状态结算，调用方据此决定是否重建。 */
  dispose: (service: T) => Promise<void>
  /** 重建时的诊断回调（日志），便于在客户端日志里看到「上次退出没完成」。 */
  onRebuild?: () => void
}

export function createApiWorkbenchLifecycle<T>(options: ApiWorkbenchLifecycleOptions<T>): ApiWorkbenchLifecycle<T> {
  let service: T | undefined
  let closing = false
  /** 关闭是否已经结算；只有结算过的关闭才允许被下一次调用重建。 */
  let settled = false
  let shutdownPromise: Promise<void> | undefined
  return {
    get(): T {
      if (closing && settled) {
        options.onRebuild?.()
        closing = false
        settled = false
        shutdownPromise = undefined
      }
      if (closing) throw new Error('API_WORKBENCH_SHUTTING_DOWN')
      if (!service) service = options.create()
      return service
    },
    current(): T | undefined { return service },
    shutdown(): Promise<void> | undefined {
      if (closing) return shutdownPromise
      closing = true
      if (!service) {
        settled = true
        return undefined
      }
      const pending = service
      service = undefined
      shutdownPromise = options.dispose(pending)
        .catch(() => undefined)
        .then(() => { settled = true })
      return shutdownPromise
    },
    isClosed(): boolean { return closing },
  }
}
