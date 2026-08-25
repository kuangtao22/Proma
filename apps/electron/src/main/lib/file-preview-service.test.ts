import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readPreviewFileStable } from './file-preview-service'

describe('文件预览稳定身份读取', () => {
  test('Given 授权后替换叶子或祖先 When 读取预览源 Then 不读取替换后的文件', () => {
    const root = mkdtempSync(join(tmpdir(), 'proma-file-preview-race-'))
    try {
      const leaf = join(root, 'leaf.docx')
      const replacement = join(root, 'replacement.docx')
      writeFileSync(leaf, 'authorized')
      writeFileSync(replacement, 'outside-secret')
      expect(() => readPreviewFileStable(leaf, 1024, () => renameSync(replacement, leaf))).toThrow('文件身份已变化')

      const ancestor = join(root, 'ancestor')
      const oldAncestor = join(root, 'ancestor-old')
      const outside = join(root, 'outside')
      mkdirSync(ancestor)
      mkdirSync(outside)
      writeFileSync(join(ancestor, 'preview.pdf'), 'authorized')
      writeFileSync(join(outside, 'preview.pdf'), 'outside-secret')
      expect(() => readPreviewFileStable(join(ancestor, 'preview.pdf'), 1024, () => {
        renameSync(ancestor, oldAncestor)
        symlinkSync(outside, ancestor)
      })).toThrow('文件身份已变化')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
