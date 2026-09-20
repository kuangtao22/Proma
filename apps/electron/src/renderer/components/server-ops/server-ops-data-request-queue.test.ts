import { describe, expect, test } from 'bun:test'
import { enqueueServerOpsDataRead } from './server-ops-data-request-queue'

/** 可控读取，模拟 utility 仍持有数据库连接。 */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  /** 由测试在精确时刻结算。 */
  let resolve!: (value: T) => void
  /** 不定时休眠，直接控制异步边界。 */
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

describe('数据库在途读取协调', () => {
  test('Given StrictMode 新旧订阅 When 目标相同 Then 共用一次读取且新订阅收到结果', async () => {
    /** 同一 preload API 作为协调域。 */
    const owner = {}
    /** 底层读取回执。 */
    const pending = deferred<number>()
    /** 记录真实读取次数。 */
    let calls = 0
    /** 模拟第一次 effect cleanup。 */
    let firstActive = true
    /** 初次请求。 */
    const first = enqueueServerOpsDataRead(owner, 'rows:source', 'users:0', () => { calls += 1; return pending.promise }, () => firstActive)
    firstActive = false
    /** 重放订阅复用未结束的读取。 */
    const second = enqueueServerOpsDataRead(owner, 'rows:source', 'users:0', () => { calls += 1; return pending.promise }, () => true)
    pending.resolve(42)
    expect(await first).toBe(42)
    expect(await second).toBe(42)
    expect(calls).toBe(1)
  })

  test('Given 连续换表 When 首次请求仍在途 Then 顺序读取最新目标并跳过失效排队请求', async () => {
    /** 相同来源的读取协调域。 */
    const owner = {}
    /** 第一个请求占用 lane。 */
    const pending = deferred<string>()
    /** 实际请求顺序。 */
    const calls: string[] = []
    /** 首次读取。 */
    const first = enqueueServerOpsDataRead(owner, 'rows:source', 'first', () => { calls.push('first'); return pending.promise }, () => true)
    await Promise.resolve()
    /** 中间选择在执行前已失效。 */
    const skipped = enqueueServerOpsDataRead(owner, 'rows:source', 'skipped', async () => { calls.push('skipped'); return 'skipped' }, () => false).catch(() => 'cancelled')
    /** 最后选中的表。 */
    const latest = enqueueServerOpsDataRead(owner, 'rows:source', 'latest', async () => { calls.push('latest'); return 'latest' }, () => true)
    expect(calls).toEqual(['first'])
    pending.resolve('first')
    expect(await first).toBe('first')
    expect(await skipped).toBe('cancelled')
    expect(await latest).toBe('latest')
    expect(calls).toEqual(['first', 'latest'])
  })

  test('Given 读取失败 When 后续同一目标刷新 Then 不缓存失败也不阻塞队列', async () => {
    /** 独立测试协调域。 */
    const owner = {}
    await expect(enqueueServerOpsDataRead(owner, 'rows', 'users', async () => { throw new Error('BUSY') }, () => true)).rejects.toThrow('BUSY')
    expect(await enqueueServerOpsDataRead(owner, 'rows', 'users', async () => 'ready', () => true)).toBe('ready')
  })
})
