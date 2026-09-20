import { describe, expect, test } from 'bun:test'
import {
  isAbsoluteFilePath,
  isLocalFileReference,
  isRelativeFilePath,
  stripLineCol,
} from './file-path-chip-utils'

describe('文件路径候选判定', () => {
  test('Given 模型输出中文或含空格的相对文件名 When 判定候选 Then 允许交给主进程解析', () => {
    expect(isRelativeFilePath('报告.md')).toBe(true)
    expect(isRelativeFilePath('docs/报告.md')).toBe(true)
    expect(isRelativeFilePath('my report.md')).toBe(true)
    expect(isRelativeFilePath('./src/入口.tsx')).toBe(true)
    expect(isRelativeFilePath('Makefile')).toBe(true)
  })

  test('Given 普通带点文本或纯目录片段 When 判定候选 Then 不触发路径解析', () => {
    expect(isRelativeFilePath('v1.2')).toBe(false)
    expect(isRelativeFilePath('1.2')).toBe(false)
    expect(isRelativeFilePath('docs/')).toBe(false)
  })

  test('Given 含目录分隔符但无扩展名的片段 When 判定候选 Then 交给主进程最终校验', () => {
    /** 目录或站内相对地址一律由主进程按普通文件校验后拒绝，渲染侧不重复实现判据。 */
    expect(isRelativeFilePath('v1/users')).toBe(true)
  })

  test('Given URL、协议相对地址或越界相对路径 When 判定候选 Then 一律拒绝', () => {
    expect(isRelativeFilePath('https://example.com/a.md')).toBe(false)
    expect(isRelativeFilePath('file:///tmp/a.md')).toBe(false)
    expect(isRelativeFilePath('//example.com/a.md')).toBe(false)
    expect(isRelativeFilePath('../secret.md')).toBe(false)
    expect(isRelativeFilePath('docs/../../secret.md')).toBe(false)
  })

  test('Given 超长文本或控制字符 When 判定候选 Then 拒绝以避免整段正文进入 IPC', () => {
    expect(isRelativeFilePath(`${'a'.repeat(5000)}.md`)).toBe(false)
    expect(isRelativeFilePath('报告\u0000.md')).toBe(false)
  })

  test('Given 带行号后缀的相对路径 When 判定候选 Then 先剥离行号再判定', () => {
    expect(isRelativeFilePath('src/main.ts:120')).toBe(true)
    expect(stripLineCol('src/main.ts:120')).toEqual({ path: 'src/main.ts', suffix: ':120' })
  })

  test('Given 主目录与绝对路径 When 判定本地引用 Then 均由绝对路径分支接管', () => {
    expect(isAbsoluteFilePath('~/notes/a.md')).toBe(true)
    expect(isAbsoluteFilePath('/tmp/a.md')).toBe(true)
    expect(isLocalFileReference('~/notes/a.md')).toBe(true)
    expect(isLocalFileReference('docs/报告.md')).toBe(true)
    expect(isLocalFileReference('v1.2')).toBe(false)
  })
})
