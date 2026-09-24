import { describe, expect, test } from 'bun:test'
import { createApiSseReader } from './api-workbench-sse'

describe('SSE 帧读取', () => {
  test('Given 完整单帧 When 送入 Then 解析事件名、id、数据与原始片段', () => {
    const reader = createApiSseReader()

    const frames = reader.push('event: message\nid: 7\ndata: hello\n\n')

    expect(frames).toHaveLength(1)
    expect(frames[0]?.event).toBe('message')
    expect(frames[0]?.id).toBe('7')
    expect(frames[0]?.data).toBe('hello')
    expect(frames[0]?.comment).toBe('')
    expect(frames[0]?.raw).toBe('event: message\nid: 7\ndata: hello\n')
    expect(frames[0]?.truncated).toBe(false)
  })

  test('Given 分块到达 When 跨多次送入 Then 只输出完整帧并保留残余', () => {
    const reader = createApiSseReader()

    expect(reader.push('data: par')).toEqual([])
    expect(reader.push('tial\n\n')).toHaveLength(1)
    expect(reader.push('data: 未完成')).toEqual([])
    expect(reader.push('\n\n')[0]?.data).toBe('未完成')
  })

  test('Given 心跳注释帧 When 解析 Then 保留注释且数据为空', () => {
    const frames = createApiSseReader().push(': keep-alive\n\n')

    expect(frames[0]?.comment).toBe('keep-alive')
    expect(frames[0]?.data).toBe('')
    expect(frames[0]?.event).toBe('')
  })

  test('Given 多行数据与重复字段 When 解析 Then 数据用换行连接且后出现的字段覆盖', () => {
    const frames = createApiSseReader().push('data: 第一行\ndata: 第二行\nevent: a\nevent: b\n\n')

    expect(frames[0]?.data).toBe('第一行\n第二行')
    expect(frames[0]?.event).toBe('b')
  })

  test('Given retry 字段 When 解析 Then 只接受非负整数毫秒', () => {
    const valid = createApiSseReader().push('retry: 3000\ndata: x\n\n')
    const invalid = createApiSseReader().push('retry: 稍后\ndata: x\n\n')

    expect(valid[0]?.retry).toBe(3000)
    expect(invalid[0]?.retry).toBeUndefined()
    expect(invalid[0]?.raw).toContain('data: x')
  })

  test('Given 冒号后单个空格 When 解析 Then 只去掉一个空格且无冒号字段为空值', () => {
    const spaced = createApiSseReader().push('data:  两个空格\n\n')
    const bare = createApiSseReader().push('data\n\n')

    expect(spaced[0]?.data).toBe(' 两个空格')
    expect(bare[0]?.data).toBe('')
  })

  test('Given CRLF 与单独 CR 分帧 When 解析 Then 都能切出完整帧', () => {
    const crlf = createApiSseReader().push('data: a\r\n\r\n')
    const cr = createApiSseReader().push('data: b\r\r')

    expect(crlf[0]?.data).toBe('a')
    expect(cr[0]?.data).toBe('b')
  })

  test('Given 未闭合残余 When flush Then 返回可读内容而不让它静默消失', () => {
    const reader = createApiSseReader()
    reader.push('data: 被截断的流')

    const leftover = reader.flush()

    expect(leftover?.data).toBe('被截断的流')
    expect(leftover?.truncated).toBe(true)
    expect(reader.flush()).toBeNull()
  })

  test('Given 单帧超过上限 When 解析 Then 截断标记并继续解析后续帧', () => {
    const reader = createApiSseReader({ maxEventChars: 32 })
    /** 超过上限的帧，随后紧跟一个正常帧。 */
    const oversized = `data: ${'x'.repeat(200)}\n\ndata: 正常\n\n`

    const frames = reader.push(oversized)

    expect(frames).toHaveLength(2)
    expect(frames[0]?.truncated).toBe(true)
    expect((frames[0]?.raw.length ?? 0)).toBeLessThanOrEqual(32)
    expect(frames[1]?.data).toBe('正常')
    expect(frames[1]?.truncated).toBe(false)
  })
})
