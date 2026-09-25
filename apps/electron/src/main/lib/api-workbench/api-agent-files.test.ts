import { describe, expect, test } from 'bun:test'
import { parseApiAgentDeclaredFiles } from './api-agent-files'

/** 一个最小可用的 multipart 正文声明。 */
function body(files: unknown): unknown {
  return { kind: 'multipart', text: '', fields: [], files }
}

describe('Agent 声明的待上传文件', () => {
  test('Given 没有声明文件 When 解析 Then 返回空数组而不是报错', () => {
    expect(parseApiAgentDeclaredFiles(undefined)).toEqual([])
    expect(parseApiAgentDeclaredFiles({ kind: 'multipart', text: '', fields: [] })).toEqual([])
  })

  test('Given 绝对路径声明 When 解析 Then 保留字段名与可选类型', () => {
    expect(parseApiAgentDeclaredFiles(body([
      { id: 'part_1', name: 'file', path: '/tmp/report.pdf' },
      { id: 'part_2', name: 'avatar', path: '/tmp/头像.png', contentType: 'image/png' },
    ]))).toEqual([
      { id: 'part_1', name: 'file', path: '/tmp/report.pdf' },
      { id: 'part_2', name: 'avatar', path: '/tmp/头像.png', contentType: 'image/png' },
    ])
  })

  test('Given 相对路径或空字段名 When 解析 Then 拒绝而不是留给后续阶段猜', () => {
    expect(() => parseApiAgentDeclaredFiles(body([{ id: 'part_1', name: 'file', path: 'report.pdf' }])))
      .toThrow('API_WORKBENCH_INVALID: body.files[0].path')
    expect(() => parseApiAgentDeclaredFiles(body([{ id: 'part_1', name: '', path: '/tmp/a.txt' }])))
      .toThrow('API_WORKBENCH_INVALID: body.files.name')
  })

  test('Given 引用、未知键或重复身份 When 解析 Then 一律拒绝', () => {
    /** 模型不能自带 ref：引用由 Host 签发，自带引用会让「批准的是哪个文件」说不清。 */
    expect(() => parseApiAgentDeclaredFiles(body([{ id: 'part_1', name: 'file', path: '/tmp/a.txt', ref: 'file_1' }])))
      .toThrow('API_WORKBENCH_INVALID: body.files[0]')
    expect(() => parseApiAgentDeclaredFiles(body([{ id: 'part_1', name: 'file', path: '/tmp/a.txt', sizeBytes: 3 }])))
      .toThrow('API_WORKBENCH_INVALID: body.files[0]')
    expect(() => parseApiAgentDeclaredFiles(body([
      { id: 'part_1', name: 'file', path: '/tmp/a.txt' },
      { id: 'part_1', name: 'file2', path: '/tmp/b.txt' },
    ]))).toThrow('API_WORKBENCH_INVALID: body.files.duplicateId')
  })

  test('Given 超过单请求上限 When 解析 Then 拒绝', () => {
    const many = Array.from({ length: 17 }, (_value, index) => ({ id: `part_${index}`, name: 'file', path: `/tmp/${index}.bin` }))

    expect(() => parseApiAgentDeclaredFiles(body(many))).toThrow('API_WORKBENCH_INVALID: body.files')
    expect(parseApiAgentDeclaredFiles(body(many.slice(0, 16)))).toHaveLength(16)
  })

  test('Given path 不是字符串或含空字符 When 解析 Then 拒绝', () => {
    expect(() => parseApiAgentDeclaredFiles(body([{ id: 'part_1', name: 'file', path: 42 }])))
      .toThrow('API_WORKBENCH_INVALID: body.files[0].path')
    expect(() => parseApiAgentDeclaredFiles(body([{ id: 'part_1', name: 'file', path: '/tmp/a\u0000b' }])))
      .toThrow('API_WORKBENCH_INVALID: body.files[0].path')
  })
})
