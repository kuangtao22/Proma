import { describe, expect, test } from 'bun:test'
import { formatServerOpsJsonLosslessly } from './server-ops-json-formatter'

describe('数据库单元格 JSON 无损格式化', () => {
  test('Given 大整数、重复键和字符串空白 When 格式化 Then 只调整结构空白且保留词法值', () => {
    /** 原始 JSON 故意包含超出安全整数范围的数值、重复键和字符串内空格。 */
    const source = '{"id":90071992547409931234,"id":2,"body":"a  b","nested":[1,{"ok":true}]}'
    const result = formatServerOpsJsonLosslessly(source)
    expect(result.valid).toBe(true)
    expect(result.formatted).toContain('90071992547409931234')
    expect(result.formatted.match(/"id"/gu)).toHaveLength(2)
    expect(result.formatted).toContain('"a  b"')
    expect(result.formatted).toBe('{\n  "id": 90071992547409931234,\n  "id": 2,\n  "body": "a  b",\n  "nested": [\n    1,\n    {\n      "ok": true\n    }\n  ]\n}')
  })

  test('Given 无效 JSON When 请求格式化 Then 保留原文且标记不可格式化', () => {
    /** 含尾逗号的文本不是有效 JSON。 */
    const source = '{"id":1,}'
    expect(formatServerOpsJsonLosslessly(source)).toEqual({ valid: false, formatted: source })
  })

  test('Given JSON 嵌套过深或格式化结果过大 When 请求格式化 Then 保留原文且不误报语法错误', () => {
    /** 超过 64 层的合法 JSON。 */
    const deep = `${'['.repeat(65)}0${']'.repeat(65)}`
    expect(formatServerOpsJsonLosslessly(deep)).toEqual({ valid: true, formatted: deep, limitation: 'too-deep' })
    /** 64 层内的大量元素会因缩进膨胀超过 4 MiB。 */
    const large = `${'['.repeat(64)}${Array.from({ length: 40_000 }, () => '0').join(',')}${']'.repeat(64)}`
    expect(formatServerOpsJsonLosslessly(large)).toEqual({ valid: true, formatted: large, limitation: 'too-large' })
  })
})
