import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  validateReleaseNotes,
  validateReleaseVersion,
} from './validate-release-version'

describe('发布版本前置校验', () => {
  test('Given 标签与版本一致 When 校验 Then 返回 Actions outputs', () => {
    expect(validateReleaseVersion('0.17.42-bone.5', 'v0.17.42-bone.5')).toEqual({
      version: '0.17.42-bone.5',
      upstreamVersion: '0.17.42',
      boneBuild: '5',
      releaseTitle: 'Proma 0.17.42 · Bone 5',
    })
  })

  test('Given 标签错误 When 校验 Then 在构建前失败', () => {
    expect(() => validateReleaseVersion('0.17.42-bone.5', 'v0.17.42-bone.4'))
      .toThrow('发布标签 v0.17.42-bone.4 与应用版本 0.17.42-bone.5 不一致')
  })

  test('Given 版本格式非法 When 校验 Then 在构建前失败', () => {
    expect(() => validateReleaseVersion('0.17.42', 'v0.17.42'))
      .toThrow('应用版本 0.17.42 不是合法的 Bone 发布版本')
  })

  test('Given 对应 Bone 说明存在 When 校验 Then 返回仓库相对路径', () => {
    /** 本测试独立使用的临时仓库根目录。 */
    const repositoryRoot = mkdtempSync(join(tmpdir(), 'proma-release-notes-'))
    /** 当前标签对应的版本说明目录。 */
    const notesDirectory = join(repositoryRoot, 'release-notes', 'bone')
    mkdirSync(notesDirectory, { recursive: true })
    writeFileSync(join(notesDirectory, 'v0.17.55-bone.1.md'), '# 更新内容\n\n- 新增版本说明。\n')

    expect(validateReleaseNotes('v0.17.55-bone.1', repositoryRoot))
      .toBe('release-notes/bone/v0.17.55-bone.1.md')
  })

  test('Given 对应 Bone 说明缺失 When 校验 Then 在构建前失败', () => {
    /** 不包含版本说明的临时仓库根目录。 */
    const repositoryRoot = mkdtempSync(join(tmpdir(), 'proma-release-notes-'))

    expect(() => validateReleaseNotes('v0.17.55-bone.1', repositoryRoot))
      .toThrow('缺少 Bone 版本说明：release-notes/bone/v0.17.55-bone.1.md')
  })

  test('Given 对应 Bone 说明为空 When 校验 Then 在构建前失败', () => {
    /** 本测试独立使用的临时仓库根目录。 */
    const repositoryRoot = mkdtempSync(join(tmpdir(), 'proma-release-notes-'))
    /** 当前标签对应的版本说明目录。 */
    const notesDirectory = join(repositoryRoot, 'release-notes', 'bone')
    mkdirSync(notesDirectory, { recursive: true })
    writeFileSync(join(notesDirectory, 'v0.17.55-bone.1.md'), '  \n')

    expect(() => validateReleaseNotes('v0.17.55-bone.1', repositoryRoot))
      .toThrow('Bone 版本说明不能为空：release-notes/bone/v0.17.55-bone.1.md')
  })
})
