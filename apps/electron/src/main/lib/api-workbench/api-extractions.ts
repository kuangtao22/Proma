import { API_LIMITS } from '@proma/shared'
import type { ApiExtraction, ApiExtractionOutcome, ApiSseEvent, ApiTransportResult } from '@proma/shared'
import { apiJsonValueToText, readApiJsonPath } from './api-json-path'

/** 事件流来源所需的上下文：明细不在传输结果里，必须由服务层传入。 */
export interface ApiExtractionStreamContext {
  events: readonly ApiSseEvent[]
  droppedEvents: number
}

/** 单条提取规则的求值结果与取值；值只在主进程内部流转。 */
export interface ApiExtractionEvaluation {
  outcome: ApiExtractionOutcome
  value?: string
}

/** 记录未命中原因，保证界面能解释为什么没有写入变量。 */
function miss(extraction: ApiExtraction, message: string): ApiExtractionEvaluation {
  return { outcome: { id: extraction.id, name: extraction.name, from: extraction.from, found: false, secret: extraction.secret, message } }
}

/** 命中后统一校验长度与空值，避免把无效值写进运行时变量。 */
function hit(extraction: ApiExtraction, value: string): ApiExtractionEvaluation {
  if (value === '') return miss(extraction, '取值为空，已跳过该变量')
  if (value.length > API_LIMITS.extractionValueChars) return miss(extraction, `取值超过 ${API_LIMITS.extractionValueChars} 字符上限，已跳过该变量`)
  return { outcome: { id: extraction.id, name: extraction.name, from: extraction.from, found: true, secret: extraction.secret }, value }
}

/** 从最终一跳响应头取值；同名头按出现顺序合并。 */
function readHeader(result: ApiTransportResult, name: string): string | undefined {
  const hop = result.hops.at(-1)
  const values = hop?.responseHeaders.filter((header) => header.name.toLowerCase() === name.toLowerCase()).map((header) => header.value) ?? []
  return values.length === 0 ? undefined : values.join(', ')
}

/** 事件流里最后一个带数据的事件；心跳不参与。 */
function lastSseData(stream: ApiExtractionStreamContext | undefined): ApiSseEvent | undefined {
  return [...(stream?.events ?? [])].reverse().find((event) => event.data !== '')
}

/**
 * 执行声明式提取。
 * @param extractions 请求声明的提取规则。
 * @param result 传输结果；正文或事件流被截断时对应规则不会命中。
 * @param stream 事件流上下文，仅事件流来源需要。
 * @returns 每条规则的结果与取值。
 */
export function evaluateApiExtractions(
  extractions: readonly ApiExtraction[],
  result: ApiTransportResult,
  stream?: ApiExtractionStreamContext,
): ApiExtractionEvaluation[] {
  return extractions.map((extraction) => {
    if (extraction.from === 'header') {
      const value = readHeader(result, extraction.path)
      return value === undefined ? miss(extraction, '响应 Header 中没有该字段') : hit(extraction, value)
    }
    if (extraction.from === 'json') {
      if (!result.body.complete || result.body.previewTruncated) return miss(extraction, '正文不完整或超出预览范围，无法验证提取')
      const found = readApiJsonPath(result.body.preview, extraction.path)
      return found.exists ? hit(extraction, apiJsonValueToText(found.value)) : miss(extraction, '正文 JSON 中没有该路径')
    }
    if (!result.sse) return miss(extraction, '响应不是事件流，无法提取')
    if ((stream?.droppedEvents ?? 0) > 0) return miss(extraction, '事件超过保留上限，无法验证提取')
    const last = lastSseData(stream)
    if (!last) return miss(extraction, '事件流没有带数据的事件')
    if (extraction.path === '') return hit(extraction, last.data)
    const found = readApiJsonPath(last.data, extraction.path)
    return found.exists ? hit(extraction, apiJsonValueToText(found.value)) : miss(extraction, '最后一个事件的 JSON 中没有该路径')
  })
}
