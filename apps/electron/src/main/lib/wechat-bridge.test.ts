import { expect, test } from 'bun:test'
import { createLazyBridgeCommandHandler } from './lazy-bridge-command-handler'

test('Given 微信 Bridge 尚未处理业务 When 构造懒加载处理器 Then 不读取路径或创建 binding store', () => {
  /** 记录 binding store 工厂的实际调用次数。 */
  let bindingStoreCreations = 0
  const lazyHandler = createLazyBridgeCommandHandler({
    createBindingStore: () => {
      bindingStoreCreations += 1
      return { path: '/offline/Proma Data/wechat-bindings.json' }
    },
    createCommandHandler: (bindingStore) => ({ bindingStore }),
  })

  expect(bindingStoreCreations).toBe(0)
  expect(lazyHandler.peek()).toBeNull()
})

test('Given 微信 Bridge 首次处理业务 When 获取命令处理器 Then 仅创建一次 binding store 并复用处理器', () => {
  /** 首次 get 触发业务依赖，后续 get 必须复用同一实例。 */
  let bindingStoreCreations = 0
  const lazyHandler = createLazyBridgeCommandHandler({
    createBindingStore: () => {
      bindingStoreCreations += 1
      return { path: '/active/Proma Data/wechat-bindings.json' }
    },
    createCommandHandler: (bindingStore) => ({ bindingStore }),
  })

  const first = lazyHandler.get()
  const second = lazyHandler.get()

  expect(bindingStoreCreations).toBe(1)
  expect(first).toBe(second)
  expect(lazyHandler.peek()).toBe(first)
})
