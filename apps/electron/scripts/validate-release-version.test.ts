import { describe, expect, test } from 'bun:test'
import { validateReleaseVersion } from './validate-release-version'

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
})
