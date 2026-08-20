/** 延迟创建 Bridge 命令处理器所需的纯依赖。 */
export interface LazyBridgeCommandHandlerDependencies<TBindingStore, TCommandHandler> {
  /** 首次业务调用时创建聊天绑定存储。 */
  createBindingStore: () => TBindingStore
  /** 使用同一次创建的绑定存储构造命令处理器。 */
  createCommandHandler: (bindingStore: TBindingStore) => TCommandHandler
}

/** 延迟命令处理器，模块构造阶段不会访问数据根。 */
export interface LazyBridgeCommandHandler<TCommandHandler> {
  /** 首次调用时创建并缓存命令处理器。 */
  get: () => TCommandHandler
  /** 只查看已创建实例，不触发任何路径或存储访问。 */
  peek: () => TCommandHandler | null
}

/** 创建可注入、可独立测试的 Bridge 命令处理器懒加载容器。 */
export function createLazyBridgeCommandHandler<TBindingStore, TCommandHandler>(
  dependencies: LazyBridgeCommandHandlerDependencies<TBindingStore, TCommandHandler>,
): LazyBridgeCommandHandler<TCommandHandler> {
  /** 缓存首次业务调用创建的命令处理器。 */
  let commandHandler: TCommandHandler | null = null

  return {
    get: () => {
      if (commandHandler !== null) return commandHandler
      /** binding store 与 handler 在同一首次业务调用中成对创建。 */
      const bindingStore = dependencies.createBindingStore()
      commandHandler = dependencies.createCommandHandler(bindingStore)
      return commandHandler
    },
    peek: () => commandHandler,
  }
}
