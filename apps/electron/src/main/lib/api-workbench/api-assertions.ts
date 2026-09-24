import type { ApiAssertion, ApiAssertionResult, ApiSseEvent, ApiTransportResult } from '@proma/shared'
import { apiJsonValueToText, readApiJsonPath } from './api-json-path'

/** 事件流断言需要的上下文：明细不在传输结果里，必须由服务层传入。 */
export interface ApiAssertionStreamContext {
  events: readonly ApiSseEvent[]
  droppedEvents: number
}

/** 解析 `<=10`、`<10`、`>=10`、`>10` 或精确毫秒断言。 */
function durationPass(actual: number, expected: string): boolean {
  const match = expected.trim().match(/^(<=|>=|<|>)?\s*(\d+(?:\.\d+)?)$/)
  if (!match) return false
  const target = Number(match[2])
  if (match[1] === '<=') return actual <= target
  if (match[1] === '>=') return actual >= target
  if (match[1] === '<') return actual < target
  if (match[1] === '>') return actual > target
  return actual === target
}

/** 执行无脚本声明式断言；传输失败时仍返回逐条可解释结果。 */
export function evaluateApiAssertions(
  assertions: readonly ApiAssertion[],
  result: ApiTransportResult,
  stream?: ApiAssertionStreamContext,
): ApiAssertionResult[] {
  const hop = result.hops.at(-1)
  const notStream = '响应不是事件流，无法验证该断言'
  return assertions.map((assertion) => {
    let actual = ''
    let passed = false
    let message: string | undefined
    if (assertion.kind === 'status') {
      actual = hop ? String(hop.status) : ''
      passed = actual === assertion.expected
    } else if (assertion.kind === 'header') {
      actual = hop?.responseHeaders.filter((header) => header.name.toLowerCase() === assertion.path.toLowerCase()).map((header) => header.value).join(', ') ?? ''
      passed = actual === assertion.expected
    } else if (assertion.kind === 'duration') {
      actual = hop ? String(hop.timings.totalMs) : ''
      passed = hop ? durationPass(hop.timings.totalMs, assertion.expected) : false
    } else if (assertion.kind === 'sse-count' || assertion.kind === 'sse-first-event') {
      const numeric = assertion.kind === 'sse-count' ? result.sse?.totalEvents : result.sse?.firstEventMs
      if (!result.sse) message = notStream
      else if (numeric === null || numeric === undefined) message = '事件流没有收到任何事件，无法验证该断言'
      else {
        actual = String(numeric)
        passed = durationPass(numeric, assertion.expected)
      }
    } else if (assertion.kind === 'sse-ended') {
      if (!result.sse) message = notStream
      else {
        actual = result.sse.endedReason
        passed = actual === assertion.expected.trim()
      }
    } else if (assertion.kind === 'sse-last-data') {
      if (!result.sse) message = notStream
      else if ((stream?.droppedEvents ?? 0) > 0) message = '事件超过保留上限，无法验证最后一段数据'
      else {
        /** 心跳没有数据，因此只看最后一个带 data 的事件。 */
        const last = [...(stream?.events ?? [])].reverse().find((event) => event.data !== '')
        if (!last) message = '事件流没有带数据的事件，无法验证该断言'
        else {
          actual = last.data
          passed = assertion.expected.startsWith('=')
            ? actual === assertion.expected.slice(1)
            : actual.includes(assertion.expected)
        }
      }
    } else {
      if (!result.body.complete || result.body.previewTruncated) {
        message = '正文不完整或超出预览范围，无法验证断言'
      } else {
        const found = readApiJsonPath(result.body.preview, assertion.path)
        actual = found.exists ? apiJsonValueToText(found.value) : ''
        passed = assertion.kind === 'json-exists'
          ? found.exists === (assertion.expected !== 'false')
          : found.exists && actual === assertion.expected
      }
    }
    return {
      id: assertion.id,
      passed,
      expected: assertion.expected,
      actual,
      message: message ?? (passed ? '断言通过' : '断言失败'),
    }
  })
}
