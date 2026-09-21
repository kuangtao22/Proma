import { describe, expect, test } from 'bun:test'
import { ServerOpsReadScheduler } from './server-ops-read-scheduler'

/** 人工控制在途读取完成时刻，验证队列真实调度次序。 */
function deferred(): { promise: Promise<string>; resolve: (value: string) => void } {
  let resolve!: (value: string) => void
  const promise = new Promise<string>((done) => { resolve = done })
  return { promise, resolve }
}

describe('运维读取队列', () => {
  test('Given 同源不同操作排队 When 前一个完成 Then 按到达顺序执行', async () => {
    const scheduler = new ServerOpsReadScheduler()
    const first = deferred()
    const events: string[] = []
    const one = scheduler.run('a', () => { events.push('one'); return first.promise })
    const two = scheduler.run('a', async () => { events.push('two'); return 'two' })
    expect(events).toEqual(['one'])
    first.resolve('one')
    expect(await Promise.all([one, two])).toEqual(['one', 'two'])
    expect(events).toEqual(['one', 'two'])
  })

  test('Given 三个活跃来源 When 第四个等待且信号取消 Then 立即移除且不执行', async () => {
    const scheduler = new ServerOpsReadScheduler()
    const holds = [deferred(), deferred(), deferred()]
    const running = holds.map((hold, index) => scheduler.run(`source-${index}`, () => hold.promise))
    const controller = new AbortController()
    let executed = false
    const queued = scheduler.run('fourth', async () => { executed = true; return 'wrong' }, { signal: controller.signal })
    controller.abort()
    await expect(queued).rejects.toThrow('SERVER_OPS_DATA_CANCELLED')
    holds.forEach((hold) => hold.resolve('done'))
    await Promise.all(running)
    expect(executed).toBe(false)
  })

  test('Given 全局队列排满 When 新任务入队 Then 稳定拒绝并保持已有任务', async () => {
    const scheduler = new ServerOpsReadScheduler()
    const holds = [deferred(), deferred(), deferred()]
    const active = holds.map((hold, index) => scheduler.run(`source-${index}`, () => hold.promise))
    const queued = Array.from({ length: 24 }, (_, index) => scheduler.run(`source-${index % 3}`, async () => 'done'))
    await expect(scheduler.run('overflow', async () => 'never')).rejects.toThrow('SERVER_OPS_DATA_QUEUE_FULL')
    holds.forEach((hold) => hold.resolve('done'))
    await Promise.all([...active, ...queued])
  })

  test('Given 同源或 Agent 会话排队达八项 When 新任务入队 Then 只拒绝超额请求', async () => {
    const scheduler = new ServerOpsReadScheduler()
    const hold = deferred()
    const active = scheduler.run('source-a', () => hold.promise)
    const queued = Array.from({ length: 8 }, () => scheduler.run('source-a', async () => 'done', { ownerSessionId: 'session-a' }))
    await expect(scheduler.run('source-a', async () => 'never')).rejects.toThrow('SERVER_OPS_DATA_QUEUE_FULL')
    const otherHold = deferred()
    const otherActive = scheduler.run('source-b', () => otherHold.promise)
    await expect(scheduler.run('source-b', async () => 'never', { ownerSessionId: 'session-a' }))
      .rejects.toThrow('SERVER_OPS_DATA_QUEUE_FULL')
    hold.resolve('done')
    otherHold.resolve('done')
    await Promise.all([active, otherActive, ...queued])
  })

  test('Given 三个源占满执行名额 When 等待超过五秒 Then 超时且从队列清理', async () => {
    const scheduler = new ServerOpsReadScheduler()
    const holds = [deferred(), deferred(), deferred()]
    const active = holds.map((hold, index) => scheduler.run(`busy-${index}`, () => hold.promise))
    let executed = false
    const queued = scheduler.run('waiting', async () => { executed = true; return 'wrong' })
    await expect(queued).rejects.toThrow('SERVER_OPS_DATA_QUEUE_TIMEOUT')
    holds.forEach((hold) => hold.resolve('done'))
    await Promise.all(active)
    expect(executed).toBe(false)
  }, 7_000)

  test('Given 事件循环延误超时 timer When 槽位先释放 Then 出队仍按单调截止时间拒绝', async () => {
    let now = 0
    const scheduler = new ServerOpsReadScheduler(() => now)
    const hold = deferred()
    const active = scheduler.run('source-a', () => hold.promise)
    let executed = false
    const queued = scheduler.run('source-a', async () => { executed = true; return 'wrong' })
    now = 5_001
    hold.resolve('done')
    await active
    await expect(queued).rejects.toThrow('SERVER_OPS_DATA_QUEUE_TIMEOUT')
    expect(executed).toBe(false)
  })
})
