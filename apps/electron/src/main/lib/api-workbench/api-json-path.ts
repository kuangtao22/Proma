/** 大整数用前缀标记，避免 JSON.parse 改写原文数字。 */
const NUMBER_PREFIX = '\u0000PROMA_JSON_NUMBER:'

/** 将字符串外 JSON 数字 token 转为字符串，避免 JSON.parse 改写大整数。 */
export function preserveJsonNumbers(source: string): string {
  let result = ''
  let index = 0
  let inString = false
  let escaped = false
  while (index < source.length) {
    const character = source[index]!
    if (character === '"' && !escaped) { inString = !inString; result += character; index += 1; escaped = false; continue }
    if (inString) {
      result += character
      if (character === '\\' && !escaped) escaped = true
      else escaped = false
      index += 1
      continue
    }
    const match = source.slice(index).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/)
    if (match) {
      result += JSON.stringify(NUMBER_PREFIX + match[0])
      index += match[0].length
      continue
    }
    result += character
    index += 1
  }
  return result
}

/**
 * 支持点路径和数组下标的只读 JSON 路径解析。
 * @param source 待解析 JSON 文本。
 * @param path 空串表示整棵 JSON；否则为点路径。
 * @returns 是否命中以及命中值。
 */
export function readApiJsonPath(source: string, path: string): { exists: boolean; value?: unknown } {
  let value: unknown
  try { value = JSON.parse(preserveJsonNumbers(source)) as unknown } catch { return { exists: false } }
  if (!path) return { exists: true, value }
  const parts = path.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean)
  for (const part of parts) {
    if (typeof value !== 'object' || value === null || !Object.hasOwn(value, part)) return { exists: false }
    value = (value as Record<string, unknown>)[part]
  }
  return { exists: true, value }
}

/** 把命中值转换为稳定文本，同时还原保留的数字 token。 */
export function apiJsonValueToText(value: unknown): string {
  if (typeof value === 'string' && value.startsWith(NUMBER_PREFIX)) return value.slice(NUMBER_PREFIX.length)
  if (typeof value === 'string') return value
  return JSON.stringify(value)
}
