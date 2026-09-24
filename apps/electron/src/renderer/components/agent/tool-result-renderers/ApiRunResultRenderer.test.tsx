import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  ApiRunResultRenderer,
  dispatchOpenApiRun,
  parseApiRunResult,
} from './ApiRunResultRenderer'

/** 创建一条合法的接口运行结果。 */
function resultJson(sessionId = 'session-1'): string {
  return JSON.stringify({
    kind: 'api-workbench-run',
    runId: 'run-1',
    sessionId,
    method: 'POST',
    url: 'https://api.example.com/users',
    state: 'completed',
    status: 201,
    durationMs: 128,
    assertions: { passed: 2, total: 2 },
    recording: 'saved',
  })
}

describe('接口运行结果卡', () => {
  test('Given api_send_request 返回直接或 details 包装 JSON When 解析 Then 得到同一运行摘要', () => {
    const direct = parseApiRunResult(resultJson())
    const wrapped = parseApiRunResult(JSON.stringify({ text: '已完成', details: JSON.parse(resultJson()) }))

    expect(direct).toEqual(wrapped)
    expect(direct).toMatchObject({ runId: 'run-1', method: 'POST', status: 201, assertions: { passed: 2, total: 2 } })
  })

  test('Given 结果类型错误或字段越界 When 解析 Then 拒绝专属卡片', () => {
    expect(parseApiRunResult('{"kind":"other"}')).toBeNull()
    expect(parseApiRunResult(JSON.stringify({ ...JSON.parse(resultJson()), durationMs: -1 }))).toBeNull()
    expect(parseApiRunResult('not-json')).toBeNull()
  })

  test('Given 结果会话与当前消息会话一致 When 打开 Then 只分派定位事件', () => {
    const events: Event[] = []
    const target = { dispatchEvent: (event: Event) => { events.push(event); return true } }
    const result = parseApiRunResult(resultJson())!

    expect(dispatchOpenApiRun(result, 'session-1', target)).toBe(true)
    expect(events).toHaveLength(1)
    expect((events[0] as CustomEvent).detail).toEqual({ sessionId: 'session-1', runId: 'run-1' })
  })

  test('Given 结果属于其它会话 When 打开 Then 不分派事件且按钮禁用', () => {
    const events: Event[] = []
    const target = { dispatchEvent: (event: Event) => { events.push(event); return true } }
    const result = parseApiRunResult(resultJson('session-a'))!

    expect(dispatchOpenApiRun(result, 'session-b', target)).toBe(false)
    expect(events).toHaveLength(0)
    const html = renderToStaticMarkup(<ApiRunResultRenderer result={resultJson('session-a')} isError={false} sessionId="session-b" />)
    expect(html).toContain('该运行属于其它会话')
    expect(html).toMatch(/打开接口工作台[^<]*<\/button>|disabled/)
  })

  test('Given 合法完成运行 When 渲染 Then 分开显示 HTTP 状态、耗时和断言结果', () => {
    const html = renderToStaticMarkup(<ApiRunResultRenderer result={resultJson()} isError={false} sessionId="session-1" />)

    expect(html).toContain('POST')
    expect(html).toContain('201')
    expect(html).toContain('128 ms')
    expect(html).toContain('断言 2/2')
    expect(html).toContain('打开接口工作台')
  })
})
