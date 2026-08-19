import { describe, expect, test } from 'bun:test'
import { createAppVersionDisplay } from './app-version-display'

describe('关于页版本显示', () => {
  test('Given Bone 版本 When 格式化 Then 分开显示官方版本和构建号', () => {
    expect(createAppVersionDisplay('0.17.42-bone.5')).toEqual({
      fullVersion: '0.17.42-bone.5',
      upstreamVersion: '0.17.42',
      boneBuild: 5,
    })
  })

  test('Given 非 Bone 版本 When 格式化 Then 保留完整版本且不伪造构建号', () => {
    expect(createAppVersionDisplay('0.17.42')).toEqual({
      fullVersion: '0.17.42',
      upstreamVersion: '0.17.42',
      boneBuild: null,
    })
  })
})
