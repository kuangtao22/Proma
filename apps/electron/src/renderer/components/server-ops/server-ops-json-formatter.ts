/** 单元格 JSON 格式化结果；无效输入原样返回。 */
export interface ServerOpsJsonFormatResult {
  valid: boolean
  formatted: string
  limitation?: 'too-deep' | 'too-large'
}

/** 格式化允许的最大嵌套层级，避免缩进倍增。 */
const MAX_SERVER_OPS_JSON_FORMAT_DEPTH = 64
/** 格式化正文最大 UTF-8 字节数。 */
const MAX_SERVER_OPS_JSON_FORMAT_BYTES = 4 * 1024 * 1024

/** 判断字符是否属于 JSON 结构符号。 */
function isJsonPunctuation(character: string): boolean {
  return character === '{' || character === '}' || character === '[' || character === ']'
    || character === ':' || character === ','
}

/** 将有效 JSON 拆成不改变字面值的词法 token。 */
function tokenizeJson(source: string): string[] {
  /** 按原始字符保存的 token 列表。 */
  const tokens: string[] = []
  /** 当前扫描位置。 */
  let index = 0
  while (index < source.length) {
    /** 当前字符。 */
    const character = source[index] ?? ''
    if (/\s/u.test(character)) { index += 1; continue }
    if (isJsonPunctuation(character)) { tokens.push(character); index += 1; continue }
    if (character === '"') {
      /** 字符串 token 起点。 */
      const start = index
      index += 1
      while (index < source.length) {
        /** 字符串内当前字符。 */
        const stringCharacter = source[index] ?? ''
        if (stringCharacter === '\\') { index += 2; continue }
        index += 1
        if (stringCharacter === '"') break
      }
      tokens.push(source.slice(start, index))
      continue
    }
    /** 数字、布尔值或 null 的起点。 */
    const start = index
    while (index < source.length) {
      /** 当前字面值字符。 */
      const valueCharacter = source[index] ?? ''
      if (/\s/u.test(valueCharacter) || isJsonPunctuation(valueCharacter)) break
      index += 1
    }
    tokens.push(source.slice(start, index))
  }
  return tokens
}

/**
 * 只重排 JSON 字符串外的空白，不解析后重新序列化值。
 *
 * @param source 原始单元格文本
 * @returns 有效 JSON 的格式化文本，或保留原文的无效结果
 */
export function formatServerOpsJsonLosslessly(source: string): ServerOpsJsonFormatResult {
  try {
    /** 解析结果仅用于语法校验，绝不参与输出，避免改写大整数和重复键。 */
    JSON.parse(source)
  } catch {
    return { valid: false, formatted: source }
  }
  /** 保留所有非空白词法值的 token。 */
  const tokens = tokenizeJson(source)
  /** 当前缩进层级。 */
  let depth = 0
  /** 格式化输出。 */
  let formatted = ''
  /** 写入当前层级换行。 */
  const newline = (): void => { formatted += `\n${'  '.repeat(depth)}` }
  for (let index = 0; index < tokens.length; index += 1) {
    /** 当前与下一个 token 用于识别空对象和空数组。 */
    const token = tokens[index] ?? ''
    /** 下一个 token。 */
    const next = tokens[index + 1]
    if (token === '{' || token === '[') {
      formatted += token
      if ((token === '{' && next !== '}') || (token === '[' && next !== ']')) {
        depth += 1
        if (depth > MAX_SERVER_OPS_JSON_FORMAT_DEPTH) return { valid: true, formatted: source, limitation: 'too-deep' }
        newline()
      }
    } else if (token === '}' || token === ']') {
      /** 空容器没有增加层级，非空容器在闭合前回退一级。 */
      const previous = tokens[index - 1]
      if (!((token === '}' && previous === '{') || (token === ']' && previous === '['))) { depth -= 1; newline() }
      formatted += token
    } else if (token === ',') {
      formatted += token
      newline()
    } else if (token === ':') {
      formatted += ': '
    } else {
      formatted += token
    }
    if (formatted.length > MAX_SERVER_OPS_JSON_FORMAT_BYTES) return { valid: true, formatted: source, limitation: 'too-large' }
  }
  /** Unicode 文本按真实 UTF-8 字节复核最终预算。 */
  if (new TextEncoder().encode(formatted).byteLength > MAX_SERVER_OPS_JSON_FORMAT_BYTES) {
    return { valid: true, formatted: source, limitation: 'too-large' }
  }
  return { valid: true, formatted }
}
