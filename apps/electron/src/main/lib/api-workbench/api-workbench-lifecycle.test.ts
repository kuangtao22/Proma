import { describe, expect, test } from 'bun:test'
import { createApiWorkbenchLifecycle } from './api-workbench-lifecycle'

/** 记录创建与关闭次数的替身服务。 */
function fixture() {
  let created = 0
  let disposed = 0
  let rebuilds = 0
  let releaseDispose: (() => void) | undefined
  const lifecycle = createApiWorkbenchLifecycle<{ id: number }>({
    create: () => ({ id: ++created }),
    dispose: () => new Promise<void>((resolve) => { disposed += 1; releaseDispose = resolve }),
    onRebuild: () => { rebuilds += 1 },
  })
  return {
    lifecycle,
    counts: () => ({ created, disposed, rebuilds }),
    finishDispose: () => { releaseDispose?.(); releaseDispose = undefined },
  }
}

describe('接口工作台服务生命周期', () => {
  test('Given 未关闭 When 多次取服务 Then 复用同一个实例', () => {
    const f = fixture()

    expect(f.lifecycle.get().id).toBe(1)
    expect(f.lifecycle.get().id).toBe(1)
    expect(f.counts().created).toBe(1)
  })

  test('Given 关闭进行中 When 再取服务 Then fail closed 而不是复活', () => {
    const f = fixture()
    f.lifecycle.get()

    void f.lifecycle.shutdown()

    expect(f.lifecycle.isClosed()).toBe(true)
    expect(() => f.lifecycle.get()).toThrow('API_WORKBENCH_SHUTTING_DOWN')
    expect(f.counts().disposed).toBe(1)
  })

  test('Given 关闭已结算但应用没退出 When 再取服务 Then 重建并记录诊断', async () => {
    const f = fixture()
    const first = f.lifecycle.get()
    const pending = f.lifecycle.shutdown()
    f.finishDispose()
    await pending

    /** 现场案例：用户在退出确认里点取消，清理已经跑过，进程继续活着。 */
    const second = f.lifecycle.get()

    expect(second.id).toBe(2)
    expect(second).not.toBe(first)
    expect(f.counts()).toEqual({ created: 2, disposed: 1, rebuilds: 1 })
    expect(f.lifecycle.isClosed()).toBe(false)
  })

  test('Given 关闭失败 When 再取服务 Then 仍然重建（不能让一次异常锁死功能）', async () => {
    const lifecycle = createApiWorkbenchLifecycle<{ id: number }>({
      create: () => ({ id: Math.random() }),
      dispose: () => Promise.reject(new Error('utility 退出失败')),
    })
    lifecycle.get()

    await lifecycle.shutdown()

    expect(lifecycle.get()).toBeDefined()
  })

  test('Given 重复关闭 When 调用两次 Then 复用同一个等待且只关闭一次', async () => {
    const f = fixture()
    f.lifecycle.get()

    const first = f.lifecycle.shutdown()
    const second = f.lifecycle.shutdown()

    expect(second).toBe(first)
    f.finishDispose()
    await first
    expect(f.counts().disposed).toBe(1)
  })

  test('Given 服务从未创建 When 关闭 Then 直接结算且不触发创建', async () => {
    const f = fixture()

    expect(await f.lifecycle.shutdown()).toBeUndefined()
    expect(f.counts().created).toBe(0)
    /** 关闭过又没创建过：下一次调用按「退出未完成」处理，重建一份新服务。 */
    expect(f.lifecycle.get().id).toBe(1)
  })

  test('Given 只查询忙碌状态 When 读 current Then 不触发创建', () => {
    const f = fixture()

    expect(f.lifecycle.current()).toBeUndefined()
    expect(f.counts().created).toBe(0)
  })
})
