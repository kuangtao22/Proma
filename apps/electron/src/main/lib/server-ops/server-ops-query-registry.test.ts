import { describe, expect, test } from 'bun:test'
import { ServerOpsQueryRegistry } from './server-ops-query-registry'

describe('SQL 窗口查询所有权', () => {
  test('Given 两个窗口 When 非所有者取消 Then 原查询继续直到真实所有者取消并等待结束', async () => {
    /** 远程清理 ACK 由测试显式释放，确保取消不会提前放开执行槽。 */
    let finish!: () => void
    let aborted = false
    const registry = new ServerOpsQueryRegistry()
    const input = { sourceId: 'db-1', queryId: 'query-1' }
    const running = registry.run(7, input, async (signal) => {
      signal.addEventListener('abort', () => { aborted = true })
      await new Promise<void>((resolve) => { finish = resolve })
      return 'done'
    })
    await registry.cancel(8, input)
    expect(aborted).toBe(false)
    let cancelled = false
    const cancelling = registry.cancel(7, input).then(() => { cancelled = true })
    await Promise.resolve()
    expect(aborted).toBe(true)
    expect(cancelled).toBe(false)
    finish()
    await cancelling
    await expect(running).rejects.toThrow('SERVER_OPS_SQL_CANCELLED')
    expect(cancelled).toBe(true)
  })
  test('Given 在途查询 When 重复 ID 或关闭窗口 Then 拒绝覆盖且取消本窗口全部查询', async () => {
    const registry = new ServerOpsQueryRegistry()
    const input = { sourceId: 'db-1', queryId: 'query-1' }
    let finish!: () => void
    let signal!: AbortSignal
    const running = registry.run(7, input, async (activeSignal) => {
      signal = activeSignal
      await new Promise<void>((resolve) => { finish = resolve })
      return 1
    })
    await expect(registry.run(7, input, async () => 2)).rejects.toThrow('SERVER_OPS_SQL_BUSY')
    registry.closeOwner(7)
    expect(signal.aborted).toBe(true)
    finish()
    await expect(running).rejects.toThrow('SERVER_OPS_SQL_CANCELLED')
    await expect(registry.run(7, input, async () => 3)).resolves.toBe(3)
  })
})
