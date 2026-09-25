import { describe, expect, test } from 'bun:test'
import { composeMultipartBody, createMultipartBoundary, summarizeMultipart } from './api-multipart'
import type { ApiMultipartPlanPart } from './api-multipart'

/** 待发计划：一个文本字段 + 一个二进制文件。 */
const parts: ApiMultipartPlanPart[] = [
  { kind: 'field', name: 'note', value: '中文 value' },
  { kind: 'file', name: 'file', fileName: 'report.pdf', contentType: 'application/pdf', sizeBytes: 3, ref: 'file_1' },
]

describe('multipart 正文合成', () => {
  test('Given 文本与二进制混合 When 合成 Then 字节与手写期望逐字节一致', () => {
    const body = composeMultipartBody('----promaX', parts, () => Buffer.from([0x00, 0xff, 0x0a]))

    const expected = Buffer.concat([
      Buffer.from('------promaX\r\nContent-Disposition: form-data; name="note"\r\n\r\n中文 value\r\n'),
      Buffer.from('------promaX\r\nContent-Disposition: form-data; name="file"; filename="report.pdf"\r\nContent-Type: application/pdf\r\n\r\n'),
      Buffer.from([0x00, 0xff, 0x0a]),
      Buffer.from('\r\n------promaX--\r\n'),
    ])

    expect(body.equals(expected)).toBe(true)
  })

  test('Given 摘要正文 When 查看 Then 只描述结构与文件大小，不含文件字节', () => {
    const summary = summarizeMultipart('----promaX', parts)

    expect(summary).toContain('filename="report.pdf"')
    expect(summary).toContain('<文件内容未留存：report.pdf（3 字节）>')
    expect(summary).toContain('中文 value')
    expect(summary.endsWith('------promaX--')).toBe(true)
  })

  test('Given 名字里含引号 When 合成 Then 按 RFC 转义', () => {
    const body = composeMultipartBody('----promaX', [{ kind: 'file', name: 'file', fileName: 'a"b.txt', contentType: 'text/plain', sizeBytes: 1, ref: 'r' }], () => Buffer.from('x'))

    expect(body.toString('utf8')).toContain('filename="a\\"b.txt"')
  })

  test('Given 字段名或文件名含换行 When 合成 Then 直接拒绝而不是发出坏协议', () => {
    expect(() => composeMultipartBody('----promaX', [{ kind: 'field', name: 'bad\nname', value: 'v' }], () => Buffer.alloc(0)))
      .toThrow('API_WORKBENCH_MULTIPART_NAME_INVALID')
    expect(() => summarizeMultipart('----promaX', [{ kind: 'file', name: 'file', fileName: 'bad\rname', contentType: 'text/plain', sizeBytes: 0, ref: 'r' }]))
      .toThrow('API_WORKBENCH_MULTIPART_NAME_INVALID')
  })

  test('Given 引用失效 When 合成 Then 把文件层的错误原样抛出', () => {
    expect(() => composeMultipartBody('----promaX', parts, () => { throw new Error('API_WORKBENCH_FILE_REF_NOT_FOUND: x') }))
      .toThrow('API_WORKBENCH_FILE_REF_NOT_FOUND')
  })

  test('Given 边界生成 When 传随机后缀 Then 不含连字符且不可预测', () => {
    expect(createMultipartBoundary('a1b2-c3d4')).toBe('----promaa1b2c3d4')
    expect(createMultipartBoundary('x')).not.toBe(createMultipartBoundary('y'))
  })
})
