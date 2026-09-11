import { redactSensitiveLogText } from '../bridge-log-redaction'

/**
 * 为 Design journal 与 trace 生成同一份有界诊断，避免回收会话后丢失失败原因。
 * @param value 上游错误或已生成的任务错误，不可信正文只能用于诊断。
 * @returns 隐去凭据、地址、路径和二进制后的单行错误摘要。
 */
export function summarizeDesignExecutionError(value: string): string {
  return redactSensitiveLogText(value.slice(0, 8 * 1024))
    .replace(/\b(?:Bearer|Basic)\s+[^\s,;]+/gi, '[凭据已隐藏]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[凭据已隐藏]')
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[地址已隐藏]')
    .replace(/(?:[A-Za-z]:\\|\/(?:Users|home|private|tmp|var)\/)[^\s"']+/g, '[路径已隐藏]')
    .replace(/data:[^\s"']+/gi, '[数据已隐藏]')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500)
}

/**
 * 将 Pi 完成结果中的错误转换为设计任务错误；不推断图片 API 已调用或是否收费。
 * @param errors 本轮 Pi result 的错误详情，优先使用第一条非空错误。
 * @param subtype 本轮有界终态，详情缺失时提供可诊断的失败类型。
 * @returns 同时供任务详情与 trace 使用的中文错误说明。
 */
export function formatDesignExecutionError(errors?: string[], subtype?: string): string {
  /** 上游可能只返回终态类型，不能重新归类为正常完成但缺图。 */
  const detail = summarizeDesignExecutionError(
    errors?.find((error) => error.trim().length > 0) ?? subtype ?? 'Agent 未正常完成',
  )
  return `设计任务执行失败：${/timeout|timed out|超时/i.test(detail) ? '模型请求超时。' : ''}${detail}`
}
